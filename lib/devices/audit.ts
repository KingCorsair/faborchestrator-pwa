/**
 * Security events for device enrollment, as `device_audit` log lines.
 *
 * The durable record of enrollments, attached credentials and revocations is
 * the device store itself (`lib/devices/store.ts`), which names who did what.
 * These lines are the same events in the log stream, plus the ones the store
 * does not keep (blocked and allowed requests, rejected enrollments, refused
 * install grants). **No token, code, hash or cookie value is ever passed
 * here**: identifiers only.
 */

import { logEvent } from "@/lib/report-error";

export type DeviceAuditAction =
  | "DEVICE_ENROLLMENT_CREATED"
  | "DEVICE_ENROLLMENT_REJECTED"
  | "DEVICE_ENROLLED"
  /** A QR was used: the device is PENDING an administrator's approval. */
  | "DEVICE_APPROVAL_REQUESTED"
  | "DEVICE_APPROVED"
  /** An administrator refused a PENDING device's request. */
  | "DEVICE_REJECTED"
  | "DEVICE_REENROLLED"
  | "DEVICE_ACCESS_ALLOWED"
  | "DEVICE_ACCESS_BLOCKED"
  | "DEVICE_REVOKED"
  | "DEVICE_LOGIN_REFUSED"
  /** A ROOT credential proved itself and was given an install grant. */
  | "INSTALL_GRANT_ISSUED"
  /** A grant was asked for, or presented, and refused. */
  | "INSTALL_GRANT_REJECTED"
  /** An installed app's key was attached to a device with an install grant. */
  | "CREDENTIAL_ATTACHED"
  /** That attachment replaced an earlier installed-app credential of the same device. */
  | "CREDENTIAL_SUPERSEDED"
  | "CREDENTIAL_REVOKED";

export interface DeviceAuditDetail {
  deviceId?: string | null;
  previousDeviceId?: string | null;
  /** A credential's id is its public key's fingerprint: public. */
  credentialId?: string | null;
  /** The ROOT credential an attached credential came from, or the credential that superseded this one. */
  relatedCredentialId?: string | null;
  enrollmentId?: string | null;
  grantId?: string | null;
  /** The FabOrchestrator user, where one is involved (sign-in on a device). Devices belong to no user. */
  userId?: string | null;
  site?: string | null;
  /** Who performed it: an administrator's email, or `self` when a device's own re-enrollment replaced it. */
  actor?: string | null;
  reason?: string | null;
  /** `document`, `api` or `asset`; never the path, which may carry an id. */
  requestKind?: string | null;
  address?: string | null;
  expiresAt?: string | null;
}

const WARN: ReadonlySet<DeviceAuditAction> = new Set(["DEVICE_ACCESS_BLOCKED", "DEVICE_ENROLLMENT_REJECTED", "INSTALL_GRANT_REJECTED"]);

export function deviceAudit(action: DeviceAuditAction, detail: DeviceAuditDetail = {}): void {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(detail)) if (typeof value === "string" && value) clean[key] = value;
  logEvent(WARN.has(action) ? "warn" : "info", "device_audit", {
    action,
    ...clean,
  });
}
