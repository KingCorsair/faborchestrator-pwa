import { after, NextResponse, type NextRequest } from "next/server";
import { foFingerprint } from "@/lib/auth";
import { foLogout } from "@/lib/faborch/client";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";

/**
 * Sign out — **ends the FabOrchestrator session, not just this app's copy**,
 * and never waits on FabOrchestrator to do it.
 *
 * ── The order is the rule (plan RP2, `endServerSession`) ────────────────────
 *  1. **Clear local state first.** The cleared cookie is written onto the
 *     response and the response goes back at once. This is what protects the
 *     handset in the room: without the cookie the browser holds nothing, and
 *     this app's bearer is inert too, because it is only accepted beside the
 *     matching FO cookie (`lib/auth.ts`). This half cannot fail and cannot be
 *     slowed down by FabOrchestrator.
 *  2. **Then tell FabOrchestrator**, after the response (Next's `after()`),
 *     under the `revoke` time limit (`FO_CALL_TIMEOUTS.revoke`). Its
 *     `/api/auth/logout` deletes the session row, so the token stops working
 *     everywhere and FO's audit records a sign-out.
 *  3. **Record the outcome** as a `session_end` line with the token's
 *     fingerprint, never the token. The response no longer reports whether
 *     FO was told; the log does. A failed revoke is not retried: FO's own
 *     idle rule refuses the token on any later use.
 *
 * Until 2026-09-29 this route awaited FabOrchestrator first, so a slow or
 * unreachable FO held the sign-out for as long as the call hung. The chetan
 * branch (`e843b9c`) bounded that wait at five seconds; the plan's order
 * removes it from the response altogether.
 *
 * ── Why revoking is the correct scope ──────────────────────────────────────
 * FO's logout is **per token** (`deleteSession(token)`, one row), and every
 * login mints a new token, so a FabOrchestrator tab on a desktop holds a
 * different token and this call cannot reach it (verified against upstream
 * `e5a5abd`).
 */
export async function POST(req: NextRequest) {
  const foToken = foTokenFrom(req);
  const res = NextResponse.json({ ok: true });
  clearFoTokenCookie(res);
  if (foToken) afterResponse(() => revokeFoSession(foToken, "user"));
  return res;
}

async function revokeFoSession(foToken: string, reason: string): Promise<void> {
  const revoked = await foLogout(foToken);
  console.info(
    JSON.stringify({
      level: "info",
      at: new Date().toISOString(),
      event: "session_end",
      reason,
      revoked,
      // RP10-A: the first 8 characters of the fingerprint, for correlation only.
      sessionFp: foFingerprint(foToken).slice(0, 8),
    }),
  );
}

/**
 * `after()` exists only inside a Next request. A route called directly (the
 * unit tests do) has no request scope and `after` throws, so the task runs
 * detached instead: still after the response is built, still never awaited.
 */
function afterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task().catch(() => {});
  }
}
