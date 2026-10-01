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
 * fingerprint of the FabOrchestrator token it was minted beside, and every
 * check (`lib/auth/verify-session.ts`) refuses a request whose FO cookie does
 * not match. Sign-out deletes that cookie, so the bearer token left in
 * `localStorage` authenticates nothing — verified end to end, not argued.
 *
 * The approach that was rejected is worth recording: validating each request
 * against FO's own `/api/auth/me`. Every authenticated call to FabOrchestrator
 * sets `last_activity_at = NOW()` (`claudeai_athena/lib/session-audit.ts`), so
 * that would have been a keep-alive — silently defeating FO's 30-minute idle
 * eviction and corrupting the idle figures in its session audit, which is
 * somebody else's compliance record.
 *
 * ── Signing keys with explicit ids (plan RP2 part 5, finding m2) ────────────
 * One secret with no id meant rotating it signed everyone out. Every token now
 * names the key it was signed with (`kid`, a public, non-secret label such as
 * `2026-09`), and verification looks that id up among the current key and any
 * previous keys kept for one transition period:
 *
 *   SESSION_SIGNING_KEY_ID          the current key's id; written into new tokens
 *   SESSION_SIGNING_SECRET          the current secret; at least 32 characters
 *   SESSION_SIGNING_PREVIOUS_KEYS   `id:secret,id:secret`, verify-only
 *
 * Rotation: set a new id and secret as current, move the old pair to previous,
 * wait one absolute TTL (12 h), then remove it. Nobody is signed out unless a
 * key is removed early. The id is never derived from the secret, so it reveals
 * nothing. New tokens also carry `iat`, `iss` and `aud`, and a token whose
 * audience is not this app's is refused.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Who issues these tokens and who they are for. Both are this app. */
export const SESSION_ISSUER = "faborch-pwa";
export const SESSION_AUDIENCE = "faborch-pwa";

/** The shortest secret accepted (RP2 part 5; it was 16 until 2026-09-30). */
export const MIN_SECRET_LENGTH = 32;

/** A key id: a short public label, never anything derived from the secret. */
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

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
  /** Issued at, epoch milliseconds. Absent only on tokens minted before 2026-09-30. */
  iat?: number;
  iss?: string;
  aud?: string;
  /** The signing key's public id. Absent only on tokens minted before 2026-09-30. */
  kid?: string;
  /**
   * The seat: which device this session was started on (`lib/faborch/device.ts`).
   * A one-way hash of the device's key, never the key. It is what separates two
   * devices signed in to the same FabOrchestrator account: the gateway lets a
   * session use only the conversations its seat started
   * (`lib/gateway/seats.ts`). Signed with the rest of the payload, so a client
   * cannot claim another seat. Absent only on tokens minted before 2026-10-01,
   * which can use no conversation route.
   */
  sid?: string;
}

/** A seat id: 43 base64url characters (`seatIdFor`). */
const SEAT_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * A short, one-way fingerprint of an FO token.
 *
 * Truncated to 128 bits, which is far beyond what a collision would need to be
 * useful here, and keeps the session token short enough to sit in a header.
 */
export function foFingerprint(foToken: string): string {
  return createHash("sha256").update(foToken).digest("base64url").slice(0, 22);
}

/** The signing configuration is unusable. Raised loudly, never worked around. */
export class SessionConfigError extends Error {
  constructor(
    message: string,
    /** Which setting is wrong, safe to log (the message is not, in production). */
    readonly setting: "SESSION_SIGNING_SECRET" | "SESSION_SIGNING_KEY_ID" | "SESSION_SIGNING_PREVIOUS_KEYS",
  ) {
    super(message);
    this.name = "SessionConfigError";
  }
}

export interface KeyRing {
  current: { id: string; secret: string };
  /** Every key that may verify a token: the current one and the previous ones. */
  byId: ReadonlyMap<string, string>;
}

/**
 * The keys in force, read from the environment on every call so a test or a
 * redeploy needs no restart logic. Throws `SessionConfigError` for anything
 * unsound: a default here would mean every deployment that forgot a setting
 * shared one key, and tokens minted anywhere would be valid everywhere.
 */
export function sessionKeyRing(env: Record<string, string | undefined> = process.env): KeyRing {
  const secret = env.SESSION_SIGNING_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new SessionConfigError(
      `SESSION_SIGNING_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters. ` +
        "Generate one with the command in .env.example.",
      "SESSION_SIGNING_SECRET",
    );
  }
  const id = (env.SESSION_SIGNING_KEY_ID ?? "").trim();
  if (!KEY_ID.test(id)) {
    throw new SessionConfigError(
      "SESSION_SIGNING_KEY_ID is not set, or is not a short label of letters, digits, '.', '_' or '-'. " +
        "Set a public id for the current key, for example 2026-09 (see .env.example).",
      "SESSION_SIGNING_KEY_ID",
    );
  }

  const byId = new Map<string, string>([[id, secret]]);
  for (const entry of (env.SESSION_SIGNING_PREVIOUS_KEYS ?? "").split(",")) {
    if (!entry.trim()) continue;
    const colon = entry.indexOf(":");
    const previousId = colon > 0 ? entry.slice(0, colon).trim() : "";
    const previousSecret = colon > 0 ? entry.slice(colon + 1).trim() : "";
    if (!KEY_ID.test(previousId) || previousSecret.length < MIN_SECRET_LENGTH) {
      throw new SessionConfigError(
        "SESSION_SIGNING_PREVIOUS_KEYS must be comma-separated id:secret pairs, each secret at least " +
          `${MIN_SECRET_LENGTH} characters.`,
        "SESSION_SIGNING_PREVIOUS_KEYS",
      );
    }
    if (byId.has(previousId)) {
      throw new SessionConfigError(
        `Signing key id "${previousId}" appears twice; every key needs its own id.`,
        "SESSION_SIGNING_PREVIOUS_KEYS",
      );
    }
    byId.set(previousId, previousSecret);
  }
  return { current: { id, secret }, byId };
}

function ttlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS ?? "12");
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
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
 * table. The single caller is `app/api/pwa/auth/login/route.ts`, immediately
 * after `foLogin()` returned an FO session — a caller reaching this function
 * with an unverified user is the bug to look for if this file is ever changed.
 *
 * ── `notAfter` reconciles two clocks ────────────────────────────────────────
 * FabOrchestrator's own session carries an absolute expiry, and this app's
 * session must not outlive it: a PWA session that is still valid after FO has
 * dropped its token leaves the operator holding a session that looks signed in
 * and cannot answer a single question. Passing FO's `expiresAt` here caps this
 * session at the earlier of the two. FO's 30-minute *idle* eviction cannot be
 * predicted at sign-in and is handled where it becomes observable: an FO 401.
 *
 * ── `foToken` binds this session to that one ────────────────────────────────
 * Its fingerprint goes in the payload, and every check refuses a request whose
 * FO cookie does not match. That is what lets sign-out revoke without a
 * server-side session store.
 */
export function sessionFor(
  user: SessionUser,
  notAfter: string,
  foToken: string,
  now: number = Date.now(),
  seatId?: string,
): LoginResult {
  const ring = sessionKeyRing();
  let exp = now + ttlMs();

  if (notAfter) {
    const foExpiry = new Date(notAfter).getTime();
    // An unparseable expiry is ignored rather than trusted: capping to NaN
    // would mint a session that is already dead, which reads as a broken app
    // rather than as the bad input it is.
    if (Number.isFinite(foExpiry)) exp = Math.min(exp, foExpiry);
  }

  const payload: SessionPayload = {
    ...user,
    exp,
    fp: foFingerprint(foToken),
    iat: now,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    kid: ring.current.id,
    ...(seatId ? { sid: seatId } : {}),
  };
  const body = b64url(JSON.stringify(payload));

  return {
    token: `${body}.${sign(body, ring.current.secret)}`,
    expiresAt: new Date(exp).toISOString(),
    user,
  };
}

/**
 * What a presented token is, finer than yes/no. The gateway needs to tell an
 * expired session (a real one that has ended, whose cookie should be cleared
 * and whose FO token revoked, plan RP2 G5) from a malformed or forged one
 * (which changes nothing).
 */
export type TokenInspection =
  | { kind: "valid"; payload: SessionPayload }
  | { kind: "expired"; payload: SessionPayload }
  | { kind: "invalid" };

const INVALID: TokenInspection = { kind: "invalid" };

export function inspectToken(token: string, now: number = Date.now()): TokenInspection {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return INVALID;
  const [body, signature] = parts as [string, string];

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return INVALID;
  }
  if (!payload || typeof payload !== "object") return INVALID;

  // The key is chosen by the token's public `kid`. A token with no `kid` was
  // minted before the key ring shipped (2026-09-30), signed with whatever
  // single secret was in force then, so it is tried against every key in the
  // ring: a rotation soon after the deploy then signs nobody out either. That
  // compatibility window closes by itself one TTL (12 h) after the deploy,
  // because no token without a `kid` is minted any more; this branch can then
  // be deleted.
  const ring = sessionKeyRing();
  const candidates =
    payload.kid === undefined
      ? [...ring.byId.values()]
      : typeof payload.kid === "string" && ring.byId.has(payload.kid)
        ? [ring.byId.get(payload.kid)!]
        : [];
  if (!candidates.some((secret) => safeEqual(signature, sign(body, secret)))) return INVALID;

  if (payload.kid !== undefined) {
    if (payload.iss !== SESSION_ISSUER || payload.aud !== SESSION_AUDIENCE || typeof payload.iat !== "number") {
      return INVALID;
    }
  }
  if (typeof payload.exp !== "number" || typeof payload.fp !== "string" || !payload.fp) return INVALID;
  // A seat, when a token carries one, is one of ours or the token is not.
  if (payload.sid !== undefined && !(typeof payload.sid === "string" && SEAT_ID.test(payload.sid))) return INVALID;

  return payload.exp <= now ? { kind: "expired", payload } : { kind: "valid", payload };
}

/** Null for anything malformed, mis-signed or expired. */
export function verifyToken(token: string): SessionPayload | null {
  const inspected = inspectToken(token);
  return inspected.kind === "valid" ? inspected.payload : null;
}
