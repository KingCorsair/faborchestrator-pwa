/**
 * The seat rule: a conversation belongs to the device that started it
 * (PWA-side conversation isolation, 1 October 2026).
 *
 * ── What it adds, and what it leaves alone ──────────────────────────────────
 * Several people may sign in with the same FabOrchestrator account
 * (`lib/faborch/device.ts`). FabOrchestrator sees one user and would show each
 * of them every conversation. This file is the rule the gateway applies in
 * front of it, so that inside this app each device sees and uses only its own:
 *
 *   GET  /api/conversations            the answer is cut down to this seat's rows
 *   POST /api/conversations            the new id is recorded as this seat's
 *                                      before the phone is told it exists
 *   anything under /api/conversations/{id}   refused unless {id} is this seat's
 *   POST /api/chat, /api/modeling-agent/chat refused when the body names a
 *                                      conversation that is not this seat's
 *
 * **FabOrchestrator is not changed and not told.** Every request that passes
 * is forwarded exactly as before: same body, same token, same model, same plant
 * data. The rule only ever *removes* rows from one list and *refuses* requests;
 * it never rewrites a question or an answer.
 *
 * ── Fail closed, everywhere ─────────────────────────────────────────────────
 *  · A conversation with no record in the seat store is nobody's: hidden from
 *    every list and refused to every seat. That includes every conversation
 *    that existed before this rule, and any started on FabOrchestrator's own
 *    site. They are untouched in FabOrchestrator and still visible there.
 *  · A session with no seat (minted before this rule) cannot use a conversation
 *    route at all: it is ended, and the next sign-in has a seat.
 *  · If the store cannot be read or written, conversation routes answer 503.
 *    A new conversation whose ownership could not be stored is deleted again
 *    in FabOrchestrator rather than left unowned.
 *  · A list this app cannot parse is not passed through: it would be unfiltered.
 *
 * ── What this rule does not cover ───────────────────────────────────────────
 * `/api/messages/feedback` names a message id and `/api/files/{id}` a file id;
 * neither names a conversation, so neither can be tied to a seat here. Both ids
 * are random and reach a browser only inside a conversation its seat owns.
 * `/api/artifacts` is denied outright (`lib/gateway/registry.ts`):
 * FabOrchestrator's client never calls it. Memory, settings, usage limits and
 * MCP connections stay shared by account. Signing in at FabOrchestrator's own
 * site shows everything, as it always did: this is privacy inside this app.
 */

import { foDeleteConversation } from "@/lib/faborch/client";
import {
  isConversationId,
  seatStore,
  SeatStoreUnavailableError,
  type ClaimResult,
} from "@/lib/gateway/seat-store";
import { idPrefix, logEvent, reportError } from "@/lib/report-error";

const COLLECTION = "/api/conversations";

/** The two FabOrchestrator endpoints that take a `conversationId` in a body. */
const CHAT_PATHS = new Set<string>(["/api/chat", "/api/modeling-agent/chat"]);

/** What the seat rule has to do for a request, decided from its path and method alone. */
export type SeatGate =
  /** Not a conversation route. Nothing to do. */
  | { kind: "none" }
  /** The conversation list: the answer must be filtered. */
  | { kind: "list" }
  /** A new conversation: its id must be recorded. */
  | { kind: "create" }
  /** One conversation, named in the path. */
  | { kind: "conversation"; id: string }
  /** A chat turn: the conversation, if any, is named in the body. */
  | { kind: "chat" }
  /** A conversation route that names no single valid conversation. Refused. */
  | { kind: "refuse" };

export function seatGateFor(pathname: string, method: string): SeatGate {
  const verb = method.toUpperCase();
  if (pathname === COLLECTION) {
    if (verb === "GET") return { kind: "list" };
    if (verb === "POST") return { kind: "create" };
    // No body comes back from these, and FabOrchestrator has no handler that acts on them.
    if (verb === "HEAD" || verb === "OPTIONS") return { kind: "none" };
    return { kind: "refuse" };
  }
  if (pathname.startsWith(`${COLLECTION}/`)) {
    const segment = pathname.slice(COLLECTION.length + 1).split("/")[0] ?? "";
    let id: string;
    try {
      id = decodeURIComponent(segment);
    } catch {
      return { kind: "refuse" };
    }
    return isConversationId(id) ? { kind: "conversation", id } : { kind: "refuse" };
  }
  if (verb === "POST" && CHAT_PATHS.has(pathname)) return { kind: "chat" };
  return { kind: "none" };
}

/**
 * The conversation a chat body names, when it names one with a valid id.
 *
 * Null for everything else: a body that is not a JSON object, no
 * `conversationId`, or one that is not a conversation id. Those cases are not
 * this rule's: the ownership check (`lib/gateway/ownership.ts`) refuses a
 * malformed id, and a turn with no conversation writes into none.
 */
export function conversationIdInChatBody(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const id = (parsed as Record<string, unknown>).conversationId;
  return isConversationId(id) ? id : null;
}

/** One of the seat rule's own refusals, in the gateway's coded shape. */
export interface SeatRefusal {
  status: 403 | 503;
  code: "conversation_forbidden" | "ownership_unavailable";
  error: string;
  retryAfterSeconds?: number;
}

/** The same answer the ownership check gives for a conversation that is not the caller's. */
export const SEAT_FORBIDDEN: SeatRefusal = {
  status: 403,
  code: "conversation_forbidden",
  error: "This conversation is no longer available or is not yours to continue. Start a new conversation.",
};

export const SEAT_UNAVAILABLE: SeatRefusal = {
  status: 503,
  code: "ownership_unavailable",
  error: "Conversations could not be checked just now. Try again in a moment.",
  retryAfterSeconds: 15,
};

function storeFailure(where: string, error: unknown, pathname: string): SeatRefusal {
  reportError(where, error, {
    path: pathname,
    configured: !(error instanceof SeatStoreUnavailableError) || error.cause !== undefined,
  });
  return SEAT_UNAVAILABLE;
}

/**
 * May this seat use this conversation? Null when it may; a refusal otherwise.
 * An unmapped conversation is refused exactly like somebody else's.
 */
export async function refusalForConversation(seat: string, id: string, pathname: string): Promise<SeatRefusal | null> {
  let owned: boolean;
  try {
    owned = await seatStore().isOwnedBy(id, seat);
  } catch (error) {
    return storeFailure("gateway/seat-store-read", error, pathname);
  }
  if (owned) return null;
  logEvent("warn", "seat_refused", { path: pathname, idPrefix: idPrefix(id), seat: idPrefix(seat) });
  return SEAT_FORBIDDEN;
}

/**
 * Is the store usable at all? Asked before FabOrchestrator is asked to create
 * or list anything, so a store that is down costs no upstream work and leaves
 * no unowned conversation behind.
 */
export async function refusalIfStoreDown(pathname: string): Promise<SeatRefusal | null> {
  try {
    await seatStore().stats();
    return null;
  } catch (error) {
    return storeFailure("gateway/seat-store-read", error, pathname);
  }
}

/**
 * Cut a conversation list down to the rows this seat owns.
 *
 * `body` is FabOrchestrator's successful answer to `GET /api/conversations`:
 * an array of rows, or an object holding one under `conversations`. A row is
 * kept only when its `id` is a string the store says is this seat's. Anything
 * this cannot read as a list is **not** returned: an unfiltered list is the one
 * thing this must never emit.
 */
export async function filterListForSeat(
  body: string,
  seat: string,
  pathname: string,
): Promise<{ ok: true; body: string; ids: string[] } | { ok: false; refusal: SeatRefusal }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    reportError("gateway/seat-list-unreadable", new Error("the conversation list was not JSON"), { path: pathname });
    return { ok: false, refusal: SEAT_UNAVAILABLE };
  }
  const wrapped =
    !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { conversations?: unknown }).conversations
      : undefined;
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(wrapped) ? wrapped : null;
  if (!rows) {
    reportError("gateway/seat-list-unreadable", new Error("the conversation list had an unexpected shape"), {
      path: pathname,
    });
    return { ok: false, refusal: SEAT_UNAVAILABLE };
  }

  const kept: unknown[] = [];
  const ids: string[] = [];
  try {
    const store = seatStore();
    for (const row of rows) {
      const id = row && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
      if (typeof id !== "string") continue;
      if (await store.isOwnedBy(id, seat)) {
        kept.push(row);
        ids.push(id);
      }
    }
  } catch (error) {
    return { ok: false, refusal: storeFailure("gateway/seat-store-read", error, pathname) };
  }

  const filtered = Array.isArray(parsed) ? kept : { ...(parsed as object), conversations: kept };
  return { ok: true, body: JSON.stringify(filtered), ids };
}

/**
 * Record a conversation FabOrchestrator has just created as this seat's.
 *
 * `body` is the 2xx answer to `POST /api/conversations`. Resolves `ok` only
 * once the ownership record is on disk. On any failure the conversation is
 * deleted again in FabOrchestrator (best effort, with the caller's own token)
 * so that nothing is left that no seat owns, and the caller answers 503.
 */
export async function claimCreatedConversation(
  body: string,
  seat: string,
  foToken: string,
  pathname: string,
): Promise<{ ok: true; id: string } | { ok: false; refusal: SeatRefusal }> {
  let id: unknown;
  try {
    id = (JSON.parse(body) as { id?: unknown } | null)?.id;
  } catch {
    id = undefined;
  }
  if (!isConversationId(id)) {
    // FabOrchestrator made something this app cannot name, so cannot own or undo.
    reportError("gateway/seat-create-unreadable", new Error("a created conversation had no usable id"), {
      path: pathname,
    });
    return { ok: false, refusal: SEAT_UNAVAILABLE };
  }

  let result: ClaimResult | null = null;
  let failure: unknown = null;
  try {
    result = await seatStore().claim(id, seat);
  } catch (error) {
    failure = error;
  }
  if (result === "claimed" || result === "already-own") {
    logEvent("info", "seat_claimed", { path: pathname, idPrefix: idPrefix(id), seat: idPrefix(seat) });
    return { ok: true, id };
  }

  // Not stored, or already another seat's: this seat must not get it, and it
  // must not be left behind for nobody.
  const undone = await foDeleteConversation(foToken, id);
  reportError(
    "gateway/seat-claim-failed",
    failure ?? new Error("the new conversation's id is already another seat's"),
    { path: pathname, idPrefix: idPrefix(id), seat: idPrefix(seat), conflict: result === "conflict", undone },
  );
  return { ok: false, refusal: SEAT_UNAVAILABLE };
}

/**
 * Read a response body to its end, up to `limit` bytes. Null when it is larger:
 * the caller then refuses rather than work from a cut-off answer.
 */
export async function readBodyUpTo(body: ReadableStream<Uint8Array>, limit: number): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The most of a conversation list this will hold to filter it (the measured list is 55 KB). */
export const MAX_LIST_BYTES = 8 * 1024 * 1024;

/** A create's answer is one small object. */
export const MAX_CREATE_BYTES = 64 * 1024;
