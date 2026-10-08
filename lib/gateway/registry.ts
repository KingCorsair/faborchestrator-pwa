/**
 * The ownership registry: which paths on this origin are this app's, which
 * are FabOrchestrator's, and which are refused.
 *
 * This app serves FabOrchestrator's own pages for every document it does not
 * reserve itself. There is no switch: the native screens that an "off" or
 * "surfaces" mode used to fall back on were removed on this branch.
 *
 * ── Order of precedence ─────────────────────────────────────────────────────
 * A path is classified in this order, first match wins:
 *
 *   1. This app's reserved paths: its front door `/`, its sign-in, its API,
 *      its build output under the asset prefix, its install files.
 *      FabOrchestrator's own `/` is its sign-in page and is never served here:
 *      one login, on this app's form.
 *   2. FabOrchestrator paths that are refused outright: the credential
 *      endpoints (this app's rate-limited form is the only way in) and FO's
 *      scheduler tick.
 *   3. FabOrchestrator API prefixes the embedded pages call. Any other `/api/`
 *      path is unknown, and unknown is 404.
 *   4. FabOrchestrator static assets: everything under `/_next/`, and the
 *      handful of files FO serves from its `public/` (verified 2026-09-08).
 *   5. Any other document is FabOrchestrator's.
 *
 * Verified against production on 2026-09-08: FO ships no manifest, no service
 * worker and no icons, so this app's own at those paths collide with nothing.
 */

export type Owner = "pwa" | "fo-document" | "fo-api" | "fo-static" | "denied" | "unknown";

/**
 * This app's own paths, matched by prefix boundary.
 *
 * ── `/api/pwa/auth`, not `/api/auth` (WP2, 2026-09-08) ──────────────────────
 * This app's session endpoints moved under `/api/pwa/` so that `/api/auth/*`
 * is free to mean what it means on FabOrchestrator. The embedded pages ask
 * FabOrchestrator who the operator is and sign them out through
 * FabOrchestrator's own endpoints, reached through the gateway with the real
 * token injected; this app's own screens ask this app. Two sessions, two
 * prefixes, no ambiguity about which one a request is talking about.
 *
 * It also preserves a property `lib/auth.ts` argued for and refused to give
 * up: this app never calls FabOrchestrator's `/api/auth/me` on its own
 * account, because every authenticated call bumps FO's idle clock and would
 * silently defeat the 30-minute eviction its session audit records. When
 * FabOrchestrator's *own* client makes that call through the gateway, the bump
 * is FabOrchestrator's own behaviour, exactly as on its website.
 */
export const PWA_RESERVED_PREFIXES: readonly string[] = [
  "/login",
  "/offline",
  "/diagnostics",
  // The old addresses of this app's removed chat screens. FabOrchestrator has
  // no page at either path; `lib/gateway/destinations.ts` sends them on to
  // `/chat`, so an old bookmark or Home Screen shortcut still lands somewhere.
  "/fabinsight",
  "/backend-agent",
  "/api/pwa",
  "/pwa-assets",
];

/** This app's own files, matched exactly. */
export const PWA_RESERVED_EXACT: readonly string[] = [
  "/",
  "/sw.js",
  // The mobile shell added to embedded FabOrchestrator documents (WP6). It is
  // this app's file, served from this app's `public/`, and must never be
  // forwarded — FabOrchestrator has no such path and would 404 it.
  "/fo-shell.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

/** FabOrchestrator paths that are never forwarded, matched by prefix boundary. */
/**
 * Never forwarded, in any mode, checked before anything else can claim them.
 *
 * This list is the security boundary, and the audit of 9 September classified
 * every one of FabOrchestrator's 52 API routes to decide what belongs on it.
 *
 * **Credential and registration** — `/api/auth/login`, `/api/auth/register`,
 * `/api/auth/password-reset` (and its `/confirm`), plus the two recovery
 * *documents* `/forgot-password` and `/reset-password`. All are
 * unauthenticated by design in FabOrchestrator, and forwarding them would let
 * somebody obtain a FabOrchestrator session *around* this app's sign-in form —
 * which is the one thing the single-login bridge must never permit. Sign-in on
 * this origin happens at `/login` or not at all.
 *
 * **Scheduled** — `/api/fabinsight/cron`. Machine-to-machine, gated upstream by
 * a `CRON_SECRET` and an `x-cron` header rather than by a session, and it
 * re-queries the MES. Nothing a browser on this origin should be able to reach.
 *
 * **Development-only introspection** — `/api/fabinsight/schema`, added
 * 9 September. FabOrchestrator's own header calls it what it is: *"Disabled
 * outside production — it would otherwise be an unauthenticated arbitrary-SELECT
 * endpoint."* It answers 404 in production today **because FabOrchestrator
 * checks `NODE_ENV`**, and that is the only thing standing between this origin
 * and an unauthenticated SELECT against the plant database. Relying on another
 * application's environment variable is not a boundary. It was on the forward
 * list until the audit; it is denied here now, so a FabOrchestrator deploy that
 * ever came up outside production mode could not turn this app into the vehicle.
 */
export const FO_DENIED_PREFIXES: readonly string[] = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/password-reset",
  "/api/fabinsight/cron",
  "/api/fabinsight/schema",
  // Artifacts are reached by an artifact id or a conversation id, and an
  // artifact id cannot be tied to the device that owns its conversation
  // (`lib/gateway/seats.ts`). FabOrchestrator's own client never calls this
  // route, so it is closed rather than half-guarded (1 October 2026).
  "/api/artifacts",
  "/forgot-password",
  "/reset-password",
];

/** FabOrchestrator API prefixes the embedded pages call. */
export const FO_API_PREFIXES: readonly string[] = [
  // Identity and sign-out, as FabOrchestrator's own client uses them. The
  // gateway injects the real token for these (WP2); the credential endpoints
  // that would let somebody sign in *around* this app's form are in
  // `FO_DENIED_PREFIXES` below and are checked first.
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/change-password",
  // Approved devices, owned by FabOrchestrator (its Admin → Devices). The
  // challenge an approved device signs at sign-in (this app's `/login` asks for
  // it), the one-time QR code a device uses on `/device-enroll`, and the admin
  // calls of the Devices page, so a QR made inside this app opens here: a
  // device key belongs to the web address it was made on.
  "/api/auth/device-challenge",
  "/api/auth/device-enroll",
  "/api/admin/devices",
  "/api/chat",
  "/api/conversations",
  "/api/mcp/connections",
  // The cockpit's agent status and its "Check now" (8 October 2026). Without
  // it, FabOrchestrator's home page shows every agent as "Status unknown".
  "/api/mcp/health",
  "/api/user",
  "/api/memory",
  "/api/messages/feedback",
  "/api/files",
  "/api/fabinsight/pinned",
  "/api/fabinsight/render",
  "/api/fabinsight/access",
  "/api/fabinsight/warm",
  "/api/modeling-agent",
  "/api/cmf",
  "/api/platform-theme",
  // The downtime banner every FabOrchestrator page shows (Admin → Downtime
  // Notices; 8 October 2026). Read-only, and public at FabOrchestrator too.
  "/api/platform-notice",
  // FabOrchestrator's pages send their browser log records here, into its
  // server log (8 October 2026). It limits them per browser tab, not per
  // address, so every operator arriving from this app's one address is fine.
  // Signed in only: an anonymous body is refused by the gateway.
  "/api/client-log",
  "/api/health",
];

/**
 * The one API row that takes a body with no session: a phone using a device QR
 * code has, by definition, not signed in. Every other body to an API row needs
 * a session (`app/fo-gateway/[...path]/route.ts`).
 */
export const FO_ANONYMOUS_BODY_PATHS: readonly string[] = ["/api/auth/device-enroll"];

/** FabOrchestrator static prefixes. */
export const FO_STATIC_PREFIXES: readonly string[] = ["/_next", "/logos"];

/** Files FabOrchestrator serves from its `public/` in production. */
export const FO_STATIC_EXACT: readonly string[] = [
  "/favicon.ico",
  "/duke_sheets_wasm_bg.wasm",
  "/file.svg",
  "/globe.svg",
  "/next.svg",
  "/vercel.svg",
  "/window.svg",
];

/**
 * The internal path the middleware rewrites FO requests to. Never public:
 * `proxy.ts` answers 404 to any request whose own path starts with it, and the
 * handler refuses anything without the marker header below.
 *
 * **Not underscore-prefixed, and that is load-bearing.** This was `/__fo`
 * until the WP1 build showed the route missing from the manifest entirely:
 * Next's App Router treats a folder beginning with `_` as private and opts it
 * and everything under it out of routing, so the rewrite had no destination
 * and every forwarded request would have 404ed. Renaming the folder is the
 * whole fix. Nothing in FabOrchestrator or this app serves `/fo-gateway`.
 */
export const GATEWAY_INTERNAL_PREFIX = "/fo-gateway";

/** The request header the middleware stamps on a rewrite, so the gateway route knows the request came through it. */
export const GATEWAY_MARKER_HEADER = "x-pwa-gateway";

/**
 * This app's asset prefix, written down once.
 *
 * `next.config.ts` sets `assetPrefix` to it, `proxy.ts` rewrites it back onto
 * the real `/_next/` before routing, and the cache rule has to exclude it.
 * Those three disagreeing is not a build error — it is a silent loss, which is
 * exactly what happened between WP1 and WP3.
 */
export const PWA_ASSET_PREFIX = "/pwa-assets";

/**
 * Paths whose contents are named by a hash of themselves, and may therefore be
 * cached forever. Everything else this app serves is revalidated.
 *
 * Exported so `next.config.ts` builds its `headers()` pattern from the same
 * list a test asserts against. The WP3 defect was precisely a pattern that had
 * fallen out of step: `assetPrefix` moved this app's chunks and the exclusion
 * did not follow, so every content-hashed file this app owns was revalidated
 * on every navigation — measured against production, which still had it right.
 */
export const IMMUTABLE_ASSET_PREFIXES: readonly string[] = [
  "_next/static",
  "_next/image",
  `${PWA_ASSET_PREFIX.slice(1)}/_next/static`,
  `${PWA_ASSET_PREFIX.slice(1)}/_next/image`,
];

/** The `source` pattern for the revalidate-everything-else cache rule. */
export function revalidateSourcePattern(): string {
  return `/((?!${IMMUTABLE_ASSET_PREFIXES.join("|")}).*)`;
}

/** `p` equals `prefix`, or continues it at a `/` boundary. */
export function underPrefix(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * Who owns `pathname` on this origin.
 *
 * The order of these tests **is** the security policy: what this app reserves
 * is decided first, what is denied is decided before anything is forwarded,
 * and the API allow-list is consulted before the document default applies.
 * Documents and APIs are deliberately treated differently, the constraint Amay
 * set: a page FabOrchestrator's team deploys appears here by itself, but an
 * *endpoint* they add must be looked at and listed by a person first.
 */
export function classify(pathname: string): Owner {
  // 1. This app's own paths. The front door, its session, its build output,
  //    its installability and its offline screen are the things this app
  //    exists to provide and can never be handed over.
  if (PWA_RESERVED_EXACT.includes(pathname)) return "pwa";
  if (PWA_RESERVED_PREFIXES.some((p) => underPrefix(pathname, p))) return "pwa";

  // 2. Denied before forwarded. Credential, registration, recovery, scheduled
  //    and development-only endpoints, and the two password-recovery
  //    documents. Nothing below can reach them.
  if (FO_DENIED_PREFIXES.some((p) => underPrefix(pathname, p))) return "denied";

  // 3. FabOrchestrator's API: an explicit allow-list. Anything else under
  //    `/api/` is unknown: a new FabOrchestrator endpoint is a decision, not a
  //    deployment side effect.
  if (FO_API_PREFIXES.some((p) => underPrefix(pathname, p))) return "fo-api";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "unknown";

  // 4. FabOrchestrator's static output.
  if (FO_STATIC_EXACT.includes(pathname)) return "fo-static";
  if (FO_STATIC_PREFIXES.some((p) => underPrefix(pathname, p))) return "fo-static";

  // 5. Every other document is FabOrchestrator's, which is what lets a page
  //    FabOrchestrator's team deploys appear here without an edit.
  return "fo-document";
}

/** True for the owners the gateway route is allowed to forward. */
export function isForwardable(owner: Owner): boolean {
  return owner === "fo-document" || owner === "fo-api" || owner === "fo-static";
}
