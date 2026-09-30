/**
 * Where this app's own navigation points — the WP9 cutover, in one function.
 *
 * ── What WP9 is for ─────────────────────────────────────────────────────────
 * WP1–WP8 made FabOrchestrator's real `/chat` and `/reports` work on this
 * origin, behind one session, on a phone. They did not make anybody *arrive*
 * there. Every chat link on the cockpit still pointed at `/fabinsight` — this
 * app's own conversation screen — so the embedded surfaces were reachable only
 * by typing the URL. WP5's manual pass found exactly that the hard way: a
 * tester following the cockpit landed on the old screen and reported a missing
 * download that the real one has.
 *
 * This module is the fix, and it is deliberately one function rather than a
 * scattering of conditionals. Two components render navigation — the cockpit's
 * own sticky header (a server component) and `AppShell` (a client one) — and
 * they have drifted apart once already. A single source for "where does a chat
 * link go" is what stops the app disagreeing with itself about its own front
 * door.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A chat link points at **FabOrchestrator's `/chat`** when the gateway is
 * serving it, and at **this app's `/fabinsight`** when it is not. Nothing else
 * changes: `/reports` is the same URL either way — the flag decides which
 * application answers it, which is the whole point of the collision WP7
 * resolved — so a Reports link never needs rewriting.
 *
 * ── Why this reads the registry rather than the env directly ────────────────
 * `readRegistry()` already knows that `FO_EMBED_SURFACES` may name a surface
 * that is not in the catalogue, that an empty value means off, and that a
 * variable of nothing but typos enables nothing. Asking it, rather than
 * re-parsing the variable here, means the navigation and the router can never
 * disagree about whether `/chat` is embedded — and disagreeing would send an
 * operator to a URL that answers 404.
 */

import { classify, readRegistry, type Registry } from "./registry";

/**
 * The chat screens this app owns, and which FabOrchestrator surface replaces
 * each one once the gateway is serving it.
 *
 * Both of this app's agent screens map to the same place, because in
 * FabOrchestrator they *are* the same place: the cockpit's AGENT · 01 and
 * AGENT · 04 cards both route to `/chat` there (verified against upstream
 * `e5a5abd`), and `lib/faborch/agents.ts` records that every agent this app
 * exposes already shares `/api/chat`. There is nothing to route between.
 */
export const RETIRED_CHAT_SCREENS: readonly string[] = ["/fabinsight", "/backend-agent"];

/**
 * Where a link to "the chat" should go.
 *
 * Pass a registry when one is already to hand — the middleware has one — so a
 * request does not parse the environment twice.
 */
export function chatHref(registry: Registry = readRegistry()): string {
  return classify("/chat", registry) === "fo-document" ? "/chat" : "/fabinsight";
}

/** True when FabOrchestrator itself is answering the chat on this origin. */
export function chatIsEmbedded(registry: Registry = readRegistry()): boolean {
  return chatHref(registry) === "/chat";
}

/**
 * Should this request for one of this app's own chat screens be sent to
 * FabOrchestrator's instead?
 *
 * This is the "retire, reversibly" half of WP9. The old screens stay in the
 * tree, fully built and fully tested; while the gateway is serving `/chat`,
 * arriving at one of them lands you on the real thing instead. Nothing is
 * deleted, so turning the flag off restores them exactly — and a bookmark or a
 * shared link made before the cutover keeps working rather than showing an
 * operator a screen the rest of the app no longer points at.
 *
 * Returns the destination, or `null` to leave the request alone.
 */
export function retiredScreenRedirect(
  pathname: string,
  registry: Registry = readRegistry(),
): string | null {
  if (!chatIsEmbedded(registry)) return null;
  return RETIRED_CHAT_SCREENS.includes(pathname) ? "/chat" : null;
}

/** FabOrchestrator's own cockpit — the product's real landing page. */
export const FO_COCKPIT_PATH = "/home";

/**
 * Where the front door leads.
 *
 * ── This reversed on 9 September, and the reversal is the point ─────────────
 * Until the audit, `/home` was *translated away*: FabOrchestrator's Back
 * control said "back to the overview", and this app answered with its own
 * hand-built cockpit because there was "only one cockpit here and it is this
 * app's". That was the narrow reading. The product is an installable delivery of
 * FabOrchestrator, so the cockpit is **FabOrchestrator's**, and `/home` is it —
 * with its own composer, its own agent cards, and whatever Danish's team ships
 * there next without anybody editing this repository.
 *
 * So the mapping goes the other way now: `/` sends a signed-in operator to
 * `/home`, and `/home` is served by the gateway like any other FabOrchestrator
 * document.
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
 *  1. **The cookie usually dies with the session.** WP2's `expiredUpstream()`
 *     clears it on any upstream 401, so the next `/` meets the sign-in gate.
 *  2. **The shell breaks it at the midpoint.** `public/fo-shell.js` runs on
 *     every FabOrchestrator document and signs this app out the moment it finds
 *     FabOrchestrator's own token gone. That catches the case (1) cannot:
 *     FabOrchestrator's *idle timer* clears its storage after 30 minutes
 *     **without any request**, so nothing upstream ever returns a 401 and the
 *     cookie would otherwise outlive the session it was minted beside.
 *
 * The loop's midpoint is always `/home`, an FabOrchestrator document, which is
 * exactly where the shell runs — so it is broken on the first pass rather than
 * bounded by a counter. `scripts/fo-auth-loop-check.mjs` drives an expired
 * session through it.
 */
export function frontDoorRedirect(
  pathname: string,
  registry: Registry = readRegistry(),
): string | null {
  if (!registry.enabled) return null;
  if (pathname !== "/") return null;
  // Only when FabOrchestrator is actually serving its cockpit here. In
  // `surfaces` mode without `/home` listed, `/` stays this app's own screen and
  // nothing about the front door moves.
  return classify(FO_COCKPIT_PATH, registry) === "fo-document" ? FO_COCKPIT_PATH : null;
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
