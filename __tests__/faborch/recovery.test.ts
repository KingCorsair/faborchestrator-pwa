/**
 * An answer the phone lost part-way through, fetched back (2026-09-29).
 *
 * Reported: minimise the app mid-answer, come back, and the screen says "This
 * answer stopped part-way and is incomplete". The phone had lost its
 * connection — and the chat route passed that on to FabOrchestrator, which then
 * never saved the answer (see `lib/faborch/keep-reading.ts` for why).
 *
 * What is pinned:
 *   the route reads a saved turn to the end after the phone has gone, and does
 *     not for a turn nothing will save
 *   the screen tells "answered", "still working" and "never received" apart in
 *     FO's saved copy, and never mistakes an earlier answer for this one
 *   it waits while FO is still answering, gives up when there is no point, and
 *     stops when Stop is pressed
 *   the fetched answer replaces the partial one, whole and unmarked
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import {
  EMPTY_CONVERSATION,
  conversationReducer as reduce,
  type ConversationAction,
  type ConversationState,
  type Turn,
} from "@/lib/faborch/conversation";
import { keepReading } from "@/lib/faborch/keep-reading";
import { resetOwnershipCache } from "@/lib/faborch/owns";
import {
  RECOVER_MISSING_GRACE_MS,
  RECOVER_POLL_MS,
  RECOVER_WITHIN_MS,
  recoverAnswer,
  storedAnswer,
  type RecoverOptions,
} from "@/lib/faborch/recover";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { resetToolCache } from "@/lib/faborch/tools";
import { POST as CHAT } from "@/app/api/faborch/[agent]/chat/route";

const run = (...actions: ConversationAction[]): ConversationState =>
  actions.reduce(reduce, EMPTY_CONVERSATION);

const ask: ConversationAction = { type: "ask", prompt: "WIP by line?", userId: "u1", assistantId: "a1" };

const turn = (role: Turn["role"], text: string, id = `${role}-${text.length}`): Turn => ({ id, role, text });

/* ── The conversation, as data ───────────────────────────────────────────── */

describe("the conversation while an answer is fetched back", () => {
  test("recovering keeps the turn open, with the text that arrived", () => {
    const s = run(ask, { type: "delta", delta: "Line 1: 42 lots" }, { type: "recovering" });
    assert.equal(s.busy, true, "the composer keeps Stop");
    assert.equal(s.phase, "recovering");
    assert.equal(s.turns[1]!.text, "Line 1: 42 lots");
    assert.equal(s.failure, null);
  });

  test("recovering after the turn has ended changes nothing", () => {
    const settled = run(ask, { type: "delta", delta: "x" }, { type: "settled" });
    assert.equal(reduce(settled, { type: "recovering" }), settled);
  });

  test("the fetched answer replaces the partial one, whole and unmarked", () => {
    const s = run(
      ask,
      { type: "delta", delta: "Line 1: 42 lots" },
      { type: "recovering" },
      { type: "recovered", text: "Line 1: 42 lots\n\nLine 2: 17 lots" },
    );
    assert.equal(s.turns.length, 2);
    assert.equal(s.turns[1]!.text, "Line 1: 42 lots\n\nLine 2: 17 lots");
    assert.equal(s.turns[1]!.incomplete, undefined, "a whole answer carries no badge");
    assert.equal(s.busy, false);
    assert.equal(s.phase, "idle");
    assert.equal(s.failure, null);
  });

  test("an answer fetched back after nothing had arrived fills the empty turn", () => {
    const s = run(ask, { type: "recovering" }, { type: "recovered", text: "All lines idle." });
    assert.equal(s.turns[1]!.text, "All lines idle.");
    assert.equal(s.busy, false);
  });

  test("an empty fetched answer is not an answer", () => {
    const before = run(ask, { type: "delta", delta: "Line 1" }, { type: "recovering" });
    assert.equal(reduce(before, { type: "recovered", text: "  " }), before);
  });

  test("giving up still keeps what arrived, marked incomplete", () => {
    const s = run(
      ask,
      { type: "delta", delta: "Line 1: 42 lots" },
      { type: "recovering" },
      { type: "failed", failure: { code: "connection_lost", message: "dropped" } },
    );
    assert.equal(s.turns[1]!.text, "Line 1: 42 lots");
    assert.equal(s.turns[1]!.incomplete, true);
    assert.equal(s.failure?.code, "connection_lost");
  });
});

/* ── Reading FabOrchestrator's saved copy ────────────────────────────────── */

describe("what FabOrchestrator's saved copy says about the question just asked", () => {
  const earlier = [turn("user", "Yield?"), turn("assistant", "94%")];

  test("the question with an answer after it is answered", () => {
    const stored = [...earlier, turn("user", "WIP by line?"), turn("assistant", "Line 1: 42")];
    assert.deepEqual(storedAnswer(stored, "WIP by line?", 2), { kind: "answered", text: "Line 1: 42", files: [] });
  });

  test("the question with nothing after it is still being worked on", () => {
    const stored = [...earlier, turn("user", "WIP by line?")];
    assert.deepEqual(storedAnswer(stored, "WIP by line?", 2), { kind: "working" });
  });

  test("a thread without the question is missing it", () => {
    assert.deepEqual(storedAnswer(earlier, "WIP by line?", 2), { kind: "missing" });
    assert.deepEqual(storedAnswer([], "WIP by line?", 1), { kind: "missing" });
  });

  test("the same question asked twice: the first answer is not taken for the second", () => {
    // Saved so far: the first time it was asked, answered. The second time has
    // not been written down yet, so the last saved question is the first one.
    const stored = [turn("user", "WIP by line?"), turn("assistant", "Line 1: 40")];
    assert.deepEqual(storedAnswer(stored, "WIP by line?", 2), { kind: "missing" });
  });

  test("whitespace around the question does not stop the match", () => {
    const stored = [turn("user", "  WIP by line?\n"), turn("assistant", "Line 1: 42")];
    assert.equal(storedAnswer(stored, "WIP by line?", 1).kind, "answered");
  });

  test("an answer saved in several parts comes back as one", () => {
    const stored = [turn("user", "WIP?"), turn("assistant", "Part one.", "a1"), turn("assistant", "Part two.", "a2")];
    assert.deepEqual(storedAnswer(stored, "WIP?", 1), { kind: "answered", text: "Part one.\n\nPart two.", files: [] });
  });

  test("an empty saved answer is not an answer", () => {
    const stored = [turn("user", "WIP?"), turn("assistant", "   ")];
    assert.deepEqual(storedAnswer(stored, "WIP?", 1), { kind: "working" });
  });
});

/* ── Fetching it back ────────────────────────────────────────────────────── */

describe("fetching the answer back", () => {
  /** A clock that only moves when the recovery waits. */
  function harness(looks: (Turn[] | "gone" | null | Error)[], start = 1_000_000) {
    let clock = start;
    let loads = 0;
    let waits = 0;
    let visibleChecks = 0;
    const options = (overrides: Partial<RecoverOptions> = {}): RecoverOptions => ({
      conversationId: "c1",
      prompt: "WIP?",
      questionsAsked: 1,
      askedAt: start,
      signal: new AbortController().signal,
      load: async () => {
        const next = looks[Math.min(loads, looks.length - 1)]!;
        loads++;
        if (next instanceof Error) throw next;
        return next;
      },
      whenVisible: async () => {
        visibleChecks++;
      },
      wait: async (ms) => {
        waits++;
        clock += ms;
      },
      now: () => clock,
      ...overrides,
    });
    return {
      options,
      get loads() {
        return loads;
      },
      get waits() {
        return waits;
      },
      get visibleChecks() {
        return visibleChecks;
      },
    };
  }

  const working = [turn("user", "WIP?")];
  const answered = [turn("user", "WIP?"), turn("assistant", "Line 1: 42")];

  test("an answer already saved is shown on the first look, without waiting", async () => {
    const h = harness([answered]);
    assert.equal((await recoverAnswer(h.options()))?.text, "Line 1: 42");
    assert.equal(h.loads, 1);
    assert.equal(h.waits, 0);
  });

  test("while FabOrchestrator is still answering, it keeps looking", async () => {
    const h = harness([working, working, answered]);
    assert.equal((await recoverAnswer(h.options()))?.text, "Line 1: 42");
    assert.equal(h.loads, 3);
    assert.equal(h.waits, 2);
  });

  test("it only looks while the app is on screen", async () => {
    const h = harness([working, answered]);
    await recoverAnswer(h.options());
    assert.equal(h.visibleChecks, h.loads, "every look waits for the screen first");
  });

  test("a look that fails is tried again, not taken as the end", async () => {
    const h = harness([new Error("offline"), null, answered]);
    assert.equal((await recoverAnswer(h.options()))?.text, "Line 1: 42");
  });

  test("signed out, or the thread deleted, ends it at once", async () => {
    const h = harness(["gone"]);
    assert.equal(await recoverAnswer(h.options()), null);
    assert.equal(h.loads, 1);
  });

  test("a question FabOrchestrator never received is given up on after the grace period", async () => {
    const h = harness([[]]);
    assert.equal(await recoverAnswer(h.options()), null);
    const looks = Math.ceil(RECOVER_MISSING_GRACE_MS / RECOVER_POLL_MS) + 1;
    assert.equal(h.loads, looks, "not the whole six minutes");
  });

  test("an answer that never arrives is given up on once FabOrchestrator's budget is spent", async () => {
    const h = harness([working]);
    assert.equal(await recoverAnswer(h.options()), null);
    assert.equal(h.waits, Math.ceil(RECOVER_WITHIN_MS / RECOVER_POLL_MS));
  });

  test("coming back long after, it still looks once — and finds a finished answer", async () => {
    const h = harness([answered]);
    const late = h.options({ askedAt: 1_000_000 - 60 * 60_000 });
    assert.equal((await recoverAnswer(late))?.text, "Line 1: 42");
  });

  test("coming back long after to an unfinished answer gives up after that one look", async () => {
    const h = harness([working]);
    assert.equal(await recoverAnswer(h.options({ askedAt: 1_000_000 - 60 * 60_000 })), null);
    assert.equal(h.loads, 1);
  });

  test("Stop ends it", async () => {
    const stop = new AbortController();
    const h = harness([working]);
    const result = recoverAnswer(
      h.options({
        signal: stop.signal,
        wait: async () => {
          stop.abort();
        },
      }),
    );
    assert.equal(await result, null);
    assert.equal(h.loads, 1);
  });
});

/* ── The route keeps reading ─────────────────────────────────────────────── */

describe("reading FabOrchestrator's answer to the end", () => {
  /** A FabOrchestrator answer that arrives a frame at a time. */
  function slowAnswer(frames: number) {
    let pulled = 0;
    let cancelled = false;
    let ended!: () => void;
    const end = new Promise<void>((resolve) => (ended = resolve));
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (pulled < frames) {
          pulled++;
          controller.enqueue(encoder.encode(`data: {"type":"text-delta","delta":"${pulled} "}\n\n`));
        } else {
          controller.close();
          ended();
        }
      },
      cancel() {
        cancelled = true;
        ended();
      },
    });
    return {
      body,
      end,
      get pulled() {
        return pulled;
      },
      get cancelled() {
        return cancelled;
      },
    };
  }

  test("the phone's copy going away does not stop the reading", async () => {
    const fo = slowAnswer(20);
    const { forPhone, finished } = keepReading(fo.body);
    const phone = forPhone.getReader();
    await phone.read();
    await phone.cancel();
    await finished;
    assert.equal(fo.cancelled, false);
    assert.equal(fo.pulled, 20, "every frame was read");
  });

  test("with the phone still there, it gets every frame", async () => {
    const fo = slowAnswer(5);
    const { forPhone, finished } = keepReading(fo.body);
    const text = await new Response(forPhone).text();
    await finished;
    assert.equal((text.match(/text-delta/g) ?? []).length, 5);
  });

  test("a stream that never ends is let go at the limit", async () => {
    const endless = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const { forPhone, finished } = keepReading(endless, 20);
    await forPhone.cancel();
    await finished;
  });

  test("a FabOrchestrator connection that fails does not throw here", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    const { forPhone, finished } = keepReading(broken);
    await forPhone.cancel().catch(() => {});
    await finished;
  });

  /* The route, end to end, against a stubbed FabOrchestrator. */

  const FO_TOKEN = "fo-token-not-real";
  const THREAD = "7b0f6a52-3c55-4a4e-9a51-5d1f2d6c9e10";
  const PWA_TOKEN = sessionFor(
    { id: "u1", email: "supervisor@plant.example", name: "Operator", roleName: "Supervisor" },
    new Date(Date.now() + 864e5).toISOString(),
    FO_TOKEN,
  ).token;

  const realFetch = globalThis.fetch;
  let chatSignal: AbortSignal | null | undefined;

  beforeEach(() => {
    resetToolCache();
    resetOwnershipCache();
    chatSignal = undefined;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFo(answer: ReadableStream<Uint8Array>) {
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/mcp/connections") return Response.json([{ id: "m1", status: "connected" }]);
      if (url.pathname === "/api/conversations") return Response.json([{ id: THREAD, title: "WIP" }]);
      if (url.pathname === "/api/chat") {
        chatSignal = init.signal;
        return new Response(answer, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
  }

  const askFrom = (phone: AbortSignal, thread?: string) =>
    CHAT(
      new NextRequest("https://pwa.test/api/faborch/insight/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PWA_TOKEN}`,
          cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: "WIP by line?" }] }],
          ...(thread ? { conversationId: thread } : {}),
        }),
        signal: phone,
      }),
      { params: Promise.resolve({ agent: "insight" }) },
    );

  test("a turn FabOrchestrator is saving is read to the end after the phone goes", async () => {
    const fo = slowAnswer(12);
    stubFo(fo.body);
    const phone = new AbortController();

    const res = await askFrom(phone.signal, THREAD);
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read();

    phone.abort();
    await reader.cancel();
    await fo.end;

    assert.equal(fo.cancelled, false, "FabOrchestrator must be allowed to finish, so it saves the answer");
    assert.equal(fo.pulled, 12);
    assert.equal(chatSignal?.aborted ?? false, false, "the phone leaving does not cancel FabOrchestrator's request");
  });

  test("a turn nothing will save still ends when the phone does", async () => {
    const fo = slowAnswer(12);
    stubFo(fo.body);
    const phone = new AbortController();

    const res = await askFrom(phone.signal);
    const reader = res.body!.getReader();
    await reader.read();

    phone.abort();
    await reader.cancel();
    await fo.end;

    assert.equal(fo.cancelled, true, "nothing would be saved, so there is nothing to finish for");
    assert.equal(chatSignal?.aborted, true);
  });

  test("the phone that stays gets the whole answer, as before", async () => {
    const fo = slowAnswer(6);
    stubFo(fo.body);
    const res = await askFrom(new AbortController().signal, THREAD);
    const text = await res.text();
    assert.equal((text.match(/text-delta/g) ?? []).length, 6);
    assert.equal(res.headers.get("X-Accel-Buffering"), "no");
  });
});
