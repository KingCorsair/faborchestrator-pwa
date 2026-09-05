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
 */
export async function ownsConversation(
  token: string,
  id: string,
  agent = "chat",
): Promise<boolean> {
  try {
    const rows = toSummaries(await foConversations(token, agent));
    return rows.some((row) => row.id === id);
  } catch {
    // FO unreachable, or the session gone. Not a licence to proceed: an
    // unproved id is refused, and the turn is sent unpersisted instead.
    return false;
  }
}
