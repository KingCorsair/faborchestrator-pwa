/**
 * This app's session, for an operator **FabOrchestrator has authenticated**.
 *
 * ── There is no credential here, and that is the point (WP2) ────────────────
 * Until 2026-09-01 this file also held a demo credential read from
 * `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD`, checked locally with no network
 * call. It was removed because it produced a session that looked signed in and
 * could not use FabOrchestrator: the login route issued it happily, then every
 * agent screen refused it, which reads as a broken app rather than as the wrong
 * credential. **FabOrchestrator is now the only identity.** The only way to
 * obtain a session is for FO to verify the password against its own `users`
 * table, and this file mints the shell session for whoever FO vouched for.
 *
 * ── Sign-out revokes, and no database was needed ────────────────────────────
 * The plan expected this file to be replaced by a server-side session store, so
 * that signing out could delete a row. It is not, because the same property
 * falls out of binding the two credentials together: the payload carries a
 * fingerprint of the FabOrchestrator token it was minted beside, and
 * `requireAuth` refuses any request whose FO cookie does not match. Sign-out
 * deletes that cookie, so the bearer token left in `localStorage` authenticates
 * nothing — verified end to end, not argued.
 *
 * The approach that was rejected is worth recording: validating each request
 * against FO's own `/api/auth/me`. Every authenticated call to FabOrchestrator
 * sets `last_activity_at = NOW()` (`claudeai_athena/lib/session-audit.ts`), so
 * that would have been a keep-alive — silently defeating FO's 30-minute idle
 * eviction and corrupting the idle figures in its session audit, which is
 * somebody else's compliance record.
 *
 * What remains true: this is a **stateless HMAC**, so an administrator still
 * cannot revoke somebody else's session centrally. Only the holder can, by
 * signing out. A shared session store is the answer if that is ever needed.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The operator, as this app labels them. Every field except `roleName` comes
 * from FabOrchestrator's own login response.
 */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roleName: string;
}

export interface SessionPayload extends SessionUser {
  /** Expiry, epoch milliseconds. */
  exp: number;
  /**
   * Fingerprint of the FabOrchestrator token this session was minted beside.
   *
   * **This is what makes sign-out a revocation.** The session is only accepted
   * on a request that also carries the matching FO cookie, so dropping that
   * cookie — which is all sign-out can do without a database — leaves the
   * bearer token unable to authenticate anything. A copy of the token taken
   * from `localStorage` is inert on its own.
   *
   * A truncated SHA-256, never the token: this payload is base64, not
   * encrypted, and readable by anyone holding it.
   */
  fp: string;
}

/**
 * A short, one-way fingerprint of an FO token.
 *
 * Truncated to 128 bits, which is far beyond what a collision would need to be
 * useful here, and keeps the session token short enough to sit in a header.
 */
export function foFingerprint(foToken: string): string {
  return createHash("sha256").update(foToken).digest("base64url").slice(0, 22);
}

function secret(): string {
  const value = process.env.SESSION_SIGNING_SECRET;
  // A default here would mean every deployment that forgot to set it shared one
  // signing key, and tokens minted anywhere would be valid everywhere.
  if (!value || value.length < 16) {
    throw new Error(
      "SESSION_SIGNING_SECRET is missing or too short. Copy .env.example to .env and set it.",
    );
  }
  return value;
}

function ttlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS ?? "12");
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

/** Constant-time compare that does not leak length through an early return. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so a wrong-length input is not measurably faster.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

/**
 * Mint a session for a user **FabOrchestrator has already authenticated**.
 *
 * This file checks no passwords. It never has one to check: since the demo
 * credential was removed (WP2), the only way to obtain a session is to present
 * FabOrchestrator credentials that FO itself verifies against its own user
 * table. The single caller is `app/api/auth/login/route.ts`, immediately after
 * `foLogin()` returned an FO session — a caller reaching this function with an
 * unverified user is the bug to look for if this file is ever changed.
 *
 * ── `notAfter` reconciles two clocks ────────────────────────────────────────
 * FabOrchestrator's own session carries an absolute expiry, and this app's
 * session must not outlive it: a PWA session that is still valid after FO has
 * dropped its token leaves the operator holding a session that looks signed in
 * and cannot answer a single question. Passing FO's `expiresAt` here caps this
 * session at the earlier of the two.
 *
 * It does **not** cover FO's 30-minute *idle* eviction, which is not a clock
 * that can be predicted at sign-in — that is handled where it becomes
 * observable, in the chat proxy's 401 path, which drops the cookie and asks for
 * a fresh sign-in (`app/api/faborch/[agent]/chat/route.ts`).
 *
 * ── `foToken` binds this session to that one ────────────────────────────────
 * Its fingerprint goes in the payload, and `requireAuth` refuses any request
 * whose FO cookie does not match. That is what lets sign-out revoke without a
 * server-side session store: sign-out deletes the cookie, and the bearer token
 * left behind authenticates nothing.
 */
export function sessionFor(user: SessionUser, notAfter: string, foToken: string): LoginResult {
  let exp = Date.now() + ttlMs();

  if (notAfter) {
    const foExpiry = new Date(notAfter).getTime();
    // An unparseable expiry is ignored rather than trusted: capping to NaN
    // would mint a session that is already dead, which reads as a broken app
    // rather than as the bad input it is.
    if (Number.isFinite(foExpiry)) exp = Math.min(exp, foExpiry);
  }

  const payload: SessionPayload = { ...user, exp, fp: foFingerprint(foToken) };
  const body = b64url(JSON.stringify(payload));

  return {
    token: `${body}.${sign(body)}`,
    expiresAt: new Date(exp).toISOString(),
    user,
  };
}

/** Null for anything malformed, mis-signed or expired. */
export function verifyToken(token: string): SessionPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  if (!safeEqual(signature, sign(body))) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
  return payload;
}
