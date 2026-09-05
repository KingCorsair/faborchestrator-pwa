/**
 * `POST /api/faborch/[agent]/chat` — **the whole integration, for all three
 * agents.**
 *
 * ```
 * agent screen → this route → FabOrchestrator /api/chat → FO's agent
 *              ←            ←     (streamed back, untouched)
 * ```
 *
 * It does four things and nothing else: check this app's session, read the FO
 * token off the cookie, ask FO which tools this operator has (FabInsight only),
 * and forward the conversation. **No prompt, no model call, no manufacturing
 * logic.** The answer is FabOrchestrator's, computed by FabOrchestrator,
 * streamed through.
 *
 * ── One route for every agent ───────────────────────────────────────────────
 * Every FO chat endpoint takes `{ messages }` and answers with
 * `createUIMessageStreamResponse`, so the only thing that varies is the path
 * and whether `activeMcpIds` is read — both of which come from `FO_AGENTS`.
 * See `lib/faborch/agents.ts` for why this is a registry rather than a copy of
 * the token, expiry and no-buffering handling per agent, and for why the
 * Master Data Load Agent is not among them.
 *
 * The `[agent]` segment **selects** from that registry and never becomes a URL:
 * an unknown value is a 404 here, before any request is made to FO. Same rule
 * as `lib/return-path.ts`.
 *
 * ── Why the PWA cannot skip this hop ────────────────────────────────────────
 * `claudeai_athena/app/api/chat/route.ts` sets no CORS headers, so the browser
 * refuses a cross-origin call from :3002 to :3000 before it is sent. Proxying
 * is not an architectural preference here; it is the only way in. It buys two
 * things anyway: the FO token stays out of client JavaScript
 * (`lib/faborch/session.ts`), and `activeMcpIds` is decided server-side rather
 * than by whatever the page posts.
 *
 * ── The body is piped, never buffered ───────────────────────────────────────
 * FO streams (`createUIMessageStreamResponse`), a turn with tool calls can run
 * for minutes, and `maxDuration` matches FO's own 300s. Reading the whole
 * response before returning it would turn a live answer into a long spinner and
 * would break the 15s keep-alive frames that exist to hold the connection open.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { foAgent } from "@/lib/faborch/agents";
import {
  FabOrchNotConfiguredError,
  FabOrchRequestError,
  foChat,
  foConnectedMcpIds,
  foErrorTextOf,
} from "@/lib/faborch/client";
import { codeForStatus, splitErrorId, statusForCode, type PwaErrorCode } from "@/lib/faborch/errors";
import { ownsConversation } from "@/lib/faborch/owns";
import { clearFoTokenCookie, foTokenFrom } from "@/lib/faborch/session";
import { FabInsightRequestSchema } from "@/lib/validation";

/** FO's own budget for one turn (`app/api/chat/route.ts:27`). */
export const maxDuration = 300;

/**
 * Machine-readable reasons the screen renders differently.
 *
 * A screen that can only show "something went wrong" sends the operator to find
 * whoever set the demo up. These each have a different next step, and the UI
 * says which — see `components/fab/screens/agent-chat.tsx`.
 */
/**
 * The codes this route can answer with.
 *
 * Defined in `lib/faborch/errors.ts` rather than here, because the screen has to
 * render every one of them and a union declared in a route handler is not
 * somewhere a component should be importing from. That module is also where the
 * next step for each code lives — see its header for why they are separate.
 */
export type FabInsightErrorCode = PwaErrorCode;

export async function POST(req: NextRequest, { params }: { params: Promise<{ agent: string }> }) {
  const agent = foAgent((await params).agent);
  if (!agent) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });

  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const foToken = foTokenFrom(req);
  if (!foToken) {
    return fail(
      "no_faborch_session",
      `This session is not signed in to FabOrchestrator. ${agent.name} runs inside ` +
        "FabOrchestrator, so it needs your FabOrchestrator credentials.",
      401,
    );
  }

  const parsed = FabInsightRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    // Which tools this operator may use is FO's answer, asked fresh each turn.
    // The product's chat asks once on mount and keeps the list for the session;
    // here there is no mount to hang it on, and one round trip is cheaper than a
    // conversation that silently loses its tools when an admin connects one
    // mid-demo. The other two agents build their tools from the authenticated
    // user server-side, so there is nothing to ask.
    const activeMcpIds = agent.sendMcpIds ? await foConnectedMcpIds(foToken) : null;

    /**
     * The conversation this turn is written into — **proved, not accepted.**
     *
     * `claudeai_athena/app/api/chat/route.ts` takes a `conversationId` and never
     * checks whose it is: no `getConversation`, no `userId` comparison, straight
     * to `addMessage` (`:338`, `:947`) and to the S3-reference lookup (`:571`).
     * Every other conversation route there checks ownership; that one does not.
     * Forwarding a browser's id unchecked would make this app a convenient way
     * to write into somebody else's thread.
     *
     * So the id is matched against this caller's own list first. One that fails
     * becomes `null` rather than a 403: the question is still answered, it
     * simply is not written down. Refusing to answer would punish an operator
     * for a stale tab.
     *
     * Only the agents that keep history are eligible. The Back-end Agent is
     * historyless here because it is historyless in the product —
     * `backend-agent-app.tsx:25` omits the section and says why.
     */
    const requested = parsed.data.conversationId ?? null;
    const conversationId =
      requested && agent.keepsHistory && (await ownsConversation(foToken, requested))
        ? requested
        : null;

    const upstream = await foChat({
      token: foToken,
      messages: parsed.data.messages,
      conversationId,
      activeMcpIds,
      path: agent.foPath,
      // Client disconnects propagate, so FO is not left streaming into nothing
      // when the operator navigates away.
      signal: req.signal,
    });

    if (upstream.status === 401) {
      // FO evicted the session — 30-day expiry, or the idle eviction its
      // auth middleware applies. Drop the cookie so the screen can offer
      // sign-in rather than failing the same way on every retry.
      const res = fail(
        "faborch_session_expired",
        "Your FabOrchestrator session has expired. Sign in again to continue.",
        401,
      );
      clearFoTokenCookie(res);
      return res;
    }

    if (!upstream.ok || !upstream.body) {
      // FO's own message, verbatim where there is one: a role model restriction
      // and a daily quota both arrive here, and both are things the operator can
      // act on. Replacing them with a generic failure would throw away the only
      // useful part.
      //
      // The code is now FO's status mapped through one table rather than
      // everything collapsing into `faborch_unavailable`. That distinction is
      // the point of WP10: "wait, the limit resets" and "your role cannot do
      // this" and "the platform is down" need three different next steps, and a
      // single code cannot carry three.
      //
      // No agent this app exposes is permission-gated any more —
      // `modeling_agent` was the only gate and `/api/chat` does not answer 403
      // itself. `agent_forbidden` stays mapped because it is FO's message that
      // matters, not this app's inventory of which ones FO currently sends.
      const code = codeForStatus(upstream.status);
      const raw = await foErrorTextOf(upstream, `${agent.name} could not answer that.`);
      const { message, errorId } = splitErrorId(raw);
      return fail(code, message, statusForCode(code), errorId);
    }

    const headers: Record<string, string> = {
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
      // Both copied from FO's own response headers. Without them a proxy in
      // front of this app buffers the stream and the answer arrives at once
      // at the end, which is the failure `X-Accel-Buffering` exists for.
      "X-Accel-Buffering": "no",
      "Cache-Control": "no-cache, no-transform",
    };

    // Which of FabOrchestrator's three paths served the turn — a deterministic
    // metric brief, a curated dashboard, or the ordinary tool-using chat. The
    // answer's prose does not say whether it was grounded in real data; this
    // does, and it is the only way to tell after the fact. Forwarded rather
    // than interpreted: the platform owns the meaning of the value.
    const foRoute = upstream.headers.get("X-FabOrch-Route");
    if (foRoute) headers["X-FabOrch-Route"] = foRoute;

    // How many data connections this operator's role actually carries. The
    // screen uses it to say so when there are none — see the note in
    // `agent-chat.tsx`. Reported rather than acted on: the plan's line was
    // "refuse to send a turn with an empty tool list", and that is measurably
    // wrong. Asked "give me the yield by product" with an empty list,
    // FabOrchestrator still answers from real plant data, because its metric
    // path reads the warehouse directly and never touches MCP. Refusing would
    // have withheld a real answer.
    if (activeMcpIds !== null) {
      headers["X-FabOrch-Data-Connections"] = String(activeMcpIds.length);
    }

    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof FabOrchNotConfiguredError) {
      return fail("not_configured", error.message, 503);
    }
    if (error instanceof FabOrchRequestError) {
      return fail("faborch_unavailable", error.message, error.status === 503 ? 503 : 502);
    }
    console.error(`[faborch/${agent.id}/chat] unexpected failure:`, error);
    return fail("faborch_unavailable", `${agent.name} is unavailable right now.`, 502);
  }
}

/**
 * The one shape that crosses the boundary: `{ code, error, errorId? }`.
 *
 * `error` is always a string. FabOrchestrator has two error envelopes and one
 * nests an object under `error`; rendering that as a React child produced
 * `[object Object]` on screen, which is the defect `foErrorMessage` exists to
 * prevent and the proxy tests assert against.
 *
 * `errorId` is separate rather than left inside the sentence, because it is the
 * only handle support has into `error_audit_logs` and a supervisor will not
 * transcribe a UUID out of prose correctly.
 */
function fail(
  code: FabInsightErrorCode,
  error: string,
  status: number,
  errorId?: string,
): NextResponse {
  return NextResponse.json(errorId ? { code, error, errorId } : { code, error }, { status });
}

