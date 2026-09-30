/**
 * Gateway deadlines (`lib/gateway/deadline.ts`; plan RP4, finding G1), driven
 * through the real route handler on a mocked clock against a scripted
 * FabOrchestrator that honours abort signals the way a real `fetch` does.
 *
 *   headers never arrive          → 504 upstream_timeout at the headers limit
 *   headers, then silence         → the stream is errored (never closed) at idle
 *   keep-alive every 20 s         → a long answer completes
 *   a trickle past the lifetime   → errored at the lifetime
 *   a slow phone                  → never mistaken for a silent FabOrchestrator
 *   the phone leaves              → FabOrchestrator's call is aborted, no incident
 *   a normal finish               → every timer cleared
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { rememberFromList, resetOwnershipCache } from "@/lib/gateway/ownership";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import {
  budgetProblems,
  callClassFor,
  FO_KEEPALIVE_GAP_MS,
  gatewayBudgets,
} from "@/lib/gateway/deadline";
import { GET, POST } from "@/app/fo-gateway/[...path]/route";

const B = gatewayBudgets({});
const FO_TOKEN = "fo-session-not-a-real-token";
const PWA_TOKEN = sessionFor(
  { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
).token;

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realError = console.error;
let logs: string[] = [];
let upstreamSignal: AbortSignal | undefined;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function advance(ms: number, step = 1000) {
  for (let done = 0; done < ms; done += step) {
    mock.timers.tick(Math.min(step, ms - done));
    await flush();
  }
  await flush();
}

/**
 * A scripted FabOrchestrator: headers after `headersAfterMs` (or never), then
 * chunks at the given offsets after the headers, then close (or stay open).
 */
function scriptFo(opts: { headersAfterMs?: number | null; chunksAt?: number[]; close?: boolean }) {
  const { headersAfterMs = 0, chunksAt = [], close = true } = opts;
  globalThis.fetch = ((_input: RequestInfo | URL, init: RequestInit = {}) => {
    upstreamSignal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")));
      if (headersAfterMs === null) return;
      setTimeout(() => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            let last = 0;
            chunksAt.forEach((at, i) => {
              setTimeout(() => {
                try {
                  c.enqueue(new TextEncoder().encode(`c${i};`));
                } catch {
                  /* cancelled */
                }
              }, at);
              last = Math.max(last, at);
            });
            if (close) setTimeout(() => { try { c.close(); } catch { /* cancelled */ } }, last + 1);
            signal?.addEventListener("abort", () => {
              try {
                c.error(signal.reason);
              } catch {
                /* already closed */
              }
            });
          },
        });
        resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
      }, headersAfterMs);
    });
  }) as typeof fetch;
}

function call(handler: typeof GET, method: string, path: string, body?: unknown, signal?: AbortSignal) {
  const req = new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
    method,
    headers: {
      [GATEWAY_MARKER_HEADER]: "1",
      authorization: `Bearer ${PWA_TOKEN}`,
      cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  return handler(req, { params: Promise.resolve({ path: path.slice(1).split("/") }) });
}

const chat = (signal?: AbortSignal) => call(POST, "POST", "/api/chat", { messages: [] }, signal);

/** Let the route run until it has actually called FabOrchestrator. */
async function fetched() {
  for (let i = 0; i < 50 && !upstreamSignal; i++) await flush();
  assert.ok(upstreamSignal, "the route never reached FabOrchestrator");
}

/** Tick the clock a second at a time until the route has answered. */
async function answered(pending: Promise<Response>, maxMs = 5000): Promise<Response> {
  const state = track(pending);
  for (let t = 0; t < maxMs && !state.settled; t += 1000) await advance(1000);
  return pending;
}

function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(() => (state.settled = true), () => (state.settled = true));
  return state;
}

/** Read a response body to the end, advancing the clock; resolves to the text or the error. */
async function readAll(res: Response, maxMs: number): Promise<{ text: string; error: unknown }> {
  const reader = res.body!.getReader();
  let text = "";
  let error: unknown = null;
  let finished = false;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch (e) {
      error = e;
    }
    finished = true;
  })();
  for (let t = 0; t < maxMs && !finished; t += 1000) await advance(1000);
  await flush();
  return { text, error };
}

beforeEach(() => {
  logs = [];
  upstreamSignal = undefined;
  resetOwnershipCache();
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
});
afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
});

describe("classes and budgets", () => {
  test("each request is put in the right class", () => {
    assert.equal(callClassFor("fo-api", "/api/chat", "POST", "application/json"), "stream");
    assert.equal(callClassFor("fo-api", "/api/modeling-agent/chat", "POST", "application/json"), "stream");
    assert.equal(callClassFor("fo-api", "/api/chat", "GET", null), "bounded");
    assert.equal(callClassFor("fo-api", "/api/modeling-agent/parse-upload", "POST", "multipart/form-data; boundary=x"), "upload");
    assert.equal(callClassFor("fo-api", "/api/conversations", "GET", null), "bounded");
    assert.equal(callClassFor("fo-document", "/chat", "GET", null), "document");
    assert.equal(callClassFor("fo-static", "/_next/static/a.js", "GET", null), "document");
  });

  test("defaults are provisional values, each overridable from the environment", () => {
    assert.equal(B.stream.headersMs, 60_000);
    const env = gatewayBudgets({ GATEWAY_TIMEOUT_STREAM_IDLE_MS: "90000", GATEWAY_TIMEOUT_BOUNDED_HEADERS_MS: "nonsense" });
    assert.equal(env.stream.idleMs, 90_000);
    assert.equal(env.bounded.headersMs, B.bounded.headersMs, "an unusable value keeps the default");
  });

  test("the defaults are sound, and an idle limit inside FO's keep-alive gap is flagged", () => {
    assert.deepEqual(budgetProblems(B), []);
    const tooShort = gatewayBudgets({ GATEWAY_TIMEOUT_STREAM_IDLE_MS: String(FO_KEEPALIVE_GAP_MS) });
    assert.equal(budgetProblems(tooShort).length, 1);
  });
});

describe("before the headers", () => {
  test("a bounded call FabOrchestrator never answers is a 504 at its limit, not before", async () => {
    scriptFo({ headersAfterMs: null });
    const pending = call(GET, "GET", "/api/conversations");
    const state = track(pending);
    await fetched();
    await advance(B.bounded.headersMs - 1000);
    assert.equal(state.settled, false, "gave up early");
    await advance(1000);
    const res = await pending;
    assert.equal(res.status, 504);
    assert.equal(((await res.json()) as { code: string }).code, "upstream_timeout");
    assert.equal(upstreamSignal?.aborted, true, "FabOrchestrator's call is aborted, not abandoned");
  });

  test("a chat answer gets the longer stream limit to begin", async () => {
    scriptFo({ headersAfterMs: B.stream.headersMs - 2000, chunksAt: [0] });
    const pending = chat();
    await fetched();
    await advance(B.stream.headersMs - 1000);
    const res = await answered(pending);
    assert.equal(res.status, 200, "a slow start is not a failed one");
    const { error } = await readAll(res, 5000);
    assert.equal(error, null);
  });
});

describe("after the headers", () => {
  test("silence after the headers errors the stream at the idle limit, and never closes it cleanly", async () => {
    scriptFo({ headersAfterMs: 0, chunksAt: [0], close: false });
    const pending = chat();
    await fetched();
    const res = await answered(pending);
    assert.equal(res.status, 200);
    const started = Date.now();
    const { text, error } = await readAll(res, B.stream.idleMs + 5000);
    assert.equal(text, "c0;");
    assert.ok(error, "errored, so the client cannot take half an answer for a whole one");
    assert.ok(Date.now() - started >= B.stream.idleMs - 1000, "not before the idle limit");
    assert.ok(logs.some((l) => l.includes('"reason":"idle"') && l.includes('"class":"stream"')), logs.join("\n"));
    assert.ok(!logs.join("\n").includes("fo.test"), "the FO address is never logged");
  });

  test("a keep-alive every 20 seconds carries a long answer through", async () => {
    const at = Array.from({ length: 8 }, (_, i) => i * FO_KEEPALIVE_GAP_MS); // 140 s of answer
    scriptFo({ headersAfterMs: 0, chunksAt: at });
    const pending = chat();
    await fetched();
    const { text, error } = await readAll(await answered(pending), 160_000);
    assert.equal(error, null);
    assert.equal(text.split(";").length - 1, 8, "every chunk arrived");
  });

  test("a trickle that outlives the lifetime is errored at the lifetime", async () => {
    const at = Array.from({ length: 50 }, (_, i) => i * 10_000); // a chunk every 10 s for 500 s
    scriptFo({ headersAfterMs: 0, chunksAt: at });
    const pending = chat();
    await fetched();
    const { error } = await readAll(await answered(pending), B.stream.lifeMs + 20_000);
    assert.ok(error);
    assert.ok(logs.some((l) => l.includes('"reason":"lifetime"')), logs.join("\n"));
  });

  test("a slow phone is never mistaken for a silent FabOrchestrator", async () => {
    // FO sends everything within 30 s; the phone does not read for 120 s.
    scriptFo({ headersAfterMs: 0, chunksAt: [0, 10_000, 20_000, 30_000] });
    const pending = chat();
    await fetched();
    const res = await answered(pending);
    await advance(120_000);
    const { text, error } = await readAll(res, 10_000);
    assert.equal(error, null, "no idle timer runs while nobody is waiting on FabOrchestrator");
    assert.equal(text, "c0;c1;c2;c3;");
  });

  test("a normal finish clears every timer", async () => {
    scriptFo({ headersAfterMs: 0, chunksAt: [0, 1000] });
    const pending = chat();
    await fetched();
    await readAll(await answered(pending), 5000);
    await advance(B.stream.lifeMs + 60_000, 10_000);
    assert.ok(!logs.some((l) => l.includes("upstream_timeout")), logs.join("\n"));
  });
});

describe("the phone leaving", () => {
  test("aborts FabOrchestrator's call, and is not reported as an incident", async () => {
    // An ordinary call. A chat answer is the exception, below.
    scriptFo({ headersAfterMs: null });
    const phone = new AbortController();
    const pending = call(GET, "GET", "/api/conversations", undefined, phone.signal);
    await fetched();
    phone.abort();
    await advance(0);
    const res = await pending;
    assert.equal(res.status, 499);
    assert.equal(upstreamSignal?.aborted, true);
    assert.ok(!logs.some((l) => /upstream_timeout|gateway\/unreachable/.test(l)), logs.join("\n"));
  });
});

/**
 * The stopgap (`lib/gateway/keep-reading.ts`, 2026-09-30): FabOrchestrator
 * saves an answer only when its stream is read to the end, so a chat answer
 * the phone walks away from is read to the end here. The deadlines above still
 * apply to it.
 */
describe("a chat answer the phone leaves is still read to the end (stopgap)", () => {
  const realInfo = console.info;
  let infos: string[] = [];
  beforeEach(() => {
    infos = [];
    console.info = (...a: unknown[]) => infos.push(a.map(String).join(" "));
  });
  afterEach(() => {
    console.info = realInfo;
    delete process.env.KEEP_READING_MAX_STREAMS;
  });
  const keptLine = () => infos.find((l) => l.includes('"event":"answer_kept_reading"'));

  test("FabOrchestrator's call is not aborted, and the answer is read to its end", async () => {
    scriptFo({ headersAfterMs: 0, chunksAt: [0, 5000, 10_000] });
    const phone = new AbortController();
    const res = await answered(chat(phone.signal));
    assert.equal(res.status, 200);
    // The phone reads the start of the answer, then is minimised: its
    // connection closes and Next cancels its side of the body.
    const reader = res.body!.getReader();
    const first = reader.read();
    await advance(1000); // the scripted chunks arrive on the test clock
    assert.equal(new TextDecoder().decode((await first).value), "c0;");
    phone.abort();
    // Not awaited: one half of a tee finishes cancelling only when the other
    // half is done too, which here needs the clock to move.
    void reader.cancel();
    await advance(15_000);
    assert.equal(upstreamSignal?.aborted, false, "the phone leaving did not end FabOrchestrator's call");
    const line = keptLine();
    assert.ok(line, infos.join("\n"));
    assert.match(line!, /"outcome":"completed"/);
    assert.ok(!line!.includes("fo.test"), "never the FabOrchestrator address");
  });

  test("the phone leaving before the answer starts does not end it either", async () => {
    scriptFo({ headersAfterMs: 3000, chunksAt: [0] });
    const phone = new AbortController();
    const pending = chat(phone.signal);
    await fetched();
    phone.abort();
    const res = await answered(pending);
    assert.equal(res.status, 200, "the answer still arrives, to be read here");
    void res.body!.cancel();
    await advance(2000);
    assert.equal(upstreamSignal?.aborted, false);
    assert.match(keptLine() ?? "", /"outcome":"completed"/);
  });

  test("the deadlines still end it: FabOrchestrator going silent after the phone left", async () => {
    scriptFo({ headersAfterMs: 0, chunksAt: [0], close: false });
    const phone = new AbortController();
    const res = await answered(chat(phone.signal));
    const reader = res.body!.getReader();
    const first = reader.read();
    await advance(1000);
    await first;
    phone.abort();
    // Not awaited: one half of a tee finishes cancelling only when the other
    // half is done too, which here needs the clock to move.
    void reader.cancel();
    await advance(B.stream.idleMs + 5000);
    assert.equal(upstreamSignal?.aborted, true, "the idle deadline ended the call");
    assert.ok(logs.some((l) => l.includes('"reason":"idle"')), logs.join("\n"));
    assert.match(keptLine() ?? "", /"outcome":"errored"/);
  });

  test("while the phone stays, it gets exactly what it got before", async () => {
    scriptFo({ headersAfterMs: 0, chunksAt: [0, 1000, 2000] });
    const { text, error } = await readAll(await answered(chat()), 5000);
    assert.equal(error, null);
    assert.equal(text, "c0;c1;c2;");
    assert.equal(keptLine(), undefined, "nothing to report when the phone stayed");
  });

  test("a new question in the same conversation stops the read of the previous answer", async () => {
    // A stopped (or abandoned) answer must not be saved after the next
    // question: FabOrchestrator writes it when it finishes (review, 30 Sep).
    const CONVO = "33333333-3333-4333-8333-333333333333";
    rememberFromList(FO_TOKEN, JSON.stringify([{ id: CONVO }]));
    scriptFo({ headersAfterMs: 0, chunksAt: [0, 30_000] });
    const phone = new AbortController();
    const first = await answered(call(POST, "POST", "/api/chat", { conversationId: CONVO, messages: [] }, phone.signal));
    const firstUpstream = upstreamSignal!;
    const reader = first.body!.getReader();
    const chunk = reader.read();
    await advance(1000);
    await chunk;
    phone.abort(); // Stop, or the phone minimised
    void reader.cancel();
    await advance(1000);
    assert.equal(firstUpstream.aborted, false, "still being read on the phone's behalf");

    const second = await answered(call(POST, "POST", "/api/chat", { conversationId: CONVO, messages: [] }));
    await flush();
    assert.equal(firstUpstream.aborted, true, "the previous answer is no longer read to its end");
    assert.match(keptLine() ?? "", /"outcome":"superseded"/);
    await readAll(second, 40_000);
  });

  test("a new question sent while the previous answer is still awaited stops it, and only the new one is answered (review, issue 3)", async () => {
    // Turn A is sent; FabOrchestrator thinks for a long time; the operator
    // presses Stop and sends turn B before A's headers arrive. Until this
    // fix A was invisible to B's supersede, later streamed, and was saved
    // after B's question.
    const CONVO = "66666666-6666-4666-8666-666666666666";
    rememberFromList(FO_TOKEN, JSON.stringify([{ id: CONVO }]));
    scriptFo({ headersAfterMs: 30_000, chunksAt: [0] });
    const phone = new AbortController();
    const pendingA = call(POST, "POST", "/api/chat", { conversationId: CONVO, messages: [] }, phone.signal);
    await fetched();
    const aUpstream = upstreamSignal!;
    phone.abort(); // Stop, during FO's think time
    await advance(1000);
    assert.equal(aUpstream.aborted, false, "A is kept: FO's answer would still be read on the phone's behalf");

    upstreamSignal = undefined;
    const pendingB = call(POST, "POST", "/api/chat", { conversationId: CONVO, messages: [] });
    await fetched();
    const bUpstream = upstreamSignal!;
    assert.equal(aUpstream.aborted, true, "B's claim stopped A while A was still waiting for headers");
    assert.equal(bUpstream.aborted, false);
    const resA = await answered(pendingA);
    assert.equal(resA.status, 499, "A is over; FabOrchestrator will not produce A's answer");
    assert.ok(infos.some((l) => l.includes('"event":"turn_superseded"')), infos.join("\n"));

    await advance(30_000); // FO answers B
    const resB = await answered(pendingB);
    assert.equal(resB.status, 200);
    const { text, error } = await readAll(resB, 5000);
    assert.equal(error, null);
    assert.equal(text, "c0;", "B's answer, and only B's, reaches the phone");
    assert.equal(bUpstream.aborted, false, "B was never stopped");
  });

  test("with every slot taken, a chat falls back to ending when the phone leaves", async () => {
    process.env.KEEP_READING_MAX_STREAMS = "0";
    scriptFo({ headersAfterMs: null });
    const phone = new AbortController();
    const pending = chat(phone.signal);
    await fetched();
    phone.abort();
    await advance(0);
    assert.equal((await pending).status, 499);
    assert.equal(upstreamSignal?.aborted, true);
  });
});
