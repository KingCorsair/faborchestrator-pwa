/**
 * Security events for device enrollment, as `device_audit` log lines.
 *
 * The durable record of enrollments and revocations is the device store itself
 * (`lib/devices/store.ts`), which names who did what. These lines are the same
 * events in the log stream, plus the ones the store does not keep (blocked and
 * allowed requests, rejected enrollments). **No token, hash or cookie value is
 * ever passed here**: identifiers only.
 */

import { logEvent } from "@/lib/report-error";

export type DeviceAuditAction =
  | "DEVICE_ENROLLMENT_CREATED"
  | "DEVICE_ENROLLMENT_REJECTED"
  | "DEVICE_ENROLLED"
  | "DEVICE_REENROLLED"
  | "DEVICE_ACCESS_ALLOWED"
  | "DEVICE_ACCESS_BLOCKED"
  | "DEVICE_REVOKED"
  | "DEVICE_LOGIN_REFUSED";

export interface DeviceAuditDetail {
  deviceId?: string | null;
  previousDeviceId?: string | null;
  enrollmentId?: string | null;
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

export function deviceAudit(action: DeviceAuditAction, detail: DeviceAuditDetail = {}): void {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(detail)) if (typeof value === "string" && value) clean[key] = value;
  logEvent(action === "DEVICE_ACCESS_BLOCKED" || action === "DEVICE_ENROLLMENT_REJECTED" ? "warn" : "info", "device_audit", {
    action,
    ...clean,
  });
}
