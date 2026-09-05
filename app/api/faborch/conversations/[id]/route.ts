/**
 * `GET   /api/faborch/conversations/[id]` — one stored thread, reduced.
 * `PATCH /api/faborch/conversations/[id]` — pin or unpin it.
 *
 * ── The GET is where a 1.3 MB thread becomes a few kilobytes ────────────────
 * Measured against production on 5 September: ten sampled conversations carried
 * `text x274 · step-start x211 · tool-* x332 · file-download x8`, and the
 * largest single thread was **1,306 KB of JSON for 18 messages** — almost all of
 * it generated SQL and returned rows. This app renders none of that and has no
 * way to.
 *
 * `toTurns` runs **here**, on the server, so the phone is sent what it will
 * actually display. Doing it in the browser would mean shipping a megabyte over
 * a fab-floor connection to throw 99% of it away, and would put unrenderable
 * part types inside the app's own bundle boundary. See `lib/faborch/history.ts`.
 *
 * ── Ownership is FO's to enforce here, and it does ──────────────────────────
 * Unlike `/api/chat`, FO's `GET /api/conversations/{id}` compares
 * `conversation.userId` against the caller and refuses. So this route does not
 * re-check: it forwards the caller's own token and treats 403 and 404 alike as
 * "not yours", which `foConversation` already collapses to null.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import {
  FabOrchNotConfiguredError,
  FabOrchRequestError,
  foConversation,
  foSetPinned,
} from "@/lib/faborch/client";
import { MAX_TEXT } from "@/lib/faborch/conversation";
import { isContinuable, toTurns } from "@/lib/faborch/history";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";
import { UpdateConversationSchema } from "@/lib/validation";

export const runtime = "nodejs";

const noFoSession = () =>
  NextResponse.json(
    {
      code: "no_faborch_session",
      error: "This session is not signed in to FabOrchestrator.",
    },
    { status: 401 },
  );

const notFound = () =>
  NextResponse.json(
    {
      code: "not_found",
      error: "That conversation is no longer available in FabOrchestrator.",
    },
    { status: 404 },
  );

function failed(error: unknown, what: string): NextResponse {
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
  console.error("[faborch/conversations/[id]] unexpected failure:", error);
  return NextResponse.json({ code: "faborch_unavailable", error: what }, { status: 502 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const foToken = foTokenFrom(req);
  if (!foToken) return noFoSession();

  const { id } = await params;

  try {
    const raw = (await foConversation(foToken, id)) as {
      id?: unknown;
      title?: unknown;
      isPinned?: unknown;
      updatedAt?: unknown;
      messages?: unknown;
    } | null;
    if (!raw) return notFound();

    const turns = toTurns(raw.messages);

    return NextResponse.json({
      id,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled",
      isPinned: raw.isPinned === true,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      turns,
      /**
       * Whether this thread can be added to.
       *
       * `FabInsightRequestSchema` caps one message at 20,000 characters, so a
       * stored FabOrchestrator answer longer than that can be read here but
       * cannot be posted back as context. Reported as a fact rather than fixed
       * by truncation: shortening what FO said, silently, to make a request fit
       * would make the product look like it answered something it did not.
       */
      continuable: isContinuable(turns, MAX_TEXT),
    });
  } catch (error) {
    return failed(error, "That conversation is unavailable right now.");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const foToken = foTokenFrom(req);
  if (!foToken) return noFoSession();

  const { id } = await params;
  const parsed = UpdateConversationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: "invalid_request", error: "Only pinning can be changed from here." },
      { status: 400 },
    );
  }

  try {
    // FO's PATCH checks ownership itself and answers 403 for somebody else's
    // thread, which arrives here as `false` — reported as "not found" for the
    // same reason `foConversation` collapses the two: whether another user's
    // conversation exists is not this response's to confirm.
    const ok = await foSetPinned(foToken, id, parsed.data.isPinned);
    if (!ok) return notFound();
    return NextResponse.json({ id, isPinned: parsed.data.isPinned });
  } catch (error) {
    return failed(error, "Could not update that conversation.");
  }
}
