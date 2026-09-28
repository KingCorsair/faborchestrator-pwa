/**
 * `POST /api/auth/keep-alive` — the operator pressed **Stay signed in**.
 *
 * FabOrchestrator ends a session after 30 minutes without an authenticated
 * call. The top bar warns when that is five minutes away (`app-shell.tsx`,
 * `lib/fo-activity.ts`), and this is its button: one call to FO's own
 * `/api/auth/me`, which FO counts as activity, so its idle clock starts again.
 *
 * ── Only ever the operator's press ──────────────────────────────────────────
 * Nothing calls this on a timer, and nothing may. `lib/auth.ts` records why an
 * automatic keep-alive was refused: FO's session audit measures idleness, and a
 * call nobody asked for would quietly defeat its 30-minute eviction and falsify
 * the figures. A person pressing a button is activity; a timer is not.
 *
 * ── If FO has already ended the session ─────────────────────────────────────
 * Then there is nothing to keep, and the answer says so the way every other
 * route does: `faborch_session_expired`, with the cookie dropped, so the screen
 * offers sign-in rather than a button that cannot work.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { FabOrchNotConfiguredError, FabOrchRequestError, foMe } from "@/lib/faborch/client";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";
import { reportError } from "@/lib/report-error";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // `requireAuth` has already refused a request without the matching cookie;
  // this is the same fact, narrowed for the compiler.
  const foToken = foTokenFrom(req);
  if (!foToken) {
    return NextResponse.json(
      { code: "no_faborch_session", error: "This session is not signed in to FabOrchestrator." },
      { status: 401 },
    );
  }

  try {
    const me = await foMe(foToken);
    if (!me) {
      const res = NextResponse.json(
        {
          code: "faborch_session_expired",
          error: "Your FabOrchestrator session has already ended. Sign in again to continue.",
        },
        { status: 401 },
      );
      clearFoTokenCookie(res);
      return res;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof FabOrchNotConfiguredError) {
      return NextResponse.json({ code: "not_configured", error: error.message }, { status: 503 });
    }
    if (error instanceof FabOrchRequestError) {
      return NextResponse.json(
        { code: "faborch_unavailable", error: error.message },
        { status: error.status === 503 ? 503 : 502 },
      );
    }
    reportError("auth/keep-alive", error);
    return NextResponse.json(
      { code: "faborch_unavailable", error: "FabOrchestrator could not be reached just now." },
      { status: 502 },
    );
  }
}
