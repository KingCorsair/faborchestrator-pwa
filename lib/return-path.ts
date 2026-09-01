/**
 * Where sign-in sends you afterwards.
 *
 * ── Why this exists (2026-08-19) ────────────────────────────────────────────
 * Sign-in always landed on `/orders`, from wherever you had been bounced. With
 * a landing page carrying **one** door that was invisible — the door pointed at
 * `/orders` anyway. The landing page now offers three, so "Read the audit
 * trail" that silently deposits you on the order list is a promise the front
 * door makes and does not keep. `/login?next=/activity` keeps it.
 *
 * ── Why a validator and not `next` straight into `router.replace` ───────────
 * A redirect target taken from the URL is the textbook open redirect: anyone
 * can hand out `…/login?next=https://evil.example` and the sign-in page, which
 * is the one screen a stranger is expected to trust, sends them there after
 * they type a password. This app is deployed on a public URL (see CLAUDE.md,
 * "Hosted deployment"), so that link is postable to anyone.
 *
 * The rule is narrow on purpose: an absolute path on this origin and nothing
 * else. Everything rejected falls back to `/orders`, which is exactly the
 * behaviour that shipped before, so a bad value degrades to the old default
 * rather than to an error.
 */

/** Where sign-in goes when nothing better is asked for. */
export const DEFAULT_RETURN_PATH = "/orders";

/**
 * The path to return to after signing in, or `fallback` if the value cannot be
 * proven to be a same-origin path.
 *
 * Accepts `string[]` because a query string can repeat a key (`?next=/a&next=/b`),
 * and Next hands that over as an array. The first wins; an attacker gains
 * nothing from either choice since both are validated.
 */
export function safeReturnPath(
  raw: string | string[] | null | undefined,
  fallback: string = DEFAULT_RETURN_PATH,
): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value === "") return fallback;

  // Control characters, including the tab/newline/CR that browsers strip from a
  // URL before resolving it — "/\n/evil.example" is a protocol-relative URL by
  // the time it is navigated, and would pass every check below.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;

  // A backslash is normalised to a forward slash by every browser, so "/\evil"
  // is "//evil" — another origin wearing a path's clothes.
  if (value.includes("\\")) return fallback;

  // One leading slash exactly. Two is protocol-relative and leaves the origin.
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;

  // No scheme anywhere. Belt and braces given the checks above, and cheap.
  if (value.includes(":")) return fallback;

  // Bouncing sign-in back to sign-in is a loop, not a destination.
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) {
    return fallback;
  }

  return value;
}

/**
 * `/login`, carrying the current location so sign-in can return to it.
 *
 * Reads `window.location` rather than `useSearchParams`, deliberately: that
 * hook forces every caller into a Suspense boundary, and this is called from
 * an effect that already only runs in the browser.
 */
export function loginHref(): string {
  if (typeof window === "undefined") return "/login";

  const here = window.location.pathname + window.location.search;
  const target = safeReturnPath(here, "");

  // Nothing worth carrying: unusable, or the place sign-in goes by default.
  if (!target || target === DEFAULT_RETURN_PATH) return "/login";

  return `/login?next=${encodeURIComponent(target)}`;
}
