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
 * ── One reason does not end the session (9 October 2026) ────────────────────
 * `token_missing` means a screen loaded with a session cookie and **no bearer
 * in this browser's storage**. A session this browser signed in with always
 * has its bearer, so that cookie was not this context's: on an iPhone it is
 * the browser's cookie, copied into a newly installed Home Screen app.
 * Revoking it would sign the browser out because its owner opened the app. So
 * step 1 asks the server to **forget** the cookie here instead
 * (`POST /api/pwa/auth/forget`): it is cleared from this context and the
 * session stays alive for the browser that owns it. Steps 2 and 3 are the
 * same. Every other reason still ends the session.
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
  | "fo_signed_out"
  | "device_blocked";

export function endClientSession(
  reason: ClientEndReason,
  options: { navigate?: boolean; to?: string } = {},
): void {
  try {
    void fetch(reason === "token_missing" ? "/api/pwa/auth/forget" : "/api/pwa/auth/logout", {
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
