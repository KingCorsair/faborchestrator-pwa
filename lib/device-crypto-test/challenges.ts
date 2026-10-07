/**
 * Device-credential feasibility test: the server half (6 October 2026).
 *
 * **Not the enrollment system.** This is an isolated test of the candidate
 * "device stamp" for Jothi's Option 2: a non-exportable ECDSA P-256 private key
 * that the installed PWA generates and keeps in its own IndexedDB, proved by
 * signing a fresh server challenge. It touches no device store and approves
 * nothing; it answers only "would the production check work with what this
 * browser produces?".
 *
 * What it does exactly as production would:
 *  - challenges are 32 bytes from `crypto.randomBytes`, valid for 60 seconds,
 *    usable **once** (taken out of the map before verification, so a replay of
 *    the same signature is refused), and bound to one claimed public key and
 *    one purpose;
 *  - the signature is checked with Node's `crypto.verify` over the challenge
 *    bytes, in the format Web Crypto produces (IEEE P1363, r‖s), against a
 *    public key that must be an EC P-256 key.
 *
 * What it does not do: remember devices. The browser sends its public key with
 * each proof and the page compares fingerprints with the one it recorded when
 * the key was made; a production store would hold the public key instead.
 *
 * Enabled only with `DEVICE_CRYPTO_TEST=1` (`testEnabled`). In memory, bounded.
 */

import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";

export const TEST_FLAG_ENV = "DEVICE_CRYPTO_TEST";

export function testEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TEST_FLAG_ENV]?.trim() === "1";
}

export const CHALLENGE_TTL_MS = 60_000;
const MAX_OPEN = 1_000;

export type Purpose = "enroll" | "verify";

interface OpenChallenge {
  bytes: Buffer;
  purpose: Purpose;
  /** Fingerprint of the public key this challenge may be answered by. */
  keyFingerprint: string;
  expiresAt: number;
}

const open = new Map<string, OpenChallenge>();

/** SHA-256 of the SPKI DER, first 16 bytes, hex: a safe, public identifier for a key. */
export function keyFingerprint(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
}

export function decodeSpki(spkiBase64url: string): { der: Buffer; key: KeyObject } | null {
  if (!/^[A-Za-z0-9_-]{40,400}$/.test(spkiBase64url)) return null;
  const der = Buffer.from(spkiBase64url, "base64url");
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return { der, key };
  } catch {
    return null;
  }
}

function sweep(now: number): void {
  for (const [id, c] of open) if (c.expiresAt <= now) open.delete(id);
}

/** Issue a challenge for one key and one purpose. */
export function issueChallenge(
  purpose: Purpose,
  claimedFingerprint: string,
  now: number = Date.now(),
): { challengeId: string; challenge: string; expiresAt: number } | null {
  if (!/^[0-9a-f]{32}$/.test(claimedFingerprint)) return null;
  sweep(now);
  if (open.size >= MAX_OPEN) return null;
  const challengeId = randomBytes(16).toString("base64url");
  const bytes = randomBytes(32);
  const expiresAt = now + CHALLENGE_TTL_MS;
  open.set(challengeId, { bytes, purpose, keyFingerprint: claimedFingerprint, expiresAt });
  return { challengeId, challenge: bytes.toString("base64url"), expiresAt };
}

export type VerifyResult =
  | { ok: true; fingerprint: string; purpose: Purpose }
  | {
      ok: false;
      reason: "unknown_or_used_challenge" | "expired" | "wrong_purpose" | "bad_key" | "key_mismatch" | "bad_signature";
    };

/**
 * Check one proof. The challenge is removed **before** anything else is
 * checked, so whatever the outcome it can never be answered again.
 */
export function verifyProof(
  input: { challengeId: string; purpose: Purpose; publicKeySpki: string; signature: string },
  now: number = Date.now(),
): VerifyResult {
  const challenge = open.get(input.challengeId);
  open.delete(input.challengeId);
  if (!challenge) return { ok: false, reason: "unknown_or_used_challenge" };
  if (challenge.expiresAt <= now) return { ok: false, reason: "expired" };
  if (challenge.purpose !== input.purpose) return { ok: false, reason: "wrong_purpose" };

  const decoded = decodeSpki(input.publicKeySpki);
  if (!decoded) return { ok: false, reason: "bad_key" };
  const fingerprint = keyFingerprint(decoded.der);
  if (fingerprint !== challenge.keyFingerprint) return { ok: false, reason: "key_mismatch" };

  if (!/^[A-Za-z0-9_-]{80,100}$/.test(input.signature)) return { ok: false, reason: "bad_signature" };
  const signature = Buffer.from(input.signature, "base64url");
  const valid = verify("sha256", challenge.bytes, { key: decoded.key, dsaEncoding: "ieee-p1363" }, signature);
  return valid ? { ok: true, fingerprint, purpose: challenge.purpose } : { ok: false, reason: "bad_signature" };
}

/** Testing seam. */
export function resetChallenges(): void {
  open.clear();
}
