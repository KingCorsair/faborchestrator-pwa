/**
 * The stored-conversation mapper.
 *
 * This is the module that decides what a phone receives when somebody taps a
 * thread in the drawer, so its tests are mostly about what it **refuses** to
 * pass on. The shapes below are FabOrchestrator's own, taken from
 * `lib/storage.ts:556-622` (`toUIMessage`) and from a live read of a production
 * thread on 5 September — `text`, `step-start`, `tool-*` and `file-download`
 * parts, interleaved in the order the stream produced them.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toTurns, toSummaries, isContinuable } from "../../lib/faborch/history";
import { MAX_TEXT } from "../../lib/faborch/conversation";

/** A real assistant message from FO: text, split by tool work, with markers. */
const realAssistantMessage = {
  id: "m-1",
  role: "assistant",
  content: "There are 237 lots currently in WIP.",
  parts: [
    { type: "step-start" },
    { type: "text", text: "Let me check the material lifecycle view.\n\n" },
    {
      type: "tool-mcp_query",
      toolCallId: "t-1",
      toolName: "mcp_query",
      input: { sql: "SELECT COUNT(*) FROM Bottleneck_MCP.vw_MaterialLifecycleStatus WHERE …" },
      output: { rows: [{ n: 237 }] },
      state: "output-available",
    },
    { type: "step-start" },
    { type: "text", text: "There are **237** lots currently in WIP." },
  ],
};

describe("what reaches the phone", () => {
  test("the text survives, in order", () => {
    const turns = toTurns([realAssistantMessage]);
    assert.equal(turns.length, 1);
    assert.equal(
      turns[0].text,
      "Let me check the material lifecycle view.\n\nThere are **237** lots currently in WIP.",
    );
  });

  test("no tool part survives", () => {
    const turns = toTurns([realAssistantMessage]);
    // The SQL is the single biggest thing in a stored thread and the one this
    // app has never rendered. If it ever appears here, the payload measurement
    // that justified proxy-side stripping has stopped being true.
    assert.ok(!turns[0].text.includes("SELECT"));
    assert.ok(!turns[0].text.includes("mcp_query"));
    assert.ok(!turns[0].text.includes("237 }"));
  });

  test("a turn carries no fields beyond id, role and text", () => {
    const turns = toTurns([realAssistantMessage]);
    assert.deepEqual(Object.keys(turns[0]).sort(), ["id", "role", "text"]);
  });

  test("unknown part types are dropped, not passed through", () => {
    // `toUIMessage` returns unrecognised parts verbatim, so a part type added
    // to FabOrchestrator tomorrow arrives here. Rejecting by default is what
    // stops it reaching a screen that has never heard of it.
    const turns = toTurns([
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Here it is." },
          { type: "some-future-part", text: "SHOULD NOT APPEAR" },
          { type: "file-download", url: "https://s3…/expired", filename: "wip.csv" },
          { type: "reasoning", text: "SHOULD NOT APPEAR EITHER" },
        ],
      },
    ]);
    assert.equal(turns[0].text, "Here it is.");
  });

  test("a turn that was only tool calls is dropped, not shown blank", () => {
    const turns = toTurns([
      { role: "assistant", content: "", parts: [{ type: "tool-mcp_query", input: {} }] },
    ]);
    assert.deepEqual(turns, []);
  });

  test("tool roles are dropped", () => {
    // FO's MessageInput allows "tool"; a transcript that shows no tools has no
    // place for one.
    const turns = toTurns([
      { role: "tool", content: "rows", parts: [{ type: "text", text: "rows" }] },
      { role: "user", content: "hi", parts: [{ type: "text", text: "hi" }] },
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].role, "user");
  });
});

describe("older and stranger rows", () => {
  test("a message with only `content` still renders", () => {
    const turns = toTurns([{ id: "x", role: "user", content: "How many lots?" }]);
    assert.equal(turns[0].text, "How many lots?");
  });

  test("empty parts fall back to content", () => {
    const turns = toTurns([{ role: "assistant", content: "Fallback.", parts: [] }]);
    assert.equal(turns[0].text, "Fallback.");
  });

  test("a missing id still yields a stable, unique one", () => {
    const turns = toTurns([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    assert.notEqual(turns[0].id, turns[1].id);
  });

  test("junk in, empty out — never a throw", () => {
    for (const junk of [null, undefined, 42, "messages", {}, [null], [{ role: 9 }], [[]]]) {
      assert.doesNotThrow(() => toTurns(junk));
      assert.ok(Array.isArray(toTurns(junk)));
    }
  });
});

describe("the list rows the drawer shows", () => {
  test("the fields the drawer needs, and no others", () => {
    const rows = toSummaries([
      {
        id: "c-1",
        title: "How many lots are currently in WIP?",
        isPinned: true,
        isShared: true,
        model: "claude-opus-4-8",
        agent: "chat",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-04T21:08:00.000Z",
        lastMessage: null,
      },
    ]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "isPinned", "title", "updatedAt"]);
    // `isShared` points at FO's /share/<id>, a page that exists in no upstream
    // branch. It must not travel to a screen that might offer it.
    assert.ok(!JSON.stringify(rows).includes("isShared"));
  });

  test("a row with no id is dropped — it could not be opened", () => {
    assert.equal(toSummaries([{ title: "orphan" }, { id: "ok", title: "t" }]).length, 1);
  });

  test("an untitled row is labelled, not blank", () => {
    assert.equal(toSummaries([{ id: "a", title: "   " }])[0].title, "Untitled");
  });

  test("junk in, empty out", () => {
    for (const junk of [null, 7, {}, "rows"]) {
      assert.deepEqual(toSummaries(junk), []);
    }
  });
});

describe("whether a loaded thread can be continued", () => {
  test("an ordinary thread can", () => {
    assert.ok(isContinuable(toTurns([realAssistantMessage]), MAX_TEXT));
  });

  test("a thread with an answer over the cap cannot", () => {
    // The composer is disabled and the screen says why, rather than letting the
    // route reject it with "Too big: expected array to have <=100 items".
    const huge = { role: "assistant", content: "x".repeat(MAX_TEXT + 1) };
    assert.equal(isContinuable(toTurns([huge]), MAX_TEXT), false);
  });

  test("exactly at the cap is still continuable", () => {
    const atCap = { role: "assistant", content: "x".repeat(MAX_TEXT) };
    assert.ok(isContinuable(toTurns([atCap]), MAX_TEXT));
  });
});
