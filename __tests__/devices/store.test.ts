/**
 * The device store (`lib/devices/store.ts`): one-time enrollments, approved
 * devices, revocation, and the rules that keep it closed when anything is off.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { currentStorePath, setUp, tearDown } from "./fixture";
import { hashSecret } from "@/lib/devices/credential";
import { describeDevice } from "@/lib/devices/metadata";
import { DeviceStore, parseRecord, serializeRecord } from "@/lib/devices/store";

const META = describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", true);
const TEN_MIN = 10 * 60 * 1000;

let store: DeviceStore;

beforeEach(async () => {
  await setUp();
  store = new DeviceStore(currentStorePath());
});
afterEach(async () => {
  await store.close();
  await tearDown();
});

async function issue(email = "alice@plant.example", now = Date.now()) {
  return store.createEnrollment({ allowedEmail: email, createdBy: "admin@plant.example", ttlMs: TEN_MIN, now });
}

async function enroll(email = "alice@plant.example") {
  const { token } = await issue(email);
  const result = await store.completeEnrollment({ token, userId: `id-${email}`, email, metadata: META });
  assert.equal(result.kind, "enrolled");
  return result as Extract<typeof result, { kind: "enrolled" }>;
}

describe("enrollment", () => {
  test("a valid enrollment creates an APPROVED device with a fresh id and token", async () => {
    const result = await enroll();
    assert.equal(result.device.deviceId, "DEVICE-001");
    assert.equal(result.device.status, "APPROVED");
    assert.equal(result.device.userId, "id-alice@plant.example");
    assert.equal(result.device.createdBy, "admin@plant.example");
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await store.verifyDevice("DEVICE-001", result.token)).kind, "approved");
  });

  test("an expired enrollment cannot be used", async () => {
    const { token } = await issue("alice@plant.example", Date.now() - TEN_MIN - 1);
    assert.equal((await store.lookupEnrollment(token)).kind, "expired");
    const result = await store.completeEnrollment({ token, userId: "a", email: "alice@plant.example", metadata: META });
    assert.equal(result.kind, "expired");
    assert.equal((await store.listDevices()).length, 0);
  });

  test("an already-used enrollment cannot be used again", async () => {
    const { token } = await issue();
    const first = await store.completeEnrollment({ token, userId: "a", email: "alice@plant.example", metadata: META });
    assert.equal(first.kind, "enrolled");
    const second = await store.completeEnrollment({ token, userId: "a", email: "alice@plant.example", metadata: META });
    assert.equal(second.kind, "used");
    assert.equal((await store.listDevices()).length, 1);
  });

  test("the wrong user cannot use it, and it stays usable for the right one", async () => {
    const { token } = await issue("alice@plant.example");
    const wrong = await store.completeEnrollment({ token, userId: "b", email: "bob@plant.example", metadata: META });
    assert.equal(wrong.kind, "wrong_user");
    assert.equal((await store.lookupEnrollment(token)).kind, "valid");
    const right = await store.completeEnrollment({ token, userId: "a", email: "ALICE@plant.example", metadata: META });
    assert.equal(right.kind, "enrolled");
  });

  test("an unknown or malformed token names nothing", async () => {
    assert.equal((await store.lookupEnrollment("x".repeat(43))).kind, "unknown");
    assert.equal((await store.lookupEnrollment("not a token")).kind, "unknown");
  });

  test("the same enrollment raced twenty times in one process creates exactly one device", async () => {
    const { token } = await issue();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.completeEnrollment({ token, userId: "a", email: "alice@plant.example", metadata: META }),
      ),
    );
    assert.equal(results.filter((r) => r.kind === "enrolled").length, 1);
    assert.equal((await store.listDevices()).length, 1);
  });

  test("the same enrollment raced from two store instances (two writers on one file) creates exactly one device", async () => {
    const { token } = await issue();
    const other = new DeviceStore(currentStorePath());
    try {
      const results = await Promise.all([
        ...Array.from({ length: 5 }, () => store.completeEnrollment({ token, userId: "a", email: "alice@plant.example", metadata: META })),
        ...Array.from({ length: 5 }, () => other.completeEnrollment({ token, userId: "a", email: "alice@plant.example", metadata: META })),
      ]);
      assert.equal(results.filter((r) => r.kind === "enrolled").length, 1);
      assert.equal((await store.listDevices()).length, 1);
      assert.equal((await other.listDevices()).length, 1);
    } finally {
      await other.close();
    }
  });

  test("pending enrollments list only unused, unexpired ones, without tokens", async () => {
    await issue("alice@plant.example");
    await issue("bob@plant.example", Date.now() - TEN_MIN - 1);
    await enroll("admin@plant.example");
    const pending = await store.listPendingEnrollments();
    assert.deepEqual(pending.map((e) => e.allowedEmail), ["alice@plant.example"]);
    assert.ok(!JSON.stringify(pending).includes("th"));
  });
});

describe("device verification", () => {
  test("approved credential passes; a wrong token, an unknown id and a revoked device do not", async () => {
    const { device, token } = await enroll();
    assert.equal((await store.verifyDevice(device.deviceId, token)).kind, "approved");
    assert.equal((await store.verifyDevice(device.deviceId, "A".repeat(43))).kind, "mismatch");
    assert.equal((await store.verifyDevice("DEVICE-999", token)).kind, "unknown");
    await store.revokeDevice(device.deviceId, { by: "admin@plant.example", reason: "lost" });
    assert.equal((await store.verifyDevice(device.deviceId, token)).kind, "revoked");
  });

  test("revocation is recorded with who and when, and is idempotent", async () => {
    const { device } = await enroll();
    const first = await store.revokeDevice(device.deviceId, { by: "admin@plant.example", reason: "lost", now: 1000 });
    assert.equal(first?.changed, true);
    assert.equal(first?.device.revokedBy, "admin@plant.example");
    assert.equal(first?.device.revokedAt, 1000);
    const again = await store.revokeDevice(device.deviceId, { by: "someone-else", reason: "x", now: 2000 });
    assert.equal(again?.changed, false);
    assert.equal(again?.device.revokedBy, "admin@plant.example");
    assert.equal(again?.device.revokedAt, 1000);
    assert.equal(await store.revokeDevice("DEVICE-404", { by: "a", reason: "x" }), null);
  });

  test("a replacement device gets a new id and token; the old one stays revoked", async () => {
    const old = await enroll();
    await store.revokeDevice(old.device.deviceId, { by: "admin@plant.example", reason: "replaced" });
    const fresh = await enroll();
    assert.equal(fresh.device.deviceId, "DEVICE-002");
    assert.notEqual(fresh.token, old.token);
    assert.equal((await store.verifyDevice(fresh.device.deviceId, fresh.token)).kind, "approved");
    assert.equal((await store.verifyDevice(old.device.deviceId, old.token)).kind, "revoked");
    // The new token does not open the old id, nor the old token the new id.
    assert.equal((await store.verifyDevice(old.device.deviceId, fresh.token)).kind, "mismatch");
    assert.equal((await store.verifyDevice(fresh.device.deviceId, old.token)).kind, "mismatch");
  });

  test("a revocation written by another instance is seen on the next check (no stale cache)", async () => {
    const { device, token } = await enroll();
    assert.equal((await store.verifyDevice(device.deviceId, token)).kind, "approved");
    const other = new DeviceStore(currentStorePath());
    try {
      await other.revokeDevice(device.deviceId, { by: "admin@plant.example", reason: "lost" });
    } finally {
      await other.close();
    }
    assert.equal((await store.verifyDevice(device.deviceId, token)).kind, "revoked");
  });

  test("last seen is exact in memory and written at most every 15 minutes", async () => {
    const { device } = await enroll();
    const t0 = Date.now();
    assert.equal(await store.recordSeen(device.deviceId, t0), true);
    assert.equal(await store.recordSeen(device.deviceId, t0 + 60_000), false);
    assert.equal((await store.getDevice(device.deviceId))?.lastSeenAt, t0 + 60_000);
    assert.equal(await store.recordSeen(device.deviceId, t0 + 16 * 60_000), true);
    const seenLines = readFileSync(currentStorePath(), "utf8").split("\n").filter((l) => l.includes('"t":"seen"'));
    assert.equal(seenLines.length, 2);
  });
});

describe("what the file holds", () => {
  test("only hashes: neither the enrollment token nor the device token is stored", async () => {
    const { token: enrollmentToken } = await issue();
    const result = await store.completeEnrollment({ token: enrollmentToken, userId: "a", email: "alice@plant.example", metadata: META });
    assert.equal(result.kind, "enrolled");
    const deviceToken = (result as { token: string }).token;
    const file = readFileSync(currentStorePath(), "utf8");
    assert.ok(!file.includes(enrollmentToken), "enrollment token must not be stored");
    assert.ok(!file.includes(deviceToken), "device token must not be stored");
    assert.ok(file.includes(hashSecret(enrollmentToken)));
    assert.ok(file.includes(hashSecret(deviceToken)));
  });

  test("a torn, altered or forged line grants nothing", async () => {
    const { device, token } = await enroll();
    // An "enrolled" line for an enrollment the file does not hold: no device.
    const forged = serializeRecord({
      t: "enrolled",
      eid: "enr_AAAAAAAAAAAAAAAA",
      dev: "DEVICE-777",
      th: hashSecret("B".repeat(43)),
      uid: "x",
      email: "x@x",
      name: "x",
      dtype: "phone",
      os: "iOS",
      browser: "Safari",
      ctx: "browser",
      at: Date.now(),
    });
    // A revocation whose checksum does not verify: ignored, the device stays approved.
    const altered = serializeRecord({ t: "revoked", dev: device.deviceId, by: "x", reason: "x", at: Date.now() }).replace('"by":"x"', '"by":"y"');
    appendFileSync(currentStorePath(), `${forged}\n${altered}\n{"v":1,"t":"rev`);
    assert.equal(parseRecord(altered), null);
    assert.equal((await store.verifyDevice("DEVICE-777", "B".repeat(43))).kind, "unknown");
    assert.equal((await store.verifyDevice(device.deviceId, token)).kind, "approved");
    assert.equal((await store.stats()).corrupt, 3);
    // And the store still writes cleanly after a torn tail.
    await store.revokeDevice(device.deviceId, { by: "admin@plant.example", reason: "lost" });
    assert.equal((await store.verifyDevice(device.deviceId, token)).kind, "revoked");
  });

  test("a store file replaced underneath a running store is the one written and read next", async () => {
    await enroll("alice@plant.example");
    rmSync(currentStorePath());
    const { token } = await issue("bob@plant.example");
    assert.equal((await store.lookupEnrollment(token)).kind, "valid");
    assert.ok(readFileSync(currentStorePath(), "utf8").includes("bob@plant.example"));
    assert.equal((await store.listDevices()).length, 0, "the replaced file's devices are gone, not remembered");
  });

  test("an enrollment's marker exists once it is used, so a crash after it burns the enrollment rather than reusing it", async () => {
    const { token, enrollment } = await issue();
    await store.completeEnrollment({ token, userId: "a", email: "alice@plant.example", metadata: META });
    const markers = readdirSync(`${currentStorePath()}.locks`);
    assert.ok(markers.includes(`enrollment-${enrollment.enrollmentId}`));
    assert.ok(markers.includes("device-DEVICE-001"));
  });
});
