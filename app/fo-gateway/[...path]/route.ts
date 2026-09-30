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
 *     HTTPS-enforced FabOrchestrator origin, for pages, assets and API alike
 *     (a preview's separate UI build only with `FO_UI_SPLIT_ALLOWED=1`) — plus
 *     the path and query. No part of the origin ever comes from the request.
 *  3. Forwards the method, the allow-listed headers and, for methods that have
 *     one, the body — read whole, measured against the 20 MiB policy and
 *     forwarded with its real length, so no cut-off body ever reaches
 *     FabOrchestrator (plan RP1 part 3; `lib/gateway/body-limit.ts`).
 *  4. Never follows redirects (`redirect: "manual"`): a `Location` is passed
 *     back, rewritten onto this origin if it pointed at FO's.
 *  5. Returns the upstream status and the allow-listed headers, and pipes the
 *     body. `content-encoding` and `content-length` are dropped because fetch
 *     decompressed the body already; the server compresses again for the
 *     phone. Streams keep the two headers that stop intermediaries buffering.
 *
 * ── Its own refusals are coded (plan RP5) ───────────────────────────────────
 * Every answer the gateway makes itself carries `{code, error}`: 401
 * `session_invalid`, 400 `invalid_request`, 403 `conversation_forbidden`, 404
 * `not_found`, 413 `body_too_large`, 503 `faborch_unavailable`,
 * `ownership_unavailable` or `not_configured`, 504 `upstream_timeout`. None
 * carries FabOrchestrator's address. FabOrchestrator's own answers pass through
 * untouched. (FabOrchestrator's chat shows a refused turn's body as text: the
 * plan's interim rule, §9 question 57, until FO renders the `error` field.)
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
import { SessionConfigError } from "@/lib/auth";
import { SESSION_INVALID } from "@/lib/auth/verify-session";
import { FabOrchNotConfiguredError } from "@/lib/faborch/client";
import { endServerSession, sessionConfigProblems } from "@/lib/faborch/end-session";
import { markPasswordChanged } from "@/lib/faborch/password-mark";
import { clearFoTokenCookie, isHttps } from "@/lib/faborch/session";
import { bridgeAuthorization, endsTheSession, expiredUpstream, type BridgeVerdict } from "@/lib/gateway/auth-bridge";
import { bodyTooLargeBody, MAX_REQUEST_BODY_BYTES, readBodyWithinLimit } from "@/lib/gateway/body-limit";
import { budgetProblems, callClassFor, gatewayBudgets, startLifecycle } from "@/lib/gateway/deadline";
import { documentErrorResponse } from "@/lib/gateway/error-page";
import { downstreamResponseHeaders, hardenFoApiHeaders, upstreamRequestHeaders } from "@/lib/gateway/headers";
import { injectShellScript, shouldInjectShell } from "@/lib/gateway/html-inject";
import { keepReadingKey, reserveKeepReading, supersedeKeptReading } from "@/lib/gateway/keep-reading";
import {
  checkChatBody,
  deletedConversationId,
  forgetConversation,
  isConversationCreate,
  isConversationList,
  needsOwnershipCheck,
  refusedConversationId,
  warmFromCreateStream,
  warmFromListStream,
} from "@/lib/gateway/ownership";
import { safeGatewayPath } from "@/lib/gateway/path";
import { classify, GATEWAY_MARKER_HEADER, isForwardable, readRegistry } from "@/lib/gateway/registry";
import { foOrigins, upstreamOrigin } from "@/lib/gateway/upstream";
import { logEvent, reportError } from "@/lib/report-error";

// RP4 part 5: the budgets must be sound. There is no startup hook to refuse
// to start from yet (that is RP10-B's server entry), so an unsound
// configuration is reported once, when this route is first loaded.
for (const problem of budgetProblems(gatewayBudgets())) {
  reportError("gateway/budget", new Error(problem));
}
// The same for the session settings every FabOrchestrator API call depends on
// (plan RP2 part 5). Not during `next build`, which runs without the secrets.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  for (const setting of sessionConfigProblems()) {
    reportError("gateway/session-config", new Error("unusable session setting"), { setting });
  }
}

/** FabOrchestrator's own budget for one turn (`app/api/chat/route.ts:38`). */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  // Only the middleware's rewrite carries the marker. A request that reached
  // this path any other way is answered as if the path did not exist.
  if (req.headers.get(GATEWAY_MARKER_HEADER) !== "1") return notFound(null);

  const segments = (await ctx.params).path ?? [];
  const pathname = safeGatewayPath(`/${segments.join("/")}`);
  if (!pathname) return notFound(null);
  const owner = classify(pathname, readRegistry());
  if (!isForwardable(owner)) return notFound(pathname);

  // ── The single-login bridge (WP2) ────────────────────────────────────────
  //
  // Only for FabOrchestrator's API. A document or a static asset is public on
  // FabOrchestrator and is fetched with no credential at all, which is also
  // what stops this app attaching an operator's token to a font.
  let verdict: BridgeVerdict;
  try {
    verdict = owner === "fo-api" ? bridgeAuthorization(req) : { action: "forward-anonymous" };
  } catch (error) {
    // The signing keys are unusable (reported when this route loaded, too):
    // no session can be checked, so none is honoured, and the operator is
    // told the app is misconfigured rather than shown a bare 500.
    if (error instanceof SessionConfigError) {
      reportError("gateway/session-config", error, { setting: error.setting });
      return fail(owner, 503, "not_configured", "Sign-in is not configured on this server.");
    }
    throw error;
  }
  if (verdict.action === "refuse") {
    // Refused here rather than forwarded: a bearer this app can see is not
    // real is a claim about a session, and FabOrchestrator should never be
    // asked to adjudicate it.
    const res = coded(401, SESSION_INVALID.code, SESSION_INVALID.error);
    // A real session that has ended (expired, or a bearer paired with a cookie
    // that is not its own): clear the cookie now and revoke FabOrchestrator's
    // token after the response (plan RP2, G5). FabOrchestrator's own client
    // signs itself out on this 401 either way.
    if (verdict.endSession) endServerSession(res, verdict.endSession.foToken, "gateway_refusal");
    return res;
  }

  let origin: string;
  let origins: string[];
  try {
    origin = upstreamOrigin(owner);
    origins = foOrigins();
  } catch (error) {
    if (error instanceof FabOrchNotConfiguredError) {
      // The detail is configuration and goes to the log, never to the phone
      // (plan RP5, m4): it can name an internal host.
      reportError("gateway/not-configured", error, { path: pathname });
      return fail(owner, 503, "not_configured", "FabOrchestrator is not configured on this server.");
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

  // ── Request bodies: buffer, measure, then forward (plan RP1 part 3) ──────
  //
  // Next has already buffered the body (up to `proxyClientMaxBodySize`, set
  // above the policy in `next.config.ts`), so streaming it on would save no
  // memory and could let a cut-off body reach FabOrchestrator as if whole. The
  // body is read here, refused past the 20 MiB policy with a coded 413, and
  // otherwise forwarded exactly, with `content-length` set from the bytes.
  // The conversation a chat turn has proved it belongs to, if any.
  let provedConversationId: string | null = null;
  if (hasBody) {
    const read = await readBodyWithinLimit(req, MAX_REQUEST_BODY_BYTES);
    if (read.tooLarge) {
      logEvent("warn", "body_too_large", { path: pathname, limit: MAX_REQUEST_BODY_BYTES });
      const tooLarge = bodyTooLargeBody();
      if (owner === "fo-document") return documentErrorResponse(413, tooLarge.code, tooLarge.error);
      return NextResponse.json(tooLarge, { status: 413, headers: NO_STORE });
    }

    // ── Conversation ownership on chat turns (WP4, plan RP6) ────────────────
    //
    // FabOrchestrator's `/api/chat` accepts a `conversationId` and never checks
    // whose it is, so an id from a browser must be proved before it reaches
    // FabOrchestrator. An id that is not proved is refused with a code the
    // operator can act on — never stripped into a turn that is silently not
    // saved (`lib/gateway/ownership.ts`).
    if (needsOwnershipCheck(pathname, method) && verdict.action === "inject") {
      const outcome = await checkChatBody(pathname, new TextDecoder().decode(read.bytes), verdict.foToken);
      if (outcome.action === "refuse") {
        return coded(outcome.status, outcome.code, outcome.error, outcome.retryAfterSeconds);
      }
      if (outcome.action === "session-expired") {
        // FabOrchestrator no longer honours the token: the session is over,
        // and there is nothing left to revoke.
        const res = coded(401, "faborch_session_expired", "Your FabOrchestrator session has ended. Sign in again.");
        clearFoTokenCookie(res);
        return res;
      }
      if (outcome.action === "forward-owned") provedConversationId = outcome.conversationId;
    }

    init.body = read.bytes;
    headersOut.set("content-length", String(read.bytes.byteLength));
  }

  // ── Deadlines (RP4, finding G1) ───────────────────────────────────────────
  //
  // Started here, after any ownership lookup, so only FabOrchestrator's own
  // time is counted. The phone leaving (`req.signal`) cancels the upstream
  // call; a deadline aborts it. See `lib/gateway/deadline.ts`.
  //
  // **Except a chat answer** (a stopgap, 2026-09-30): FabOrchestrator saves an
  // answer only when its stream is read to the end, so a chat call is started
  // without the phone's signal and read to the end here if the phone goes
  // (`lib/gateway/keep-reading.ts`). The deadlines still apply to it.
  // The phone left while this request was being read or checked: nobody is
  // waiting for what FabOrchestrator would answer, so it is not asked.
  if (req.signal.aborted) return new NextResponse(null, { status: 499 });

  const cls = callClassFor(owner, pathname, method, req.headers.get("content-type"));
  // A new turn in a conversation stops the read of that conversation's
  // previous answer, so the previous answer can never be saved after the new
  // question (`lib/gateway/keep-reading.ts`).
  const keepKey =
    cls === "stream" && provedConversationId && verdict.action === "inject"
      ? keepReadingKey(verdict.foToken, provedConversationId)
      : null;
  if (keepKey) supersedeKeptReading(keepKey);
  const keepSlot = cls === "stream" ? reserveKeepReading() : null;
  const lifecycle = startLifecycle(cls, gatewayBudgets()[cls], keepSlot ? null : req.signal, { pathname });
  init.signal = lifecycle.signal;

  let upstream: Response;
  // When this request's evidence was asked for: a list read that began before
  // a delete the gateway saw cannot re-warm the deleted id (RP6 tombstone).
  const requestedAt = Date.now();
  try {
    upstream = await fetch(upstreamUrl, init);
  } catch (cause) {
    keepSlot?.release();
    lifecycle.done();
    const reason = lifecycle.reason();
    // Three different things, told apart (RP4 part 4, RP5's codes). The FO
    // address is never logged or returned: `upstreamUrl` stays in this scope.
    if (reason === "headers") return fail(owner, 504, "upstream_timeout", "FabOrchestrator did not answer in time.");
    if (reason === "cancelled" || req.signal.aborted) {
      // The phone went away. Nobody is waiting for this answer.
      return new NextResponse(null, { status: 499 });
    }
    reportError("gateway/unreachable", cause, { path: pathname, class: cls });
    return fail(owner, 503, "faborch_unavailable", "FabOrchestrator could not be reached just now.");
  }
  lifecycle.onHeaders();

  const headers = downstreamResponseHeaders(upstream.headers, origins);
  // `nosniff` on API answers; a generated file is always a download.
  if (owner === "fo-api") hardenFoApiHeaders(pathname, headers);
  let body = method === "HEAD" || BODYLESS_STATUSES.has(upstream.status) ? null : upstream.body;
  // Idle and lifetime are enforced on FabOrchestrator's body itself, before
  // any transform below, so they measure FabOrchestrator and nothing else.
  if (body) body = lifecycle.watch(body);
  else lifecycle.done();

  // The stopgap: a chat answer is read to the end here even if the phone goes.
  if (keepSlot) {
    if (body && upstream.ok) body = keepSlot.keepReading(body, { pathname, phone: req.signal, key: keepKey });
    else keepSlot.release();
  }

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
  // FabOrchestrator refusing a change to a conversation means it is not this
  // caller's, or no longer anyone's: forget it too (RP6 part 1).
  const refusedId = refusedConversationId(pathname, method, upstream.status);
  if (refusedId) forgetConversation(refusedId);

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

  // A password change FabOrchestrator accepted. If FabOrchestrator does not
  // clear its own "must change" flag (§9 question 44), the next sign-in says so
  // instead of sending the operator round the change page again (plan RP2, G20).
  if (verdict.action === "inject" && upstream.ok && method === "POST" && pathname === "/api/auth/change-password") {
    markPasswordChanged(res, verdict.userId, isHttps(req));
  }

  return res;
}

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || null;
  return req.headers.get("x-real-ip");
}

const NO_STORE = { "Cache-Control": "no-store" };

/** One of the gateway's own answers, coded (plan RP5). Never carries FabOrchestrator's address. */
function coded(status: number, code: string, error: string, retryAfterSeconds?: number): NextResponse {
  const headers: Record<string, string> = { ...NO_STORE };
  if (retryAfterSeconds) headers["Retry-After"] = String(retryAfterSeconds);
  return NextResponse.json({ code, error }, { status, headers });
}

/**
 * The gateway's own failure in the shape the request can use (plan RP5 part
 * 3b): a page for one of FabOrchestrator's documents, so a phone never shows
 * raw JSON in the installed app's window; the JSON envelope for anything else.
 */
function fail(owner: string, status: number, code: string, error: string, retryAfterSeconds?: number): Response {
  if (owner === "fo-document") return documentErrorResponse(status, code, error, retryAfterSeconds);
  return coded(status, code, error, retryAfterSeconds);
}

/** A coded JSON 404 for an API path (plan RP5, G8); an empty one for anything else. */
function notFound(pathname: string | null): Response {
  if (pathname && (pathname === "/api" || pathname.startsWith("/api/"))) return coded(404, "not_found", "Not found.");
  return new NextResponse(null, { status: 404 });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
