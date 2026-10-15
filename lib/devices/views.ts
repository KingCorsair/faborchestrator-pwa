/**
 * What the administration API shows of a device, a credential or an
 * enrollment. Built field by field so that nothing new on the store's types (a
 * hash, say) can reach a response by being spread into it.
 */

import { edgeLocation } from "./origin";
import type { Credential, Device, Enrollment, Origin } from "./store";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Where a request came from, for the administrator. Each field is descriptive only (`lib/devices/origin.ts`). */
function originView(o: Origin | null) {
  if (!o) return null;
  return {
    ip: o.ip,
    edge: o.edge,
    /** The edge region as a place: the data centre the request came in by, not the device's location. */
    edgeLocation: edgeLocation(o.edge),
    userAgent: o.userAgent,
    timeZone: o.timeZone,
    language: o.language,
  };
}

export type OriginView = NonNullable<ReturnType<typeof originView>>;

/**
 * One of a device's keys. `credentialId` is the key's fingerprint, which is
 * public; the public key itself is not shown (nothing needs it).
 */
export function credentialView(c: Credential) {
  return {
    credentialId: c.credentialId,
    /** `ROOT`: the browser the enrollment QR approved. `APP`: an installed app added from it. */
    kind: c.kind,
    status: c.status,
    context: c.context,
    createdAt: iso(c.createdAt),
    endedAt: iso(c.endedAt),
    endedBy: c.endedBy,
    endReason: c.endReason,
    origin: originView(c.origin),
  };
}

export type CredentialView = ReturnType<typeof credentialView>;

export function deviceView(d: Device, credentials: Credential[] = []) {
  return {
    deviceId: d.deviceId,
    friendlyName: d.friendlyName,
    status: d.status,
    keyFingerprint: d.keyFingerprint,
    deviceType: d.deviceType,
    os: d.os,
    browser: d.browser,
    context: d.context,
    site: d.site,
    createdBy: d.createdBy,
    createdAt: iso(d.createdAt),
    lastSeenAt: iso(d.lastSeenAt),
    approvedAt: iso(d.approvedAt),
    approvedBy: d.approvedBy,
    origin: originView(d.origin),
    revokedAt: iso(d.revokedAt),
    revokedBy: d.revokedBy,
    revokeReason: d.revokeReason,
    credentials: credentials.map(credentialView),
  };
}

export type DeviceView = ReturnType<typeof deviceView>;

export function enrollmentView(e: Enrollment) {
  return {
    enrollmentId: e.enrollmentId,
    site: e.site,
    friendlyName: e.friendlyName,
    createdBy: e.createdBy,
    createdAt: iso(e.createdAt),
    expiresAt: iso(e.expiresAt),
  };
}

export type EnrollmentView = ReturnType<typeof enrollmentView>;
