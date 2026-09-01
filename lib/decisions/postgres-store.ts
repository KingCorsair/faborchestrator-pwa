/**
 * The durable decision log — Postgres, one insert-only table.
 *
 * ── Why `pg` and not Prisma (2026-08-19) ────────────────────────────────────
 * The product uses Prisma 7 + PostgreSQL, and "reuse before adding" says follow
 * it. This deliberately does not, and the reason is worth keeping.
 *
 * **Prisma 7 no longer connects on its own.** It dropped `url` from the
 * datasource block and requires a driver adapter — `@prisma/adapter-pg`, over
 * `pg`. So the driver underneath is `pg` either way, and Prisma would sit on
 * top of it as a query builder and a migration tool. Against one append-only
 * table with nine columns and five queries, that buys a generated client, a
 * `prisma.config.ts`, an engine download and a `prisma generate` step in the
 * Dockerfile. This file's own repo already documents what a build step that
 * silently does not run costs: a host skipping lifecycle scripts ships a dead
 * scanner. A second one of those, holding the audit trail, is a bad trade.
 *
 * It is the same call this project already made twice — hand-written components
 * rather than Radix and 26 shadcn files for two screens, hand-rolled Code 39
 * rather than a second wasm for a demo prop.
 *
 * **What it costs:** no migration history and no generated types. The table is
 * created by `CREATE TABLE IF NOT EXISTS` on first use, and rows are mapped by
 * hand in `toDecision`. That is defensible for one table that only ever gains
 * inserts, and it is the thing to revisit the moment a second table appears —
 * at which point the product's Prisma is the right destination anyway.
 *
 * ── Insert-only, by construction ────────────────────────────────────────────
 * There is no UPDATE and no DELETE in this file. An override is a new row
 * carrying `supersedes_id`; the original stays exactly as it was written. That
 * is the single property an audit trail exists to have, and expressing it as an
 * absence is stronger than a comment promising it.
 */

import { Pool } from "pg";
import {
  decisionId,
  decisionSeq,
  groupByOrder,
  type Decision,
  type DecisionInput,
  type DecisionKind,
  type DecisionStore,
  type OrderDecision,
} from "./types";

interface Row {
  seq: number | string;
  order_number: string;
  decision: string;
  note: string | null;
  decided_by_email: string;
  decided_at: Date;
  recommended_action: string | null;
  analysis_source: string;
  supersedes_id: string | null;
}

/**
 * `seq` arrives as a string from `pg` when the column is `bigint`; it is `int`
 * here, so it arrives as a number. Coerced anyway — a decision id silently
 * becoming `DEC-NaN` is the kind of thing that only shows up in an audit six
 * weeks later.
 */
function toDecision(row: Row): Decision {
  const seq = Number(row.seq);
  return {
    id: decisionId(seq),
    orderNumber: row.order_number,
    decision: row.decision as DecisionKind,
    ...(row.note ? { note: row.note } : {}),
    decidedByEmail: row.decided_by_email,
    decidedAt: row.decided_at.toISOString(),
    recommendedAction: row.recommended_action,
    analysisSource: row.analysis_source as Decision["analysisSource"],
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
  };
}

const COLUMNS = `seq, order_number, decision, note, decided_by_email,
                 decided_at, recommended_action, analysis_source, supersedes_id`;

/**
 * Created on first use rather than by a migration step.
 *
 * `IF NOT EXISTS` makes it idempotent, so every process may run it and a
 * redeploy is a no-op. The order-number index is the one query shape that is
 * not "the whole table newest-first" — every screen either reads one order or
 * reads the feed.
 *
 * **`order_number` is stored uppercased** by the writer, and every lookup
 * uppercases too, matching the case-insensitivity every other lookup in this
 * app already has.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS decisions (
    seq                SERIAL PRIMARY KEY,
    order_number       VARCHAR(32)  NOT NULL,
    decision           VARCHAR(16)  NOT NULL,
    note               TEXT,
    decided_by_email   TEXT         NOT NULL,
    decided_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    recommended_action TEXT,
    analysis_source    VARCHAR(8)   NOT NULL,
    supersedes_id      VARCHAR(16)
  );
  CREATE INDEX IF NOT EXISTS decisions_order_seq ON decisions (order_number, seq);
`;

export function createPostgresStore(connectionString: string): DecisionStore {
  const pool = new Pool({
    connectionString,
    // Managed Postgres (Neon, Supabase, Railway) terminates TLS with a
    // certificate this container has no root for. The connection is still
    // encrypted; what is skipped is verifying the far end, which is the
    // trade every one of those providers' own connection strings makes.
    ssl: /\bsslmode=disable\b/.test(connectionString) ? false : { rejectUnauthorized: false },
    // A single long-lived web process with a handful of queries per request.
    max: 5,
  });

  // Once per process, awaited by every call. Sharing the promise rather than a
  // boolean means two concurrent requests on a cold process cannot both race to
  // create the table.
  let ready: Promise<void> | null = null;
  const ensureSchema = () => (ready ??= pool.query(SCHEMA).then(() => undefined));

  async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    await ensureSchema();
    const result = await pool.query(sql, params);
    return result.rows as T[];
  }

  return {
    durable: true,

    async record(input: DecisionInput): Promise<Decision> {
      const rows = await query<Row>(
        `INSERT INTO decisions
           (order_number, decision, note, decided_by_email,
            recommended_action, analysis_source, supersedes_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [
          input.orderNumber.toUpperCase(),
          input.decision,
          input.note ?? null,
          input.decidedByEmail,
          input.recommendedAction,
          input.analysisSource,
          input.supersedesId ?? null,
        ],
      );
      return toDecision(rows[0]);
    },

    async forOrder(orderNumber: string): Promise<Decision[]> {
      const rows = await query<Row>(
        `SELECT ${COLUMNS} FROM decisions WHERE order_number = $1 ORDER BY seq ASC`,
        [orderNumber.toUpperCase()],
      );
      return rows.map(toDecision);
    },

    async all(limit = 100): Promise<Decision[]> {
      // By `seq`, not by `decided_at`: two decisions inside the same
      // millisecond would tie on the timestamp, and the feed's order would
      // depend on how Postgres felt about it that day.
      const rows = await query<Row>(
        `SELECT ${COLUMNS} FROM decisions ORDER BY seq DESC LIMIT $1`,
        [limit],
      );
      return rows.map(toDecision);
    },

    async byId(id: string): Promise<Decision | null> {
      const seq = decisionSeq(id);
      if (seq === null) return null;
      const rows = await query<Row>(`SELECT ${COLUMNS} FROM decisions WHERE seq = $1`, [seq]);
      return rows[0] ? toDecision(rows[0]) : null;
    },

    async currentFor(orderNumber: string): Promise<Decision | null> {
      const rows = await query<Row>(
        `SELECT ${COLUMNS} FROM decisions WHERE order_number = $1 ORDER BY seq DESC LIMIT 1`,
        [orderNumber.toUpperCase()],
      );
      return rows[0] ? toDecision(rows[0]) : null;
    },

    async current(): Promise<OrderDecision[]> {
      // Grouped in `groupByOrder` rather than by a window function, so both
      // stores share one definition of which decision is standing. At demo
      // scale the whole table is a few hundred rows; when that stops being
      // true this becomes `DISTINCT ON (order_number) ... ORDER BY seq DESC`
      // plus a second query for the trail.
      const rows = await query<Row>(`SELECT ${COLUMNS} FROM decisions ORDER BY seq ASC`);
      return groupByOrder(rows.map(toDecision));
    },
  };
}
