/**
 * The context sent to the model — and the definition of what it may cite.
 *
 * This is the single most load-bearing file in the AI layer, because it fixes
 * both halves of grounding at once: what the model is *shown* and what a
 * citation is later checked *against* are built from the same object. If the
 * prompt were assembled ad hoc in the route while validation read the order
 * separately, the two would drift and a citation could be judged invalid
 * because the validator never saw a record the model did.
 *
 * Tier 2 turns `citableRecords` into the grounding check. It is exported now,
 * and already used by the rule tests, so the seam exists before it is needed.
 */

import type { DetectedIssue } from "@/lib/mes/issues";
import { recordIndex, type OrderDetail } from "@/lib/mes/types";

/**
 * Every record the model is allowed to cite, flattened to plain fields.
 *
 * Derived from `recordIndex` rather than re-walked here — the definition of
 * "citable" belongs to the MES contract, not to the AI layer, and the AI layer
 * is exactly the code that must not be allowed to widen it.
 */
export function citableRecords(order: OrderDetail): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [recordId, record] of recordIndex(order)) {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(record as unknown as Record<string, unknown>)) {
      // Nested objects (the order's `product`) are flattened one level so a
      // citation can name `product.name` — a field the model can actually read.
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
          fields[`${key}.${innerKey}`] = String(innerValue);
        }
        continue;
      }
      if (Array.isArray(value)) continue;
      fields[key] = String(value);
    }
    out[recordId] = fields;
  }
  return out;
}

/**
 * The user-turn payload: the order, the records that may be cited, and the
 * issues the rules found — all of them, in one message.
 *
 * Rule 7 lives here as much as in the prompt: sending every fired issue in a
 * single turn is what makes a unified analysis possible at all. One request per
 * issue would make it structurally impossible for the model to notice that the
 * downtime and the delay are the same event.
 */
export function buildAnalysisRequest(order: OrderDetail, issues: DetectedIssue[]): string {
  return JSON.stringify(
    {
      instruction:
        "Explain these detected problems together and recommend one next action. Cite only the records listed under citable_records.",
      order: {
        order_number: order.orderNumber,
        product: order.product.name,
        product_code: order.product.code,
        status: order.status,
        machine: order.machineId,
        site: order.site,
        operation: `${order.operation.number} — ${order.operation.name}`,
        planned_qty: order.plannedQty,
        completed_qty: order.completedQty,
        scrap_qty: order.scrapQty,
        planned_rate_per_hour: order.plannedRatePerHour,
        baseline_defect_rate: order.product.baselineDefectRate,
        operation_started_at: order.operation.startedAt,
        due_at: order.dueAt,
        as_of: order.asOf,
      },
      // Given to the model as facts, already ordered by severity. It explains
      // them; it does not re-rank or re-grade them.
      detected_issues: issues.map((issue) => ({
        type: issue.type,
        headline: issue.headline,
        rule_that_fired: issue.rule,
        supporting_records: issue.evidence.map((e) => ({
          record_id: e.recordId,
          field: e.field,
          value: e.value,
        })),
      })),
      citable_records: citableRecords(order),
    },
    null,
    2,
  );
}
