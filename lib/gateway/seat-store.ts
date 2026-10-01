/**
 * The seat store: which device ("seat") started which FabOrchestrator
 * conversation (PWA-side conversation isolation, 1 October 2026).
 *
 * ── Why this app keeps a store at all ───────────────────────────────────────
 * Several people may sign in to this app with the **same** FabOrchestrator
 * account, and each device must see and use only the conversations it started.
 * FabOrchestrator keys conversations by user id and cannot tell the devices
 * apart, and FabOrchestrator is not being changed. So the one fact that
 * separates them, "this conversation was started by that device", has to be
 * remembered here. It is the only thing this store holds: no credential, no
 * message, no title. Losing it hides conversations inside this app; it never
 * reveals one, and nothing is lost in FabOrchestrator.
 *
 * ── The rules it keeps ──────────────────────────────────────────────────────
 *  · **Unmapped is nobody's.** `ownerOf` answers a seat only for an id with a
 *    valid record. Every caller compares that answer for equality with its own
 *    seat; there is no path on which "no record" means "yours".
 *  · **Ownership is written before it is believed.** `claim` appends the record
 *    and flushes it to disk (`fsync`) *before* the in-memory map changes and
 *    before it resolves. A crash can lose a claim that was never acknowledged;
 *    it cannot acknowledge one that was not stored.
 *  · **Writes are serialised.** Claims run one at a time through a promise
 *    chain, so two conversations created at the same instant are two complete
 *    lines, each flushed, neither lost and neither interleaved.
 *  · **Append-only, validated records.** One JSON object per line, with a
 *    version, a UUID, a seat id, a time and a checksum over the other fields.
 *    Nothing is ever rewritten or removed; a deleted conversation simply keeps
 *    its (now useless) record, so an id can never pass to another seat.
 *  · **A bad record grants nothing.** A line that is not valid JSON, fails the
 *    shape or the checksum, or is a torn last line is counted and reported and
 *    otherwise ignored: the conversation it may have named stays unmapped,
 *    which is nobody's. Two valid records that give one id to two different
 *    seats leave that id owned by **neither**.
 *  · **First owner is the only owner.** A claim for an id that already belongs
 *    to another seat is refused, never overwritten.
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 * `SEAT_STORE_PATH`: one file, on a volume that survives restarts and deploys
 * (`fly.hardening.toml`). With the variable unset the store is *not
 * configured* and every caller fails closed; there is no in-memory fallback,
 * because one that vanished on restart would look exactly like working.
 *
 * One process, one file: this app runs one machine. Several instances would
 * need a shared store behind the same interface (plan RP10-B).
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { reportError } from "@/lib/report-error";

export const SEAT_STORE_ENV = "SEAT_STORE_PATH";

const RECORD_VERSION = 1;

/** A FabOrchestrator conversation id, as the gateway's own checks accept it. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A seat id: the base64url SHA-256 of a device key (`lib/faborch/device.ts`). */
const SEAT_ID = /^[A-Za-z0-9_-]{43}$/;

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}

export function isSeatId(value: unknown): value is string {
  return typeof value === "string" && SEAT_ID.test(value);
}

/** The store has no path, or its file cannot be read or written. Callers fail closed. */
export class SeatStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SeatStoreUnavailableError";
  }
}

export type ClaimResult =
  /** The record was appended and flushed: the conversation is this seat's. */
  | "claimed"
  /** It already was this seat's. */
  | "already-own"
  /** It is another seat's, or two records disagree about it. Never reassigned. */
  | "conflict";

interface OwnRecord {
  v: typeof RECORD_VERSION;
  id: string;
  seat: string;
  /** When the claim was made, epoch milliseconds. */
  at: number;
  /** Checksum over the other fields: a torn or altered line does not verify. */
  h: string;
}

function checksum(id: string, seat: string, at: number): string {
  return createHash("sha256").update(`${RECORD_VERSION}\n${id}\n${seat}\n${at}`).digest("hex").slice(0, 32);
}

/** One line of the file for this claim, without its newline. */
export function serializeRecord(id: string, seat: string, at: number): string {
  const record: OwnRecord = { v: RECORD_VERSION, id, seat, at, h: checksum(id, seat, at) };
  return JSON.stringify(record);
}

/** The claim a line makes, or null for anything that is not exactly a valid record. */
export function parseRecord(line: string): { id: string; seat: string; at: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 5) return null;
  if (record.v !== RECORD_VERSION) return null;
  if (!isConversationId(record.id) || !isSeatId(record.seat)) return null;
  if (typeof record.at !== "number" || !Number.isSafeInteger(record.at) || record.at <= 0) return null;
  if (record.h !== checksum(record.id, record.seat, record.at)) return null;
  return { id: record.id, seat: record.seat, at: record.at };
}

export interface SeatStoreStats {
  /** Conversations with exactly one valid owner. */
  owned: number;
  /** Ids that two valid records give to different seats: owned by neither. */
  conflicted: number;
  /** Lines that were not valid records when the file was loaded. */
  corrupt: number;
}

export class SeatStore {
  private readonly owners = new Map<string, string>();
  private readonly conflicted = new Set<string>();
  private corrupt = 0;

  private loaded: Promise<void> | null = null;
  private handle: FileHandle | null = null;
  /** True when the file's last byte is not a newline: the next record must start its own line. */
  private needsNewline = false;
  /** The serialising chain: each claim starts when the one before it has settled. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  /**
   * The seat that owns this conversation, or null: unmapped, conflicted, or not
   * a conversation id at all. Rejects with `SeatStoreUnavailableError` when the
   * file cannot be read, which a caller must treat as "refuse".
   */
  async ownerOf(id: string): Promise<string | null> {
    await this.load();
    if (this.conflicted.has(id)) return null;
    return this.owners.get(id) ?? null;
  }

  /** Whether this conversation is this seat's. False for anything unmapped. */
  async isOwnedBy(id: string, seat: string): Promise<boolean> {
    const owner = await this.ownerOf(id);
    return owner !== null && owner === seat;
  }

  /**
   * Record that `seat` started conversation `id`. Resolves only once the record
   * is on disk. Rejects when it could not be stored: the caller must then treat
   * the conversation as nobody's.
   */
  claim(id: string, seat: string, now: number = Date.now()): Promise<ClaimResult> {
    if (!isConversationId(id)) return Promise.reject(new TypeError("seat store: not a conversation id"));
    if (!isSeatId(seat)) return Promise.reject(new TypeError("seat store: not a seat id"));

    const run = async (): Promise<ClaimResult> => {
      await this.load();
      if (this.conflicted.has(id)) return "conflict";
      const existing = this.owners.get(id);
      if (existing !== undefined) return existing === seat ? "already-own" : "conflict";
      await this.append(serializeRecord(id, seat, now));
      // Only now: the map never says more than the file does.
      this.owners.set(id, seat);
      return "claimed";
    };
    // One at a time, whatever happened to the claim before this one.
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async stats(): Promise<SeatStoreStats> {
    await this.load();
    return { owned: this.owners.size, conflicted: this.conflicted.size, corrupt: this.corrupt };
  }

  /** Testing seam, and a clean shutdown: release the file. */
  async close(): Promise<void> {
    await this.tail;
    const handle = this.handle;
    this.handle = null;
    await handle?.close();
  }

  /** Read the file once. A failure is not remembered: the next call tries again. */
  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.readAll().catch((cause) => {
        this.loaded = null;
        throw new SeatStoreUnavailableError("The seat store could not be read.", { cause });
      });
    }
    return this.loaded;
  }

  private async readAll(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // no claims yet
      throw error;
    }
    this.owners.clear();
    this.conflicted.clear();
    this.corrupt = 0;
    this.needsNewline = text.length > 0 && !text.endsWith("\n");

    const badLines: number[] = [];
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (line === "") return; // carries no claim; the final terminator is one of these
      const record = parseRecord(line);
      if (!record) {
        this.corrupt += 1;
        if (badLines.length < 10) badLines.push(index + 1);
        return;
      }
      if (this.conflicted.has(record.id)) return;
      const existing = this.owners.get(record.id);
      if (existing !== undefined && existing !== record.seat) {
        // Two valid records disagree: it is neither seat's.
        this.owners.delete(record.id);
        this.conflicted.add(record.id);
        return;
      }
      this.owners.set(record.id, record.seat);
    });

    if (this.corrupt > 0 || this.conflicted.size > 0) {
      reportError("seat-store/bad-records", new Error("the seat store holds records that grant nothing"), {
        corrupt: this.corrupt,
        conflicted: this.conflicted.size,
        firstBadLines: badLines.join(","),
      });
    }
  }

  /** Append one line and flush it. Throws when the record is not known to be on disk. */
  private async append(line: string): Promise<void> {
    try {
      if (!this.handle) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        this.handle = await open(this.path, "a", 0o600);
      }
      // A torn tail must not swallow this record into its own broken line.
      const data = `${this.needsNewline ? "\n" : ""}${line}\n`;
      await this.handle.appendFile(data, "utf8");
      await this.handle.sync();
      this.needsNewline = false;
    } catch (cause) {
      // The line may be partly written: make the next record start a line of
      // its own, and reopen the file rather than trust this handle.
      this.needsNewline = true;
      const handle = this.handle;
      this.handle = null;
      await handle?.close().catch(() => undefined);
      throw new SeatStoreUnavailableError("The seat store could not be written.", { cause });
    }
  }
}

/** One store per file per process, however many times this module is loaded. */
const STORES = Symbol.for("faborch.pwa.seat-stores");
type Registry = Map<string, SeatStore>;

/**
 * The seat store this deployment is configured with. Throws
 * `SeatStoreUnavailableError` when `SEAT_STORE_PATH` is not set: there is no
 * fallback, and a caller that cannot reach the store must refuse.
 */
export function seatStore(env: Record<string, string | undefined> = process.env): SeatStore {
  const path = env[SEAT_STORE_ENV]?.trim();
  if (!path) {
    throw new SeatStoreUnavailableError(`${SEAT_STORE_ENV} is not set: conversation ownership cannot be stored.`);
  }
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const stores = (holder[STORES] ??= new Map<string, SeatStore>());
  let store = stores.get(path);
  if (!store) {
    store = new SeatStore(path);
    stores.set(path, store);
  }
  return store;
}

/** Testing seam: forget every open store, closing its file. */
export async function resetSeatStores(): Promise<void> {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const stores = holder[STORES];
  if (!stores) return;
  await Promise.all([...stores.values()].map((store) => store.close().catch(() => undefined)));
  stores.clear();
}
