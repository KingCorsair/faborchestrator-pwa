/**
 * A credential's proof (6 October 2026; credential-aware since 9 October):
 * `DEVICE-nnn`, the credential (the key) that is proving itself, a challenge id
 * from `/api/pwa/device-auth/challenge`, and that key's signature over it.
 *
 * Verified against the public key **the store holds for that credential**
 * (never a key the caller supplies). Then status decides: a revoked device's
 * valid signature still proves which device it is, and is still refused; so is
 * a credential that was revoked or superseded on a device that is approved.
 *
 * A proof that names no credential is the device's ROOT: pages loaded before
 * credentials existed send only `deviceId`, and every device then had one key.
 */

import { verifyProof, type ProofFailure } from "./challenges";
import type { Credential, Device, DeviceStore } from "./store";

export interface DeviceProof {
  deviceId: string;
  credentialId?: string;
  challengeId: string;
  signature: string;
}

export type ProofRefusal =
  | "unknown_device"
  /** The device is waiting for an administrator's approval (14 October 2026). */
  | "pending"
  /** The device is revoked, or its request was rejected: every credential under it is refused. */
  | "revoked"
  /** The device is approved, but this credential was revoked or replaced by a newer install. */
  | "credential_revoked"
  | "credential_superseded"
  | ProofFailure;

export type ProofCheck =
  | { ok: true; device: Device; credential: Credential }
  | { ok: false; reason: ProofRefusal; deviceId: string; credentialId?: string };

/**
 * Check one proof for one purpose: `sign-in`, or `grant` (a ROOT asking for an
 * install grant; that it is a ROOT is the caller's check). The challenge is
 * bound to the credential, so one credential's signature answers no other's.
 */
export async function verifyCredentialProof(
  proof: DeviceProof,
  purpose: "sign-in" | "grant",
  store: DeviceStore,
  now: number = Date.now(),
): Promise<ProofCheck> {
  const credential = await store.resolveCredential(proof.deviceId, proof.credentialId);
  const device = credential ? await store.getDevice(proof.deviceId) : null;
  if (!credential || !device) return { ok: false, reason: "unknown_device", deviceId: proof.deviceId, credentialId: proof.credentialId };
  const named = { deviceId: proof.deviceId, credentialId: credential.credentialId };
  const verdict = verifyProof(
    {
      challengeId: proof.challengeId,
      purpose,
      subject: credential.credentialId,
      publicKeySpki: credential.publicKeySpki,
      signature: proof.signature,
    },
    now,
  );
  if (!verdict.ok) return { ok: false, reason: verdict.reason, ...named };
  if (device.status === "PENDING") return { ok: false, reason: "pending", ...named };
  if (device.status !== "APPROVED") return { ok: false, reason: "revoked", ...named };
  if (credential.status !== "ACTIVE") {
    return { ok: false, reason: credential.status === "SUPERSEDED" ? "credential_superseded" : "credential_revoked", ...named };
  }
  return { ok: true, device, credential };
}

export function verifyDeviceSignIn(proof: DeviceProof, store: DeviceStore, now: number = Date.now()): Promise<ProofCheck> {
  return verifyCredentialProof(proof, "sign-in", store, now);
}
