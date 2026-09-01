import { NextResponse } from "next/server";
import { clearFoTokenCookie } from "@/lib/faborch/session";

/**
 * Logout cannot revoke this app's own token: Tier 0 tokens are stateless HMACs
 * with no server-side session record (see `lib/auth.ts`). The client clearing
 * its storage is the whole of that effect. A real session table makes that half
 * of this endpoint meaningful.
 *
 * **The FabOrchestrator half is real.** The FO token is an httpOnly cookie the
 * client cannot clear, so if this route did not drop it, signing out would
 * leave a live FO session attached to the browser — and the next person to open
 * the demo on that device would be able to ask FabInsight questions as the
 * operator who signed out. It is dropped here.
 *
 * FO's own `/api/auth/logout` is deliberately not called: FO sessions are
 * server-side records, and ending one would sign the operator out of the
 * FabOrchestrator tab they may still have open. Dropping the cookie ends this
 * app's use of it, which is all this app is entitled to do.
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  clearFoTokenCookie(res);
  return res;
}
