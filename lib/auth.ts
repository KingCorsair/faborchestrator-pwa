/**
 * Demo authentication.
 *
 * ⚠ **This is not the product's authentication.** FabOrchestrator authenticates
 * against a `users` table with scrypt hashes and issues opaque session tokens
 * stored in PostgreSQL (`claudeai_athena/lib/auth-middleware.ts` +
 * `lib/storage.ts`). This demo has no database, so it does the smallest thing
 * that keeps the *shape* identical — a bearer token, an `Authorization` header
 * on every request, `requireAuth` in front of every route — without pulling
 * Prisma and a schema into a Tier 0 demo.
 *
 * What that costs, stated plainly so nobody ships it by accident:
 *
 *  - One credential pair, from the environment. No user table, no registration.
 *  - Tokens are **stateless HMACs**. Nothing server-side records that a session
 *    exists, so logout cannot revoke one — it only clears the client. A stolen
 *    token is valid until it expires.
 *  - No rate limiting, no lockout, no password reset, no audit trail.
 *
 * Replacing this with the real thing means swapping this file and
 * `auth-middleware.ts` for the product's; nothing else imports either.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface DemoUser {
  id: string;
  email: string;
  name: string;
  roleName: string;
}

export interface SessionPayload extends DemoUser {
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

/** The single configured operator, or null when the environment is incomplete. */
function configuredUser(): { user: DemoUser; password: string } | null {
  const email = process.env.DEMO_USER_EMAIL;
  const password = process.env.DEMO_USER_PASSWORD;
  if (!email || !password) return null;
  return {
    user: {
      id: "USR-DEMO-1",
      email,
      name: process.env.DEMO_USER_NAME ?? "Supervisor",
      roleName: process.env.DEMO_USER_ROLE ?? "Supervisor",
    },
    password,
  };
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: DemoUser;
}

/** Null on bad credentials — the caller must not distinguish which half was wrong. */
export function authenticate(email: string, password: string): LoginResult | null {
  const configured = configuredUser();
  if (!configured) return null;

  const emailOk = safeEqual(email.trim().toLowerCase(), configured.user.email.trim().toLowerCase());
  const passwordOk = safeEqual(password, configured.password);
  if (!emailOk || !passwordOk) return null;

  return sessionFor(configured.user);
}

/**
 * Mint a session for a user who has **already** been authenticated elsewhere.
 *
 * Extracted from `authenticate` on 2026-08-23, unchanged, so the login route
 * can issue this app's session to somebody FabOrchestrator vouched for. FO owns
 * a real user table with scrypt hashes; this app owns the shell those users see
 * in the PWA. Nothing here checks a password, and the one caller that does not
 * is `app/api/auth/login/route.ts` immediately after `foLogin` returned a
 * session — so a caller reaching this function with an unverified user is the
 * bug to look for if this file is ever changed.
 */
export function sessionFor(user: DemoUser): LoginResult {
  const exp = Date.now() + ttlMs();
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
