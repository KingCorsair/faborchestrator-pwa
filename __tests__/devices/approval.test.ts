/**
 * An administrator approves each device enrolled with a QR (14 October 2026).
 *
 *   scan → DEVICE-nnn PENDING, holding its key, with where the request came
 *   from → nothing opens (no challenge, no sign-in, no install grant) →
 *   an administrator approves it (APPROVED) or blocks it (REJECTED, for good:
 *   a new QR is needed).
 *
 * Through the real route handlers and the real store, as `flow.test.ts`.
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { bindSession, currentStorePath, foCalls, newPhoneKey, request, sessionOf, setUp, signChallenge, tearDown, type PhoneKey } from "./fixture";
import { describeDevice } from "@/lib/devices/metadata";
import { enrollmentNeedsApproval } from "@/lib/devices/enrollment";
import { BOOTSTRAP_ISSUER, deviceStore, serializeRecord } from "@/lib/devices/store";
import { POST as START } from "@/app/api/pwa/device-enrollments/start/route";
import { POST as COMPLETE } from "@/app/api/pwa/device-enrollments/complete/route";
import { POST as CREATE_ENROLLMENT } from "@/app/api/pwa/device-enrollments/route";
import { GET as LIST_DEVICES } from "@/app/api/pwa/devices/route";
import { POST as REVOKE } from "@/app/api/pwa/devices/[deviceId]/revoke/route";
import { POST as APPROVE } from "@/app/api/pwa/devices/[deviceId]/approve/route";
import { POST as CHALLENGE } from "@/app/api/pwa/device-auth/challenge/route";
import { POST as LOGIN } from "@/app/api/pwa/auth/login/route";

let logged: string[] = [];
let secrets: string[] = [];
const APPROVAL_ENV = process.env.DEVICE_ENROLLMENT_APPROVAL;

beforeEach(async () => {
  await setUp({ gate: "enforce" });
  delete process.env.DEVICE_ENROLLMENT_APPROVAL;
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
  if (APPROVAL_ENV === undefined) delete process.env.DEVICE_ENROLLMENT_APPROVAL;
  else process.env.DEVICE_ENROLLMENT_APPROVAL = APPROVAL_ENV;
  await tearDown();
});

/* ── Helpers ───────────────────────────────────────────────────────────────── */

/** A device approved by a bootstrap-CLI enrollment, signed in as `email`, session bound to it. */
async function signedInOn(email: string) {
  const key = await newPhoneKey();
  const store = deviceStore();
  const { token } = await store.createEnrollment({ createdBy: BOOTSTRAP_ISSUER, ttlMs: 600_000 });
  secrets.push(token);
  const result = await store.completeEnrollment({
    token,
    publicKeySpki: key.spki,
    metadata: describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/130", false),
    requireApproval: true,
  });
  assert.equal(result.kind, "enrolled");
  const deviceId = (result as { device: { deviceId: string } }).device.deviceId;
  const session = sessionOf(email);
  await bindSession(session.foToken, deviceId);
  return { deviceId, cookies: session.cookies, bearer: session.bearer };
}
type Browser = Awaited<ReturnType<typeof signedInOn>>;

const asAdmin = (who: Browser, path: string, json: unknown = {}, headers: Record<string, string> = {}) =>
  request(path, { cookies: who.cookies, headers: { authorization: who.bearer, ...headers }, json });

async function issueQr(admin: Browser) {
  const res = await CREATE_ENROLLMENT(asAdmin(admin, "/api/pwa/device-enrollments", { friendlyName: "Phone A" }));
  assert.equal(res.status, 201);
  const token = new URL(((await res.json()) as { url: string }).url).pathname.split("/").pop()!;
  secrets.push(token);
  return token;
}

/** What a phone does when it scans the QR. `fly-region` as Fly's edge would add it. */
async function scan(token: string): Promise<{ key: PhoneKey; deviceId: string; status: string }> {
  const key = await newPhoneKey();
  const start = await START(request("/api/pwa/device-enrollments/start", { json: { token } }));
  const s = (await start.json()) as { challengeId: string; challenge: string };
  const res = await COMPLETE(
    request("/api/pwa/device-enrollments/complete", {
      headers: { "fly-region": "sjc" },
      json: {
        token,
        challengeId: s.challengeId,
        publicKeySpki: key.spki,
        signature: await signChallenge(key, s.challenge),
        timeZone: "Asia/Kolkata",
        language: "en-IN",
      },
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { device: { deviceId: string; status: string } };
  return { key, deviceId: body.device.deviceId, status: body.device.status };
}

async function challenge(deviceId: string, purpose?: "grant") {
  const res = await CHALLENGE(request("/api/pwa/device-auth/challenge", { json: { deviceId, ...(purpose ? { purpose } : {}) } }));
  return { status: res.status, body: (await res.json()) as { code?: string; challenge?: string; challengeId?: string } };
}

async function signIn(phone: { key: PhoneKey; deviceId: string }) {
  const c = await challenge(phone.deviceId);
  if (c.status !== 200) return c;
  const res = await LOGIN(
    request("/api/pwa/auth/login", {
      json: {
        email: "alice@plant.example",
        password: "alice-pass",
        device: { deviceId: phone.deviceId, challengeId: c.body.challengeId, signature: await signChallenge(phone.key, c.body.challenge!) },
      },
    }),
  );
  return { status: res.status, body: (await res.json()) as { code?: string } };
}

const approve = (who: Browser, deviceId: string) =>
  APPROVE(asAdmin(who, `/api/pwa/devices/${deviceId}/approve`), { params: Promise.resolve({ deviceId }) });
const block = (who: Browser, deviceId: string) =>
  REVOKE(asAdmin(who, `/api/pwa/devices/${deviceId}/revoke`, { reason: "request rejected by administrator" }), {
    params: Promise.resolve({ deviceId }),
  });

/* ── Waiting ───────────────────────────────────────────────────────────────── */

describe("a scanned QR makes a request, and a request opens nothing", () => {
  test("PENDING: the challenge says so, sign-in never reaches FabOrchestrator, and no install grant is given", async () => {
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    assert.equal(phone.status, "PENDING");

    const c = await challenge(phone.deviceId);
    assert.equal(c.status, 403);
    assert.equal(c.body.code, "device_pending");
    assert.equal(c.body.challenge, undefined, "nothing to sign");
    assert.equal((await challenge(phone.deviceId, "grant")).body.code, "device_pending", "no install grant either");

    const logins = foCalls.filter((f) => f.path === "/api/auth/login").length;
    assert.equal((await signIn(phone)).status, 403);
    assert.equal(foCalls.filter((f) => f.path === "/api/auth/login").length, logins);
    assert.ok(logged.some((l) => l.includes('"action":"DEVICE_APPROVAL_REQUESTED"')));
  });

  test("a proof signed for a challenge issued before is still refused by sign-in itself", async () => {
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    // The store, asked directly: the proof is valid, and refused on status.
    const { verifyDeviceSignIn } = await import("@/lib/devices/proof");
    const { issueChallenge } = await import("@/lib/devices/challenges");
    const root = await deviceStore().resolveCredential(phone.deviceId);
    const issued = issueChallenge("sign-in", root!.credentialId)!;
    const check = await verifyDeviceSignIn(
      { deviceId: phone.deviceId, challengeId: issued.challengeId, signature: await signChallenge(phone.key, issued.challenge) },
      deviceStore(),
    );
    assert.equal(check.ok, false);
    assert.equal((check as { reason: string }).reason, "pending");
  });

  test("the administrator sees where it came from: address, edge region, time zone, language, browser", async () => {
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    const res = await LIST_DEVICES(request("/api/pwa/devices", { cookies: admin.cookies, headers: { authorization: admin.bearer } }));
    const { devices } = (await res.json()) as {
      devices: { deviceId: string; status: string; origin: { ip: string; edge: string; edgeLocation: string; timeZone: string; language: string; userAgent: string } }[];
    };
    const row = devices.find((d) => d.deviceId === phone.deviceId)!;
    assert.equal(row.status, "PENDING");
    assert.match(row.origin.ip, /^10\.9\./);
    assert.equal(row.origin.edge, "sjc");
    assert.equal(row.origin.edgeLocation, "San Jose, US (sjc)");
    assert.equal(row.origin.timeZone, "Asia/Kolkata");
    assert.equal(row.origin.language, "en-IN");
    assert.match(row.origin.userAgent, /iPhone/);
  });
});

/* ── Deciding ──────────────────────────────────────────────────────────────── */

describe("an administrator decides", () => {
  test("approved: the phone can sign in, and is given an install grant; approving again changes nothing", async () => {
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    const res = await approve(admin, phone.deviceId);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { device: { status: string; approvedBy: string; approvedAt: string }; changed: boolean };
    assert.equal(body.device.status, "APPROVED");
    assert.equal(body.device.approvedBy, "admin@plant.example");
    assert.ok(body.device.approvedAt);
    assert.equal(body.changed, true);
    assert.ok(logged.some((l) => l.includes('"action":"DEVICE_APPROVED"')));

    assert.equal((await signIn(phone)).status, 200);
    assert.equal((await challenge(phone.deviceId, "grant")).status, 200);
    assert.equal(((await (await approve(admin, phone.deviceId)).json()) as { changed: boolean }).changed, false);
  });

  test("blocked: REJECTED for good. It reads as revoked, and cannot be approved afterwards", async () => {
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    const res = await block(admin, phone.deviceId);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { device: { status: string } }).device.status, "REJECTED");
    assert.ok(logged.some((l) => l.includes('"action":"DEVICE_REJECTED"')));

    assert.equal((await challenge(phone.deviceId)).body.code, "device_revoked");
    const again = await approve(admin, phone.deviceId);
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { code: string }).code, "not_pending");
    assert.equal((await deviceStore().getDevice(phone.deviceId))?.status, "REJECTED");
  });

  test("only a device administrator can approve; an unknown device is not found", async () => {
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    const alice = await signedInOn("alice@plant.example");
    assert.equal((await approve(alice, phone.deviceId)).status, 403);
    const anonymous = await APPROVE(request(`/api/pwa/devices/${phone.deviceId}/approve`, { json: {} }), {
      params: Promise.resolve({ deviceId: phone.deviceId }),
    });
    // No device proved and no session: refused at the device check, as every admin route is.
    assert.equal(anonymous.status, 403);
    assert.equal((await deviceStore().getDevice(phone.deviceId))?.status, "PENDING");
    assert.equal((await approve(admin, "DEVICE-999")).status, 404);
    assert.equal((await approve(admin, "not-a-device")).status, 404);
  });

  test("a request from another site is refused before anything else", async () => {
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    const res = await APPROVE(asAdmin(admin, `/api/pwa/devices/${phone.deviceId}/approve`, {}, { "sec-fetch-site": "cross-site" }), {
      params: Promise.resolve({ deviceId: phone.deviceId }),
    });
    assert.equal(res.status, 403);
    assert.equal((await deviceStore().getDevice(phone.deviceId))?.status, "PENDING");
  });
});

/* ── Setting and store ─────────────────────────────────────────────────────── */

describe("the setting, the bootstrap, and the file", () => {
  test("DEVICE_ENROLLMENT_APPROVAL: manual unless set to auto; anything else is refused", () => {
    assert.equal(enrollmentNeedsApproval({}), true);
    assert.equal(enrollmentNeedsApproval({ DEVICE_ENROLLMENT_APPROVAL: "manual" }), true);
    assert.equal(enrollmentNeedsApproval({ DEVICE_ENROLLMENT_APPROVAL: " AUTO " }), false);
    assert.throws(() => enrollmentNeedsApproval({ DEVICE_ENROLLMENT_APPROVAL: "yes" }));
  });

  test("with auto, a scan approves the device at once, as before", async () => {
    process.env.DEVICE_ENROLLMENT_APPROVAL = "auto";
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    assert.equal(phone.status, "APPROVED");
    assert.equal((await signIn(phone)).status, 200);
  });

  test("an enrollment from the bootstrap CLI is approved by being used: the first administrator has nobody to ask", async () => {
    const admin = await signedInOn("admin@plant.example");
    assert.equal((await deviceStore().getDevice(admin.deviceId))?.status, "APPROVED");
  });

  test("an `approved` line for a device that is not waiting grants nothing", async () => {
    const admin = await signedInOn("admin@plant.example");
    const phone = await scan(await issueQr(admin));
    await block(admin, phone.deviceId);
    appendFileSync(currentStorePath(), `${serializeRecord({ t: "approved", dev: phone.deviceId, by: "intruder@plant.example", at: Date.now() })}\n`);
    assert.equal((await deviceStore().getDevice(phone.deviceId))?.status, "REJECTED");
    assert.equal((await deviceStore().stats()).corrupt, 1);
  });
});
