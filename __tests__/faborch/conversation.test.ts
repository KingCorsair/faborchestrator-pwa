/**
 * The conversation layer — the one part of the FabOrchestrator path that had no
 * test behind it.
 *
 * These exercise `lib/faborch/conversation.ts` as data: a sequence of actions in,
 * a state out. What they are really checking is the set of promises the screen
 * makes about a conversation — that a stop keeps what arrived, that an empty
 * answer leaves no bubble, that a follow-up carries its context, and that a full
 * thread says so instead of failing with a schema library's words.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_CONVERSATION,
  MAX_MESSAGES,
  MAX_TEXT,
  capacityFailure,
  capacityIssue,
  conversationReducer as reduce,
  historyFor,
  toFoMessages,
  type ConversationAction,
  type ConversationState,
  type Turn,
} from "../../lib/faborch/conversation";
import { FabInsightRequestSchema } from "../../lib/validation";

/** Run a script of actions from empty, the way a turn actually arrives. */
function run(...actions: ConversationAction[]): ConversationState {
  return actions.reduce(reduce, EMPTY_CONVERSATION);
}

const ask: ConversationAction = { type: "ask", prompt: "Yield on line 4?", userId: "u1", assistantId: "a1" };

/* ── Asking ──────────────────────────────────────────────────────────────── */

test("asking shows the question and an empty answer, and marks the turn busy", () => {
  const s = run(ask);
  assert.equal(s.turns.length, 2);
  assert.deepEqual(
    s.turns.map((t) => [t.role, t.text]),
    [
      ["user", "Yield on line 4?"],
      ["assistant", ""],
    ],
  );
  assert.equal(s.busy, true);
  assert.equal(s.streamingId, "a1");
});

test("asking clears the failure left by the previous turn", () => {
  const s = run(
    { type: "failed", failure: { code: "faborch_unavailable", message: "down" } },
    ask,
  );
  assert.equal(s.failure, null);
});

test("deltas land in the streaming turn and nowhere else", () => {
  const s = run(ask, { type: "delta", delta: "94." }, { type: "delta", delta: "2%" });
  assert.equal(s.turns[0].text, "Yield on line 4?");
  assert.equal(s.turns[1].text, "94.2%");
});

test("a tool name shows while it runs and clears when the answer starts", () => {
  const working = run(ask, { type: "activity", name: "query_mes" });
  assert.equal(working.activity, "query_mes");

  const answering = reduce(working, { type: "delta", delta: "The" });
  assert.equal(answering.activity, null);
});

/* ── Stopping — the acceptance line for this package ──────────────────────── */

test("stopping mid-answer keeps what already arrived", () => {
  const s = run(ask, { type: "delta", delta: "Line 4 ran at 94.2% " }, { type: "stopped" });
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns[1].text, "Line 4 ran at 94.2% ");
  assert.equal(s.busy, false);
  assert.equal(s.streamingId, null);
});

test("stopping before anything arrived leaves no empty bubble", () => {
  const s = run(ask, { type: "stopped" });
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].role, "user");
});

test("whitespace is not an answer", () => {
  const s = run(ask, { type: "delta", delta: "  \n " }, { type: "stopped" });
  assert.equal(s.turns.length, 1);
});

test("a stream that ends with nothing in it leaves no empty bubble", () => {
  const s = run(ask, { type: "activity", name: "query_mes" }, { type: "settled" });
  assert.equal(s.turns.length, 1);
  assert.equal(s.activity, null);
});

/* ── Failing ─────────────────────────────────────────────────────────────── */

test("a failure before the answer starts drops the placeholder", () => {
  const s = run(ask, { type: "failed", failure: { code: "faborch_unavailable", message: "no" } });
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].role, "user");
  assert.equal(s.failure?.code, "faborch_unavailable");
  assert.equal(s.busy, false);
});

test("a failure part-way through keeps the text that did arrive", () => {
  const s = run(
    ask,
    { type: "delta", delta: "Line 4 ran at " },
    { type: "failed", failure: { code: "faborch_unavailable", message: "stream broke" } },
  );
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns[1].text, "Line 4 ran at ");
  assert.equal(s.failure?.message, "stream broke");
});

test("dismissing a failure leaves the thread alone", () => {
  const s = run(
    ask,
    { type: "delta", delta: "half" },
    { type: "failed", failure: { code: "x", message: "y" } },
    { type: "clearFailure" },
  );
  assert.equal(s.failure, null);
  assert.equal(s.turns.length, 2);
});

/* ── Following up ────────────────────────────────────────────────────────── */

test("a follow-up carries the whole thread, and not the empty placeholder", () => {
  const first = run(ask, { type: "delta", delta: "94.2%" }, { type: "settled" });
  const history = historyFor(first.turns, "And line 5?", "u2");

  assert.deepEqual(
    history.map((t) => [t.role, t.text]),
    [
      ["user", "Yield on line 4?"],
      ["assistant", "94.2%"],
      ["user", "And line 5?"],
    ],
  );
});

test("the posted history omits an answer that was stopped before it began", () => {
  const stopped = run(ask, { type: "stopped" });
  const history = historyFor(stopped.turns, "Try again?", "u2");
  assert.equal(history.length, 2);
  assert.ok(history.every((t) => t.text.trim().length > 0));
});

test("the wire shape is one text part per turn", () => {
  assert.deepEqual(toFoMessages([{ id: "u1", role: "user", text: "hi" }]), [
    { role: "user", parts: [{ type: "text", text: "hi" }] },
  ]);
});

test("what the reducer produces is what the route accepts", () => {
  const s = run(ask, { type: "delta", delta: "94.2%" }, { type: "settled" });
  const body = { messages: toFoMessages(historyFor(s.turns, "And line 5?", "u2")) };
  assert.equal(FabInsightRequestSchema.safeParse(body).success, true);
});

test("resetting empties the thread", () => {
  const s = run(ask, { type: "delta", delta: "94.2%" }, { type: "settled" }, { type: "reset" });
  assert.deepEqual(s, EMPTY_CONVERSATION);
});

/* ── Capacity ────────────────────────────────────────────────────────────── */

const turns = (count: number): Turn[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: "x",
  }));

test("the limits stated here are the limits the route enforces", () => {
  // The two are deliberately not imported from one another — this asserts they
  // agree, which is the part that keeps them honest. Asserted by asking the
  // real schema, on the boundary, rather than by reading zod's internals: the
  // question is what the route accepts, not how zod stores the number.
  const body = (count: number, text = "x") => ({
    messages: toFoMessages(turns(count).map((t) => ({ ...t, text }))),
  });

  assert.equal(FabInsightRequestSchema.safeParse(body(MAX_MESSAGES)).success, true);
  assert.equal(FabInsightRequestSchema.safeParse(body(MAX_MESSAGES + 1)).success, false);

  assert.equal(FabInsightRequestSchema.safeParse(body(1, "x".repeat(MAX_TEXT))).success, true);
  assert.equal(FabInsightRequestSchema.safeParse(body(1, "x".repeat(MAX_TEXT + 1))).success, false);
});

test("a thread with room takes another question", () => {
  assert.equal(capacityIssue(turns(MAX_MESSAGES - 1), "one more"), null);
});

test("a full thread is refused before the request is made", () => {
  // MAX_MESSAGES turns plus the new question is one over the route's limit.
  assert.deepEqual(capacityIssue(turns(MAX_MESSAGES), "one more"), { kind: "thread-full" });
});

test("the refusal is what a supervisor reads, not a schema library's words", () => {
  const failure = capacityFailure({ kind: "thread-full" });
  assert.equal(failure.code, "conversation_full");
  assert.match(failure.message, /Start a new one/);
  assert.doesNotMatch(failure.message, /expected array|<=|zod/i);
});

test("an over-long question is caught before it costs a round trip", () => {
  assert.deepEqual(capacityIssue([], "x".repeat(MAX_TEXT + 1)), { kind: "question-too-long" });
  assert.equal(capacityIssue([], "x".repeat(MAX_TEXT)), null);
});

test("an over-long answer already in the thread blocks the follow-up, not the answer", () => {
  const long: Turn[] = [
    { id: "u1", role: "user", text: "table please" },
    { id: "a1", role: "assistant", text: "x".repeat(MAX_TEXT + 1) },
  ];
  assert.deepEqual(capacityIssue(long, "and now?"), { kind: "answer-too-long" });
  assert.match(capacityFailure({ kind: "answer-too-long" }).message, /new conversation/);
});

test("every capacity refusal names a next step", () => {
  for (const kind of ["thread-full", "question-too-long", "answer-too-long"] as const) {
    const { code, message } = capacityFailure({ kind });
    assert.ok(code.length > 0, kind);
    assert.match(message, /Start a new|Shorten it/, kind);
  }
});
