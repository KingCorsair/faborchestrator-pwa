/**
 * Every way this app can fail to answer, in one table.
 *
 * ── Why one table ───────────────────────────────────────────────────────────
 * The failure modes were spread across the proxy, the stream reader and the
 * screen, each deciding its own wording. That is how an app ends up saying
 * "something went wrong" — not because anyone chose to, but because no single
 * place knew what the alternatives were. This module is that place: the codes,
 * what each one means, and what the operator should do about it.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * Exactly one shape crosses the boundary between the proxy and the screen:
 *
 *     { code: PwaErrorCode, error: string, errorId?: string }
 *
 * `error` is **always a string**. FabOrchestrator has two error envelopes and
 * one of them nests an object under `error`; rendering that as a React child
 * produced `[object Object]` on screen. `foErrorMessage` in `client.ts` is what
 * flattens it, and the proxy tests assert the result is a string for every
 * hostile body they can invent.
 *
 * ── Client-safe ─────────────────────────────────────────────────────────────
 * Pure strings and one regex. No imports, so the screen and the route can share
 * it without either dragging the other's dependencies along.
 */

/**
 * Every failure the screen can be asked to render.
 *
 * Ordered as a turn meets them: configuration, then identity, then the
 * platform's own refusals, then the transport.
 */
export type PwaErrorCode =
  /** `FABORCH_BASE_URL` is unset or not https. A deployment fault. */
  | "not_configured"
  /** Signed in here, but not to FabOrchestrator. */
  | "no_faborch_session"
  /** FO rejected the token — expired, or evicted after 30 idle minutes. */
  | "faborch_session_expired"
  /** FO refused the request itself: a role restriction, an invalid parameter. */
  | "faborch_rejected"
  /** FO forbade this operator. Its message names the permission to grant. */
  | "agent_forbidden"
  /** A daily request or token limit. Waiting fixes it; retrying does not. */
  | "quota_exceeded"
  /** FO is unreachable, or answered with an error of its own. */
  | "faborch_unavailable"
  /** The stream ended part-way. Whatever arrived is kept. */
  | "connection_lost"
  /** No frame of any kind for 45 seconds — three missed keep-alives. */
  | "stream_stalled"
  /** This app sent something FO would not accept. Should never be user-visible. */
  | "bad_request";

/**
 * What the operator should do next, per code.
 *
 * Every entry answers "and now what?", because a message that does not is what
 * sends somebody to find whoever set the demo up. Kept separate from the
 * message itself: the message is often FabOrchestrator's own words, relayed
 * verbatim because they name the permission or the limit, and this is ours.
 */
export const NEXT_STEP: Record<PwaErrorCode, string> = {
  not_configured:
    "This is a deployment setting, not your account. Nothing you can type will fix it — " +
    "it needs whoever set this app up.",
  no_faborch_session: "Sign in with your FabOrchestrator account to continue.",
  faborch_session_expired:
    "Sessions end after 30 minutes of inactivity, which a pocketed phone reaches easily. " +
    "Sign in again and carry on.",
  faborch_rejected:
    "FabOrchestrator would not accept the request as sent. The message above is its own " +
    "and usually says what to change.",
  agent_forbidden:
    "Your role does not carry this permission. The message above names it, so an " +
    "administrator can grant it.",
  quota_exceeded: "The limit resets on its own. Retrying now will not help; try later.",
  faborch_unavailable:
    "This is usually temporary. Try again in a moment — if it persists, the platform " +
    "needs attention.",
  connection_lost: "Anything that arrived is kept above. Ask again to get the rest.",
  stream_stalled:
    "FabOrchestrator has not sent anything for 45 seconds. A long tool call can be slow, " +
    "so waiting may still work — or stop and ask again.",
  bad_request:
    "This app sent something FabOrchestrator would not accept, which is a fault here " +
    "rather than in what you typed.",
};

/**
 * Codes worth offering a retry for.
 *
 * Deliberately not all of them. Retrying a quota does nothing but spend another
 * request against a limit that has not moved, and retrying a permission refusal
 * asks the same question of the same role. Offering a button that cannot work
 * is worse than offering none, because it invites the operator to keep pressing
 * it instead of telling somebody.
 */
export const RETRYABLE: ReadonlySet<PwaErrorCode> = new Set<PwaErrorCode>([
  "faborch_unavailable",
  "connection_lost",
  "stream_stalled",
]);

/** Codes that mean "sign in again", so the screen offers that instead of a retry. */
export const NEEDS_SIGN_IN: ReadonlySet<PwaErrorCode> = new Set<PwaErrorCode>([
  "no_faborch_session",
  "faborch_session_expired",
]);

/**
 * Map an HTTP status from FabOrchestrator onto a code.
 *
 * Only the statuses FO actually uses are distinguished. Everything else is
 * `faborch_unavailable`, which is honest: the app does not know what happened
 * and should not invent a specific-sounding explanation.
 *
 * 401 is deliberately absent — the proxy handles it before this is reached,
 * because expiry has a side effect (dropping the cookie) that a pure mapping
 * function should not be responsible for.
 */
export function codeForStatus(status: number): PwaErrorCode {
  if (status === 400) return "faborch_rejected";
  if (status === 403) return "agent_forbidden";
  if (status === 429) return "quota_exceeded";
  return "faborch_unavailable";
}

/**
 * The HTTP status this app answers with, given a code.
 *
 * The proxy's own status, not FabOrchestrator's — they agree here by design, so
 * a 429 stays a 429 and a client can tell "wait" from "broken" without reading
 * the body.
 */
export function statusForCode(code: PwaErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "no_faborch_session":
    case "faborch_session_expired":
      return 401;
    case "agent_forbidden":
      return 403;
    case "quota_exceeded":
      return 429;
    case "not_configured":
      return 503;
    case "faborch_rejected":
      return 400;
    default:
      return 502;
  }
}

/**
 * FabOrchestrator's error ids, pulled out of the message they arrive in.
 *
 * FO's `onError` returns `"<user message> (errorId=<uuid>)"` for anything that
 * goes through its error catalog, and that id is **the only handle support has**
 * into `error_audit_logs`. Left inside the sentence it is noise a supervisor
 * will not transcribe correctly; split out, the screen can show it as something
 * to copy.
 *
 * The id is matched loosely rather than as a strict UUID: FO's catalog is a
 * database table and the format is its business, not this app's. What matters
 * is that the sentence reads cleanly and the id survives.
 */
const ERROR_ID = /\s*\(errorId=([^)]+)\)\s*/i;

export function splitErrorId(message: string): { message: string; errorId?: string } {
  const match = ERROR_ID.exec(message);
  if (!match) return { message: message.trim() };

  const errorId = match[1]?.trim();
  const withoutId = message.replace(ERROR_ID, " ").replace(/\s+/g, " ").trim();

  return {
    // A message that was *only* an error id would otherwise become empty, and
    // an empty error is worse than a technical one.
    message: withoutId || message.trim(),
    ...(errorId ? { errorId } : {}),
  };
}
