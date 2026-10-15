import { NextResponse, type NextRequest } from "next/server";
import { CLIENT_FORGET_REASONS, forgetServerSession, type SessionForgetReason } from "@/lib/faborch/end-session";
import { foTokenFrom } from "@/lib/faborch/session";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Forget a session cookie this browser context cannot use, **without ending
 * the session** (9 October 2026; `lib/faborch/end-session.ts`, "Forgetting is
 * not ending").
 *
 * ── Why this is not sign-out ────────────────────────────────────────────────
 * On an iPhone, "Add to Home Screen" copies the browser's cookies into the new
 * app. The app then opens holding the browser's FabOrchestrator cookie, with
 * no bearer in its storage and no device key: a session it never signed in
 * with and cannot use. The pages that find a cookie without a bearer used to
 * call sign-out, which revokes the session at FabOrchestrator, and so opening
 * the installed app signed the browser out. They call this instead when the
 * page **loaded** that way: the cookie leaves this context, the session stays
 * alive for the browser that owns it, and the app goes on to sign in for
 * itself.
 *
 * A session that was this context's own and then lost its bearer (sign-out in
 * another tab, FabOrchestrator's idle timer) still goes to sign-out and is
 * revoked: the pages tell the two apart by whether a bearer was ever there.
 *
 * ── What it can and cannot do ───────────────────────────────────────────────
 * It clears one cookie on the caller's own browser. It returns no data,
 * revokes nothing and needs no session, so the worst a caller can do with it
 * is make themselves sign in again. Same-origin only, like sign-out: another
 * site must not be able to do even that.
 */
export async function POST(req: NextRequest) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json(
      { code: "cross_site_request", error: "This has to come from this app." },
      { status: 403, headers: NO_STORE },
    );
  }
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  forgetServerSession(res, foTokenFrom(req), await forgetReason(req));
  return res;
}

/** Why, for the log line only. Anything unrecognised is the ordinary case. */
async function forgetReason(req: NextRequest): Promise<SessionForgetReason> {
  const body = await readJsonBody(req, 1024).catch(() => null);
  const value = body && !body.tooLarge ? (body.value as { reason?: unknown } | null) : null;
  const reason = typeof value?.reason === "string" ? (value.reason as SessionForgetReason) : "token_missing";
  return CLIENT_FORGET_REASONS.has(reason) ? reason : "token_missing";
}
