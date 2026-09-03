/**
 * WP10 — what the screen shows while it waits, and when it cannot answer.
 *
 * The package's line is that **every failure reaches the screen as a
 * predictable `{ code, message }` and every state tells the operator what to do
 * next**. A screen that can only say "something went wrong" sends somebody to
 * find whoever set the demo up, and on a fab floor that person is not there.
 *
 * Four things are asserted here:
 *
 *   1. the error table — one code per situation, a next step for each, and a
 *      retry offered only where retrying can work
 *   2. `errorId` survives, out of the sentence and into its own field
 *   3. the three progress states are distinct, and a stall is a warning rather
 *      than an ending
 *   4. an answer cut off part-way is marked, so half a table is not read as a
 *      whole one
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  NEEDS_SIGN_IN,
  NEXT_STEP,
  RETRYABLE,
  codeForStatus,
  splitErrorId,
  statusForCode,
  type PwaErrorCode,
} from "../../lib/faborch/errors";
import {
  EMPTY_CONVERSATION,
  conversationReducer as reduce,
  type ConversationAction,
  type ConversationState,
} from "../../lib/faborch/conversation";
import { STALL_MS, readFoStream, type FoStreamEvent } from "../../lib/faborch/stream";

const ALL_CODES: PwaErrorCode[] = [
  "not_configured",
  "no_faborch_session",
  "faborch_session_expired",
  "faborch_rejected",
  "agent_forbidden",
  "quota_exceeded",
  "faborch_unavailable",
  "connection_lost",
  "stream_stalled",
  "bad_request",
];

const run = (...actions: ConversationAction[]): ConversationState =>
  actions.reduce(reduce, EMPTY_CONVERSATION);

const ask: ConversationAction = {
  type: "ask",
  prompt: "Yield on line 4?",
  userId: "u1",
  assistantId: "a1",
};

/* ── 1. The table ─────────────────────────────────────────────────────────── */

describe("every failure has a code, and every code has a next step", () => {
  test("no code is left without one", () => {
    // The whole point of the package: a message with no next step is the one
    // that sends an operator looking for the person who set this up.
    for (const code of ALL_CODES) {
      const step = NEXT_STEP[code];
      assert.ok(step && step.trim().length > 0, `${code} has no next step`);
    }
  });

  test("FabOrchestrator's statuses map to distinct codes", () => {
    // These three need three different next steps. Collapsing them into one
    // "unavailable", which is what the code did before WP10, tells an operator
    // to retry a quota that has not moved and to wait out a permission they
    // will never be granted.
    assert.equal(codeForStatus(400), "faborch_rejected");
    assert.equal(codeForStatus(403), "agent_forbidden");
    assert.equal(codeForStatus(429), "quota_exceeded");
  });

  test("anything unrecognised is 'unavailable' rather than a guess", () => {
    for (const status of [500, 502, 504, 418]) {
      assert.equal(codeForStatus(status), "faborch_unavailable", String(status));
    }
  });

  test("the status this app answers with lets a client tell wait from broken", () => {
    // A 429 that arrives as a 502 is indistinguishable from an outage, and the
    // caller retries something that cannot succeed.
    assert.equal(statusForCode("quota_exceeded"), 429);
    assert.equal(statusForCode("agent_forbidden"), 403);
    assert.equal(statusForCode("not_configured"), 503);
    assert.equal(statusForCode("faborch_session_expired"), 401);
    assert.equal(statusForCode("faborch_unavailable"), 502);
  });

  test("retry is offered only where retrying can work", () => {
    // A quota does not move because a button was pressed, and a permission
    // refusal asks the same question of the same role. Offering the control
    // invites somebody to keep pressing it instead of telling an administrator.
    assert.ok(RETRYABLE.has("faborch_unavailable"));
    assert.ok(RETRYABLE.has("connection_lost"));
    assert.ok(RETRYABLE.has("stream_stalled"));

    assert.ok(!RETRYABLE.has("quota_exceeded"), "a quota does not move on retry");
    assert.ok(!RETRYABLE.has("agent_forbidden"), "a role does not change on retry");
    assert.ok(!RETRYABLE.has("not_configured"), "a deployment fault is not the operator's");
    assert.ok(!RETRYABLE.has("faborch_session_expired"), "that one needs a sign-in");
  });

  test("the two identity codes offer sign-in instead", () => {
    assert.deepEqual(
      [...NEEDS_SIGN_IN].sort(),
      ["faborch_session_expired", "no_faborch_session"],
    );
    // And they are never also retryable, or the screen would offer both.
    for (const code of NEEDS_SIGN_IN) assert.ok(!RETRYABLE.has(code), code);
  });
});

/* ── 2. The error id ──────────────────────────────────────────────────────── */

describe("FabOrchestrator's error id survives, out of the prose", () => {
  test("it is lifted out and the sentence still reads", () => {
    // FO's `onError` returns "<message> (errorId=<uuid>)". Left inline it is
    // something a supervisor has to transcribe off a phone by eye.
    const { message, errorId } = splitErrorId(
      "The data connection did not respond. (errorId=6f1c2b90-2f7e-4a11-9a1e-77bb0f2c4d33)",
    );
    assert.equal(message, "The data connection did not respond.");
    assert.equal(errorId, "6f1c2b90-2f7e-4a11-9a1e-77bb0f2c4d33");
  });

  test("a message with no id is returned unchanged", () => {
    const { message, errorId } = splitErrorId("Daily limit reached. Try again later.");
    assert.equal(message, "Daily limit reached. Try again later.");
    assert.equal(errorId, undefined);
  });

  test("an id in the middle of a sentence does not leave double spaces", () => {
    const { message, errorId } = splitErrorId("Something failed (errorId=e-9) while querying.");
    assert.equal(message, "Something failed while querying.");
    assert.equal(errorId, "e-9");
  });

  test("a message that is only an id keeps something to show", () => {
    // Stripping it would leave an empty error, which is worse than a technical
    // one: the screen would render a notice with no text in it.
    const { message, errorId } = splitErrorId("(errorId=e-42)");
    assert.ok(message.length > 0, "an empty message is worse than a technical one");
    assert.equal(errorId, "e-42");
  });

  test("the id format is FabOrchestrator's business, not this app's", () => {
    // FO's catalog is a database table. Matching a strict UUID here would drop
    // ids the day that table changes shape.
    assert.equal(splitErrorId("Failed (errorId=ABC-123_xyz)").errorId, "ABC-123_xyz");
  });
});

/* ── 3. The three progress states ─────────────────────────────────────────── */

describe("progress is three distinct states, not one spinner", () => {
  test("asking is 'waiting' — sent, nothing back yet", () => {
    const s = run(ask);
    assert.equal(s.phase, "waiting");
    assert.equal(s.busy, true);
  });

  test("a tool call is 'working', and names the tool", () => {
    const s = run(ask, { type: "activity", name: "mcp_query" });
    assert.equal(s.phase, "working");
    assert.equal(s.activity, "mcp_query");
  });

  test("text arriving is 'answering', and clears the tool name", () => {
    const s = run(ask, { type: "activity", name: "mcp_query" }, { type: "delta", delta: "94" });
    assert.equal(s.phase, "answering");
    assert.equal(s.activity, null);
  });

  test("every ending returns to idle", () => {
    for (const ending of [
      { type: "settled" } as const,
      { type: "stopped" } as const,
      { type: "failed", failure: { code: "faborch_unavailable", message: "x" } } as const,
    ]) {
      const s = run(ask, { type: "delta", delta: "half" }, ending);
      assert.equal(s.phase, "idle", ending.type);
      assert.equal(s.busy, false, ending.type);
    }
  });
});

/* ── The stall: a warning, not a verdict ──────────────────────────────────── */

describe("a stall warns without ending the turn", () => {
  test("the turn stays open and the composer still shows Stop", () => {
    const s = run(ask, { type: "stalled" });
    assert.equal(s.phase, "stalled");
    assert.equal(s.busy, true, "a stall must not end the turn — FO may still be working");
    assert.equal(s.streamingId, "a1", "and the answer must still have somewhere to land");
  });

  test("text arriving afterwards clears it, with no dismissal needed", () => {
    const s = run(ask, { type: "stalled" }, { type: "delta", delta: "finally" });
    assert.equal(s.phase, "answering");
    assert.equal(s.turns[1].text, "finally");
  });

  test("a tool starting afterwards clears it too", () => {
    const s = run(ask, { type: "stalled" }, { type: "activity", name: "mcp_query" });
    assert.equal(s.phase, "working");
  });

  test("it is ignored when no turn is in flight", () => {
    // Nothing is waiting, so there is nothing to warn about. Without this a
    // late timer could paint a warning over a finished conversation.
    const s = run(ask, { type: "settled" }, { type: "stalled" });
    assert.equal(s.phase, "idle");
  });
});

/* ── The watchdog that produces it ────────────────────────────────────────── */

describe("readFoStream's stall watchdog", () => {
  /**
   * A stream that emits `frames`, goes quiet, then closes after `quietMs`.
   *
   * The quiet period is what the watchdog is for. The close matters only to the
   * test: `readFoStream` loops until the stream ends, so a stream that never
   * closes keeps the loop — and the runner — alive forever.
   */
  function goesQuiet(frames: string[], quietMs: number): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        setTimeout(() => controller.close(), quietMs);
      },
    });
  }

  test("fires after the configured silence", async () => {
    const events: FoStreamEvent[] = [];
    const stream = goesQuiet(
      [`data: ${JSON.stringify({ type: "text-delta", delta: "hi" })}

`],
      200,
    );

    await readFoStream(stream, (e) => events.push(e), { stallMs: 40 });

    assert.ok(
      events.some((e) => e.type === "stalled"),
      `expected a stall; saw ${events.map((e) => e.type).join(", ") || "nothing"}`,
    );
    // And what arrived before the silence is still delivered.
    assert.ok(events.some((e) => e.type === "text"));
  });

  test("warns once per silence, not every interval", async () => {
    // Re-firing into a dead connection is noise, and on screen it would look
    // like the app repeatedly discovering the same thing.
    const events: FoStreamEvent[] = [];
    const stream = goesQuiet([], 250);

    await readFoStream(stream, (e) => events.push(e), { stallMs: 30 });

    assert.equal(events.filter((e) => e.type === "stalled").length, 1);
  });

  test("does not fire on a stream that is answering normally", async () => {
    const events: FoStreamEvent[] = [];
    const frames = [
      `data: ${JSON.stringify({ type: "text-delta", delta: "yield " })}\n\n`,
      `data: ${JSON.stringify({ type: "text-delta", delta: "is 94%" })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    });

    await readFoStream(stream, (e) => events.push(e), { stallMs: 50 });

    assert.ok(!events.some((e) => e.type === "stalled"));
    assert.equal(
      events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""),
      "yield is 94%",
    );
  });

  test("a keep-alive counts as life, even though it produces no event", async () => {
    // FO sends `data-keepalive` every 15s precisely so a long tool call does
    // not look dead. The parser maps it to nothing, so a watchdog counting
    // EVENTS would fire on every healthy long turn. It counts reads.
    const events: FoStreamEvent[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        let sent = 0;
        const timer = setInterval(() => {
          if (sent++ >= 6) {
            clearInterval(timer);
            controller.close();
            return;
          }
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "data-keepalive" })}\n\n`));
        }, 20);
      },
    });

    await readFoStream(stream, (e) => events.push(e), { stallMs: 60 });

    assert.ok(
      !events.some((e) => e.type === "stalled"),
      "keep-alives must hold the watchdog off",
    );
  });

  test("the shipped threshold is three missed keep-alives", () => {
    assert.equal(STALL_MS, 45_000);
  });
});

/* ── 4. An answer cut off part-way ────────────────────────────────────────── */

describe("an interrupted answer is marked, not silently truncated", () => {
  test("a failure part-way through marks the turn incomplete", () => {
    // Half a yield table looks exactly like a whole one. Nothing in the text
    // says otherwise, so the badge is the only thing that can.
    const s = run(
      ask,
      { type: "delta", delta: "| Product | Yield |\n| A | 94% |" },
      { type: "failed", failure: { code: "connection_lost", message: "dropped" } },
    );
    assert.equal(s.turns.length, 2);
    assert.equal(s.turns[1].incomplete, true);
    assert.match(s.turns[1].text, /94%/, "and what arrived is kept");
  });

  test("a failure before any text leaves nothing to mark", () => {
    const s = run(ask, { type: "failed", failure: { code: "quota_exceeded", message: "limit" } });
    assert.equal(s.turns.length, 1, "the empty placeholder is dropped");
    assert.equal(s.turns[0].role, "user");
  });

  test("Stop is not marked incomplete — the user chose it", () => {
    // They pressed the button and know what they have. A warning badge would
    // be the app telling them something went wrong when nothing did.
    const s = run(ask, { type: "delta", delta: "partial" }, { type: "stopped" });
    assert.equal(s.turns[1].incomplete, undefined);
    assert.equal(s.turns[1].text, "partial");
  });

  test("a clean finish is not marked either", () => {
    const s = run(ask, { type: "delta", delta: "complete" }, { type: "settled" });
    assert.equal(s.turns[1].incomplete, undefined);
  });

  test("the failure carries its errorId through to the screen", () => {
    const s = run(ask, {
      type: "failed",
      failure: { code: "faborch_unavailable", message: "It failed.", errorId: "e-9" },
    });
    assert.equal(s.failure?.errorId, "e-9");
  });
});
