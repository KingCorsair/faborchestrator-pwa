/**
 * The single-login bridge: this app's session in, FabOrchestrator's token out.
 *
 * ── The problem it solves (WP2, 2026-09-08) ─────────────────────────────────
 * After WP1, FabOrchestrator's own pages run on this origin and its client
 * calls its own API here. Those calls carry whatever is in
 * `localStorage["llmatscale_auth_token"]`, and on this origin that is **this
 * app's** session — a signed HMAC, meaningless to FabOrchestrator. So FO
 * answered 401 to every one of them and its client showed "You've been signed
 * out". That was WP1's accepted boundary; removing it is this file.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * For a forwarded `/api/*` request carrying a bearer token, it proves the
 * caller holds a live session of *this* app and then hands the gateway the
 * FabOrchestrator token to use instead. Two things must agree, exactly as
 * `lib/auth-middleware.ts` requires of this app's own routes:
 *
 *   1. the bearer verifies as this app's session (signature and expiry), and
 *   2. the FabOrchestrator cookie on the same request fingerprints to the one
 *      that session was minted beside.
 *
 * Both, or nothing is injected. That second check is what makes sign-out a
 * revocation without a session store: signing out drops the cookie, so a
 * bearer copied out of `localStorage` fingerprints against nothing and buys
 * its holder no FabOrchestrator access at all.
 *
 * ── Where the credential lives, and where it does not ───────────────────────
 * The FabOrchestrator token is read from the httpOnly cookie on the server and
 * written onto the upstream request. It is never returned downstream, never
 * placed in a response header, and never reaches client JavaScript — which is
 * the property `lib/faborch/session.ts` exists to keep and
 * `scripts/security-review.mjs` asserts against the deployment.
 *
 * ── Why a missing bearer is forwarded rather than refused ───────────────────
 * Some FabOrchestrator endpoints are public — `/api/platform-theme` is fetched
 * by its root layout before anyone signs in. A request with no bearer is
 * therefore passed through untouched and FabOrchestrator decides; a request
 * with a bearer that does not verify is refused here, because that is a claim
 * to a session this app can see is not real.
 *
 * ── A refusal that ends a session (plan RP2, finding G5) ────────────────────
 * When the bearer is a real session that has ended — expired, or paired with
 * an FO cookie that is not its own — the refusal also carries the cookie's FO
 * token, so the gateway can clear the cookie and revoke that token after the
 * response. Clearing alone is not enough: the client's follow-up sign-out then
 * arrives with no cookie and cannot revoke, and FabOrchestrator keeps the
 * session row until its own 30-day expiry. A malformed bearer ends nothing; it
 * may be a stray header.
 */

import type { NextRequest } from "next/server";
import { checkSession } from "@/lib/auth/verify-session";
import { foTokenFrom } from "@/lib/faborch/session";

export type BridgeVerdict =
  /** No bearer was offered. Forward as-is; FabOrchestrator answers for itself. */
  | { action: "forward-anonymous" }
  /**
   * A live session of this app, holding the matching cookie. Use this token.
   * `userId` is the verified session's FabOrchestrator user id.
   */
  | { action: "inject"; foToken: string; userId: string }
  /**
   * A bearer that does not verify, or verifies without its cookie. Refuse.
   * `endSession` names the FO token to revoke when a real session has ended.
   */
  | { action: "refuse"; reason: string; endSession: { foToken: string } | null };

/** Decide what Authorization, if any, FabOrchestrator should see. */
export function bridgeAuthorization(req: NextRequest): BridgeVerdict {
  const foToken = foTokenFrom(req);
  const check = checkSession(req.headers.get("authorization"), foToken);
  if (check.ok) return { action: "inject", foToken: check.foToken, userId: check.session.id };
  if (check.why === "no-bearer") return { action: "forward-anonymous" };

  // One reason for every failure: saying which check failed tells an attacker
  // which to work on. Same rule as `lib/auth-middleware.ts`.
  const ended = check.why === "expired" || check.why === "mismatch";
  return {
    action: "refuse",
    reason: "Invalid or expired session",
    endSession: ended && foToken ? { foToken } : null,
  };
}

/**
 * Paths where FabOrchestrator's answer changes this app's session too.
 *
 * `/api/auth/logout` is the only one today. FabOrchestrator's own sidebar
 * signs out through it, and when FO deletes the session the cookie this app
 * holds is worthless — so the gateway drops it on the way back and the next
 * navigation meets the sign-in gate rather than a cockpit the operator can no
 * longer use. FO answers 404 when it had already dropped the session; the
 * outcome asked for is the same, so that counts too.
 */
export function endsTheSession(pathname: string, upstreamStatus: number): boolean {
  if (pathname !== "/api/auth/logout") return false;
  return upstreamStatus === 200 || upstreamStatus === 204 || upstreamStatus === 404;
}

/**
 * Whether an upstream 401 on an injected request means this app's cookie is
 * dead and should be dropped.
 *
 * FabOrchestrator evicts a session after 30 minutes idle and expires it
 * absolutely at 30 days. Either way the token in the cookie has stopped
 * working, and keeping it would leave the operator holding a session that
 * passes this app's gate and cannot answer a single question — the exact
 * failure `app/api/faborch/[agent]/chat/route.ts` already handles for the
 * screens this app draws itself.
 */
export function expiredUpstream(injected: boolean, upstreamStatus: number): boolean {
  return injected && upstreamStatus === 401;
}
