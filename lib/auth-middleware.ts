/**
 * Route guard, matching FabOrchestrator's convention.
 *
 * `requireAuth` returns either `{ user }` or a `NextResponse` to return
 * directly, so every route opens with the same two lines the product's routes
 * open with:
 *
 *   const auth = await requireAuth(req);
 *   if (auth instanceof NextResponse) return auth;
 *
 * Keeping the signature identical is the point — it is what makes swapping in
 * the product's real middleware a file replacement rather than a rewrite.
 *
 * ── Two things must agree, not one ──────────────────────────────────────────
 * A bearer token alone is not enough: it must arrive with the FabOrchestrator
 * cookie whose fingerprint it carries. The check itself lives in
 * `lib/auth/verify-session.ts`, shared with the gateway so the two cannot
 * drift (plan RP2).
 *
 * Every refusal is the same coded 401 (`session_invalid`), whichever check
 * failed: saying which tells an attacker which half to work on, and the
 * client's answer to all of them is the same — sign in again (RP5 part 5b).
 */

import { NextResponse, type NextRequest } from "next/server";
import { SessionConfigError, type SessionPayload } from "./auth";
import { checkSession, SESSION_INVALID } from "./auth/verify-session";
import { foTokenFrom } from "./faborch/session";
import { reportError } from "./report-error";

export async function requireAuth(
  req: NextRequest,
): Promise<{ user: SessionPayload } | NextResponse> {
  let check: ReturnType<typeof checkSession>;
  try {
    check = checkSession(req.headers.get("authorization"), foTokenFrom(req));
  } catch (error) {
    // Unusable signing keys: no session can be checked, so none is honoured,
    // and the answer says the server is misconfigured rather than a bare 500.
    if (error instanceof SessionConfigError) {
      reportError("auth/session-config", error, { setting: error.setting });
      return NextResponse.json(
        { code: "not_configured", error: "Sign-in is not configured on this server." },
        { status: 503 },
      );
    }
    throw error;
  }
  if (!check.ok) return NextResponse.json(SESSION_INVALID, { status: 401 });
  return { user: check.session };
}
