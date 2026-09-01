/**
 * AI-layer tests.
 *
 * These do not call the API. They test the two things that must hold whether
 * or not a model is reachable: the contract the model is held to, and the
 * cached analysis that stands in when it is not.
 *
 * The grounding assertion below is the one that matters. Tier 2 will validate
 * live model output by exact lookup against `recordIndex`; running that same
 * check against the *cached* analysis now means the fallback can never be the
 * thing that fails it — a saved answer citing a record that does not exist
 * would be worse than no fallback, because it teaches an audience to trust a
 * badge that means nothing.
 *
 * Run: npm run test:ai
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citableRecords } from "../../lib/ai/context";
import { cachedAnalysisFor, cachedOrderNumbers } from "../../lib/ai/fallback";
import { ANALYSIS_BUDGET, ANALYSIS_TOOL_SCHEMA, AnalysisSchema } from "../../lib/ai/schema";
import { detectIssues } from "../../lib/mes/issues";
import { MockMESAdapter } from "../../lib/mes/mock-adapter";

const mes = new MockMESAdapter();

describe("analysis schema", () => {
  it("has no confidence, score, or probability field anywhere", () => {
    // Rule 3, enforced against the contract rather than trusted to review.
    // Severity is arithmetic; a model-supplied number that looked like it
    // would compete with the rules the first time the two disagreed.
    const json = JSON.stringify(ANALYSIS_TOOL_SCHEMA).toLowerCase();
    for (const banned of ["confidence", "probability", "likelihood", "score", "certainty"]) {
      assert.equal(json.includes(banned), false, `tool schema mentions "${banned}"`);
    }
  });

  it("does not let the model assign severity", () => {
    const json = JSON.stringify(ANALYSIS_TOOL_SCHEMA).toLowerCase();
    assert.equal(json.includes('"severity"'), false);
  });

  it("is strict-compatible: every object closed, every property required", () => {
    // `strict: true` is only a guarantee if the schema is actually strict.
    // A generator that quietly drops `additionalProperties` turns the API's
    // guarantee off without failing anything.
    walkObjects(ANALYSIS_TOOL_SCHEMA, (node, path) => {
      assert.equal(
        node.additionalProperties,
        false,
        `${path || "root"} does not set additionalProperties: false`,
      );
      const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>);
      assert.deepEqual(
        [...(node.required as string[])].sort(),
        properties.sort(),
        `${path || "root"} required list does not cover every property`,
      );
    });
  });

  it("asks for exactly one recommended action, not a plan", () => {
    const recommendation = ANALYSIS_TOOL_SCHEMA.properties.recommendation;
    assert.equal(recommendation.type, "object", "a list of actions would be a plan");
    assert.equal(recommendation.properties.action.type, "string");
  });

  it("carries no length constraint strict output would silently drop", () => {
    // Strict structured output supports neither string-length nor array-length
    // constraints. One added here would read as enforcing the budget while
    // enforcing nothing — the failure mode this test exists to prevent. The
    // budget rides in the descriptions, which the model reads, and is checked
    // by Zod afterwards.
    const json = JSON.stringify(ANALYSIS_TOOL_SCHEMA);
    for (const unsupported of ["maxLength", "minLength", "maxItems", "minItems"]) {
      assert.equal(
        json.includes(`"${unsupported}"`),
        false,
        `tool schema sets ${unsupported}, which strict output does not support`,
      );
    }
  });

  it("tells the model the word budget for every prose field", () => {
    // The descriptions are the mechanism that actually shortens the output —
    // the Zod ceilings are a runaway guard sitting well above them. A budget
    // that never reaches the model does nothing.
    const props = ANALYSIS_TOOL_SCHEMA.properties;
    const budgeted: [string, string, number][] = [
      ["summary", props.summary.description, ANALYSIS_BUDGET.summary.words],
      [
        "explanation",
        props.issues.items.properties.explanation.description,
        ANALYSIS_BUDGET.explanation.words,
      ],
      ["action", props.recommendation.properties.action.description, ANALYSIS_BUDGET.action.words],
      [
        "rationale",
        props.recommendation.properties.rationale.description,
        ANALYSIS_BUDGET.rationale.words,
      ],
    ];
    for (const [field, description, words] of budgeted) {
      assert.ok(
        description.includes(`${words} words`),
        `${field}'s description does not state its ${words}-word budget`,
      );
    }
  });

  it("keeps the Zod ceiling above the stated budget, not at it", () => {
    // A ceiling at the target would turn "slightly wordy" into a corrective
    // retry and, twice over, into the whole analysis dropping to the cache.
    // Roughly 6 characters a word, and the ceiling sits clear of that.
    for (const [field, budget] of Object.entries(ANALYSIS_BUDGET)) {
      if (!("words" in budget)) continue;
      assert.ok(
        budget.maxChars > budget.words * 6,
        `${field}'s ${budget.maxChars}-char ceiling is not clear of its ${budget.words}-word budget`,
      );
    }
  });
});

describe("cached fallback", () => {
  it("validates against the same Zod schema live output must pass", () => {
    for (const orderNumber of cachedOrderNumbers()) {
      const result = AnalysisSchema.safeParse(cachedAnalysisFor(orderNumber));
      assert.ok(
        result.success,
        `${orderNumber}: ${result.success ? "" : JSON.stringify(result.error.issues)}`,
      );
    }
  });

  it("exists for the demo scenario order", () => {
    assert.ok(cachedAnalysisFor("PO-10382"), "CLAUDE.md requires one for PO-10382");
    assert.ok(cachedAnalysisFor("po-10382"), "lookup is case-insensitive");
  });

  it("returns null rather than a wrong answer for an uncached order", () => {
    assert.equal(cachedAnalysisFor("PO-10391"), null);
  });

  it("covers every issue the rules actually fire", async () => {
    const order = await mes.getOrder("PO-10382");
    assert.ok(order);

    const fired = detectIssues(order).map((i) => i.type).sort();
    const explained = cachedAnalysisFor("PO-10382")!.issues.map((i) => i.type).sort();

    assert.deepEqual(explained, fired, "the cached analysis has drifted from the rules");
  });

  it("cites only records that exist, with the values they actually hold", async () => {
    // This is Tier 2's grounding validation, run early against the fallback.
    const order = await mes.getOrder("PO-10382");
    assert.ok(order);
    const records = citableRecords(order);

    const analysis = cachedAnalysisFor("PO-10382")!;
    const allRefs = [
      ...analysis.issues.flatMap((i) => i.evidence),
      ...analysis.recommendation.evidence,
    ];
    assert.ok(allRefs.length > 0);

    for (const ref of allRefs) {
      const record = records[ref.record_id];
      assert.ok(record, `cited ${ref.record_id}, which is not a citable record on this order`);
      assert.ok(
        ref.field in record,
        `${ref.record_id} has no field ${ref.field} (has: ${Object.keys(record).join(", ")})`,
      );
      assert.equal(
        record[ref.field],
        ref.value,
        `${ref.record_id}.${ref.field} holds "${record[ref.field]}", not "${ref.value}"`,
      );
    }
  });
});

describe("citableRecords", () => {
  it("exposes every record the rules can cite", async () => {
    const order = await mes.getOrder("PO-10382");
    assert.ok(order);
    const records = citableRecords(order);

    for (const id of ["PO-10382", "OPR-10382-30", "EVT-2231", "DEF-0417", "DEF-0418"]) {
      assert.ok(records[id], `${id} is missing from the citable set`);
    }
  });

  it("flattens nested objects one level so their fields are citable", async () => {
    const order = await mes.getOrder("PO-10382");
    assert.ok(order);
    const record = citableRecords(order)["PO-10382"];

    assert.equal(record["product.name"], "Widget A");
    assert.equal(record["product.baselineDefectRate"], "0.02");
    // Arrays are dropped — "downtimeEvents" is not a value anyone can cite;
    // its members are citable in their own right.
    assert.equal("downtimeEvents" in record, false);
  });
});

interface SchemaNode {
  additionalProperties?: unknown;
  properties?: unknown;
  required?: unknown;
}

/** Visits every object node in a JSON Schema that declares `properties`. */
function walkObjects(
  node: unknown,
  visit: (node: SchemaNode, path: string) => void,
  path = "",
) {
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;

  if (record.type === "object" && record.properties) {
    visit(record as SchemaNode, path);
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
      walkObjects(child, visit, path ? `${path}.${key}` : key);
    }
  }
  if (record.type === "array" && record.items) {
    walkObjects(record.items, visit, `${path}[]`);
  }
}
