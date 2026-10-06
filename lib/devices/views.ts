/**
 * What the administration API shows of a device or an enrollment. Built field
 * by field so that nothing new on the store's types (a hash, say) can reach a
 * response by being spread into it.
 */

import type { Device, Enrollment } from "./store";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function deviceView(d: Device) {
  return {
    deviceId: d.deviceId,
    friendlyName: d.friendlyName,
    userId: d.userId,
    email: d.email,
    status: d.status,
    deviceType: d.deviceType,
    os: d.os,
    browser: d.browser,
    context: d.context,
    site: d.site,
    createdBy: d.createdBy,
    createdAt: iso(d.createdAt),
    lastSeenAt: iso(d.lastSeenAt),
    revokedAt: iso(d.revokedAt),
    revokedBy: d.revokedBy,
    revokeReason: d.revokeReason,
  };
}

export type DeviceView = ReturnType<typeof deviceView>;

export function enrollmentView(e: Enrollment) {
  return {
    enrollmentId: e.enrollmentId,
    email: e.allowedEmail,
    site: e.site,
    friendlyName: e.friendlyName,
    createdBy: e.createdBy,
    createdAt: iso(e.createdAt),
    expiresAt: iso(e.expiresAt),
  };
}

export type EnrollmentView = ReturnType<typeof enrollmentView>;
