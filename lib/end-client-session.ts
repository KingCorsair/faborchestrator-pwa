/**
 * Ending a session in the browser (plan RP2, `endClientSession`).
 *
 * Every way a session ends on the phone goes through here, in one fixed order:
 *
 *  1. **Ask the server to end it**: `POST /api/pwa/auth/logout`, `keepalive`
 *     so it survives the navigation that follows, never awaited. The server
 *     clears the httpOnly FabOrchestrator cookie and revokes that session at
 *     FabOrchestrator (`lib/faborch/end-session.ts`).
 *  2. **Forget this device's session**: both localStorage keys.
 *  3. **A whole-document navigation to sign-in**, so no screen keeps holding a
 *     user, a conversation or a list after the session behind it has gone.
 *
 * Until 2026-09-30 an expired session was only half ended: the screens cleared
 * localStorage and went to sign-in **without** telling the server (plan RP2,
 * finding m3), so the FabOrchestrator session behind the cookie stayed alive
 * for up to 30 days. `public/fo-shell.js` mirrors this order on
 * FabOrchestrator's own pages.
 *
 * Client-safe: no server imports.
 */

import { clearStoredSession } from "@/lib/stored-session";

/** Why the session is ending, for the server's `session_end` log line. */
export type ClientEndReason =
  | "user"
  | "pwa_expired"
  | "fo_expired"
  | "token_missing"
  | "storage_unavailable"
  | "fo_signed_out";

export function endClientSession(
  reason: ClientEndReason,
  options: { navigate?: boolean; to?: string } = {},
): void {
  try {
    void fetch("/api/pwa/auth/logout", {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }).catch(() => {});
  } catch {
    /* A fetch that throws synchronously changes nothing below. */
  }

  clearStoredSession();

  if (options.navigate === false) return;
  try {
    // `replace`: Back must not return into a screen whose session has ended.
    window.location.replace(options.to ?? "/login");
  } catch {
    /* No window (a server render): nothing to navigate. */
  }
}
