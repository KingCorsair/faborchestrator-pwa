/**
 * `GET /api/faborch/reports` — the pinned reports this operator may read.
 *
 * ```
 * /reports screen → this route → FabOrchestrator GET /api/fabinsight/pinned
 * ```
 *
 * Same shape as the chat proxy and for the same reason: FO sets no CORS
 * headers, so the browser cannot call it, and the FO token lives in an httpOnly
 * cookie this app reads server-side. The screen never holds a credential.
 *
 * ── Read-only, and that is a design constraint rather than a phase ──────────
 * FabOrchestrator's rule is that an administrator creates and pins a dashboard
 * and **every authenticated role may read one** (`lib/fabinsight/access.ts`).
 * This route exposes the read half only. There is no POST, no DELETE and no
 * refresh here — the client has no way to reach those through this app, so a
 * non-admin cannot invoke an admin action even by crafting a request.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import {
  FabOrchNotConfiguredError,
  FabOrchRequestError,
  foPinnedReports,
} from "@/lib/faborch/client";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const foToken = foTokenFrom(req);
  if (!foToken) {
    return NextResponse.json(
      {
        code: "no_faborch_session",
        error:
          "This session is not signed in to FabOrchestrator. Reports are pinned " +
          "inside FabOrchestrator, so it needs your FabOrchestrator credentials.",
      },
      { status: 401 },
    );
  }

  try {
    const { dashboards, canManage } = await foPinnedReports(foToken);
    return NextResponse.json({ reports: dashboards, canManage });
  } catch (error) {
    if (error instanceof FabOrchNotConfiguredError) {
      return NextResponse.json({ code: "not_configured", error: error.message }, { status: 503 });
    }
    if (error instanceof FabOrchRequestError) {
      // FO evicted the session — 30-day expiry or the 30-minute idle rule.
      // Drop the cookie so the screen offers sign-in rather than failing the
      // same way on every retry, exactly as the chat proxy does.
      if (error.status === 401) {
        const res = NextResponse.json(
          {
            code: "faborch_session_expired",
            error: "Your FabOrchestrator session has expired. Sign in again to continue.",
          },
          { status: 401 },
        );
        clearFoTokenCookie(res);
        return res;
      }
      return NextResponse.json(
        { code: "faborch_unavailable", error: error.message },
        { status: error.status === 503 ? 503 : 502 },
      );
    }
    console.error("[faborch/reports] unexpected failure:", error);
    return NextResponse.json(
      { code: "faborch_unavailable", error: "Reports are unavailable right now." },
      { status: 502 },
    );
  }
}
