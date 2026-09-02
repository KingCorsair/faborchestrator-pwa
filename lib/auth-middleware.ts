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
 * cookie whose fingerprint it carries. See `lib/auth.ts` for why that replaces
 * the server-side session store this app was otherwise going to need.
 */

import { NextResponse, type NextRequest } from "next/server";
import { foFingerprint, verifyToken, type SessionPayload } from "./auth";
import { foTokenFrom } from "./faborch/session";

export async function requireAuth(
  req: NextRequest,
): Promise<{ user: SessionPayload } | NextResponse> {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return unauthorized("Missing bearer token");
  }

  const user = verifyToken(header.slice(7));
  if (!user) {
    // One message for malformed, mis-signed and expired alike: telling a caller
    // which of the three it was tells an attacker which to work on.
    return unauthorized("Invalid or expired session");
  }

  // ── The session is only valid beside the FabOrchestrator token it was minted
  // with ────────────────────────────────────────────────────────────────────
  // This is what makes sign-out a revocation without a session store. Signing
  // out deletes the httpOnly FO cookie; the bearer token left in `localStorage`
  // then matches nothing and authenticates nothing. It also means a token
  // copied off a device is inert on its own.
  //
  // Same message as above, for the same reason.
  const foToken = foTokenFrom(req);
  if (!foToken || !user.fp || user.fp !== foFingerprint(foToken)) {
    return unauthorized("Invalid or expired session");
  }

  return { user };
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}
