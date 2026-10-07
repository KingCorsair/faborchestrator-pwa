/**
 * Device enrollment end to end, through the real proxy and route handlers,
 * against a stub FabOrchestrator (`lib/devices/`).
 *
 * The architecture these hold (6 October 2026):
 *
 *   admin creates a one-time enrollment QR → a device opens it → the device is
 *   approved at once, with no sign-in → later, the normal front door checks the
 *   device first, then the normal FabOrchestrator sign-in decides who uses it.
 *
 * The enrollment code authorizes a device; it does not authenticate a person.
 * The scenarios at the bottom are the demo (1–6) written down.
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  browser,
  currentStorePath,
  DEVICE_COOKIE,
  ENROLL_COOKIE,
  foCalls,
  redirectedTo,
  request,
  sessionOf,
  setCookie,
  setUp,
  tearDown,
} from "./fixture";
import { NextResponse } from "next/server";
import { proxy } from "@/proxy";
import { credentialValue } from "@/lib/devices/credential";
import { describeDevice } from "@/lib/devices/metadata";
import { deviceStore } from "@/lib/devices/store";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { GET as ENROLL_LINK } from "@/app/device-enroll/[token]/route";
import { POST as COMPLETE } from "@/app/api/pwa/device-enrollments/complete/route";
import { GET as LIST_ENROLLMENTS, POST as CREATE_ENROLLMENT } from "@/app/api/pwa/device-enrollments/route";
import { GET as LIST_DEVICES } from "@/app/api/pwa/devices/route";
import { POST as REVOKE } from "@/app/api/pwa/devices/[deviceId]/revoke/route";
import { POST as LOGIN } from "@/app/api/pwa/auth/login/route";

/* ── Logs: captured for every test, and checked for secrets ────────────────── */

let logged: string[] = [];
/** Every secret a test has seen; none may ever appear in a log line. */
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
  for (const secret of secrets) {
    assert.ok(!logged.some((line) => line.includes(secret)), "a secret reached the log");
  }
  mock.restoreAll();
  await tearDown();
});

/* ── Helpers ───────────────────────────────────────────────────────────────── */

type Cookies = Record<string, string | null>;

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

/** A device approved directly in the store, as the bootstrap CLI would: its cookie value. */
async function bootstrapDevice(): Promise<string> {
  const store = deviceStore();
  const { token } = await store.createEnrollment({ createdBy: "bootstrap-cli", ttlMs: 600_000 });
  const result = await store.completeEnrollment({
    token,
    metadata: describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/130", false),
  });
  assert.equal(result.kind, "enrolled");
  const { device, token: deviceToken } = result as Extract<typeof result, { kind: "enrolled" }>;
  secrets.push(token, deviceToken);
  return credentialValue(device.deviceId, deviceToken);
}

/** The administrator, signed in on an approved device. */
async function adminBrowser() {
  const device = await bootstrapDevice();
  const session = sessionOf("admin@plant.example");
  return { cookies: browser(device, session), bearer: session.bearer };
}
type Admin = Awaited<ReturnType<typeof adminBrowser>>;

async function createEnrollment(admin: Admin, json: Record<string, unknown> = {}) {
  const res = await CREATE_ENROLLMENT(
    request("/api/pwa/device-enrollments", { cookies: admin.cookies, headers: { authorization: admin.bearer }, json }),
  );
  const body = (await res.json()) as { url: string; qrSvg: string; enrollment: { enrollmentId: string; expiresAt: string } };
  assert.equal(res.status, 201, JSON.stringify(body));
  const token = new URL(body.url).pathname.split("/").pop()!;
  secrets.push(token);
  return { ...body, token };
}

/** A phone opens the enrollment link (what scanning the QR does): the token moves into a cookie. */
async function openLink(token: string, cookies: Cookies = {}) {
  const res = await ENROLL_LINK(request(`/device-enroll/${token}`, { cookies }), { params: Promise.resolve({ token }) });
  return { res, pending: setCookie(res, ENROLL_COOKIE) };
}

/** The enrollment page's own automatic POST. No email, no password. */
async function complete(pending: string | undefined, cookies: Cookies = {}) {
  const res = await COMPLETE(
    request("/api/pwa/device-enrollments/complete", {
      cookies: { ...cookies, [ENROLL_COOKIE]: pending ?? null },
      json: { installedApp: true },
    }),
  );
  const body = (await res.json()) as Record<string, unknown>;
  const device = setCookie(res, DEVICE_COOKIE);
  if (device) secrets.push(device.split(".")[1]!);
  return { res, body, device };
}

/** Scan an enrollment QR on a phone, end to end: the phone's device cookie value. */
async function scanEnrollment(admin: Admin, cookies: Cookies = {}) {
  const { token } = await createEnrollment(admin);
  const { pending } = await openLink(token, cookies);
  const { res, device } = await complete(pending, cookies);
  assert.equal(res.status, 200);
  return device!;
}

const login = (device: string | null, email: string, password: string) =>
  LOGIN(request("/api/pwa/auth/login", { cookies: { [DEVICE_COOKIE]: device }, json: { email, password } }));

const revoke = (admin: Admin, deviceId: string) =>
  REVOKE(
    request(`/api/pwa/devices/${deviceId}/revoke`, { cookies: admin.cookies, headers: { authorization: admin.bearer }, json: {} }),
    { params: Promise.resolve({ deviceId }) },
  );

/* ── The everyday device check ─────────────────────────────────────────────── */

describe("everyday device check, in front of everything", () => {
  test("approved credential → PASS", async () => {
    const device = await bootstrapDevice();
    assert.equal(await gate("/", { [DEVICE_COOKIE]: device }), "passed");
    assert.equal(await gate("/api/pwa/auth/login", { [DEVICE_COOKIE]: device }, "POST"), "passed");
  });

  test("missing credential → BLOCK, on documents, sign-in, FabOrchestrator pages, APIs and assets", async () => {
    for (const path of ["/", "/login", "/home", "/chat", "/device-admin", "/diagnostics", "/reports"]) {
      const res = await proxy(request(path));
      assert.equal(redirectedTo(res), "/device-blocked", path);
      assert.match(res.headers.get("cache-control") ?? "", /no-store/, path);
    }
    for (const path of ["/api/pwa/auth/login", "/api/chat", "/api/conversations", "/api/pwa/devices", "/api/pwa/device-enrollments"]) {
      const res = await proxy(request(path, { method: "POST" }));
      assert.equal(res.status, 403, path);
      assert.equal(((await res.json()) as { code: string }).code, "device_not_approved", path);
    }
    assert.equal((await proxy(request("/_next/static/chunks/app.js"))).status, 403);
  });

  test("invalid token, unknown device, malformed or duplicated cookie → BLOCK", async () => {
    const device = await bootstrapDevice();
    const [id] = device.split(".");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: `${id}.${"A".repeat(43)}` }), "blocked");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: `DEVICE-404.${"A".repeat(43)}` }), "blocked");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: "garbage" }), "blocked");
    // The non-`__Host-` name is a loopback-only fallback; on a real host it is not read.
    assert.equal(await gate("/", { fo_device: device }), "blocked");
    const res = await proxy(request("/", { headers: { cookie: `${DEVICE_COOKIE}=${device}; ${DEVICE_COOKIE}=${device}` } }));
    assert.equal(redirectedTo(res), "/device-blocked");
  });

  test("revoked device → BLOCK", async () => {
    const device = await bootstrapDevice();
    await deviceStore().revokeDevice(device.split(".")[0]!, { by: "admin@plant.example", reason: "lost" });
    assert.equal(await gate("/", { [DEVICE_COOKIE]: device }), "blocked");
  });

  test("only the blocked page, enrollment, sign-out and install files pass without a device", async () => {
    for (const path of [
      "/device-blocked",
      "/device-enroll",
      `/device-enroll/${"a".repeat(43)}`,
      "/api/pwa/device-enrollments/complete",
      "/api/pwa/auth/logout",
      "/offline",
      "/sw.js",
      "/manifest.webmanifest",
      "/icon-192.png",
      "/apple-touch-icon.png",
      "/pwa-assets/_next/static/chunks/app.js",
    ]) {
      assert.equal(await gate(path, {}, path.startsWith("/api/") ? "POST" : "GET"), "passed", path);
    }
    assert.equal(await gate("/device-enroll/x/y"), "blocked");
  });

  test("a store that cannot be used blocks everything (fails closed), worded as unavailable", async () => {
    const device = await bootstrapDevice();
    delete process.env.DEVICE_STORE_PATH;
    const res = await proxy(request("/", { cookies: { [DEVICE_COOKIE]: device } }));
    assert.equal(redirectedTo(res), "/device-blocked");
    assert.match(res.headers.get("location") ?? "", /reason=unavailable/);
    assert.equal((await proxy(request("/api/chat", { cookies: { [DEVICE_COOKIE]: device }, method: "POST" }))).status, 503);
  });

  test("any DEVICE_GATE value but off/empty enforces; off checks nothing", async () => {
    process.env.DEVICE_GATE = "enforced-typo";
    assert.equal(await gate("/"), "blocked");
    process.env.DEVICE_GATE = "off";
    const res = proxy(request("/login"));
    assert.ok(res instanceof NextResponse, "with the gate off the proxy stays synchronous");
    assert.equal(redirectedTo(res), null);
  });
});

/* ── Enrollment: the QR code is the authorization ──────────────────────────── */

describe("enrollment", () => {
  test("a valid enrollment QR enrolls the device automatically: no FabOrchestrator call, no email, no password, no session", async () => {
    const admin = await adminBrowser();
    const issued = await createEnrollment(admin, { friendlyName: "Line 3 phone" });
    assert.match(issued.url, /^https:\/\/pwa\.test\/device-enroll\/[A-Za-z0-9_-]{43}$/);
    assert.match(issued.qrSvg, /^<svg/);

    const { res: link, pending } = await openLink(issued.token);
    assert.equal(link.status, 303);
    assert.equal(redirectedTo(link), "/device-enroll");
    assert.ok(!(link.headers.get("location") ?? "").includes(issued.token), "token must leave the URL");
    assert.equal(link.headers.get("referrer-policy"), "no-referrer");
    assert.match(link.headers.get("set-cookie") ?? "", /__Host-fo_enroll=[^;]+;.*HttpOnly/i);

    const { res, body, device } = await complete(pending);
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true, device: { deviceId: "DEVICE-002", friendlyName: "Line 3 phone" } });
    assert.match(device ?? "", /^DEVICE-002\.[A-Za-z0-9_-]{43}$/);
    assert.equal(setCookie(res, ENROLL_COOKIE), "", "the pending enrollment is cleared");
    const cookie = (res.headers.get("set-cookie") ?? "").split(/, (?=__Host-)/).find((c) => c.startsWith(`${DEVICE_COOKIE}=`)) ?? "";
    for (const attribute of [/; HttpOnly/i, /; Secure/i, /; SameSite=lax/i, /; Path=\//]) assert.match(cookie, attribute);

    assert.equal(foCalls.length, 0, "FabOrchestrator is not asked anything during enrollment");
    assert.equal(setCookie(res, FO_TOKEN_COOKIE), undefined, "enrollment signs nobody in");
    assert.ok(!("token" in body), "no session token");

    const listed = (await deviceStore().listDevices()).find((d) => d.deviceId === "DEVICE-002")!;
    assert.equal(listed.status, "APPROVED");
    assert.equal(listed.createdBy, "admin@plant.example");
    assert.equal(listed.context, "installed-app");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: device! }), "passed");
  });

  test("an enrollment cannot be tied to a user: a request naming one is refused", async () => {
    const admin = await adminBrowser();
    const res = await CREATE_ENROLLMENT(
      request("/api/pwa/device-enrollments", { cookies: admin.cookies, headers: { authorization: admin.bearer }, json: { email: "alice@plant.example" } }),
    );
    assert.equal(res.status, 400);
  });

  test("opening the link alone spends nothing: a link preview cannot burn the QR", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    await openLink(token); // e.g. a chat app's preview fetcher
    await openLink(token);
    assert.equal((await deviceStore().lookupEnrollment(token)).kind, "valid");
    const { pending } = await openLink(token);
    assert.equal((await complete(pending)).res.status, 200);
  });

  test("expired QR fails", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    const { pending } = await openLink(token);
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      const { res, device } = await complete(pending);
      assert.equal(res.status, 410);
      assert.equal(device, undefined);
      const { res: link } = await openLink(token);
      assert.match(link.headers.get("location") ?? "", /link=invalid/);
    } finally {
      Date.now = realNow;
    }
  });

  test("reused QR fails: the link, and the old pending cookie replayed", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    const first = await openLink(token);
    assert.equal((await complete(first.pending)).res.status, 200);
    const again = await openLink(token, {});
    assert.match(again.res.headers.get("location") ?? "", /link=invalid/);
    assert.equal(again.pending, "", "no pending cookie for a used link");
    const replay = await complete(first.pending);
    assert.equal(replay.res.status, 410);
    assert.equal(replay.device, undefined);
  });

  test("simultaneous use of one QR (two phones at once) permits exactly one enrollment", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin);
    const { pending } = await openLink(token);
    const results = await Promise.all(Array.from({ length: 8 }, () => complete(pending)));
    assert.equal(results.filter((r) => r.res.status === 200).length, 1);
    assert.equal(results.filter((r) => r.device).length, 1);
    assert.equal(results.filter((r) => r.res.status === 410).length, 7);
    assert.equal((await deviceStore().listDevices()).length, 2, "the admin's device and exactly one new one");
  });

  test("without a pending enrollment, or from another site, nothing happens", async () => {
    assert.equal((await complete(undefined)).res.status, 410);
    const res = await COMPLETE(
      request("/api/pwa/device-enrollments/complete", {
        headers: { "sec-fetch-site": "cross-site" },
        cookies: { [ENROLL_COOKIE]: "a".repeat(43) },
        json: {},
      }),
    );
    assert.equal(res.status, 403);
  });

  test("guessing enrollment codes is rate-limited per address", async () => {
    const ip = { "fly-client-ip": "10.77.0.1" };
    let last = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = await COMPLETE(
        request("/api/pwa/device-enrollments/complete", { headers: ip, cookies: { [ENROLL_COOKIE]: `${i}`.padEnd(43, "x") }, json: {} }),
      );
      last = res.status;
    }
    assert.equal(last, 429);
  });
});

/* ── Administration: authorization ─────────────────────────────────────────── */

describe("admin endpoints require an approved device, a session and the allowlist", () => {
  test("no session → 401; a non-admin → 403; an admin on an unapproved device → blocked; an admin on an approved one → OK", async () => {
    const alice = sessionOf("alice@plant.example");
    const aliceDevice = await bootstrapDevice();
    const admin = sessionOf("admin@plant.example");
    const adminDevice = await bootstrapDevice();
    const call = (cookies: Cookies, bearer?: string) =>
      CREATE_ENROLLMENT(
        request("/api/pwa/device-enrollments", { cookies, json: {}, headers: bearer ? { authorization: bearer } : {} }),
      );

    assert.equal((await call(browser(adminDevice))).status, 401);
    assert.equal((await call(browser(aliceDevice, alice), alice.bearer)).status, 403);
    const unapproved = await call(browser(null, admin), admin.bearer);
    assert.equal(unapproved.status, 403);
    assert.equal(((await unapproved.json()) as { code: string }).code, "device_not_approved");
    assert.equal((await call(browser(adminDevice, admin), admin.bearer)).status, 201);

    for (const handler of [
      () => LIST_DEVICES(request("/api/pwa/devices", { cookies: browser(aliceDevice, alice), headers: { authorization: alice.bearer } })),
      () => LIST_ENROLLMENTS(request("/api/pwa/device-enrollments", { cookies: browser(aliceDevice, alice), headers: { authorization: alice.bearer } })),
      () =>
        REVOKE(
          request("/api/pwa/devices/DEVICE-001/revoke", { cookies: browser(aliceDevice, alice), headers: { authorization: alice.bearer }, json: {} }),
          { params: Promise.resolve({ deviceId: "DEVICE-001" }) },
        ),
    ]) {
      assert.equal((await handler()).status, 403);
    }
    assert.equal((await deviceStore().getDevice("DEVICE-001"))?.status, "APPROVED");
  });

  test("the device list carries no token and no hash", async () => {
    const admin = await adminBrowser();
    await scanEnrollment(admin);
    const res = await LIST_DEVICES(request("/api/pwa/devices", { cookies: admin.cookies, headers: { authorization: admin.bearer } }));
    const text = await res.text();
    const file = readFileSync(currentStorePath(), "utf8");
    const hashes = [...file.matchAll(/"th":"([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(hashes.length >= 2);
    for (const value of [...hashes, ...secrets]) assert.ok(!text.includes(value));
    assert.match(text, /"deviceId":"DEVICE-002","friendlyName":"[^"]+","status":"APPROVED"/);
  });

  test("an enrollment link is never built from the Host header", async () => {
    const admin = await adminBrowser();
    delete process.env.PUBLIC_ORIGIN;
    try {
      const res = await CREATE_ENROLLMENT(
        request("/api/pwa/device-enrollments", { cookies: admin.cookies, headers: { authorization: admin.bearer, host: "evil.example" }, json: {} }),
      );
      assert.equal(res.status, 503);
    } finally {
      process.env.PUBLIC_ORIGIN = "https://pwa.test";
    }
  });
});

/* ── Revocation and replacement ────────────────────────────────────────────── */

describe("revocation", () => {
  test("works before revoke; admin revokes; the same credential fails afterwards, on its very next request", async () => {
    const admin = await adminBrowser();
    const phone = await scanEnrollment(admin);
    const alice = sessionOf("alice@plant.example");
    assert.equal(await gate("/home", browser(phone, alice)), "passed");

    const res = await revoke(admin, "DEVICE-002");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { device: { status: string; revokedBy: string; revokedAt: string | null } };
    assert.equal(body.device.status, "REVOKED");
    assert.equal(body.device.revokedBy, "admin@plant.example");
    assert.ok(body.device.revokedAt);

    assert.equal(await gate("/home", browser(phone, alice)), "blocked");
    assert.equal(await gate("/api/chat", browser(phone, alice), "POST"), "blocked");
    assert.equal(await gate("/api/pwa/auth/login", browser(phone), "POST"), "blocked");
    assert.ok(logged.some((l) => l.includes('"action":"DEVICE_REVOKED"') && l.includes('"actor":"admin@plant.example"')));
  });

  test("replacement: old device revoked, new device enrolled, new works, old stays blocked", async () => {
    const admin = await adminBrowser();
    const oldPhone = await scanEnrollment(admin);
    await revoke(admin, "DEVICE-002");
    const newPhone = await scanEnrollment(admin);
    assert.match(newPhone, /^DEVICE-003\./);
    assert.equal(await gate("/", { [DEVICE_COOKIE]: newPhone }), "passed");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: oldPhone }), "blocked");
  });

  test("re-enrolling a browser that holds an approved credential revokes the credential it replaces", async () => {
    const admin = await adminBrowser();
    const first = await scanEnrollment(admin);
    const second = await scanEnrollment(admin, { [DEVICE_COOKIE]: first });
    assert.notEqual(first, second);
    assert.equal(await gate("/", { [DEVICE_COOKIE]: first }), "blocked");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: second }), "passed");
    assert.ok(logged.some((l) => l.includes('"action":"DEVICE_REENROLLED"')));
  });
});

/* ── Sign-in stays a separate step ─────────────────────────────────────────── */

describe("user sign-in remains separate from device approval", () => {
  test("an approved device does not sign anyone in; sign-in is its own step, with FabOrchestrator's password", async () => {
    const admin = await adminBrowser();
    const phone = await scanEnrollment(admin);
    // Approved, but no session: the front door leads to sign-in, not into FabOrchestrator.
    assert.equal(redirectedTo(await proxy(request("/", { cookies: { [DEVICE_COOKIE]: phone } }))), "/login");
    assert.equal((await login(phone, "alice@plant.example", "wrong")).status, 401);
    const res = await login(phone, "alice@plant.example", "alice-pass");
    assert.equal(res.status, 200);
    assert.equal(setCookie(res, DEVICE_COOKIE), phone, "the device credential is renewed");
    assert.ok(setCookie(res, FO_TOKEN_COOKIE));
  });

  test("the device belongs to no user: different FabOrchestrator accounts may sign in on the same approved device", async () => {
    const admin = await adminBrowser();
    const phone = await scanEnrollment(admin);
    assert.equal((await login(phone, "alice@plant.example", "alice-pass")).status, 200);
    assert.equal((await login(phone, "bob@plant.example", "bob-pass")).status, 200);
  });

  test("the sign-in route refuses an unapproved device itself, not only behind the proxy", async () => {
    const res = await login(null, "alice@plant.example", "alice-pass");
    assert.equal(res.status, 403);
    assert.equal(setCookie(res, FO_TOKEN_COOKIE), undefined);
    assert.ok(foCalls.some((c) => c.path === "/api/auth/logout"), "the FabOrchestrator token just issued is revoked");
  });
});

/* ── The demo scenarios ────────────────────────────────────────────────────── */

describe("demo scenarios 1–6", () => {
  test("1–6", async () => {
    const admin = await adminBrowser(); // DEVICE-001 is the administrator's own

    // 1. Phone A, no device stamp, opens the normal FO access URL → BLOCKED.
    assert.equal(await gate("/"), "blocked");

    // 2. The admin generates a one-time enrollment QR at /device-admin.
    const issued = await createEnrollment(admin, { friendlyName: "Phone A" });

    // 3. Phone A scans it: no email, no password; the device stamp is issued,
    //    it shows as APPROVED, and the QR is spent.
    const { pending } = await openLink(issued.token);
    const enrolled = await complete(pending);
    assert.equal(enrolled.res.status, 200);
    const phoneA = enrolled.device!;
    assert.match(phoneA, /^DEVICE-002\./);
    assert.equal(foCalls.length, 0);
    const listed = await LIST_DEVICES(request("/api/pwa/devices", { cookies: admin.cookies, headers: { authorization: admin.bearer } }));
    assert.match(await listed.text(), /"deviceId":"DEVICE-002","friendlyName":"Phone A","status":"APPROVED"/);
    assert.match((await openLink(issued.token)).res.headers.get("location") ?? "", /link=invalid/);

    // 4. Phone A opens normal FO access again → device check passes → the
    //    normal sign-in → the user signs in → FabOrchestrator.
    assert.equal(redirectedTo(await proxy(request("/", { cookies: { [DEVICE_COOKIE]: phoneA } }))), "/login");
    const signIn = await login(phoneA, "alice@plant.example", "alice-pass");
    assert.equal(signIn.status, 200);
    const foCookie = setCookie(signIn, FO_TOKEN_COOKIE)!;
    assert.equal(await gate("/home", { [DEVICE_COOKIE]: phoneA, [FO_TOKEN_COOKIE]: foCookie }), "passed");

    // 5. Phone B, no enrollment → BLOCKED, even with valid FO credentials and
    //    even holding Phone A's FO session cookie.
    assert.equal(await gate("/"), "blocked");
    assert.equal(await gate("/api/pwa/auth/login", {}, "POST"), "blocked");
    assert.equal((await login(null, "alice@plant.example", "alice-pass")).status, 403);
    assert.equal(await gate("/home", { [FO_TOKEN_COOKIE]: foCookie }), "blocked");

    // 6. The admin revokes DEVICE-002 → Phone A is BLOCKED although its old
    //    device cookie is still there.
    assert.equal((await revoke(admin, "DEVICE-002")).status, 200);
    assert.equal(await gate("/", { [DEVICE_COOKIE]: phoneA }), "blocked");
    assert.equal(await gate("/home", { [DEVICE_COOKIE]: phoneA, [FO_TOKEN_COOKIE]: foCookie }), "blocked");

    for (const action of ["DEVICE_ENROLLMENT_CREATED", "DEVICE_ENROLLED", "DEVICE_ACCESS_BLOCKED", "DEVICE_ACCESS_ALLOWED", "DEVICE_REVOKED"]) {
      assert.ok(logged.some((l) => l.includes(`"action":"${action}"`)), action);
    }
  });
});
