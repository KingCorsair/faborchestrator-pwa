/**
 * `MockMESAdapter` — the JSON-backed implementation of `MESAdapter`.
 *
 * The fixture is trusted input: it ships with the app and is reviewed in the
 * same pull request as the code, so it is asserted to the contract's types
 * rather than parsed at runtime. Untrusted input — the operator's search query
 * — is validated with Zod at the API boundary, which is where validation
 * actually buys something.
 */

import fixture from "./mock-data/orders.json";
import type { MESAdapter, OrderDetail, OrderQuery, OrderSummary } from "./types";

const ORDERS = fixture.orders as unknown as OrderDetail[];
const AS_OF = fixture.asOf;

const DEFAULT_LIMIT = 25;

export class MockMESAdapter implements MESAdapter {
  readonly name = "MockMESAdapter";

  async searchOrders(query: OrderQuery): Promise<OrderSummary[]> {
    const text = query.text?.trim().toLowerCase() ?? "";

    const statuses = query.statuses ?? [];

    return ORDERS.filter((order) => {
      if (statuses.length > 0 && !statuses.includes(order.status)) return false;
      if (!text) return true;
      return (
        order.orderNumber.toLowerCase().includes(text) ||
        order.product.name.toLowerCase().includes(text) ||
        order.product.code.toLowerCase().includes(text) ||
        order.machineId.toLowerCase().includes(text)
      );
    })
      // Most recently due first, so what is about to go late is at the top.
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
      .slice(0, query.limit ?? DEFAULT_LIMIT)
      .map(toSummary);
  }

  async getOrder(orderNumber: string): Promise<OrderDetail | null> {
    const wanted = orderNumber.trim().toUpperCase();
    const order = ORDERS.find((o) => o.orderNumber.toUpperCase() === wanted);
    if (!order) return null;
    return { ...order, asOf: AS_OF };
  }
}

/** Detail records are dropped rather than sent to a list screen that ignores them. */
function toSummary(order: OrderDetail): OrderSummary {
  return {
    recordId: order.recordId,
    recordType: "PRODUCTION_ORDER",
    orderNumber: order.orderNumber,
    product: order.product,
    status: order.status,
    site: order.site,
    machineId: order.machineId,
    plannedQty: order.plannedQty,
    completedQty: order.completedQty,
    dueAt: order.dueAt,
  };
}
