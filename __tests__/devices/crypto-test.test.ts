/**
 * The device-credential feasibility test's server half
 * (`lib/device-crypto-test/`): the QR workflow for Jothi's Option 2 with a Web
 * Crypto device stamp. Keys here are made with Node's Web Crypto,
 * non-extractable, exactly as the browser makes them, so the signature format
 * (IEEE P1363, r‖s) is the browser's.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

process.env.DEVICE_CRYPTO_TEST = "1";
process.env.PUBLIC_ORIGIN = "https://pwa.test";

import { NextRequest } from "next/server";
import { CHALLENGE_TTL_MS, issueChallenge, keyFingerprint, resetChallenges, testEnabled, verifyProof } from "@/lib/device-crypto-test/challenges";
import {
  createEnrollment,
  ENROLLMENT_TTL_MS,
  finishAccess,
  finishEnrollment,
  resetRegistry,
  setStatus,
  snapshot,
  startAccess,
  startEnrollment,
} from "@/lib/device-crypto-test/registry";
import { GET, POST } from "@/app/api/pwa/device-crypto-test/[action]/route";
import { resetLoginFailures } from "@/lib/rate-limit";

const subtle = webcrypto.subtle;

/** A phone's key, made as the browser makes it. */
async function phoneKey(curve: "P-256" | "P-384" = "P-256") {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: curve }, false, ["sign", "verify"]);
  const der = Buffer.from(await subtle.exportKey("spki", pair.publicKey));
  return { pair, spki: der.toString("base64url"), fingerprint: keyFingerprint(der) };
}
type PhoneKey = Awaited<ReturnType<typeof phoneKey>>;

async function signB64(pair: webcrypto.CryptoKeyPair, challenge: string, hash = "SHA-256") {
  return Buffer.from(await subtle.sign({ name: "ECDSA", hash }, pair.privateKey, Buffer.from(challenge, "base64url"))).toString("base64url");
}

/** What the installed app does when it scans an Enrollment QR. */
async function scanEnrollment(token: string, key: PhoneKey) {
  const start = startEnrollment(token);
  if (!start.ok) return { ok: false as const, problem: start.problem };
  return finishEnrollment({ token, challengeId: start.challengeId, publicKeySpki: key.spki, signature: await signB64(key.pair, start.challenge) });
}

/** What the installed app does when it scans the Normal Access QR. */
async function scanAccess(deviceId: string, key: PhoneKey) {
  const start = startAccess(deviceId);
  if (!start.ok) return { result: start.problem };
  return finishAccess({ deviceId, challengeId: start.challengeId, signature: await signB64(key.pair, start.challenge) });
}

beforeEach(() => {
  resetChallenges();
  resetRegistry();
  resetLoginFailures();
});

describe("the non-exportable key itself", () => {
  test("a private key made with extractable=false refuses export and wrapping", async () => {
    const { pair } = await phoneKey();
    assert.equal(pair.privateKey.extractable, false);
    await assert.rejects(subtle.exportKey("pkcs8", pair.privateKey));
    await assert.rejects(subtle.exportKey("jwk", pair.privateKey));
    const wrapping = await subtle.generateKey({ name: "AES-KW", length: 256 }, false, ["wrapKey"]);
    await assert.rejects(subtle.wrapKey("pkcs8", pair.privateKey, wrapping, "AES-KW"));
  });
});

describe("Enrollment QR", () => {
  test("scanning a fresh Enrollment QR creates DEVICE-001, APPROVED, holding the phone's public key", async () => {
    const { token, enrollment } = createEnrollment();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(enrollment.expiresAt - enrollment.createdAt, ENROLLMENT_TTL_MS);
    const phoneA = await phoneKey();
    const result = await scanEnrollment(token, phoneA);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.device.deviceId, "DEVICE-001");
    assert.equal(result.device.status, "APPROVED");
    assert.equal(result.device.fingerprint, phoneA.fingerprint);
    assert.equal(snapshot().enrollments[0]!.state, "used");
  });

  test("the same QR cannot be used again, by the same phone or another", async () => {
    const { token } = createEnrollment();
    assert.ok((await scanEnrollment(token, await phoneKey())).ok);
    assert.deepEqual(await scanEnrollment(token, await phoneKey()), { ok: false, problem: "used" });
    assert.deepEqual(startEnrollment(token), { ok: false, problem: "used" }, "refused before any key would be made");
    assert.equal(snapshot().devices.length, 1);
  });

  test("two phones scanning the same QR at once: exactly one becomes a device", async () => {
    const { token } = createEnrollment();
    const phones = await Promise.all(Array.from({ length: 6 }, () => phoneKey()));
    // Every phone gets past the first step before any finishes.
    const starts = phones.map(() => startEnrollment(token));
    assert.ok(starts.every((s) => s.ok));
    const finishes = await Promise.all(
      phones.map(async (p, i) => {
        const s = starts[i] as Extract<(typeof starts)[number], { ok: true }>;
        return finishEnrollment({ token, challengeId: s.challengeId, publicKeySpki: p.spki, signature: await signB64(p.pair, s.challenge) });
      }),
    );
    assert.equal(finishes.filter((f) => f.ok).length, 1);
    assert.equal(finishes.filter((f) => !f.ok && f.problem === "used").length, 5);
    assert.equal(snapshot().devices.length, 1);
  });

  test("an expired QR fails", async () => {
    const t0 = Date.now();
    const { token } = createEnrollment(t0);
    assert.deepEqual(startEnrollment(token, t0 + ENROLLMENT_TTL_MS + 1), { ok: false, problem: "expired" });
  });

  test("an unknown or malformed code fails", () => {
    assert.deepEqual(startEnrollment("x".repeat(43)), { ok: false, problem: "unknown" });
    assert.deepEqual(startEnrollment("nope"), { ok: false, problem: "unknown" });
  });

  test("enrollment needs proof of the private key: a signature by a different key is refused and the QR stays unused", async () => {
    const { token } = createEnrollment();
    const claimed = await phoneKey();
    const other = await phoneKey();
    const start = startEnrollment(token);
    assert.ok(start.ok);
    if (!start.ok) return;
    const result = finishEnrollment({ token, challengeId: start.challengeId, publicKeySpki: claimed.spki, signature: await signB64(other.pair, start.challenge) });
    assert.deepEqual(result, { ok: false, problem: "bad_proof", detail: "bad_signature" });
    assert.equal(snapshot().enrollments[0]!.state, "unused");
  });

  test("an enrollment challenge cannot be answered for a different enrollment", async () => {
    const a = createEnrollment();
    const b = createEnrollment();
    const key = await phoneKey();
    const start = startEnrollment(a.token);
    assert.ok(start.ok);
    if (!start.ok) return;
    const result = finishEnrollment({ token: b.token, challengeId: start.challengeId, publicKeySpki: key.spki, signature: await signB64(key.pair, start.challenge) });
    assert.deepEqual(result, { ok: false, problem: "bad_proof", detail: "wrong_subject" });
  });
});

describe("Normal Access QR", () => {
  test("after enrollment, the same stored key proves DEVICE-001 → APPROVED, as many times as needed", async () => {
    const { token } = createEnrollment();
    const phoneA = await phoneKey();
    assert.ok((await scanEnrollment(token, phoneA)).ok);
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await scanAccess("DEVICE-001", phoneA), { result: "approved", deviceId: "DEVICE-001" });
    assert.ok(snapshot().devices[0]!.lastVerifiedAt);
  });

  test("a phone that never enrolled cannot pass: unknown device, or another device's id without its key", async () => {
    const { token } = createEnrollment();
    const phoneA = await phoneKey();
    assert.ok((await scanEnrollment(token, phoneA)).ok);
    const phoneB = await phoneKey();
    assert.deepEqual(await scanAccess("DEVICE-404", phoneB), { result: "unknown_device" });
    assert.deepEqual(await scanAccess("DEVICE-001", phoneB), { result: "bad_proof", detail: "bad_signature" });
  });

  test("revocation: the key still signs validly, the server blocks; reinstating restores access", async () => {
    const { token } = createEnrollment();
    const phoneA = await phoneKey();
    assert.ok((await scanEnrollment(token, phoneA)).ok);
    setStatus("DEVICE-001", "REVOKED");
    assert.deepEqual(await scanAccess("DEVICE-001", phoneA), { result: "revoked", deviceId: "DEVICE-001", signatureValid: true });
    setStatus("DEVICE-001", "APPROVED");
    assert.deepEqual(await scanAccess("DEVICE-001", phoneA), { result: "approved", deviceId: "DEVICE-001" });
  });

  test("access is checked against the key registered at enrollment, not one the caller supplies", async () => {
    const { token } = createEnrollment();
    const phoneA = await phoneKey();
    assert.ok((await scanEnrollment(token, phoneA)).ok);
    const start = startAccess("DEVICE-001");
    assert.ok(start.ok);
    if (!start.ok) return;
    const attacker = await phoneKey();
    // finishAccess has no way to accept a key: the attacker's valid signature over its own key fails.
    assert.equal(finishAccess({ deviceId: "DEVICE-001", challengeId: start.challengeId, signature: await signB64(attacker.pair, start.challenge) }).result, "bad_proof");
  });
});

describe("challenges", () => {
  test("fresh, single-use (spent even by a failed attempt), short-lived", async () => {
    const key = await phoneKey();
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(issueChallenge("verify", key.fingerprint)!.challenge);
    assert.equal(seen.size, 100);

    const c = issueChallenge("verify", key.fingerprint)!;
    const good = { challengeId: c.challengeId, purpose: "verify" as const, subject: key.fingerprint, publicKeySpki: key.spki, signature: await signB64(key.pair, c.challenge) };
    assert.equal(verifyProof(good).ok, true);
    assert.deepEqual(verifyProof(good), { ok: false, reason: "unknown_or_used_challenge" }, "replay refused");

    const c2 = issueChallenge("verify", key.fingerprint)!;
    verifyProof({ ...good, challengeId: c2.challengeId, signature: "A".repeat(86) });
    assert.deepEqual(verifyProof({ ...good, challengeId: c2.challengeId, signature: await signB64(key.pair, c2.challenge) }), {
      ok: false,
      reason: "unknown_or_used_challenge",
    });

    const t0 = Date.now();
    const c3 = issueChallenge("verify", key.fingerprint, t0)!;
    assert.deepEqual(verifyProof({ ...good, challengeId: c3.challengeId, signature: await signB64(key.pair, c3.challenge) }, t0 + CHALLENGE_TTL_MS + 1), {
      ok: false,
      reason: "expired",
    });
  });

  test("only EC P-256 keys are accepted", async () => {
    const key = await phoneKey("P-384");
    const c = issueChallenge("verify", key.fingerprint)!;
    const result = verifyProof({ challengeId: c.challengeId, purpose: "verify", subject: key.fingerprint, publicKeySpki: key.spki, signature: await signB64(key.pair, c.challenge, "SHA-384") });
    assert.equal(result.ok, false);
  });
});

describe("the test routes", () => {
  const call = (action: string, json?: unknown, headers: Record<string, string> = {}) => {
    const req = new NextRequest(`https://pwa.test/api/pwa/device-crypto-test/${action}`, {
      method: json === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const ctx = { params: Promise.resolve({ action }) };
    return json === undefined ? GET(req, ctx) : POST(req, ctx);
  };

  test("the whole demo over the API: enroll, reuse refused, access, phone B blocked, revoke blocks", async () => {
    const created = (await (await call("enrollments", {})).json()) as { url: string; qrSvg: string; enrollmentId: string };
    assert.match(created.qrSvg, /^<svg/);
    const token = new URL(created.url).searchParams.get("enroll")!;
    const phoneA = await phoneKey();

    const s = (await (await call("enroll-start", { token })).json()) as { challengeId: string; challenge: string };
    const enrolled = await call("enroll-finish", { token, challengeId: s.challengeId, publicKeySpki: phoneA.spki, signature: await signB64(phoneA.pair, s.challenge) });
    assert.equal(enrolled.status, 200);
    assert.equal(((await enrolled.json()) as { deviceId: string }).deviceId, "DEVICE-001");
    assert.equal((await call("enroll-start", { token })).status, 410, "the QR is spent");

    const access = async (deviceId: string, key: PhoneKey) => {
      const a = await call("access-start", { deviceId });
      if (a.status !== 200) return a.status;
      const c = (await a.json()) as { challengeId: string; challenge: string };
      return (await call("access-finish", { deviceId, challengeId: c.challengeId, signature: await signB64(key.pair, c.challenge) })).status;
    };
    assert.equal(await access("DEVICE-001", phoneA), 200);
    assert.equal(await access("DEVICE-001", await phoneKey()), 403, "phone B with DEVICE-001's id but not its key");
    assert.equal(await access("DEVICE-002", await phoneKey()), 404, "phone B never enrolled");
    assert.equal((await call("revoke", { deviceId: "DEVICE-001" })).status, 200);
    assert.equal(await access("DEVICE-001", phoneA), 403);

    const state = (await (await call("state")).json()) as { enrollments: { state: string }[]; devices: { status: string }[] };
    assert.equal(state.enrollments[0]!.state, "used");
    assert.equal(state.devices[0]!.status, "REVOKED");
    const text = JSON.stringify(state);
    assert.ok(!text.includes(token), "no token in the admin state");
  });

  test("off unless DEVICE_CRYPTO_TEST=1, and same-origin only", async () => {
    assert.equal((await call("enrollments", {}, { "sec-fetch-site": "cross-site" })).status, 403);
    process.env.DEVICE_CRYPTO_TEST = "";
    try {
      assert.equal(testEnabled(), false);
      assert.equal((await call("enrollments", {})).status, 404);
      assert.equal((await call("state")).status, 404);
    } finally {
      process.env.DEVICE_CRYPTO_TEST = "1";
    }
  });
});
