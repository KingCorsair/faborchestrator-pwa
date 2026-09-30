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

const UPSTREAM_ALLOW = new Set([
  "accept",
  "accept-language",
  "content-type",
  "content-length",
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

/** A `Location` on the FO origin becomes a path on this one; anything else passes through. */
export function rewriteLocation(location: string, foOrigin: string): string {
  const origin = foOrigin.replace(/\/+$/, "");
  if (location === origin) return "/";
  if (location.startsWith(`${origin}/`)) return location.slice(origin.length);
  return location;
}

/** The headers the browser will see. */
export function downstreamResponseHeaders(upstream: Headers, foOrigin: string): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!DOWNSTREAM_ALLOW.has(k)) return;
    out.set(k, k === "location" ? rewriteLocation(value, foOrigin) : value);
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
