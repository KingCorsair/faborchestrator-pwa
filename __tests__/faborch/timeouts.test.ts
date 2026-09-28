/**
 * How long FabOrchestrator is given, and what happens when it takes longer.
 *
 * Until 2026-09-28 no call to FabOrchestrator had a limit, so one that accepted
 * a request and went quiet held it for Node's default — five minutes. These run
 * the real client and routes against a stubbed FabOrchestrator that never
 * answers, on a mocked clock, and pin:
 *
 *   a lookup is abandoned at FO_TIMEOUT_MS, as a 504 that says so
 *   the limit covers the body too, so a response that starts and stalls is caught
 *   an answer gets FO_ANSWER_START_TIMEOUT_MS to begin, and no limit once it has
 *   sign-out gives up on FabOrchestrator at FO_SIGN_OUT_TIMEOUT_MS and still signs out
 *   the operator's own cancel is not mistaken for FabOrchestrator failing
 *
 * The stub behaves as a real `fetch` does with a signal: it rejects when the
 * signal aborts, and errors a body it is still sending.
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL = "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import {
  FO_ANSWER_START_TIMEOUT_MS,
  FO_SIGN_OUT_TIMEOUT_MS,
  FO_TIMEOUT_MS,
  FabOrchRequestError,
  foChat,
  foLogout,
  foPinnedReports,
} from "@/lib/faborch/client";
import { resetOwnershipCache } from "@/lib/faborch/owns";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { resetToolCache } from "@/lib/faborch/tools";
import { POST as CHAT } from "@/app/api/faborch/[agent]/chat/route";
import { POST as LOGOUT } from "@/app/api/auth/logout/route";

const TOKEN = "fo-token-not-real";
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

let calls: { url: string; signal?: AbortSignal | null }[] = [];
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
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), signal: init.signal });
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
      );
    });
  }) as typeof fetch;
}

/** Headers at once, then a body that sends a little and stops. */
function answersThenStalls() {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), signal: init.signal });
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

/**
 * Whether the promise has settled yet, without waiting for it to.
 *
 * Attaching handlers at once also matters on its own: a promise that rejects
 * while the mocked clock is being advanced, with nothing yet listening, is an
 * unhandled rejection by the time the test gets round to awaiting it.
 */
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

/**
 * Advance until the promise settles, a second at a time, up to `maxMs`.
 *
 * For a chain of limits — one call's timer only starts once the previous call
 * has given up, at whatever second the chain happened to reach — so a fixed
 * total would be one tick short as often as not.
 */
async function advanceUntilSettled<T>(promise: Promise<T>, maxMs: number) {
  const state = track(promise);
  for (let elapsed = 0; elapsed < maxMs && !state.settled; elapsed += 1000) {
    mock.timers.tick(1000);
    await flush();
  }
  await flush();
  return state;
}

/** The rejection, as a value — with a handler attached from the start. */
const failureOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

beforeEach(() => {
  calls = [];
  logged = [];
  resetToolCache();
  resetOwnershipCache();
  delete process.env.ERROR_ALERT_WEBHOOK_URL;
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

describe("a lookup FabOrchestrator never answers", () => {
  test("is abandoned at the limit, not a moment before", async () => {
    neverAnswers();
    const pending = foPinnedReports(TOKEN);
    const state = track(pending);

    await advance(FO_TIMEOUT_MS - 1000);
    assert.equal(state.settled, false, "gave up early");

    await advance(1000);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof FabOrchRequestError);
      assert.equal(error.status, 504);
      assert.match(error.message, /did not answer within 15 seconds/);
      return true;
    });
  });

  test("is reported, once, as a timeout", async () => {
    neverAnswers();
    const failure = failureOf(foPinnedReports(TOKEN));
    await advance(FO_TIMEOUT_MS);
    assert.ok((await failure) instanceof FabOrchRequestError);
    const lines = logged.filter((line) => line.includes('"where":"faborch/timeout"'));
    assert.equal(lines.length, 1, logged.join("\n"));
  });

  test("a response that starts and then stalls is caught by the same limit", async () => {
    // `fetch` resolves at the headers. A limit that stopped there would let this
    // hang whoever reads the body — which is why the body is read inside it.
    answersThenStalls();
    const failure = failureOf(foPinnedReports(TOKEN));
    await advance(FO_TIMEOUT_MS);
    const error = await failure;
    assert.ok(error instanceof FabOrchRequestError);
    assert.equal(error.status, 504);
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

  test("gets FO_ANSWER_START_TIMEOUT_MS to begin", async () => {
    neverAnswers();
    const pending = ask();
    const state = track(pending);

    await advance(FO_ANSWER_START_TIMEOUT_MS - 1000);
    assert.equal(state.settled, false, "a slow start is not a failed one");

    await advance(1000);
    await assert.rejects(pending, /did not answer within 60 seconds/);
  });

  test("once begun, streams for as long as it takes", async () => {
    // Headers at once; the body then goes quiet far past every limit. Nothing
    // may cut it — the stall watchdog in the browser is what watches this part.
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      signal = init.signal;
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const res = await ask();
    assert.equal(res.status, 200);
    await advance(FO_ANSWER_START_TIMEOUT_MS * 3);
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

describe("a question, end to end", () => {
  test("FabOrchestrator never beginning ends in a 502 that says why", async () => {
    // The tool lookup waits its 15 seconds and is dropped (the question goes on
    // without tools, as it always has); the question itself waits its sixty.
    neverAnswers();
    const pwaToken = sessionFor(
      { id: "u1", email: "s@plant.example", name: "S", roleName: "Supervisor" },
      new Date(Date.now() + 864e5).toISOString(),
      TOKEN,
    ).token;
    const pending = CHAT(
      new NextRequest("https://pwa.test/api/faborch/insight/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pwaToken}`,
          cookie: `${FO_TOKEN_COOKIE}=${TOKEN}`,
        },
        body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }),
      }),
      { params: Promise.resolve({ agent: "insight" }) },
    );

    const state = await advanceUntilSettled(pending, FO_TIMEOUT_MS + FO_ANSWER_START_TIMEOUT_MS + 10_000);
    assert.equal(state.settled, true, "both limits together must end the wait");
    const res = await pending;
    assert.equal(res.status, 502);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "faborch_unavailable", "a retryable code: it may well answer next time");
    assert.match(body.error, /did not answer within 60 seconds/);
  });
});

describe("sign-out", () => {
  const signOut = () =>
    LOGOUT(
      new NextRequest("https://pwa.test/api/auth/logout", {
        method: "POST",
        headers: { cookie: `${FO_TOKEN_COOKIE}=${TOKEN}` },
      }),
    );

  test("gives up on FabOrchestrator after five seconds, and signs out anyway", async () => {
    neverAnswers();
    const pending = signOut();
    const state = track(pending);

    await advance(FO_SIGN_OUT_TIMEOUT_MS - 1000);
    assert.equal(state.settled, false);

    await advance(1000);
    const res = await pending;
    assert.equal(res.status, 200, "sign-out must not fail because FabOrchestrator is slow");
    assert.equal(((await res.json()) as { faborchRevoked: boolean }).faborchRevoked, false);
    assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`${FO_TOKEN_COOKIE}=;`));
  });

  test("a 204 from FabOrchestrator is a sign-out, not a crash", async () => {
    // A status that may carry no body. Buffering the reply must not choke on it.
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    assert.equal(await foLogout(TOKEN), true);
  });
});
