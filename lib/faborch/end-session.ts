/**
 * Ending a session on the server (plan RP2, `endServerSession`).
 *
 * Every exit from a session runs through here — sign-out, and the gateway
 * refusing a bearer whose session has ended — so every exit happens in the
 * same order, and **the order is the rule**:
 *
 *  1. **Clear local state first.** The cleared cookie is written onto the
 *     response and the response goes back at once. Without the cookie the
 *     browser holds nothing, and this app's bearer is inert too, because it is
 *     only accepted beside the matching FO cookie. This half cannot fail and
 *     cannot be slowed down by FabOrchestrator.
 *  2. **Then revoke at FabOrchestrator**, after the response (Next's
 *     `after()`), under the `revoke` time limit, never tied to the phone's
 *     connection: a revoke has nobody waiting on it and must finish even if
 *     the phone has gone.
 *  3. **Record the outcome**: a `session_end` line with the token's
 *     fingerprint prefix, never the token. A failed revoke is not retried:
 *     FabOrchestrator's own idle rule refuses the token on any later use.
 *
 * Kept apart from `lib/faborch/session.ts` on purpose: that file is imported by
 * `proxy.ts` for the cookie name, and the proxy has no business loading the
 * FabOrchestrator client.
 */

import { after, type NextResponse } from "next/server";
import { foFingerprint, SessionConfigError, sessionKeyRing } from "@/lib/auth";
import { foLogout } from "@/lib/faborch/client";
import { clearFoTokenCookie, sessionCookieGraceSeconds } from "@/lib/faborch/session";
import { logEvent } from "@/lib/report-error";

/** Why a session ended, as the `session_end` log line records it. */
export type SessionEndReason =
  /** The operator signed out, or a client-side end of session told the server. */
  | "user"
  | "pwa_expired"
  | "fo_expired"
  | "token_missing"
  | "storage_unavailable"
  | "fo_signed_out"
  /** The gateway refused a bearer whose session had ended (G5). */
  | "gateway_refusal"
  /** A session with no seat (minted before 1 October 2026) asked for a conversation route. */
  | "no_seat"
  /** A new sign-in on this browser replaced an older session (RP2 login step 3). */
  | "replaced"
  /** Sign-in's `/me` probe refused the token FabOrchestrator had just issued. */
  | "probe_inactive"
  | "probe_unexpected"
  /** FabOrchestrator still holds the account for a password change after one was made. */
  | "password_change_required"
  /** Sign-in failed after FabOrchestrator had issued a token. */
  | "login_failed"
  /** The device is not (or no longer) approved: its blocked page ends the session. */
  | "device_blocked";

/** The reasons a client may name when it asks the server to end a session. */
export const CLIENT_END_REASONS: ReadonlySet<SessionEndReason> = new Set([
  "user",
  "pwa_expired",
  "fo_expired",
  "token_missing",
  "storage_unavailable",
  "fo_signed_out",
  "device_blocked",
]);

/**
 * Clear this app's session on `res` now, and revoke FabOrchestrator's token
 * after the response has gone. `foToken` is the token read from the request's
 * cookie; null means there is nothing to revoke.
 */
export function endServerSession(res: NextResponse, foToken: string | null, reason: SessionEndReason): void {
  clearFoTokenCookie(res);
  if (foToken && !recentlyRevoked(foToken)) afterResponse(() => revokeFoSession(foToken, reason));
}

/**
 * A page whose session has expired often has several calls in flight, and each
 * is refused on its own. One revoke is enough: a token asked to be revoked in
 * the last few seconds is not asked again. Fingerprints only, never tokens.
 */
const REVOKE_MEMORY_MS = 10_000;
const revokedAt = new Map<string, number>();

function recentlyRevoked(foToken: string, now: number = Date.now()): boolean {
  for (const [fp, at] of revokedAt) if (now - at > REVOKE_MEMORY_MS) revokedAt.delete(fp);
  const fp = foFingerprint(foToken);
  if (revokedAt.has(fp)) return true;
  revokedAt.set(fp, now);
  return false;
}

/** Testing seam: forget which tokens were revoked recently. */
export function resetRecentRevokes(): void {
  revokedAt.clear();
}

/**
 * The session settings that are unusable, by name (plan RP2 part 5 asks for a
 * refusal at startup; until RP10-B's server entry exists, the routes that
 * depend on them report this once, when they are loaded). Safe to log: names
 * only, never values.
 */
export function sessionConfigProblems(): string[] {
  const problems: string[] = [];
  try {
    sessionKeyRing();
  } catch (error) {
    problems.push(error instanceof SessionConfigError ? error.setting : "SESSION_SIGNING_SECRET");
  }
  try {
    sessionCookieGraceSeconds();
  } catch {
    problems.push("SESSION_COOKIE_GRACE_S");
  }
  return problems;
}

/**
 * Revoke one FabOrchestrator session and log the outcome. Never throws;
 * `foLogout` bounds the wait with the `revoke` limit. Awaited only by the
 * sign-in flow, which revokes before it answers (the replaced token, and a
 * token the `/me` probe refused).
 */
export async function revokeFoSession(foToken: string, reason: SessionEndReason): Promise<boolean> {
  const revoked = await foLogout(foToken);
  // RP10-A: the first 8 characters of the fingerprint, for correlation only.
  logEvent("info", "session_end", { reason, revoked, sessionFp: foFingerprint(foToken).slice(0, 8) });
  return revoked;
}

/**
 * Run `task` after the response. `after()` exists only inside a Next request; a
 * route called directly (the unit tests do) has no request scope and `after`
 * throws, so the task then runs detached instead: still never awaited by the
 * response.
 */
export function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task().catch(() => {});
  }
}
