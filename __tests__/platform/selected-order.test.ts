/**
 * `safeSelectedOrder` — which order `/orders` opens its review panel on.
 *
 * The parameter exists to close the workflow: the order screen shows the
 * evidence, the review panel records the decision, and before 2026-08-20 the
 * order did not travel between them. What made that urgent rather than untidy
 * is where the panel lands without it — the first row of the list, which is a
 * *different* order, completed and carrying no detected issues. A supervisor
 * could read one order's evidence and decide on another.
 *
 * So the two things worth pinning are: a real order number survives the trip
 * intact, and everything else degrades to `""` — the value the page held
 * before this parameter existed, which puts the panel back on its documented
 * fallback instead of into a state nobody designed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NO_SELECTED_ORDER, safeSelectedOrder } from "../../lib/selected-order";

test("carries an order number across the route boundary", () => {
  assert.equal(safeSelectedOrder("PO-10382"), "PO-10382");
  assert.equal(safeSelectedOrder("PO-10344"), "PO-10344");
});

test("normalises case, because the panel matches by exact string", () => {
  // `MockMESAdapter.getOrder` is case-insensitive, so `/orders/po-10382`
  // resolves to a real order — and would hand the panel a value matching no row.
  assert.equal(safeSelectedOrder("po-10382"), "PO-10382");
  assert.equal(safeSelectedOrder("  Po-10382  "), "PO-10382");
});

test("falls back when nothing is asked for", () => {
  assert.equal(safeSelectedOrder(undefined), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder(null), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder(""), NO_SELECTED_ORDER);
});

test("takes the first value when the key repeats", () => {
  assert.equal(safeSelectedOrder(["PO-10382", "PO-10344"]), "PO-10382");
  assert.equal(safeSelectedOrder([]), NO_SELECTED_ORDER);
});

test("rejects anything that is not an order number", () => {
  assert.equal(safeSelectedOrder("PO-"), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder("10382"), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder("WO-10382"), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder("PO-10382; DROP TABLE"), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder("../../etc/passwd"), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder("<script>alert(1)</script>"), NO_SELECTED_ORDER);
});

test("rejects an order number with something appended to it", () => {
  // The regex is anchored; these are the values that would slip past an
  // unanchored one and reach the panel as a selection matching no row.
  assert.equal(safeSelectedOrder("PO-10382x"), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder("xPO-10382"), NO_SELECTED_ORDER);
  assert.equal(safeSelectedOrder("PO-10382\nPO-10344"), NO_SELECTED_ORDER);
});

test("rejects a number long enough to be something other than an order", () => {
  assert.equal(safeSelectedOrder("PO-12345678901"), NO_SELECTED_ORDER);
});
