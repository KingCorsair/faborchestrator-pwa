/**
 * Every rule threshold in the product, in one object.
 *
 * Thresholds are the thing a customer argues about and a process engineer
 * retunes. Scattered through rule code as literals they are unauditable and
 * untestable; here they are one reviewable table, and a rule that wants a new
 * number has to add it to this file where someone will see it.
 *
 * Severity is always computed here from MES facts. The LLM never assigns it,
 * and there are no confidence scores anywhere in this product.
 */

import type { OrderStatus } from "./types";

export type Severity = "LOW" | "MEDIUM" | "HIGH";

export type IssueType = "MACHINE_DOWNTIME" | "QUALITY_PROBLEM" | "PRODUCTION_DELAY";

export const RULE_CONFIG = {
  machineDowntime: {
    /** At or above this many minutes down, the issue is MEDIUM. */
    mediumMinutes: 30,
    /** Above this many minutes down, HIGH. */
    highMinutes: 60,
  },

  qualityProblem: {
    /**
     * Fires when the observed defect rate is at least this many times the
     * product's own baseline — relative to the product, never a fixed
     * percentage. 3% is a crisis on a part that normally runs at 0.5% and
     * unremarkable on one that normally runs at 3%.
     */
    // Plan v2: "defect rate 2–3× baseline = MEDIUM, > 3× = HIGH". This was
    // built as 2/4 before the plan document surfaced; corrected 2026-08-10.
    mediumBaselineMultiple: 2,
    highBaselineMultiple: 3,
    /** Below this many units completed the rate is noise, not a signal. */
    minCompletedQty: 50,
  },

  productionDelay: {
    /**
     *   expected_qty = planned_rate_per_hour × hours_elapsed_on_current_operation
     *   delay_ratio  = (expected_qty − completed_qty) / expected_qty
     *
     * PRODUCTION_DELAY fires strictly above this ratio.
     */
    firesAboveRatio: 0.1,
    highRatio: 0.25,

    /**
     * The only statuses this rule assesses. Added 2026-08-12 to fix a defect
     * that made every finished and every unstarted order look like a crisis.
     *
     * The rule measures elapsed time from `operation.startedAt` to `asOf` and
     * assumes the machine should have been producing for all of it. There is no
     * "the operation finished" fact in the contract, so **the clock never
     * stops**: PO-10344 completed all 750 of its 750 planned units and, a day
     * later, reported "750 against 4000 expected — 81.3% behind" at HIGH. It
     * got worse every hour. PO-10402 failed from the other end — RELEASED
     * fifteen minutes earlier, 0 units made, "100.0% behind" at HIGH.
     *
     * `IN_PROGRESS` only, deliberately:
     *   - RELEASED has not started; there is nothing to be behind on.
     *   - COMPLETED and CANCELLED are finished; delay is no longer actionable
     *     and the arithmetic above is unbounded.
     *   - ON_HOLD is the arguable one. A held order genuinely does slip against
     *     its due date — but "behind the planned *rate*" is the wrong way to say
     *     it, because the machine is stopped on purpose and the ratio just
     *     counts how long the hold has lasted. That belongs to a due-date rule,
     *     which this demo does not have. Excluded rather than half-answered.
     */
    assessedStatuses: ["IN_PROGRESS"] as readonly OrderStatus[],
  },
} as const;

/**
 * Hours between two ISO timestamps.
 *
 * The delay rule measures elapsed time against the adapter's `asOf`, never
 * against the wall clock — otherwise the same order yields a different delay
 * ratio every time the demo is run, and a demo whose numbers drift is one
 * nobody can rehearse. Negative spans clamp to zero: an operation recorded as
 * starting after `asOf` has not run yet.
 */
export function hoursElapsed(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, (to - from) / 3_600_000);
}

/**
 * Downtime minutes → severity, per `RULE_CONFIG.machineDowntime`.
 *
 * Boundaries: 30 minutes exactly is MEDIUM, 60 exactly is MEDIUM, 61 is HIGH.
 * CLAUDE.md specifies "30–60 min = MEDIUM, >60 = HIGH", so 60 belongs to the
 * closed interval below it.
 */
export function severityForDowntime(minutes: number): Severity {
  const { mediumMinutes, highMinutes } = RULE_CONFIG.machineDowntime;
  if (minutes > highMinutes) return "HIGH";
  if (minutes >= mediumMinutes) return "MEDIUM";
  return "LOW";
}
