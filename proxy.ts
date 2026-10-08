import { NextResponse, type NextRequest } from "next/server";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { classify, GATEWAY_INTERNAL_PREFIX, GATEWAY_MARKER_HEADER, type Owner } from "@/lib/gateway/registry";
import { frontDoorRedirect, retiredScreenRedirect } from "@/lib/gateway/destinations";
import { safeGatewayPath } from "@/lib/gateway/path";
import { safeReturnPath } from "@/lib/return-path";

/**
 * The session gate, in front of the document rather than inside it — and,
 * since WP1 of the embedding work, the ownership decision for every path.
 *
 * ── Why this file is called `proxy.ts` ──────────────────────────────────────
 * It is Next's middleware, under the name Next 16 gives it. `middleware.ts`
 * still runs and builds with a deprecation warning; `proxy.ts` exporting
 * `proxy` is the supported convention as of 16.1, and the two cannot coexist —
 * the build errors if both are present. The name describes Next's mechanism,
 * not this file's job.
 *
 * ── Two jobs ────────────────────────────────────────────────────────────────
 *
 * **1. The gate (2026-09-04).** Reported on the installed iPhone app: sign in,
 * sign out, force-quit, reopen from the Home Screen — and the app opened on the
 * cockpit as though the operator were still signed in. Never an access-control
 * failure: nothing behind `/api/` was reachable. What leaked was the
 * *appearance* of a session, because `/` was a statically prerendered page that
 * read no session and `start_url` points at it. A client-side check cannot run
 * before the HTML it means to suppress has painted, so the answer has to be in
 * front of the document. The FabOrchestrator cookie is the thing read because
 * it is the only half of the session the server can see on a navigation, it is
 * what sign-out deletes, and it carries FO's own expiry. It is deliberately not
 * validated against FO's `/api/auth/me` on every navigation: that would bump
 * FO's idle clock and corrupt somebody else's session audit (`lib/auth.ts`).
 * A forged cookie buys the cockpit's placeholder metrics and nothing else; the
 * first real request still meets `requireAuth`.
 *
 * **2. Ownership (2026-09-08, WP1).** Most paths on this origin are
 * FabOrchestrator's. `lib/gateway/registry.ts` decides which; this file acts
 * on the decision:
 *
 *   pwa          → this app serves it (the gate applies to documents)
 *   fo-document  → the gate applies, then the request is rewritten to the
 *                  internal gateway route `/fo-gateway/<path>`
 *   fo-api       → rewritten to the gateway (FO answers 401 itself when a
 *   fo-static      token is missing; static assets are public on FO too)
 *   denied       → 404
 *   unknown      → 404, deny by default
 *
 * ── Why the matcher now covers everything ───────────────────────────────────
 * Until WP1 the matcher excluded `/api/`, `/_next/` and any path with a file
 * extension, because those are not documents and the gate has nothing to say
 * about them. The gateway does: FabOrchestrator's chunks live under `/_next/`
 * and its API under `/api/`, and Next resolves middleware *before* its own
 * filesystem routes (verified in `next/dist/server/lib/router-utils/
 * resolve-routes.js`), so this is the only place that can claim them. The
 * gate's old exclusions are now the `isDocument` test below, applied by hand.
 *
 * ── This app's own build output ─────────────────────────────────────────────
 * `next.config.ts` sets `assetPrefix: "/pwa-assets"`, so this app's documents
 * ask for their chunks at `/pwa-assets/_next/…` and bare `/_next/…` is
 * unambiguously FabOrchestrator's. Next does not serve the prefixed path by
 * itself; the rewrite below maps it back onto the real `/_next/…` internally,
 * before the ownership decision, so it holds for every request.
 */

/**
 * The paths a signed-out visitor may reach.
 *
 *  - `/login` — the destination. Gating it is the redirect loop.
 *  - `/offline` — served from cache by the service worker when the network is
 *    gone; bouncing it to a sign-in page that cannot load is the worst
 *    possible offline screen.
 *  - `/diagnostics` — the page you open when the app is not working, and
 *    "log in first" is not a diagnostic.
 *  - `/device-enroll` — FabOrchestrator's page for a device QR code from its
 *    Admin → Devices, served through the gateway. The phone that opens it has
 *    no session yet; the one-time code in the link is the permission.
 */
const PUBLIC = new Set(["/login", "/offline", "/diagnostics", "/device-enroll"]);

/** This app's chunk prefix, from `next.config.ts`. */
const PWA_ASSET_PREFIX = "/pwa-assets";

/**
 * The old matcher's exclusions, as a predicate: not the API, not build output,
 * not a file. Only documents meet the gate.
 */
function isDocument(pathname: string): boolean {
  // **A malformed path is not a file, whatever it ends with.** A
  // protocol-relative `//evil.example`, or the backslash a browser normalises
  // into one, is an origin wearing a path's clothes; the extension heuristic
  // below would read `.example` as a file type and wave it past the gate.
  // These meet the gate instead, so a signed-out visitor is bounced to
  // sign-in and `safeReturnPath` refuses to carry the value as a return
  // target. Held by `__tests__/platform/route-gate.test.ts`, which caught
  // exactly this when the old matcher's exclusions moved into this function
  // during WP1.
  if (pathname.startsWith("//") || pathname.includes("\\")) return true;

  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  if (/\.[^/]+$/.test(pathname)) return false;
  return true;
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // The gateway's internal path is never reachable directly. The handler also
  // refuses any request without the marker header, so this is belt and braces.
  if (pathname === GATEWAY_INTERNAL_PREFIX || pathname.startsWith(`${GATEWAY_INTERNAL_PREFIX}/`)) {
    return notFound(req);
  }

  // This app's own chunks, from the prefix back to where Next keeps them.
  if (pathname.startsWith(`${PWA_ASSET_PREFIX}/_next/`)) {
    const url = req.nextUrl.clone();
    url.pathname = pathname.slice(PWA_ASSET_PREFIX.length);
    return NextResponse.rewrite(url);
  }

  // ── This app's removed chat screens (WP9 cutover, 9 September) ───────────
  //
  // `/fabinsight` and `/backend-agent` were this app's own chat screens. They
  // are gone, and arriving at one lands on FabOrchestrator's `/chat` instead,
  // so a bookmark, a shared link or a Home Screen shortcut made before the
  // cutover keeps working.
  //
  // It is a redirect rather than a rewrite on purpose: the operator should end
  // up *at* `/chat`, with `/chat` in the address bar, so that reloading,
  // sharing or installing from there does the same thing next time.
  //
  // Gated first, so an unauthenticated request meets the sign-in gate and its
  // `?next=` rather than being bounced to a URL it cannot open yet.
  const retired = retiredScreenRedirect(pathname);
  if (retired) {
    const gated = gate(req);
    if (gated.status !== 200) return gated;
    const url = req.nextUrl.clone();
    url.pathname = retired;
    // The question, if one was in the URL, does not survive — FabOrchestrator's
    // chat accepts no prefill (`?q=`, `?message=` and `?prompt=` all verified
    // against production, composer still empty). Dropping the query is the
    // honest outcome: carrying it would put a parameter in the address bar that
    // nothing reads.
    url.search = "";
    const res = NextResponse.redirect(url, 307);
    // 307 and `no-store`, as the sign-in gate uses them: a cached redirect on
    // a phone outlives whatever caused it.
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  // ── The front door leads into FabOrchestrator's cockpit ──────────────────
  //
  // The product is an installable delivery of FabOrchestrator, so the cockpit
  // is FabOrchestrator's `/home` — its composer, its agent cards, and whatever
  // Danish's team ships there next without an edit here. `/` is this app's
  // front door and sends a signed-in operator on to it.
  //
  // Gated first, so a visitor with no session meets sign-in rather than being
  // bounced towards a page they cannot open.
  //
  // **This is one half of a loop that must not exist.** FabOrchestrator's
  // guards navigate to `/` meaning "go to our login page"; here `/` comes back
  // to `/home`. `public/fo-shell.js` closes it at the midpoint by signing this
  // app out as soon as FabOrchestrator's own token is gone — including the idle
  // case, where FabOrchestrator clears its storage after 30 minutes without any
  // request, so no upstream 401 ever reaches `expiredUpstream()`.
  // `scripts/fo-auth-loop-check.mjs` drives an expired session through it.
  const frontDoor = frontDoorRedirect(pathname);
  if (frontDoor) {
    const gated = gate(req);
    if (gated.status !== 200) return gated;
    const url = req.nextUrl.clone();
    url.pathname = frontDoor;
    const res = NextResponse.redirect(url, 307);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  const owner: Owner = classify(pathname);

  switch (owner) {
    case "pwa":
      return gate(req);
    case "fo-document": {
      const gated = gate(req);
      if (gated.status !== 200) return gated;
      return toGateway(req);
    }
    case "fo-api":
    case "fo-static":
      return toGateway(req);
    case "denied":
    case "unknown":
      return notFound(req);
  }
}

/** The 2026-09-04 gate, unchanged in behaviour. */
function gate(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (!isDocument(pathname)) return NextResponse.next();
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

/**
 * Hand the request to the gateway route, marked so the route knows it came
 * from here. The path is re-checked for hygiene first: a path the gateway
 * would refuse is refused here too, before anything is rewritten.
 */
function toGateway(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (!safeGatewayPath(pathname)) return notFound(req);

  const url = req.nextUrl.clone();
  url.pathname = `${GATEWAY_INTERNAL_PREFIX}${pathname}`;

  const headers = new Headers(req.headers);
  headers.set(GATEWAY_MARKER_HEADER, "1");
  return NextResponse.rewrite(url, { request: { headers } });
}

/**
 * A 404 in the shape the caller can use (plan RP5 part 3b, finding G8).
 *
 * An API path gets a coded JSON body: a script reading `error` gets a sentence,
 * never an HTML page it cannot parse. Anything else gets Next's own not-found
 * page, by rewriting to a path nothing serves: a document request deserves the
 * app's 404 page rather than an empty body, and a phone must never see raw JSON
 * in a standalone window.
 */
function notFound(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.json(
      { code: "not_found", error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/__gateway-not-found";
  url.search = "";
  return NextResponse.rewrite(url);
}

export const config = {
  /**
   * Every path. See "Why the matcher now covers everything" above; the
   * document-only rule the old matcher expressed now lives in `isDocument`.
   */
  matcher: ["/(.*)"],
};
