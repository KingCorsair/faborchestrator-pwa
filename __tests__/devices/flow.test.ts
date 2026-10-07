/**
 * Device enrollment end to end, through the real proxy and route handlers,
 * against a stub FabOrchestrator (`lib/devices/`), with the Web Crypto device
 * stamp (6 October 2026):
 *
 *   admin creates a one-time enrollment QR → the device (installed app, or the
 *   browser the QR opened in) generates a non-exportable key pair and registers
 *   the public key → DEVICE-nnn, APPROVED. No email, no password, no cookie.
 *
 *   normal use: the sign-in page signs a fresh challenge with the stored key;
 *   the server checks it against the registered public key and the device's
 *   status **before** asking FabOrchestrator about the password; the session
 *   is bound to DEVICE-nnn, and every request on it is checked again, so a
 *   revoked device is stopped on its next request.
 *
 * Phones here hold real non-extractable Web Crypto keys (`newPhoneKey`).
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bindSession,
  currentStorePath,
  ENROLL_COOKIE,
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
import { NextResponse } from "next/server";
import { proxy } from "@/proxy";
import { describeDevice } from "@/lib/devices/metadata";
import { deviceStore } from "@/lib/devices/store";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { GET as ENROLL_LINK } from "@/app/device-enroll/[token]/route";
import { POST as START } from "@/app/api/pwa/device-enrollments/start/route";
import { POST as COMPLETE } from "@/app/api/pwa/device-enrollments/complete/route";
import { GET as LIST_ENROLLMENTS, POST as CREATE_ENROLLMENT } from "@/app/api/pwa/device-enrollments/route";
import { GET as LIST_DEVICES } from "@/app/api/pwa/devices/route";
import { POST as REVOKE } from "@/app/api/pwa/devices/[deviceId]/revoke/route";
import { POST as CHALLENGE } from "@/app/api/pwa/device-auth/challenge/route";
import { POST as LOGIN } from "@/app/api/pwa/auth/login/route";

/* ── Logs: captured for every test, and checked for secrets ────────────────── */

let logged: string[] = [];
let secrets: string[] = [];

beforeEach(async () => {
  await setUp({ gate: "enforce" });
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
  await tearDown();
});

/* ── Helpers ───────────────────────────────────────────────────────────────── */

type Cookies = Record<string, string | null>;
interface Phone {
  key: PhoneKey;
  deviceId: string | null;
}

/** What the proxy does with this request: "blocked" by the device gate, or "passed" it. */
async function gate(path: string, cookies: Cookies = {}, method = "GET") {
  const res = await proxy(request(path, { cookies, method }));
  if (redirectedTo(res) === "/device-blocked") return "blocked";
  if (res.status === 403 || res.status === 503) {
    const body = (await res.clone().json().catch(() => null)) as { code?: string } | null;
    if (!body || body.code === "device_not_approved" || body.code === "device_check_unavailable") return "blocked";
  }
  return "passed";
}

/** A device approved directly in the store (as the bootstrap CLI and a scan would), with its key. */
async function enrolledPhone(): Promise<Phone> {
  const key = await newPhoneKey();
  const store = deviceStore();
  const { token } = await store.createEnrollment({ createdBy: "bootstrap-cli", ttlMs: 600_000 });
  secrets.push(token);
  const result = await store.completeEnrollment({ token, publicKeySpki: key.spki, metadata: describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/130", false) });
  assert.equal(result.kind, "enrolled");
  return { key, deviceId: (result as { device: { deviceId: string } }).device.deviceId };
}

/** The administrator: an approved device, signed in, session bound to it. */
async function adminBrowser() {
  const phone = await enrolledPhone();
  const session = sessionOf("admin@plant.example");
  await bindSession(session.foToken, phone.deviceId!);
  return { phone, cookies: session.cookies, bearer: session.bearer };
}
type Admin = Awaited<ReturnType<typeof adminBrowser>>;

async function createEnrollment(admin: Admin, json: Record<string, unknown> = {}) {
  const res = await CREATE_ENROLLMENT(request("/api/pwa/device-enrollments", { cookies: admin.cookies, headers: { authorization: admin.bearer }, json }));
  const body = (await res.json()) as { url: string; qrSvg: string; enrollment: { enrollmentId: string } };
  assert.equal(res.status, 201, JSON.stringify(body));
  const token = new URL(body.url).pathname.split("/").pop()!;
  secrets.push(token);
  return { ...body, token };
}

/**
 * What the device does when it scans an Enrollment QR (`keystore.enroll`):
 * start (the code is checked first) → make a key → sign → complete.
 * `via: "cookie"` is the link path (the code in the pending cookie).
 */
async function scanEnrollment(token: string, opts: { key?: PhoneKey; via?: "body" | "cookie"; cookies?: Cookies } = {}) {
  const key = opts.key ?? (await newPhoneKey());
  const cookies = { ...(opts.cookies ?? {}), ...(opts.via === "cookie" ? { [ENROLL_COOKIE]: token } : {}) };
  const tokenBody = opts.via === "cookie" ? {} : { token };
  const start = await START(request("/api/pwa/device-enrollments/start", { cookies, json: tokenBody }));
  const s = (await start.json()) as { challengeId?: string; challenge?: string; reason?: string };
  if (start.status !== 200) return { status: start.status, step: "start" as const, body: s, key, deviceId: null };
  const res = await COMPLETE(
    request("/api/pwa/device-enrollments/complete", {
      cookies,
      json: { ...tokenBody, challengeId: s.challengeId, publicKeySpki: key.spki, signature: await signChallenge(key, s.challenge!), installedApp: true },
    }),
  );
  const body = (await res.json()) as { device?: { deviceId: string; keyFingerprint: string }; reason?: string; code?: string };
  return { status: res.status, step: "complete" as const, body, key, deviceId: body.device?.deviceId ?? null, res };
}

/** What the sign-in page does: get a challenge for its device, sign it, send it with the password. */
async function signIn(phone: Phone | null, email: string, password: string, opts: { proof?: Record<string, string> | null } = {}) {
  let device: Record<string, string> | undefined;
  if (opts.proof !== undefined) device = opts.proof ?? undefined;
  else if (phone?.deviceId) {
    const c = await CHALLENGE(request("/api/pwa/device-auth/challenge", { json: { deviceId: phone.deviceId } }));
    const cb = (await c.json()) as { challengeId: string; challenge: string };
    device = { deviceId: phone.deviceId, challengeId: cb.challengeId, signature: await signChallenge(phone.key, cb.challenge) };
  }
  const res = await LOGIN(request("/api/pwa/auth/login", { json: { email, password, ...(device ? { device } : {}) } }));
  const body = (await res.json()) as { token?: string; code?: string };
  const foToken = setCookie(res, FO_TOKEN_COOKIE);
  return { res, body, device, cookies: { [FO_TOKEN_COOKIE]: foToken ?? null } as Cookies, bearer: body.token ? `Bearer ${body.token}` : null };
}

const revoke = (admin: Admin, deviceId: string) =>
  REVOKE(request(`/api/pwa/devices/${deviceId}/revoke`, { cookies: admin.cookies, headers: { authorization: admin.bearer }, json: {} }), {
    params: Promise.resolve({ deviceId }),
  });

const foLogins = () => foCalls.filter((c) => c.path === "/api/auth/login").length;

/* ── The gate on every request ─────────────────────────────────────────────── */

describe("every request on a session is checked against the session's device", () => {
  test("a session that signed in with an approved device's proof passes, documents and APIs", async () => {
    const phone = await enrolledPhone();
    const s = sessionOf("alice@plant.example");
    await bindSession(s.foToken, phone.deviceId!);
    assert.equal(await gate("/home", s.cookies), "passed");
    assert.equal(await gate("/api/chat", s.cookies, "POST"), "passed");
  });

  test("a session that never proved a device is blocked (an old session, or a copied cookie)", async () => {
    const s = sessionOf("alice@plant.example");
    const res = await proxy(request("/home", { cookies: s.cookies }));
    assert.equal(redirectedTo(res), "/device-blocked");
    assert.match(res.headers.get("location") ?? "", /reason=session/);
    assert.equal(await gate("/api/chat", s.cookies, "POST"), "blocked");
    assert.equal(await gate("/api/conversations", s.cookies), "blocked");
    assert.equal((await proxy(request("/_next/static/chunks/app.js", { cookies: s.cookies }))).status, 403);
  });

  test("a session whose device was revoked is blocked on its next request", async () => {
    const phone = await enrolledPhone();
    const s = sessionOf("alice@plant.example");
    await bindSession(s.foToken, phone.deviceId!);
    await deviceStore().revokeDevice(phone.deviceId!, { by: "admin@plant.example", reason: "lost" });
    const res = await proxy(request("/home", { cookies: s.cookies }));
    assert.equal(redirectedTo(res), "/device-blocked");
    assert.match(res.headers.get("location") ?? "", /reason=revoked/);
    assert.equal(await gate("/api/chat", s.cookies, "POST"), "blocked");
  });

  test("no session: nothing to check here; documents go to sign-in, where the device must prove itself", async () => {
    const res = await proxy(request("/home"));
    assert.equal(redirectedTo(res), "/login");
    assert.equal(await gate("/login"), "passed");
  });

  test("sign-in, enrollment, sign-out and the install files are never blocked for a session's device", async () => {
    const s = sessionOf("alice@plant.example"); // unbound: would be blocked anywhere else
    for (const path of [
      "/device-blocked",
      "/device-enroll",
      `/device-enroll/${"a".repeat(43)}`,
      "/device-blocked/zxing_reader.wasm",
      "/api/pwa/device-enrollments/start",
      "/api/pwa/device-enrollments/complete",
      "/api/pwa/device-auth/challenge",
      "/login",
      "/api/pwa/auth/login",
      "/api/pwa/auth/logout",
      "/offline",
      "/sw.js",
      "/manifest.webmanifest",
      "/apple-touch-icon.png",
    ]) {
      assert.equal(await gate(path, s.cookies, path.startsWith("/api/") ? "POST" : "GET"), "passed", path);
    }
    assert.equal(await gate("/device-enroll/x/y", s.cookies), "blocked");
  });

  test("a store that cannot be used blocks sessions (fails closed), worded as unavailable", async () => {
    const s = sessionOf("alice@plant.example");
    delete process.env.DEVICE_STORE_PATH;
    const res = await proxy(request("/home", { cookies: s.cookies }));
    assert.match(res.headers.get("location") ?? "", /\/device-blocked\?reason=unavailable/);
    assert.equal((await proxy(request("/api/chat", { cookies: s.cookies, method: "POST" }))).status, 503);
  });

  test("any DEVICE_GATE value but off/empty enforces; off checks nothing", async () => {
    const s = sessionOf("alice@plant.example");
    process.env.DEVICE_GATE = "enforced-typo";
    assert.equal(await gate("/home", s.cookies), "blocked");
    process.env.DEVICE_GATE = "off";
    const res = proxy(request("/login"));
    assert.ok(res instanceof NextResponse, "with the gate off the proxy stays synchronous");
  });
});

/* ── Enrollment: the QR is the authorization, the key never leaves ─────────── */

describe("enrollment", () => {
  test("scanning a valid Enrollment QR makes DEVICE-nnn with this device's public key: no FabOrchestrator call, no secret issued, no cookie", async () => {
    const admin = await adminBrowser();
    const issued = await createEnrollment(admin, { friendlyName: "Phone A" });
    assert.match(issued.url, /^https:\/\/pwa\.test\/device-enroll\/[A-Za-z0-9_-]{43}$/);
    const before = foCalls.length;
    const result = await scanEnrollment(issued.token);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.deviceId, "DEVICE-002");
    assert.equal(foCalls.length, before, "FabOrchestrator is not asked anything");
    assert.equal(result.res!.headers.get("set-cookie")?.includes("fo_device"), false, "no device cookie");
    const device = await deviceStore().getDevice("DEVICE-002");
    assert.equal(device?.status, "APPROVED");
    assert.equal(device?.friendlyName, "Phone A");
    assert.equal(await deviceStore().publicKeyOf("DEVICE-002"), result.key.spki, "the server holds the public key");
  });

  test("the link path works too: opening the link moves the code into a cookie, and the page enrolls with it", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    const link = await ENROLL_LINK(request(`/device-enroll/${token}`), { params: Promise.resolve({ token }) });
    assert.equal(link.status, 303);
    assert.equal(redirectedTo(link), "/device-enroll");
    assert.ok(!(link.headers.get("location") ?? "").includes(token), "the code leaves the address bar");
    // Relative: on Fly a route handler's own URL is the listen address (0.0.0.0:3000).
    assert.equal(link.headers.get("location"), "/device-enroll");
    const pending = setCookie(link, ENROLL_COOKIE);
    assert.equal(pending, token);
    const result = await scanEnrollment(token, { via: "cookie" });
    assert.equal(result.status, 200);
    assert.equal(setCookie(result.res!, ENROLL_COOKIE), "", "the pending code is cleared");
  });

  test("opening the link alone spends nothing: a link preview cannot burn the QR", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    await ENROLL_LINK(request(`/device-enroll/${token}`), { params: Promise.resolve({ token }) });
    await ENROLL_LINK(request(`/device-enroll/${token}`), { params: Promise.resolve({ token }) });
    assert.equal((await deviceStore().lookupEnrollment(token)).kind, "valid");
  });

  test("a used QR fails at the first step, before any key would be made; so does an expired one", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    assert.equal((await scanEnrollment(token)).status, 200);
    const again = await scanEnrollment(token);
    assert.equal(again.step, "start");
    assert.equal(again.status, 410);
    assert.equal((again.body as { reason?: string }).reason, "used");

    const second = await createEnrollment(admin);
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      const expired = await scanEnrollment(second.token);
      assert.equal(expired.status, 410);
      assert.equal((expired.body as { reason?: string }).reason, "expired");
    } finally {
      Date.now = realNow;
    }
  });

  test("enrollment needs proof of the private key: a signature by another key is refused and the QR stays unused", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    const claimed = await newPhoneKey();
    const other = await newPhoneKey();
    const s = (await (await START(request("/api/pwa/device-enrollments/start", { json: { token } }))).json()) as { challengeId: string; challenge: string };
    const res = await COMPLETE(
      request("/api/pwa/device-enrollments/complete", {
        json: { token, challengeId: s.challengeId, publicKeySpki: claimed.spki, signature: await signChallenge(other, s.challenge) },
      }),
    );
    assert.equal(res.status, 401);
    assert.equal((await deviceStore().lookupEnrollment(token)).kind, "valid");
  });

  test("only EC P-256 keys are registered", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    const key = await newPhoneKey("P-384");
    const s = (await (await START(request("/api/pwa/device-enrollments/start", { json: { token } }))).json()) as { challengeId: string; challenge: string };
    const res = await COMPLETE(
      request("/api/pwa/device-enrollments/complete", { json: { token, challengeId: s.challengeId, publicKeySpki: key.spki, signature: "A".repeat(86) } }),
    );
    assert.notEqual(res.status, 200);
  });

  test("simultaneous use of one QR by several phones: exactly one becomes a device", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    const keys = await Promise.all(Array.from({ length: 6 }, () => newPhoneKey()));
    const starts = await Promise.all(keys.map(async () => (await (await START(request("/api/pwa/device-enrollments/start", { json: { token } }))).json()) as { challengeId: string; challenge: string }));
    const results = await Promise.all(
      keys.map(async (key, i) =>
        COMPLETE(
          request("/api/pwa/device-enrollments/complete", {
            json: { token, challengeId: starts[i]!.challengeId, publicKeySpki: key.spki, signature: await signChallenge(key, starts[i]!.challenge) },
          }),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 410).length, 5);
    assert.equal((await deviceStore().listDevices()).length, 2, "the admin's device and exactly one new one");
  });

  test("an enrollment cannot be tied to a user: a request naming one is refused", async () => {
    const admin = await adminBrowser();
    const res = await CREATE_ENROLLMENT(
      request("/api/pwa/device-enrollments", { cookies: admin.cookies, headers: { authorization: admin.bearer }, json: { email: "alice@plant.example" } }),
    );
    assert.equal(res.status, 400);
  });

  test("guessing enrollment codes is rate-limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = await START(request("/api/pwa/device-enrollments/start", { headers: { "fly-client-ip": "10.77.0.1" }, json: { token: `${i}`.padEnd(43, "x") } }));
      last = res.status;
    }
    assert.equal(last, 429);
  });

  test("from another site, nothing happens", async () => {
    const res = await START(request("/api/pwa/device-enrollments/start", { headers: { "sec-fetch-site": "cross-site" }, json: {} }));
    assert.equal(res.status, 403);
  });
});

/* ── Sign-in: the device first, then the person ────────────────────────────── */

describe("sign-in requires the device's proof, checked before the password", () => {
  test("no proof → refused, and FabOrchestrator is never asked about the password", async () => {
    const result = await signIn(null, "alice@plant.example", "alice-pass");
    assert.equal(result.res.status, 403);
    assert.equal(result.body.code, "device_not_approved");
    assert.equal(foLogins(), 0);
    assert.equal(setCookie(result.res, FO_TOKEN_COOKIE), undefined);
  });

  test("an enrolled device's proof → signed in, and the session is bound to that device", async () => {
    const phone = await enrolledPhone();
    const result = await signIn(phone, "alice@plant.example", "alice-pass");
    assert.equal(result.res.status, 200);
    assert.equal(await gate("/home", result.cookies), "passed");
    assert.equal((await deviceStore().sessionDevice((await import("@/lib/auth")).foFingerprint(result.cookies[FO_TOKEN_COOKIE]!)))?.deviceId, phone.deviceId);
  });

  test("the device belongs to no user: different accounts sign in on the same approved device", async () => {
    const phone = await enrolledPhone();
    assert.equal((await signIn(phone, "alice@plant.example", "alice-pass")).res.status, 200);
    assert.equal((await signIn(phone, "bob@plant.example", "bob-pass")).res.status, 200);
  });

  test("knowing a device's id is not enough: another key's signature is refused before the password", async () => {
    const phone = await enrolledPhone();
    const thief = { key: await newPhoneKey(), deviceId: phone.deviceId };
    const result = await signIn(thief, "alice@plant.example", "alice-pass");
    assert.equal(result.res.status, 403);
    assert.equal(foLogins(), 0);
  });

  test("a proof is single-use: replaying it is refused", async () => {
    const phone = await enrolledPhone();
    const first = await signIn(phone, "alice@plant.example", "alice-pass");
    assert.equal(first.res.status, 200);
    const replay = await signIn(null, "alice@plant.example", "alice-pass", { proof: first.device! });
    assert.equal(replay.res.status, 403);
  });

  test("a revoked device's valid signature is refused (device_revoked), before the password", async () => {
    const phone = await enrolledPhone();
    await deviceStore().revokeDevice(phone.deviceId!, { by: "admin@plant.example", reason: "lost" });
    const result = await signIn(phone, "alice@plant.example", "alice-pass");
    assert.equal(result.res.status, 403);
    assert.equal(result.body.code, "device_revoked");
    assert.equal(foLogins(), 0);
  });

  test("a wrong password on an approved device is still a wrong password", async () => {
    const phone = await enrolledPhone();
    assert.equal((await signIn(phone, "alice@plant.example", "nope")).res.status, 401);
  });

  test("a challenge for an unknown device is refused", async () => {
    const res = await CHALLENGE(request("/api/pwa/device-auth/challenge", { json: { deviceId: "DEVICE-404" } }));
    assert.equal(res.status, 404);
  });

  test("with the gate off, sign-in works without a proof, and a proof still binds the session", async () => {
    process.env.DEVICE_GATE = "off";
    assert.equal((await signIn(null, "alice@plant.example", "alice-pass")).res.status, 200);
    const phone = await enrolledPhone();
    const bound = await signIn(phone, "alice@plant.example", "alice-pass");
    assert.equal(bound.res.status, 200);
    process.env.DEVICE_GATE = "enforce";
    assert.equal(await gate("/home", bound.cookies), "passed", "already bound when the gate is turned on");
  });
});

/* ── Administration ─────────────────────────────────────────────────────────── */

describe("admin endpoints require an approved device, a session and the allowlist", () => {
  test("no session → refused; a non-admin → 403; an admin whose session never proved a device → blocked; a proved admin → OK", async () => {
    const call = (cookies: Cookies, bearer?: string) =>
      CREATE_ENROLLMENT(request("/api/pwa/device-enrollments", { cookies, json: {}, headers: bearer ? { authorization: bearer } : {} }));
    assert.equal((await call({})).status, 403);

    const alicePhone = await enrolledPhone();
    const alice = sessionOf("alice@plant.example");
    await bindSession(alice.foToken, alicePhone.deviceId!);
    assert.equal(((await (await call(alice.cookies, alice.bearer)).json()) as { code: string }).code, "forbidden");

    const unproved = sessionOf("admin@plant.example");
    assert.equal(((await (await call(unproved.cookies, unproved.bearer)).json()) as { code: string }).code, "device_not_approved");

    const admin = await adminBrowser();
    assert.equal((await call(admin.cookies, admin.bearer)).status, 201);

    for (const handler of [
      () => LIST_DEVICES(request("/api/pwa/devices", { cookies: alice.cookies, headers: { authorization: alice.bearer } })),
      () => LIST_ENROLLMENTS(request("/api/pwa/device-enrollments", { cookies: alice.cookies, headers: { authorization: alice.bearer } })),
      () => REVOKE(request("/api/pwa/devices/DEVICE-001/revoke", { cookies: alice.cookies, headers: { authorization: alice.bearer }, json: {} }), { params: Promise.resolve({ deviceId: "DEVICE-001" }) }),
    ]) {
      assert.equal((await handler()).status, 403);
    }
  });

  test("the device list shows key fingerprints, never keys or hashes", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    const phone = await scanEnrollment(token);
    const text = await (await LIST_DEVICES(request("/api/pwa/devices", { cookies: admin.cookies, headers: { authorization: admin.bearer } }))).text();
    assert.match(text, /"deviceId":"DEVICE-002"/);
    assert.match(text, /"keyFingerprint":"[0-9a-f]{32}"/);
    assert.ok(!text.includes(phone.key.spki), "not even the public key itself");
    const file = readFileSync(currentStorePath(), "utf8");
    for (const hash of [...file.matchAll(/"th":"([^"]+)"/g)].map((m) => m[1]!)) assert.ok(!text.includes(hash));
  });
});

/* ── The demonstration ─────────────────────────────────────────────────────── */

describe("demo: normal access to the Fly app depends on the enrollment QR", () => {
  test("Phone A blocked → enrolled by QR → signs in → Phone B blocked → Phone A revoked → blocked", async () => {
    const admin = await adminBrowser(); // DEVICE-001 is the administrator's own

    // 1. Phone A, no device key: the sign-in page sends it to "not approved",
    //    and the server refuses a sign-in without a device proof.
    assert.equal((await signIn(null, "alice@plant.example", "alice-pass")).res.status, 403);

    // 2. The admin creates an Enrollment QR at /device-admin.
    const { token } = await createEnrollment(admin, { friendlyName: "Phone A" });

    // 3. Phone A scans it: a key is made, the public key registered → DEVICE-002.
    const enrolled = await scanEnrollment(token);
    assert.equal(enrolled.status, 200);
    const phoneA: Phone = { key: enrolled.key, deviceId: enrolled.deviceId };
    assert.equal(phoneA.deviceId, "DEVICE-002");
    //    The QR is spent.
    assert.equal((await scanEnrollment(token)).status, 410);

    // 4. Phone A opens the normal FO URL → device proof → normal sign-in → FO.
    const signedIn = await signIn(phoneA, "alice@plant.example", "alice-pass");
    assert.equal(signedIn.res.status, 200);
    assert.equal(await gate("/home", signedIn.cookies), "passed");
    assert.equal(await gate("/api/chat", signedIn.cookies, "POST"), "passed");

    // 5. Phone B, never enrolled, knows Alice's password: blocked, even with Phone A's id.
    assert.equal((await signIn(null, "alice@plant.example", "alice-pass")).res.status, 403);
    assert.equal((await signIn({ key: await newPhoneKey(), deviceId: "DEVICE-002" }, "alice@plant.example", "alice-pass")).res.status, 403);

    // 6. The admin revokes DEVICE-002 → Phone A's session stops, and it cannot sign in again.
    assert.equal((await revoke(admin, "DEVICE-002")).status, 200);
    assert.equal(await gate("/home", signedIn.cookies), "blocked");
    const again = await signIn(phoneA, "alice@plant.example", "alice-pass");
    assert.equal(again.res.status, 403);
    assert.equal(again.body.code, "device_revoked");

    for (const action of ["DEVICE_ENROLLMENT_CREATED", "DEVICE_ENROLLED", "DEVICE_ACCESS_ALLOWED", "DEVICE_ACCESS_BLOCKED", "DEVICE_REVOKED", "DEVICE_LOGIN_REFUSED"]) {
      assert.ok(logged.some((l) => l.includes(`"action":"${action}"`)), action);
    }
  });
});
