/**
 * The order the landing page opens on.
 *
 * ── Why this is derived and not written down ────────────────────────────────
 * The front door shows a real order with its real detected problems, because
 * the strongest proof a demo has is the thing itself working. But CLAUDE.md's
 * hardest rule is that **nothing may state a fact about the factory that does
 * not resolve to a real MES record**, and a landing page with `3 problems` and
 * `QUALITY HIGH` typed into the JSX is exactly that: a claim, frozen at the
 * moment somebody typed it.
 *
 * It would also have gone stale, and this file already knows how. On
 * 2026-08-12 the delay rule was corrected and `PO-10344` went from a HIGH
 * problem to no issues at all. A hard-coded card would have kept announcing
 * the old severities from the front door, and every screen behind it would
 * have disagreed.
 *
 * So the card runs the same adapter and the same rules the order screen runs.
 * `/` still prerenders as **static**: `MockMESAdapter` reads a JSON import,
 * `detectIssues` is arithmetic, and neither touches a request — so this
 * resolves at build time and the numbers are regenerated on every deploy.
 * When Tier 4 swaps in a real adapter this becomes a request-time read and `/`
 * stops being static, which is the correct trade at that point and not before.
 *
 * ── Degrading ───────────────────────────────────────────────────────────────
 * Null when the order is missing **or when the rules find nothing wrong with
 * it**. A card headed "3 problems detected" that has no problems to name is
 * the failure this file exists to prevent, and an order with a clean bill of
 * health is not the thing to put at the entrance of an exception assistant.
 * The landing page falls back to the plain "Review production orders" door it
 * carried before, which is a door that asserts nothing.
 */

import { detectIssues, mes, type IssueType, type OrderStatus, type Severity } from "@/lib/mes";

/**
 * The scenario order — 42 min down on ASM-04, 620 of 1000 against 750
 * expected, 9.0% defects against a 2% baseline. All three rules fire on it,
 * which is what makes it worth putting on the front door rather than any other
 * order in the fixture.
 */
export const FEATURED_ORDER_NUMBER = "PO-10382";

/** Only what the card renders — not an `OrderDetail`, so the screen cannot start reading fields it has no business showing. */
export interface FeaturedOrder {
  orderNumber: string;
  productName: string;
  machineId: string;
  status: OrderStatus;
  issues: { type: IssueType; severity: Severity }[];
}

/**
 * The parameter exists so the two degrade paths are reachable from a test.
 * Callers in the app never pass it — there is one front door and it opens on
 * one order — but "returns null when the order has no issues" is a claim that
 * is worth nothing unless something checks it, and the fixture already holds
 * an order the rules find nothing wrong with.
 */
export async function featuredOrder(
  orderNumber: string = FEATURED_ORDER_NUMBER,
): Promise<FeaturedOrder | null> {
  const order = await mes.getOrder(orderNumber);
  if (!order) return null;

  const issues = detectIssues(order);
  if (issues.length === 0) return null;

  return {
    orderNumber: order.orderNumber,
    productName: order.product.name,
    machineId: order.machineId,
    status: order.status,
    // Already worst-first out of `detectIssues`, and the card relies on that:
    // the pill a supervisor reads first should be the problem that matters
    // most, not the rule that happens to run first.
    issues: issues.map((issue) => ({ type: issue.type, severity: issue.severity })),
  };
}
