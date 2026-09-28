/**
 * Which data connections an operator's questions may use — asked of
 * FabOrchestrator at most once every five minutes per session, not before every
 * question.
 *
 * ── Why this is remembered at all (2026-09-28) ──────────────────────────────
 * `/api/chat` loads tools from `activeMcpIds` and nothing else, so the chat
 * route asks FO for the operator's connected MCP servers before forwarding a
 * turn. It used to ask before *every* turn: one more round trip to
 * FabOrchestrator per question, in series ahead of the answer, to learn
 * something that changes only when an administrator connects or removes a
 * server.
 *
 * ── Why five minutes ────────────────────────────────────────────────────────
 * The route's reason for asking every time still holds: a conversation must not
 * carry on for long without a tool an administrator connected mid-demo. But an
 * answer takes thirty seconds to two minutes to stream, and the operator reads
 * it before asking the next — so follow-ups arrive minutes apart, and a
 * one-minute memory would have expired before almost every one of them.
 *
 * Five minutes is still far fresher than the product: FabOrchestrator's own
 * chat asks once, when the page mounts, and keeps the answer for the whole
 * session (`claudeai_athena/components/full-chat-app.tsx:722-746`). That is
 * also why a list a few minutes stale is safe to send — the product sends one
 * as stale as the page is old, every day.
 *
 * ── What is never remembered ────────────────────────────────────────────────
 * A failed lookup. `foConnectedMcpIds` answers null when FO could not be asked,
 * and the turn goes ahead without tools as it always has — but that is not an
 * answer about the operator, and remembering it would strip their tools for
 * five minutes after one bad request.
 *
 * Keyed by a fingerprint of the FO token, never the token itself, so each
 * session is only ever told what FO said about that session.
 */

import { foFingerprint } from "../auth";
import { createTtlCache } from "../ttl-cache";
import { foConnectedMcpIds } from "./client";

export const TOOL_LIST_TTL_MS = 5 * 60_000;

/** One entry per signed-in session, and each is a short list of ids. */
const remembered = createTtlCache<string[]>(TOOL_LIST_TTL_MS, 1_000);

/** The operator's connected MCP ids: remembered if FO said so in the last five minutes. */
export async function connectedMcpIds(token: string): Promise<string[]> {
  const key = foFingerprint(token);
  const known = remembered.get(key);
  if (known) return known;

  const ids = await foConnectedMcpIds(token);
  if (ids === null) return [];
  remembered.set(key, ids);
  return ids;
}

/** Test seam. Nothing in the app calls this. */
export function resetToolCache(): void {
  remembered.clear();
}
