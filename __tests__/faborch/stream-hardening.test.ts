/**
 * WP6 — the stream parser under conditions a real network produces.
 *
 * `stream.test.ts` pins the frame *shapes* against `ai@6.0.97`. This suite
 * covers the other half: what happens when those frames arrive badly. The
 * failure being defended against is silent — a parser that drops an answer
 * shows an empty bubble, not an error, and on a phone that reads as the app
 * being broken.
 *
 * The byte-split test is the important one. A chunk boundary lands wherever
 * TCP puts it, and the 2026-09-01 probe measured ten separate arrivals for a
 * single short answer through CloudFront, so mid-frame splits are the norm and
 * not an edge case.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createFoStreamParser, readFoStream, type FoStreamEvent } from "@/lib/faborch/stream";

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** A realistic turn: text, a tool call, more text, then the terminator. */
const TRANSCRIPT =
  frame({ type: "start" }) +
  frame({ type: "start-step" }) +
  frame({ type: "text-start", id: "t0" }) +
  frame({ type: "text-delta", id: "t0", delta: "Yield for " }) +
  frame({ type: "data-keepalive", data: {} }) +
  frame({ type: "tool-input-start", toolId: "c1", toolName: "query_mes" }) +
  frame({ type: "text-delta", id: "t0", delta: "Line 4 is " }) +
  frame({ type: "text-delta", id: "t0", delta: "94.2%." }) +
  frame({ type: "text-end", id: "t0" }) +
  frame({ type: "finish" }) +
  "data: [DONE]\n\n";

const collect = (chunks: string[]): FoStreamEvent[] => {
  const parser = createFoStreamParser();
  return chunks.flatMap((c) => parser.push(c));
};

const EXPECTED: FoStreamEvent[] = [
  { type: "text", delta: "Yield for " },
  { type: "tool", name: "query_mes" },
  { type: "text", delta: "Line 4 is " },
  { type: "text", delta: "94.2%." },
];

describe("chunk boundaries", () => {
  test("the whole transcript in one push", () => {
    assert.deepEqual(collect([TRANSCRIPT]), EXPECTED);
  });

  /**
   * Split at EVERY byte offset. If any single split point loses, duplicates or
   * reorders an event, this fails and names the offset.
   */
  test("splitting at every byte offset produces identical output", () => {
    for (let i = 1; i < TRANSCRIPT.length; i++) {
      const got = collect([TRANSCRIPT.slice(0, i), TRANSCRIPT.slice(i)]);
      assert.deepEqual(got, EXPECTED, `split at offset ${i} changed the output`);
    }
  });

  test("one byte at a time still produces the same events", () => {
    assert.deepEqual(collect([...TRANSCRIPT]), EXPECTED);
  });

  test("a frame split across three chunks is not lost", () => {
    const f = frame({ type: "text-delta", id: "t0", delta: "hello" });
    const a = f.slice(0, 7);
    const b = f.slice(7, 20);
    const c = f.slice(20);
    assert.deepEqual(collect([a, b, c]), [{ type: "text", delta: "hello" }]);
  });
});

describe("frames that must be ignored rather than thrown on", () => {
  const IGNORED = [
    ["envelope: start", { type: "start" }],
    ["envelope: finish-step", { type: "finish-step" }],
    ["keepalive", { type: "data-keepalive", data: {} }],
    ["reasoning", { type: "reasoning-delta", delta: "thinking" }],
    ["tool output", { type: "tool-output-available", toolCallId: "c1", output: {} }],
    ["file download", { type: "data-fileDownload", data: { id: "f1" } }],
    ["a source", { type: "source-url", url: "https://example.test" }],
    ["a type nobody has shipped yet", { type: "quantum-delta", delta: "x" }],
    ["a frame with no type at all", { delta: "orphan" }],
    ["a type that is not a string", { type: 7 }],
    ["text-delta with a non-string delta", { type: "text-delta", delta: { a: 1 } }],
    ["text-delta with an empty delta", { type: "text-delta", delta: "" }],
    ["tool-input-start with no toolName", { type: "tool-input-start", toolId: "c1" }],
  ] as const;

  for (const [name, f] of IGNORED) {
    test(`${name} yields nothing and does not throw`, () => {
      assert.deepEqual(collect([frame(f)]), []);
    });
  }

  test("malformed JSON is skipped without killing the surrounding answer", () => {
    const events = collect([
      frame({ type: "text-delta", delta: "before " }),
      "data: {not json at all}\n\n",
      frame({ type: "text-delta", delta: "after" }),
    ]);
    assert.deepEqual(events, [
      { type: "text", delta: "before " },
      { type: "text", delta: "after" },
    ]);
  });

  test("a comment line and a bare newline are not frames", () => {
    assert.deepEqual(collect([": heartbeat\n\n\n", frame({ type: "text-delta", delta: "x" })]), [
      { type: "text", delta: "x" },
    ]);
  });

  test("[DONE] terminates without emitting an event", () => {
    assert.deepEqual(collect(["data: [DONE]\n\n"]), []);
  });
});

describe("errors carry FabOrchestrator's own words", () => {
  test("errorText is shown as sent, errorId included", () => {
    const events = collect([
      frame({
        type: "error",
        errorText: "The data connection did not respond. (errorId=abc-123)",
      }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.ok((events[0] as { message: string }).message.includes("abc-123"));
  });

  test("an error with no text still says something useful", () => {
    const events = collect([frame({ type: "error" })]);
    assert.equal(events.length, 1);
    const message = (events[0] as { message: string }).message;
    assert.ok(message.length > 0);
    assert.ok(!message.includes("undefined"), message);
  });

  test("an error frame does not discard text that already arrived", () => {
    const events = collect([
      frame({ type: "text-delta", delta: "partial answer" }),
      frame({ type: "error", errorText: "stopped" }),
    ]);
    assert.equal(events[0].type, "text");
    assert.equal(events[1].type, "error");
  });
});

describe("readFoStream over a real ReadableStream", () => {
  const streamOf = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });

  test("delivers events in order as chunks arrive", async () => {
    const seen: FoStreamEvent[] = [];
    await readFoStream(streamOf([TRANSCRIPT]), (e) => seen.push(e));
    assert.deepEqual(seen, EXPECTED);
  });

  test("a multi-byte character split across chunks is not corrupted", async () => {
    // "°" is two bytes in UTF-8; split between them. A decoder without
    // {stream:true} would emit a replacement character here.
    const text = frame({ type: "text-delta", delta: "94.2° C" });
    const bytes = new TextEncoder().encode(text);
    const cut = text.indexOf("°") + 1; // lands inside the two-byte sequence
    const seen: FoStreamEvent[] = [];
    await readFoStream(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes.slice(0, cut));
          c.enqueue(bytes.slice(cut));
          c.close();
        },
      }),
      (e) => seen.push(e),
    );
    assert.deepEqual(seen, [{ type: "text", delta: "94.2° C" }]);
  });

  test("a stream that ends mid-frame simply stops, with no throw", async () => {
    const seen: FoStreamEvent[] = [];
    await readFoStream(
      streamOf([frame({ type: "text-delta", delta: "ok" }) + 'data: {"type":"text-de']),
      (e) => seen.push(e),
    );
    assert.deepEqual(seen, [{ type: "text", delta: "ok" }]);
  });

  test("an empty stream yields nothing", async () => {
    const seen: FoStreamEvent[] = [];
    await readFoStream(streamOf([]), (e) => seen.push(e));
    assert.deepEqual(seen, []);
  });
});
