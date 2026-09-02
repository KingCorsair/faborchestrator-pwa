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
 * ── The earlier decision, and why it was wrong ─────────────────────────────
 * This route used to skip step 2 deliberately, so as not to sign the operator
 * out of a FabOrchestrator tab they might have open. **That objection does not
 * hold, and the mechanics say so** (verified against upstream `e5a5abd`):
 *
 *  - FO's logout is **per token**: `deleteSession(token)` is
 *    `prisma.session.delete({ where: { token } })`, one row. The `deleteMany`
 *    variants exist but only the admin force-logout path calls them.
 *  - Every login **mints a new token**: `generateToken()` then a plain
 *    `session.create`, with no delete-first and no reuse. One person can hold
 *    many concurrent sessions.
 *
 * So a desktop tab holds a *different* token from a *different* login, and this
 * call cannot reach it. Ending the session the PWA was given is not a
 * trade-off against anything — it is simply the correct scope.
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
