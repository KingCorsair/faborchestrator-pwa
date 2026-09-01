/**
 * What the **client** accepts. The other half of "Zod end to end" (Tier 2).
 *
 * `lib/validation.ts` is what the API accepts from a request. This file is what
 * a screen accepts from a response, and until Tier 2 it did not exist: pages
 * wrote `payload as AnalysisResult` and rendered whatever arrived. A cast is not
 * a check. It compiles against a shape nobody verified at runtime, and the first
 * thing that breaks it is Tier 4 — a real `FabOrchestratorMESAdapter` returning
 * `completedQty` as a string, or an operation with no `startedAt`, produces
 * `NaN%` and `Invalid Date` on a shop-floor screen rather than an error anyone
 * can act on.
 *
 * ── Why not infer these from the interfaces ─────────────────────────────────
 * They cannot be — TypeScript types are erased, so a runtime validator has to be
 * written out. What stops the two drifting is the `Assignable` assertions at the
 * bottom of each group: they are type-level, cost nothing at runtime, and fail
 * the build the moment a schema stops describing the interface it stands for.
 */

import { z } from "zod";
import { AnalysisSchema } from "@/lib/ai/schema";
import type { GroundingReport } from "@/lib/ai/grounding";
import type { AnalysisResult } from "@/lib/ai/analyze";
import type { Decision, OrderDecision } from "@/lib/decisions";
import type { DetectedIssue } from "@/lib/mes/issues";
import type { OrderDetail, OrderSummary } from "@/lib/mes/types";

/**
 * Compile-time proof that `Source` can stand in for `Target`.
 *
 * Exported rather than declared as a bare unused alias so it is a real reference
 * and not something a lint rule is entitled to delete. If a schema drifts from
 * its interface, the error lands here with both names in it.
 */
export type Assignable<Target, Source extends Target> = Source;

/* ── MES records ──────────────────────────────────────────────────────────── */

export const OrderStatusEnum = z.enum([
  "RELEASED",
  "IN_PROGRESS",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
]);

const ProductRefSchema = z.object({
  code: z.string(),
  name: z.string(),
  baselineDefectRate: z.number(),
});

export const OrderSummarySchema = z.object({
  recordId: z.string(),
  recordType: z.literal("PRODUCTION_ORDER"),
  orderNumber: z.string(),
  product: ProductRefSchema,
  status: OrderStatusEnum,
  site: z.string(),
  machineId: z.string(),
  plannedQty: z.number(),
  completedQty: z.number(),
  dueAt: z.string(),
});

export const OrderDetailSchema = OrderSummarySchema.extend({
  operation: z.object({
    recordId: z.string(),
    recordType: z.literal("OPERATION"),
    number: z.number(),
    name: z.string(),
    startedAt: z.string(),
  }),
  scrapQty: z.number(),
  plannedRatePerHour: z.number(),
  downtimeEvents: z.array(
    z.object({
      recordId: z.string(),
      recordType: z.literal("DOWNTIME_EVENT"),
      machineId: z.string(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      durationMinutes: z.number(),
      reasonCode: z.string(),
      reason: z.string(),
    }),
  ),
  defects: z.array(
    z.object({
      recordId: z.string(),
      recordType: z.literal("DEFECT_RECORD"),
      operationNumber: z.number(),
      defectCode: z.string(),
      description: z.string(),
      quantity: z.number(),
      recordedAt: z.string(),
    }),
  ),
  asOf: z.string(),
});

export type CheckedOrderSummary = Assignable<OrderSummary, z.infer<typeof OrderSummarySchema>>;
export type CheckedOrderDetail = Assignable<OrderDetail, z.infer<typeof OrderDetailSchema>>;

/* ── Rules ────────────────────────────────────────────────────────────────── */

export const DetectedIssueSchema = z.object({
  type: z.enum(["MACHINE_DOWNTIME", "QUALITY_PROBLEM", "PRODUCTION_DELAY"]),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  headline: z.string(),
  rule: z.string(),
  evidence: z.array(
    z.object({ recordId: z.string(), field: z.string(), value: z.string() }),
  ),
});

export type CheckedDetectedIssue = Assignable<DetectedIssue, z.infer<typeof DetectedIssueSchema>>;

export const OrderSearchResponseSchema = z.object({
  orders: z.array(OrderSummarySchema),
});

export const OrderResponseSchema = z.object({
  order: OrderDetailSchema,
  issues: z.array(DetectedIssueSchema),
  source: z.string(),
});

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

/* ── Analysis ─────────────────────────────────────────────────────────────── */

export const GroundingReportSchema = z.object({
  grounded: z.boolean(),
  citationsChecked: z.number(),
  problems: z.array(
    z.object({
      fault: z.enum(["unknown_record", "unknown_field", "value_mismatch"]),
      path: z.string(),
      recordId: z.string(),
      field: z.string(),
      claimed: z.string(),
      actual: z.string().optional(),
    }),
  ),
  unfiredIssueTypes: z.array(z.string()),
  unexplainedIssueTypes: z.array(z.string()),
});

export const AnalysisResultSchema = z.object({
  // The same `AnalysisSchema` the server validated the model against. Parsed
  // twice on purpose: once where it is produced, once where it is rendered.
  analysis: AnalysisSchema,
  source: z.enum(["live", "cached"]),
  model: z.string().nullable(),
  grounding: GroundingReportSchema,
  attempts: z.number(),
  degraded: z
    .object({
      reason: z.enum(["no_api_key", "api_error", "timeout", "invalid_output"]),
      detail: z.string(),
    })
    .optional(),
});

export type CheckedGroundingReport = Assignable<
  GroundingReport,
  z.infer<typeof GroundingReportSchema>
>;
export type CheckedAnalysisResult = Assignable<AnalysisResult, z.infer<typeof AnalysisResultSchema>>;

/* ── Decisions and activity ───────────────────────────────────────────────── */

export const DecisionRecordSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  decision: z.enum(["APPROVE", "REJECT", "ESCALATE"]),
  note: z.string().optional(),
  decidedByEmail: z.string(),
  decidedAt: z.string(),
  // Nullable since 2026-08-18: a decision can be taken with no analysis on
  // screen, and `analysisSource: "none"` is how the log says so.
  recommendedAction: z.string().nullable(),
  analysisSource: z.enum(["live", "cached", "none"]),
  /** Present when this decision overrode an earlier one. */
  supersedesId: z.string().optional(),
});

export type CheckedDecision = Assignable<Decision, z.infer<typeof DecisionRecordSchema>>;

export const OrderDecisionSchema = z.object({
  orderNumber: z.string(),
  current: DecisionRecordSchema,
  superseded: z.array(DecisionRecordSchema),
});

export type CheckedOrderDecision = Assignable<OrderDecision, z.infer<typeof OrderDecisionSchema>>;

export const DecisionsResponseSchema = z.object({
  decisions: z.array(OrderDecisionSchema),
  durable: z.boolean(),
});

export type DecisionsResponse = z.infer<typeof DecisionsResponseSchema>;

export const DecisionResponseSchema = z.object({
  decision: DecisionRecordSchema,
  history: z.array(DecisionRecordSchema),
});

export const HistoryResponseSchema = z.object({
  history: z.array(DecisionRecordSchema),
});

export const ActivityResponseSchema = z.object({
  activity: z.array(DecisionRecordSchema),
  /** Whether the log is persistent. False until Tier 3 — the feed says so on screen. */
  durable: z.boolean(),
});

export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

/* ── Parsing ──────────────────────────────────────────────────────────────── */

/**
 * Parse a response body, or throw an error a human can act on.
 *
 * The message names the endpoint and the first failing path — "GET /api/orders:
 * order.completedQty: expected number, received string" tells whoever is on
 * call which side is wrong. `payload as T` told them nothing, three screens
 * later, as `NaN`.
 */
export function parseResponse<T>(schema: z.ZodType<T>, payload: unknown, endpoint: string): T {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;

  const first = result.error.issues[0];
  throw new Error(
    `${endpoint} returned an unexpected shape — ${first.path.join(".") || "(root)"}: ${first.message}`,
  );
}
