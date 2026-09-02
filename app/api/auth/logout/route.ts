import { NextResponse, type NextRequest } from "next/server";
import { foLogout } from "@/lib/faborch/client";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";

/**
 * Sign out — **ends the FabOrchestrator session, not just this app's copy.**
 *
 * Two things happen, in this order of importance:
 *
 *  1. **The cookie is dropped.** This is what protects the handset in the room:
 *     without it the browser holds nothing, and this app's own bearer token is
 *     inert too, because it is only accepted beside the matching FO cookie
 *     (`lib/auth.ts`). This half cannot fail.
 *  2. **FabOrchestrator is told.** Its `/api/auth/logout` closes the audit row
 *     and deletes the session record, so the token stops working everywhere —
 *     and FO's own logs record a sign-out rather than a session that went quiet.
 *
 * ── The earlier decision, and why it changed ────────────────────────────────
 * This route used to skip step 2 deliberately, so as not to sign the operator
 * out of a FabOrchestrator tab they might have open. That case has stopped being
 * the likely one: this app is a mobile front door used on a fab floor, not a
 * second window beside the desktop product. Truthful audit logs are worth more
 * than protecting a tab that probably is not there.
 *
 * ── Order matters ──────────────────────────────────────────────────────────
 * FO is told first, because that call needs the token; the cookie is dropped on
 * the response regardless of what FO answered. If FO is unreachable the user is
 * still signed out here, and FO's own expiry closes the session later.
 */
export async function POST(req: NextRequest) {
  const foToken = foTokenFrom(req);

  const revoked = foToken ? await foLogout(foToken) : null;

  const res = NextResponse.json({ ok: true, faborchRevoked: revoked });
  clearFoTokenCookie(res);
  return res;
}
