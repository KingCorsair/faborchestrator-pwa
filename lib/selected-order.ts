/**
 * `?order=` on `/orders` — which order the review panel opens pointed at.
 *
 * ── Why this parameter exists ───────────────────────────────────────────────
 * Decisions are recorded in exactly one place, the review panel at the top of
 * `/orders` (CLAUDE.md, 2026-08-19). The order screen is where the evidence is.
 * So the workflow crosses a route boundary — read the problem here, record the
 * decision there — and before this parameter existed **the order did not cross
 * with you**. `router.push("/orders")` landed on a panel whose selection is
 * component state, which falls back to the first row of the list: `PO-10344`,
 * sorted first by due date, completed, and carrying no detected issues at all.
 *
 * That is the failure `review-panel.tsx` names in its own comment as the worst
 * outcome it has — a decision posted against a stale selection — reached not by
 * a filter or a race but by using the app the way the landing page invites you
 * to. This carries the order across so the panel opens on what you were just
 * reading.
 *
 * ── Why it is validated ─────────────────────────────────────────────────────
 * It is a URL parameter, so it is attacker-controlled on a permanently public
 * deployment, and it decides which order a supervisor is about to approve. The
 * damage here is not an open redirect — the panel can only select an order the
 * MES actually returned, and the route re-checks existence on write — it is
 * that a plausible-looking value could put the panel in a state nobody
 * intended. Anything that is not an order number resolves to `""`, which is
 * exactly what the page held before the parameter existed: the panel falls back
 * to the first row, and behaviour degrades to the old default rather than to an
 * error.
 *
 * `OrderNumberSchema` is reused rather than re-expressed. It is what the API
 * accepts as a key, and a value this page would select but the decision route
 * would reject is a value that fails late instead of early.
 */

import { OrderNumberSchema } from "@/lib/validation";

/** The panel's own behaviour when nothing is asked for: select the first row. */
export const NO_SELECTED_ORDER = "";

export function safeSelectedOrder(raw: string | string[] | undefined | null): string {
  // Next hands a repeated key through as an array. Take the first, the way a
  // server reading a query string conventionally does — the alternative is
  // rejecting `?order=A&order=B` outright, which turns a duplicated parameter
  // into a worse experience than an ignored one.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return NO_SELECTED_ORDER;

  const trimmed = value.trim();
  if (!OrderNumberSchema.safeParse(trimmed).success) return NO_SELECTED_ORDER;

  // Uppercased because the panel matches by exact string against what the
  // adapter returned, and `MockMESAdapter.getOrder` is the only lookup in the
  // app that is case-insensitive. `?order=po-10382` would otherwise select
  // nothing, silently, and look exactly like a typo in the fixture.
  return trimmed.toUpperCase();
}
