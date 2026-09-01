/**
 * Rule-layer tests.
 *
 * The rules decide what a supervisor is told is wrong and how badly, so they
 * are the part of this product that has to be provably right — and unlike an
 * LLM's explanation, they are deterministic, so they can be.
 *
 * `node --test` through tsx, matching the repo's existing unit suites
 * (`test:errors`, `test:validation`, `test:ui-spec`). Relative imports rather
 * than the `@/` alias: the alias is a bundler concern and these run outside it.
 *
 * Run: npm run test:mes
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectIssues } from "../../lib/mes/issues";
import { RULE_CONFIG, hoursElapsed, severityForDowntime } from "../../lib/mes/rules-config";
import { MockMESAdapter } from "../../lib/mes/mock-adapter";
import { recordIndex, type OrderDetail } from "../../lib/mes/types";
import type { DetectedIssue } from "../../lib/mes/issues";

function find(issues: DetectedIssue[], type: string): DetectedIssue | undefined {
  return issues.find((i) => i.type === type);
}

const mes = new MockMESAdapter();

async function scenarioOrder(): Promise<OrderDetail> {
  const order = await mes.getOrder("PO-10382");
  assert.ok(order, "PO-10382 must exist — it is the demo scenario");
  return order;
}

describe("severityForDowntime", () => {
  it("puts the CLAUDE.md boundaries where CLAUDE.md puts them", () => {
    // "30–60 min = MEDIUM, >60 = HIGH" — 60 is inside the MEDIUM interval.
    assert.equal(severityForDowntime(29), "LOW");
    assert.equal(severityForDowntime(30), "MEDIUM");
    assert.equal(severityForDowntime(60), "MEDIUM");
    assert.equal(severityForDowntime(61), "HIGH");
  });

  it("reads its boundaries from the config rather than from literals", () => {
    const { mediumMinutes, highMinutes } = RULE_CONFIG.machineDowntime;
    assert.equal(severityForDowntime(mediumMinutes), "MEDIUM");
    assert.equal(severityForDowntime(highMinutes + 1), "HIGH");
  });

  it("treats zero downtime as LOW rather than as a problem", () => {
    assert.equal(severityForDowntime(0), "LOW");
  });
});

describe("detectIssues", () => {
  it("fires all three rules on the scenario order, worst first", async () => {
    const issues = detectIssues(await scenarioOrder());

    // CLAUDE.md's demo scenario: "Three rules fire".
    assert.deepEqual(
      issues.map((i) => i.type).sort(),
      ["MACHINE_DOWNTIME", "PRODUCTION_DELAY", "QUALITY_PROBLEM"],
    );

    const bySeverity = issues.map((i) => i.severity);
    assert.deepEqual(
      [...bySeverity].sort(),
      [...bySeverity].sort(),
      "sanity: severities are comparable",
    );
    assert.equal(issues[0].severity, "HIGH", "the worst issue is listed first");

    const byType = Object.fromEntries(issues.map((i) => [i.type, i]));
    assert.equal(byType.MACHINE_DOWNTIME.severity, "MEDIUM", "42 min is inside the MEDIUM band");
    assert.equal(byType.QUALITY_PROBLEM.severity, "HIGH", "9.0% against a 2% baseline is 4.5x");
    assert.equal(byType.PRODUCTION_DELAY.severity, "MEDIUM", "17.3% behind is under the 25% HIGH bar");
  });

  it("cites evidence that resolves against the order's own records", async () => {
    const order = await scenarioOrder();
    const index = recordIndex(order);
    const issues = detectIssues(order);
    const [issue] = issues;

    assert.ok(issue.evidence.length > 0, "an issue with no evidence cannot be verified");

    for (const reference of issues.flatMap((i) => i.evidence)) {
      const record = index.get(reference.recordId);
      assert.ok(record, `cited ${reference.recordId}, which is not a record on this order`);

      const actual = (record as unknown as Record<string, unknown>)[reference.field];
      assert.notEqual(actual, undefined, `${reference.recordId} has no field ${reference.field}`);
      assert.equal(
        String(actual),
        reference.value,
        `${reference.recordId}.${reference.field} does not hold the cited value`,
      );
    }
  });

  it("sums stoppages rather than taking the longest", async () => {
    const order = await scenarioOrder();
    const twoStoppages: OrderDetail = {
      ...order,
      downtimeEvents: [
        { ...order.downtimeEvents[0], recordId: "EVT-9001", durationMinutes: 20 },
        { ...order.downtimeEvents[0], recordId: "EVT-9002", durationMinutes: 20 },
      ],
    };

    // Neither event reaches 30 on its own; together they are 40.
    // Selected by type: three rules fire on this order, so issues[0] is
    // whichever is worst, not necessarily the downtime one.
    const issue = find(detectIssues(twoStoppages), "MACHINE_DOWNTIME");
    assert.equal(issue?.severity, "MEDIUM");
    assert.match(issue!.headline, /2 stoppages/);
  });

  it("stays silent on a healthy order", async () => {
    // PO-10391: on rate, no downtime, 4 defects against a 1.5% baseline.
    const order = await mes.getOrder("PO-10391");
    assert.ok(order);
    assert.deepEqual(detectIssues(order), []);
  });

  it("stays silent when downtime is below the threshold", async () => {
    // PO-10344 has an 18-minute label reload — real, recorded, and not a problem.
    const order = await mes.getOrder("PO-10344");
    assert.ok(order);
    assert.equal(
      detectIssues(order).some((i) => i.type === "MACHINE_DOWNTIME"),
      false,
    );
  });
});

describe("machineDowntime scoping", () => {
  /*
   * The headline names `order.machineId` but the minutes come from the events.
   * An event belonging to another machine would therefore be reported under
   * this order's machine — and every citation would still resolve, so grounding
   * validation would pass it. A true record, a true number, a false sentence.
   *
   * Nothing produces this today; the mock only attaches matching events. It is
   * a Tier 4 exposure, where a real MES is likely to return a machine-level
   * event stream for a whole cell.
   */
  it("ignores downtime recorded against a different machine", async () => {
    const order = await scenarioOrder();
    const own = order.downtimeEvents.filter((e) => e.machineId === order.machineId);
    assert.ok(own.length > 0, "the scenario order must have downtime of its own");

    const withForeignEvent: OrderDetail = {
      ...order,
      downtimeEvents: [
        ...order.downtimeEvents,
        { ...own[0], recordId: "EVT-9999", machineId: "ASM-99", durationMinutes: 600 },
      ],
    };

    const issue = find(detectIssues(withForeignEvent), "MACHINE_DOWNTIME");
    assert.ok(issue, "the order's own downtime still fires");
    assert.match(
      issue.headline,
      /42 min/,
      "600 minutes on ASM-99 must not be reported as this order's machine being down",
    );
    assert.equal(
      issue.evidence.some((e) => e.recordId === "EVT-9999"),
      false,
      "a foreign event must not be cited as evidence either",
    );
  });

  it("does not fire when every downtime event belongs to another machine", async () => {
    const order = await scenarioOrder();
    const foreignOnly: OrderDetail = {
      ...order,
      downtimeEvents: order.downtimeEvents.map((e) => ({ ...e, machineId: "ASM-99" })),
    };
    assert.equal(
      detectIssues(foreignOnly).some((i) => i.type === "MACHINE_DOWNTIME"),
      false,
    );
  });
});

describe("qualityProblem", () => {
  async function widgetA(overrides: Partial<OrderDetail>): Promise<OrderDetail> {
    const order = await scenarioOrder();
    return { ...order, ...overrides };
  }

  it("measures against the product baseline, not a fixed percentage", async () => {
    // Same 9% observed rate. Against a 2% baseline it is 4.5x and HIGH;
    // against a 10% baseline it is below normal and must not fire at all.
    const strict = await widgetA({});
    assert.ok(detectIssues(strict).some((i) => i.type === "QUALITY_PROBLEM"));

    const tolerant = await widgetA({
      product: { code: "WGT-A", name: "Widget A", baselineDefectRate: 0.1 },
    });
    assert.equal(
      detectIssues(tolerant).some((i) => i.type === "QUALITY_PROBLEM"),
      false,
      "9% against a 10% baseline is normal for that product",
    );
  });

  it("stays quiet below the minimum sample size", async () => {
    const { minCompletedQty } = RULE_CONFIG.qualityProblem;
    // 8 scrapped of 40 completed is 20% — five times the baseline, and noise.
    const early = await widgetA({ completedQty: minCompletedQty - 10, scrapQty: 8 });
    assert.equal(
      detectIssues(early).some((i) => i.type === "QUALITY_PROBLEM"),
      false,
    );
  });

  it("does not divide by a zero baseline", async () => {
    const noBaseline = await widgetA({
      product: { code: "WGT-A", name: "Widget A", baselineDefectRate: 0 },
    });
    assert.equal(
      detectIssues(noBaseline).some((i) => i.type === "QUALITY_PROBLEM"),
      false,
      "un-assessable, not infinitely bad",
    );
  });

  it("escalates to HIGH at the configured multiple", async () => {
    const { mediumBaselineMultiple, highBaselineMultiple } = RULE_CONFIG.qualityProblem;
    const baseline = 0.02;

    const medium = await widgetA({
      completedQty: 1000,
      scrapQty: Math.round(1000 * baseline * mediumBaselineMultiple),
    });
    const high = await widgetA({
      completedQty: 1000,
      scrapQty: Math.round(1000 * baseline * highBaselineMultiple),
    });

    assert.equal(find(detectIssues(medium), "QUALITY_PROBLEM")?.severity, "MEDIUM");
    assert.equal(find(detectIssues(high), "QUALITY_PROBLEM")?.severity, "HIGH");
  });
});

describe("productionDelay", () => {
  it("uses the CLAUDE.md formula against asOf, not the wall clock", async () => {
    const order = await scenarioOrder();

    // expected = 125/h x 6h = 750; (750 - 620) / 750 = 0.1733
    const elapsed = hoursElapsed(order.operation.startedAt, order.asOf);
    const expected = order.plannedRatePerHour * elapsed;
    const ratio = (expected - order.completedQty) / expected;

    assert.equal(expected, 750);
    assert.ok(Math.abs(ratio - 0.1733) < 0.001, `delay ratio was ${ratio}`);
    assert.equal(find(detectIssues(order), "PRODUCTION_DELAY")?.severity, "MEDIUM");
  });

  it("does not fire at or below the configured ratio", async () => {
    const order = await scenarioOrder();
    const { firesAboveRatio } = RULE_CONFIG.productionDelay;

    // Exactly at the threshold: 750 expected, 675 complete = 10.0% behind.
    const atThreshold: OrderDetail = {
      ...order,
      completedQty: Math.round(750 * (1 - firesAboveRatio)),
    };
    assert.equal(
      detectIssues(atThreshold).some((i) => i.type === "PRODUCTION_DELAY"),
      false,
      "the rule fires strictly above the ratio",
    );
  });

  it("does not fire before any output is expected", async () => {
    const order = await scenarioOrder();
    const justStarted: OrderDetail = {
      ...order,
      completedQty: 0,
      operation: { ...order.operation, startedAt: order.asOf },
    };
    assert.equal(
      detectIssues(justStarted).some((i) => i.type === "PRODUCTION_DELAY"),
      false,
    );
  });

  it("is deterministic — the ratio does not drift with real time", async () => {
    const first = find(detectIssues(await scenarioOrder()), "PRODUCTION_DELAY");
    await new Promise((r) => setTimeout(r, 25));
    const second = find(detectIssues(await scenarioOrder()), "PRODUCTION_DELAY");
    assert.equal(first?.headline, second?.headline);
  });

  /*
   * Regression — the clock that never stopped.
   *
   * The rule assumes the machine should have produced for every hour since the
   * operation started, and the MES contract carries no "operation finished"
   * fact to stop it. So a finished order kept accruing expected quantity
   * forever: PO-10344 made all 750 of its 750 planned units and reported
   * "750 against 4000 expected — 81.3% behind" at HIGH, worsening every hour.
   *
   * Worth stating plainly, because it is the reason this survived so long:
   * **grounding validation cannot catch this.** Every citation was real —
   * completedQty 750, plannedRatePerHour 125, that start time all resolve
   * exactly — so the analysis wore the "Grounded in MES data" badge honestly
   * while being nonsense. True numbers, false inference. Only the rule layer
   * can prevent it, which is why these tests are here and not in the AI suite.
   */
  describe("does not assess an order it has no business assessing", () => {
    it("stays silent on a COMPLETED order that met its planned quantity", async () => {
      const completed = await mes.getOrder("PO-10344");
      assert.ok(completed, "PO-10344 must exist — it is the regression fixture");
      assert.equal(completed.status, "COMPLETED");
      assert.equal(completed.completedQty, completed.plannedQty, "it made everything it planned");

      assert.equal(
        detectIssues(completed).some((i) => i.type === "PRODUCTION_DELAY"),
        false,
        "a finished order is not behind, it is done",
      );
    });

    it("stays silent on a RELEASED order that has not started", async () => {
      const released = await mes.getOrder("PO-10402");
      assert.ok(released, "PO-10402 must exist — it is the regression fixture");
      assert.equal(released.status, "RELEASED");

      assert.equal(
        detectIssues(released).some((i) => i.type === "PRODUCTION_DELAY"),
        false,
        "an order released minutes ago cannot be 100% behind",
      );
    });

    it("stays silent on ON_HOLD, where the machine is stopped on purpose", async () => {
      const held = await mes.getOrder("PO-10365");
      assert.ok(held, "PO-10365 must exist — it is the ON_HOLD fixture");
      assert.equal(held.status, "ON_HOLD");

      assert.equal(
        detectIssues(held).some((i) => i.type === "PRODUCTION_DELAY"),
        false,
        "a hold is not a rate problem; slipping against the due date is a rule this demo does not have",
      );
      // The hold must not silence the rules that *are* about observed facts.
      assert.ok(
        detectIssues(held).some((i) => i.type === "MACHINE_DOWNTIME"),
        "75 minutes down is still 75 minutes down",
      );
    });

    it("reads the permitted statuses from the config, not from literals", async () => {
      const order = await scenarioOrder();
      const { assessedStatuses } = RULE_CONFIG.productionDelay;

      assert.ok(
        assessedStatuses.includes(order.status),
        "the scenario order's status must be one the rule assesses, or its 17.3% is unreachable",
      );

      // Every status the config excludes must silence the rule, on an order
      // that otherwise fires it. Asserting against the config rather than a
      // hard-coded list means widening `assessedStatuses` later cannot leave a
      // stale expectation passing.
      const excluded = (["RELEASED", "ON_HOLD", "COMPLETED", "CANCELLED"] as const).filter(
        (s) => !assessedStatuses.includes(s),
      );
      assert.ok(excluded.length > 0, "this test is vacuous if the rule assesses everything");

      for (const status of excluded) {
        assert.equal(
          detectIssues({ ...order, status }).some((i) => i.type === "PRODUCTION_DELAY"),
          false,
          `${status} must not be assessed for delay`,
        );
      }
    });
  });

  /*
   * The second half of the same defect, and independent of status: expected
   * quantity was unbounded. Even mid-run you can never be expected to have
   * produced more than the order asks for, so a long-running operation
   * eventually invents a target the order never had.
   */
  it("never expects more units than the order planned", async () => {
    const order = await scenarioOrder();

    // 125/h against a 200-unit order, 6 hours elapsed: uncapped this expects
    // 750 on an order that only ever wanted 200.
    const smallOrder: OrderDetail = { ...order, plannedQty: 200, completedQty: 200 };
    assert.equal(
      detectIssues(smallOrder).some((i) => i.type === "PRODUCTION_DELAY"),
      false,
      "an order that produced its full planned quantity is not behind",
    );

    // And the cap must not silence a genuine shortfall against it.
    const genuinelyBehind: OrderDetail = { ...order, plannedQty: 200, completedQty: 100 };
    const issue = find(detectIssues(genuinelyBehind), "PRODUCTION_DELAY");
    assert.ok(issue, "100 of a 200-unit order, 6 hours in, is genuinely behind");
    assert.match(issue.headline, /200 expected/, "the cap is what it is measured against");
  });
});

describe("MockMESAdapter", () => {
  it("matches on order number, product and machine", async () => {
    const byNumber = await mes.searchOrders({ text: "10382" });
    assert.deepEqual(byNumber.map((o) => o.orderNumber), ["PO-10382"]);

    const byMachine = await mes.searchOrders({ text: "asm-04" });
    assert.deepEqual(
      byMachine.map((o) => o.orderNumber).sort(),
      ["PO-10344", "PO-10382"],
      "machine search is case-insensitive and finds both orders on ASM-04",
    );

    const byProduct = await mes.searchOrders({ text: "widget a" });
    assert.equal(byProduct.length, 2);
  });

  it("filters by any of the given statuses", async () => {
    const held = await mes.searchOrders({ statuses: ["ON_HOLD"] });
    assert.deepEqual(held.map((o) => o.orderNumber), ["PO-10365"]);

    const two = await mes.searchOrders({ statuses: ["ON_HOLD", "COMPLETED"] });
    assert.equal(two.length, 2);

    const all = await mes.searchOrders({});
    assert.ok(all.length > two.length, "no status filter means no status filtering");
  });

  it("returns null for an unknown order rather than throwing", async () => {
    assert.equal(await mes.getOrder("PO-00000"), null);
  });

  it("is case-insensitive on lookup", async () => {
    const order = await mes.getOrder("po-10382");
    assert.equal(order?.orderNumber, "PO-10382");
  });

  it("reports a fixed asOf so the demo is deterministic", async () => {
    const first = await scenarioOrder();
    const second = await scenarioOrder();
    assert.equal(first.asOf, second.asOf);
  });

  it("carries the scenario numbers from CLAUDE.md", async () => {
    const order = await scenarioOrder();
    assert.equal(order.plannedQty, 1000);
    assert.equal(order.completedQty, 620);
    assert.equal(order.machineId, "ASM-04");

    // Expected-by-now is 750: 125/h over the six hours since the operation
    // started. That is what makes the Tier 1 delay ratio 0.173.
    const hours =
      (new Date(order.asOf).getTime() - new Date(order.operation.startedAt).getTime()) / 3_600_000;
    assert.equal(order.plannedRatePerHour * hours, 750);

    // 9% observed against a 2% baseline.
    assert.equal(Math.round((order.scrapQty / order.completedQty) * 100), 9);
    assert.equal(order.product.baselineDefectRate, 0.02);
  });
});
