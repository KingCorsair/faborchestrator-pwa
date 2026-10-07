/**
 * Device proof: challenges and signature checks (6 October 2026).
 *
 * The device stamp is `DEVICE-nnn` plus an ECDSA P-256 private key that the
 * device generated itself with Web Crypto, non-extractable, kept in its own
 * IndexedDB (`lib/devices/keystore.ts`). This server holds only the public key
 * (`lib/devices/store.ts`). A device proves itself by signing a challenge from
 * here:
 *
 *  - 32 bytes from `crypto.randomBytes`, valid for `CHALLENGE_TTL_MS`;
 *  - usable **once**: taken out of the map before anything is checked, so a
 *    failed attempt spends it too and a replayed signature is refused;
 *  - bound to one purpose (`enroll` or `sign-in`) and one subject (the
 *    enrollment being used, or the device signing in), so a proof for one
 *    cannot be spent on another.
 *
 * Signatures are Web Crypto's format (IEEE P1363, r‖s), checked with Node's
 * `crypto.verify`, against an EC P-256 key only.
 *
 * In memory, bounded, shared by every module instance in this process (one
 * machine, like the device store). A restart forgets open challenges, which
 * costs a device one retry.
 */

import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";

export const CHALLENGE_TTL_MS = 60_000;
const MAX_OPEN = 5_000;

export type ChallengePurpose = "enroll" | "sign-in";

interface OpenChallenge {
  bytes: Buffer;
  purpose: ChallengePurpose;
  subject: string;
  expiresAt: number;
}

const KEY = Symbol.for("faborch.pwa.device-challenges");
function open(): Map<string, OpenChallenge> {
  const holder = globalThis as unknown as Record<symbol, Map<string, OpenChallenge> | undefined>;
  return (holder[KEY] ??= new Map());
}

/** A public key as SPKI DER, base64url. */
export const PUBLIC_KEY_SPKI = /^[A-Za-z0-9_-]{80,400}$/;

/** SHA-256 of the SPKI DER, first 16 bytes, hex: a public identifier for a key. */
export function keyFingerprint(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
}

/** The key, if this is an EC P-256 public key in SPKI form; otherwise null. */
export function decodePublicKey(spkiBase64url: string): { der: Buffer; key: KeyObject; fingerprint: string } | null {
  if (!PUBLIC_KEY_SPKI.test(spkiBase64url)) return null;
  const der = Buffer.from(spkiBase64url, "base64url");
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return { der, key, fingerprint: keyFingerprint(der) };
  } catch {
    return null;
  }
}

function sweep(map: Map<string, OpenChallenge>, now: number): void {
  for (const [id, c] of map) if (c.expiresAt <= now) map.delete(id);
}

export function issueChallenge(
  purpose: ChallengePurpose,
  subject: string,
  now: number = Date.now(),
): { challengeId: string; challenge: string; expiresAt: number } | null {
  const map = open();
  sweep(map, now);
  if (map.size >= MAX_OPEN) return null;
  const challengeId = randomBytes(16).toString("base64url");
  const bytes = randomBytes(32);
  const expiresAt = now + CHALLENGE_TTL_MS;
  map.set(challengeId, { bytes, purpose, subject, expiresAt });
  return { challengeId, challenge: bytes.toString("base64url"), expiresAt };
}

export type ProofFailure =
  | "unknown_or_used_challenge"
  | "expired"
  | "wrong_purpose"
  | "wrong_subject"
  | "bad_key"
  | "bad_signature";

/**
 * Check one proof against the public key the caller trusts for `subject`. The
 * challenge is spent whatever the outcome.
 */
export function verifyProof(
  input: { challengeId: string; purpose: ChallengePurpose; subject: string; publicKeySpki: string; signature: string },
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: ProofFailure } {
  const map = open();
  const challenge = map.get(input.challengeId);
  map.delete(input.challengeId);
  if (!challenge) return { ok: false, reason: "unknown_or_used_challenge" };
  if (challenge.expiresAt <= now) return { ok: false, reason: "expired" };
  if (challenge.purpose !== input.purpose) return { ok: false, reason: "wrong_purpose" };
  if (challenge.subject !== input.subject) return { ok: false, reason: "wrong_subject" };
  const decoded = decodePublicKey(input.publicKeySpki);
  if (!decoded) return { ok: false, reason: "bad_key" };
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(input.signature)) return { ok: false, reason: "bad_signature" };
  const valid = verify("sha256", challenge.bytes, { key: decoded.key, dsaEncoding: "ieee-p1363" }, Buffer.from(input.signature, "base64url"));
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** Testing seam. */
export function resetDeviceChallenges(): void {
  open().clear();
}
