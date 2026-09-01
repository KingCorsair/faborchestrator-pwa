/**
 * The in-memory decision log — the original store, kept.
 *
 * ⚠ **Per-process, and that is a real limitation rather than a placeholder
 * detail.** It empties on every restart, on every hot reload in dev, and on
 * every redeploy; it is not shared between instances behind a load balancer.
 * `durable` is `false`, which both screens render, because a log that forgets
 * and does not admit it is worse than no log.
 *
 * ── Why it survives Tier 3 ──────────────────────────────────────────────────
 * It is what runs when `DATABASE_URL` is unset: `npm run dev` on a laptop with
 * no Postgres, the unit suites, and the design-review harness. The alternative
 * was making a database a prerequisite for running the app at all, which would
 * have made every test and every local session slower to set up in exchange for
 * fidelity that only the deployed instance needs.
 *
 * It is also the honest fallback. A demo that refuses to start because a
 * database is unreachable is worse than one that starts and says out loud that
 * nothing it records will survive.
 */

import {
  decisionId,
  decisionSeq,
  groupByOrder,
  type Decision,
  type DecisionInput,
  type DecisionStore,
  type OrderDecision,
} from "./types";

export function createMemoryStore(): DecisionStore {
  /** Keyed by uppercased order number; each list is oldest-first. */
  const log = new Map<string, Decision[]>();
  let counter = 0;

  return {
    durable: false,

    async record(input: DecisionInput): Promise<Decision> {
      const decision: Decision = {
        ...input,
        id: decisionId(++counter),
        decidedAt: new Date().toISOString(),
      };

      const key = input.orderNumber.toUpperCase();
      log.set(key, [...(log.get(key) ?? []), decision]);
      return decision;
    },

    async forOrder(orderNumber: string): Promise<Decision[]> {
      return log.get(orderNumber.toUpperCase()) ?? [];
    },

    async all(limit = 100): Promise<Decision[]> {
      // Sorted by timestamp and then by id rather than by insertion, so this
      // stays correct against a store whose rows arrive in no promised order.
      return [...log.values()]
        .flat()
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || b.id.localeCompare(a.id))
        .slice(0, limit);
    },

    async byId(id: string): Promise<Decision | null> {
      if (decisionSeq(id) === null) return null;
      for (const decisions of log.values()) {
        const found = decisions.find((d) => d.id.toUpperCase() === id.trim().toUpperCase());
        if (found) return found;
      }
      return null;
    },

    async currentFor(orderNumber: string): Promise<Decision | null> {
      const decisions = log.get(orderNumber.toUpperCase()) ?? [];
      return decisions.at(-1) ?? null;
    },

    async current(): Promise<OrderDecision[]> {
      return groupByOrder([...log.values()].flat());
    },
  };
}
