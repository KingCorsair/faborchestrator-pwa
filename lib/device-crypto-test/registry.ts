/**
 * The feasibility test's own enrollment and device registry (6 October 2026).
 *
 * A stand-in for the production device store, **isolated from it**: in memory,
 * in this process, gone on restart, never written to `DEVICE_STORE_PATH`. It
 * models Jothi's Option 2 with the Web Crypto device stamp end to end so the QR
 * workflow can be shown on a real phone:
 *
 *   createEnrollment     one-time code (256 bits, stored as SHA-256), 10 min
 *   startEnrollment      the code is checked **before** the phone makes a key;
 *                        a challenge bound to this enrollment is issued
 *   finishEnrollment     the phone's signature over that challenge, with the
 *                        public key it just made, proves it holds the private
 *                        key; the enrollment is consumed (check-and-set in one
 *                        synchronous step, so of two racing phones exactly one
 *                        wins) and DEVICE-nnn is created APPROVED with that key
 *   startAccess          a challenge bound to DEVICE-nnn
 *   finishAccess         verified against the public key **stored at
 *                        enrollment**, never one the caller supplies; then the
 *                        device's status decides: APPROVED passes, REVOKED is
 *                        blocked even though the signature is valid
 *
 * Cryptography proves which device this is; server state decides whether it
 * may enter.
 */

import { createHash, randomBytes } from "node:crypto";
import { decodeSpki, issueChallenge, keyFingerprint, verifyProof } from "./challenges";

export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

export interface TestEnrollment {
  enrollmentId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  deviceId: string | null;
}

export interface TestDevice {
  deviceId: string;
  publicKeySpki: string;
  fingerprint: string;
  status: "APPROVED" | "REVOKED";
  enrollmentId: string;
  createdAt: number;
  lastVerifiedAt: number | null;
  revokedAt: number | null;
}

interface State {
  enrollments: Map<string, TestEnrollment>;
  byHash: Map<string, string>;
  devices: Map<string, TestDevice>;
  seq: number;
}

const KEY = Symbol.for("faborch.pwa.device-crypto-test.registry");
function state(): State {
  const holder = globalThis as unknown as Record<symbol, State | undefined>;
  return (holder[KEY] ??= { enrollments: new Map(), byHash: new Map(), devices: new Map(), seq: 0 });
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash("sha256").update(token).digest("base64url");

/** Testing seam. */
export function resetRegistry(): void {
  const s = state();
  s.enrollments.clear();
  s.byHash.clear();
  s.devices.clear();
  s.seq = 0;
}

/* ── Enrollment ────────────────────────────────────────────────────────────── */

export function createEnrollment(now: number = Date.now()): { enrollment: TestEnrollment; token: string } {
  const s = state();
  const token = randomBytes(32).toString("base64url");
  const enrollment: TestEnrollment = {
    enrollmentId: `tenr_${randomBytes(9).toString("base64url")}`,
    tokenHash: hash(token),
    createdAt: now,
    expiresAt: now + ENROLLMENT_TTL_MS,
    usedAt: null,
    deviceId: null,
  };
  s.enrollments.set(enrollment.enrollmentId, enrollment);
  s.byHash.set(enrollment.tokenHash, enrollment.enrollmentId);
  return { enrollment, token };
}

export type EnrollmentProblem = "unknown" | "expired" | "used";

function usableEnrollment(token: string, now: number): TestEnrollment | EnrollmentProblem {
  if (!TOKEN.test(token)) return "unknown";
  const id = state().byHash.get(hash(token));
  const enrollment = id ? state().enrollments.get(id) : undefined;
  if (!enrollment) return "unknown";
  if (enrollment.usedAt !== null) return "used";
  if (enrollment.expiresAt <= now) return "expired";
  return enrollment;
}

/** Step 1: is this code still usable? If so, a challenge bound to this enrollment. */
export function startEnrollment(
  token: string,
  now: number = Date.now(),
): { ok: true; challengeId: string; challenge: string; enrollmentId: string } | { ok: false; problem: EnrollmentProblem } {
  const enrollment = usableEnrollment(token, now);
  if (typeof enrollment === "string") return { ok: false, problem: enrollment };
  const challenge = issueChallenge("enroll", enrollment.enrollmentId, now);
  if (!challenge) return { ok: false, problem: "unknown" };
  return { ok: true, challengeId: challenge.challengeId, challenge: challenge.challenge, enrollmentId: enrollment.enrollmentId };
}

export type FinishEnrollment =
  | { ok: true; device: TestDevice }
  | { ok: false; problem: EnrollmentProblem | "bad_proof"; detail?: string };

/**
 * Step 2: the phone proves it holds the private key for `publicKeySpki` by
 * signing the enrollment challenge. Then, in one synchronous step, the
 * enrollment is consumed and the device created.
 */
export function finishEnrollment(
  input: { token: string; challengeId: string; publicKeySpki: string; signature: string },
  now: number = Date.now(),
): FinishEnrollment {
  const before = usableEnrollment(input.token, now);
  if (typeof before === "string") return { ok: false, problem: before };
  const proof = verifyProof({
    challengeId: input.challengeId,
    purpose: "enroll",
    subject: before.enrollmentId,
    publicKeySpki: input.publicKeySpki,
    signature: input.signature,
  }, now);
  if (!proof.ok) return { ok: false, problem: "bad_proof", detail: proof.reason };

  // Check-and-set, with no await in between: exactly one caller can pass here.
  const enrollment = usableEnrollment(input.token, now);
  if (typeof enrollment === "string") return { ok: false, problem: enrollment };
  const s = state();
  s.seq += 1;
  const deviceId = `DEVICE-${String(s.seq).padStart(3, "0")}`;
  enrollment.usedAt = now;
  enrollment.deviceId = deviceId;
  const device: TestDevice = {
    deviceId,
    publicKeySpki: input.publicKeySpki,
    fingerprint: keyFingerprint(decodeSpki(input.publicKeySpki)!.der),
    status: "APPROVED",
    enrollmentId: enrollment.enrollmentId,
    createdAt: now,
    lastVerifiedAt: null,
    revokedAt: null,
  };
  s.devices.set(deviceId, device);
  return { ok: true, device };
}

/* ── Everyday access ───────────────────────────────────────────────────────── */

export function startAccess(
  deviceId: string,
  now: number = Date.now(),
): { ok: true; challengeId: string; challenge: string } | { ok: false; problem: "unknown_device" } {
  if (!state().devices.has(deviceId)) return { ok: false, problem: "unknown_device" };
  // Issued for revoked devices too: the proof says who it is, the status decides.
  const challenge = issueChallenge("verify", deviceId, now);
  return challenge ? { ok: true, challengeId: challenge.challengeId, challenge: challenge.challenge } : { ok: false, problem: "unknown_device" };
}

export type AccessResult =
  | { result: "approved"; deviceId: string }
  | { result: "revoked"; deviceId: string; signatureValid: true }
  | { result: "unknown_device" }
  | { result: "bad_proof"; detail: string };

export function finishAccess(
  input: { deviceId: string; challengeId: string; signature: string },
  now: number = Date.now(),
): AccessResult {
  const device = state().devices.get(input.deviceId);
  if (!device) return { result: "unknown_device" };
  const proof = verifyProof({
    challengeId: input.challengeId,
    purpose: "verify",
    subject: device.deviceId,
    publicKeySpki: device.publicKeySpki, // the key registered at enrollment
    signature: input.signature,
  }, now);
  if (!proof.ok) return { result: "bad_proof", detail: proof.reason };
  if (device.status !== "APPROVED") return { result: "revoked", deviceId: device.deviceId, signatureValid: true };
  device.lastVerifiedAt = now;
  return { result: "approved", deviceId: device.deviceId };
}

/* ── Test admin ────────────────────────────────────────────────────────────── */

export function setStatus(deviceId: string, status: "APPROVED" | "REVOKED", now: number = Date.now()): TestDevice | null {
  const device = state().devices.get(deviceId);
  if (!device) return null;
  device.status = status;
  device.revokedAt = status === "REVOKED" ? now : null;
  return device;
}

/** Everything the admin panel shows. No token, no hash. */
export function snapshot(now: number = Date.now()) {
  const s = state();
  return {
    now,
    enrollments: [...s.enrollments.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map((e) => ({
        enrollmentId: e.enrollmentId,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
        state: e.usedAt !== null ? "used" : e.expiresAt <= now ? "expired" : "unused",
        deviceId: e.deviceId,
      })),
    devices: [...s.devices.values()].map((d) => ({
      deviceId: d.deviceId,
      status: d.status,
      fingerprint: d.fingerprint,
      enrollmentId: d.enrollmentId,
      createdAt: d.createdAt,
      lastVerifiedAt: d.lastVerifiedAt,
      revokedAt: d.revokedAt,
    })),
  };
}
