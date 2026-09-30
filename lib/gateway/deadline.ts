/**
 * Deadlines for everything the gateway forwards to FabOrchestrator (plan RP4,
 * finding G1: "the gateway has no deadline").
 *
 * Until now the gateway's `fetch` carried only `req.signal`: a FabOrchestrator
 * that accepted a request and then went quiet held the phone's request, and
 * this server's socket, for as long as nobody hung up. The chetan branch had a
 * 60-second limit on an answer beginning, but on the PWA's own chat route; in
 * the embedded architecture every chat turn comes through here instead.
 *
 * ── Four call classes, three limits each (RP4 part 2) ───────────────────────
 *   bounded   ordinary API rows (JSON in, JSON out)
 *   stream    the two chat endpoints, whose answer streams for minutes
 *   upload    a multipart body going up; the response then pipes like any other
 *   document  FabOrchestrator's pages and static assets
 *
 * For each: **headers** (from `fetch` until the response headers arrive),
 * **idle** (after headers, how long FabOrchestrator may go without sending a
 * chunk) and **lifetime** (after headers, the most the body may take).
 *
 * ── Idle measures FabOrchestrator, never the phone (RP4-R2, R3) ─────────────
 * The idle timer runs only while this gateway is *waiting on FabOrchestrator*
 * for the next chunk. A phone that reads slowly applies backpressure, no read
 * is pending, and no idle timer runs, so a slow download on a weak signal is
 * never mistaken for a silent FabOrchestrator. FO's chat sends a keep-alive
 * comment every 20 seconds, which resets it like any other chunk.
 *
 * ── A limit that fires after the answer has started errors the stream ───────
 * It never closes it cleanly (RP4-R4). A cleanly closed stream is what a
 * finished answer looks like, and FabOrchestrator's chat would show half an
 * answer as though it were whole. Erroring it makes Next destroy the
 * connection, which the client reads as a failure.
 *
 * ── The values are provisional ──────────────────────────────────────────────
 * RP4 leaves every budget to checkpoint CP3, bounded above by the edge's own
 * origin timeout (§9 question 48). These defaults are reasonable for the
 * current single-machine deployment, and each can be set from the environment
 * (`GATEWAY_TIMEOUT_<CLASS>_<HEADERS|IDLE|LIFE>_MS`) without a code change.
 *
 * Not here yet, and still RP4's own work: the per-task stream-slot cap
 * (`N_streams`), the shutdown registry that errors open streams on `SIGTERM`,
 * and an explicit connect timeout on the fetch dispatcher.
 */

import { maskPath } from "@/lib/report-error";

export type CallClass = "bounded" | "stream" | "upload" | "document";
export type Budget = { headersMs: number; idleMs: number; lifeMs: number };
export type TimeoutReason = "headers" | "idle" | "lifetime";

const DEFAULTS: Record<CallClass, Budget> = {
  bounded: { headersMs: 15_000, idleMs: 15_000, lifeMs: 120_000 },
  // FO's first byte can take tens of seconds on a hard question, and its
  // CloudFront gives up on a silent origin at 60 s (FO `app/api/chat/route.ts`).
  // Idle sits well above FO's 20-second keep-alive; lifetime above FO's own
  // 300-second turn budget (`maxDuration`).
  stream: { headersMs: 60_000, idleMs: 45_000, lifeMs: 360_000 },
  // The headers deadline covers the upload itself, so it is generous: a 20 MB
  // workbook on a weak phone signal is slow, not dead.
  upload: { headersMs: 180_000, idleMs: 30_000, lifeMs: 300_000 },
  document: { headersMs: 20_000, idleMs: 20_000, lifeMs: 120_000 },
};

/** FabOrchestrator's keep-alive gap on a chat stream (`withKeepAlive`, 20 s). */
export const FO_KEEPALIVE_GAP_MS = 20_000;

function envMs(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The budgets in force, defaults overridden from the environment. */
export function gatewayBudgets(env: Record<string, string | undefined> = process.env): Record<CallClass, Budget> {
  const out = {} as Record<CallClass, Budget>;
  for (const cls of Object.keys(DEFAULTS) as CallClass[]) {
    const d = DEFAULTS[cls];
    const key = `GATEWAY_TIMEOUT_${cls.toUpperCase()}`;
    out[cls] = {
      headersMs: envMs(env, `${key}_HEADERS_MS`, d.headersMs),
      idleMs: envMs(env, `${key}_IDLE_MS`, d.idleMs),
      lifeMs: envMs(env, `${key}_LIFE_MS`, d.lifeMs),
    };
  }
  return out;
}

/**
 * RP4 part 5's ordering rules, as a list of problems (empty when sound). A
 * stream idle limit at or below FO's keep-alive gap would cut every healthy
 * answer that pauses to think; an idle limit above the lifetime is meaningless.
 */
export function budgetProblems(budgets: Record<CallClass, Budget>): string[] {
  const problems: string[] = [];
  if (budgets.stream.idleMs <= FO_KEEPALIVE_GAP_MS) {
    problems.push(`stream idle ${budgets.stream.idleMs} ms must exceed FO's ${FO_KEEPALIVE_GAP_MS} ms keep-alive gap`);
  }
  for (const [cls, b] of Object.entries(budgets)) {
    if (b.idleMs > b.lifeMs) problems.push(`${cls}: idle ${b.idleMs} ms exceeds lifetime ${b.lifeMs} ms`);
  }
  return problems;
}

const STREAM_PATHS = new Set(["/api/chat", "/api/modeling-agent/chat"]);

/** Which class a forwarded request belongs to. */
export function callClassFor(
  owner: string,
  pathname: string,
  method: string,
  contentType: string | null,
): CallClass {
  if (owner !== "fo-api") return "document";
  if (method === "POST" && STREAM_PATHS.has(pathname)) return "stream";
  if ((contentType ?? "").toLowerCase().startsWith("multipart/")) return "upload";
  return "bounded";
}

export class UpstreamTimeout extends Error {
  constructor(readonly reason: TimeoutReason) {
    super(`FabOrchestrator ${reason === "headers" ? "did not answer" : reason === "idle" ? "went silent" : "took too long"}`);
    this.name = "UpstreamTimeout";
  }
}

export type Lifecycle = {
  /** Pass to `fetch`: the caller's signal and this lifecycle's, combined. */
  signal: AbortSignal;
  /** Why the lifecycle ended early, or null. */
  reason(): TimeoutReason | "cancelled" | null;
  /** The response headers arrived: stop the headers timer, start the lifetime. */
  onHeaders(): void;
  /** Wrap the upstream body so idle and lifetime are enforced on it. */
  watch(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Clear every timer (the request is over, one way or another). */
  done(): void;
};

/**
 * One upstream call's timers (RP4 `startLifecycle`). Every timer is cleared on
 * every exit: completion, timeout, the phone leaving, or an upstream error.
 */
export function startLifecycle(
  cls: CallClass,
  budget: Budget,
  callerSignal: AbortSignal,
  context: { pathname: string },
): Lifecycle {
  const controller = new AbortController();
  const signal = AbortSignal.any([callerSignal, controller.signal]);
  let ended: TimeoutReason | "cancelled" | null = null;
  let headersTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lifeTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  let onTimeout: ((reason: TimeoutReason) => void) | null = null;

  const clearAll = () => {
    clearTimeout(headersTimer);
    clearTimeout(idleTimer);
    clearTimeout(lifeTimer);
  };

  const fire = (reason: TimeoutReason) => {
    if (ended) return;
    ended = reason;
    clearAll();
    const error = new UpstreamTimeout(reason);
    controller.abort(error);
    onTimeout?.(reason);
    logStreamEnd(cls, reason, context.pathname, startedAt);
  };

  callerSignal.addEventListener("abort", () => {
    if (ended) return;
    ended = "cancelled";
    clearAll();
  });

  headersTimer = setTimeout(() => fire("headers"), budget.headersMs);

  return {
    signal,
    reason: () => ended,
    onHeaders() {
      clearTimeout(headersTimer);
      if (!ended) lifeTimer = setTimeout(() => fire("lifetime"), budget.lifeMs);
    },
    watch(body) {
      const reader = body.getReader();
      let downstream: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | null = null;
      onTimeout = (reason) => {
        reader.cancel(new UpstreamTimeout(reason)).catch(() => {});
        try {
          downstream?.error(new UpstreamTimeout(reason));
        } catch {
          /* already closed */
        }
      };
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(c) {
          downstream = c;
        },
        async pull(c) {
          if (ended && ended !== "cancelled") return;
          // The idle timer runs only while waiting on FabOrchestrator.
          idleTimer = setTimeout(() => fire("idle"), budget.idleMs);
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (error) {
            clearTimeout(idleTimer);
            if (!ended) {
              clearAll();
              c.error(error);
            }
            return;
          } finally {
            clearTimeout(idleTimer);
          }
          if (ended && ended !== "cancelled") return;
          if (result.done) {
            clearAll();
            c.close();
            return;
          }
          c.enqueue(result.value as Uint8Array<ArrayBuffer>);
        },
        cancel(reason) {
          // The phone went away (Next's pipe controller cancels the body).
          if (!ended) ended = "cancelled";
          clearAll();
          controller.abort(reason);
          reader.cancel(reason).catch(() => {});
        },
      });
    },
    done: clearAll,
  };
}

function logStreamEnd(cls: CallClass, reason: TimeoutReason, pathname: string, startedAt: number): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      at: new Date().toISOString(),
      event: "upstream_timeout",
      class: cls,
      reason,
      path: maskPath(pathname),
      elapsedMs: Date.now() - startedAt,
    }),
  );
}
