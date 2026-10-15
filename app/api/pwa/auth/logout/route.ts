import { NextResponse, type NextRequest } from "next/server";
import { foFingerprint } from "@/lib/auth";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { CLIENT_END_REASONS, endServerSession, forgetServerSession, type SessionEndReason } from "@/lib/faborch/end-session";
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
 *
 * ── The device-check page, and a session that is not the caller's to end ────
 * `/device-blocked` calls this on arrival (`device_blocked`), for a session
 * whose device was revoked or that never proved a device. A third case reaches
 * that page (9 October 2026): a newly installed iPhone Home Screen app, which
 * holds a **copy** of its browser's session cookie and no device key. That
 * session is healthy and belongs to the browser's credential; revoking it
 * would sign the browser out because its owner opened the app. So for this
 * reason the server decides, from what it knows and not from anything the
 * page says: a session bound to an ACTIVE credential on an APPROVED device is
 * only **forgotten** here (the cookie is cleared, the session lives); any
 * other is revoked as before.
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
  const foToken = foTokenFrom(req);
  if (reason === "device_blocked" && foToken && (await belongsToAHealthyCredential(foToken))) {
    forgetServerSession(res, foToken, "device_blocked");
  } else {
    endServerSession(res, foToken, reason);
  }
  return res;
}

/**
 * Whether this session signed in with a credential that may still be used. If
 * the store cannot say, the answer is no and the session is revoked: the rule
 * this route had before credentials existed.
 */
async function belongsToAHealthyCredential(foToken: string): Promise<boolean> {
  try {
    const binding = await deviceStore().sessionBinding(foFingerprint(foToken));
    return binding !== null && binding.device.status === "APPROVED" && binding.credential.status === "ACTIVE";
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    return false;
  }
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
