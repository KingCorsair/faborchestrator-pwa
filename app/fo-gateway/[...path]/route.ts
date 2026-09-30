/**
 * The FabOrchestrator gateway — **the one place FO traffic crosses this app.**
 *
 * ```
 * browser ─► proxy.ts (ownership) ─► /fo-gateway/<path> ─► this handler ─► FabOrchestrator
 *         ◄──────────────────────── piped, never buffered ◄─────────
 * ```
 *
 * `proxy.ts` decides *whether* a path belongs to FabOrchestrator and rewrites
 * it here; this file decides *how* the request is forwarded. It is reachable
 * only through that rewrite: the middleware answers 404 to any request whose
 * own path starts with `/fo-gateway`, and this handler additionally refuses any
 * request that does not carry the marker header the middleware stamps.
 *
 * ── What it does, in order ──────────────────────────────────────────────────
 *  1. Re-checks the path against the same hygiene and registry rules the
 *     middleware applied. Defence in depth: a route that trusts its caller to
 *     have checked is a route that is one refactor away from not checking.
 *  2. Builds the upstream URL from `upstreamOrigin()` — `foBaseUrl()`, the
 *     HTTPS-enforced FabOrchestrator origin, or, for pages and assets only,
 *     the UI build named by `FO_UI_BASE_URL` when one is set — plus the path
 *     and query. No part of the origin ever comes from the request.
 *  3. Forwards the method, the allow-listed headers and, for methods that have
 *     one, the body as a stream (`duplex: "half"`), so an upload is not held
 *     in memory here.
 *  4. Never follows redirects (`redirect: "manual"`): a `Location` is passed
 *     back, rewritten onto this origin if it pointed at FO's.
 *  5. Returns the upstream status and the allow-listed headers, and pipes the
 *     body. `content-encoding` and `content-length` are dropped because fetch
 *     decompressed the body already; the server compresses again for the
 *     phone. Streams keep the two headers that stop intermediaries buffering.
 *
 * ── What it deliberately does not do in WP1 ─────────────────────────────────
 * It does not authenticate. `authorization` is dropped on the way in, so FO
 * answers every protected API call with its own 401. Injecting the FO token
 * from this app's httpOnly cookie, after verifying this app's session, is WP2.
 * The consequence is stated in `docs/STATUS.md`: with the flag on, FO's chat
 * *document* loads from this origin, and FO's *page script* then finds its
 * data calls refused and shows its own signed-out state. That is the WP1
 * proof — the document and every asset arrive — and nothing more.
 *
 * ── Why a route handler rather than a middleware rewrite to FO ──────────────
 * A middleware can rewrite to an external URL, but it cannot see the upstream
 * response: it could not override FO's year-long HTML cache header, drop the
 * ALB cookies, rewrite a `Location`, or (in WP2) clear this app's cookie when
 * FO says the session is dead. This handler can, and it is the same
 * pipe-the-body pattern `app/api/faborch/[agent]/chat/route.ts` has proven
 * against the deployment since WP1 of the demo.
 */

import { NextResponse, type NextRequest } from "next/server";
import { FabOrchNotConfiguredError } from "@/lib/faborch/client";
import { clearFoTokenCookie } from "@/lib/faborch/session";
import { bridgeAuthorization, endsTheSession, expiredUpstream } from "@/lib/gateway/auth-bridge";
import { declaredTooLarge, limitBody, MAX_UPSTREAM_BODY_BYTES } from "@/lib/gateway/body-limit";
import { budgetProblems, callClassFor, gatewayBudgets, startLifecycle } from "@/lib/gateway/deadline";
import { downstreamResponseHeaders, upstreamRequestHeaders } from "@/lib/gateway/headers";
import { injectShellScript, shouldInjectShell } from "@/lib/gateway/html-inject";
import {
  checkChatBody,
  deletedConversationId,
  forgetConversation,
  isConversationCreate,
  isConversationList,
  needsOwnershipCheck,
  warmFromCreateStream,
  warmFromListStream,
} from "@/lib/gateway/ownership";
import { safeGatewayPath } from "@/lib/gateway/path";
import { classify, GATEWAY_MARKER_HEADER, isForwardable, readRegistry } from "@/lib/gateway/registry";
import { upstreamOrigin } from "@/lib/gateway/upstream";
import { reportError } from "@/lib/report-error";

// RP4 part 5: the budgets must be sound. There is no startup hook to refuse
// to start from yet (that is RP10-B's server entry), so an unsound
// configuration is reported once, when this route is first loaded.
for (const problem of budgetProblems(gatewayBudgets())) {
  reportError("gateway/budget", new Error(problem));
}

/** FabOrchestrator's own budget for one turn (`app/api/chat/route.ts:38`). */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  // Only the middleware's rewrite carries the marker. A request that reached
  // this path any other way is answered as if the path did not exist.
  if (req.headers.get(GATEWAY_MARKER_HEADER) !== "1") return notFound();

  const segments = (await ctx.params).path ?? [];
  const pathname = safeGatewayPath(`/${segments.join("/")}`);
  if (!pathname) return notFound();
  const owner = classify(pathname, readRegistry());
  if (!isForwardable(owner)) return notFound();

  // ── The single-login bridge (WP2) ────────────────────────────────────────
  //
  // Only for FabOrchestrator's API. A document or a static asset is public on
  // FabOrchestrator and is fetched with no credential at all, which is also
  // what stops this app attaching an operator's token to a font.
  const verdict = owner === "fo-api" ? bridgeAuthorization(req) : ({ action: "forward-anonymous" } as const);
  if (verdict.action === "refuse") {
    // Refused here rather than forwarded: a bearer this app can see is not
    // real is a claim about a session, and FabOrchestrator should never be
    // asked to adjudicate it.
    return NextResponse.json({ error: verdict.reason }, { status: 401 });
  }

  let origin: string;
  try {
    origin = upstreamOrigin(owner);
  } catch (error) {
    if (error instanceof FabOrchNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }

  const upstreamUrl = `${origin}${pathname}${req.nextUrl.search}`;
  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const headersOut = upstreamRequestHeaders(req.headers, {
    ip: clientIp(req),
    proto: req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.nextUrl.protocol.replace(":", ""),
  });
  // The one header this app sets rather than forwards. `upstreamRequestHeaders`
  // drops the incoming `authorization` — this app's session means nothing to
  // FabOrchestrator — and this replaces it with the real token, read from the
  // httpOnly cookie on the server and never sent downstream.
  if (verdict.action === "inject") {
    headersOut.set("authorization", `Bearer ${verdict.foToken}`);
  }

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: headersOut,
    redirect: "manual",
    cache: "no-store",
  };

  // ── Conversation ownership on chat turns (WP4) ───────────────────────────
  //
  // FabOrchestrator's `/api/chat` accepts a `conversationId` and never checks
  // whose it is, so an id from a browser must be proved before it reaches
  // FabOrchestrator — the rule this app's own proxy route has followed since
  // the demo, applied here because embedding would otherwise reopen the hole.
  //
  // Only these two paths are buffered. Everything else — uploads above all —
  // keeps streaming, which is why the check is a narrow special case rather
  // than something every request pays for.
  if (hasBody && needsOwnershipCheck(pathname, method) && verdict.action === "inject") {
    const raw = await req.text();
    const outcome = await checkChatBody(pathname, raw, verdict.foToken);
    if (outcome.action === "refuse") {
      return NextResponse.json({ error: outcome.reason }, { status: 413 });
    }
    if (outcome.action === "forward-stripped") {
      console.warn(`[gateway] conversationId ${outcome.conversationId} is not this caller's; forwarding the turn unpersisted`);
      init.body = outcome.body;
      headersOut.set("content-length", String(Buffer.byteLength(outcome.body)));
    } else {
      init.body = raw;
      headersOut.set("content-length", String(Buffer.byteLength(raw)));
    }
  } else if (hasBody && req.body) {
    // Everything that is not a chat turn — uploads above all — streams
    // through rather than being buffered, under a ceiling matching
    // FabOrchestrator's own nginx limit (WP5). Declared too large is refused
    // before a byte leaves; a chunked body that grows past the ceiling errors
    // the stream mid-flight.
    if (declaredTooLarge(req.headers)) {
      return NextResponse.json(
        { error: `Request body exceeds the ${MAX_UPSTREAM_BODY_BYTES} byte limit.` },
        { status: 413 },
      );
    }
    init.body = limitBody(req.body);
    init.duplex = "half";
  }

  // ── Deadlines (RP4, finding G1) ───────────────────────────────────────────
  //
  // Started here, after any ownership lookup, so only FabOrchestrator's own
  // time is counted. The phone leaving (`req.signal`) cancels the upstream
  // call; a deadline aborts it. See `lib/gateway/deadline.ts`.
  const cls = callClassFor(owner, pathname, method, req.headers.get("content-type"));
  const lifecycle = startLifecycle(cls, gatewayBudgets()[cls], req.signal, { pathname });
  init.signal = lifecycle.signal;

  let upstream: Response;
  // When this request's evidence was asked for: a list read that began before
  // a delete the gateway saw cannot re-warm the deleted id (RP6 tombstone).
  const requestedAt = Date.now();
  try {
    upstream = await fetch(upstreamUrl, init);
  } catch (cause) {
    lifecycle.done();
    const reason = lifecycle.reason();
    // Three different things, told apart (RP4 part 4, RP5's codes). The FO
    // address is never logged or returned: `upstreamUrl` stays in this scope.
    if (reason === "headers") {
      return NextResponse.json(
        { code: "upstream_timeout", error: "FabOrchestrator did not answer in time." },
        { status: 504 },
      );
    }
    if (reason === "cancelled" || req.signal.aborted) {
      // The phone went away. Nobody is waiting for this answer.
      return new NextResponse(null, { status: 499 });
    }
    reportError("gateway/unreachable", cause, { path: pathname, class: cls });
    return NextResponse.json(
      { code: "faborch_unavailable", error: "FabOrchestrator could not be reached just now." },
      { status: 503 },
    );
  }
  lifecycle.onHeaders();

  const headers = downstreamResponseHeaders(upstream.headers, origin);
  let body = method === "HEAD" || BODYLESS_STATUSES.has(upstream.status) ? null : upstream.body;
  // Idle and lifetime are enforced on FabOrchestrator's body itself, before
  // any transform below, so they measure FabOrchestrator and nothing else.
  if (body) body = lifecycle.watch(body);
  else lifecycle.done();

  // ── The shell (WP6, WP10) ────────────────────────────────────────────────
  //
  // The manifest and Apple tags that make FabOrchestrator's documents
  // installable, and one script tag carrying the single-sign-out watcher and
  // the service-worker registration. No navigation: since 11 September
  // FabOrchestrator provides its own on a phone (`public/fo-shell.js`).
  // Inserted as the document streams; `content-length` is already dropped by
  // the header policy, so a body that grows by a few tags needs no adjustment.
  if (body && shouldInjectShell(headers.get("content-type"))) {
    body = injectShellScript(body);
  }

  // ── Warming the ownership cache from a list already on its way (WP8) ─────
  //
  // The ownership check above is the only thing here that costs an upstream
  // round trip, and WP8 measured it: 1,276 ms to first byte for a turn
  // carrying a conversation id against 708 ms for one without. What it fetches
  // is this account's conversation list — which FabOrchestrator's own sidebar
  // has *already* requested through this gateway before anybody could pick a
  // thread to type into. So the ids are read out of that answer as it streams
  // past, and the turn that follows finds them waiting. The response is
  // forwarded chunk by chunk exactly as it would have been; only a copy is
  // kept, and only until the stream ends.
  if (body && verdict.action === "inject" && upstream.ok && isConversationList(pathname, method)) {
    body = warmFromListStream(body, verdict.foToken, requestedAt);
  }

  // ── The same cache, from a create and a delete (RP6) ─────────────────────
  //
  // A 201 from `POST /api/conversations` names a conversation FabOrchestrator
  // just made for this token, so its first turn needs no lookup. A successful
  // `DELETE /api/conversations/{id}` forgets that id for every token and
  // leaves a tombstone, so a proof already in flight cannot re-warm it.
  if (body && verdict.action === "inject" && upstream.status === 201 && isConversationCreate(pathname, method)) {
    body = warmFromCreateStream(body, verdict.foToken);
  }
  const deletedId = upstream.ok ? deletedConversationId(pathname, method) : null;
  if (deletedId) forgetConversation(deletedId);

  // A `NextResponse` rather than a bare `Response`, only so that
  // `clearFoTokenCookie` below is the app's single definition of how that
  // cookie is dropped. It streams the body exactly the same way.
  const res = new NextResponse(body, { status: upstream.status, headers });

  // ── When FabOrchestrator's answer ends this app's session too (WP2) ──────
  //
  // Signing out from FabOrchestrator's own sidebar, and FabOrchestrator
  // evicting an idle session, both leave this app holding a cookie that
  // authenticates nothing. Dropping it here is what makes the next navigation
  // meet the sign-in gate instead of a cockpit the operator can no longer use
  // — and it is the same thing `app/api/faborch/[agent]/chat/route.ts` already
  // does for the screens this app draws itself.
  if (
    endsTheSession(pathname, upstream.status) ||
    expiredUpstream(verdict.action === "inject", upstream.status)
  ) {
    clearFoTokenCookie(res);
  }

  return res;
}

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || null;
  return req.headers.get("x-real-ip");
}

function notFound(): Response {
  return new NextResponse(null, { status: 404 });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
