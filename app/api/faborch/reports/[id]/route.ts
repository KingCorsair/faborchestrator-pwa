/**
 * `GET /api/faborch/reports/[id]` — one pinned report's stored snapshot.
 *
 * The sibling of `../route.ts`, and read-only for the same reason. FO's
 * `GET /api/fabinsight/pinned/[id]` returns the HTML an administrator's pin
 * last cached; every authenticated role may read it.
 *
 * ── Why the snapshot and not a live render ──────────────────────────────────
 * FO also has `POST /api/fabinsight/pinned/[id]/refresh`, which re-queries the
 * MES and writes the result back. It is **not** admin-gated — and that is the
 * reason this app does not call it. Refreshing overwrites the shared snapshot
 * that every other reader sees, so on a read-only screen it is a control that
 * changes other people's data. A supervisor reading a report on a phone wants
 * to see what the administrator published, and the screen says when it was
 * taken so nobody mistakes it for live.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import {
  FabOrchNotConfiguredError,
  FabOrchRequestError,
  foPinnedReport,
} from "@/lib/faborch/client";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const foToken = foTokenFrom(req);
  if (!foToken) {
    return NextResponse.json(
      {
        code: "no_faborch_session",
        error: "This session is not signed in to FabOrchestrator.",
      },
      { status: 401 },
    );
  }

  const { id } = await params;

  try {
    const report = await foPinnedReport(foToken, id);
    if (!report) {
      return NextResponse.json(
        {
          code: "not_found",
          error: "That report is no longer pinned in FabOrchestrator.",
        },
        { status: 404 },
      );
    }
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof FabOrchNotConfiguredError) {
      return NextResponse.json({ code: "not_configured", error: error.message }, { status: 503 });
    }
    if (error instanceof FabOrchRequestError) {
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
    console.error("[faborch/reports/[id]] unexpected failure:", error);
    return NextResponse.json(
      { code: "faborch_unavailable", error: "That report is unavailable right now." },
      { status: 502 },
    );
  }
}
