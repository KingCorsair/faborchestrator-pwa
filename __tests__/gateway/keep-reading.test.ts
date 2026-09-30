/**
 * The stopgap's slots (`lib/gateway/keep-reading.ts`): at most
 * `KEEP_READING_MAX_STREAMS` chat answers are read on the phone's behalf at
 * once, every slot comes back however the answer ends, and the phone's half of
 * the answer is byte-for-byte what FabOrchestrator sent. The behaviour through
 * the route (the phone leaving, the deadlines) is pinned in `deadline.test.ts`.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  claimTurn,
  keepReadingKey,
  keepReadingMaxStreams,
  keptReadingCount,
  reserveKeepReading,
  supersedeKeptReading,
} from "@/lib/gateway/keep-reading";

afterEach(() => {
  delete process.env.KEEP_READING_MAX_STREAMS;
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function streamOf(chunks: string[], fail = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (fail) controller.error(new Error("FabOrchestrator went away"));
      else controller.close();
    },
  });
}

describe("the slots", () => {
  test("50 by default, overridable, never negative", () => {
    assert.equal(keepReadingMaxStreams({}), 50);
    assert.equal(keepReadingMaxStreams({ KEEP_READING_MAX_STREAMS: "3" }), 3);
    assert.equal(keepReadingMaxStreams({ KEEP_READING_MAX_STREAMS: "0" }), 0);
    assert.equal(keepReadingMaxStreams({ KEEP_READING_MAX_STREAMS: "-1" }), 50);
    assert.equal(keepReadingMaxStreams({ KEEP_READING_MAX_STREAMS: "lots" }), 50);
  });

  test("past the limit there is no slot, and a released one is available again", () => {
    process.env.KEEP_READING_MAX_STREAMS = "2";
    const before = keptReadingCount();
    const a = reserveKeepReading();
    const b = reserveKeepReading();
    assert.ok(a && b);
    assert.equal(reserveKeepReading(), null);
    a!.release();
    a!.release(); // idempotent
    const c = reserveKeepReading();
    assert.ok(c);
    b!.release();
    c!.release();
    assert.equal(keptReadingCount(), before);
  });

  test("the slot comes back when the answer ends, cleanly or not", async () => {
    const before = keptReadingCount();
    for (const fail of [false, true]) {
      const slot = reserveKeepReading()!;
      const phone = new AbortController();
      const forPhone = slot.keepReading(streamOf(["a", "b"], fail), { pathname: "/api/chat", phone: phone.signal });
      phone.abort();
      void forPhone.cancel();
      await flush();
      assert.equal(keptReadingCount(), before, fail ? "after an error" : "after a clean end");
    }
  });
});

describe("the phone's half", () => {
  test("is exactly what FabOrchestrator sent", async () => {
    const slot = reserveKeepReading()!;
    const forPhone = slot.keepReading(streamOf(["data: 1\n\n", "data: 2\n\n"]), {
      pathname: "/api/chat",
      phone: new AbortController().signal,
    });
    assert.equal(await new Response(forPhone).text(), "data: 1\n\ndata: 2\n\n");
  });
});

describe("a new turn in the same conversation stops the previous read (review, 30 September)", () => {
  test("the previous answer is no longer read, so it cannot be saved after the new question", async () => {
    process.env.KEEP_READING_MAX_STREAMS = "5";
    const before = keptReadingCount();
    let sourceCancelled = false;
    // An answer FabOrchestrator is still writing: it never ends by itself.
    const answer = new ReadableStream<Uint8Array>({
      pull() {
        /* nothing more yet */
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const info: string[] = [];
    const realInfo = console.info;
    console.info = (...a: unknown[]) => info.push(a.map(String).join(" "));
    try {
      const key = keepReadingKey("fo-token", "11111111-1111-4111-8111-111111111111");
      const phone = new AbortController();
      const slot = reserveKeepReading()!;
      const claim = claimTurn(key, () => {});
      const forPhone = slot.keepReading(answer, { pathname: "/api/chat", phone: phone.signal, claim });
      // The operator pressed Stop (or minimised): the phone's half is gone.
      phone.abort();
      void forPhone.cancel();
      await flush();
      assert.equal(sourceCancelled, false, "still being read on the phone's behalf");

      supersedeKeptReading(key); // the next question in that conversation
      await flush();
      assert.equal(sourceCancelled, true, "FabOrchestrator's answer is no longer read to its end");
      assert.equal(keptReadingCount(), before, "the slot came back");
      const line = info.find((l) => l.includes('"event":"answer_kept_reading"'));
      assert.match(line ?? "", /"outcome":"superseded"/);
      assert.ok(!(line ?? "").includes("fo-token"), "never the token");
    } finally {
      console.info = realInfo;
    }
  });

  test("a turn claimed before FabOrchestrator answered is stopped by the next turn's claim (review, issue 3)", () => {
    // The first version registered a turn only once FO's headers had arrived,
    // so a turn stopped during FO's think time was invisible to the next one.
    const key = keepReadingKey("fo-token", "44444444-4444-4444-8444-444444444444");
    const aborted: string[] = [];
    const a = claimTurn(key, () => aborted.push("a"));
    assert.equal(aborted.length, 0, "nothing to stop yet");
    const b = claimTurn(key, () => aborted.push("b"));
    assert.deepEqual(aborted.slice(), ["a"], "claiming B stopped A, though A had no stream yet");
    assert.equal(a.superseded, true);
    assert.equal(b.superseded, false);
    a.release(); // A ending late must not drop B's registration
    supersedeKeptReading(key); // a third turn
    assert.deepEqual(aborted, ["a", "b"]);
    assert.equal(b.superseded, true);
    b.release();
    assert.doesNotThrow(() => supersedeKeptReading(key));
  });

  test("a read attached to an already superseded claim is cancelled at once", async () => {
    const key = keepReadingKey("fo-token", "55555555-5555-4555-8555-555555555555");
    let sourceCancelled = false;
    const answer = new ReadableStream<Uint8Array>({ pull() {}, cancel() { sourceCancelled = true; } });
    const late = claimTurn(key, () => {});
    claimTurn(key, () => {}).release(); // the newer turn came and went
    const slot = reserveKeepReading()!;
    const before = keptReadingCount();
    void slot.keepReading(answer, { pathname: "/api/chat", phone: new AbortController().signal, claim: late }).cancel();
    await flush();
    assert.equal(sourceCancelled, true, "FabOrchestrator's late answer is not read to its end");
    assert.equal(keptReadingCount(), before - 1, "the slot came back");
  });

  test("a key names one session's conversation, never the token", () => {
    const key = keepReadingKey("fo-token", "c1");
    assert.ok(key.endsWith(":c1"));
    assert.ok(!key.includes("fo-token"));
    assert.notEqual(key, keepReadingKey("another-token", "c1"));
  });

  test("superseding a conversation with nothing being read does nothing", () => {
    assert.doesNotThrow(() => supersedeKeptReading("nobody:nothing"));
  });
});
