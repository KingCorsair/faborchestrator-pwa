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
 */

import { NextResponse, type NextRequest } from "next/server";
import { verifyToken, type SessionPayload } from "./auth";

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

  return { user };
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}
