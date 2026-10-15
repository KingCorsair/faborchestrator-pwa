/**
 * The device store: one-time enrollments, approved devices, and revocations
 * (device enrollment, 6 October 2026).
 *
 * ── Why a file, and why this shape ──────────────────────────────────────────
 * This app has no database. Its one durable store before this one, the seat
 * store (`lib/gateway/seat-store.ts`), is an append-only file of validated,
 * checksummed JSON lines on a Fly volume, and this follows the same pattern
 * rather than adding a second kind of persistence. Every change is a new line;
 * nothing is rewritten. The current state (which enrollments are used, which
 * devices are approved or revoked, when each was last seen) is the fold of the
 * lines in order, so the file is also the audit trail of who enrolled and who
 * revoked what.
 *
 *   enrollment  an administrator issued a one-time enrollment
 *   enrolled    that enrollment was used: a device was created, APPROVED, or
 *               PENDING an administrator's approval (`pend`, 14 October 2026)
 *   approved    an administrator approved a PENDING device
 *   revoked     a device was revoked (by an administrator, or replaced); a
 *               PENDING device revoked is REJECTED: its request was refused
 *   seen        a device was used (written at most every `SEEN_PERSIST_MS`)
 *   bound       a session signed in with a device's proof (by the FO token's
 *               fingerprint, never the token): every later request on it is
 *               checked against that device, and against the credential
 *               (`cr`) that signed in
 *   grant       a device's ROOT credential proved itself and was given a
 *               one-time install grant (9 October 2026, below)
 *   attached    that grant was used: a second key, an installed app's, now
 *               belongs to the same device as an APP credential
 *   cred_revoked  one credential was revoked, without revoking its device
 *
 * ── A device has credentials (9 October 2026) ───────────────────────────────
 * On an iPhone the browser and the Home Screen app keep separate storage, so
 * the key a browser enrolled with is invisible to the app installed from it.
 * A device therefore holds one or more **credentials**, each a public key:
 *
 *   ROOT  the key registered by the enrollment QR. Exactly one per device.
 *         Every `enrolled` line is one, including every line written before
 *         this model existed: nothing is migrated, the same line is read as
 *         device + ROOT. It alone may ask for install grants.
 *   APP   an installed app's own key, attached with a one-time install grant.
 *         At most one is ACTIVE per device: attaching another (a reinstall)
 *         marks the earlier one SUPERSEDED.
 *
 * A credential's id is its key's fingerprint, so it is the same on every read
 * and a browser can compute its own. Which kind a credential is comes only
 * from the record that created it, never from anything a client says.
 *
 * The record version stays 3: these are new record types and one optional
 * field, and every older line stays valid exactly as written.
 *
 * ── Approval by an administrator (14 October 2026) ──────────────────────────
 * Scanning an enrollment QR used to approve the device on the spot. Now it
 * makes a **request**: the device is created PENDING, holding its key, and
 * nothing it proves opens anything until an administrator approves it on
 * `/device-admin` (or refuses it: REJECTED). The `enrolled` line says so with
 * `pend: true`; a line without it (every line before this) is APPROVED as
 * written. The line also keeps where the request came from (`origin.ts`):
 * the address, the edge region, the user agent, and the time zone and
 * language the device reported, for the administrator deciding. An installed
 * app's `attached` line keeps the same.
 *
 * Install grants no longer run out (14 October 2026): a `grant` line without
 * `exp` stands until it is used, replaced by a newer one, or cancelled by a
 * revocation. One use, as before.
 *
 * The file holds **no secrets**: the SHA-256 of each enrollment code
 * (`lib/devices/credential.ts`) and each device's **public** key. The raw
 * enrollment code exists only in the enrollment link; a device's private key
 * never leaves the device (`lib/devices/keystore.ts`).
 *
 * ── The rules it keeps ──────────────────────────────────────────────────────
 *  · **Fails closed.** A line that is not exactly a valid record is counted,
 *    reported and ignored. An `enrolled` line for an enrollment the file does
 *    not hold, or one already used, creates no device. A device the file does
 *    not hold is unknown, and unknown is blocked.
 *  · **One enrollment, one device, even under a race.** Using an enrollment
 *    first creates a marker file named after it with `O_EXCL` (`wx`): the
 *    filesystem lets exactly one creator succeed, in this process or any
 *    other on the same volume. Only the winner writes the `enrolled` line. A
 *    crash between the marker and the line burns the enrollment (it can
 *    never be used) rather than risk a second device.
 *  · **Written before it is believed**, as in the seat store: a line is
 *    appended and flushed (`fsync`) before the call resolves.
 *  · **Writes are serialised** in this process through one promise chain.
 *  · **Re-read when the file changes.** Every read stats the file and reloads
 *    it when its size or modification time moved, so a revocation written by
 *    one module instance (an API route) is seen by another (the proxy) on its
 *    very next request, and so is an enrollment written by the bootstrap CLI
 *    (`scripts/device-enrollment.mjs`).
 *
 * The checksum on each line detects a torn or accidentally altered line. It is
 * not a signature: whoever can write the volume can write a valid line, and
 * whoever can write the volume already controls the machine.
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 * `DEVICE_STORE_PATH`. Unset means not configured, and with the device gate
 * enforced every request is then refused (`lib/devices/gate.ts`); there is no
 * in-memory fallback. One machine, one volume, as for the seat store: several
 * instances would need a shared store behind this interface.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { reportError } from "@/lib/report-error";
import { CREDENTIAL_ID, decodePublicKey, PUBLIC_KEY_SPKI } from "./challenges";
import { DEVICE_ID, hashSecret, newSecretToken, SECRET_HASH, SECRET_TOKEN } from "./credential";

export const DEVICE_STORE_ENV = "DEVICE_STORE_PATH";

/**
 * 3 since 6 October 2026, when the device stamp became a Web Crypto key pair:
 * a device record holds the device's **public key**, and the private key never
 * leaves the device. Records of earlier versions (a user-named enrollment, a
 * bearer-token hash) are not valid records and grant nothing: those devices
 * must enroll again.
 */
const RECORD_VERSION = 3;

/** How long a session's device binding is kept, at most: past any session's end. */
const MAX_BINDING_MS = 24 * 60 * 60 * 1000;

/** A session's fingerprint as `lib/auth.ts` `foFingerprint` makes it. */
const SESSION_FP = /^[A-Za-z0-9_-]{22}$/;

/** How often a device's use is written down. In memory it is exact; on disk it is at most this stale. */
export const SEEN_PERSIST_MS = 15 * 60 * 1000;

/**
 * PENDING: enrolled with a QR, waiting for an administrator. REJECTED: an
 * administrator refused that request. Only APPROVED opens anything.
 */
export type DeviceStatus = "PENDING" | "APPROVED" | "REJECTED" | "REVOKED";

/** Where an enrollment or an attachment came from (`lib/devices/origin.ts`). Descriptive only. */
export interface Origin {
  ip: string | null;
  edge: string | null;
  userAgent: string | null;
  timeZone: string | null;
  language: string | null;
}

export type CredentialKind = "ROOT" | "APP";
export type CredentialStatus = "ACTIVE" | "SUPERSEDED" | "REVOKED";

/** One key that may prove a device. Its id is the key's fingerprint. */
export interface Credential {
  credentialId: string;
  deviceId: string;
  /** Decided by the record that created it: `enrolled` makes a ROOT, `attached` an APP. */
  kind: CredentialKind;
  /** The ROOT credential whose grant attached this one; null for a ROOT. */
  parentId: string | null;
  publicKeySpki: string;
  status: CredentialStatus;
  /** `installed-app` or `browser`, as the client described itself. Descriptive only. */
  context: string;
  createdAt: number;
  /** The enrollment (ROOT) or install grant (APP) that created it. */
  createdVia: string;
  endedAt: number | null;
  endedBy: string | null;
  endReason: string | null;
  /** Where the request that registered it came from, when it was recorded. */
  origin: Origin | null;
}

export type GrantState = "ISSUED" | "CONSUMED" | "EXPIRED" | "CANCELLED";

/**
 * A one-time permission to attach one installed-app key to a device. It signs
 * nobody in and reads nothing. Its state is computed, never stored: see
 * `grantStateIn`.
 */
export interface InstallGrant {
  grantId: string;
  deviceId: string;
  rootCredentialId: string;
  createdAt: number;
  /** Null: it does not run out (14 October 2026). It is still used once. */
  expiresAt: number | null;
  consumedAt: number | null;
  /** The APP credential it created, once used. */
  consumedBy: string | null;
}

export interface Enrollment {
  enrollmentId: string;
  /** The administrator who issued it. */
  createdBy: string;
  site: string | null;
  /** The name the device will be given, if the administrator chose one. */
  friendlyName: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  /** The device it created, once used. */
  deviceId: string | null;
}

export interface DeviceMetadata {
  friendlyName: string;
  deviceType: string;
  os: string;
  browser: string;
  /** `installed-app` when enrolled from the Home Screen app, `browser` otherwise. */
  context: string;
}

/**
 * An approved (or revoked) device. It belongs to no user: the enrollment
 * authorized the device, and whoever signs in on it is decided by the normal
 * FabOrchestrator sign-in, every time.
 */
export interface Device extends DeviceMetadata {
  deviceId: string;
  status: DeviceStatus;
  /** Fingerprint of the device's public key: public, for display and logs. */
  keyFingerprint: string;
  site: string | null;
  enrollmentId: string;
  /** The administrator who issued the enrollment this device came from. */
  createdBy: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** When an administrator approved it; null for a device approved by its QR alone (before 14 October 2026, or the bootstrap CLI). */
  approvedAt: number | null;
  approvedBy: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  revokeReason: string | null;
  /** Where the enrollment request came from, when it was recorded. */
  origin: Origin | null;
}

/* ── Records ───────────────────────────────────────────────────────────────── */

const ENROLLMENT_ID = /^enr_[A-Za-z0-9_-]{16}$/;
const GRANT_ID = /^grt_[A-Za-z0-9_-]{16}$/;
const text = (max: number) => z.string().min(1).max(max);
const time = z.number().int().positive();

/** Where a request came from: every field optional, so older lines are unchanged. */
const originFields = {
  ip: text(64).optional(),
  edge: text(16).optional(),
  ua: text(400).optional(),
  tz: text(64).optional(),
  lang: text(35).optional(),
};

const EnrollmentRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("enrollment"),
    id: z.string().regex(ENROLLMENT_ID),
    th: z.string().regex(SECRET_HASH),
    by: text(255),
    site: text(100).nullable(),
    name: text(100).nullable(),
    at: time,
    exp: time,
    h: z.string(),
  })
  .strict();

const EnrolledRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("enrolled"),
    eid: z.string().regex(ENROLLMENT_ID),
    dev: z.string().regex(DEVICE_ID),
    /** The device's public key (SPKI, base64url). The private key never reaches the server. */
    pk: z.string().regex(PUBLIC_KEY_SPKI),
    name: text(100),
    dtype: text(40),
    os: text(40),
    browser: text(40),
    ctx: text(40),
    /** Waiting for an administrator's approval. Absent: approved by the enrollment itself. */
    pend: z.literal(true).optional(),
    ...originFields,
    at: time,
    h: z.string(),
  })
  .strict();

/** An administrator approved a PENDING device. */
const ApprovedRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("approved"),
    dev: z.string().regex(DEVICE_ID),
    by: text(255),
    at: time,
    h: z.string(),
  })
  .strict();

const RevokedRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("revoked"),
    dev: z.string().regex(DEVICE_ID),
    by: text(255),
    reason: text(200),
    at: time,
    h: z.string(),
  })
  .strict();

const SeenRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("seen"),
    dev: z.string().regex(DEVICE_ID),
    at: time,
    h: z.string(),
  })
  .strict();

/**
 * A session that signed in with this device's proof: its FO-token fingerprint,
 * never the token. `cr` is the credential that signed in; a line without one
 * (every line written before 9 October 2026) means the device's ROOT, which
 * was then the device's only key.
 */
const BoundRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("bound"),
    sf: z.string().regex(SESSION_FP),
    dev: z.string().regex(DEVICE_ID),
    cr: z.string().regex(CREDENTIAL_ID).optional(),
    exp: time,
    at: time,
    h: z.string(),
  })
  .strict();

/** An install grant, issued to a device's ROOT credential. Only the code's hash is kept. */
const GrantRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("grant"),
    id: z.string().regex(GRANT_ID),
    th: z.string().regex(SECRET_HASH),
    dev: z.string().regex(DEVICE_ID),
    cr: z.string().regex(CREDENTIAL_ID),
    at: time,
    /** Absent: the grant does not run out (14 October 2026). */
    exp: time.optional(),
    h: z.string(),
  })
  .strict();

/** A grant was used: this public key is now an APP credential of the grant's device. */
const AttachedRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("attached"),
    gid: z.string().regex(GRANT_ID),
    dev: z.string().regex(DEVICE_ID),
    pk: z.string().regex(PUBLIC_KEY_SPKI),
    ctx: text(40),
    ...originFields,
    at: time,
    h: z.string(),
  })
  .strict();

const CredentialRevokedRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("cred_revoked"),
    cr: z.string().regex(CREDENTIAL_ID),
    by: text(255),
    reason: text(200),
    at: time,
    h: z.string(),
  })
  .strict();

const StoreRecord = z.discriminatedUnion("t", [
  EnrollmentRecord,
  EnrolledRecord,
  ApprovedRecord,
  RevokedRecord,
  SeenRecord,
  BoundRecord,
  GrantRecord,
  AttachedRecord,
  CredentialRevokedRecord,
]);
type StoreRecord = z.infer<typeof StoreRecord>;
type Unsigned<R> = R extends unknown ? Omit<R, "h" | "v"> : never;

/**
 * The checksum over every other field, in sorted key order. Kept trivially
 * reproducible on purpose: `scripts/device-enrollment.mjs` computes the same
 * thing without importing this file, and a test holds the two together.
 */
export function recordChecksum(fields: Record<string, unknown>): string {
  const canonical = Object.keys(fields)
    .filter((key) => key !== "h")
    .sort()
    .map((key) => [key, fields[key]]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export function serializeRecord(record: Unsigned<StoreRecord>): string {
  // An absent optional field must be absent, not `undefined`: the checksum is
  // over the keys present, and JSON drops an undefined value but not its key
  // from that list.
  const present = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
  const withVersion = { v: RECORD_VERSION, ...present };
  return JSON.stringify({ ...withVersion, h: recordChecksum(withVersion) });
}

export function parseRecord(line: string): StoreRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = StoreRecord.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.h !== recordChecksum(parsed.data as unknown as Record<string, unknown>)) return null;
  return parsed.data;
}

/* ── Errors and results ────────────────────────────────────────────────────── */

/** The store has no path, or its file cannot be read or written. Callers fail closed. */
export class DeviceStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeviceStoreUnavailableError";
  }
}

/** `DEVICE_STORE_PATH` is not set: a deployment fault, not an outage. */
export class DeviceStoreNotConfiguredError extends DeviceStoreUnavailableError {
  constructor() {
    super(`${DEVICE_STORE_ENV} is not set: devices cannot be checked.`);
    this.name = "DeviceStoreNotConfiguredError";
  }
}

export type EnrollmentLookup =
  | { kind: "valid"; enrollment: Enrollment }
  | { kind: "expired"; enrollment: Enrollment }
  | { kind: "used"; enrollment: Enrollment }
  | { kind: "unknown" };

export type CompleteResult =
  | { kind: "enrolled"; device: Device }
  | { kind: "unknown" | "expired" | "used" | "bad_key" };

export type ApproveResult =
  | { kind: "approved"; device: Device; changed: boolean }
  /** Rejected or revoked before it was approved: it needs a new enrollment QR. */
  | { kind: "not_pending"; device: Device }
  | { kind: "unknown" };

/**
 * Enrollments the bootstrap CLI issues (`scripts/device-enrollment.mjs`) are
 * approved by being used: whoever ran it has a shell on the server, and the
 * first administrator's device has nobody to approve it.
 */
export const BOOTSTRAP_ISSUER = "bootstrap-cli";

/** Origin fields as a record writes them: absent rather than null. */
function originRecord(origin: Origin | null | undefined) {
  return {
    ip: origin?.ip ?? undefined,
    edge: origin?.edge ?? undefined,
    ua: origin?.userAgent ?? undefined,
    tz: origin?.timeZone ?? undefined,
    lang: origin?.language ?? undefined,
  };
}

/** Origin as a record holds it; null when the line kept none (every line before 14 October 2026). */
function originOf(record: { ip?: string; edge?: string; ua?: string; tz?: string; lang?: string }): Origin | null {
  if (!record.ip && !record.edge && !record.ua && !record.tz && !record.lang) return null;
  return {
    ip: record.ip ?? null,
    edge: record.edge ?? null,
    userAgent: record.ua ?? null,
    timeZone: record.tz ?? null,
    language: record.lang ?? null,
  };
}

export type GrantLookup =
  | { kind: "valid"; grant: InstallGrant }
  | { kind: "unknown" }
  | { kind: "expired" | "consumed" | "cancelled"; grant: InstallGrant };

export type IssueGrantResult =
  | { kind: "issued"; grant: InstallGrant; token: string }
  /** No such credential, not a ROOT, or not ACTIVE on an APPROVED device. */
  | { kind: "unknown" | "not_root" | "inactive" };

export type AttachResult =
  | { kind: "attached"; device: Device; credential: Credential; superseded: Credential[] }
  | { kind: "unknown" | "expired" | "consumed" | "cancelled" | "bad_key" };

/** The device and credential a session signed in with. */
export interface SessionBinding {
  device: Device;
  credential: Credential;
}

/* ── The store ─────────────────────────────────────────────────────────────── */

interface State {
  enrollments: Map<string, Enrollment>;
  enrollmentByHash: Map<string, string>;
  devices: Map<string, Device>;
  /** Every credential, by its id (its key's fingerprint). */
  credentials: Map<string, Credential>;
  /** Device → its ROOT credential's id. */
  rootOf: Map<string, string>;
  grants: Map<string, InstallGrant>;
  grantByHash: Map<string, string>;
  /** ROOT credential → the newest grant issued to it. Any older one is cancelled. */
  latestGrant: Map<string, string>;
  /** Session fingerprint → the device and credential it signed in with, and until when. */
  sessions: Map<string, { deviceId: string; credentialId: string; exp: number }>;
  corrupt: number;
}

function emptyState(): State {
  return {
    enrollments: new Map(),
    enrollmentByHash: new Map(),
    devices: new Map(),
    credentials: new Map(),
    rootOf: new Map(),
    grants: new Map(),
    grantByHash: new Map(),
    latestGrant: new Map(),
    sessions: new Map(),
    corrupt: 0,
  };
}

/**
 * A grant's state right now, computed from the rest of the store:
 *
 *   CONSUMED   an installed app attached with it
 *   CANCELLED  a newer grant was issued to the same ROOT, or the ROOT is no
 *              longer ACTIVE, or its device is no longer APPROVED
 *   EXPIRED    its time ran out
 *   ISSUED     none of those: it can be used, once
 */
function grantStateIn(state: State, grant: InstallGrant, now: number): GrantState {
  if (grant.consumedAt !== null) return "CONSUMED";
  if (state.latestGrant.get(grant.rootCredentialId) !== grant.grantId) return "CANCELLED";
  if (state.credentials.get(grant.rootCredentialId)?.status !== "ACTIVE") return "CANCELLED";
  if (state.devices.get(grant.deviceId)?.status !== "APPROVED") return "CANCELLED";
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "EXPIRED";
  return "ISSUED";
}

/** Lower case, trimmed: how administrator emails are compared (`lib/devices/admin.ts`). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class DeviceStore {
  private state: State = emptyState();
  /** size:mtime:ino of the file as last read; null when never read. */
  private signature: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** In-memory last use per device, exact; the file gets it at most every SEEN_PERSIST_MS. */
  private readonly seenInMemory = new Map<string, number>();

  constructor(readonly path: string) {}

  private get markerDir(): string {
    return `${this.path}.locks`;
  }

  /* ── Enrollments ───────────────────────────────────────────────────────── */

  /**
   * Issue a one-time enrollment. Returns the raw token exactly once, for the
   * link; only its hash is stored. It names no user: whoever holds the link
   * within its lifetime may enroll one device with it.
   */
  createEnrollment(input: {
    createdBy: string;
    site?: string | null;
    friendlyName?: string | null;
    ttlMs: number;
    now?: number;
  }): Promise<{ enrollment: Enrollment; token: string }> {
    const now = input.now ?? Date.now();
    const token = newSecretToken();
    const record = {
      t: "enrollment" as const,
      id: `enr_${newSecretToken().slice(0, 16)}`,
      th: hashSecret(token),
      by: input.createdBy,
      site: input.site?.trim() || null,
      name: input.friendlyName?.trim() || null,
      at: now,
      exp: now + input.ttlMs,
    };
    return this.serialised(async () => {
      await this.append(serializeRecord(record));
      await this.load();
      const enrollment = this.state.enrollments.get(record.id);
      if (!enrollment) throw new DeviceStoreUnavailableError("The enrollment was written but could not be read back.");
      return { enrollment, token };
    });
  }

  /** What an enrollment token names right now. */
  async lookupEnrollment(token: string, now: number = Date.now()): Promise<EnrollmentLookup> {
    if (!SECRET_TOKEN.test(token)) return { kind: "unknown" };
    await this.load();
    return this.classifyEnrollment(this.state.enrollmentByHash.get(hashSecret(token)), now);
  }

  private classifyEnrollment(id: string | undefined, now: number): EnrollmentLookup {
    const enrollment = id ? this.state.enrollments.get(id) : undefined;
    if (!enrollment) return { kind: "unknown" };
    if (enrollment.usedAt !== null) return { kind: "used", enrollment };
    if (enrollment.expiresAt <= now) return { kind: "expired", enrollment };
    return { kind: "valid", enrollment };
  }

  /**
   * Use an enrollment: create a device holding `publicKeySpki`. With
   * `requireApproval` it is PENDING until an administrator approves it
   * (`approveDevice`); without, or for an enrollment the bootstrap CLI issued,
   * it is APPROVED at once. No user is involved. The caller has already
   * checked that the device holds the matching private key (a signed
   * enrollment challenge, `lib/devices/challenges.ts`). Exactly one call can
   * succeed per enrollment, however many race (see "One enrollment, one
   * device").
   */
  completeEnrollment(input: {
    token: string;
    publicKeySpki: string;
    metadata: DeviceMetadata;
    requireApproval?: boolean;
    origin?: Origin | null;
    now?: number;
  }): Promise<CompleteResult> {
    return this.serialised(async () => {
      const now = input.now ?? Date.now();
      if (!SECRET_TOKEN.test(input.token)) return { kind: "unknown" };
      if (!decodePublicKey(input.publicKeySpki)) return { kind: "bad_key" };
      await this.load();
      const lookup = this.classifyEnrollment(this.state.enrollmentByHash.get(hashSecret(input.token)), now);
      if (lookup.kind !== "valid") return { kind: lookup.kind };
      const enrollment = lookup.enrollment;
      // One key, one device: a key already registered is refused here, before
      // the enrollment is spent (the file would refuse the line anyway).
      if (this.keyRegistered(input.publicKeySpki)) return { kind: "bad_key" };

      // The race-proof step: exactly one creator of this marker, ever.
      if (!(await this.createMarker(`enrollment-${enrollment.enrollmentId}`))) return { kind: "used" };

      const deviceId = await this.allocateDeviceId();
      await this.append(
        serializeRecord({
          t: "enrolled",
          eid: enrollment.enrollmentId,
          dev: deviceId,
          pk: input.publicKeySpki,
          name: enrollment.friendlyName ?? input.metadata.friendlyName,
          dtype: input.metadata.deviceType,
          os: input.metadata.os,
          browser: input.metadata.browser,
          ctx: input.metadata.context,
          pend: input.requireApproval === true && enrollment.createdBy !== BOOTSTRAP_ISSUER ? true : undefined,
          ...originRecord(input.origin),
          at: now,
        }),
      );
      await this.load();
      const device = this.state.devices.get(deviceId);
      if (!device) throw new DeviceStoreUnavailableError("The device was written but could not be read back.");
      return { kind: "enrolled", device };
    });
  }

  async listPendingEnrollments(now: number = Date.now()): Promise<Enrollment[]> {
    await this.load();
    return [...this.state.enrollments.values()]
      .filter((e) => e.usedAt === null && e.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ── Devices ───────────────────────────────────────────────────────────── */

  /** The public key registered for a device at enrollment (its ROOT's), or null for an unknown device. */
  async publicKeyOf(deviceId: string): Promise<string | null> {
    return (await this.resolveCredential(deviceId))?.publicKeySpki ?? null;
  }

  /** One credential, or null. */
  async credential(credentialId: string): Promise<Credential | null> {
    if (!CREDENTIAL_ID.test(credentialId)) return null;
    await this.load();
    const found = this.state.credentials.get(credentialId);
    return found ? { ...found } : null;
  }

  /**
   * The credential a device proof names: `credentialId` when given, and it
   * must belong to `deviceId`; the device's ROOT when not (a page loaded before
   * 9 October 2026 names only its device, and every device then had one key).
   */
  async resolveCredential(deviceId: string, credentialId?: string): Promise<Credential | null> {
    if (!DEVICE_ID.test(deviceId)) return null;
    if (credentialId !== undefined && !CREDENTIAL_ID.test(credentialId)) return null;
    await this.load();
    const id = credentialId ?? this.state.rootOf.get(deviceId);
    const found = id ? this.state.credentials.get(id) : undefined;
    return found && found.deviceId === deviceId ? { ...found } : null;
  }

  /** A device's credentials: its ROOT first, then the others, oldest first. */
  async credentialsOf(deviceId: string): Promise<Credential[]> {
    await this.load();
    return [...this.state.credentials.values()]
      .filter((c) => c.deviceId === deviceId)
      .sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === "ROOT" ? -1 : 1))
      .map((c) => ({ ...c }));
  }

  /**
   * Record that a session signed in with a credential's proof. `sessionFp` is
   * the FabOrchestrator token's fingerprint (`foFingerprint`), never the token.
   * Every later request on that session is checked against this device and
   * this credential. `credentialId` omitted means the device's ROOT.
   */
  bindSession(
    sessionFp: string,
    deviceId: string,
    expiresAt: number,
    options: { credentialId?: string; now?: number } = {},
  ): Promise<void> {
    const now = options.now ?? Date.now();
    if (
      !SESSION_FP.test(sessionFp) ||
      !DEVICE_ID.test(deviceId) ||
      (options.credentialId !== undefined && !CREDENTIAL_ID.test(options.credentialId))
    ) {
      return Promise.reject(new TypeError("device store: bad session binding"));
    }
    const exp = Math.min(expiresAt, now + MAX_BINDING_MS);
    return this.serialised(async () => {
      await this.append(serializeRecord({ t: "bound", sf: sessionFp, dev: deviceId, cr: options.credentialId, exp, at: now }));
      await this.load();
    });
  }

  /** The device and credential a session signed in with, while its binding lasts; otherwise null. */
  async sessionBinding(sessionFp: string, now: number = Date.now()): Promise<SessionBinding | null> {
    if (!SESSION_FP.test(sessionFp)) return null;
    await this.load();
    const binding = this.state.sessions.get(sessionFp);
    if (!binding || binding.exp <= now) return null;
    const device = this.state.devices.get(binding.deviceId);
    const credential = this.state.credentials.get(binding.credentialId);
    return device && credential ? { device: this.withSeen(device), credential: { ...credential } } : null;
  }

  /** The device a session signed in with, while its binding lasts; otherwise null. */
  async sessionDevice(sessionFp: string, now: number = Date.now()): Promise<Device | null> {
    return (await this.sessionBinding(sessionFp, now))?.device ?? null;
  }

  async getDevice(deviceId: string): Promise<Device | null> {
    await this.load();
    const device = this.state.devices.get(deviceId);
    return device ? this.withSeen(device) : null;
  }

  async listDevices(): Promise<Device[]> {
    await this.load();
    return [...this.state.devices.values()].map((d) => this.withSeen(d)).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Approve a PENDING device: from its next request, its key opens what an
   * approved device's does. Idempotent for an approved device. A device that
   * was rejected or revoked is not approved again: it needs a new enrollment.
   */
  approveDevice(deviceId: string, input: { by: string; now?: number }): Promise<ApproveResult> {
    return this.serialised(async () => {
      await this.load();
      const device = this.state.devices.get(deviceId);
      if (!device) return { kind: "unknown" };
      if (device.status === "APPROVED") return { kind: "approved", device: this.withSeen(device), changed: false };
      if (device.status !== "PENDING") return { kind: "not_pending", device: this.withSeen(device) };
      await this.append(serializeRecord({ t: "approved", dev: deviceId, by: input.by, at: input.now ?? Date.now() }));
      await this.load();
      return { kind: "approved", device: this.withSeen(this.state.devices.get(deviceId)!), changed: true };
    });
  }

  /**
   * Revoke a device; a PENDING one is REJECTED, its request refused.
   * Idempotent: revoking a revoked device changes nothing and keeps the first
   * revocation's time and actor. Null for an unknown device.
   */
  revokeDevice(deviceId: string, input: { by: string; reason: string; now?: number }): Promise<{ device: Device; changed: boolean } | null> {
    return this.serialised(async () => {
      await this.load();
      const device = this.state.devices.get(deviceId);
      if (!device) return null;
      if (device.status === "REVOKED" || device.status === "REJECTED") return { device: this.withSeen(device), changed: false };
      await this.append(
        serializeRecord({ t: "revoked", dev: deviceId, by: input.by, reason: input.reason.slice(0, 200) || "revoked", at: input.now ?? Date.now() }),
      );
      await this.load();
      return { device: this.withSeen(this.state.devices.get(deviceId)!), changed: true };
    });
  }

  /**
   * Revoke one credential and leave its device approved. Revoking an installed
   * app's credential stops that app only; revoking a ROOT stops the browser
   * that enrolled, and with it any new install grant, while an app already
   * attached keeps working (to stop everything, revoke the device).
   * Idempotent. Null for an unknown credential.
   */
  revokeCredential(
    credentialId: string,
    input: { by: string; reason: string; now?: number },
  ): Promise<{ credential: Credential; changed: boolean } | null> {
    return this.serialised(async () => {
      await this.load();
      const found = CREDENTIAL_ID.test(credentialId) ? this.state.credentials.get(credentialId) : undefined;
      if (!found) return null;
      if (found.status === "REVOKED") return { credential: { ...found }, changed: false };
      await this.append(
        serializeRecord({
          t: "cred_revoked",
          cr: credentialId,
          by: input.by,
          reason: input.reason.slice(0, 200) || "revoked",
          at: input.now ?? Date.now(),
        }),
      );
      await this.load();
      return { credential: { ...this.state.credentials.get(credentialId)! }, changed: true };
    });
  }

  /* ── Install grants ────────────────────────────────────────────────────── */

  /** The newest grant issued to a ROOT credential and its state, or null when it never had one. */
  async latestGrant(rootCredentialId: string, now: number = Date.now()): Promise<{ grant: InstallGrant; state: GrantState } | null> {
    await this.load();
    const id = this.state.latestGrant.get(rootCredentialId);
    const grant = id ? this.state.grants.get(id) : undefined;
    return grant ? { grant: { ...grant }, state: grantStateIn(this.state, grant, now) } : null;
  }

  /** One grant and its state, or null. */
  async grant(grantId: string, now: number = Date.now()): Promise<{ grant: InstallGrant; state: GrantState } | null> {
    await this.load();
    const grant = this.state.grants.get(grantId);
    return grant ? { grant: { ...grant }, state: grantStateIn(this.state, grant, now) } : null;
  }

  /**
   * Issue an install grant to a ROOT credential. The caller has already
   * checked a fresh proof from that credential's key. Returns the raw code
   * exactly once, for the cookie; only its hash is stored. Issuing one cancels
   * any earlier grant of the same ROOT, so at most one is ever outstanding per
   * device. Refused for an APP credential, a credential that is not ACTIVE,
   * and a device that is not APPROVED. `ttlMs: null`: it does not run out.
   */
  issueGrant(input: { credentialId: string; ttlMs: number | null; now?: number }): Promise<IssueGrantResult> {
    return this.serialised(async () => {
      const now = input.now ?? Date.now();
      await this.load();
      const root = CREDENTIAL_ID.test(input.credentialId) ? this.state.credentials.get(input.credentialId) : undefined;
      if (!root) return { kind: "unknown" };
      if (root.kind !== "ROOT") return { kind: "not_root" };
      if (root.status !== "ACTIVE" || this.state.devices.get(root.deviceId)?.status !== "APPROVED") return { kind: "inactive" };
      const token = newSecretToken();
      const id = `grt_${newSecretToken().slice(0, 16)}`;
      await this.append(
        serializeRecord({
          t: "grant",
          id,
          th: hashSecret(token),
          dev: root.deviceId,
          cr: root.credentialId,
          at: now,
          exp: input.ttlMs === null ? undefined : now + input.ttlMs,
        }),
      );
      await this.load();
      const grant = this.state.grants.get(id);
      if (!grant) throw new DeviceStoreUnavailableError("The install grant was written but could not be read back.");
      return { kind: "issued", grant: { ...grant }, token };
    });
  }

  /** What an install-grant code names right now. */
  async lookupGrant(token: string, now: number = Date.now()): Promise<GrantLookup> {
    if (!SECRET_TOKEN.test(token)) return { kind: "unknown" };
    await this.load();
    return this.classifyGrant(this.state.grantByHash.get(hashSecret(token)), now);
  }

  private classifyGrant(id: string | undefined, now: number): GrantLookup {
    const grant = id ? this.state.grants.get(id) : undefined;
    if (!grant) return { kind: "unknown" };
    const state = grantStateIn(this.state, grant, now);
    if (state === "ISSUED") return { kind: "valid", grant: { ...grant } };
    return { kind: state === "CONSUMED" ? "consumed" : state === "EXPIRED" ? "expired" : "cancelled", grant: { ...grant } };
  }

  /**
   * Use an install grant: register `publicKeySpki` as an APP credential of the
   * grant's device. No device is created. The caller has already checked that
   * the requester holds the matching private key (a signed attach challenge).
   * Exactly one call can succeed per grant, however many race: the same
   * `O_EXCL` marker rule as an enrollment. Any APP credential the device
   * already had ACTIVE becomes SUPERSEDED by the same record, so one device
   * never has two installed-app credentials at once.
   */
  attachCredential(input: { token: string; publicKeySpki: string; context: string; origin?: Origin | null; now?: number }): Promise<AttachResult> {
    return this.serialised(async () => {
      const now = input.now ?? Date.now();
      if (!SECRET_TOKEN.test(input.token)) return { kind: "unknown" };
      if (!decodePublicKey(input.publicKeySpki)) return { kind: "bad_key" };
      await this.load();
      const lookup = this.classifyGrant(this.state.grantByHash.get(hashSecret(input.token)), now);
      if (lookup.kind !== "valid") return { kind: lookup.kind };
      const grant = lookup.grant;
      // One key, one credential: refused before the grant is spent.
      if (this.keyRegistered(input.publicKeySpki)) return { kind: "bad_key" };

      // The race-proof step: exactly one creator of this marker, ever.
      if (!(await this.createMarker(`grant-${grant.grantId}`))) return { kind: "consumed" };

      const replaced = [...this.state.credentials.values()]
        .filter((c) => c.deviceId === grant.deviceId && c.kind === "APP" && c.status === "ACTIVE")
        .map((c) => c.credentialId);
      await this.append(
        serializeRecord({
          t: "attached",
          gid: grant.grantId,
          dev: grant.deviceId,
          pk: input.publicKeySpki,
          ctx: input.context.slice(0, 40) || "unknown",
          ...originRecord(input.origin),
          at: now,
        }),
      );
      await this.load();
      const credentialId = this.state.grants.get(grant.grantId)?.consumedBy;
      const credential = credentialId ? this.state.credentials.get(credentialId) : undefined;
      const device = this.state.devices.get(grant.deviceId);
      if (!credential || !device) throw new DeviceStoreUnavailableError("The credential was written but could not be read back.");
      return {
        kind: "attached",
        device: this.withSeen(device),
        credential: { ...credential },
        superseded: replaced.map((id) => ({ ...this.state.credentials.get(id)! })),
      };
    });
  }

  /**
   * Note that a device was used. Exact in memory; written to the file only when
   * the last written use is older than `SEEN_PERSIST_MS`. Resolves true when a
   * line was written (the caller logs an access event then, not on every
   * request). Never rejects: a lost "last seen" must not block anybody.
   */
  async recordSeen(deviceId: string, now: number = Date.now()): Promise<boolean> {
    this.seenInMemory.set(deviceId, Math.max(now, this.seenInMemory.get(deviceId) ?? 0));
    try {
      await this.load();
      const device = this.state.devices.get(deviceId);
      if (!device) return false;
      const persisted = device.lastSeenAt ?? 0;
      if (now - persisted < SEEN_PERSIST_MS) return false;
      return await this.serialised(async () => {
        await this.load();
        const latest = this.state.devices.get(deviceId)?.lastSeenAt ?? 0;
        if (now - latest < SEEN_PERSIST_MS) return false;
        await this.append(serializeRecord({ t: "seen", dev: deviceId, at: now }));
        return true;
      });
    } catch (error) {
      reportError("devices/seen", error);
      return false;
    }
  }

  async stats(): Promise<{ devices: number; enrollments: number; credentials: number; grants: number; corrupt: number }> {
    await this.load();
    return {
      devices: this.state.devices.size,
      enrollments: this.state.enrollments.size,
      credentials: this.state.credentials.size,
      grants: this.state.grants.size,
      corrupt: this.state.corrupt,
    };
  }

  /** Testing seam, and a clean shutdown: let pending writes finish. No file stays open. */
  async close(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  /* ── Internals ─────────────────────────────────────────────────────────── */

  /** Whether this public key is already some credential's. */
  private keyRegistered(publicKeySpki: string): boolean {
    for (const c of this.state.credentials.values()) if (c.publicKeySpki === publicKeySpki) return true;
    return false;
  }

  private withSeen(device: Device): Device {
    const memory = this.seenInMemory.get(device.deviceId) ?? 0;
    const lastSeenAt = Math.max(memory, device.lastSeenAt ?? 0) || null;
    return { ...device, lastSeenAt };
  }

  private serialised<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** `O_EXCL` create: true for the one caller that made it, false when it already existed. */
  private async createMarker(name: string): Promise<boolean> {
    try {
      await mkdir(this.markerDir, { recursive: true, mode: 0o700 });
      const handle = await open(join(this.markerDir, name), "wx", 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new DeviceStoreUnavailableError("The device store's markers could not be written.", { cause: error });
    }
  }

  /** The next free `DEVICE-nnn`, claimed with a marker so no two writers can take one id. */
  private async allocateDeviceId(): Promise<string> {
    let n = 0;
    for (const id of this.state.devices.keys()) n = Math.max(n, Number(id.slice("DEVICE-".length)));
    for (;;) {
      n += 1;
      const id = `DEVICE-${String(n).padStart(3, "0")}`;
      if (await this.createMarker(`device-${id}`)) return id;
    }
  }

  /** Read the file if it has changed since it was last read. */
  private async load(): Promise<void> {
    let signature: string;
    try {
      const info = await stat(this.path);
      signature = `${info.size}:${info.mtimeMs}:${info.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = emptyState();
        this.signature = "absent";
        return;
      }
      throw new DeviceStoreUnavailableError("The device store could not be read.", { cause: error });
    }
    if (signature === this.signature) return;

    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      throw new DeviceStoreUnavailableError("The device store could not be read.", { cause: error });
    }
    const previousCorrupt = this.state.corrupt;
    const { state, badLines } = fold(content);
    // Reported when the count grows, not on every re-read of the same file.
    if (state.corrupt > previousCorrupt) {
      reportError("devices/bad-records", new Error("the device store holds records that grant nothing"), {
        corrupt: state.corrupt,
        firstBadLines: badLines.join(","),
      });
    }
    this.state = state;
    this.signature = signature;
  }

  /**
   * Append one line and flush it. The file is opened for each write, never
   * held: writes are rare (an enrollment, a revocation, a "seen" every quarter
   * hour per device), and a held handle would keep writing to a file that had
   * been replaced underneath it (a restore, a move), where nothing reads.
   */
  private async append(line: string): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const handle = await open(this.path, "a+", 0o600);
      try {
        // A torn last line (a crash mid-write, here or in the CLI) must not
        // swallow this record into its own broken line.
        const { size } = await handle.stat();
        let prefix = "";
        if (size > 0) {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = "\n";
        }
        await handle.appendFile(`${prefix}${line}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (cause) {
      throw new DeviceStoreUnavailableError("The device store could not be written.", { cause });
    }
  }
}

/** The state a file's lines describe, in order. */
function fold(content: string): { state: State; badLines: number[] } {
  const state = emptyState();
  const badLines: number[] = [];
  const bad = (index: number) => {
    state.corrupt += 1;
    if (badLines.length < 10) badLines.push(index + 1);
  };

  content.split("\n").forEach((line, index) => {
    if (line === "") return;
    const record = parseRecord(line);
    if (!record) return bad(index);
    switch (record.t) {
      case "enrollment": {
        if (state.enrollments.has(record.id) || state.enrollmentByHash.has(record.th)) return bad(index);
        state.enrollments.set(record.id, {
          enrollmentId: record.id,
          createdBy: record.by,
          site: record.site,
          friendlyName: record.name,
          createdAt: record.at,
          expiresAt: record.exp,
          usedAt: null,
          deviceId: null,
        });
        state.enrollmentByHash.set(record.th, record.id);
        return;
      }
      case "enrolled": {
        const enrollment = state.enrollments.get(record.eid);
        // No enrollment, a used one, a used device id or a reused token: no device.
        if (!enrollment || enrollment.usedAt !== null || state.devices.has(record.dev)) return bad(index);
        const decoded = decodePublicKey(record.pk);
        if (!decoded) return bad(index);
        // One key, one credential: a public key already registered is not registered again.
        if (state.credentials.has(decoded.fingerprint)) return bad(index);
        enrollment.usedAt = record.at;
        enrollment.deviceId = record.dev;
        state.devices.set(record.dev, {
          deviceId: record.dev,
          status: record.pend ? "PENDING" : "APPROVED",
          keyFingerprint: decoded.fingerprint,
          site: enrollment.site,
          enrollmentId: record.eid,
          createdBy: enrollment.createdBy,
          createdAt: record.at,
          lastSeenAt: null,
          approvedAt: null,
          approvedBy: null,
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
          origin: originOf(record),
          friendlyName: record.name,
          deviceType: record.dtype,
          os: record.os,
          browser: record.browser,
          context: record.ctx,
        });
        // The enrolling key is the device's ROOT credential. This is the whole
        // migration: a line written before credentials existed reads the same.
        state.credentials.set(decoded.fingerprint, {
          credentialId: decoded.fingerprint,
          deviceId: record.dev,
          kind: "ROOT",
          parentId: null,
          publicKeySpki: record.pk,
          status: "ACTIVE",
          context: record.ctx,
          createdAt: record.at,
          createdVia: record.eid,
          endedAt: null,
          endedBy: null,
          endReason: null,
          origin: originOf(record),
        });
        state.rootOf.set(record.dev, decoded.fingerprint);
        return;
      }
      case "approved": {
        const device = state.devices.get(record.dev);
        if (!device) return bad(index);
        if (device.status === "APPROVED") return;
        // Only a request still waiting can be approved; a refused one stays refused.
        if (device.status !== "PENDING") return bad(index);
        device.status = "APPROVED";
        device.approvedAt = record.at;
        device.approvedBy = record.by;
        return;
      }
      case "revoked": {
        const device = state.devices.get(record.dev);
        if (!device) return bad(index);
        if (device.status === "REVOKED" || device.status === "REJECTED") return;
        device.status = device.status === "PENDING" ? "REJECTED" : "REVOKED";
        device.revokedAt = record.at;
        device.revokedBy = record.by;
        device.revokeReason = record.reason;
        return;
      }
      case "bound": {
        if (!state.devices.has(record.dev)) return bad(index);
        // No credential named: the device's ROOT, its only key when the line was written.
        const credentialId = record.cr ?? state.rootOf.get(record.dev);
        if (!credentialId || state.credentials.get(credentialId)?.deviceId !== record.dev) return bad(index);
        // A fingerprint is bound once; a later line for it is ignored, never re-pointed.
        if (!state.sessions.has(record.sf)) state.sessions.set(record.sf, { deviceId: record.dev, credentialId, exp: record.exp });
        return;
      }
      case "grant": {
        if (state.grants.has(record.id) || state.grantByHash.has(record.th)) return bad(index);
        const root = state.credentials.get(record.cr);
        // Only a device's own ROOT credential is ever granted to.
        if (!root || root.kind !== "ROOT" || root.deviceId !== record.dev) return bad(index);
        state.grants.set(record.id, {
          grantId: record.id,
          deviceId: record.dev,
          rootCredentialId: record.cr,
          createdAt: record.at,
          expiresAt: record.exp ?? null,
          consumedAt: null,
          consumedBy: null,
        });
        state.grantByHash.set(record.th, record.id);
        state.latestGrant.set(record.cr, record.id);
        return;
      }
      case "attached": {
        const grant = state.grants.get(record.gid);
        // The grant must have been usable at that moment: for this device,
        // unused, unexpired, not cancelled. Anything else attaches nothing.
        if (!grant || grant.deviceId !== record.dev || grantStateIn(state, grant, record.at) !== "ISSUED") return bad(index);
        const decoded = decodePublicKey(record.pk);
        if (!decoded || state.credentials.has(decoded.fingerprint)) return bad(index);
        // One installed-app credential per device: the earlier one is superseded.
        for (const other of state.credentials.values()) {
          if (other.deviceId !== record.dev || other.kind !== "APP" || other.status !== "ACTIVE") continue;
          other.status = "SUPERSEDED";
          other.endedAt = record.at;
          other.endedBy = "reinstall";
          other.endReason = `superseded by ${decoded.fingerprint}`;
        }
        grant.consumedAt = record.at;
        grant.consumedBy = decoded.fingerprint;
        state.credentials.set(decoded.fingerprint, {
          credentialId: decoded.fingerprint,
          deviceId: record.dev,
          kind: "APP",
          parentId: grant.rootCredentialId,
          publicKeySpki: record.pk,
          status: "ACTIVE",
          context: record.ctx,
          createdAt: record.at,
          createdVia: record.gid,
          endedAt: null,
          endedBy: null,
          endReason: null,
          origin: originOf(record),
        });
        return;
      }
      case "cred_revoked": {
        const found = state.credentials.get(record.cr);
        if (!found) return bad(index);
        if (found.status === "REVOKED") return;
        found.status = "REVOKED";
        found.endedAt = record.at;
        found.endedBy = record.by;
        found.endReason = record.reason;
        return;
      }
      case "seen": {
        const device = state.devices.get(record.dev);
        if (!device) return bad(index);
        device.lastSeenAt = Math.max(device.lastSeenAt ?? 0, record.at);
        return;
      }
    }
  });

  return { state, badLines };
}

/* ── One store per file per process ────────────────────────────────────────── */

const STORES = Symbol.for("faborch.pwa.device-stores");
type Registry = Map<string, DeviceStore>;

/**
 * The device store this deployment is configured with. Throws
 * `DeviceStoreUnavailableError` when `DEVICE_STORE_PATH` is not set.
 */
export function deviceStore(env: Record<string, string | undefined> = process.env): DeviceStore {
  const path = env[DEVICE_STORE_ENV]?.trim();
  if (!path) throw new DeviceStoreNotConfiguredError();
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const stores = (holder[STORES] ??= new Map<string, DeviceStore>());
  let store = stores.get(path);
  if (!store) {
    store = new DeviceStore(path);
    stores.set(path, store);
  }
  return store;
}

/** Testing seam: forget every open store, closing its file. */
export async function resetDeviceStores(): Promise<void> {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const stores = holder[STORES];
  if (!stores) return;
  await Promise.all([...stores.values()].map((store) => store.close().catch(() => undefined)));
  stores.clear();
}
