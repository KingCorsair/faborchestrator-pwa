/**
 * Header policy for the FabOrchestrator gateway.
 *
 * Both directions are allow-lists. A header that is not named here does not
 * cross, which is the property that keeps this app's cookies away from
 * FabOrchestrator and FabOrchestrator's load-balancer cookies away from the
 * phone.
 *
 * ── Upstream (browser → FabOrchestrator) ────────────────────────────────────
 * Forwarded: the content-negotiation headers a page needs, the App Router's
 * own navigation headers (`rsc`, `next-router-*`, `next-url`) so FO answers a
 * client-side navigation with the payload its router expects, range and
 * conditional-request headers for assets, and the user agent for FO's session
 * audit. Added: `x-forwarded-for` and `x-forwarded-proto`, so FO's login and
 * activity records carry the phone's address rather than the gateway's.
 *
 * Never forwarded: `cookie` (this app's session lives there; FO uses no
 * cookies), `authorization` in WP1 (WP2 replaces it with the FO token from
 * the cookie, after verifying this app's own session), `host` (set by fetch
 * from the upstream URL), and the hop-by-hop set.
 *
 * ── Downstream (FabOrchestrator → browser) ──────────────────────────────────
 * Forwarded: content type, caching and validation headers, content
 * disposition and ranges. Dropped: `set-cookie` (the ALB stickiness cookies
 * FO's origin sets on every response, verified 2026-09-08, which have no
 * meaning here), `content-encoding` and `content-length` (fetch has already
 * decompressed the body; forwarding either would describe bytes that are not
 * being sent), and the hop-by-hop set.
 *
 * ── Two overrides ───────────────────────────────────────────────────────────
 * HTML and RSC payloads are re-served with `no-cache, must-revalidate`. FO
 * sends `s-maxage=31536000` plus an ETag on every document (verified
 * 2026-09-08). Held by a phone, a year-old document names chunks a later
 * deploy has removed and the page paints and never hydrates — the exact
 * defect this app fixed for its own documents on 2026-08-19. Revalidation
 * with the ETag costs a 304.
 *
 * Streams keep `no-cache, no-transform` and gain `X-Accel-Buffering: no`, the
 * same two headers the existing chat proxy sends, so nothing between here and
 * the phone buffers a minutes-long answer into one lump.
 *
 * A `Location` that points at the FabOrchestrator origin is rewritten to a
 * path on this origin, so a redirect never carries the phone off to
 * CloudFront. FO sends none today; the rule exists so that the day it does,
 * the app does not silently leave its own origin.
 */

// `content-length` is deliberately absent (plan RP1 part 3): the gateway reads
// and measures every body before forwarding it, and sets the length from the
// bytes it actually holds. Forwarding the phone's own claim is what produced
// the length-mismatch 502 when Next had cut the body short (G2).
const UPSTREAM_ALLOW = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "range",
  "if-none-match",
  "if-modified-since",
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
]);

const DOWNSTREAM_ALLOW = new Set([
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "vary",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "location",
]);

/** The headers FabOrchestrator will see. */
export function upstreamRequestHeaders(
  incoming: Headers,
  client: { ip: string | null; proto: string },
): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    if (UPSTREAM_ALLOW.has(key.toLowerCase())) out.set(key, value);
  });
  if (client.ip) out.set("x-forwarded-for", client.ip);
  out.set("x-forwarded-proto", client.proto);
  return out;
}

export function isDocumentContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith("text/html") || ct.startsWith("text/x-component");
}

export function isStreamContentType(contentType: string | null): boolean {
  return !!contentType && contentType.toLowerCase().startsWith("text/event-stream");
}

/**
 * A `Location` on a FabOrchestrator origin becomes a path on this one; anything
 * else passes through. Every FO origin in use is checked, not only the one the
 * request went to (plan RP1, G17): with the preview's UI build answering pages
 * and `FABORCH_BASE_URL` answering the API, a redirect naming the other origin
 * would otherwise carry the phone off this app.
 */
export function rewriteLocation(location: string, foOrigins: string | readonly string[]): string {
  for (const candidate of typeof foOrigins === "string" ? [foOrigins] : foOrigins) {
    const origin = candidate.replace(/\/+$/, "");
    if (location === origin) return "/";
    if (location.startsWith(`${origin}/`)) return location.slice(origin.length);
  }
  return location;
}

/** The headers the browser will see. */
export function downstreamResponseHeaders(upstream: Headers, foOrigins: string | readonly string[]): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!DOWNSTREAM_ALLOW.has(k)) return;
    out.set(k, k === "location" ? rewriteLocation(value, foOrigins) : value);
  });

  const contentType = out.get("content-type");
  if (isDocumentContentType(contentType)) {
    out.set("cache-control", "no-cache, must-revalidate");
  } else if (isStreamContentType(contentType)) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }
  return out;
}

// ── FabOrchestrator API responses, and generated files (2026-09-30) ─────────

/** `/api/files/{id}/download`: a file FabOrchestrator's model made. */
const FILE_DOWNLOAD = /^\/api\/files\/[^/]+\/download$/;

export function isFileDownload(pathname: string): boolean {
  return FILE_DOWNLOAD.test(pathname);
}

/**
 * Harden what the gateway returns for FabOrchestrator's API (feature parity
 * with the chetan branch's download route, `3d4fc1a`; plan RP7).
 *
 *  - **`nosniff` on every API response.** The browser takes the declared type
 *    at its word and never guesses one; an API answer is data, never a page.
 *    Not added to FO's documents and static assets, where a type FO got
 *    slightly wrong would otherwise stop its own script loading.
 *  - **A generated file is always a download.** FabOrchestrator's route sends
 *    `attachment` today ([FO-clone] `app/api/files/[fileId]/download`), but
 *    the file is a model's output served from *this* origin, where a document
 *    rendered inline could read the session this origin keeps. So `inline` or
 *    a missing disposition becomes `attachment` (the filename is kept), and
 *    `Content-Security-Policy: sandbox` means that even a file opened directly
 *    cannot run script as this origin.
 *
 * **Who may download which file is not decided here.** FabOrchestrator checks
 * only that the caller is signed in; whether that is fixed in FabOrchestrator
 * or proved at the gateway is an open ownership decision.
 */
export function hardenFoApiHeaders(pathname: string, headers: Headers): void {
  headers.set("x-content-type-options", "nosniff");
  if (!isFileDownload(pathname)) return;
  const disposition = headers.get("content-disposition")?.trim() ?? "";
  if (!disposition) {
    headers.set("content-disposition", "attachment");
  } else if (!/^attachment\b/i.test(disposition)) {
    // `inline; filename="x.html"` → `attachment; filename="x.html"`
    const params = disposition.includes(";") ? disposition.slice(disposition.indexOf(";")) : "";
    headers.set("content-disposition", `attachment${params}`);
  }
  headers.set("content-security-policy", "sandbox");
}
