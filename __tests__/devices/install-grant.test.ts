/**
 * An installed Home Screen app joins the device its browser enrolled
 * (`lib/devices/install-grant.ts`, 9 October 2026), end to end through the real
 * proxy and route handlers against a stub FabOrchestrator:
 *
 *   an approved browser (KEY-A, the device's ROOT credential) keeps a one-time
 *   install grant in a cookie → iOS copies the browser's cookies into the app
 *   added to the Home Screen → the app makes its own key (KEY-B) and the grant
 *   registers it as an APP credential of the **same** DEVICE-nnn → the app
 *   signs in for itself, and the browser's session is left alone.
 *
 * "The app" here is a second cookie jar that starts as a copy of the
 * browser's, with a different key: what iOS 17.2 and later give a new Home
 * Screen app. Keys are real non-extractable Web Crypto keys (`newPhoneKey`).
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bindSession,
  currentStorePath,
  foCalls,
  newPhoneKey,
  redirectedTo,
  request,
  sessionOf,
  setCookie,
  setUp,
  signChallenge,
  tearDown,
  type PhoneKey,
} from "./fixture";
import { proxy } from "@/proxy";
import { foFingerprint } from "@/lib/auth";
import { keyFingerprint } from "@/lib/devices/challenges";
import { hashSecret } from "@/lib/devices/credential";
import {
  INSTALL_GRANT_COOKIE_MS,
  INSTALL_GRANT_PATH,
  INSTALL_GRANT_RENEW_BELOW_MS,
  INSTALL_GRANT_TTL_MS,
  installGrantsEnabled,
} from "@/lib/devices/install-grant";

/** A lifetime for grants a test wants to see run out; the app's own grants have none. */
const SHORT_TTL_MS = 15 * 60 * 1000;
import { credentialIdOf, INSTALL_GRANT_UNTIL_KEY } from "@/lib/devices/keystore";
import { describeDevice } from "@/lib/devices/metadata";
import { deviceStore, serializeRecord } from "@/lib/devices/store";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { POST as CHALLENGE } from "@/app/api/pwa/device-auth/challenge/route";
import { POST as LOGIN } from "@/app/api/pwa/auth/login/route";
import { POST as LOGOUT } from "@/app/api/pwa/auth/logout/route";
import { POST as FORGET } from "@/app/api/pwa/auth/forget/route";
import { POST as GRANT } from "@/app/api/pwa/device-credentials/grant/route";
import { POST as ATTACH_START } from "@/app/api/pwa/device-credentials/attach/start/route";
import { POST as ATTACH_COMPLETE } from "@/app/api/pwa/device-credentials/attach/complete/route";
import { GET as LIST_DEVICES } from "@/app/api/pwa/devices/route";
import { POST as REVOKE_DEVICE } from "@/app/api/pwa/devices/[deviceId]/revoke/route";
import { POST as REVOKE_CREDENTIAL } from "@/app/api/pwa/devices/[deviceId]/credentials/[credentialId]/revoke/route";

const GRANT_COOKIE = "__Secure-fo_install";
const META = describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", false);

/* ── Logs: captured for every test, and checked for secrets ────────────────── */

let logged: string[] = [];
let secrets: string[] = [];

beforeEach(async () => {
  await setUp({ gate: "enforce" });
  delete process.env.DEVICE_INSTALL_GRANTS;
  logged = [];
  secrets = [];
  for (const level of ["info", "warn", "error", "log"] as const) {
    mock.method(console, level, (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});
afterEach(async () => {
  for (const secret of secrets) assert.ok(!logged.some((line) => line.includes(secret)), "a secret reached the log");
  mock.restoreAll();
  delete process.env.DEVICE_INSTALL_GRANTS;
  await tearDown();
});

/* ── Helpers ───────────────────────────────────────────────────────────────── */

type Cookies = Record<string, string | null>;

/** One key and the device it belongs to: a browser, or an installed app. */
interface Holder {
  key: PhoneKey;
  deviceId: string;
  credentialId: string;
}

const credentialIdFor = (key: PhoneKey) => keyFingerprint(Buffer.from(key.spki, "base64url"));

/** Let work scheduled for after a response (a revoke at FabOrchestrator) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The FabOrchestrator tokens this app asked FabOrchestrator to revoke. */
const revokedAtFo = () => foCalls.filter((c) => c.path === "/api/auth/logout").map((c) => c.bearer);

/** A browser approved by an enrollment QR: KEY-A, the device's ROOT credential. */
async function enrolledBrowser(): Promise<Holder> {
  const key = await newPhoneKey();
  const store = deviceStore();
  const { token } = await store.createEnrollment({ createdBy: "admin@plant.example", ttlMs: 600_000 });
  secrets.push(token);
  const result = await store.completeEnrollment({ token, publicKeySpki: key.spki, metadata: META });
  assert.equal(result.kind, "enrolled");
  return { key, deviceId: (result as { device: { deviceId: string } }).device.deviceId, credentialId: credentialIdFor(key) };
}

async function challenge(holder: Holder, purpose?: "sign-in" | "grant", named = true) {
  const res = await CHALLENGE(
    request("/api/pwa/device-auth/challenge", {
      json: { deviceId: holder.deviceId, ...(named ? { credentialId: holder.credentialId } : {}), ...(purpose ? { purpose } : {}) },
    }),
  );
  return { res, body: (await res.json()) as { challengeId?: string; challenge?: string; code?: string } };
}

/**
 * What the sign-in page does. `named: false` is a page loaded before
 * credentials existed. A revoked device or credential is refused at the
 * challenge already, and that refusal is what the page acts on.
 */
async function signIn(holder: Holder, email = "alice@plant.example", cookies: Cookies = {}, named = true) {
  const c = await challenge(holder, undefined, named);
  if (c.res.status === 403) return { res: c.res, body: c.body as { token?: string; code?: string; error?: string }, device: null, foToken: null, cookies: {} as Cookies };
  assert.equal(c.res.status, 200, JSON.stringify(c.body));
  return signInWith(holder, c, email, cookies, named);
}

/** Sign in with a challenge obtained earlier: a proof signed before a revocation. */
async function signInWith(
  holder: Holder,
  c: { body: { challengeId?: string; challenge?: string } },
  email = "alice@plant.example",
  cookies: Cookies = {},
  named = true,
) {
  const device = {
    deviceId: holder.deviceId,
    ...(named ? { credentialId: holder.credentialId } : {}),
    challengeId: c.body.challengeId!,
    signature: await signChallenge(holder.key, c.body.challenge!),
  };
  const password = `${email.split("@")[0]}-pass`;
  const res = await LOGIN(request("/api/pwa/auth/login", { cookies, json: { email, password, device } }));
  const body = (await res.json()) as { token?: string; code?: string; error?: string };
  const foToken = setCookie(res, FO_TOKEN_COOKIE) ?? null;
  if (foToken) secrets.push(foToken);
  return { res, body, device, foToken, cookies: { [FO_TOKEN_COOKIE]: foToken } as Cookies };
}

/**
 * What an approved browser does in the background: prove its key, receive a
 * grant cookie. `held` is the grant cookie the browser already has, which the
 * browser sends with this request (the cookie's path covers the route).
 */
async function requestGrant(holder: Holder, held: string | null = null) {
  const c = await challenge(holder, "grant");
  if (c.res.status !== 200) return { status: c.res.status, step: "challenge" as const, body: c.body as Record<string, unknown>, token: null, res: c.res };
  const res = await GRANT(
    request(`${INSTALL_GRANT_PATH}/grant`, {
      cookies: held ? { [GRANT_COOKIE]: held } : {},
      json: {
        deviceId: holder.deviceId,
        credentialId: holder.credentialId,
        challengeId: c.body.challengeId,
        signature: await signChallenge(holder.key, c.body.challenge!),
      },
    }),
  );
  const token = setCookie(res, GRANT_COOKIE) || null;
  if (token) secrets.push(token);
  return { status: res.status, step: "grant" as const, body: (await res.clone().json()) as Record<string, unknown>, token, res };
}

/**
 * What a newly installed app does (`keystore.attachFromGrant`): ask whether its
 * cookies hold a usable grant, make a key, sign, attach.
 */
async function attach(grantToken: string | null, opts: { key?: PhoneKey; cookies?: Cookies } = {}) {
  const key = opts.key ?? (await newPhoneKey());
  const cookies = { ...(opts.cookies ?? {}), [GRANT_COOKIE]: grantToken };
  const start = await ATTACH_START(request(`${INSTALL_GRANT_PATH}/attach/start`, { cookies, json: {} }));
  const s = (await start.json()) as { challengeId?: string; challenge?: string; deviceId?: string; code?: string; reason?: string };
  if (start.status !== 200) return { status: start.status, step: "start" as const, body: s, res: start, holder: null };
  const res = await ATTACH_COMPLETE(
    request(`${INSTALL_GRANT_PATH}/attach/complete`, {
      cookies,
      json: { challengeId: s.challengeId, publicKeySpki: key.spki, signature: await signChallenge(key, s.challenge!), installedApp: true },
    }),
  );
  const body = (await res.clone().json()) as { device?: { deviceId: string }; credentialId?: string; code?: string; reason?: string };
  const holder: Holder | null = body.device ? { key, deviceId: body.device.deviceId, credentialId: credentialIdFor(key) } : null;
  return { status: res.status, step: "complete" as const, body, res, holder };
}

/** A browser, and the app installed from it and attached with its grant. */
async function browserAndApp() {
  const browser = await enrolledBrowser();
  const grant = await requestGrant(browser);
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  const attached = await attach(grant.token);
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  return { browser, app: attached.holder!, grantToken: grant.token! };
}

/** What the proxy does with a document request: "passed", or "blocked:<reason>". */
async function gate(cookies: Cookies, path = "/home") {
  const res = await proxy(request(path, { cookies }));
  if (redirectedTo(res) !== "/device-blocked") return "passed";
  return `blocked:${new URL(res.headers.get("location")!).searchParams.get("reason")}`;
}

/** An administrator, signed in on an approved browser. */
async function administrator() {
  const browser = await enrolledBrowser();
  const session = sessionOf("admin@plant.example");
  await bindSession(session.foToken, browser.deviceId, browser.credentialId);
  return { browser, cookies: session.cookies, headers: { authorization: session.bearer } };
}
type Admin = Awaited<ReturnType<typeof administrator>>;

const revokeCredential = (admin: Admin, deviceId: string, credentialId: string) =>
  REVOKE_CREDENTIAL(request(`/api/pwa/devices/${deviceId}/credentials/${credentialId}/revoke`, { cookies: admin.cookies, headers: admin.headers, json: {} }), {
    params: Promise.resolve({ deviceId, credentialId }),
  });

const revokeDevice = (admin: Admin, deviceId: string) =>
  REVOKE_DEVICE(request(`/api/pwa/devices/${deviceId}/revoke`, { cookies: admin.cookies, headers: admin.headers, json: {} }), {
    params: Promise.resolve({ deviceId }),
  });

/* ── Devices enrolled before credentials existed ───────────────────────────── */

describe("a device enrolled before credentials existed keeps working, unchanged", () => {
  /** A store file as the previous release wrote it: an enrollment, DEVICE-002 with KEY-A, a signed-in session. */
  async function oldStoreFile() {
    const keyA = await newPhoneKey();
    const code = "c".repeat(43);
    const oldSession = sessionOf("alice@plant.example");
    const at = Date.now() - 86_400_000;
    const lines = [
      serializeRecord({ t: "enrollment", id: "enr_AAAAAAAAAAAAAAAA", th: hashSecret(code), by: "admin@plant.example", site: null, name: "Line 2 phone", at, exp: at + 600_000 }),
      serializeRecord({ t: "enrolled", eid: "enr_AAAAAAAAAAAAAAAA", dev: "DEVICE-002", pk: keyA.spki, name: "Line 2 phone", dtype: "phone", os: "iOS", browser: "Safari", ctx: "browser", at: at + 1000 }),
      serializeRecord({ t: "bound", sf: foFingerprint(oldSession.foToken), dev: "DEVICE-002", exp: Date.now() + 3_600_000, at: Date.now() - 60_000 }),
    ];
    // The session line names no credential: that field did not exist.
    assert.ok(!("cr" in JSON.parse(lines[2]!)), "an old session line carries no credential");
    const content = `${lines.join("\n")}\n`;
    writeFileSync(currentStorePath(), content);
    return { keyA, oldSession, content };
  }

  test("the same record is read as DEVICE-002 with KEY-A as its ROOT credential, and the file is not rewritten", async () => {
    const { keyA, content } = await oldStoreFile();
    const store = deviceStore();
    const device = await store.getDevice("DEVICE-002");
    assert.equal(device?.status, "APPROVED");

    const credentials = await store.credentialsOf("DEVICE-002");
    assert.equal(credentials.length, 1);
    const root = credentials[0]!;
    assert.equal(root.kind, "ROOT");
    assert.equal(root.status, "ACTIVE");
    assert.equal(root.parentId, null);
    assert.equal(root.publicKeySpki, keyA.spki, "KEY-A's public key is the one already stored");
    assert.equal(root.credentialId, credentialIdFor(keyA));
    assert.equal(root.credentialId, device!.keyFingerprint, "the id shown on /device-admin before is the credential id now");

    assert.equal((await store.stats()).corrupt, 0);
    assert.equal(readFileSync(currentStorePath(), "utf8"), content, "reading migrates nothing on disk");
  });

  test("a session signed in before the upgrade still passes, and counts as the ROOT's", async () => {
    const { keyA, oldSession } = await oldStoreFile();
    assert.equal(await gate(oldSession.cookies), "passed");
    const binding = await deviceStore().sessionBinding(foFingerprint(oldSession.foToken));
    assert.equal(binding?.device.deviceId, "DEVICE-002");
    assert.equal(binding?.credential.credentialId, credentialIdFor(keyA));
  });

  test("KEY-A signs in after the upgrade, from an old page (no credential id) and from a new one", async () => {
    const { keyA, content } = await oldStoreFile();
    const browser: Holder = { key: keyA, deviceId: "DEVICE-002", credentialId: credentialIdFor(keyA) };

    const oldPage = await signIn(browser, "alice@plant.example", {}, false);
    assert.equal(oldPage.res.status, 200, JSON.stringify(oldPage.body));
    const newPage = await signIn(browser, "bob@plant.example", {}, true);
    assert.equal(newPage.res.status, 200, JSON.stringify(newPage.body));

    for (const s of [oldPage, newPage]) {
      const binding = await deviceStore().sessionBinding(foFingerprint(s.foToken!));
      assert.equal(binding?.credential.credentialId, browser.credentialId);
      assert.equal(await gate(s.cookies), "passed");
    }
    // No second device, no new enrollment, and the old lines are still the file's first lines.
    assert.deepEqual((await deviceStore().listDevices()).map((d) => d.deviceId), ["DEVICE-002"]);
    assert.equal((await deviceStore().stats()).enrollments, 1);
    assert.ok(readFileSync(currentStorePath(), "utf8").startsWith(content), "existing lines are untouched; new ones are appended");
  });

  test("and it can go straight on to an install grant: no new enrollment QR", async () => {
    const { keyA } = await oldStoreFile();
    const browser: Holder = { key: keyA, deviceId: "DEVICE-002", credentialId: credentialIdFor(keyA) };
    const grant = await requestGrant(browser);
    assert.equal(grant.status, 200, JSON.stringify(grant.body));
    const attached = await attach(grant.token);
    assert.equal(attached.status, 200);
    assert.equal(attached.holder!.deviceId, "DEVICE-002");
    assert.equal((await deviceStore().stats()).enrollments, 1, "no enrollment was created or used");
  });

  test("the browser computes the same credential id the server derives", async () => {
    const key = await newPhoneKey();
    assert.equal(await credentialIdOf(key.spki), credentialIdFor(key));
  });
});

/* ── Issuing a grant ───────────────────────────────────────────────────────── */

describe("an install grant is issued only to a device's ROOT credential, after a fresh proof", () => {
  test("the enrolling browser's proof → a grant in an httpOnly, Secure, Strict, path-scoped cookie; only its hash is stored", async () => {
    const browser = await enrolledBrowser();
    const grant = await requestGrant(browser);
    assert.equal(grant.status, 200, JSON.stringify(grant.body));
    assert.match(grant.token ?? "", /^[A-Za-z0-9_-]{43}$/);

    const header = grant.res.headers.getSetCookie().find((c) => c.startsWith(`${GRANT_COOKIE}=`))!.toLowerCase();
    assert.ok(header.includes("httponly"), header);
    assert.ok(header.includes("secure"), header);
    assert.ok(header.includes("samesite=strict"), header);
    assert.ok(header.includes(`path=${INSTALL_GRANT_PATH}`), header);
    // The grant does not run out (14 October 2026); the cookie lives as long as a browser keeps one.
    assert.equal(INSTALL_GRANT_TTL_MS, null);
    assert.ok(header.includes(`max-age=${INSTALL_GRANT_COOKIE_MS / 1000}`), header);
    assert.equal((await deviceStore().lookupGrant(grant.token!, Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)).kind, "valid", "still usable in ten years");

    assert.ok(!JSON.stringify(grant.body).includes(grant.token!), "the code is never in a response body");
    const file = readFileSync(currentStorePath(), "utf8");
    assert.ok(!file.includes(grant.token!), "the code is never stored");
    assert.ok(file.includes(hashSecret(grant.token!)), "its hash is");
    assert.ok(logged.some((line) => line.includes("INSTALL_GRANT_ISSUED")));
  });

  test("it authenticates nothing: the grant cookie alone opens no page and signs nobody in", async () => {
    const browser = await enrolledBrowser();
    const grant = await requestGrant(browser);
    const res = await proxy(request("/home", { cookies: { [GRANT_COOKIE]: grant.token } }));
    assert.equal(redirectedTo(res), "/login");
    assert.equal(foCalls.filter((c) => c.path === "/api/auth/login").length, 0);
  });

  test("a browser asking again while it holds the outstanding grant keeps the one it has", async () => {
    const browser = await enrolledBrowser();
    const first = await requestGrant(browser);
    const again = await requestGrant(browser, first.token);
    assert.equal(again.status, 200);
    assert.equal(again.body.kept, true);
    assert.equal(again.token, null, "no new cookie: the outstanding grant stands");
    assert.equal((await deviceStore().lookupGrant(first.token!)).kind, "valid");
    assert.equal((await deviceStore().stats()).grants, 1);
  });

  test("a browser that lost its grant cookie is given a new grant, and the lost one is cancelled", async () => {
    const browser = await enrolledBrowser();
    const first = await requestGrant(browser);
    const again = await requestGrant(browser, null);
    assert.equal(again.status, 200);
    assert.equal(again.body.kept, false);
    assert.ok(again.token && again.token !== first.token);
    assert.equal((await deviceStore().lookupGrant(first.token!)).kind, "cancelled");
    assert.equal((await deviceStore().lookupGrant(again.token!)).kind, "valid");
  });

  test("an installed app's credential cannot obtain a grant, at the challenge or at the grant route", async () => {
    const { app } = await browserAndApp();
    const refused = await requestGrant(app);
    assert.equal(refused.step, "challenge");
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "not_root");

    // Even with a valid signature of its own over a sign-in challenge: wrong purpose, and not a ROOT.
    const c = await challenge(app);
    const res = await GRANT(
      request(`${INSTALL_GRANT_PATH}/grant`, {
        json: { deviceId: app.deviceId, credentialId: app.credentialId, challengeId: c.body.challengeId, signature: await signChallenge(app.key, c.body.challenge!) },
      }),
    );
    assert.equal(res.status, 403);
    assert.equal(setCookie(res, GRANT_COOKIE), undefined);
    assert.equal((await deviceStore().issueGrant({ credentialId: app.credentialId, ttlMs: 60_000 })).kind, "not_root");
  });

  test("a client cannot say what it is: unknown fields are refused, and the kind comes from the store", async () => {
    const browser = await enrolledBrowser();
    const c = await challenge(browser, "grant");
    const res = await GRANT(
      request(`${INSTALL_GRANT_PATH}/grant`, {
        json: { deviceId: browser.deviceId, credentialId: browser.credentialId, challengeId: c.body.challengeId, signature: await signChallenge(browser.key, c.body.challenge!), kind: "ROOT" },
      }),
    );
    assert.equal(res.status, 400);

    const grant = await requestGrant(browser);
    const key = await newPhoneKey();
    const start = await ATTACH_START(request(`${INSTALL_GRANT_PATH}/attach/start`, { cookies: { [GRANT_COOKIE]: grant.token }, json: {} }));
    const s = (await start.json()) as { challengeId: string; challenge: string };
    const claimed = await ATTACH_COMPLETE(
      request(`${INSTALL_GRANT_PATH}/attach/complete`, {
        cookies: { [GRANT_COOKIE]: grant.token },
        json: { challengeId: s.challengeId, publicKeySpki: key.spki, signature: await signChallenge(key, s.challenge), kind: "ROOT" },
      }),
    );
    assert.equal(claimed.status, 400, "a body that claims a kind is not a valid attach request");
  });

  test("a grant proof cannot be replayed, and a sign-in proof is not a grant proof", async () => {
    const browser = await enrolledBrowser();
    const c = await challenge(browser, "grant");
    const json = { deviceId: browser.deviceId, credentialId: browser.credentialId, challengeId: c.body.challengeId, signature: await signChallenge(browser.key, c.body.challenge!) };
    assert.equal((await GRANT(request(`${INSTALL_GRANT_PATH}/grant`, { json }))).status, 200);
    assert.equal((await GRANT(request(`${INSTALL_GRANT_PATH}/grant`, { json }))).status, 403, "the challenge was spent");

    const signInChallenge = await challenge(browser);
    const wrongPurpose = await GRANT(
      request(`${INSTALL_GRANT_PATH}/grant`, {
        json: { deviceId: browser.deviceId, credentialId: browser.credentialId, challengeId: signInChallenge.body.challengeId, signature: await signChallenge(browser.key, signInChallenge.body.challenge!) },
      }),
    );
    assert.equal(wrongPurpose.status, 403);
    assert.ok(logged.some((line) => line.includes("INSTALL_GRANT_REJECTED") && line.includes("proof_wrong_purpose")));
  });

  test("another key's signature does not answer a credential's challenge", async () => {
    const { browser, app } = await browserAndApp();
    // The app signs the browser's grant challenge with its own key.
    const c = await challenge(browser, "grant");
    const res = await GRANT(
      request(`${INSTALL_GRANT_PATH}/grant`, {
        json: { deviceId: browser.deviceId, credentialId: browser.credentialId, challengeId: c.body.challengeId, signature: await signChallenge(app.key, c.body.challenge!) },
      }),
    );
    assert.equal(res.status, 403);
    // And the browser's sign-in challenge, signed by the app, signs nobody in.
    const s = await challenge(browser);
    const login = await LOGIN(
      request("/api/pwa/auth/login", {
        json: {
          email: "alice@plant.example",
          password: "alice-pass",
          device: { deviceId: browser.deviceId, credentialId: browser.credentialId, challengeId: s.body.challengeId, signature: await signChallenge(app.key, s.body.challenge!) },
        },
      }),
    );
    assert.equal(login.status, 403);
    assert.equal(foCalls.filter((call) => call.path === "/api/auth/login").length, 0, "refused before the password is checked");
  });

  test("cross-site requests are refused, and the switch turns the whole mechanism off", async () => {
    const browser = await enrolledBrowser();
    const crossSite = { "sec-fetch-site": "cross-site" };
    assert.equal((await GRANT(request(`${INSTALL_GRANT_PATH}/grant`, { headers: crossSite, json: {} }))).status, 403);
    assert.equal((await ATTACH_START(request(`${INSTALL_GRANT_PATH}/attach/start`, { headers: crossSite, json: {} }))).status, 403);
    assert.equal((await ATTACH_COMPLETE(request(`${INSTALL_GRANT_PATH}/attach/complete`, { headers: crossSite, json: {} }))).status, 403);
    assert.equal((await FORGET(request("/api/pwa/auth/forget", { headers: crossSite, json: {} }))).status, 403);

    const grant = await requestGrant(browser);
    process.env.DEVICE_INSTALL_GRANTS = "off";
    assert.equal((await requestGrant(browser)).status, 404);
    assert.equal((await attach(grant.token)).status, 404);
    // Sign-in is untouched by the switch.
    assert.equal((await signIn(browser)).res.status, 200);
  });
});

/* ── Using a grant ─────────────────────────────────────────────────────────── */

describe("the installed app attaches its own key to the browser's device", () => {
  test("KEY-B becomes an APP credential of the same DEVICE-nnn: no second device, no enrollment", async () => {
    const browser = await enrolledBrowser();
    const grant = await requestGrant(browser);
    const attached = await attach(grant.token);
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    const app = attached.holder!;

    assert.equal(app.deviceId, browser.deviceId, "the same device");
    assert.notEqual(app.credentialId, browser.credentialId, "its own key");
    assert.deepEqual((await deviceStore().listDevices()).map((d) => d.deviceId), [browser.deviceId]);
    assert.equal((await deviceStore().stats()).enrollments, 1, "the enrollment that approved the browser, and no other");

    const [root, child] = await deviceStore().credentialsOf(browser.deviceId);
    assert.equal(root!.kind, "ROOT");
    assert.equal(root!.publicKeySpki, browser.key.spki, "KEY-A is unchanged");
    assert.equal(child!.kind, "APP");
    assert.equal(child!.status, "ACTIVE");
    assert.equal(child!.parentId, browser.credentialId);
    assert.equal(child!.publicKeySpki, app.key.spki);
    assert.equal(child!.context, "installed-app");

    assert.equal(setCookie(attached.res, GRANT_COOKIE), "", "the spent grant is cleared from the app");
    assert.ok(logged.some((line) => line.includes("CREDENTIAL_ATTACHED") && line.includes(app.credentialId)));
  });

  test("a grant works once: the same cookie attaches nothing a second time", async () => {
    const { browser, grantToken } = await browserAndApp();
    const second = await attach(grantToken);
    assert.equal(second.status, 410);
    assert.equal(second.body.reason, "consumed");
    assert.equal((await deviceStore().credentialsOf(browser.deviceId)).length, 2);
  });

  test("six apps racing with one grant: exactly one attaches", async () => {
    const browser = await enrolledBrowser();
    const grant = await requestGrant(browser);
    const keys = await Promise.all(Array.from({ length: 6 }, () => newPhoneKey()));
    const results = await Promise.all(
      keys.map((key) => deviceStore().attachCredential({ token: grant.token!, publicKeySpki: key.spki, context: "installed-app" })),
    );
    assert.equal(results.filter((r) => r.kind === "attached").length, 1);
    assert.equal(results.filter((r) => r.kind === "consumed").length, 5);
    assert.equal((await deviceStore().credentialsOf(browser.deviceId)).filter((c) => c.kind === "APP").length, 1);
  });

  test("a grant given a lifetime, and past it, attaches nothing (a grant line written before 14 October 2026 has one)", async () => {
    const browser = await enrolledBrowser();
    const store = deviceStore();
    const issuedAt = Date.now();
    const issued = await store.issueGrant({ credentialId: browser.credentialId, ttlMs: SHORT_TTL_MS, now: issuedAt });
    assert.equal(issued.kind, "issued");
    const token = (issued as { token: string }).token;
    secrets.push(token);
    const late = issuedAt + SHORT_TTL_MS + 1;
    assert.equal((await store.lookupGrant(token, late)).kind, "expired");
    const result = await store.attachCredential({ token, publicKeySpki: (await newPhoneKey()).spki, context: "installed-app", now: late });
    assert.equal(result.kind, "expired");
    assert.equal((await store.credentialsOf(browser.deviceId)).length, 1);
  });

  test("a new grant cancels the one before it: one outstanding grant per device", async () => {
    const browser = await enrolledBrowser();
    const store = deviceStore();
    const t0 = Date.now();
    const first = (await store.issueGrant({ credentialId: browser.credentialId, ttlMs: INSTALL_GRANT_TTL_MS, now: t0 })) as { token: string };
    // The browser asks again once the first's cookie is close to running out.
    const t1 = t0 + INSTALL_GRANT_COOKIE_MS - INSTALL_GRANT_RENEW_BELOW_MS + 1000;
    const second = (await store.issueGrant({ credentialId: browser.credentialId, ttlMs: INSTALL_GRANT_TTL_MS, now: t1 })) as { token: string };
    secrets.push(first.token, second.token);

    assert.equal((await store.lookupGrant(first.token, t1)).kind, "cancelled", "the first still had time left, and is cancelled anyway");
    assert.equal((await store.lookupGrant(second.token, t1)).kind, "valid");
    const stale = await attach(first.token);
    assert.equal(stale.status, 410);
    assert.equal(stale.body.reason, "cancelled");
    assert.equal(setCookie(stale.res, GRANT_COOKIE), "", "a grant that can never work is dropped from the app");
    assert.ok(logged.some((line) => line.includes("INSTALL_GRANT_REJECTED") && line.includes("grant_cancelled")));
  });

  test("no grant cookie, or a made-up one: nothing happens, and no key is asked for", async () => {
    const none = await attach(null);
    assert.equal(none.status, 404);
    assert.equal(none.body.code, "no_install_grant");
    const invented = await attach("z".repeat(43));
    assert.equal(invented.status, 410);
    assert.equal(invented.body.reason, "unknown");
    assert.equal((await deviceStore().stats()).credentials, 0);
  });

  test("the attach proof is bound to the grant and to the new key, and cannot be replayed", async () => {
    const browser = await enrolledBrowser();
    const grant = await requestGrant(browser);
    const cookies = { [GRANT_COOKIE]: grant.token };
    const keyB = await newPhoneKey();
    const other = await newPhoneKey();

    // Signed by a key other than the one being registered.
    let start = (await (await ATTACH_START(request(`${INSTALL_GRANT_PATH}/attach/start`, { cookies, json: {} }))).json()) as { challengeId: string; challenge: string };
    const forged = await ATTACH_COMPLETE(
      request(`${INSTALL_GRANT_PATH}/attach/complete`, {
        cookies,
        json: { challengeId: start.challengeId, publicKeySpki: keyB.spki, signature: await signChallenge(other, start.challenge) },
      }),
    );
    assert.equal(forged.status, 401);
    assert.equal((await deviceStore().lookupGrant(grant.token!)).kind, "valid", "a failed proof does not spend the grant");

    // A sign-in challenge is not an attach challenge.
    const signInChallenge = await challenge(browser);
    const wrongPurpose = await ATTACH_COMPLETE(
      request(`${INSTALL_GRANT_PATH}/attach/complete`, {
        cookies,
        json: { challengeId: signInChallenge.body.challengeId, publicKeySpki: keyB.spki, signature: await signChallenge(keyB, signInChallenge.body.challenge!) },
      }),
    );
    assert.equal(wrongPurpose.status, 401);

    // The real one works, and its proof cannot be used again with a new grant.
    start = (await (await ATTACH_START(request(`${INSTALL_GRANT_PATH}/attach/start`, { cookies, json: {} }))).json()) as { challengeId: string; challenge: string };
    const json = { challengeId: start.challengeId, publicKeySpki: keyB.spki, signature: await signChallenge(keyB, start.challenge) };
    assert.equal((await ATTACH_COMPLETE(request(`${INSTALL_GRANT_PATH}/attach/complete`, { cookies, json }))).status, 200);
    assert.equal((await ATTACH_COMPLETE(request(`${INSTALL_GRANT_PATH}/attach/complete`, { cookies, json }))).status, 410);
    assert.equal((await deviceStore().credentialsOf(browser.deviceId)).length, 2);
  });

  test("the browser's own key cannot be attached as an app: one key, one credential", async () => {
    const browser = await enrolledBrowser();
    const grant = await requestGrant(browser);
    const again = await attach(grant.token, { key: browser.key });
    assert.equal(again.status, 410);
    assert.equal(again.body.reason, "bad_key");
    assert.equal((await deviceStore().lookupGrant(grant.token!)).kind, "valid", "and the grant is not spent on the attempt");
  });
});

/* ── Sessions: the browser's and the app's ─────────────────────────────────── */

describe("the browser and the installed app sign in for themselves", () => {
  test("the app signs in with KEY-B; each session is bound to its own credential", async () => {
    const { browser, app } = await browserAndApp();
    const inBrowser = await signIn(browser, "alice@plant.example");
    const inApp = await signIn(app, "alice@plant.example");
    assert.equal(inBrowser.res.status, 200);
    assert.equal(inApp.res.status, 200, JSON.stringify(inApp.body));

    const store = deviceStore();
    const b = await store.sessionBinding(foFingerprint(inBrowser.foToken!));
    const a = await store.sessionBinding(foFingerprint(inApp.foToken!));
    assert.equal(b?.device.deviceId, a?.device.deviceId, "one device");
    assert.equal(b?.credential.kind, "ROOT");
    assert.equal(a?.credential.kind, "APP");
    assert.equal(a?.credential.credentialId, app.credentialId);
    assert.equal(await gate(inBrowser.cookies), "passed");
    assert.equal(await gate(inApp.cookies), "passed");
  });

  test("the app's first sign-in arrives with the browser's copied cookie, and does not end the browser's session", async () => {
    const browser = await enrolledBrowser();
    const inBrowser = await signIn(browser, "alice@plant.example");
    const grant = await requestGrant(browser);
    // iOS copies the browser's cookies into the new app: its session cookie and the grant.
    const copied: Cookies = { ...inBrowser.cookies, [GRANT_COOKIE]: grant.token };
    const attached = await attach(grant.token, { cookies: copied });
    assert.equal(attached.status, 200);

    const inApp = await signIn(attached.holder!, "alice@plant.example", copied);
    assert.equal(inApp.res.status, 200, JSON.stringify(inApp.body));
    await settle();

    assert.notEqual(inApp.foToken, inBrowser.foToken, "the app has a session of its own");
    assert.ok(!revokedAtFo().includes(inBrowser.foToken), "the browser's session was not revoked at FabOrchestrator");
    assert.equal(await gate(inBrowser.cookies), "passed", "the browser is still signed in");
    assert.ok(logged.some((line) => line.includes("session_forgotten") && line.includes("replaced_foreign")));
  });

  test("a sign-in still ends the session it replaces when that session is its own", async () => {
    const browser = await enrolledBrowser();
    const first = await signIn(browser, "alice@plant.example");
    const second = await signIn(browser, "alice@plant.example", first.cookies);
    assert.equal(second.res.status, 200);
    await settle();
    assert.ok(revokedAtFo().includes(first.foToken), "the browser's own earlier session is revoked, as before");
  });

  test("opening the app on a page with the copied cookie forgets it there and revokes nothing", async () => {
    const browser = await enrolledBrowser();
    const inBrowser = await signIn(browser, "alice@plant.example");

    // The copied cookie passes the device gate: it is a healthy session.
    assert.equal(await gate(inBrowser.cookies), "passed");
    // The page finds no bearer in the app's storage and asks the server to forget the cookie.
    const res = await FORGET(request("/api/pwa/auth/forget", { cookies: inBrowser.cookies, json: { reason: "fo_token_missing" } }));
    await settle();
    assert.equal(res.status, 200);
    assert.equal(setCookie(res, FO_TOKEN_COOKIE), "", "cleared from the app's cookies");
    assert.deepEqual(revokedAtFo(), [], "FabOrchestrator was not asked to end anything");
    assert.equal(await gate(inBrowser.cookies), "passed", "the browser, which still holds the cookie, is still signed in");
  });

  test("the device-check page: a healthy session that is another credential's is forgotten, never revoked", async () => {
    const browser = await enrolledBrowser();
    const inBrowser = await signIn(browser, "alice@plant.example");
    const res = await LOGOUT(request("/api/pwa/auth/logout", { cookies: inBrowser.cookies, json: { reason: "device_blocked" } }));
    await settle();
    assert.equal(setCookie(res, FO_TOKEN_COOKIE), "");
    assert.deepEqual(revokedAtFo(), []);
    assert.equal(await gate(inBrowser.cookies), "passed");
  });

  test("the device-check page still ends a session whose device was revoked, or that never proved a device", async () => {
    const browser = await enrolledBrowser();
    const inBrowser = await signIn(browser, "alice@plant.example");
    await deviceStore().revokeDevice(browser.deviceId, { by: "admin@plant.example", reason: "lost" });
    await LOGOUT(request("/api/pwa/auth/logout", { cookies: inBrowser.cookies, json: { reason: "device_blocked" } }));
    await settle();
    assert.ok(revokedAtFo().includes(inBrowser.foToken));

    const unbound = sessionOf("bob@plant.example");
    await LOGOUT(request("/api/pwa/auth/logout", { cookies: unbound.cookies, json: { reason: "device_blocked" } }));
    await settle();
    assert.ok(revokedAtFo().includes(unbound.foToken));
  });

  test("forgetting a cookie and joining a device are never blocked for the session's device", async () => {
    const unbound = sessionOf("alice@plant.example"); // blocked anywhere else
    assert.equal(await gate(unbound.cookies), "blocked:session");
    for (const path of [
      "/api/pwa/auth/forget",
      `${INSTALL_GRANT_PATH}/grant`,
      `${INSTALL_GRANT_PATH}/attach/start`,
      `${INSTALL_GRANT_PATH}/attach/complete`,
    ]) {
      const res = await proxy(request(path, { cookies: unbound.cookies, method: "POST" }));
      assert.notEqual(res.status, 403, `${path} must reach its route`);
    }
    // The exemption is exact: a neighbouring route is still refused.
    assert.equal((await proxy(request(`${INSTALL_GRANT_PATH}/anything-else`, { cookies: unbound.cookies, method: "POST" }))).status, 403);
    assert.equal((await proxy(request("/api/pwa/devices", { cookies: unbound.cookies }))).status, 403);
  });

  test("the switch: unset or `on` enables install grants, anything else turns them off", () => {
    assert.equal(installGrantsEnabled({}), true);
    assert.equal(installGrantsEnabled({ DEVICE_INSTALL_GRANTS: " On " }), true);
    for (const value of ["off", "0", "false", "enforce", "no"]) {
      assert.equal(installGrantsEnabled({ DEVICE_INSTALL_GRANTS: value }), false, value);
    }
  });

  test("an ordinary sign-out by the session's owner still revokes it", async () => {
    const browser = await enrolledBrowser();
    const inBrowser = await signIn(browser, "alice@plant.example");
    await LOGOUT(request("/api/pwa/auth/logout", { cookies: inBrowser.cookies, json: { reason: "user" } }));
    await settle();
    assert.ok(revokedAtFo().includes(inBrowser.foToken));
  });
});

/* ── Reinstalling ──────────────────────────────────────────────────────────── */

describe("reinstalling the app supersedes the earlier install", () => {
  test("APP-C becomes ACTIVE, APP-B SUPERSEDED, and APP-B's session stops on its next request", async () => {
    const { browser, app: appB } = await browserAndApp();
    const sessionB = await signIn(appB, "alice@plant.example");
    assert.equal(await gate(sessionB.cookies), "passed");

    // The browser keeps issuing grants; the reinstalled app gets a later one.
    const store = deviceStore();
    const later = Date.now() + 60_000;
    const issued = (await store.issueGrant({ credentialId: browser.credentialId, ttlMs: INSTALL_GRANT_TTL_MS, now: later })) as { token: string };
    secrets.push(issued.token);
    const keyC = await newPhoneKey();
    const result = await store.attachCredential({ token: issued.token, publicKeySpki: keyC.spki, context: "installed-app", now: later + 1000 });
    assert.equal(result.kind, "attached");
    const appC: Holder = { key: keyC, deviceId: browser.deviceId, credentialId: credentialIdFor(keyC) };

    const credentials = await store.credentialsOf(browser.deviceId);
    const status = (id: string) => credentials.find((c) => c.credentialId === id)?.status;
    assert.equal(status(browser.credentialId), "ACTIVE");
    assert.equal(status(appB.credentialId), "SUPERSEDED");
    assert.equal(status(appC.credentialId), "ACTIVE");
    assert.equal(credentials.filter((c) => c.kind === "APP" && c.status === "ACTIVE").length, 1, "one installed app per device");
    assert.equal((result as { superseded: { credentialId: string }[] }).superseded[0]?.credentialId, appB.credentialId);

    // APP-B: its session is stopped, its sign-in refused, and its session ended at FabOrchestrator.
    assert.equal(await gate(sessionB.cookies), "blocked:credential");
    const again = await signIn(appB, "alice@plant.example");
    assert.equal(again.res.status, 403);
    assert.equal(again.body.code, "credential_revoked");
    await LOGOUT(request("/api/pwa/auth/logout", { cookies: sessionB.cookies, json: { reason: "device_blocked" } }));
    await settle();
    assert.ok(revokedAtFo().includes(sessionB.foToken), "a superseded credential's session is ended, not just forgotten");

    // APP-C and the browser carry on.
    assert.equal((await signIn(appC, "alice@plant.example")).res.status, 200);
    assert.equal((await signIn(browser, "alice@plant.example")).res.status, 200);
  });

  test("the attach route reports the supersession in the audit log", async () => {
    const { browser, app: appB } = await browserAndApp();
    const store = deviceStore();
    // Past the renewal margin, so the browser's next request is given a new grant.
    const issued = (await store.issueGrant({ credentialId: browser.credentialId, ttlMs: INSTALL_GRANT_TTL_MS })) as { token: string };
    secrets.push(issued.token);
    const second = await attach(issued.token);
    assert.equal(second.status, 200);
    assert.ok(logged.some((line) => line.includes("CREDENTIAL_SUPERSEDED") && line.includes(appB.credentialId)));
  });
});

/* ── Revocation ────────────────────────────────────────────────────────────── */

describe("revoking a device stops every credential; revoking a credential stops only that one", () => {
  test("revoking the device blocks the browser and the app, their sign-ins, and any outstanding grant", async () => {
    const admin = await administrator();
    const { browser, app } = await browserAndApp();
    const inBrowser = await signIn(browser, "alice@plant.example");
    const inApp = await signIn(app, "bob@plant.example");
    const store = deviceStore();
    const outstanding = (await store.issueGrant({ credentialId: browser.credentialId, ttlMs: INSTALL_GRANT_TTL_MS })) as { token: string };
    secrets.push(outstanding.token);
    assert.equal((await store.lookupGrant(outstanding.token)).kind, "valid");

    const signedBefore = await challenge(app);
    assert.equal(signedBefore.res.status, 200);

    assert.equal((await revokeDevice(admin, browser.deviceId)).status, 200);

    assert.equal(await gate(inBrowser.cookies), "blocked:revoked");
    // Refused at the challenge now; and a proof for a challenge issued before
    // the revocation is refused by sign-in itself.
    assert.equal((await challenge(browser)).res.status, 403);
    assert.equal((await signInWith(app, signedBefore)).body.code, "device_revoked");
    assert.equal(await gate(inApp.cookies), "blocked:revoked");
    assert.equal((await signIn(browser)).body.code, "device_revoked");
    assert.equal((await signIn(app)).body.code, "device_revoked");
    assert.equal((await store.lookupGrant(outstanding.token)).kind, "cancelled");
    assert.equal((await attach(outstanding.token)).status, 410);
    assert.equal((await requestGrant(browser)).status, 403, "a revoked device's browser gets no new grant");
    // The administrator's own device is another device, and is untouched.
    assert.equal(await gate(admin.cookies), "passed");
  });

  test("revoking the app's credential stops the app only", async () => {
    const admin = await administrator();
    const { browser, app } = await browserAndApp();
    const inBrowser = await signIn(browser, "alice@plant.example");
    const inApp = await signIn(app, "alice@plant.example");

    const res = await revokeCredential(admin, app.deviceId, app.credentialId);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { credential: { status: string; kind: string }; changed: boolean };
    assert.equal(body.credential.status, "REVOKED");
    assert.equal(body.changed, true);
    assert.ok(logged.some((line) => line.includes("CREDENTIAL_REVOKED") && line.includes(app.credentialId)));

    assert.equal(await gate(inApp.cookies), "blocked:credential");
    assert.equal((await signIn(app)).body.code, "credential_revoked");
    assert.equal(await gate(inBrowser.cookies), "passed", "the browser is untouched");
    assert.equal((await signIn(browser)).res.status, 200);
    assert.equal((await deviceStore().getDevice(browser.deviceId))?.status, "APPROVED");
    // The browser can approve a fresh install of the app.
    assert.equal((await requestGrant(browser)).status, 200);
    // Idempotent.
    assert.equal(((await (await revokeCredential(admin, app.deviceId, app.credentialId)).json()) as { changed: boolean }).changed, false);
  });

  test("revoking the browser's credential stops the browser and its grants; the app already attached carries on", async () => {
    const admin = await administrator();
    const { browser, app } = await browserAndApp();
    const inBrowser = await signIn(browser, "alice@plant.example");
    const inApp = await signIn(app, "alice@plant.example");
    const store = deviceStore();
    const outstanding = (await store.issueGrant({ credentialId: browser.credentialId, ttlMs: INSTALL_GRANT_TTL_MS })) as { token: string };
    secrets.push(outstanding.token);

    assert.equal((await revokeCredential(admin, browser.deviceId, browser.credentialId)).status, 200);

    assert.equal(await gate(inBrowser.cookies), "blocked:credential");
    assert.equal((await store.lookupGrant(outstanding.token)).kind, "cancelled", "its outstanding grant is cancelled");
    assert.equal((await requestGrant(browser)).status, 403);
    assert.equal(await gate(inApp.cookies), "passed");
    assert.equal((await signIn(app)).res.status, 200);
  });

  test("a credential is revoked only under its own device, and only by a device administrator", async () => {
    const admin = await administrator();
    const { browser, app } = await browserAndApp();
    // The right credential id under the wrong device.
    assert.equal((await revokeCredential(admin, admin.browser.deviceId, app.credentialId)).status, 404);
    assert.equal((await revokeCredential(admin, browser.deviceId, "0".repeat(32))).status, 404);

    const alice = sessionOf("alice@plant.example");
    await bindSession(alice.foToken, browser.deviceId, browser.credentialId);
    const notAdmin = await REVOKE_CREDENTIAL(
      request(`/api/pwa/devices/${app.deviceId}/credentials/${app.credentialId}/revoke`, { cookies: alice.cookies, headers: { authorization: alice.bearer }, json: {} }),
      { params: Promise.resolve({ deviceId: app.deviceId, credentialId: app.credentialId }) },
    );
    assert.equal(notAdmin.status, 403);
    assert.equal((await deviceStore().credential(app.credentialId))?.status, "ACTIVE");
  });

  test("the administrator's device list shows each device's credentials, and nothing secret", async () => {
    const admin = await administrator();
    const { browser, app, grantToken } = await browserAndApp();
    const res = await LIST_DEVICES(request("/api/pwa/devices", { cookies: admin.cookies, headers: admin.headers }));
    const text = await res.text();
    const body = JSON.parse(text) as {
      devices: { deviceId: string; credentials: { credentialId: string; kind: string; status: string }[] }[];
      currentCredentialId: string;
    };
    const device = body.devices.find((d) => d.deviceId === browser.deviceId)!;
    assert.deepEqual(
      device.credentials.map((c) => [c.kind, c.status, c.credentialId]),
      [
        ["ROOT", "ACTIVE", browser.credentialId],
        ["APP", "ACTIVE", app.credentialId],
      ],
    );
    assert.equal(body.currentCredentialId, admin.browser.credentialId);
    for (const secret of [grantToken, hashSecret(grantToken), browser.key.spki, app.key.spki]) {
      assert.ok(!text.includes(secret), "no grant code, hash or public key in the list");
    }
  });
});

/* ── The store's own rules ─────────────────────────────────────────────────── */

describe("the store refuses records that would attach a key it should not", () => {
  test("an attached line for a grant that was not usable attaches nothing, however it got into the file", async () => {
    const browser = await enrolledBrowser();
    const store = deviceStore();
    const issued = (await store.issueGrant({ credentialId: browser.credentialId, ttlMs: 60_000 })) as { token: string; grant: { grantId: string; expiresAt: number } };
    secrets.push(issued.token);
    const forged = await newPhoneKey();
    // Written after the grant expired.
    const line = serializeRecord({ t: "attached", gid: issued.grant.grantId, dev: browser.deviceId, pk: forged.spki, ctx: "installed-app", at: issued.grant.expiresAt + 1 });
    writeFileSync(currentStorePath(), `${readFileSync(currentStorePath(), "utf8")}${line}\n`);
    assert.equal((await store.credentialsOf(browser.deviceId)).length, 1);
    assert.equal((await store.stats()).corrupt, 1);
  });

  test("a grant line for an installed app's credential is not a grant", async () => {
    const { app } = await browserAndApp();
    const store = deviceStore();
    const before = (await store.stats()).grants;
    const line = serializeRecord({ t: "grant", id: "grt_AAAAAAAAAAAAAAAA", th: hashSecret("x".repeat(43)), dev: app.deviceId, cr: app.credentialId, at: Date.now(), exp: Date.now() + 60_000 });
    writeFileSync(currentStorePath(), `${readFileSync(currentStorePath(), "utf8")}${line}\n`);
    assert.equal((await store.stats()).grants, before);
    assert.equal((await store.lookupGrant("x".repeat(43))).kind, "unknown");
  });

  test("the state survives a restart: a fresh read of the same file gives the same credentials and grants", async () => {
    const { browser, app } = await browserAndApp();
    const { DeviceStore } = await import("@/lib/devices/store");
    const reread = new DeviceStore(currentStorePath());
    try {
      const credentials = await reread.credentialsOf(browser.deviceId);
      assert.deepEqual(credentials.map((c) => [c.kind, c.credentialId, c.status]), [
        ["ROOT", browser.credentialId, "ACTIVE"],
        ["APP", app.credentialId, "ACTIVE"],
      ]);
      assert.equal((await reread.latestGrant(browser.credentialId))?.state, "CONSUMED");
    } finally {
      await reread.close();
    }
  });
});

/* ── The two copies of the browser-side logic ──────────────────────────────── */

describe("fo-shell.js keeps the grant the same way keystore.ts does", () => {
  const shell = readFileSync(join(process.cwd(), "public", "fo-shell.js"), "utf8");

  test("the same storage key, routes, database and renewal margin", () => {
    assert.ok(shell.includes(`"${INSTALL_GRANT_UNTIL_KEY}"`));
    assert.ok(shell.includes(`"${INSTALL_GRANT_PATH}/grant"`));
    assert.ok(shell.includes(`"/api/pwa/device-auth/challenge"`));
    assert.ok(shell.includes(`indexedDB.open("fo-device", 1)`));
    assert.ok(shell.includes(`createObjectStore("credential", { keyPath: "id" })`));
    assert.match(shell, /GRANT_RENEW_BELOW_MS = 30 \* 24 \* 60 \* 60 \* 1000;/);
    assert.equal(INSTALL_GRANT_RENEW_BELOW_MS, 30 * 24 * 60 * 60 * 1000);
  });

  test("a page that never had a bearer is forgotten, and one that lost its bearer is signed out", () => {
    assert.ok(shell.includes(`endSession("/api/pwa/auth/forget", "fo_token_missing")`));
    assert.ok(shell.includes(`endSession("/api/pwa/auth/logout", "fo_signed_out")`));
  });
});
