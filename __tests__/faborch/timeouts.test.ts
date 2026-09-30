/**
 * How long FabOrchestrator is given, and what happens when it takes longer.
 *
 * Ported from the `chetan` branch (`e843b9c`). These run the real client
 * against a stubbed FabOrchestrator on a mocked clock and pin:
 *
 *   a bounded call is abandoned at FO_CALL_TIMEOUTS.bounded, as a 504
 *   the limit covers the body too, so a response that starts and stalls is caught
 *   an answer gets FO_CALL_TIMEOUTS.streamStart to begin, and no limit once it has
 *   a revoke gives up at FO_CALL_TIMEOUTS.revoke
 *   the operator's own cancel is not mistaken for FabOrchestrator failing
 *
 * Left behind: the end-to-end native chat case (it depends on the native
 * screens' tool and ownership caches, which were not ported). The sign-out
 * route's own behaviour is pinned in `logout.test.ts`.
 *
 * The stub behaves as a real `fetch` does with a signal: it rejects when the
 * signal aborts, and errors a body it is still sending.
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL = "https://fo.test";

import { FO_CALL_TIMEOUTS, FabOrchRequestError, foChat, foLogout, foPinnedReports } from "@/lib/faborch/client";

const TOKEN = "fo-token-not-real";
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

let logged: string[] = [];

/** Lets promise reactions run. `setImmediate` is not mocked, so it still advances. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Move the mocked clock forward a second at a time, letting work run in between. */
async function advance(ms: number) {
  for (let done = 0; done < ms; done += 1000) {
    mock.timers.tick(Math.min(1000, ms - done));
    await flush();
  }
  await flush();
}

/** A FabOrchestrator that accepts the request and never answers. */
function neverAnswers() {
  globalThis.fetch = ((_input: RequestInfo | URL, init: RequestInit = {}) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
      );
    })) as typeof fetch;
}

/** Headers at once, then a body that sends a little and stops. */
function answersThenStalls() {
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"dashboards": ['));
        init.signal?.addEventListener("abort", () =>
          controller.error(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
        );
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

/** Whether the promise has settled yet; attaching handlers at once also avoids an unhandled rejection. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

const failureOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

describe("a bounded call FabOrchestrator never answers", () => {
  test("is abandoned at the limit, not a moment before", async () => {
    neverAnswers();
    const pending = foPinnedReports(TOKEN);
    const state = track(pending);

    await advance(FO_CALL_TIMEOUTS.bounded - 1000);
    assert.equal(state.settled, false, "gave up early");

    await advance(1000);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof FabOrchRequestError);
      assert.equal(error.status, 504);
      assert.match(error.message, /did not answer within 15 seconds/);
      return true;
    });
  });

  test("is reported, once, as a timeout, with the path as a pattern", async () => {
    neverAnswers();
    const failure = failureOf(foPinnedReports(TOKEN));
    await advance(FO_CALL_TIMEOUTS.bounded);
    assert.ok((await failure) instanceof FabOrchRequestError);
    const lines = logged.filter((line) => line.includes('"where":"faborch/timeout"'));
    assert.equal(lines.length, 1, logged.join("\n"));
    assert.ok(!lines[0]!.includes("fo.test"), "the FO address is never logged");
  });

  test("a response that starts and then stalls is caught by the same limit", async () => {
    answersThenStalls();
    const failure = failureOf(foPinnedReports(TOKEN));
    await advance(FO_CALL_TIMEOUTS.bounded);
    const error = await failure;
    assert.ok(error instanceof FabOrchRequestError);
    assert.equal(error.status, 504);
  });

  test("FabOrchestrator unreachable is a 503, reported as unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }) as typeof fetch;
    const error = await failureOf(foPinnedReports(TOKEN));
    assert.ok(error instanceof FabOrchRequestError);
    assert.equal(error.status, 503);
    const line = logged.find((l) => l.includes('"where":"faborch/unreachable"'));
    assert.ok(line, logged.join("\n"));
    assert.match(line!, /"errorCode":"ECONNREFUSED"/);
  });
});

describe("an answer", () => {
  const ask = (signal?: AbortSignal) =>
    foChat({
      token: TOKEN,
      messages: [{ role: "user", parts: [{ type: "text", text: "Yield?" }] }],
      activeMcpIds: [],
      signal,
    });

  test("gets FO_CALL_TIMEOUTS.streamStart to begin", async () => {
    neverAnswers();
    const pending = ask();
    const state = track(pending);

    await advance(FO_CALL_TIMEOUTS.streamStart - 1000);
    assert.equal(state.settled, false, "a slow start is not a failed one");

    await advance(1000);
    await assert.rejects(pending, /did not answer within 60 seconds/);
  });

  test("once begun, streams for as long as it takes", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      signal = init.signal;
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const res = await ask();
    assert.equal(res.status, 200);
    await advance(FO_CALL_TIMEOUTS.streamStart * 3);
    assert.equal(signal?.aborted, false, "the limit must end when the answer begins");
  });

  test("the operator's own cancel is not reported as FabOrchestrator failing", async () => {
    neverAnswers();
    const controller = new AbortController();
    const pending = ask(controller.signal);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof FabOrchRequestError);
      assert.equal(error.status, 499);
      return true;
    });
    assert.ok(
      !logged.some((line) => /faborch\/(timeout|unreachable)/.test(line)),
      "pressing Stop is not an incident",
    );
  });
});

describe("revoking an FO session", () => {
  test("gives up at the revoke limit and reports false", async () => {
    neverAnswers();
    const pending = foLogout(TOKEN);
    const state = track(pending);

    await advance(FO_CALL_TIMEOUTS.revoke - 1000);
    assert.equal(state.settled, false);

    await advance(1000);
    assert.equal(await pending, false);
  });

  test("a 204 from FabOrchestrator is a sign-out, not a crash", async () => {
    // A status that may carry no body. Buffering the reply must not choke on it.
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    assert.equal(await foLogout(TOKEN), true);
  });
});
