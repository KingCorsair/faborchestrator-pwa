/**
 * The device store (`lib/devices/store.ts`): one-time enrollments, devices
 * holding a public key, sessions bound to devices, revocation, and the rules
 * that keep it closed when anything is off.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { currentStorePath, newPhoneKey, setUp, tearDown, type PhoneKey } from "./fixture";
import { hashSecret } from "@/lib/devices/credential";
import { describeDevice } from "@/lib/devices/metadata";
import { DeviceStore, parseRecord, recordChecksum, serializeRecord } from "@/lib/devices/store";

const META = describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", true);
const TEN_MIN = 10 * 60 * 1000;
const SESSION_FP = "AbCdEfGhIjKlMnOpQrStUv";

let store: DeviceStore;

beforeEach(async () => {
  await setUp();
  store = new DeviceStore(currentStorePath());
});
afterEach(async () => {
  await store.close();
  await tearDown();
});

async function issue(now = Date.now(), friendlyName?: string) {
  return store.createEnrollment({ createdBy: "admin@plant.example", ttlMs: TEN_MIN, now, friendlyName });
}

async function enroll(key?: PhoneKey) {
  const k = key ?? (await newPhoneKey());
  const { token } = await issue();
  const result = await store.completeEnrollment({ token, publicKeySpki: k.spki, metadata: META });
  assert.equal(result.kind, "enrolled");
  return { ...(result as Extract<typeof result, { kind: "enrolled" }>), key: k };
}

describe("enrollment", () => {
  test("a valid enrollment creates an APPROVED device holding the device's public key", async () => {
    const { device, key } = await enroll();
    assert.equal(device.deviceId, "DEVICE-001");
    assert.equal(device.status, "APPROVED");
    assert.equal(device.createdBy, "admin@plant.example");
    assert.match(device.keyFingerprint, /^[0-9a-f]{32}$/);
    assert.equal(await store.publicKeyOf("DEVICE-001"), key.spki);
  });

  test("an expired enrollment cannot be used", async () => {
    const { token } = await issue(Date.now() - TEN_MIN - 1);
    assert.equal((await store.lookupEnrollment(token)).kind, "expired");
    const result = await store.completeEnrollment({ token, publicKeySpki: (await newPhoneKey()).spki, metadata: META });
    assert.equal(result.kind, "expired");
    assert.equal((await store.listDevices()).length, 0);
  });

  test("an already-used enrollment cannot be used again", async () => {
    const { token } = await issue();
    assert.equal((await store.completeEnrollment({ token, publicKeySpki: (await newPhoneKey()).spki, metadata: META })).kind, "enrolled");
    assert.equal((await store.completeEnrollment({ token, publicKeySpki: (await newPhoneKey()).spki, metadata: META })).kind, "used");
    assert.equal((await store.listDevices()).length, 1);
  });

  test("the code alone enrolls: no user is named or recorded; a malformed key is refused", async () => {
    const { token, enrollment } = await issue(Date.now(), "Line 3 phone");
    assert.deepEqual(Object.keys(enrollment).sort(), ["createdAt", "createdBy", "deviceId", "enrollmentId", "expiresAt", "friendlyName", "site", "usedAt"]);
    assert.equal((await store.completeEnrollment({ token, publicKeySpki: "A".repeat(91), metadata: META })).kind, "bad_key");
    const result = await store.completeEnrollment({ token, publicKeySpki: (await newPhoneKey()).spki, metadata: META });
    assert.equal(result.kind, "enrolled");
    if (result.kind === "enrolled") assert.equal(result.device.friendlyName, "Line 3 phone");
    assert.ok(!readFileSync(currentStorePath(), "utf8").includes("email"));
  });

  test("an unknown or malformed code names nothing", async () => {
    assert.equal((await store.lookupEnrollment("x".repeat(43))).kind, "unknown");
    assert.equal((await store.lookupEnrollment("not a token")).kind, "unknown");
  });

  test("the same enrollment raced twenty times in one process creates exactly one device", async () => {
    const { token } = await issue();
    const keys = await Promise.all(Array.from({ length: 20 }, () => newPhoneKey()));
    const results = await Promise.all(keys.map((k) => store.completeEnrollment({ token, publicKeySpki: k.spki, metadata: META })));
    assert.equal(results.filter((r) => r.kind === "enrolled").length, 1);
    assert.equal((await store.listDevices()).length, 1);
  });

  test("the same enrollment raced from two store instances (two writers on one file) creates exactly one device", async () => {
    const { token } = await issue();
    const other = new DeviceStore(currentStorePath());
    try {
      const keys = await Promise.all(Array.from({ length: 10 }, () => newPhoneKey()));
      const results = await Promise.all(
        keys.map((k, i) => (i % 2 ? store : other).completeEnrollment({ token, publicKeySpki: k.spki, metadata: META })),
      );
      assert.equal(results.filter((r) => r.kind === "enrolled").length, 1);
      assert.equal((await store.listDevices()).length, 1);
      assert.equal((await other.listDevices()).length, 1);
    } finally {
      await other.close();
    }
  });

  test("pending enrollments list only unused, unexpired ones, without code hashes", async () => {
    await issue(Date.now(), "pending");
    await issue(Date.now() - TEN_MIN - 1, "expired");
    await enroll();
    const pending = await store.listPendingEnrollments();
    assert.deepEqual(pending.map((e) => e.friendlyName), ["pending"]);
    assert.ok(!JSON.stringify(pending).includes("th"));
  });
});

describe("sessions bound to devices", () => {
  test("a bound session names its device while the binding lasts; unknown or expired sessions name nothing", async () => {
    const { device } = await enroll();
    const now = Date.now();
    await store.bindSession(SESSION_FP, device.deviceId, now + 60_000, now);
    assert.equal((await store.sessionDevice(SESSION_FP, now))?.deviceId, device.deviceId);
    assert.equal(await store.sessionDevice(SESSION_FP, now + 60_001), null);
    assert.equal(await store.sessionDevice("ZzZzZzZzZzZzZzZzZzZzZz", now), null);
  });

  test("a session's device reflects revocation at once", async () => {
    const { device } = await enroll();
    await store.bindSession(SESSION_FP, device.deviceId, Date.now() + 60_000);
    await store.revokeDevice(device.deviceId, { by: "admin@plant.example", reason: "lost" });
    assert.equal((await store.sessionDevice(SESSION_FP))?.status, "REVOKED");
  });

  test("a binding is never re-pointed to another device", async () => {
    const a = await enroll();
    const b = await enroll();
    await store.bindSession(SESSION_FP, a.device.deviceId, Date.now() + 60_000);
    await store.bindSession(SESSION_FP, b.device.deviceId, Date.now() + 60_000);
    assert.equal((await store.sessionDevice(SESSION_FP))?.deviceId, a.device.deviceId);
  });

  test("a binding written by another instance is seen at once (the proxy reads what sign-in wrote)", async () => {
    const { device } = await enroll();
    const other = new DeviceStore(currentStorePath());
    try {
      await other.bindSession(SESSION_FP, device.deviceId, Date.now() + 60_000);
    } finally {
      await other.close();
    }
    assert.equal((await store.sessionDevice(SESSION_FP))?.deviceId, device.deviceId);
  });
});

describe("devices", () => {
  test("revocation is recorded with who and when, and is idempotent", async () => {
    const { device } = await enroll();
    const first = await store.revokeDevice(device.deviceId, { by: "admin@plant.example", reason: "lost", now: 1000 });
    assert.equal(first?.changed, true);
    assert.equal(first?.device.revokedBy, "admin@plant.example");
    assert.equal(first?.device.revokedAt, 1000);
    const again = await store.revokeDevice(device.deviceId, { by: "someone-else", reason: "x", now: 2000 });
    assert.equal(again?.changed, false);
    assert.equal(again?.device.revokedAt, 1000);
    assert.equal(await store.revokeDevice("DEVICE-404", { by: "a", reason: "x" }), null);
  });

  test("a replacement device gets a new id and its own key; the old one stays revoked", async () => {
    const old = await enroll();
    await store.revokeDevice(old.device.deviceId, { by: "admin@plant.example", reason: "replaced" });
    const fresh = await enroll();
    assert.equal(fresh.device.deviceId, "DEVICE-002");
    assert.notEqual(await store.publicKeyOf("DEVICE-002"), await store.publicKeyOf("DEVICE-001"));
    assert.equal((await store.getDevice("DEVICE-001"))?.status, "REVOKED");
    assert.equal((await store.getDevice("DEVICE-002"))?.status, "APPROVED");
  });

  test("the same public key cannot be registered twice", async () => {
    const key = await newPhoneKey();
    await enroll(key);
    const { token } = await issue();
    const second = await store.completeEnrollment({ token, publicKeySpki: key.spki, metadata: META });
    assert.equal(second.kind, "bad_key");
    assert.equal((await store.listDevices()).length, 1);
    assert.equal((await store.lookupEnrollment(token)).kind, "valid", "the enrollment is not spent");
  });

  test("last seen is exact in memory and written at most every 15 minutes", async () => {
    const { device } = await enroll();
    const t0 = Date.now();
    assert.equal(await store.recordSeen(device.deviceId, t0), true);
    assert.equal(await store.recordSeen(device.deviceId, t0 + 60_000), false);
    assert.equal((await store.getDevice(device.deviceId))?.lastSeenAt, t0 + 60_000);
    assert.equal(await store.recordSeen(device.deviceId, t0 + 16 * 60_000), true);
  });
});

describe("what the file holds", () => {
  test("public keys and code hashes only: never a private key or a raw enrollment code", async () => {
    const key = await newPhoneKey();
    const { token } = await issue();
    await store.completeEnrollment({ token, publicKeySpki: key.spki, metadata: META });
    const file = readFileSync(currentStorePath(), "utf8");
    assert.ok(!file.includes(token), "enrollment code must not be stored");
    assert.ok(file.includes(hashSecret(token)));
    assert.ok(file.includes(key.spki), "the public key is stored");
    assert.equal(key.pair.privateKey.extractable, false, "the private key cannot even be exported to be stored");
  });

  test("a torn, altered, forged or earlier-version line grants nothing", async () => {
    const { device } = await enroll();
    const forged = serializeRecord({
      t: "enrolled",
      eid: "enr_AAAAAAAAAAAAAAAA",
      dev: "DEVICE-777",
      pk: (await newPhoneKey()).spki,
      name: "x",
      dtype: "phone",
      os: "iOS",
      browser: "Safari",
      ctx: "browser",
      at: Date.now(),
    });
    const altered = serializeRecord({ t: "revoked", dev: device.deviceId, by: "x", reason: "x", at: Date.now() }).replace('"by":"x"', '"by":"y"');
    const v2 = { v: 2, t: "enrollment", id: "enr_BBBBBBBBBBBBBBBB", th: hashSecret("C".repeat(43)), by: "x", site: null, name: null, at: Date.now(), exp: Date.now() + TEN_MIN };
    appendFileSync(currentStorePath(), `${forged}\n${altered}\n${JSON.stringify({ ...v2, h: recordChecksum(v2) })}\n{"v":3,"t":"rev`);
    assert.equal(parseRecord(altered), null);
    assert.equal(await store.getDevice("DEVICE-777"), null);
    assert.equal((await store.getDevice(device.deviceId))?.status, "APPROVED");
    assert.equal((await store.lookupEnrollment("C".repeat(43))).kind, "unknown");
    assert.equal((await store.stats()).corrupt, 4);
    await store.revokeDevice(device.deviceId, { by: "admin@plant.example", reason: "lost" });
    assert.equal((await store.getDevice(device.deviceId))?.status, "REVOKED");
  });

  test("a store file replaced underneath a running store is the one written and read next", async () => {
    await enroll();
    rmSync(currentStorePath());
    const { token, enrollment } = await issue();
    assert.equal((await store.lookupEnrollment(token)).kind, "valid");
    assert.ok(readFileSync(currentStorePath(), "utf8").includes(enrollment.enrollmentId));
    assert.equal((await store.listDevices()).length, 0);
  });

  test("an enrollment's marker exists once it is used, so a crash after it burns the enrollment rather than reusing it", async () => {
    const { token, enrollment } = await issue();
    await store.completeEnrollment({ token, publicKeySpki: (await newPhoneKey()).spki, metadata: META });
    const markers = readdirSync(`${currentStorePath()}.locks`);
    assert.ok(markers.includes(`enrollment-${enrollment.enrollmentId}`));
    assert.ok(markers.includes("device-DEVICE-001"));
  });
});
