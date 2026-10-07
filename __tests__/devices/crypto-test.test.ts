/**
 * The device-credential feasibility test's server half
 * (`lib/device-crypto-test/challenges.ts`): what a production challenge-response
 * check would have to do with a Web Crypto ECDSA P-256 signature. Keys here are
 * made with Node's Web Crypto, non-extractable, exactly as the browser makes
 * them, so the signature format (IEEE P1363, r‖s) is the browser's.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

process.env.DEVICE_CRYPTO_TEST = "1";

import { NextRequest } from "next/server";
import {
  CHALLENGE_TTL_MS,
  issueChallenge,
  keyFingerprint,
  resetChallenges,
  testEnabled,
  verifyProof,
} from "@/lib/device-crypto-test/challenges";
import { POST as CHALLENGE } from "@/app/api/pwa/device-crypto-test/challenge/route";
import { POST as VERIFY } from "@/app/api/pwa/device-crypto-test/verify/route";

const subtle = webcrypto.subtle;

async function device(curve: "P-256" | "P-384" = "P-256") {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: curve }, false, ["sign", "verify"]);
  const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey));
  return { pair, spki: spki.toString("base64url"), fingerprint: keyFingerprint(spki) };
}

async function signB64(pair: webcrypto.CryptoKeyPair, challenge: string, hash = "SHA-256") {
  const sig = await subtle.sign({ name: "ECDSA", hash }, pair.privateKey, Buffer.from(challenge, "base64url"));
  return Buffer.from(sig).toString("base64url");
}

beforeEach(() => resetChallenges());

describe("the non-exportable key itself", () => {
  test("a private key made with extractable=false refuses export in every format", async () => {
    const { pair } = await device();
    assert.equal(pair.privateKey.extractable, false);
    await assert.rejects(subtle.exportKey("pkcs8", pair.privateKey));
    await assert.rejects(subtle.exportKey("jwk", pair.privateKey));
    // A non-exportable key cannot be wrapped either: wrapping is export.
    const wrapping = await subtle.generateKey({ name: "AES-KW", length: 256 }, false, ["wrapKey"]);
    await assert.rejects(subtle.wrapKey("pkcs8", pair.privateKey, wrapping, "AES-KW"));
  });
});

describe("challenge-response", () => {
  test("a fresh challenge signed by the claimed key verifies with Node's crypto", async () => {
    const d = await device();
    const c = issueChallenge("verify", d.fingerprint)!;
    assert.equal(Buffer.from(c.challenge, "base64url").length, 32);
    const result = verifyProof({ challengeId: c.challengeId, purpose: "verify", publicKeySpki: d.spki, signature: await signB64(d.pair, c.challenge) });
    assert.deepEqual(result, { ok: true, fingerprint: d.fingerprint, purpose: "verify" });
  });

  test("every challenge is different", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(issueChallenge("verify", "a".repeat(32))!.challenge);
    assert.equal(seen.size, 200);
  });

  test("a used challenge cannot be answered again: the same signature replayed is refused", async () => {
    const d = await device();
    const c = issueChallenge("verify", d.fingerprint)!;
    const proof = { challengeId: c.challengeId, purpose: "verify" as const, publicKeySpki: d.spki, signature: await signB64(d.pair, c.challenge) };
    assert.equal(verifyProof(proof).ok, true);
    assert.deepEqual(verifyProof(proof), { ok: false, reason: "unknown_or_used_challenge" });
  });

  test("a failed attempt also spends the challenge (no retries against one challenge)", async () => {
    const d = await device();
    const c = issueChallenge("verify", d.fingerprint)!;
    assert.equal(verifyProof({ challengeId: c.challengeId, purpose: "verify", publicKeySpki: d.spki, signature: "A".repeat(86) }).ok, false);
    const good = await signB64(d.pair, c.challenge);
    assert.deepEqual(verifyProof({ challengeId: c.challengeId, purpose: "verify", publicKeySpki: d.spki, signature: good }), {
      ok: false,
      reason: "unknown_or_used_challenge",
    });
  });

  test("an expired challenge is refused", async () => {
    const d = await device();
    const t0 = Date.now();
    const c = issueChallenge("verify", d.fingerprint, t0)!;
    const proof = { challengeId: c.challengeId, purpose: "verify" as const, publicKeySpki: d.spki, signature: await signB64(d.pair, c.challenge) };
    assert.deepEqual(verifyProof(proof, t0 + CHALLENGE_TTL_MS + 1), { ok: false, reason: "expired" });
  });

  test("a challenge is bound to one key: another device's valid signature is refused", async () => {
    const a = await device();
    const b = await device();
    const c = issueChallenge("verify", a.fingerprint)!;
    const result = verifyProof({ challengeId: c.challengeId, purpose: "verify", publicKeySpki: b.spki, signature: await signB64(b.pair, c.challenge) });
    assert.deepEqual(result, { ok: false, reason: "key_mismatch" });
  });

  test("a challenge is bound to one purpose", async () => {
    const d = await device();
    const c = issueChallenge("enroll", d.fingerprint)!;
    const result = verifyProof({ challengeId: c.challengeId, purpose: "verify", publicKeySpki: d.spki, signature: await signB64(d.pair, c.challenge) });
    assert.deepEqual(result, { ok: false, reason: "wrong_purpose" });
  });

  test("a signature over different bytes, or a tampered one, is refused", async () => {
    const d = await device();
    const c = issueChallenge("verify", d.fingerprint)!;
    const other = await signB64(d.pair, Buffer.alloc(32, 7).toString("base64url"));
    assert.deepEqual(verifyProof({ challengeId: c.challengeId, purpose: "verify", publicKeySpki: d.spki, signature: other }), {
      ok: false,
      reason: "bad_signature",
    });
  });

  test("only EC P-256 public keys are accepted", async () => {
    const d = await device("P-384");
    const c = issueChallenge("verify", d.fingerprint)!;
    const result = verifyProof({ challengeId: c.challengeId, purpose: "verify", publicKeySpki: d.spki, signature: await signB64(d.pair, c.challenge, "SHA-384") });
    assert.equal(result.ok, false);
  });
});

describe("the test routes", () => {
  const post = (path: string, json: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`https://pwa.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
      body: JSON.stringify(json),
    });

  test("round trip over the routes, then the replay is refused", async () => {
    const d = await device();
    const c = (await (await CHALLENGE(post("/api/pwa/device-crypto-test/challenge", { purpose: "verify", keyFingerprint: d.fingerprint }))).json()) as {
      challengeId: string;
      challenge: string;
    };
    const proof = { challengeId: c.challengeId, purpose: "verify", publicKeySpki: d.spki, signature: await signB64(d.pair, c.challenge) };
    assert.equal((await VERIFY(post("/api/pwa/device-crypto-test/verify", proof))).status, 200);
    assert.equal((await VERIFY(post("/api/pwa/device-crypto-test/verify", proof))).status, 401);
  });

  test("off unless DEVICE_CRYPTO_TEST=1, and same-origin only", async () => {
    assert.equal((await CHALLENGE(post("/api/pwa/device-crypto-test/challenge", {}, { "sec-fetch-site": "cross-site" }))).status, 403);
    process.env.DEVICE_CRYPTO_TEST = "";
    try {
      assert.equal(testEnabled(), false);
      assert.equal((await CHALLENGE(post("/api/pwa/device-crypto-test/challenge", {}))).status, 404);
      assert.equal((await VERIFY(post("/api/pwa/device-crypto-test/verify", {}))).status, 404);
    } finally {
      process.env.DEVICE_CRYPTO_TEST = "1";
    }
  });
});
