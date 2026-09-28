import { foFingerprint } from "../auth";
import { createTtlCache } from "../ttl-cache";
import { foConversations } from "./client";
import { toSummaries } from "./history";

/**
 * Does this operator own that conversation?
 *
 * ── Why this function exists at all ─────────────────────────────────────────
 * `claudeai_athena/app/api/chat/route.ts` accepts a `conversationId` and never
 * checks whose it is. There is no `getConversation` in that route and no
 * `userId` comparison; the value goes straight to `addMessage` (`:338`, `:947`)
 * and to the S3-reference lookup (`:571`). So an authenticated FabOrchestrator
 * user who knows another user's conversation UUID can write turns into it, and
 * can have that thread's presigned file URLs folded into their own system
 * prompt.
 *
 * Every *other* conversation route in FabOrchestrator checks ownership properly
 * — `GET`, `PATCH` and `DELETE` all compare `conversation.userId !== user.id`
 * and refuse. `/api/chat` is the one that does not.
 *
 * That is FabOrchestrator's to fix and this app must not paper over it. What
 * this app must do is refuse to be the vehicle: **no id from a browser reaches
 * FO unless it has been proved to belong to the caller.** Same rule as
 * `foAgent()` and `lib/return-path.ts` — a value from a request *selects* from
 * a set the server derived, it never *becomes* the destination.
 *
 * ── Why a list read rather than something cheaper ───────────────────────────
 * There is nothing cheaper that is also correct. FO exposes no "does this
 * belong to me" endpoint, and `GET /api/conversations/{id}` would fetch the
 * whole thread with every tool part — 1.3 MB, measured — to answer a yes/no.
 * The list is 28 KB for 104 rows and is the same call the drawer makes.
 *
 * ── A proof is remembered; a refusal is not (2026-09-28) ────────────────────
 * That list used to be downloaded before *every* question, growing with every
 * thread the operator starts, to answer the same yes/no it answered one
 * question earlier. The answer cannot change: a conversation's owner is fixed
 * when FabOrchestrator creates it. So a `true` is remembered, per session and
 * per conversation, and the next question in the same thread skips the
 * download.
 *
 * A `false` is never remembered, and that asymmetry is load-bearing. The screen
 * creates a conversation and asks its first question a moment later; a
 * remembered "not yours" from before it existed would send that question
 * unpersisted. An unproved id is checked again every time, exactly as before.
 *
 * Remembered for five minutes rather than for good, because one thing can
 * change: the operator can delete the thread in the FabOrchestrator website.
 * FO's deletes are soft, so a question sent into a deleted thread inside that
 * window is written somewhere nobody will look, rather than failing. Five
 * minutes bounds how long that can happen.
 */
export const OWNERSHIP_TTL_MS = 5 * 60_000;

/** Small entries, one per session and thread actually being asked in. */
const proved = createTtlCache<true>(OWNERSHIP_TTL_MS, 5_000);

function proofKey(token: string, id: string, agent: string): string {
  return `${foFingerprint(token)}:${agent}:${id}`;
}

export async function ownsConversation(
  token: string,
  id: string,
  agent = "chat",
): Promise<boolean> {
  if (proved.get(proofKey(token, id, agent))) return true;

  try {
    const rows = toSummaries(await foConversations(token, agent));
    const owned = rows.some((row) => row.id === id);
    if (owned) proved.set(proofKey(token, id, agent), true);
    return owned;
  } catch {
    // FO unreachable, or the session gone. Not a licence to proceed: an
    // unproved id is refused, and the turn is sent unpersisted instead.
    return false;
  }
}

/**
 * Record that this session owns a conversation FabOrchestrator just created
 * for it.
 *
 * FO made it for the token's own user, so the create call is itself the proof.
 * Without this, the first question in every new conversation — which follows
 * the create by a moment — would download the whole list to learn what the app
 * had just been told.
 */
export function rememberOwnership(token: string, id: string, agent = "chat"): void {
  proved.set(proofKey(token, id, agent), true);
}

/** Test seam. Nothing in the app calls this. */
export function resetOwnershipCache(): void {
  proved.clear();
}
