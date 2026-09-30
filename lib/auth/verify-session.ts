/**
 * The one session check (plan RP2, "Normal request").
 *
 * `requireAuth` (this app's own routes) and `bridgeAuthorization` (the
 * gateway, before it injects FabOrchestrator's token) used to carry two copies
 * of the same four checks. Two copies drift, and a drift here is either a
 * bypass or a lock-out, so both now call this.
 *
 * A session is valid only when both credentials are present together:
 *   1. a bearer that verifies as this app's session (signature, key id,
 *      audience) and has not expired, and
 *   2. the FabOrchestrator cookie on the same request, fingerprinting to the
 *      token that session was minted beside.
 *
 * The verdict says *why* a check failed because one caller must act on it: the
 * gateway ends the session (clears the cookie and revokes FO's token) when a
 * real session has ended and **the cookie on the request is that session's
 * own** — an `expired` bearer whose fingerprint matches the cookie — and
 * changes nothing otherwise. A malformed bearer may be a stray header; a
 * bearer beside a cookie that is not its own (`mismatch`) says nothing about
 * the cookie's session, which may be a newer sign-in on the same browser that
 * is still in use in another tab (review of c193e9e, 30 September 2026: the
 * old rule revoked exactly that session). **The reason is never shown to the
 * caller**: every failure answers with the same status and wording, so an
 * attacker learns nothing about which half to work on.
 */

import { foFingerprint, inspectToken, type SessionPayload } from "@/lib/auth";

export type SessionCheck =
  | { ok: true; session: SessionPayload; foToken: string }
  | { ok: false; why: "no-bearer" | "invalid" }
  | {
      ok: false;
      why: "expired" | "mismatch";
      /**
       * Whether the cookie on the request fingerprints to this bearer's own
       * FabOrchestrator token. Only then may a caller end the cookie's session
       * on this bearer's account. Always false for `mismatch`, by definition.
       */
      cookieIsOwn: boolean;
    };

export function checkSession(authorization: string | null, foToken: string | null): SessionCheck {
  if (!authorization) return { ok: false, why: "no-bearer" };
  if (!authorization.startsWith("Bearer ")) return { ok: false, why: "invalid" };

  const inspected = inspectToken(authorization.slice("Bearer ".length));
  if (inspected.kind === "invalid") return { ok: false, why: "invalid" };

  const cookieIsOwn = !!foToken && inspected.payload.fp === foFingerprint(foToken);
  if (inspected.kind === "expired") return { ok: false, why: "expired", cookieIsOwn };
  if (!cookieIsOwn) return { ok: false, why: "mismatch", cookieIsOwn: false };
  return { ok: true, session: inspected.payload, foToken: foToken! };
}

/** The one refusal every failed check answers with (plan RP5: `session_invalid`). */
export const SESSION_INVALID = {
  code: "session_invalid",
  error: "Your session has ended. Sign in again.",
} as const;
