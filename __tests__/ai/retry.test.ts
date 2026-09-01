/**
 * The corrective-retry loop.
 *
 * This is the branch that had never executed. Grounding validation was well
 * tested and both rendered outcomes were checked, but the code that appends a
 * rejected `tool_use`, replies with an `is_error` `tool_result`, and asks again
 * had only ever been typechecked — and a retry loop that is wrong is wrong in
 * the most expensive way possible: it burns a second round trip on a shop floor
 * and returns something worse than the first answer.
 *
 * Provoking it against the real API is neither deterministic nor free — you
 * cannot ask a model to please miscite a record — so `analyzeOrder` takes an
 * injected client and these tests drive it with scripted responses.
 *
 * Run: npm run test:ai
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { analyzeOrder, type MessageCreator } from "../../lib/ai/analyze";
import { cachedAnalysisFor } from "../../lib/ai/fallback";
import { ANALYSIS_TOOL_NAME, type Analysis } from "../../lib/ai/schema";
import { detectIssues } from "../../lib/mes/issues";
import { MockMESAdapter } from "../../lib/mes/mock-adapter";
import type { OrderDetail } from "../../lib/mes/types";

const mes = new MockMESAdapter();

async function scenario(): Promise<{ order: OrderDetail; issues: ReturnType<typeof detectIssues> }> {
  const order = await mes.getOrder("PO-10382");
  assert.ok(order);
  return { order, issues: detectIssues(order) };
}

function good(): Analysis {
  return JSON.parse(JSON.stringify(cachedAnalysisFor("PO-10382"))) as Analysis;
}

/** The same analysis with one citation's value changed to something the MES does not hold. */
function withBadValue(): Analysis {
  const analysis = good();
  analysis.issues[0].evidence[0].value = "999999";
  return analysis;
}

/** A message carrying a forced tool call, as the API returns one. */
function toolUseMessage(input: unknown, id = "toolu_test"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    content: [{ type: "tool_use", id, name: ANALYSIS_TOOL_NAME, input }] as Anthropic.ContentBlock[],
  } as Anthropic.Message;
}

/**
 * A client that returns a scripted response per call and records what it was
 * sent. The recording is the point: a retry that does not carry the correction
 * is just a re-roll.
 */
function scriptedClient(responses: Anthropic.Message[]): {
  client: MessageCreator;
  calls: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (params) => {
          calls.push(params);
          const next = responses[calls.length - 1];
          assert.ok(next, `client called ${calls.length} times, only ${responses.length} scripted`);
          return next;
        },
      },
    },
  };
}

describe("corrective retry", () => {
  it("does not retry when the first answer is grounded", async () => {
    const { order, issues } = await scenario();
    const { client, calls } = scriptedClient([toolUseMessage(good())]);

    const result = await analyzeOrder(order, issues, client);

    assert.equal(calls.length, 1, "a grounded answer must not cost a second round trip");
    assert.equal(result.attempts, 1);
    assert.equal(result.source, "live");
    assert.equal(result.grounding.grounded, true);
  });

  it("retries an ungrounded answer and returns the corrected one", async () => {
    const { order, issues } = await scenario();
    const { client, calls } = scriptedClient([
      toolUseMessage(withBadValue()),
      toolUseMessage(good()),
    ]);

    const result = await analyzeOrder(order, issues, client);

    assert.equal(calls.length, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.source, "live");
    assert.equal(result.grounding.grounded, true, "the corrected answer must pass");
    assert.deepEqual(result.grounding.problems, []);
  });

  it("sends the rejection as a tool_result naming the real value", async () => {
    // The correction has to carry the truth. A retry that says only "try again"
    // gets a differently-wrong answer about as often as a right one.
    const { order, issues } = await scenario();
    const { client, calls } = scriptedClient([
      toolUseMessage(withBadValue()),
      toolUseMessage(good()),
    ]);

    await analyzeOrder(order, issues, client);

    const second = calls[1].messages;
    assert.equal(second.length, 3, "user turn, rejected assistant turn, tool_result turn");
    assert.equal(second[1].role, "assistant");

    const toolResultTurn = second[2];
    assert.equal(toolResultTurn.role, "user");
    const blocks = toolResultTurn.content as Anthropic.ContentBlockParam[];
    const toolResult = blocks.find((b) => b.type === "tool_result");
    assert.ok(toolResult, "the reply to a tool_use must be a tool_result");

    const block = toolResult as Anthropic.ToolResultBlockParam;
    assert.equal(block.tool_use_id, "toolu_test", "must answer the call it rejected");
    assert.equal(block.is_error, true);

    const text = String(block.content);
    assert.match(text, /999999/, "names what was claimed");
    assert.match(text, /is "56"/, "carries what the record actually holds");
  });

  it("flags a second ungrounded answer rather than hiding it", async () => {
    // Shown without the badge, not swallowed. Hiding it would leave the
    // supervisor with nothing and teach the room that the badge is decoration.
    const { order, issues } = await scenario();
    const { client, calls } = scriptedClient([
      toolUseMessage(withBadValue()),
      toolUseMessage(withBadValue()),
    ]);

    const result = await analyzeOrder(order, issues, client);

    assert.equal(calls.length, 2, "exactly one correction, never a third attempt");
    assert.equal(result.attempts, 2);
    assert.equal(result.source, "live", "still the live answer, not the cache");
    assert.equal(result.grounding.grounded, false);
    assert.equal(result.grounding.problems.length, 1);
    assert.equal(result.grounding.problems[0].fault, "value_mismatch");
    assert.equal(result.grounding.problems[0].actual, "56");
  });

  it("keeps the better of two ungrounded answers", async () => {
    const { order, issues } = await scenario();
    const worse = withBadValue();
    worse.recommendation.evidence[0].record_id = "EVT-0000";

    const { client } = scriptedClient([toolUseMessage(worse), toolUseMessage(withBadValue())]);
    const result = await analyzeOrder(order, issues, client);

    assert.equal(result.grounding.problems.length, 1, "the second answer had fewer problems");
  });

  it("retries schema-invalid output, then falls back to cache if it fails twice", async () => {
    const { order, issues } = await scenario();
    const { client, calls } = scriptedClient([
      toolUseMessage({ nonsense: true }),
      toolUseMessage({ still: "wrong" }),
    ]);

    const result = await analyzeOrder(order, issues, client);

    assert.equal(calls.length, 2);
    assert.equal(result.source, "cached", "no analysis to flag, so fall back");
    assert.equal(result.degraded?.reason, "invalid_output");
    assert.equal(result.grounding.grounded, true, "the cached analysis is itself checked");
  });

  it("recovers when the first answer is schema-invalid and the second is not", async () => {
    const { order, issues } = await scenario();
    const { client } = scriptedClient([toolUseMessage({ nonsense: true }), toolUseMessage(good())]);

    const result = await analyzeOrder(order, issues, client);

    assert.equal(result.source, "live");
    assert.equal(result.attempts, 2);
    assert.equal(result.grounding.grounded, true);
  });

  it("does not retry when the model returns no tool call at all", async () => {
    // Forced tool use that did not happen is structural. Asking again the same
    // way is not a fix, so it degrades immediately rather than paying twice.
    const { order, issues } = await scenario();
    const refusal = {
      ...toolUseMessage(good()),
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I cannot help with that." }],
    } as unknown as Anthropic.Message;

    const { client, calls } = scriptedClient([refusal]);
    const result = await analyzeOrder(order, issues, client);

    assert.equal(calls.length, 1);
    assert.equal(result.source, "cached");
    assert.equal(result.degraded?.reason, "invalid_output");
  });
});
