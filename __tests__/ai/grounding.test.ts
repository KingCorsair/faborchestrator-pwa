/**
 * Grounding validation tests.
 *
 * The badge is the product's central claim — "everything the AI put on screen
 * came from the MES" — so these tests are about the ways a wrong answer could
 * still earn it. Each one takes the known-good cached analysis and breaks
 * exactly one thing.
 *
 * The third case is the one that matters. A citation naming a real record and a
 * real field, with the wrong number beside it, is invisible to a supervisor
 * reading the screen: "EVT-2231 durationMinutes 24" is as authoritative-looking
 * as "EVT-2231 durationMinutes 42". If the validator does not compare values,
 * the badge means nothing and is worse than absent.
 *
 * Run: npm run test:ai
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cachedAnalysisFor } from "../../lib/ai/fallback";
import { groundingFeedback, validateGrounding } from "../../lib/ai/grounding";
import type { Analysis } from "../../lib/ai/schema";
import { detectIssues } from "../../lib/mes/issues";
import { MockMESAdapter } from "../../lib/mes/mock-adapter";
import type { IssueType } from "../../lib/mes/rules-config";
import type { OrderDetail } from "../../lib/mes/types";

const mes = new MockMESAdapter();

async function scenario(): Promise<{
  order: OrderDetail;
  fired: IssueType[];
  analysis: Analysis;
}> {
  const order = await mes.getOrder("PO-10382");
  assert.ok(order, "PO-10382 is the demo scenario order and must exist");
  const analysis = cachedAnalysisFor("PO-10382");
  assert.ok(analysis, "the cached analysis for PO-10382 must exist");
  return { order, fired: detectIssues(order).map((i) => i.type), analysis };
}

/** A deep copy, so one test's mutation cannot leak into the next. */
function clone(analysis: Analysis): Analysis {
  return JSON.parse(JSON.stringify(analysis)) as Analysis;
}

describe("validateGrounding", () => {
  it("passes the cached analysis against the order it describes", async () => {
    const { order, fired, analysis } = await scenario();
    const report = validateGrounding(order, analysis, fired);

    assert.equal(report.grounded, true, JSON.stringify(report.problems, null, 2));
    assert.ok(report.citationsChecked > 0, "a report over zero citations proves nothing");
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.unfiredIssueTypes, []);
  });

  it("catches a citation to a record that does not exist", async () => {
    const { order, fired, analysis } = await scenario();
    const broken = clone(analysis);
    broken.issues[0].evidence[0].record_id = "EVT-9999";

    const report = validateGrounding(order, broken, fired);
    assert.equal(report.grounded, false);
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].fault, "unknown_record");
    assert.equal(report.problems[0].path, "issues[0].evidence[0]");
  });

  it("catches a real record cited on a field it does not have", async () => {
    const { order, fired, analysis } = await scenario();
    const broken = clone(analysis);
    broken.issues[0].evidence[0].field = "operatorName";

    const report = validateGrounding(order, broken, fired);
    assert.equal(report.grounded, false);
    assert.equal(report.problems[0].fault, "unknown_field");
    assert.equal(report.problems[0].field, "operatorName");
  });

  it("catches a real record and field with the wrong value, and reports the real one", async () => {
    // The invisible failure. Everything about this citation looks right.
    const { order, fired, analysis } = await scenario();
    const broken = clone(analysis);
    const target = broken.issues[0].evidence[0];
    const truth = target.value;
    target.value = `${truth}0`;

    const report = validateGrounding(order, broken, fired);
    assert.equal(report.grounded, false);
    assert.equal(report.problems[0].fault, "value_mismatch");
    assert.equal(report.problems[0].claimed, `${truth}0`);
    assert.equal(report.problems[0].actual, truth, "the screen shows what the MES actually holds");
  });

  it("checks the recommendation's evidence, not only the issues'", async () => {
    const { order, fired, analysis } = await scenario();
    const broken = clone(analysis);
    broken.recommendation.evidence[0].record_id = "DEF-0000";

    const report = validateGrounding(order, broken, fired);
    assert.equal(report.grounded, false);
    assert.equal(report.problems[0].path, "recommendation.evidence[0]");
  });

  it("reports every bad citation, not just the first", async () => {
    const { order, fired, analysis } = await scenario();
    const broken = clone(analysis);
    broken.issues[0].evidence[0].record_id = "EVT-9999";
    broken.recommendation.evidence[0].record_id = "EVT-9998";

    const report = validateGrounding(order, broken, fired);
    assert.equal(report.problems.length, 2, "a report that stops at the first is not an audit");
  });

  it("fails an analysis that explains an issue no rule detected", async () => {
    // Every citation can still resolve — an invented issue with no evidence
    // passes all three citation checks by having nothing to check.
    const { order, analysis } = await scenario();
    const report = validateGrounding(order, analysis, ["MACHINE_DOWNTIME"]);

    assert.equal(report.grounded, false);
    assert.ok(report.unfiredIssueTypes.length > 0);
    assert.equal(report.problems.length, 0, "the citations themselves were fine");
  });

  it("does not fail an analysis that explains fewer issues than fired", async () => {
    // Incomplete, not ungrounded: everything on screen is still true. Reported
    // so it is visible, but the badge is about truth, not coverage.
    const { order, fired, analysis } = await scenario();
    const partial = clone(analysis);
    const dropped = partial.issues.pop();
    assert.ok(dropped, "the scenario order fires more than one rule");

    const report = validateGrounding(order, partial, fired);
    assert.equal(report.grounded, true);
    assert.deepEqual(report.unexplainedIssueTypes, [dropped.type]);
  });

  it("matches record IDs case-insensitively and ignores surrounding whitespace", async () => {
    // A validator that failed on capitalisation would be a bug wearing a
    // grounding failure's clothes — the order route accepts either casing.
    const { order, fired, analysis } = await scenario();
    const shouted = clone(analysis);
    shouted.issues[0].evidence[0].record_id =
      shouted.issues[0].evidence[0].record_id.toLowerCase();
    shouted.issues[0].evidence[0].value = ` ${shouted.issues[0].evidence[0].value} `;

    assert.equal(validateGrounding(order, shouted, fired).grounded, true);
  });

  it("does not accept a value that merely contains the right one", async () => {
    const { order, fired, analysis } = await scenario();
    const padded = clone(analysis);
    padded.issues[0].evidence[0].value = `about ${padded.issues[0].evidence[0].value}`;

    assert.equal(validateGrounding(order, padded, fired).grounded, false);
  });
});

describe("groundingFeedback", () => {
  it("tells the model what the record actually holds", async () => {
    // A retry that only says "try again" gets a differently-wrong answer about
    // as often as a right one. The correction has to carry the truth.
    const { order, fired, analysis } = await scenario();
    const broken = clone(analysis);
    const target = broken.issues[0].evidence[0];
    const truth = target.value;
    target.value = "999999";

    const feedback = groundingFeedback(validateGrounding(order, broken, fired));
    assert.ok(feedback.includes(target.record_id), "names the record");
    assert.ok(feedback.includes(truth), "carries the real value");
    assert.ok(feedback.includes("999999"), "names what was claimed");
  });

  it("names an invented issue type", async () => {
    const { order, analysis } = await scenario();
    const feedback = groundingFeedback(validateGrounding(order, analysis, ["MACHINE_DOWNTIME"]));
    assert.match(feedback, /No rule detected one on this order/);
  });
});
