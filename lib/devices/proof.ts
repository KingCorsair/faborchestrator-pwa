/**
 * A device's sign-in proof (6 October 2026): `DEVICE-nnn`, a challenge id from
 * `/api/pwa/device-auth/challenge`, and the device's signature over it.
 *
 * Verified against the public key **registered at enrollment** (never a key the
 * caller supplies), then the device's status decides: a revoked device's valid
 * signature still proves which device it is, and is still refused.
 */

import { verifyProof, type ProofFailure } from "./challenges";
import type { Device, DeviceStore } from "./store";

export interface DeviceProof {
  deviceId: string;
  challengeId: string;
  signature: string;
}

export type ProofCheck =
  | { ok: true; device: Device }
  | { ok: false; reason: "unknown_device" | "revoked" | ProofFailure; deviceId: string };

export async function verifyDeviceSignIn(proof: DeviceProof, store: DeviceStore, now: number = Date.now()): Promise<ProofCheck> {
  const publicKey = await store.publicKeyOf(proof.deviceId);
  const device = publicKey ? await store.getDevice(proof.deviceId) : null;
  if (!publicKey || !device) return { ok: false, reason: "unknown_device", deviceId: proof.deviceId };
  const verdict = verifyProof(
    { challengeId: proof.challengeId, purpose: "sign-in", subject: proof.deviceId, publicKeySpki: publicKey, signature: proof.signature },
    now,
  );
  if (!verdict.ok) return { ok: false, reason: verdict.reason, deviceId: proof.deviceId };
  if (device.status !== "APPROVED") return { ok: false, reason: "revoked", deviceId: proof.deviceId };
  return { ok: true, device };
}
