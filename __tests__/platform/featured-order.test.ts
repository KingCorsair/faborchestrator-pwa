/**
 * `featuredOrder` — what the landing page opens on.
 *
 * The front door renders a real order with its real severities. That is only
 * safe while the card is *derived*, and these tests pin the two properties
 * that make it so: the facts come from the same rules the order screen runs,
 * and the card disappears rather than lying when there is nothing to show.
 *
 * The second one is the reason this file exists. `PO-10344` used to report a
 * HIGH problem and stopped on 2026-08-12, when the delay rule learned that a
 * completed order is not behind schedule. A front door that had hard-coded
 * that severity would still be announcing it; a front door that derives it has
 * to have somewhere sensible to land instead, and "nothing" is that place.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FEATURED_ORDER_NUMBER, featuredOrder } from "../../lib/featured-order";
import { detectIssues, mes } from "../../lib/mes";

test("opens on the scenario order, with the facts the adapter holds", async () => {
  const featured = await featuredOrder();
  assert.ok(featured, "the demo's own scenario order must resolve");

  const order = await mes.getOrder(FEATURED_ORDER_NUMBER);
  assert.ok(order);

  assert.equal(featured.orderNumber, order.orderNumber);
  assert.equal(featured.productName, order.product.name);
  assert.equal(featured.machineId, order.machineId);
  assert.equal(featured.status, order.status);
});

test("carries exactly the issues the rules detected, worst first", async () => {
  const featured = await featuredOrder();
  const order = await mes.getOrder(FEATURED_ORDER_NUMBER);
  assert.ok(featured && order);

  const detected = detectIssues(order);
  assert.deepEqual(
    featured.issues,
    detected.map((issue) => ({ type: issue.type, severity: issue.severity })),
  );

  // The scenario the whole demo is built around: all three rules fire, and the
  // pill a supervisor reads first is the worst one.
  assert.equal(featured.issues.length, 3);
  assert.equal(featured.issues[0].severity, "HIGH");
});

test("shows nothing rather than a clean order", async () => {
  // Completed, and correctly carrying no issues since the 2026-08-12 rule fix.
  const order = await mes.getOrder("PO-10344");
  assert.ok(order);
  assert.equal(detectIssues(order).length, 0, "fixture drifted — pick another clean order");

  assert.equal(await featuredOrder("PO-10344"), null);
});

test("shows nothing rather than inventing an order that is gone", async () => {
  assert.equal(await featuredOrder("PO-00000"), null);
});
