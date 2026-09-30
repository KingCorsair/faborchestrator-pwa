/**
 * Where the FabOrchestrator session token lives.
 *
 * ── An httpOnly cookie, and not this app's own bearer token ─────────────────
 * This app's session is a stateless HMAC in `localStorage`
 * (`lib/auth.ts`, `components/fab/use-session.ts`) — the same convention the
 * product uses for its own token, and the reason both are readable by any
 * script on the page. That is a considered trade for a demo credential that
 * unlocks mock MES data.
 *
 * **The FO token is not that.** It is a real session against a real
 * FabOrchestrator, carrying that operator's role, their MCP connections, their
 * quota and their audit trail. So it never reaches client JavaScript: the login
 * route sets it as an `httpOnly` cookie, the browser attaches it to same-origin
 * requests without being asked, and only route handlers can read it.
 *
 * That also means the PWA cannot accidentally leak it into a screenshot, a log
 * line or a service-worker cache — the three ways a demo usually loses one.
 *
 * ── Why a cookie rather than a server-side session store ────────────────────
 * There isn't one. `lib/auth.ts` is deliberately stateless so this app needs no
 * database, and `lib/decisions/` shows what a module-level `Map` costs the
 * moment a process restarts. A cookie keeps the token with the browser that
 * earned it and keeps this app's "no session store" property intact.
 */

import type { NextRequest, NextResponse } from "next/server";

/** Named for what it is. Not `session` — this app already has one of those. */
export const FO_TOKEN_COOKIE = "faborch_token";

/** The default for `SESSION_COOKIE_GRACE_S`: five minutes. */
const DEFAULT_COOKIE_GRACE_S = 300;

/**
 * How long the FO cookie outlives this app's session, in seconds (plan RP2,
 * login step 5: `G`, default 5 minutes, `0 < G ≤ 15 min`).
 *
 * An unsound value throws rather than being corrected: a cookie that lives far
 * past the session admits a phone to FabOrchestrator's pages long after sign-in
 * has ended, and a silently "fixed" setting hides that somebody set it wrong.
 */
export function sessionCookieGraceSeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SESSION_COOKIE_GRACE_S?.trim();
  if (!raw) return DEFAULT_COOKIE_GRACE_S;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 900) {
    throw new Error("SESSION_COOKIE_GRACE_S must be a whole number of seconds, above 0 and at most 900.");
  }
  return seconds;
}

/**
 * Attach an FO session to the response.
 *
 * ── It lives as long as this app's session, plus a short grace (plan RP2) ───
 * Until 2026-09-30 the cookie expired with FabOrchestrator's own session, 30
 * days away, while the bearer beside it lasts 12 hours. The sign-in gate only
 * checks that the cookie is present, so a phone kept opening FabOrchestrator's
 * pages for weeks after its session had ended. Now `Max-Age` is this app's
 * session lifetime plus `SESSION_COOKIE_GRACE_S`. `Max-Age` rather than an
 * absolute `Expires`, so a phone whose clock is wrong still drops it on time.
 *
 * The grace is what lets an expiry still revoke: a phone used within it sends
 * the expired bearer beside the cookie, and the gateway clears the cookie and
 * revokes FabOrchestrator's token (G5). A phone left overnight simply drops the
 * cookie; FabOrchestrator's idle rule then refuses the token if it is ever
 * presented again.
 */
export function setFoTokenCookie(
  req: NextRequest,
  res: NextResponse,
  token: string,
  sessionExpiresAt: string,
  now: number = Date.now(),
): void {
  const exp = new Date(sessionExpiresAt).getTime();
  // An unreadable expiry keeps only the grace: short is the safe mistake.
  const lifetime = Number.isFinite(exp) ? Math.max(0, Math.ceil((exp - now) / 1000)) : 0;
  res.cookies.set({
    name: FO_TOKEN_COOKIE,
    value: token,
    httpOnly: true,
    secure: isHttps(req),
    sameSite: "lax",
    path: "/",
    maxAge: lifetime + sessionCookieGraceSeconds(),
  });
}

/**
 * Whether **this request** arrived over HTTPS.
 *
 * ── Not `NODE_ENV === "production"`, and the difference is a real defect ────
 * That was the first version, and it is wrong for the way this demo is
 * actually run. The README's instruction is *"for a demo, always use production
 * mode"* — `npm run build && npm start`, on `http://localhost:3002`. Under that
 * rule `NODE_ENV` is `production` while the scheme is plain HTTP, so the cookie
 * would be marked `Secure` on an origin that is not. Chrome treats `localhost`
 * as trustworthy and stores it anyway; Safari has not always, and the failure
 * mode is silent — sign-in succeeds, the cookie never arrives, and FabInsight
 * says the session is not signed in to FabOrchestrator on every single turn.
 *
 * The scheme is the thing that actually matters, so the scheme is what is
 * read. `x-forwarded-proto` first, because every deployment this app has had
 * terminates TLS in front of the container — CloudFront and Fly both do — and
 * the request reaching Node is plain HTTP there. Deployed, this is `true` and
 * the cookie is `Secure`, which is the property that matters in the place it
 * matters.
 */
export function isHttps(req: NextRequest): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  return req.nextUrl.protocol === "https:";
}

/** Drop it. Called on sign-out, and whenever FO says the token is no good. */
export function clearFoTokenCookie(res: NextResponse): void {
  res.cookies.set({ name: FO_TOKEN_COOKIE, value: "", path: "/", maxAge: 0 });
}

/** The FO token on this request, or null. Route handlers only. */
export function foTokenFrom(req: NextRequest): string | null {
  return req.cookies.get(FO_TOKEN_COOKIE)?.value || null;
}
