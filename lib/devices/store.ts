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
 *   enrollment  an administrator issued a one-time enrollment for a user
 *   enrolled    that enrollment was used: a device was created, APPROVED
 *   revoked     a device was revoked (by an administrator, or replaced)
 *   seen        a device was used (written at most every `SEEN_PERSIST_MS`)
 *
 * The file holds **hashes, never secrets**: the SHA-256 of each enrollment
 * token and each device token (`lib/devices/credential.ts`). The raw tokens
 * exist only in the enrollment link and in the device's cookie.
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
import { DEVICE_ID, hashSecret, newSecretToken, SECRET_HASH, SECRET_TOKEN, secretMatches } from "./credential";

export const DEVICE_STORE_ENV = "DEVICE_STORE_PATH";

const RECORD_VERSION = 1;

/** How often a device's use is written down. In memory it is exact; on disk it is at most this stale. */
export const SEEN_PERSIST_MS = 15 * 60 * 1000;

export type DeviceStatus = "APPROVED" | "REVOKED";

export interface Enrollment {
  enrollmentId: string;
  /** The one user who may use it, as their FabOrchestrator email (lower case). */
  allowedEmail: string;
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

export interface Device extends DeviceMetadata {
  deviceId: string;
  userId: string;
  email: string;
  status: DeviceStatus;
  site: string | null;
  enrollmentId: string;
  /** The administrator who issued the enrollment this device came from. */
  createdBy: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

/* ── Records ───────────────────────────────────────────────────────────────── */

const ENROLLMENT_ID = /^enr_[A-Za-z0-9_-]{16}$/;
const text = (max: number) => z.string().min(1).max(max);
const time = z.number().int().positive();

const EnrollmentRecord = z
  .object({
    v: z.literal(RECORD_VERSION),
    t: z.literal("enrollment"),
    id: z.string().regex(ENROLLMENT_ID),
    th: z.string().regex(SECRET_HASH),
    email: text(255),
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
    th: z.string().regex(SECRET_HASH),
    uid: text(255),
    email: text(255),
    name: text(100),
    dtype: text(40),
    os: text(40),
    browser: text(40),
    ctx: text(40),
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

const StoreRecord = z.discriminatedUnion("t", [EnrollmentRecord, EnrolledRecord, RevokedRecord, SeenRecord]);
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
  const withVersion = { v: RECORD_VERSION, ...record };
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
  | { kind: "enrolled"; device: Device; token: string }
  | { kind: "unknown" | "expired" | "used" }
  | { kind: "wrong_user"; enrollment: Enrollment };

export type DeviceVerification =
  | { kind: "approved"; device: Device }
  | { kind: "revoked"; device: Device }
  /** The id is known but the token is not its token. */
  | { kind: "mismatch"; deviceId: string }
  | { kind: "unknown" };

/* ── The store ─────────────────────────────────────────────────────────────── */

interface State {
  enrollments: Map<string, Enrollment>;
  enrollmentByHash: Map<string, string>;
  devices: Map<string, Device>;
  tokenHashes: Map<string, string>;
  corrupt: number;
}

function emptyState(): State {
  return { enrollments: new Map(), enrollmentByHash: new Map(), devices: new Map(), tokenHashes: new Map(), corrupt: 0 };
}

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
   * link; only its hash is stored.
   */
  createEnrollment(input: {
    allowedEmail: string;
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
      email: normaliseEmail(input.allowedEmail),
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
   * Use an enrollment: create an APPROVED device for the user who has just
   * authenticated, and mint its token. Exactly one call can succeed per
   * enrollment, however many race (see "One enrollment, one device").
   */
  completeEnrollment(input: {
    token: string;
    userId: string;
    email: string;
    metadata: DeviceMetadata;
    now?: number;
  }): Promise<CompleteResult> {
    return this.serialised(async () => {
      const now = input.now ?? Date.now();
      if (!SECRET_TOKEN.test(input.token)) return { kind: "unknown" };
      await this.load();
      const lookup = this.classifyEnrollment(this.state.enrollmentByHash.get(hashSecret(input.token)), now);
      if (lookup.kind !== "valid") return { kind: lookup.kind };
      const enrollment = lookup.enrollment;
      if (normaliseEmail(input.email) !== enrollment.allowedEmail) return { kind: "wrong_user", enrollment };

      // The race-proof step: exactly one creator of this marker, ever.
      if (!(await this.createMarker(`enrollment-${enrollment.enrollmentId}`))) return { kind: "used" };

      const deviceId = await this.allocateDeviceId();
      const deviceToken = newSecretToken();
      await this.append(
        serializeRecord({
          t: "enrolled",
          eid: enrollment.enrollmentId,
          dev: deviceId,
          th: hashSecret(deviceToken),
          uid: input.userId,
          email: normaliseEmail(input.email),
          name: enrollment.friendlyName ?? input.metadata.friendlyName,
          dtype: input.metadata.deviceType,
          os: input.metadata.os,
          browser: input.metadata.browser,
          ctx: input.metadata.context,
          at: now,
        }),
      );
      await this.load();
      const device = this.state.devices.get(deviceId);
      if (!device) throw new DeviceStoreUnavailableError("The device was written but could not be read back.");
      return { kind: "enrolled", device, token: deviceToken };
    });
  }

  async listPendingEnrollments(now: number = Date.now()): Promise<Enrollment[]> {
    await this.load();
    return [...this.state.enrollments.values()]
      .filter((e) => e.usedAt === null && e.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ── Devices ───────────────────────────────────────────────────────────── */

  /** Check a presented device id and token. The token is compared by hash, in constant time. */
  async verifyDevice(deviceId: string, token: string): Promise<DeviceVerification> {
    if (!DEVICE_ID.test(deviceId) || !SECRET_TOKEN.test(token)) return { kind: "unknown" };
    await this.load();
    const device = this.state.devices.get(deviceId);
    const hash = this.state.tokenHashes.get(deviceId);
    if (!device || !hash) return { kind: "unknown" };
    if (!secretMatches(token, hash)) return { kind: "mismatch", deviceId };
    const view = this.withSeen(device);
    return device.status === "APPROVED" ? { kind: "approved", device: view } : { kind: "revoked", device: view };
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
   * Revoke a device. Idempotent: revoking a revoked device changes nothing and
   * keeps the first revocation's time and actor. Null for an unknown device.
   */
  revokeDevice(deviceId: string, input: { by: string; reason: string; now?: number }): Promise<{ device: Device; changed: boolean } | null> {
    return this.serialised(async () => {
      await this.load();
      const device = this.state.devices.get(deviceId);
      if (!device) return null;
      if (device.status === "REVOKED") return { device: this.withSeen(device), changed: false };
      await this.append(
        serializeRecord({ t: "revoked", dev: deviceId, by: input.by, reason: input.reason.slice(0, 200) || "revoked", at: input.now ?? Date.now() }),
      );
      await this.load();
      return { device: this.withSeen(this.state.devices.get(deviceId)!), changed: true };
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

  async stats(): Promise<{ devices: number; enrollments: number; corrupt: number }> {
    await this.load();
    return { devices: this.state.devices.size, enrollments: this.state.enrollments.size, corrupt: this.state.corrupt };
  }

  /** Testing seam, and a clean shutdown: let pending writes finish. No file stays open. */
  async close(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  /* ── Internals ─────────────────────────────────────────────────────────── */

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
          allowedEmail: normaliseEmail(record.email),
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
        if ([...state.tokenHashes.values()].includes(record.th)) return bad(index);
        enrollment.usedAt = record.at;
        enrollment.deviceId = record.dev;
        state.devices.set(record.dev, {
          deviceId: record.dev,
          userId: record.uid,
          email: normaliseEmail(record.email),
          status: "APPROVED",
          site: enrollment.site,
          enrollmentId: record.eid,
          createdBy: enrollment.createdBy,
          createdAt: record.at,
          lastSeenAt: null,
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
          friendlyName: record.name,
          deviceType: record.dtype,
          os: record.os,
          browser: record.browser,
          context: record.ctx,
        });
        state.tokenHashes.set(record.dev, record.th);
        return;
      }
      case "revoked": {
        const device = state.devices.get(record.dev);
        if (!device) return bad(index);
        if (device.status === "REVOKED") return;
        device.status = "REVOKED";
        device.revokedAt = record.at;
        device.revokedBy = record.by;
        device.revokeReason = record.reason;
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
