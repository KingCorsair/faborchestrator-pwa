/**
 * `GET /api/faborch/conversations` — this operator's FabOrchestrator threads.
 * `POST /api/faborch/conversations` — start one.
 *
 * ```
 * agent drawer → this route → FabOrchestrator /api/conversations
 * ```
 *
 * Same shape and the same reasons as the reports proxy: FO sets no CORS
 * headers, so a browser cannot call it, and the FO token lives in an httpOnly
 * cookie only the server reads. The screen never holds a credential.
 *
 * ── This app stores nothing ─────────────────────────────────────────────────
 * There is no PWA database here and there must never be one. FabOrchestrator
 * already owns conversation history — two tables, an ownership check on every
 * route, soft deletes, pinning — and the whole value of this feature is that it
 * is the **same** history the FabOrchestrator website shows. A local copy would
 * be a second source of truth that silently disagrees with the product.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * No DELETE. FO supports it (a soft delete), and it is not offered here: this
 * is a read-and-continue interface, and a destructive control on a phone, one
 * tap from a thread list, is not something to add without being asked. Nor
 * rename, share, search or projects. The route exposes list and create; the
 * `[id]` route exposes load and pin.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import {
  FabOrchNotConfiguredError,
  FabOrchRequestError,
  foConversations,
  foCreateConversation,
} from "@/lib/faborch/client";
import { toSummaries } from "@/lib/faborch/history";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";
import { CreateConversationSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * The FO history bucket this app reads and writes.
 *
 * A constant, never a request parameter. `agent` partitions FO's conversation
 * store (`prisma/schema.prisma:109`), and `"chat"` is both FabInsight's bucket
 * and the one the FabOrchestrator website reads — which is the point of the
 * whole feature. A client able to name it could write rows into the Modeling
 * Agent's history, which this app does not open.
 */
const AGENT = "chat";

const noFoSession = () =>
  NextResponse.json(
    {
      code: "no_faborch_session",
      error:
        "This session is not signed in to FabOrchestrator. Your conversations " +
        "are stored in FabOrchestrator, so it needs your FabOrchestrator credentials.",
    },
    { status: 401 },
  );

/** The shared failure shape, so both handlers answer identically. */
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
  console.error("[faborch/conversations] unexpected failure:", error);
  return NextResponse.json({ code: "faborch_unavailable", error: what }, { status: 502 });
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const foToken = foTokenFrom(req);
  if (!foToken) return noFoSession();

  try {
    // `toSummaries` is what keeps this honest: FO's rows carry `isShared`,
    // `model` and `agent`, none of which a drawer should see. Four fields go
    // out — id, title, isPinned, updatedAt.
    const conversations = toSummaries(await foConversations(foToken, AGENT));
    return NextResponse.json({ conversations });
  } catch (error) {
    return failed(error, "Your conversations are unavailable right now.");
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const foToken = foTokenFrom(req);
  if (!foToken) return noFoSession();

  const parsed = CreateConversationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: "invalid_request", error: "A conversation needs the question it starts with." },
      { status: 400 },
    );
  }

  try {
    const id = await foCreateConversation(foToken, parsed.data.title, AGENT);
    // Null means FO declined to create one. Answered as 200 with a null id
    // rather than as an error, because the caller's next move is the same
    // either way: send the turn unpersisted, so the operator still gets their
    // answer. History is an enhancement; answering is the product.
    return NextResponse.json({ id });
  } catch (error) {
    return failed(error, "Could not start a conversation in FabOrchestrator.");
  }
}
