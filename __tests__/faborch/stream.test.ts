/**
 * The FabInsight stream parser.
 *
 * ── What these tests are actually protecting ────────────────────────────────
 * This app reads FabOrchestrator's reply by hand rather than through
 * `@ai-sdk/react`'s `useChat` (see `lib/faborch/stream.ts` for why). The cost of
 * that decision is that the frame names are knowledge held here rather than in
 * the SDK — so if FO upgrades `ai` and `text-delta` becomes something else, the
 * screen goes quiet and nothing errors.
 *
 * **These tests are the alarm for that.** Every frame below is written in the
 * shape `ai@6.0.97`'s `UIMessageChunk` union defines
 * (`claudeai_athena/node_modules/ai/dist/index.d.ts:2127`), which is the version
 * FO ships today. A red test here means the contract moved.
 *
 * The chunk-boundary tests matter for a different reason: a `ReadableStream`
 * hands over whatever arrived, and on a slow connection — which is every phone
 * on a shop floor — that is regularly half a line. A parser that assumed whole
 * frames would drop a token every few hundred milliseconds and nobody would see
 * it as anything but the model writing strangely.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createFoStreamParser, type FoStreamEvent } from "../../lib/faborch/stream";

/** One SSE frame, as `createUIMessageStreamResponse` writes it. */
function frame(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function textOf(events: FoStreamEvent[]): string {
  return events
    .filter((event): event is { type: "text"; delta: string } => event.type === "text")
    .map((event) => event.delta)
    .join("");
}

test("text deltas become text, in order", () => {
  const parser = createFoStreamParser();
  const events = parser.push(
    frame({ type: "start" }) +
      frame({ type: "text-start", id: "0" }) +
      frame({ type: "text-delta", id: "0", delta: "Yield for " }) +
      frame({ type: "text-delta", id: "0", delta: "the last two days" }) +
      frame({ type: "text-end", id: "0" }) +
      frame({ type: "finish" }),
  );

  assert.equal(textOf(events), "Yield for the last two days");
});

test("a frame split across two chunks is not lost", () => {
  const parser = createFoStreamParser();
  const whole = frame({ type: "text-delta", id: "0", delta: "94.2%" });
  const cut = Math.floor(whole.length / 2);

  // The first half completes nothing — the important half of this assertion,
  // because a parser that emitted a truncated frame here would corrupt the
  // answer rather than delay it.
  assert.deepEqual(parser.push(whole.slice(0, cut)), []);
  assert.equal(textOf(parser.push(whole.slice(cut))), "94.2%");
});

test("a delta split mid-word reassembles exactly", () => {
  const parser = createFoStreamParser();
  const stream =
    frame({ type: "text-delta", id: "0", delta: "down" }) +
    frame({ type: "text-delta", id: "0", delta: "time" });

  let out = "";
  for (const char of stream) out += textOf(parser.push(char));
  assert.equal(out, "downtime");
});

test("tool calls are reported by FO's own tool name", () => {
  const parser = createFoStreamParser();
  const events = parser.push(
    frame({ type: "tool-input-start", toolCallId: "call_1", toolName: "query_yield_by_day" }),
  );

  assert.deepEqual(events, [{ type: "tool", name: "query_yield_by_day" }]);
});

test("an error frame carries FO's message through, errorId included", () => {
  const parser = createFoStreamParser();
  const events = parser.push(
    frame({ type: "error", errorText: "Something went wrong. (errorId=FO-4831)" }),
  );

  assert.deepEqual(events, [
    { type: "error", message: "Something went wrong. (errorId=FO-4831)" },
  ]);
});

test("keep-alive frames are silent", () => {
  // FO writes one every 15s so a proxy does not cut a long tool call
  // (`app/api/chat/route.ts:768`). Surfacing them would put a blank event into
  // the conversation four times a minute.
  const parser = createFoStreamParser();
  assert.deepEqual(parser.push(frame({ type: "data-keepalive", data: {} })), []);
});

test("reasoning is not shown", () => {
  // FO asks for it (`sendReasoning: true`) and this screen has no panel for it.
  // Half-rendering thinking into the answer would read as the model talking to
  // itself in the middle of a yield figure.
  const parser = createFoStreamParser();
  const events = parser.push(
    frame({ type: "reasoning-start", id: "r0" }) +
      frame({ type: "reasoning-delta", id: "r0", delta: "The user wants…" }) +
      frame({ type: "reasoning-end", id: "r0" }),
  );

  assert.deepEqual(events, []);
});

test("the [DONE] sentinel and unparseable frames are skipped, not thrown", () => {
  const parser = createFoStreamParser();
  const events = parser.push(
    "data: {not json\n\n" +
      frame({ type: "text-delta", id: "0", delta: "still here" }) +
      "data: [DONE]\n\n",
  );

  // One bad frame must not end an answer that is otherwise arriving fine.
  assert.equal(textOf(events), "still here");
});

test("an empty delta produces no event", () => {
  const parser = createFoStreamParser();
  assert.deepEqual(parser.push(frame({ type: "text-delta", id: "0", delta: "" })), []);
});

test("a tool frame with no name is ignored rather than rendered blank", () => {
  const parser = createFoStreamParser();
  assert.deepEqual(parser.push(frame({ type: "tool-input-start", toolCallId: "c" })), []);
});
