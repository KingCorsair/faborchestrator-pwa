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
 * ⚠ **This is still not the product's session store.** FO issues opaque tokens
 * recorded in PostgreSQL (`claudeai_athena/lib/auth-middleware.ts`); this app
 * issues a **stateless HMAC**, so nothing server-side records that a session
 * exists and sign-out cannot revoke one — it clears the client and drops the FO
 * cookie. What that is worth is bounded now that FO is the only identity: this
 * token alone reaches the order workflow's mock data and `/api/auth/me`, and
 * nothing in FabOrchestrator, because every FO call needs the httpOnly cookie
 * that sign-out removes.
 *
 * Replacing the HMAC with a revocable server-side session is the remaining WP2
 * item; it needs a database, which this app deliberately does not yet require.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

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
 */
export function sessionFor(user: SessionUser, notAfter?: string): LoginResult {
  let exp = Date.now() + ttlMs();

  if (notAfter) {
    const foExpiry = new Date(notAfter).getTime();
    // An unparseable expiry is ignored rather than trusted: capping to NaN
    // would mint a session that is already dead, which reads as a broken app
    // rather than as the bad input it is.
    if (Number.isFinite(foExpiry)) exp = Math.min(exp, foExpiry);
  }

  const payload: SessionPayload = { ...user, exp };
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
