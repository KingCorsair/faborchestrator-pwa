/**
 * The upstream body ceiling (`lib/gateway/body-limit.ts`), WP5.
 *
 * Uploads stream through the gateway rather than being buffered, so the
 * ceiling has to work two ways: refuse a request that declares itself too
 * large before anything leaves, and stop a chunked one that grows past the
 * limit while it is already in flight. Without the second, the first is only a
 * suggestion — anything sent chunked would sail past it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BodyTooLargeError,
  declaredLength,
  declaredTooLarge,
  limitBody,
  MAX_UPSTREAM_BODY_BYTES,
} from "@/lib/gateway/body-limit";

/** A body delivered in `count` chunks of `size` bytes. */
function streamOf(count: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  return total;
}

describe("the declared length", () => {
  test("matches FabOrchestrator's own nginx ceiling", () => {
    // Raising one without the other only moves where the refusal comes from.
    assert.equal(MAX_UPSTREAM_BODY_BYTES, 50 * 1024 * 1024);
  });

  test("an ordinary upload is allowed through", () => {
    const headers = new Headers({ "content-length": String(5 * 1024 * 1024) });
    assert.equal(declaredTooLarge(headers), false);
  });

  test("one over the ceiling is refused", () => {
    const headers = new Headers({ "content-length": String(MAX_UPSTREAM_BODY_BYTES + 1) });
    assert.equal(declaredTooLarge(headers), true);
  });

  test("exactly at the ceiling is allowed", () => {
    const headers = new Headers({ "content-length": String(MAX_UPSTREAM_BODY_BYTES) });
    assert.equal(declaredTooLarge(headers), false);
  });

  test("a chunked request declares nothing, and is not refused on that basis", () => {
    // It is the counting stream's job to stop this one, not this check's.
    assert.equal(declaredLength(new Headers()), null);
    assert.equal(declaredTooLarge(new Headers()), false);
  });

  test("a nonsense length is treated as absent rather than as zero", () => {
    for (const v of ["not-a-number", "-1", ""]) {
      assert.equal(declaredLength(new Headers({ "content-length": v })), null, v);
    }
  });
});

describe("counting the body as it streams", () => {
  test("a body under the ceiling passes through byte for byte", async () => {
    const total = await drain(limitBody(streamOf(4, 1024), 8 * 1024));
    assert.equal(total, 4 * 1024);
  });

  test("a body exactly at the ceiling still passes", async () => {
    const total = await drain(limitBody(streamOf(4, 1024), 4 * 1024));
    assert.equal(total, 4 * 1024);
  });

  test("a chunked body that outgrows the ceiling errors the stream", async () => {
    // The case the declared-length check cannot see.
    await assert.rejects(
      () => drain(limitBody(streamOf(10, 1024), 4 * 1024)),
      (error: unknown) => error instanceof BodyTooLargeError,
    );
  });

  test("it stops partway rather than reading the whole body first", async () => {
    let produced = 0;
    const counted = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array(1024));
        if (produced > 1000) controller.close();
      },
    });
    await assert.rejects(() => drain(limitBody(counted, 4 * 1024)));
    // Not held in memory and not drained to the end: a handful of chunks in,
    // the stream is already refused.
    assert.ok(produced < 20, `read ${produced} chunks before stopping`);
  });
});
