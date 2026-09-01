/**
 * The MES contract.
 *
 * This is the only file the rest of the app is allowed to know about when it
 * comes to manufacturing data. `MockMESAdapter` implements it against JSON
 * today; `FabOrchestratorMESAdapter` implements it against the real MES later
 * (Tier 4). Nothing outside `lib/mes/` may care which one is active, so this
 * contract is fixed from day one and changes only deliberately.
 *
 * ── Record IDs ──────────────────────────────────────────────────────────────
 * Every record carries a stable `recordId` — `PO-10382`, `EVT-2231`,
 * `DEF-0417`, `OPR-10382-30`. This is not cosmetic. From Tier 1 the LLM cites
 * evidence as `{record_id, field, value}` triples, and Tier 2 validates those
 * citations by exact lookup against the context that was sent. A record with no
 * ID, or an ID that is not stable across a refetch, cannot be cited and cannot
 * be validated. Prose references ("the downtime event") are never evidence.
 *
 * ── Facts only ──────────────────────────────────────────────────────────────
 * These types describe what the MES observed. They carry no severity, no
 * detected problem and no explanation: the deterministic rules assign severity
 * (see `rules-config.ts`) and the LLM only ever explains. Nothing here should
 * ever gain a `confidence` field.
 */

/** Every MES record is addressable and typed. */
export interface MESRecord {
  recordId: string;
  recordType: MESRecordType;
}

export type MESRecordType =
  | "PRODUCTION_ORDER"
  | "OPERATION"
  | "DOWNTIME_EVENT"
  | "DEFECT_RECORD";

export type OrderStatus =
  | "RELEASED"
  | "IN_PROGRESS"
  | "ON_HOLD"
  | "COMPLETED"
  | "CANCELLED";

export interface ProductRef {
  code: string;
  name: string;
  /**
   * The defect rate this product normally runs at, as a fraction. The
   * comparison baseline for QUALITY_PROBLEM — a rate is only high relative to
   * something, and that something is a property of the product, not a constant.
   */
  baselineDefectRate: number;
}

/** The operation currently being run against the order. */
export interface OperationRecord extends MESRecord {
  recordType: "OPERATION";
  number: number;
  name: string;
  /** ISO 8601. The delay rule measures elapsed time from here. */
  startedAt: string;
}

export interface DowntimeEvent extends MESRecord {
  recordType: "DOWNTIME_EVENT";
  machineId: string;
  startedAt: string;
  /** ISO 8601, or null while the machine is still down. */
  endedAt: string | null;
  durationMinutes: number;
  reasonCode: string;
  reason: string;
}

export interface DefectRecord extends MESRecord {
  recordType: "DEFECT_RECORD";
  operationNumber: number;
  defectCode: string;
  description: string;
  quantity: number;
  recordedAt: string;
}

/** What the search screen needs, and no more. */
export interface OrderSummary extends MESRecord {
  recordType: "PRODUCTION_ORDER";
  orderNumber: string;
  product: ProductRef;
  status: OrderStatus;
  site: string;
  machineId: string;
  plannedQty: number;
  completedQty: number;
  dueAt: string;
}

/** The full order, with every record the analysis is allowed to cite. */
export interface OrderDetail extends OrderSummary {
  operation: OperationRecord;
  /** Units scrapped so far. `defects` explains what they were. */
  scrapQty: number;
  /** Units per hour the order is planned to run at, on this operation. */
  plannedRatePerHour: number;
  downtimeEvents: DowntimeEvent[];
  defects: DefectRecord[];
  /**
   * The instant the adapter's facts are true as of. The mock returns a fixed
   * timestamp so the demo is deterministic — elapsed time, and therefore the
   * delay ratio, must not drift between two runs of the same demo. A real
   * adapter returns the query time.
   */
  asOf: string;
}

export interface OrderQuery {
  /** Free text over order number, product name/code and machine. */
  text?: string;
  /**
   * Statuses to include; empty or absent means all. A list rather than a single
   * value because the filter rail is multi-select, and because this is the
   * shape a real MES query pushes down — filtering a fetched page client-side
   * would silently stop working the moment the result set exceeds one page.
   */
  statuses?: OrderStatus[];
  limit?: number;
}

/**
 * The adapter. Two reads today; approve/reject/escalate arrives in Tier 1 and
 * writes to a decision log, not to the MES — the AI recommends and a human
 * decides, and neither ever executes a manufacturing action.
 */
export interface MESAdapter {
  /** The adapter's own name, surfaced in the UI so a demo is never mistaken for live data. */
  readonly name: string;
  searchOrders(query: OrderQuery): Promise<OrderSummary[]>;
  /** Null when no such order exists — not a throw; a missing order is an ordinary answer. */
  getOrder(orderNumber: string): Promise<OrderDetail | null>;
}

/**
 * Every citable record in an order, keyed by `recordId`.
 *
 * This is the lookup table an evidence citation resolves against. Tier 2's
 * grounding validation is exactly this map plus a field check, which is why it
 * lives beside the contract rather than inside the LLM code — the definition of
 * "citable" must not be something the AI layer gets to decide for itself.
 */
export function recordIndex(order: OrderDetail): Map<string, MESRecord> {
  const index = new Map<string, MESRecord>();
  const { operation, downtimeEvents, defects, ...orderFields } = order;
  index.set(order.recordId, { ...orderFields, recordType: "PRODUCTION_ORDER" } as MESRecord);
  index.set(operation.recordId, operation);
  for (const event of downtimeEvents) index.set(event.recordId, event);
  for (const defect of defects) index.set(defect.recordId, defect);
  return index;
}
