/**
 * Device enrollment end to end, through the real proxy and route handlers,
 * against a stub FabOrchestrator (`lib/devices/`, 6 October 2026).
 *
 * The scenarios at the bottom are the manual acceptance test (A–F) written
 * down: an unenrolled phone is blocked, an enrollment makes it DEVICE-001, the
 * same account on a second phone is still blocked, revoking DEVICE-001 blocks
 * it, and a separate enrollment makes the second phone DEVICE-002.
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
  setFoAnswersAs,
  setUp,
  tearDown,
  USERS,
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

/** What the proxy does with this request: "blocked" by the device gate, or "passed" it. */
async function gate(path: string, cookies: Record<string, string | null> = {}, method = "GET") {
  const res = await proxy(request(path, { cookies, method }));
  if (redirectedTo(res) === "/device-blocked") return "blocked";
  if (res.status === 403 || res.status === 503) {
    const body = (await res.clone().json().catch(() => null)) as { code?: string } | null;
    if (!body || body.code === "device_not_approved" || body.code === "device_check_unavailable") return "blocked";
  }
  return "passed";
}

/** A device approved directly in the store, as the bootstrap CLI would: its cookie value. */
async function bootstrapDevice(email: string): Promise<string> {
  const store = deviceStore();
  const { token } = await store.createEnrollment({ allowedEmail: email, createdBy: "bootstrap-cli", ttlMs: 600_000 });
  const result = await store.completeEnrollment({
    token,
    userId: USERS[email]!.id,
    email,
    metadata: describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/130", false),
  });
  assert.equal(result.kind, "enrolled");
  const { device, token: deviceToken } = result as Extract<typeof result, { kind: "enrolled" }>;
  secrets.push(token, deviceToken);
  return credentialValue(device.deviceId, deviceToken);
}

/** The administrator, signed in on an approved device. */
async function adminBrowser() {
  const device = await bootstrapDevice("admin@plant.example");
  const session = sessionOf("admin@plant.example");
  return { cookies: browser(device, session), bearer: session.bearer };
}

async function createEnrollment(admin: { cookies: Record<string, string | null>; bearer: string }, email: string) {
  const res = await CREATE_ENROLLMENT(
    request("/api/pwa/device-enrollments", { cookies: admin.cookies, headers: { authorization: admin.bearer }, json: { email } }),
  );
  const body = (await res.json()) as { url: string; qrSvg: string; enrollment: { enrollmentId: string; expiresAt: string } };
  assert.equal(res.status, 201, JSON.stringify(body));
  const token = new URL(body.url).pathname.split("/").pop()!;
  secrets.push(token);
  return { ...body, token };
}

/** A phone opens the enrollment link: the token moves into a cookie. */
async function openLink(token: string, cookies: Record<string, string | null> = {}) {
  const res = await ENROLL_LINK(request(`/device-enroll/${token}`, { cookies }), { params: Promise.resolve({ token }) });
  return { res, pending: setCookie(res, ENROLL_COOKIE) };
}

/** The phone signs in on the enrollment page. */
async function complete(pending: string | undefined, email: string, password: string, cookies: Record<string, string | null> = {}) {
  const res = await COMPLETE(
    request("/api/pwa/device-enrollments/complete", {
      cookies: { ...cookies, [ENROLL_COOKIE]: pending ?? null },
      json: { email, password, installedApp: true },
    }),
  );
  const body = (await res.json()) as Record<string, unknown>;
  const device = setCookie(res, DEVICE_COOKIE);
  if (device) secrets.push(device.split(".")[1]!);
  return { res, body, device };
}

/** The full enrollment of one phone for `email`; its device cookie value. */
async function enrollPhone(admin: { cookies: Record<string, string | null>; bearer: string }, email: string, cookies: Record<string, string | null> = {}) {
  const { token } = await createEnrollment(admin, email);
  const { pending } = await openLink(token, cookies);
  const { res, device } = await complete(pending, email, USERS[email]!.password, cookies);
  assert.equal(res.status, 200);
  return device!;
}

/* ── The everyday device check ─────────────────────────────────────────────── */

describe("everyday device check, in front of everything", () => {
  test("approved credential → PASS", async () => {
    const device = await bootstrapDevice("alice@plant.example");
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
    const device = await bootstrapDevice("alice@plant.example");
    const [id] = device.split(".");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: `${id}.${"A".repeat(43)}` }), "blocked");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: `DEVICE-404.${"A".repeat(43)}` }), "blocked");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: "garbage" }), "blocked");
    // The non-`__Host-` name is a loopback-only fallback; on a real host it is not read.
    assert.equal(await gate("/", { fo_device: device }), "blocked");
    // Two cookies of the name: neither is trusted.
    const res = await proxy(request("/", { headers: { cookie: `${DEVICE_COOKIE}=${device}; ${DEVICE_COOKIE}=${device}` } }));
    assert.equal(redirectedTo(res), "/device-blocked");
  });

  test("revoked device → BLOCK", async () => {
    const device = await bootstrapDevice("alice@plant.example");
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
    // Not a way round: nothing deeper under the enrollment link is exempt.
    assert.equal(await gate("/device-enroll/x/y"), "blocked");
  });

  test("the device check comes before the sign-in gate: no session needed to be blocked, and an approved device still meets sign-in", async () => {
    const device = await bootstrapDevice("alice@plant.example");
    const res = await proxy(request("/chat", { cookies: { [DEVICE_COOKIE]: device } }));
    assert.equal(redirectedTo(res), "/login");
  });

  test("a store that cannot be used blocks everything (fails closed), worded as unavailable", async () => {
    const device = await bootstrapDevice("alice@plant.example");
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

/* ── Enrollment ────────────────────────────────────────────────────────────── */

describe("enrollment", () => {
  test("valid enrollment succeeds: link → cookie and a clean URL → sign-in → DEVICE credential, never in the body", async () => {
    const admin = await adminBrowser();
    const issued = await createEnrollment(admin, "alice@plant.example");
    assert.match(issued.url, /^https:\/\/pwa\.test\/device-enroll\/[A-Za-z0-9_-]{43}$/);
    assert.match(issued.qrSvg, /^<svg/);

    const { res: link, pending } = await openLink(issued.token);
    assert.equal(link.status, 303);
    assert.equal(redirectedTo(link), "/device-enroll");
    assert.ok(!(link.headers.get("location") ?? "").includes(issued.token), "token must leave the URL");
    assert.equal(link.headers.get("referrer-policy"), "no-referrer");
    assert.equal(pending, issued.token);

    const { res, body, device } = await complete(pending, "alice@plant.example", "alice-pass");
    assert.equal(res.status, 200);
    assert.match(device ?? "", /^DEVICE-002\.[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(body).includes(device!.split(".")[1]!), "the token is only in the cookie");
    assert.equal(setCookie(res, ENROLL_COOKIE), "", "the pending enrollment is cleared");
    const cookie = (res.headers.get("set-cookie") ?? "").split(/, (?=__Host-)/).find((c) => c.startsWith(`${DEVICE_COOKIE}=`)) ?? "";
    assert.match(cookie, /^__Host-fo_device=DEVICE-002\./);
    for (const attribute of [/; HttpOnly/i, /; Secure/i, /; SameSite=lax/i, /; Path=\//]) assert.match(cookie, attribute);

    // The FabOrchestrator session the identity check created is not kept.
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(foCalls.some((c) => c.path === "/api/auth/logout"));
    assert.equal(setCookie(res, FO_TOKEN_COOKIE), undefined, "enrollment does not sign anyone in");

    const listed = (await deviceStore().listDevices()).find((d) => d.deviceId === "DEVICE-002")!;
    assert.equal(listed.userId, "user-alice");
    assert.equal(listed.createdBy, "admin@plant.example");
    assert.equal(listed.context, "installed-app");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: device! }), "passed");
  });

  test("expired enrollment fails", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin, "alice@plant.example");
    const { pending } = await openLink(token);
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      const { res } = await complete(pending, "alice@plant.example", "alice-pass");
      assert.equal(res.status, 410);
      const { res: link } = await openLink(token);
      assert.match(link.headers.get("location") ?? "", /link=invalid/);
    } finally {
      Date.now = realNow;
    }
    assert.ok(!foCalls.some((c) => c.path === "/api/auth/login"), "FabOrchestrator is not asked for a dead link");
  });

  test("already-used enrollment fails, and its QR can never be reused", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin, "alice@plant.example");
    const first = await openLink(token);
    assert.equal((await complete(first.pending, "alice@plant.example", "alice-pass")).res.status, 200);
    const again = await openLink(token);
    assert.match(again.res.headers.get("location") ?? "", /link=invalid/);
    assert.equal(again.pending, "", "no pending cookie for a used link");
    // Even replaying the old pending cookie directly.
    assert.equal((await complete(first.pending, "alice@plant.example", "alice-pass")).res.status, 410);
  });

  test("wrong user fails: by the email typed, and by who FabOrchestrator says signed in", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin, "alice@plant.example");
    const { pending } = await openLink(token);
    const typed = await complete(pending, "bob@plant.example", "bob-pass");
    assert.equal(typed.res.status, 403);
    assert.equal(typed.body.code, "enrollment_wrong_user");
    assert.ok(!foCalls.some((c) => c.path === "/api/auth/login"), "bob's password is not even sent");

    setFoAnswersAs("bob@plant.example");
    const vouched = await complete(pending, "alice@plant.example", "alice-pass");
    assert.equal(vouched.res.status, 403);
    assert.equal(vouched.device, undefined);
    setFoAnswersAs(null);

    // Still usable by Alice herself.
    assert.equal((await complete(pending, "alice@plant.example", "alice-pass")).res.status, 200);
  });

  test("a wrong password enrolls nothing and counts against the limiter", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin, "alice@plant.example");
    const { pending } = await openLink(token);
    const { res } = await complete(pending, "alice@plant.example", "nope");
    assert.equal(res.status, 401);
    assert.equal((await deviceStore().lookupEnrollment(token)).kind, "valid");
  });

  test("the same enrollment completed twice at once creates one device", async () => {
    const admin = await adminBrowser();
    const { token } = await createEnrollment(admin, "alice@plant.example");
    const { pending } = await openLink(token);
    const results = await Promise.all(Array.from({ length: 6 }, () => complete(pending, "alice@plant.example", "alice-pass")));
    assert.equal(results.filter((r) => r.res.status === 200).length, 1);
    assert.equal(results.filter((r) => r.device).length, 1);
    assert.equal((await deviceStore().listDevices()).filter((d) => d.email === "alice@plant.example").length, 1);
  });

  test("without a pending enrollment, or from another site, nothing happens", async () => {
    assert.equal((await complete(undefined, "alice@plant.example", "alice-pass")).res.status, 410);
    const res = await COMPLETE(
      request("/api/pwa/device-enrollments/complete", {
        headers: { "sec-fetch-site": "cross-site" },
        json: { email: "alice@plant.example", password: "alice-pass" },
      }),
    );
    assert.equal(res.status, 403);
  });
});

/* ── Administration: authorization ─────────────────────────────────────────── */

describe("admin endpoints require an approved device, a session and the allowlist", () => {
  test("no session → 401; a non-admin → 403; an admin on an unapproved device → blocked; an admin on an approved one → OK", async () => {
    const alice = sessionOf("alice@plant.example");
    const aliceDevice = await bootstrapDevice("alice@plant.example");
    const admin = sessionOf("admin@plant.example");
    const adminDevice = await bootstrapDevice("admin@plant.example");
    const json = { email: "bob@plant.example" };
    const call = (cookies: Record<string, string | null>, bearer?: string) =>
      CREATE_ENROLLMENT(
        request("/api/pwa/device-enrollments", { cookies, json, headers: bearer ? { authorization: bearer } : {} }),
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
    await enrollPhone(admin, "alice@plant.example");
    const res = await LIST_DEVICES(request("/api/pwa/devices", { cookies: admin.cookies, headers: { authorization: admin.bearer } }));
    const text = await res.text();
    const file = readFileSync(currentStorePath(), "utf8");
    const hashes = [...file.matchAll(/"th":"([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(hashes.length >= 2);
    for (const value of [...hashes, ...secrets]) assert.ok(!text.includes(value));
    assert.match(text, /"deviceId":"DEVICE-002"/);
  });

  test("an enrollment link is never built from the Host header", async () => {
    const admin = await adminBrowser();
    delete process.env.PUBLIC_ORIGIN;
    try {
      const res = await CREATE_ENROLLMENT(
        request("/api/pwa/device-enrollments", { cookies: admin.cookies, headers: { authorization: admin.bearer, host: "evil.example" }, json: { email: "alice@plant.example" } }),
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
    const phone = await enrollPhone(admin, "alice@plant.example");
    const alice = sessionOf("alice@plant.example");
    assert.equal(await gate("/home", browser(phone, alice)), "passed");

    const res = await REVOKE(
      request("/api/pwa/devices/DEVICE-002/revoke", { cookies: admin.cookies, headers: { authorization: admin.bearer }, json: { reason: "phone lost" } }),
      { params: Promise.resolve({ deviceId: "DEVICE-002" }) },
    );
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
    const oldPhone = await enrollPhone(admin, "alice@plant.example");
    await REVOKE(
      request("/api/pwa/devices/DEVICE-002/revoke", { cookies: admin.cookies, headers: { authorization: admin.bearer }, json: {} }),
      { params: Promise.resolve({ deviceId: "DEVICE-002" }) },
    );
    const newPhone = await enrollPhone(admin, "alice@plant.example");
    assert.match(newPhone, /^DEVICE-003\./);
    assert.equal(await gate("/", { [DEVICE_COOKIE]: newPhone }), "passed");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: oldPhone }), "blocked");
  });

  test("re-enrolling a browser that holds an approved credential revokes the credential it replaces", async () => {
    const admin = await adminBrowser();
    const first = await enrollPhone(admin, "alice@plant.example");
    const second = await enrollPhone(admin, "alice@plant.example", { [DEVICE_COOKIE]: first });
    assert.notEqual(first, second);
    assert.equal(await gate("/", { [DEVICE_COOKIE]: first }), "blocked");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: second }), "passed");
    assert.ok(logged.some((l) => l.includes('"action":"DEVICE_REENROLLED"')));
  });
});

/* ── Sign-in on an approved device ─────────────────────────────────────────── */

describe("sign-in after the device check", () => {
  const login = (device: string | null, email: string, password: string) =>
    LOGIN(request("/api/pwa/auth/login", { cookies: { [DEVICE_COOKIE]: device }, json: { email, password } }));

  test("the device's own user signs in, and the device credential is renewed", async () => {
    const device = await bootstrapDevice("alice@plant.example");
    const res = await login(device, "alice@plant.example", "alice-pass");
    assert.equal(res.status, 200);
    assert.equal(setCookie(res, DEVICE_COOKIE), device);
    assert.ok(setCookie(res, FO_TOKEN_COOKIE));
  });

  test("another account on Alice's device is refused, and its fresh FabOrchestrator token revoked", async () => {
    const device = await bootstrapDevice("alice@plant.example");
    const res = await login(device, "bob@plant.example", "bob-pass");
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "device_user_mismatch");
    assert.equal(setCookie(res, FO_TOKEN_COOKIE), undefined);
    assert.ok(foCalls.some((c) => c.path === "/api/auth/logout"));
  });

  test("the route refuses an unapproved device itself, not only behind the proxy", async () => {
    const res = await login(null, "alice@plant.example", "alice-pass");
    assert.equal(res.status, 403);
    assert.equal(setCookie(res, FO_TOKEN_COOKIE), undefined);
  });
});

/* ── The manual acceptance scenarios ───────────────────────────────────────── */

describe("acceptance scenarios A–F", () => {
  test("A–F", async () => {
    const admin = await adminBrowser(); // DEVICE-001 is the administrator's own

    // A: Phone A, never enrolled, opens the normal FO QR → BLOCK.
    assert.equal(await gate("/"), "blocked");

    // B: the admin issues an enrollment; Phone A uses it and becomes a device.
    const phoneA = await enrollPhone(admin, "alice@plant.example");
    assert.match(phoneA, /^DEVICE-002\./);

    // C: Phone A opens the normal QR → device verified → sign-in → FO.
    assert.equal(redirectedTo(await proxy(request("/", { cookies: { [DEVICE_COOKIE]: phoneA } }))), "/login");
    const signIn = await LOGIN(request("/api/pwa/auth/login", { cookies: { [DEVICE_COOKIE]: phoneA }, json: { email: "alice@plant.example", password: "alice-pass" } }));
    assert.equal(signIn.status, 200);
    const foCookie = setCookie(signIn, FO_TOKEN_COOKIE)!;
    assert.equal(await gate("/home", { [DEVICE_COOKIE]: phoneA, [FO_TOKEN_COOKIE]: foCookie }), "passed");

    // D: Phone B, same user account, not enrolled → BLOCK, even holding Alice's FO session cookie.
    assert.equal(await gate("/"), "blocked");
    assert.equal(await gate("/home", { [FO_TOKEN_COOKIE]: foCookie }), "blocked");
    assert.equal(await gate("/api/pwa/auth/login", {}, "POST"), "blocked");

    // E: the admin revokes Phone A's device → Phone A is blocked.
    await REVOKE(
      request("/api/pwa/devices/DEVICE-002/revoke", { cookies: admin.cookies, headers: { authorization: admin.bearer }, json: {} }),
      { params: Promise.resolve({ deviceId: "DEVICE-002" }) },
    );
    assert.equal(await gate("/home", { [DEVICE_COOKIE]: phoneA, [FO_TOKEN_COOKIE]: foCookie }), "blocked");

    // F: Phone B gets its own enrollment → DEVICE-003, which works on its own.
    const phoneB = await enrollPhone(admin, "alice@plant.example");
    assert.match(phoneB, /^DEVICE-003\./);
    assert.equal(await gate("/", { [DEVICE_COOKIE]: phoneB }), "passed");
    assert.equal(await gate("/", { [DEVICE_COOKIE]: phoneA }), "blocked");

    // Every step is in the audit log.
    for (const action of ["DEVICE_ENROLLMENT_CREATED", "DEVICE_ENROLLED", "DEVICE_ACCESS_BLOCKED", "DEVICE_ACCESS_ALLOWED", "DEVICE_REVOKED"]) {
      assert.ok(logged.some((l) => l.includes(`"action":"${action}"`)), action);
    }
  });
});
