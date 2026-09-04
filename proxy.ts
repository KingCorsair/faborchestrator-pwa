import { NextResponse, type NextRequest } from "next/server";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { safeReturnPath } from "@/lib/return-path";

/**
 * The session gate, in front of the document rather than inside it.
 *
 * ── Why this file is called `proxy.ts` ──────────────────────────────────────
 * It is Next's middleware, under the name Next 16 gives it. `middleware.ts`
 * still runs and builds with a deprecation warning; `proxy.ts` exporting
 * `proxy` is the supported convention as of 16.1, and the two cannot coexist —
 * the build errors if both are present. The name describes Next's mechanism,
 * not this file's job, which is the session gate described below.
 *
 * ── The defect this exists for (2026-09-04) ─────────────────────────────────
 * Reported on the installed iPhone app: sign in, sign out, force-quit from the
 * app switcher, reopen from the Home Screen — and the app opens on the cockpit
 * as though the operator were still signed in. Only pressing an agent card
 * revealed the truth, and by then they had read four agent cards, a Live ops
 * panel and a Recent activity feed that a signed-out person has no business
 * being shown.
 *
 * **It was never an access-control failure.** Nothing behind `/api/` was
 * reachable: `requireAuth` refuses any request whose bearer token does not
 * arrive beside the matching FabOrchestrator cookie, and sign-out drops that
 * cookie. What leaked was the *appearance* of a session, which for a product
 * whose entire argument is "do not show a supervisor a number you cannot stand
 * behind" is its own kind of wrong.
 *
 * The cause was structural, not a bug in any line. `/` was a statically
 * prerendered page that read no session at all — deliberately, so the front
 * door would open before any bundle arrived — and the manifest's `start_url`
 * is `/`, so **every cold launch of the installed app landed on the one screen
 * in the app that never asked who you were.** The session checks all lived in
 * `useSession`, which runs on the screens behind the cockpit. Nothing was
 * broken; the check simply was not there.
 *
 * A client-side check on the landing page would not have fixed it either. It
 * cannot run before the HTML it is meant to suppress has already painted, and
 * on a cold standalone launch the gap between paint and hydration is at its
 * widest. The answer has to be in front of the document.
 *
 * ── Why the FabOrchestrator cookie is the thing being read ──────────────────
 * It is the only half of this app's session the server can see on a plain
 * navigation. The bearer token lives in `localStorage` (`lib/auth.ts` explains
 * why: it is the convention the product itself uses), and no middleware can
 * read that.
 *
 * That turns out to be the right half rather than a compromise. The FO cookie
 * is the credential `requireAuth` cannot proceed without, it is what sign-out
 * deletes, and it carries FO's own expiry so the browser drops it on the same
 * clock FO does. Every state the reported sequence can produce — signed out,
 * expired, never signed in — is a state with no cookie, and every one of them
 * now ends at `/login` before a byte of cockpit is rendered.
 *
 * What it deliberately does **not** claim: that the cookie is valid, or that
 * FabOrchestrator still honours it. Proving that needs FO's own `/api/auth/me`
 * on every navigation, which would reset FO's idle timer and corrupt somebody
 * else's session audit — the trade `lib/auth.ts` already recorded and refused.
 * A forged cookie buys its holder the cockpit's four hardcoded placeholder
 * metrics and nothing else; the first real request still meets `requireAuth`.
 *
 * ── Deny by default ────────────────────────────────────────────────────────
 * `PUBLIC` is an allowlist, so a screen added later is behind the gate on the
 * day it is created rather than on the day somebody remembers. The three
 * entries on it are each there for a reason worth stating, and are stated at
 * the constant.
 */

/**
 * The paths a signed-out visitor may reach.
 *
 *  - `/login` — the destination. Gating it is the redirect loop.
 *  - `/offline` — the service worker serves this from cache when the network
 *    is gone, so a request for it can arrive from a device that could not
 *    reach the server to be redirected in the first place. Bouncing it to a
 *    sign-in page that cannot load is the worst possible offline screen.
 *  - `/diagnostics` — the page you open when the app is not working, and
 *    "log in first" is not a diagnostic. It reads nothing but what the browser
 *    reports about itself; that file carries the reasoning.
 */
const PUBLIC = new Set(["/login", "/offline", "/diagnostics"]);

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (PUBLIC.has(pathname)) return NextResponse.next();

  // An empty value is what `clearFoTokenCookie` leaves behind on the way out,
  // and some browsers send the emptied cookie back before dropping it. A
  // present-but-empty cookie is a signed-out cookie.
  if (req.cookies.get(FO_TOKEN_COOKIE)?.value) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";

  // Where they were headed, so sign-in returns them to it — the same contract
  // `loginHref()` gives the client-side redirects, through the same validator,
  // so neither path can be turned into an open redirect.
  const target = safeReturnPath(pathname + req.nextUrl.search, "");
  if (target && target !== "/") url.searchParams.set("next", target);

  const res = NextResponse.redirect(url, 307);

  // **The one header this must not get wrong.** A cached redirect on a phone
  // outlives the sign-in that was supposed to clear it: the operator signs in,
  // navigates to `/`, and is bounced by a copy of this response held from
  // before they had a session. That is the redirect loop, and it is the only
  // way one can happen here.
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = {
  /**
   * Everything except the things that are not documents.
   *
   * `/api/` is excluded because those routes answer to `requireAuth`, which is
   * a stronger check than this one and returns 401 rather than redirecting —
   * a `fetch` cannot follow a redirect to a sign-in page usefully, and the
   * screens are written to read the 401.
   *
   * Anything with a file extension is excluded, which covers the build output
   * and everything in `public/`. Three of those matter enough to name:
   * `/manifest.webmanifest` and the icons, because redirecting them would break
   * installation for the signed-out visitor who is about to sign in; and
   * `/sw.js`, because a service worker script that answers 307 does not
   * register, and the app would silently lose its offline page.
   *
   * ⚠ **`\\.` and not `\.`.** This is a regular expression inside a string
   * literal, so the backslash needs escaping twice. Written `\.` it parses as a
   * bare `.`, the lookahead then matches almost every path, and the gate is
   * excluded from the routes it exists to protect — a fix that builds, passes
   * its unit tests and does nothing at all, because those tests call `proxy`
   * directly and never see this matcher. It was written that way once during
   * the 2026-09-04 change and caught before deploying; nothing in the suite
   * would have caught it, which is why `scripts/gate-live-check.mjs` exists and
   * runs against the deployment rather than against a mock.
   */
  matcher: ["/((?!api/|_next/|.*\\.[^/]+$).*)"],
};
