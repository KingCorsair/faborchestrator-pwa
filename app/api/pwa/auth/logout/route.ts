import { NextResponse, type NextRequest } from "next/server";
import { CLIENT_END_REASONS, endServerSession, type SessionEndReason } from "@/lib/faborch/end-session";
import { foTokenFrom } from "@/lib/faborch/session";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";

/**
 * Sign out — **ends the FabOrchestrator session, not just this app's copy**,
 * and never waits on FabOrchestrator to do it.
 *
 * The order is `endServerSession`'s (`lib/faborch/end-session.ts`, plan RP2):
 * the cleared cookie goes back at once, FabOrchestrator is told after the
 * response under the `revoke` limit, and the outcome is a `session_end` log
 * line. Until 2026-09-29 this route awaited FabOrchestrator first, so a slow FO
 * held the sign-out; the chetan branch bounded that wait at five seconds, and
 * the plan's order removes it from the response altogether.
 *
 * ── Only this app's own pages may sign an operator out (plan RP2, G26) ──────
 * Another site could otherwise post here and sign somebody out: a nuisance
 * rather than access, since reading FabOrchestrator data needs the bearer as
 * well as the cookie, but a nuisance this route need not allow. A request whose
 * headers say it is cross-site is refused and the cookie kept; one with no
 * such header is allowed (`lib/same-origin.ts` says why).
 *
 * Bearer-less on purpose: `fo-shell.js` calls this after FabOrchestrator has
 * already deleted the bearer. Idempotent: with no cookie it clears nothing and
 * calls nobody.
 *
 * ── Why revoking is the correct scope ──────────────────────────────────────
 * FO's logout is **per token** (`deleteSession(token)`, one row), and every
 * login mints a new token, so a FabOrchestrator tab on a desktop holds a
 * different token and this call cannot reach it (verified against upstream
 * `e5a5abd`).
 */
export async function POST(req: NextRequest) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json(
      { code: "cross_site_request", error: "Sign-out has to come from this app." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const reason = await endReason(req);
  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  endServerSession(res, foTokenFrom(req), reason);
  return res;
}

/**
 * Why the client is ending the session, for the log line only. An optional
 * `{reason}` body naming one of the client-side reasons; anything else,
 * including no body at all, is an ordinary sign-out. Never a reason to refuse.
 */
async function endReason(req: NextRequest): Promise<SessionEndReason> {
  const body = await readJsonBody(req, 1024).catch(() => null);
  const value = body && !body.tooLarge ? (body.value as { reason?: unknown } | null) : null;
  const reason = typeof value?.reason === "string" ? (value.reason as SessionEndReason) : "user";
  return CLIENT_END_REASONS.has(reason) ? reason : "user";
}
