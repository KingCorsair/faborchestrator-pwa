/**
 * The decision log — and the only file that picks which store is behind it.
 *
 * Exactly the shape `lib/mes/index.ts` uses for the MES adapter, and for the
 * same reason: nothing above this line may care whether decisions are held in
 * memory or in Postgres. The routes call these five functions and read
 * `DECISIONS_ARE_DURABLE`; they did before Tier 3 and they do after.
 *
 * ── How the store is chosen ─────────────────────────────────────────────────
 * `DATABASE_URL` set → Postgres, durable. Unset → the in-memory Map, which says
 * so. There is no third setting and no way to ask for the Map when a database
 * is configured: a deployment that has a database and quietly is not using it
 * is the failure mode this whole tier exists to end.
 *
 * **It does not fall back on a connection error.** If Postgres is configured
 * and unreachable, the routes fail and say so. Falling back to memory would
 * mean an app that reports `durable: true` while writing to something that
 * forgets — the exact dishonesty the `durable` flag was added to prevent.
 *
 * ── Module scope, deliberately ──────────────────────────────────────────────
 * One store per process, created on first import. The Postgres pool wants to be
 * long-lived, and in dev Next re-imports modules on hot reload — which is
 * survivable here because a pool is cheap and the previous one is garbage
 * collected, and because the data no longer lives in the module.
 */

import { createMemoryStore } from "./memory-store";
import { createPostgresStore } from "./postgres-store";
import type { Decision, DecisionInput, DecisionStore, OrderDecision } from "./types";

export type { Decision, DecisionInput, DecisionKind, OrderDecision } from "./types";

function selectStore(): DecisionStore {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return createMemoryStore();
  return createPostgresStore(url);
}

const store = selectStore();

/**
 * Whether the log survives a restart, read off whichever store is active.
 *
 * Surfaced by `GET /api/activity` and `GET /api/decisions` and rendered on both
 * screens. It was a hard-coded `false` until Tier 3; it is now the truth about
 * this deployment, which is the whole point of having said it out loud all
 * along.
 */
export const DECISIONS_ARE_DURABLE = store.durable;

export function recordDecision(input: DecisionInput): Promise<Decision> {
  return store.record(input);
}

export function decisionsFor(orderNumber: string): Promise<Decision[]> {
  return store.forOrder(orderNumber);
}

export function allDecisions(limit?: number): Promise<Decision[]> {
  return store.all(limit);
}

export function decisionById(id: string): Promise<Decision | null> {
  return store.byId(id);
}

export function currentDecisionFor(orderNumber: string): Promise<Decision | null> {
  return store.currentFor(orderNumber);
}

export function currentDecisions(): Promise<OrderDecision[]> {
  return store.current();
}
