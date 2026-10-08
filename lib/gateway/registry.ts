/**
 * The ownership registry: which paths on this origin are this app's, which
 * are FabOrchestrator's, and which are refused.
 *
 * ── The one switch ──────────────────────────────────────────────────────────
 * `FO_EMBED_SURFACES` lists the FabOrchestrator documents this origin opens,
 * as a comma-separated set of paths from the catalogue below, for example
 * `/chat,/reports`. **Unset or empty means the registry is disabled** and
 * every path belongs to this app exactly as before the embedding work: no
 * FO document, asset or API is reachable, and `proxy.ts` behaves as it did on
 * 2026-09-04. That is the rollback at every stage of the plan.
 *
 * ── Order of precedence ─────────────────────────────────────────────────────
 * When enabled, a path is classified in this order, first match wins:
 *
 *   1. `/` is always this app's front door. FabOrchestrator's own `/` is its
 *      sign-in page and is never served here: one login, on this app's form.
 *   2. A document listed in `FO_EMBED_SURFACES` (by path prefix) is FO's.
 *      This is what lets `/reports` move from this app's own screen to FO's
 *      page by configuration alone (WP7).
 *   3. This app's reserved paths: its screens, its API, its build output
 *      under the asset prefix, its install files.
 *   4. FabOrchestrator paths that are refused outright: the credential
 *      endpoints (this app's rate-limited form is the only way in) and FO's
 *      scheduler tick.
 *   5. FabOrchestrator API prefixes the embedded pages call.
 *   6. FabOrchestrator static assets: everything under `/_next/`, and the
 *      handful of files FO serves from its `public/` (verified 2026-09-08).
 *   7. Anything else is unknown, and unknown is 404. Deny by default.
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 * FO's `/api/auth/*` is this app's in WP1: the sign-in, sign-out and session
 * routes at those paths are this app's own and stay so until WP2 moves them.
 * FO's `/home` and `/modeling-agent` are in the catalogue but not in any
 * default; the plan keeps the desktop cockpit and the Master Data Load agent
 * off phones unless a later decision lists them.
 *
 * Verified against production on 2026-09-08
 * (`docs/probes/2026-09-08-wp0-embedding-baseline.md`): FO ships no manifest,
 * no service worker and no icons, so this app's own at those paths collide
 * with nothing.
 */

export type Owner = "pwa" | "fo-document" | "fo-api" | "fo-static" | "denied" | "unknown";

export interface Registry {
  /** How much of FabOrchestrator this origin serves. See `EmbedMode`. */
  mode: EmbedMode;
  /** False only in `off` mode. */
  enabled: boolean;
  /** The FO documents this origin opens, in catalogue order. */
  surfaces: string[];
  /** Entries in the variable that are not in the catalogue, for a warning. */
  ignored: string[];
}

/**
 * The FabOrchestrator documents this app knows how to open. A value in
 * `FO_EMBED_SURFACES` that is not here is ignored, so a typo cannot proxy an
 * unexpected page. `/settings` is included although FO answers it with a
 * client-side redirect to `/chat` (verified 2026-09-08): listing it keeps a
 * bookmarked or linked `/settings` working the way it does on FO.
 */
export const FO_DOCUMENT_CATALOGUE: readonly string[] = [
  "/chat",
  "/reports",
  "/settings",
  "/home",
  "/modeling-agent",
  "/force-password-change",
];

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
  // This app's own agent screens. FabOrchestrator has no page at either path,
  // so forwarding them in `whole` mode would proxy a 404. They stay this app's
  // and `lib/gateway/destinations.ts` sends them on to `/chat` (WP9).
  "/fabinsight",
  "/backend-agent",
  "/api/pwa",
  "/api/faborch",
  "/pwa-assets",
  // Device enrollment (6 October 2026, `lib/devices/`): the blocked page, the
  // enrollment page and its link, and device administration. FabOrchestrator
  // has none of these paths.
  "/device-blocked",
  "/device-enroll",
  "/device-admin",
  // The developer-only device-credential feasibility test (404 unless
  // DEVICE_CRYPTO_TEST=1).
  "/device-crypto-test",
];

/**
 * The paths **both applications have a page for**, where the mode decides.
 *
 * `/reports` is the only one. This app draws a read-only dashboard list there
 * and FabOrchestrator serves its own Reports page at the same path — the
 * collision WP7 resolved with a flag. It cannot sit in the always-reserved list
 * above, because then FabOrchestrator could never have it; it cannot be
 * unreserved either, because with the embedding off this app must still answer
 * it. So it is checked *after* the document rules: FabOrchestrator wins when the
 * surface is listed or the mode is `whole`, and this app answers otherwise.
 */
export const PWA_CONTESTED_PREFIXES: readonly string[] = ["/reports"];

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
 * How much of FabOrchestrator this origin serves.
 *
 * ── Why this replaced a list of surfaces (audit, 9 September) ───────────────
 * WP1 named its variable `FO_EMBED_SURFACES` — *a list of surfaces* — and every
 * package after it inherited the assumption inside that name. The audit found
 * what it cost: **two of FabOrchestrator's ten pages were served, while
 * forty-eight of its fifty-two API routes already were.** The gateway had been
 * built general and pointed at two paths. A page FabOrchestrator shipped was a
 * 404 here until somebody remembered to list it, which is how its own Back
 * button came to point at a dead page.
 *
 * The product is an installable delivery of FabOrchestrator, not a separate
 * cockpit linking to a few of its pages. So the default inverts:
 *
 *   off       no FabOrchestrator on this origin. Exactly the app of 7 September.
 *   surfaces  WP1–WP9 behaviour: only the documents named in
 *             `FO_EMBED_SURFACES` are FabOrchestrator's. Kept so the migration
 *             is reversible one step at a time rather than all at once.
 *   whole     FabOrchestrator owns this origin's documents except the ones this
 *             app reserves and the ones explicitly denied.
 *
 * **`whole` changes the default for documents only.** The API policy does not
 * invert — see `FO_API_PREFIXES` and `FO_DENIED_PREFIXES`. That asymmetry is
 * deliberate and is the security constraint Amay set: a page
 * FabOrchestrator's team deploys should appear by itself, but an *endpoint*
 * they add should be looked at by a person first.
 */
export type EmbedMode = "off" | "surfaces" | "whole";

/**
 * Parse `FO_EMBED_MODE` and `FO_EMBED_SURFACES`. Pure; takes the environment so
 * tests can pass their own.
 *
 * `FO_EMBED_MODE` wins when set. With it unset the old variable still decides,
 * so a deployment carrying only `FO_EMBED_SURFACES` behaves exactly as it did
 * before this change — which is what makes the migration reversible by
 * configuration rather than by revert.
 */
export function readRegistry(env: Record<string, string | undefined> = process.env): Registry {
  const rawMode = (env.FO_EMBED_MODE ?? "").trim().toLowerCase();
  const raw = (env.FO_EMBED_SURFACES ?? "").trim();

  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const surfaces = FO_DOCUMENT_CATALOGUE.filter((s) => wanted.includes(s));
  const ignored = wanted.filter((w) => !FO_DOCUMENT_CATALOGUE.includes(w));

  if (rawMode === "whole") return { mode: "whole", enabled: true, surfaces, ignored };
  if (rawMode === "off") return { mode: "off", enabled: false, surfaces: [], ignored };

  // Unset, or any value this app does not recognise: fall back to the surface
  // list. An unrecognised mode must not silently open the whole application.
  const enabled = surfaces.length > 0;
  return { mode: enabled ? "surfaces" : "off", enabled, surfaces, ignored };
}

/**
 * Who owns `pathname` on this origin.
 *
 * The order of these tests **is** the security policy, and it does not change
 * between modes: what this app reserves is decided first, what is denied is
 * decided before anything is forwarded, and the API allow-list is consulted
 * before any default applies. Only the last step differs — in `whole` mode a
 * document nobody claimed goes to FabOrchestrator instead of being denied.
 */
export function classify(pathname: string, registry: Registry): Owner {
  if (!registry.enabled) return "pwa";

  // 1. This app's own paths, always, in every mode. The front door, its
  //    session, its build output, its installability and its offline screen are
  //    the things this app exists to provide and can never be handed over.
  if (PWA_RESERVED_EXACT.includes(pathname)) return "pwa";
  if (PWA_RESERVED_PREFIXES.some((p) => underPrefix(pathname, p))) return "pwa";

  // 2. Denied before forwarded, in every mode. Credential, registration,
  //    recovery, scheduled and development-only endpoints, and the two
  //    password-recovery documents. Nothing below can reach them.
  if (FO_DENIED_PREFIXES.some((p) => underPrefix(pathname, p))) return "denied";

  // 3. FabOrchestrator's API — an explicit allow-list in **both** modes. This
  //    is the half that deliberately does not invert.
  if (FO_API_PREFIXES.some((p) => underPrefix(pathname, p))) return "fo-api";
  //    Anything else under `/api/` is unknown, whatever the mode. A new
  //    FabOrchestrator endpoint is a decision, not a deployment side effect.
  if (pathname === "/api" || pathname.startsWith("/api/")) return "unknown";

  // 4. FabOrchestrator's static output.
  if (FO_STATIC_EXACT.includes(pathname)) return "fo-static";
  if (FO_STATIC_PREFIXES.some((p) => underPrefix(pathname, p))) return "fo-static";

  // 5. Documents. In `surfaces` mode only what was named; in `whole` mode
  //    whatever is left, which is what lets a page FabOrchestrator's team
  //    deploys appear here without an edit.
  if (registry.surfaces.some((s) => underPrefix(pathname, s))) return "fo-document";
  if (registry.mode === "whole") return "fo-document";

  // 6. A path both applications claim, which FabOrchestrator did not win above.
  if (PWA_CONTESTED_PREFIXES.some((c) => underPrefix(pathname, c))) return "pwa";

  return "unknown";
}

/** True for the owners the gateway route is allowed to forward. */
export function isForwardable(owner: Owner): boolean {
  return owner === "fo-document" || owner === "fo-api" || owner === "fo-static";
}
