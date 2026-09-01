/**
 * The decision log's contract.
 *
 * Rule 8: **the AI recommends; it never executes manufacturing actions.**
 * Approve / Reject / Escalate record what the supervisor decided and nothing
 * else. Nothing in this directory touches the MES, and the `MESAdapter`
 * contract has no write method for it to call even if it wanted to — that is
 * the guarantee, expressed as an absence rather than as a comment.
 *
 * Split out of `lib/decisions.ts` at Tier 3 (2026-08-19), when the store gained
 * a second implementation. The shape is `lib/mes/`'s: a contract here, one file
 * per backing store, and an `index.ts` that is the only place which picks.
 */

export type DecisionKind = "APPROVE" | "REJECT" | "ESCALATE";

export interface Decision {
  id: string;
  orderNumber: string;
  decision: DecisionKind;
  /** Optional free text — why the supervisor rejected or escalated. */
  note?: string;
  /** Who decided. From the session, never from the client body. */
  decidedByEmail: string;
  decidedAt: string;
  /**
   * What was on screen when they decided. Recording the recommendation means a
   * decision is never orphaned from the advice it was a response to.
   *
   * **`null` when there was no analysis on screen** — see `analysisSource`.
   */
  recommendedAction: string | null;
  /**
   * Whether the analysis they acted on was live, a cached fallback, or **absent
   * entirely**.
   *
   * `"none"` was added on 2026-08-18, when a decision stopped requiring an
   * analysis to exist first. It is recorded rather than inferred from a null
   * `recommendedAction`, because the two say different things: a supervisor who
   * decided without asking the model is a fact about how the decision was made,
   * and the audit trail's whole job is to keep facts like that.
   */
  analysisSource: "live" | "cached" | "none";
  /**
   * Set when this decision **overrides** an earlier one, naming the decision it
   * replaced.
   *
   * An override is a new row, never an edit. Rewriting the original would
   * destroy the only record of what was first decided, which is the single
   * thing an audit trail exists to keep — "approved at 14:22, overridden at
   * 16:40 because the feeder was still jammed" is the auditable story, and
   * "rejected at 16:40" on its own is not. It also means the log stays
   * append-only, so it persists as an **insert-only table** with no update path
   * and no history trigger.
   */
  supersedesId?: string;
}

/** What a caller supplies. The id and the timestamp belong to the store. */
export type DecisionInput = Omit<Decision, "id" | "decidedAt">;

/** An order's standing decision plus the ones it replaced. */
export interface OrderDecision {
  orderNumber: string;
  /** The decision in force. */
  current: Decision;
  /** Everything it replaced, newest first. Empty unless somebody overrode. */
  superseded: Decision[];
}

/**
 * Every way this app reads or writes a decision.
 *
 * **Async, including in the in-memory implementation.** A synchronous contract
 * would have been comfortable for the Map and impossible for a database, and
 * the whole point of writing a contract at Tier 3 is that Tier 3's second
 * implementation must fit it. The Map pays a resolved promise per call, which
 * is nothing.
 */
export interface DecisionStore {
  /**
   * Whether the log survives a restart.
   *
   * Surfaced through `GET /api/activity` and `GET /api/decisions` and rendered
   * on both screens — an audit trail that quietly forgets is worse than one
   * that says it forgets. It is a property of the store rather than a constant
   * so that the screens report what is actually behind them.
   */
  readonly durable: boolean;

  record(input: DecisionInput): Promise<Decision>;

  /** Decisions for one order, oldest first. */
  forOrder(orderNumber: string): Promise<Decision[]>;

  /**
   * Every decision across every order, **newest first** — the activity feed.
   *
   * The opposite order to `forOrder` on purpose. On one order the decisions are
   * a narrative and you read them forwards; across all orders they are a feed
   * and the only one anyone looks at is the most recent.
   */
  all(limit?: number): Promise<Decision[]>;

  /** One decision by id, or null. The lookup an override validates against. */
  byId(id: string): Promise<Decision | null>;

  /**
   * The decision currently standing on an order — the last one recorded.
   *
   * Taken by insertion order rather than by comparing `decidedAt`, because two
   * decisions recorded inside the same millisecond would tie on the timestamp
   * and "which of these is in force" must never be decided by a coin flip.
   */
  currentFor(orderNumber: string): Promise<Decision | null>;

  /**
   * One entry per order that has ever been decided, carrying the decision in
   * force and the trail behind it — the review screen's source.
   *
   * Deliberately **not** the same shape as `all`. The activity feed answers
   * "what happened", so it is a flat list of events. This answers "what stands
   * right now", so it is one row per order: a manager scanning for approvals to
   * revisit should not have to work out which of four rows on PO-10382 is the
   * live one.
   */
  current(): Promise<OrderDecision[]>;
}

/**
 * `DEC-0007` is how a decision is named on screen, in the audit trail and in
 * the `supersedesId` a client sends back. Both stores derive it from a counter
 * rather than storing it, so the display name and the ordering can never
 * disagree about which decision came first.
 *
 * `DecisionIdSchema` accepts `DEC-\d{1,10}`, so the padding is presentation and
 * the parse tolerates its absence.
 */
export function decisionId(seq: number): string {
  return `DEC-${String(seq).padStart(4, "0")}`;
}

/** The inverse. Returns null for anything that is not one of our ids. */
export function decisionSeq(id: string): number | null {
  const match = /^DEC-(\d{1,10})$/i.exec(id.trim());
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

/**
 * Groups a flat, ordered decision list into one row per order.
 *
 * Shared by both stores because it is the *definition* of "standing decision",
 * not a detail of how rows are fetched — and two implementations of that
 * definition is two chances to disagree about which decision is in force.
 *
 * `ordered` must be oldest-first within each order, which is what both stores
 * hand it.
 */
export function groupByOrder(ordered: Decision[]): OrderDecision[] {
  const byOrder = new Map<string, Decision[]>();
  for (const decision of ordered) {
    const key = decision.orderNumber.toUpperCase();
    byOrder.set(key, [...(byOrder.get(key) ?? []), decision]);
  }

  return [...byOrder.values()]
    .filter((decisions) => decisions.length > 0)
    .map((decisions) => ({
      orderNumber: decisions[decisions.length - 1].orderNumber,
      current: decisions[decisions.length - 1],
      superseded: decisions.slice(0, -1).reverse(),
    }))
    .sort(
      (a, b) =>
        b.current.decidedAt.localeCompare(a.current.decidedAt) ||
        b.current.id.localeCompare(a.current.id),
    );
}
