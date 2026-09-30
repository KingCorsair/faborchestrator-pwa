/**
 * Conversation ownership, for the embedded chat (WP4).
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 * FabOrchestrator's `/api/chat` takes a `conversationId` and **never checks
 * whose it is**. Verified again on upstream `main` for WP4: that route contains
 * no `getConversation` and no `userId` comparison — zero matches — and the
 * value goes straight to `addMessage` and to the S3-reference lookup. Every
 * other conversation route in FabOrchestrator checks properly: `/api/artifacts`
 * compares `conversation.userId !== user.id`, and so do GET, PATCH and DELETE
 * on `/api/conversations/[id]`. `/api/chat` is the exception.
 *
 * This app already refuses to be the vehicle for it on its own proxy route
 * (`lib/faborch/owns.ts`, since the demo's WP1). **Embedding would have
 * reopened it**: FabOrchestrator's own client posts `/api/chat` through the
 * gateway with whatever `conversationId` it holds, and until this file the
 * gateway forwarded that body untouched. So the same rule is applied here —
 * an id from a browser reaches FabOrchestrator only once it has been proved to
 * belong to the caller.
 *
 * ── Refused, not stripped (plan RP6, 2026-09-30) ────────────────────────────
 * Until 2026-09-30 an unproved id was stripped and the turn forwarded without
 * it: the operator saw an answer that was never saved, and found the
 * conversation missing it later. That silently turned one request into a
 * different one. Now an unproved id is refused with a coded error the operator
 * can act on:
 *
 *   not a conversation id at all              400 invalid_request
 *   FabOrchestrator says not theirs, or gone  403 conversation_forbidden
 *   FabOrchestrator says the token is dead    401 faborch_session_expired
 *   FabOrchestrator could not be asked        503 ownership_unavailable
 *
 * **Fail closed**: forwarding an unproved id could write into somebody else's
 * thread, and stripping it would write into a different one. The cost of an
 * outage is a refused turn with `Retry-After`, not a misfiled one.
 *
 * The proof is FabOrchestrator's own per-conversation answer
 * (`foConversationProof`, `GET /api/conversations/{id}`), which checks
 * `userId` itself. The earlier proof read the caller's whole conversation
 * list, which FabOrchestrator caps at 1,000 rows (`applyRowCap`): past that,
 * a user's own older conversations could not be proved at all.
 *
 * ── Why positive results are cached and negative ones never are ─────────────
 * Proving ownership costs a read from FabOrchestrator, and a chat turn cannot
 * afford one serially on every message. But a cache that can answer "no" from
 * memory would break the ordinary flow: FabOrchestrator's client creates a
 * conversation and immediately posts the first turn into it, and a "no" cached
 * a moment earlier would refuse it.
 *
 * So only "yes" is remembered, per token and id. A miss always costs a fresh
 * read, which is what makes a brand-new conversation work; a forged id is a
 * miss every time and can never be cached into a yes.
 *
 * A module-level Map, like `lib/rate-limit.ts`, for the same reason: this app
 * runs one machine (`fly.toml`), and a cache that vanishes on restart costs
 * one extra read rather than correctness.
 *
 * ── What WP8 measured, and the two things it changed ────────────────────────
 * This check is **the only work the gateway does that costs an upstream round
 * trip**, and against the preview it cost one: a chat turn carrying a
 * conversation id answered its first byte in 1,276 ms where the same turn
 * without an id answered in 708 ms. Two changes take that round trip off every
 * turn but the first, and neither weakens what is being proved:
 *
 *  1. **The list the client already fetches warms the cache.**
 *     FabOrchestrator's own sidebar calls `GET /api/conversations` before
 *     anybody can pick a thread to type into. The gateway reads the ids out of
 *     that answer as it streams past and remembers them. Nothing extra is
 *     requested, nothing is delayed, and the ids remembered are exactly the
 *     ids FabOrchestrator has just said belong to this token. A per-id read
 *     (up to 1.3 MB for a long thread) is therefore paid only on a cold cache.
 *
 *  2. **A positive lasts as long as the session that earned it.** The old TTL
 *     was 60 seconds — shorter than the gap between opening a thread and
 *     finishing a sentence, so a warmed entry would almost always have gone
 *     cold before it was needed. Ownership is not a credential and does not
 *     expire like one: FabOrchestrator never moves a conversation to another
 *     user, so "this token owns this id" stays true for as long as the token
 *     does. The TTL is therefore FabOrchestrator's own 30-minute idle eviction
 *     window — past which the token itself stops working and the entry stops
 *     being reachable at all.
 *
 * Neither changes the security property. Every entry is still only ever
 * written after FabOrchestrator itself said that id is this token's, and "no"
 * is still never cached — so an id that is not the caller's costs a fresh read
 * every single time, exactly as before, and can never be cached into a yes.
 *
 * ── Reconciled with the plan's RP6 cache, 2026-09-30 ────────────────────────
 * The `chetan` branch built a second ownership cache for the PWA's own chat
 * route (`owns.ts` there: five-minute positives keyed by token fingerprint,
 * warmed when a conversation is created). Rather than a second system, the
 * pieces of that capability that RP6 also designs are here, in the one cache
 * the embedded chat uses:
 *
 *  - **Keyed by `foFingerprint(token)`, not the token** (RP6: `own:<fp>:<id>`),
 *    so the cache does not hold live FabOrchestrator credentials in memory.
 *  - **Warmed from a create** (RP6 `warmFromCreate`): a 201 from
 *    `POST /api/conversations` passing through names an id FabOrchestrator
 *    just made for this token, so the first turn in it needs no lookup.
 *  - **Forgotten on a delete the gateway sees** (RP6 `forget(id)`), for every
 *    token, plus a **tombstone** for `T_own`: a positive whose proof or list
 *    read began before the delete is refused, so a lookup in flight when the
 *    delete lands cannot re-warm it.
 *  - **`T_own` is a parameter** (`OWNERSHIP_TTL_MS`, default 30 minutes as
 *    before; RP6 leaves the value to CP1, §9 question 21).
 *  - **A real bound**: least-recently-used eviction at `MAX_ENTRIES`, where
 *    the old threshold only swept expired entries.
 *
 * The per-conversation proof, the refusals and failing closed followed on
 * 2026-09-30 (above).
 */

import { z } from "zod";
import { foFingerprint } from "@/lib/auth";
import { foConversationProof } from "@/lib/faborch/client";
import { MAX_REQUEST_BODY_BYTES } from "@/lib/gateway/body-limit";
import { idPrefix, logEvent, reportError } from "@/lib/report-error";

/** The two FabOrchestrator endpoints that accept a `conversationId` in a body. */
const CHAT_PATHS = new Set<string>(["/api/chat", "/api/modeling-agent/chat"]);

/**
 * A conversation id, validated exactly as FabOrchestrator's own
 * `ChatRequestSchema` validates it (Zod 4 `uuid()`, RFC-strict). The modeling
 * route has no schema of its own, so the gateway must not rely on
 * FabOrchestrator's database layer to refuse anything else (RP6 part 2).
 */
const ConversationId = z.string().uuid();

/** How long to ask a phone to wait after FabOrchestrator could not be asked (RP6 part 3). */
const OWNERSHIP_RETRY_AFTER_S = 15;

/**
 * How long a proved "yes" is kept: RP6's `T_own` (WP8 set it to 30 minutes).
 *
 * FabOrchestrator evicts an idle session at 30 minutes, so a token idle for
 * longer no longer opens anything and an entry keyed by it is never read
 * again. Read on every use so an environment change needs no code change.
 */
export function ownershipTtlMs(): number {
  const value = Number(process.env.OWNERSHIP_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 30 * 60_000;
}

/**
 * The most entries the cache holds. Past it, the least recently used entry
 * goes first (RP6: a true bound, measured under RP10-B's load test L5).
 */
export const MAX_ENTRIES = 50_000;

/**
 * The most ids taken from a single conversation list.
 *
 * The measured list is 208 rows; this is generous against that and bounds what
 * one response can put in the map, so a malformed or enormous list cannot grow
 * this app's memory without limit.
 */
const MAX_WARMED_IDS = 2000;

/**
 * The most of a conversation list this will read in order to warm the cache.
 *
 * The measured list is 55 KB. Past this ceiling the copy is abandoned and the
 * cache simply stays cold — **the response itself is never truncated**, because
 * warming is an optimisation and the operator's data is not.
 */
const MAX_WARM_BYTES = 4 * 1024 * 1024;

/** `own:<fp>:<id>` → expiry instant. Map order is recency order (LRU). */
const owned = new Map<string, number>();

/**
 * Conversation id → when the gateway saw it deleted. Held for `T_own`, swept
 * on every insert, and never more than `MAX_TOMBSTONES` (oldest first past
 * it). Map order is insertion order, refreshed on a repeat delete, so the
 * oldest tombstone is always first. Until 30 September 2026 this map had no
 * bound and was pruned only when the same id was re-proved after `T_own`
 * (review of c193e9e, issue 4).
 */
const deletedAt = new Map<string, number>();

/** The most tombstones held. A delete is one round trip to FO per entry, so this is generous. */
export const MAX_TOMBSTONES = 10_000;

/** Only these paths have a body worth inspecting. */
export function needsOwnershipCheck(pathname: string, method: string): boolean {
  return method.toUpperCase() === "POST" && CHAT_PATHS.has(pathname);
}

const cacheKey = (token: string, id: string) => `own:${foFingerprint(token)}:${id}`;

/**
 * Remember that this token owns this conversation.
 *
 * `provedSince` is when the evidence was *asked for* (the lookup or the list
 * read began). A delete seen after that moment wins: the evidence predates it.
 */
function remember(token: string, id: string, provedSince: number = Date.now()): void {
  const tombstone = deletedAt.get(id);
  if (tombstone !== undefined) {
    if (tombstone + ownershipTtlMs() <= Date.now()) deletedAt.delete(id);
    else if (provedSince <= tombstone) return;
  }
  const key = cacheKey(token, id);
  owned.delete(key); // re-insert at the most recent end
  owned.set(key, Date.now() + ownershipTtlMs());
  while (owned.size > MAX_ENTRIES) {
    const oldest = owned.keys().next();
    if (oldest.done) break;
    owned.delete(oldest.value);
  }
}

function remembered(token: string, id: string): boolean {
  const key = cacheKey(token, id);
  const expires = owned.get(key);
  if (expires === undefined) return false;
  if (expires <= Date.now()) {
    owned.delete(key);
    return false;
  }
  owned.delete(key);
  owned.set(key, expires); // a hit is a use
  return true;
}

/**
 * A conversation was deleted through the gateway: forget it for every token
 * (RP6: an O(n) scan, deletes are rare) and hold a tombstone for `T_own`.
 *
 * Only an id that could ever be proved gets a tombstone: the proof accepts
 * UUIDs alone, so a tombstone for anything else would protect nothing and
 * would let a caller fill the map with junk one PATCH at a time. The positive
 * entries are still forgotten whatever the id looks like.
 */
export function forgetConversation(id: string, now: number = Date.now()): void {
  if (ConversationId.safeParse(id).success) {
    sweepTombstones(now);
    deletedAt.delete(id); // a repeat delete moves to the recent end
    deletedAt.set(id, now);
    while (deletedAt.size > MAX_TOMBSTONES) {
      const oldest = deletedAt.keys().next();
      if (oldest.done) break;
      deletedAt.delete(oldest.value);
    }
  }
  const suffix = `:${id}`;
  for (const key of owned.keys()) if (key.endsWith(suffix)) owned.delete(key);
}

/** Drop every tombstone older than `T_own`. Oldest first, so the scan stops at the first live one. */
function sweepTombstones(now: number): void {
  const ttl = ownershipTtlMs();
  for (const [id, at] of deletedAt) {
    if (at + ttl > now) break;
    deletedAt.delete(id);
  }
}

/** Testing seam. The cache is process-wide, and a test must not inherit another's. */
export function resetOwnershipCache(): void {
  owned.clear();
  deletedAt.clear();
}

/** Testing seam: how many entries the cache and the tombstone map hold, and whether any cache key contains `text`. */
export function ownershipCacheStats(text?: string): { size: number; tombstones: number; contains: boolean } {
  let contains = false;
  if (text) for (const key of owned.keys()) if (key.includes(text)) contains = true;
  return { size: owned.size, tombstones: deletedAt.size, contains };
}

export type OwnershipOutcome =
  /** No id in the body, or nothing to check. Forward the body unchanged. */
  | { action: "forward-unchanged" }
  /** The id is the caller's. Forward unchanged. */
  | { action: "forward-owned"; conversationId: string }
  /** FabOrchestrator no longer honours the token: the session is over. */
  | { action: "session-expired" }
  /** Refuse the turn with this coded answer; FabOrchestrator is sent nothing. */
  | {
      action: "refuse";
      status: 400 | 403 | 413 | 503;
      code: "invalid_request" | "conversation_forbidden" | "body_too_large" | "ownership_unavailable";
      error: string;
      retryAfterSeconds?: number;
    };

const REFUSE_INVALID: OwnershipOutcome = {
  action: "refuse",
  status: 400,
  code: "invalid_request",
  error: "That conversation reference is not valid. Start a new conversation.",
};

const REFUSE_FORBIDDEN: OwnershipOutcome = {
  action: "refuse",
  status: 403,
  code: "conversation_forbidden",
  error: "This conversation is no longer available or is not yours to continue. Start a new conversation.",
};

const REFUSE_UNAVAILABLE: OwnershipOutcome = {
  action: "refuse",
  status: 503,
  code: "ownership_unavailable",
  error: "FabOrchestrator could not confirm this conversation just now. Try again in a moment.",
  retryAfterSeconds: OWNERSHIP_RETRY_AFTER_S,
};

/**
 * Inspect a chat body and decide what FabOrchestrator may be told
 * (plan RP6 parts 2 and 3).
 *
 *   not JSON, not an object          forward unchanged (FabOrchestrator refuses it)
 *   `conversationId` absent or null  forward unchanged (FO starts or keeps its own)
 *   anything but a UUID string       400 invalid_request, FabOrchestrator not asked
 *   a remembered "yes"               forward
 *   FO 200 naming the same id        remember, forward
 *   FO 401                           the session is over
 *   FO 403 or 404                    403 conversation_forbidden
 *   anything else                    503 ownership_unavailable, fail closed
 */
export async function checkChatBody(
  pathname: string,
  raw: string,
  foToken: string,
): Promise<OwnershipOutcome> {
  // The route has already held the body to the policy; this is defence in
  // depth for any other caller.
  if (Buffer.byteLength(raw) > MAX_REQUEST_BODY_BYTES) {
    return {
      action: "refuse",
      status: 413,
      code: "body_too_large",
      error: "That is more than this app can send in one go.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON. FabOrchestrator will reject it on its own terms, and there is
    // no id in it to misuse, so this is not the gateway's argument to have.
    return { action: "forward-unchanged" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { action: "forward-unchanged" };
  }

  const id = (parsed as Record<string, unknown>).conversationId;
  if (id === undefined || id === null) return { action: "forward-unchanged" };
  if (typeof id !== "string" || !ConversationId.safeParse(id).success) {
    logEvent("warn", "ownership_invalid_id", { path: pathname });
    return REFUSE_INVALID;
  }

  if (remembered(foToken, id)) return { action: "forward-owned", conversationId: id };

  const askedAt = Date.now();
  const proof = await foConversationProof(foToken, id);
  const elapsedMs = Date.now() - askedAt;

  switch (proof.kind) {
    case "owned":
      remember(foToken, id, askedAt);
      logEvent("info", "ownership_lookup", { path: pathname, idPrefix: idPrefix(id), elapsedMs });
      return { action: "forward-owned", conversationId: id };
    case "session-expired":
      return { action: "session-expired" };
    case "not-owned":
      // RP10-A: an 8-character prefix only; a conversation id is access-bearing
      // at FO. `foStatus` separates a deleted conversation of the caller's own
      // (404) from somebody else's (403) in the log, never in the answer.
      logEvent("warn", "ownership_refused", {
        path: pathname,
        idPrefix: idPrefix(id),
        foStatus: proof.status,
        elapsedMs,
      });
      return REFUSE_FORBIDDEN;
    case "unavailable":
      reportError("gateway/ownership-unavailable", new Error("conversation ownership could not be proved"), {
        path: pathname,
        foStatus: proof.status,
        elapsedMs,
      });
      return REFUSE_UNAVAILABLE;
  }
}

// ── Warming the cache from the list the client already asked for (WP8) ───────

/** The reads whose answers name the caller's own conversations. */
const LIST_PATHS = new Set(["/api/conversations"]);

/**
 * Is this the request whose answer names the caller's conversations?
 *
 * Only `GET`, and only the collection — `/api/conversations/{id}` answers with
 * one thread and up to 1.3 MB of tool parts, which is not worth reading for a
 * single id that a chat turn would have proved anyway.
 */
export function isConversationList(pathname: string, method: string): boolean {
  return method.toUpperCase() === "GET" && LIST_PATHS.has(pathname);
}

/**
 * Remember every conversation id in a list FabOrchestrator just returned.
 *
 * `body` is the raw JSON of a **successful** list read made with `token`.
 * FabOrchestrator answers that call with only the caller's own conversations,
 * so every id in it is, by FabOrchestrator's own account, this token's.
 *
 * Anything unexpected is ignored rather than guessed at: a body that is not
 * JSON, or not a list of objects with string `id`s, warms nothing and leaves
 * the check to pay for its own read as before.
 *
 * Returns how many ids were remembered, which is what the tests assert on.
 */
export function rememberFromList(token: string, body: string, provedSince: number = Date.now()): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 0;
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { conversations?: unknown }).conversations)
      ? (parsed as { conversations: unknown[] }).conversations
      : null;
  if (!rows) return 0;

  let remembered = 0;
  for (const row of rows) {
    if (remembered >= MAX_WARMED_IDS) break;
    if (!row || typeof row !== "object") continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    remember(token, id, provedSince);
    remembered += 1;
  }
  return remembered;
}

/**
 * Pass a conversation-list response straight through, keeping a copy to learn
 * from once it has finished.
 *
 * The stream is **not** buffered and then re-emitted: each chunk is forwarded
 * the moment it arrives and only *also* copied aside, so the phone sees exactly
 * the timing it would have seen without this. Past `MAX_WARM_BYTES` the copy is
 * dropped and forwarding carries on untouched — the same shape as
 * `injectShellScript`, and for the same reason: what the operator asked for
 * must never depend on what this app wanted to learn.
 */
export function warmFromListStream(
  body: ReadableStream<Uint8Array>,
  token: string,
  provedSince: number = Date.now(),
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const decoder = new TextDecoder();
  let copy = "";
  let overflowed = false;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
        if (overflowed) return;
        copy += decoder.decode(chunk, { stream: true });
        if (copy.length > MAX_WARM_BYTES) {
          overflowed = true;
          copy = "";
        }
      },
      flush() {
        if (overflowed) return;
        copy += decoder.decode();
        // A failure to learn is not a failure to answer: the response has
        // already been delivered in full by the time this runs.
        try {
          rememberFromList(token, copy, provedSince);
        } catch {
          /* the check pays for its own read, as it did before WP8 */
        }
      },
    }),
  );
}

// ── Warming from a create, forgetting on a delete (RP6) ─────────────────────

/** `POST /api/conversations`: FabOrchestrator creates a conversation for the caller. */
export function isConversationCreate(pathname: string, method: string): boolean {
  return method.toUpperCase() === "POST" && LIST_PATHS.has(pathname);
}

/** The conversation id a `/api/conversations/{id}` path names, or null. */
function conversationIdIn(pathname: string): string | null {
  const match = /^\/api\/conversations\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null; // malformed percent-encoding names no conversation
  }
}

/** The id a `DELETE /api/conversations/{id}` names, or null for anything else. */
export function deletedConversationId(pathname: string, method: string): string | null {
  return method.toUpperCase() === "DELETE" ? conversationIdIn(pathname) : null;
}

/**
 * The id a `PATCH /api/conversations/{id}` names when FabOrchestrator refused
 * it with 403: not this caller's, or no longer anyone's (RP6 part 1). Null for
 * anything else.
 */
export function refusedConversationId(pathname: string, method: string, status: number): string | null {
  return method.toUpperCase() === "PATCH" && status === 403 ? conversationIdIn(pathname) : null;
}

/** A create's answer is one small object; anything past this is not one. */
const MAX_CREATE_BYTES = 64 * 1024;

/**
 * Remember the id in a 201 from `POST /api/conversations` (RP6 `warmFromCreate`).
 *
 * FabOrchestrator made that conversation for this token's own user, so the
 * create is itself the proof, and the first turn in the new thread needs no
 * lookup. The chetan branch's `rememberOwnership` did the same for the PWA's
 * own chat route. Passed through chunk by chunk like the list, never delayed.
 */
export function warmFromCreateStream(
  body: ReadableStream<Uint8Array>,
  token: string,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const decoder = new TextDecoder();
  let copy = "";
  let overflowed = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
        if (overflowed) return;
        copy += decoder.decode(chunk, { stream: true });
        if (copy.length > MAX_CREATE_BYTES) {
          overflowed = true;
          copy = "";
        }
      },
      flush() {
        if (overflowed) return;
        copy += decoder.decode();
        try {
          const id = (JSON.parse(copy) as { id?: unknown } | null)?.id;
          if (typeof id === "string" && id !== "") remember(token, id);
        } catch {
          /* not the shape expected: the first turn pays for its own lookup */
        }
      },
    }),
  );
}
