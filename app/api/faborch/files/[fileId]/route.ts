/**
 * `GET /api/faborch/files/[fileId]?c=<conversation>` — a file FabOrchestrator's
 * model made, downloaded (2026-09-29).
 *
 * ── Proved, not trusted ──────────────────────────────────────────────────────
 * FO's own download route checks only that the caller is signed in: anybody
 * signed in who holds a file id gets the file. So before anything is fetched,
 * this reads the conversation the file is said to belong to — FO refuses one
 * that is not the caller's — and looks for the file in it. Same rule as the
 * chat route's `conversationId`: an id from a browser selects, it never proves.
 *
 * ── Served as a download, never as a page ────────────────────────────────────
 * The file is a model's output, and this is this app's origin: a document
 * rendered here could read the session the page keeps. So it goes out as an
 * attachment with `nosniff` and a sandboxing policy, and the screen fetches it
 * rather than navigating to it — which it has to anyway, since the request must
 * carry the session header.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import {
  FabOrchNotConfiguredError,
  FabOrchRequestError,
  foConversation,
  foFileDownload,
} from "@/lib/faborch/client";
import { conversationHasFile, isFileId } from "@/lib/faborch/files";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";
import { reportError } from "@/lib/report-error";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (code: string, error: string, status: number) =>
  NextResponse.json({ code, error }, { status });

function sessionExpired(): NextResponse {
  const res = refuse(
    "faborch_session_expired",
    "Your FabOrchestrator session has expired. Sign in again to continue.",
    401,
  );
  clearFoTokenCookie(res);
  return res;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const foToken = foTokenFrom(req);
  if (!foToken) {
    return refuse("no_faborch_session", "This session is not signed in to FabOrchestrator.", 401);
  }

  const { fileId } = await params;
  const conversationId = req.nextUrl.searchParams.get("c");
  if (!isFileId(fileId) || !conversationId || !UUID.test(conversationId)) {
    return refuse("bad_request", "That file link is not valid.", 400);
  }

  try {
    const conversation = (await foConversation(foToken, conversationId)) as { messages?: unknown } | null;
    // FO writes the file into the conversation a moment after announcing it,
    // so "not there yet" and "not yours" read the same from here. The screen
    // tries once more after a pause.
    if (!conversation || !conversationHasFile(conversation.messages, fileId)) {
      return refuse(
        "not_found",
        "That file is not in this conversation yet. Try again in a moment.",
        404,
      );
    }

    const upstream = await foFileDownload(foToken, fileId);
    if (upstream.status === 401) return sessionExpired();
    if (upstream.status === 404) {
      return refuse("not_found", "FabOrchestrator no longer has that file.", 404);
    }
    if (upstream.status === 410) {
      return refuse(
        "file_expired",
        "That file has expired: FabOrchestrator keeps the files it makes for 30 days. Ask again to make it anew.",
        410,
      );
    }
    if (!upstream.ok || !upstream.body) {
      return refuse("faborch_unavailable", "FabOrchestrator could not send that file right now.", 502);
    }

    const disposition = upstream.headers.get("Content-Disposition");
    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      // Always an attachment, whatever FO says — see the header.
      "Content-Disposition": disposition && /^attachment\b/i.test(disposition) ? disposition : "attachment",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
    });
    const length = upstream.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);

    // Piped, not buffered: a deck with pictures in it can be large.
    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof FabOrchNotConfiguredError) {
      return refuse("not_configured", error.message, 503);
    }
    if (error instanceof FabOrchRequestError) {
      if (error.status === 401) return sessionExpired();
      return refuse("faborch_unavailable", error.message, error.status === 503 ? 503 : 502);
    }
    reportError("faborch/files", error);
    return refuse("faborch_unavailable", "That file could not be downloaded right now.", 502);
  }
}
