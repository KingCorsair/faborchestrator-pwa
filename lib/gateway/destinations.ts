/**
 * Where this app's own addresses lead, now that FabOrchestrator's pages are
 * the app.
 *
 * Two redirects are left, both applied by `proxy.ts` after the sign-in gate:
 *
 *  - this app's old chat screens, `/fabinsight` and `/backend-agent`, removed
 *    on this branch, go to FabOrchestrator's `/chat`, so a bookmark or a Home
 *    Screen shortcut made before the cutover still lands somewhere;
 *  - the front door `/` goes to FabOrchestrator's cockpit, `/home`.
 */

/** The old addresses of this app's removed chat screens. */
export const RETIRED_CHAT_SCREENS: readonly string[] = ["/fabinsight", "/backend-agent"];

/** Where one of the removed chat screens' addresses goes, or `null` to leave the request alone. */
export function retiredScreenRedirect(pathname: string): string | null {
  return RETIRED_CHAT_SCREENS.includes(pathname) ? "/chat" : null;
}

/** FabOrchestrator's own cockpit — the product's real landing page. */
export const FO_COCKPIT_PATH = "/home";

/**
 * Where the front door leads: `/` sends a signed-in operator to `/home`.
 *
 * ── The redirect loop this could have been, and why it is not ──────────────
 * FabOrchestrator's client-side guards do `router.replace("/")` meaning **"go
 * to our login page"** — on its own site `/` *is* the login page. Here `/` is
 * the front door. So a session FabOrchestrator has given up on, with this app's
 * cookie still alive, would go: guard → `/` → `/home` → guard → `/` → for
 * ever.
 *
 * Two things stop it, and the second is the one that actually closes it:
 *
 *  1. **The cookie usually dies with the session.** `expiredUpstream()` clears
 *     it on any upstream 401, so the next `/` meets the sign-in gate.
 *  2. **The shell breaks it at the midpoint.** `public/fo-shell.js` runs on
 *     every FabOrchestrator document and signs this app out the moment it finds
 *     FabOrchestrator's own token gone. That catches the case (1) cannot:
 *     FabOrchestrator's *idle timer* clears its storage after 30 minutes
 *     **without any request**, so nothing upstream ever returns a 401 and the
 *     cookie would otherwise outlive the session it was minted beside.
 *
 * The loop's midpoint is always `/home`, a FabOrchestrator document, which is
 * exactly where the shell runs — so it is broken on the first pass rather than
 * bounded by a counter.
 */
export function frontDoorRedirect(pathname: string): string | null {
  return pathname === "/" ? FO_COCKPIT_PATH : null;
}

/**
 * FabOrchestrator's `/` — its sign-in page — is this app's `/login`.
 *
 * Its guards navigate to `/` to mean "sign in". This app's `/` is the front
 * door, so that intent has to be carried across explicitly: a request that
 * *FabOrchestrator* sent to the root because it wants a login form should meet
 * this app's form, which is the only way in on this origin.
 *
 * There is nothing to detect at the router — `/` looks the same either way — so
 * this is applied by the shell, which knows it is running inside a
 * FabOrchestrator document and can sign out and go to `/login` directly.
 * Recorded here as the policy the shell implements.
 */
export const FO_LOGIN_PATH = "/";
