/**
 * Deterministic problem detection.
 *
 * The division of labour this whole product rests on: **MES data provides
 * facts → this file decides whether there is a problem and how severe it is →
 * the LLM only explains and recommends → a human decides.** Nothing below ever
 * asks a model whether a machine stopped or whether a defect rate is high.
 * Those are arithmetic, and arithmetic that a customer can audit.
 *
 * All three rules are implemented as of Tier 1. Every threshold comes from
 * `rules-config.ts` — there is not a bare number in this file.
 *
 * When several rules fire, `detectIssues` returns them worst-first and they go
 * to the model **together**, as one prioritised analysis. Never one explanation
 * per issue: three disconnected paragraphs is how you get three contradictory
 * recommendations about the same machine.
 */

import {
  RULE_CONFIG,
  hoursElapsed,
  severityForDowntime,
  type IssueType,
  type Severity,
} from "./rules-config";
import type { OrderDetail } from "./types";

/**
 * A single piece of evidence: which record, which field of it, and the value
 * that was read. This is the shape the LLM is required to cite in, and the
 * shape Tier 2 validates by exact lookup against `recordIndex(order)`. Rules
 * emit it too, so the screen renders citations identically whether they came
 * from arithmetic or from a model.
 */
export interface EvidenceRef {
  recordId: string;
  field: string;
  value: string;
}

export interface DetectedIssue {
  type: IssueType;
  severity: Severity;
  /** One line, factual, no interpretation. The explanation is the LLM's job. */
  headline: string;
  /** Why this severity, in terms of the threshold that decided it. */
  rule: string;
  evidence: EvidenceRef[];
}

/** Severity ordering for display and for the order the model reads them in. */
const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function detectIssues(order: OrderDetail): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  const downtime = machineDowntime(order);
  if (downtime) issues.push(downtime);

  const quality = qualityProblem(order);
  if (quality) issues.push(quality);

  const delay = productionDelay(order);
  if (delay) issues.push(delay);

  return issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * MACHINE_DOWNTIME — total downtime recorded against this order, on its own
 * machine.
 *
 * Events are summed rather than taken at the maximum: six ten-minute stoppages
 * cost the same hour as one sixty-minute stoppage, and the supervisor is being
 * asked about the hour.
 *
 * ── Two things this rule does not do, corrected 2026-08-12 ──────────────────
 * This comment used to claim downtime "on the order's current operation" and
 * that the downtime was "unplanned". **It does neither, and the contract cannot
 * support either claim**: `DowntimeEvent` carries no operation number and no
 * planned/unplanned flag (see `types.ts`). Every event attached to the order is
 * counted, whatever operation it belonged to and whether or not it was
 * scheduled — so a routine label-stock reload weighs the same as a feeder jam.
 *
 * That is a defensible default for a demo, and it was being described as
 * something more precise than it is. If either distinction is wanted it is a
 * contract change first, not a rule change — which makes it a Tier 4 question
 * to settle against a real MES, not something to fake here.
 */
function machineDowntime(order: OrderDetail): DetectedIssue | null {
  /*
   * Only this order's machine.
   *
   * The headline interpolates `order.machineId` while the minutes come from the
   * events, so without this filter an event belonging to another machine is
   * reported under this one's name — "ASM-04 was down 75 min" when ASM-04 was
   * never down. Every citation would still resolve, so grounding validation
   * would pass it: a true record, a true number, and a false sentence.
   *
   * The mock adapter only ever attaches matching events, so this changes
   * nothing today. It matters at Tier 4, where a real MES is far more likely to
   * return a machine-level event stream for a cell or a line than a
   * pre-filtered list per order.
   */
  const events = order.downtimeEvents.filter((event) => event.machineId === order.machineId);
  if (events.length === 0) return null;

  const totalMinutes = events.reduce((sum, e) => sum + e.durationMinutes, 0);
  const severity = severityForDowntime(totalMinutes);
  if (severity === "LOW") return null;

  const { mediumMinutes, highMinutes } = RULE_CONFIG.machineDowntime;

  return {
    type: "MACHINE_DOWNTIME",
    severity,
    headline:
      events.length === 1
        ? `${order.machineId} was down ${totalMinutes} min — ${events[0].reason}`
        : `${order.machineId} was down ${totalMinutes} min across ${events.length} stoppages`,
    rule:
      severity === "HIGH"
        ? `Downtime above ${highMinutes} min is HIGH`
        : `Downtime from ${mediumMinutes} to ${highMinutes} min is MEDIUM`,
    evidence: [
      { recordId: order.recordId, field: "machineId", value: order.machineId },
      ...events.flatMap((event) => [
        { recordId: event.recordId, field: "durationMinutes", value: String(event.durationMinutes) },
        { recordId: event.recordId, field: "reason", value: event.reason },
      ]),
    ],
  };
}

/**
 * QUALITY_PROBLEM — observed defect rate against the product's own baseline.
 *
 * Relative to the product, not to a fixed percentage: a 3% defect rate is a
 * crisis on a part that normally runs at 0.5% and unremarkable on one that
 * normally runs at 3%. `minCompletedQty` keeps the rule quiet early in a run,
 * where two scrapped units out of ten reads as 20% and means nothing.
 */
function qualityProblem(order: OrderDetail): DetectedIssue | null {
  const { minCompletedQty, mediumBaselineMultiple, highBaselineMultiple } =
    RULE_CONFIG.qualityProblem;

  if (order.completedQty < minCompletedQty) return null;

  const baseline = order.product.baselineDefectRate;
  // A product with no baseline has nothing to be "high relative to"; treat the
  // absence as un-assessable rather than dividing by zero into Infinity.
  if (baseline <= 0) return null;

  const observedRate = order.scrapQty / order.completedQty;
  const multiple = observedRate / baseline;
  if (multiple < mediumBaselineMultiple) return null;

  const severity: Severity = multiple >= highBaselineMultiple ? "HIGH" : "MEDIUM";

  return {
    type: "QUALITY_PROBLEM",
    severity,
    headline: `Defect rate ${pct(observedRate)} against a ${pct(baseline)} baseline — ${multiple.toFixed(1)}× normal`,
    rule:
      severity === "HIGH"
        ? `At or above ${highBaselineMultiple}× the product baseline is HIGH`
        : `From ${mediumBaselineMultiple}× to ${highBaselineMultiple}× the product baseline is MEDIUM`,
    evidence: [
      { recordId: order.recordId, field: "scrapQty", value: String(order.scrapQty) },
      { recordId: order.recordId, field: "completedQty", value: String(order.completedQty) },
      ...order.defects.map((defect) => ({
        recordId: defect.recordId,
        field: "quantity",
        value: String(defect.quantity),
      })),
    ],
  };
}

/**
 * PRODUCTION_DELAY — how far behind the planned rate the order is running.
 *
 *   expected_qty = min(planned_rate_per_hour × hours_elapsed, planned_qty)
 *   delay_ratio  = (expected_qty − completed_qty) / expected_qty
 *
 * Fires above `firesAboveRatio`. Elapsed time is measured against the adapter's
 * `asOf`, not the wall clock, so the same order yields the same ratio on every
 * run of the demo.
 *
 * **Two guards, both added 2026-08-12 after this rule fired HIGH on a finished
 * order.** See `RULE_CONFIG.productionDelay.assessedStatuses` for the full
 * account; in short, the rule assumes the machine should have been producing
 * for every hour since the operation started, and the contract carries no
 * "operation finished" fact to stop the clock.
 */
function productionDelay(order: OrderDetail): DetectedIssue | null {
  const { firesAboveRatio, highRatio, assessedStatuses } = RULE_CONFIG.productionDelay;

  // Guard 1 — status. A completed order is not behind, it is done; a released
  // one has not started. Without this the ratio grows every hour forever.
  if (!assessedStatuses.includes(order.status)) return null;

  const elapsed = hoursElapsed(order.operation.startedAt, order.asOf);
  // Guard 2 — you can never be expected to have produced more than the order
  // asks for. Uncapped, a 750-unit order sitting 32 hours past its operation
  // start "expected" 4000 units, which is not a number anybody can act on.
  const expectedQty = Math.min(order.plannedRatePerHour * elapsed, order.plannedQty);
  // Nothing was expected yet — an operation that started a minute ago cannot
  // be behind, and dividing by it would produce a meaningless ratio.
  if (expectedQty <= 0) return null;

  const delayRatio = (expectedQty - order.completedQty) / expectedQty;
  if (delayRatio <= firesAboveRatio) return null;

  const severity: Severity = delayRatio >= highRatio ? "HIGH" : "MEDIUM";

  return {
    type: "PRODUCTION_DELAY",
    severity,
    headline: `${order.completedQty} units complete against ${Math.round(expectedQty)} expected by now — ${pct(delayRatio)} behind`,
    rule:
      severity === "HIGH"
        ? `A delay ratio at or above ${pct(highRatio)} is HIGH`
        : `A delay ratio above ${pct(firesAboveRatio)} is MEDIUM`,
    evidence: [
      { recordId: order.recordId, field: "completedQty", value: String(order.completedQty) },
      {
        recordId: order.recordId,
        field: "plannedRatePerHour",
        value: String(order.plannedRatePerHour),
      },
      {
        recordId: order.operation.recordId,
        field: "startedAt",
        value: order.operation.startedAt,
      },
    ],
  };
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
