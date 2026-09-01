/**
 * Decision log and override tests.
 *
 * The claim this screen makes is that overriding a decision **adds** to the
 * record rather than replacing it. These tests are about the ways that could
 * quietly stop being true: a superseded decision disappearing, the wrong one
 * being reported as standing, or an override being accepted against a decision
 * somebody has already replaced.
 *
 * The route's own checks are exercised through the schema and the store rather
 * than by booting Next: `DecisionSchema` decides what a client may send, and
 * `currentDecisionFor` decides what "already replaced" means. Those two are the
 * whole of the rule.
 *
 * Run: npm run test:decisions
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentDecisionFor,
  currentDecisions,
  decisionById,
  decisionsFor,
  recordDecision,
  type Decision,
  type DecisionKind,
} from "../../lib/decisions";
import { decisionId, decisionSeq, groupByOrder } from "../../lib/decisions/types";
import { DecisionSchema } from "../../lib/validation";

/**
 * The store is module-scope and shared across this file, so every test uses its
 * own order number rather than resetting it. That also matches how it behaves
 * in the app — decisions accumulate and nothing clears them.
 */
let seq = 0;
function freshOrder(): string {
  return `PO-9${String(++seq).padStart(4, "0")}`;
}

async function decide(
  orderNumber: string,
  decision: DecisionKind,
  extra: Partial<Decision> = {},
): Promise<Decision> {
  return recordDecision({
    orderNumber,
    decision,
    recommendedAction: "Hold the order and inspect the feeder at station 3",
    analysisSource: "live",
    decidedByEmail: "supervisor@example.com",
    ...extra,
  });
}

describe("the decision log", () => {
  it("appends rather than replaces when a decision is overridden", async () => {
    const order = freshOrder();
    const first = await decide(order, "APPROVE");
    const override = await decide(order, "REJECT", {
      note: "Feeder still jammed on the next shift",
      supersedesId: first.id,
      decidedByEmail: "manager@example.com",
    });

    const history = await decisionsFor(order);
    assert.equal(history.length, 2, "the original must survive the override");
    assert.equal(history[0].id, first.id);
    assert.equal(history[0].decision, "APPROVE", "the original decision must be unchanged");
    assert.equal(history[1].id, override.id);
    assert.equal(override.supersedesId, first.id);
  });

  it("reports the newest decision as the one standing", async () => {
    const order = freshOrder();
    await decide(order, "APPROVE");
    const second = await decide(order, "ESCALATE", {
      supersedesId: (await decisionsFor(order))[0].id,
    });

    assert.equal((await currentDecisionFor(order))?.id, second.id);
    assert.equal((await currentDecisionFor(order))?.decision, "ESCALATE");
  });

  it("has no standing decision on an order nobody has decided", async () => {
    assert.equal(await currentDecisionFor(freshOrder()), null);
  });

  it("matches order numbers case-insensitively, as every other lookup does", async () => {
    const order = freshOrder();
    const recorded = await decide(order, "APPROVE");
    assert.equal((await currentDecisionFor(order.toLowerCase()))?.id, recorded.id);
  });

  it("finds a decision by id across orders", async () => {
    const recorded = await decide(freshOrder(), "APPROVE");
    assert.equal((await decisionById(recorded.id))?.id, recorded.id);
    assert.equal(await decisionById("DEC-9999"), null);
  });
});

describe("currentDecisions", () => {
  it("returns one row per order, carrying the trail newest first", async () => {
    const order = freshOrder();
    const first = await decide(order, "APPROVE");
    const second = await decide(order, "REJECT", { supersedesId: first.id });
    const third = await decide(order, "ESCALATE", { supersedesId: second.id });

    const row = (await currentDecisions()).find((entry) => entry.orderNumber === order);
    assert.ok(row, "a decided order must appear exactly once");
    assert.equal(row.current.id, third.id);
    assert.deepEqual(
      row.superseded.map((d) => d.id),
      [second.id, first.id],
      "superseded decisions run newest first",
    );
  });

  it("carries no superseded decisions on an order decided once", async () => {
    const order = freshOrder();
    await decide(order, "APPROVE");
    const row = (await currentDecisions()).find((entry) => entry.orderNumber === order);
    assert.deepEqual(row?.superseded, []);
  });

  it("puts the most recently decided order first", async () => {
    const older = freshOrder();
    const newer = freshOrder();
    await decide(older, "APPROVE");
    await decide(newer, "APPROVE");

    const rows = (await currentDecisions()).map((entry) => entry.orderNumber);
    assert.ok(
      rows.indexOf(newer) < rows.indexOf(older),
      "a manager scanning this list reads the newest first",
    );
  });

  it("counts an overridden order once, not twice", async () => {
    const order = freshOrder();
    const first = await decide(order, "APPROVE");
    await decide(order, "REJECT", { supersedesId: first.id });

    const rows = (await currentDecisions()).filter((entry) => entry.orderNumber === order);
    assert.equal(rows.length, 1);
  });
});

/**
 * Deciding without an analysis — 2026-08-18.
 *
 * The review panel on `/orders` and the ungated card on the order screen both
 * record decisions with no model output behind them. The point of these tests
 * is the *honesty* of the resulting row: the log has to say an analysis was
 * absent, and it must never be possible to end up with a row that implies the
 * model advised something it never said.
 */
describe("a decision taken with no analysis", () => {
  it("is accepted by the schema without a recommendation", async () => {
    const result = DecisionSchema.safeParse({ decision: "APPROVE", analysisSource: "none" });
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  /**
   * The guard that stops "I forgot to send it" from being recorded as "there
   * was nothing to send". Those are different facts and only one of them is
   * true, so the client has to say which.
   */
  it("still requires analysisSource, so an omission is not read as 'none'", async () => {
    const result = DecisionSchema.safeParse({ decision: "APPROVE" });
    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0].path[0], "analysisSource");
  });

  it("rejects a recommendation sent alongside 'none'", async () => {
    const result = DecisionSchema.safeParse({
      decision: "APPROVE",
      analysisSource: "none",
      recommendedAction: "Something no model produced",
    });
    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0].path[0], "recommendedAction");
  });

  it("records a null recommendation rather than a placeholder", async () => {
    const order = freshOrder();
    const decision = await recordDecision({
      orderNumber: order,
      decision: "APPROVE",
      recommendedAction: null,
      analysisSource: "none",
      decidedByEmail: "supervisor@example.com",
    });

    assert.equal(decision.recommendedAction, null);
    assert.equal(decision.analysisSource, "none");
    assert.equal((await currentDecisionFor(order))?.id, decision.id);
  });

  /**
   * An override inherits the advice it answers from the record it replaces. If
   * that record had none, the override must inherit *none* — inheriting a
   * recommendation from nowhere would be the placeholder problem arriving by
   * the back door.
   */
  it("is inherited as 'none' by an override of it", async () => {
    const order = freshOrder();
    const first = await recordDecision({
      orderNumber: order,
      decision: "APPROVE",
      recommendedAction: null,
      analysisSource: "none",
      decidedByEmail: "supervisor@example.com",
    });

    // What the route does in its supersedesId branch: copy both fields off the
    // superseded record rather than trusting the client.
    const superseded = await decisionById(first.id);
    const override = await recordDecision({
      orderNumber: order,
      decision: "REJECT",
      note: "Feeder still jammed",
      recommendedAction: superseded!.recommendedAction,
      analysisSource: superseded!.analysisSource,
      decidedByEmail: "manager@example.com",
      supersedesId: first.id,
    });

    assert.equal(override.recommendedAction, null);
    assert.equal(override.analysisSource, "none");
    assert.equal((await currentDecisionFor(order))?.id, override.id);
    assert.equal((await decisionsFor(order)).length, 2, "the original is still there");
  });
});

/**
 * The two pure functions both stores are built on — Tier 3, 2026-08-19.
 *
 * They are here rather than beside a store because they are the place the two
 * implementations could silently disagree. The in-memory store takes the
 * standing decision by array position and Postgres takes it by `ORDER BY seq`;
 * if `groupByOrder` were written twice, "which decision is in force" would have
 * two definitions and only one of them would be under test. The display id is
 * the same argument: it is derived from a counter in both stores, so a change
 * to the format has to break here rather than in an audit six weeks later.
 */
describe("the shared store vocabulary", () => {
  it("renders a decision id the way the schema expects to read it back", () => {
    assert.equal(decisionId(1), "DEC-0001");
    assert.equal(decisionId(4217), "DEC-4217");
    // Past four digits it stops padding rather than truncating — the id has to
    // stay unique long before it has to stay pretty.
    assert.equal(decisionId(12345), "DEC-12345");
  });

  it("round-trips every id it renders", () => {
    for (const seq of [1, 9, 10, 999, 1000, 12345]) {
      assert.equal(decisionSeq(decisionId(seq)), seq, `seq ${seq}`);
    }
  });

  it("parses an unpadded id, which DecisionIdSchema also accepts", () => {
    assert.equal(decisionSeq("DEC-7"), 7);
    assert.equal(decisionSeq("dec-0007"), 7);
  });

  /**
   * `byId` reaches the database with whatever a client sent. Anything that is
   * not one of our ids has to be rejected before it becomes a query parameter.
   */
  it("refuses anything that is not one of our ids", () => {
    for (const bad of ["", "DEC-", "DEC-0", "DEC-abc", "0007", "DEC-0007x", "'; DROP TABLE"]) {
      assert.equal(decisionSeq(bad), null, JSON.stringify(bad));
    }
  });

  it("takes the last decision on an order as the one standing", () => {
    const rows = [
      row("DEC-0001", "PO-1", "2026-08-19T10:00:00.000Z"),
      row("DEC-0002", "PO-1", "2026-08-19T11:00:00.000Z"),
      row("DEC-0003", "PO-2", "2026-08-19T09:00:00.000Z"),
    ];

    const grouped = groupByOrder(rows);
    const first = grouped.find((entry) => entry.orderNumber === "PO-1");

    assert.equal(first?.current.id, "DEC-0002");
    assert.deepEqual(first?.superseded.map((d) => d.id), ["DEC-0001"]);
    assert.equal(grouped.length, 2, "one row per order, not one per decision");
  });

  it("orders the rows by when each order was last decided", () => {
    const grouped = groupByOrder([
      row("DEC-0001", "PO-OLD", "2026-08-19T08:00:00.000Z"),
      row("DEC-0002", "PO-NEW", "2026-08-19T12:00:00.000Z"),
    ]);

    assert.deepEqual(grouped.map((entry) => entry.orderNumber), ["PO-NEW", "PO-OLD"]);
  });

  /** Case-insensitivity is a property of every lookup in this app. */
  it("groups an order number recorded in two cases as one order", () => {
    const grouped = groupByOrder([
      row("DEC-0001", "PO-10382", "2026-08-19T08:00:00.000Z"),
      row("DEC-0002", "po-10382", "2026-08-19T09:00:00.000Z"),
    ]);

    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].current.id, "DEC-0002");
  });
});

function row(id: string, orderNumber: string, decidedAt: string): Decision {
  return {
    id,
    orderNumber,
    decision: "APPROVE",
    decidedByEmail: "supervisor@example.com",
    decidedAt,
    recommendedAction: null,
    analysisSource: "none",
  };
}

describe("DecisionSchema", () => {
  const firstDecision = {
    decision: "APPROVE",
    recommendedAction: "Hold the order and inspect the feeder",
    analysisSource: "live",
  };

  it("accepts a first decision with the recommendation it answered", async () => {
    assert.equal(DecisionSchema.safeParse(firstDecision).success, true);
  });

  it("rejects a first decision with no recommendation", async () => {
    const result = DecisionSchema.safeParse({ decision: "APPROVE", analysisSource: "live" });
    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0].path[0], "recommendedAction");
  });

  it("accepts an override without a recommendation — the route inherits it", async () => {
    const result = DecisionSchema.safeParse({
      decision: "REJECT",
      note: "Feeder still jammed",
      supersedesId: "DEC-0001",
    });
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it("rejects an override with no reason", async () => {
    const result = DecisionSchema.safeParse({ decision: "REJECT", supersedesId: "DEC-0001" });
    assert.equal(result.success, false, "an override with no reason is unauditable");
    assert.equal(result.error?.issues[0].path[0], "note");
  });

  it("rejects an override whose reason is only whitespace", async () => {
    const result = DecisionSchema.safeParse({
      decision: "REJECT",
      note: "   ",
      supersedesId: "DEC-0001",
    });
    assert.equal(result.success, false);
  });

  it("rejects a malformed decision id", async () => {
    const result = DecisionSchema.safeParse({
      decision: "REJECT",
      note: "Feeder still jammed",
      supersedesId: "'; DROP TABLE decisions;--",
    });
    assert.equal(result.success, false);
  });

  it("ignores a recommendation sent alongside an override", async () => {
    // The route reads `recommendedAction` from the superseded record, never
    // from here — a client that could restate it could put advice in the audit
    // trail the AI never gave. The schema still parses; the route discards it.
    const result = DecisionSchema.safeParse({
      decision: "REJECT",
      note: "Feeder still jammed",
      supersedesId: "DEC-0001",
      recommendedAction: "Something the model never said",
      analysisSource: "cached",
    });
    assert.equal(result.success, true);
  });
});
