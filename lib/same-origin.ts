/**
 * Did this request come from this app's own pages? (plan RP3 part 5,
 * `sameOriginVerdict`; used by sign-out under RP2.)
 *
 *   Sec-Fetch-Site: same-origin          → same-origin
 *   Sec-Fetch-Site: cross-site|same-site → cross-site
 *   Sec-Fetch-Site: none                 → unknown (typed into the address bar)
 *   otherwise, Origin present:
 *     equal to PUBLIC_ORIGIN             → same-origin
 *     "null"                             → cross-site (sandboxed or opaque)
 *     anything else                      → cross-site, when PUBLIC_ORIGIN is set
 *   neither header                       → unknown
 *
 * `unknown` is allowed through, deliberately: every browser the app supports
 * (Safari from 16.4, the install floor; Chrome and Firefox for years) sends
 * `Sec-Fetch-Site` on every request, so a request with neither header is a
 * non-browser client, which cannot be the victim of a forged form post.
 *
 * `PUBLIC_ORIGIN` is configuration, never read from `Host` (RP2/RP3-D3). Until
 * a deployment sets it, an `Origin` header other than `null` is `unknown`
 * rather than guessed at; `Sec-Fetch-Site`, which every supported browser
 * sends, decides in practice.
 */

export type SameOriginVerdict = "same-origin" | "cross-site" | "unknown";

export function sameOriginVerdict(headers: Headers, publicOrigin: string | null): SameOriginVerdict {
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "same-origin") return "same-origin";
  if (site === "cross-site" || site === "same-site") return "cross-site";
  if (site === "none") return "unknown";

  const origin = headers.get("origin")?.trim();
  if (!origin) return "unknown";
  if (origin === "null") return "cross-site";
  if (!publicOrigin) return "unknown";
  return origin === publicOrigin ? "same-origin" : "cross-site";
}

/** `PUBLIC_ORIGIN`, normalised to `scheme://host[:port]`, or null when unset or unusable. */
export function publicOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.PUBLIC_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
