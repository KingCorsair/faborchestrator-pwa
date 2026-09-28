/**
 * A failed-attempt limiter for sign-in.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `/api/auth/login` forwards to a **real** FabOrchestrator. On a public URL, an
 * unthrottled login that proxies to a production identity store is a
 * credential-testing endpoint with no lockout, no alerting, and — because the
 * attempts are made by *this* server — nothing in FO's audit trail that
 * distinguishes them from a person. The limiter arrived with the first public
 * deploy (2026-08-23), because the deploy is what made that reachable.
 *
 * **This is a mitigation, not a fix.** It counts per address, so it stops a
 * script hammering from one address and does not stop a distributed attempt.
 * The real answer is FabOrchestrator's own lockout, on its own user table.
 *
 * ── Where the count lives (2026-09-28) ──────────────────────────────────────
 * Until now, in this process's memory — which was coherent only while exactly
 * one copy of the app ran. With two, each copy keeps its own count and an
 * attacker gets eight guesses *per copy*; a restart or a deploy forgets them
 * all. It was the one piece of state standing between this app and running as
 * several copies, so it can now live in a store every copy shares:
 *
 *   UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN set  → Upstash Redis
 *   either one unset                                        → this process, as before
 *
 * Upstash is spoken to over its REST API with plain `fetch`: no new dependency
 * and no connection to hold open, so the same call works from a long-lived
 * server and from a serverless function alike.
 *
 * **If the store cannot be reached, the count falls back to this process** for
 * that request, and the log says so. Refusing every sign-in because a counter
 * is down would lock out the operators the limiter exists to protect; counting
 * locally is exactly the protection this app had before the store existed.
 *
 * ── Only failures count ─────────────────────────────────────────────────────
 * A successful sign-in clears the counter. Somebody who knows their password is
 * never throttled by their own logins, however many devices they open the demo
 * on; only wrong guesses accumulate.
 */

import { createHmac } from "node:crypto";
import { reportError } from "./report-error";

/** Wrong guesses allowed from one address before it is refused. */
const MAX_FAILURES = 8;

/** How long failures are remembered, and how long a blocked address waits. */
const WINDOW_MS = 10 * 60 * 1000;

/**
 * Cap on addresses tracked in memory, so a spray across many source IPs cannot
 * grow the Map without bound. At the cap the oldest entry is dropped — which
 * favours whoever is attacking, and is the right way round: the alternative is
 * refusing to record anything, or refusing real users, both worse than
 * degrading to no protection for one address.
 */
const MAX_TRACKED = 10_000;

/**
 * The caller's address.
 *
 * `fly-client-ip` first: Fly sets it on every request from its edge and a
 * client cannot forge it, whereas `x-forwarded-for` is caller-supplied and is
 * only trustworthy at the hop that wrote it. Falling back to the first
 * `x-forwarded-for` entry covers other hosts; falling back to a constant covers
 * local development, where every request shares one bucket, which is correct
 * because there is only one caller.
 */
export function clientAddress(headers: Headers): string {
  const fly = headers.get("fly-client-ip");
  if (fly) return fly.trim();
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "local";
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Whole seconds until the window clears. Only meaningful when blocked. */
  retryAfterSeconds: number;
}

/*
 * `now` below is this process's clock, and only the in-process count reads it.
 * The shared store keeps time itself: a key's expiry is the window.
 */

/** Whether this address may attempt a sign-in right now. */
export async function checkLoginAllowed(
  address: string,
  now = Date.now(),
): Promise<RateLimitVerdict> {
  return withSharedStore(
    (store) => sharedCheck(store, storeKey(address)),
    () => checkLocally(address, now),
  );
}

/** Record a wrong guess. */
export async function recordLoginFailure(address: string, now = Date.now()): Promise<void> {
  return withSharedStore(
    (store) => sharedRecord(store, storeKey(address)),
    () => recordLocally(address, now),
  );
}

/** Forget this address's failures. Called on a successful sign-in. */
export async function clearLoginFailures(address: string): Promise<void> {
  return withSharedStore(
    (store) => sharedClear(store, storeKey(address)),
    () => clearLocally(address),
  );
}

/** Test seam: empties the in-process count. Nothing in the app calls this. */
export function resetLoginFailures(): void {
  failures.clear();
}

export const LOGIN_RATE_LIMIT = { MAX_FAILURES, WINDOW_MS } as const;

/* ── In this process ─────────────────────────────────────────────────────── */

interface Attempts {
  count: number;
  /** When the window began, epoch ms. */
  since: number;
}

const failures = new Map<string, Attempts>();

function checkLocally(address: string, now: number): RateLimitVerdict {
  const record = failures.get(address);
  if (!record) return { allowed: true, retryAfterSeconds: 0 };

  const elapsed = now - record.since;
  if (elapsed >= WINDOW_MS) {
    failures.delete(address);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (record.count < MAX_FAILURES) return { allowed: true, retryAfterSeconds: 0 };

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)),
  };
}

function recordLocally(address: string, now: number): void {
  const record = failures.get(address);

  if (!record || now - record.since >= WINDOW_MS) {
    if (failures.size >= MAX_TRACKED) {
      const oldest = failures.keys().next();
      if (!oldest.done) failures.delete(oldest.value);
    }
    failures.set(address, { count: 1, since: now });
    return;
  }

  record.count += 1;
}

function clearLocally(address: string): void {
  failures.delete(address);
}

/* ── In the shared store ─────────────────────────────────────────────────── */

interface SharedStore {
  url: string;
  token: string;
}

/** Long enough for a healthy store anywhere; short enough that a sick one does not hold up sign-in. */
const STORE_TIMEOUT_MS = 2_000;

const KEY_PREFIX = "faborch-pwa:login-failures:";

/** The same loopback exception `foBaseUrl()` makes, for a store emulator on this machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Count a failure and start the window on the first one, as one atomic step.
 *
 * INCR and PEXPIRE sent as two commands leave a gap in which the key exists
 * with no expiry — and a key with no expiry is an address locked out forever.
 * The expiry is set whenever it is missing, not only when the count is 1, so a
 * key that ever lost its expiry heals on its next failure.
 */
const RECORD_FAILURE = [
  "local n = redis.call('INCR', KEYS[1])",
  "if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
  "return n",
].join("\n");

function sharedStore(): SharedStore | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * The name an address is counted under in the shared store.
 *
 * A keyed digest rather than the address itself: the store is a third-party
 * service, and an IP address is personal data. Keyed with this app's signing
 * secret, because an unkeyed hash of an address is no disguise at all — the
 * whole IPv4 space can be hashed in seconds.
 */
function storeKey(address: string): string {
  const secret = process.env.SESSION_SIGNING_SECRET ?? "";
  return KEY_PREFIX + createHmac("sha256", secret).update(address).digest("base64url").slice(0, 22);
}

/** How often an outage of the store may write to the log. */
const COMPLAINT_EVERY_MS = 60_000;
let lastComplaint = 0;

async function withSharedStore<T>(
  shared: (store: SharedStore) => Promise<T>,
  local: () => T,
): Promise<T> {
  const store = sharedStore();
  if (!store) return local();

  try {
    return await shared(store);
  } catch (error) {
    // At most once a minute: during an outage every sign-in would otherwise
    // write the same line, which buries the one that says when it began.
    // `reportError` throttles the alert on its own; this throttles the log.
    const now = Date.now();
    if (now - lastComplaint > COMPLAINT_EVERY_MS) {
      lastComplaint = now;
      reportError("rate-limit/store", error, { fallback: "counting in this process" });
    }
    return local();
  }
}

/** One call to Upstash's REST API: `""` for a single command, `/pipeline` for several. */
async function command(store: SharedStore, path: "" | "/pipeline", body: unknown): Promise<unknown> {
  const target = new URL(`${store.url}${path}`);
  // The token travels with every call, so the store gets the same rule as
  // FabOrchestrator: https, or a store on this machine.
  if (target.protocol !== "https:" && !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error("UPSTASH_REDIS_REST_URL must be https: the token travels with every call.");
  }

  const res = await fetch(target, {
    method: "POST",
    headers: { Authorization: `Bearer ${store.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`the store answered HTTP ${res.status}`);
  return res.json();
}

/** One reply, `{ result }` or `{ error }`, as a value or a throw. */
function resultOf(reply: unknown): unknown {
  if (!reply || typeof reply !== "object") throw new Error("the store's reply was not a result");
  const { result, error } = reply as { result?: unknown; error?: unknown };
  if (typeof error === "string") throw new Error(`the store refused the command: ${error}`);
  return result;
}

async function sharedCheck(store: SharedStore, key: string): Promise<RateLimitVerdict> {
  const replies = await command(store, "/pipeline", [
    ["GET", key],
    ["PTTL", key],
  ]);
  if (!Array.isArray(replies) || replies.length !== 2) {
    throw new Error("the store's reply was not a two-command pipeline");
  }

  const count = Number(resultOf(replies[0]) ?? 0);
  const ttlMs = Number(resultOf(replies[1]));
  if (!(count >= MAX_FAILURES)) return { allowed: true, retryAfterSeconds: 0 };

  return {
    allowed: false,
    retryAfterSeconds: ttlMs > 0 ? Math.max(1, Math.ceil(ttlMs / 1000)) : Math.ceil(WINDOW_MS / 1000),
  };
}

async function sharedRecord(store: SharedStore, key: string): Promise<void> {
  resultOf(await command(store, "", ["EVAL", RECORD_FAILURE, "1", key, String(WINDOW_MS)]));
}

async function sharedClear(store: SharedStore, key: string): Promise<void> {
  resultOf(await command(store, "", ["DEL", key]));
}
