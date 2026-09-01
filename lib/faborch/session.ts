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

/**
 * Attach an FO session to the response.
 *
 * `expiresAt` is FO's own — its sessions last 30 days
 * (`claudeai_athena/app/api/auth/login/route.ts:54`) and this app must not
 * outlive it, or the cookie would keep sending a token FO has already dropped.
 */
export function setFoTokenCookie(
  req: NextRequest,
  res: NextResponse,
  token: string,
  expiresAt: string,
): void {
  const expires = new Date(expiresAt);
  res.cookies.set({
    name: FO_TOKEN_COOKIE,
    value: token,
    httpOnly: true,
    secure: isHttps(req),
    sameSite: "lax",
    path: "/",
    expires: Number.isNaN(expires.getTime()) ? undefined : expires,
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
function isHttps(req: NextRequest): boolean {
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
