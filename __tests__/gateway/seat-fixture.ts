/**
 * A seat for the gateway tests that are not about seats.
 *
 * Since 1 October 2026 a session may use a conversation route only if it has a
 * seat and the seat store says the conversation is its own
 * (`lib/gateway/seats.ts`). The tests of deadlines, ownership proofs, session
 * ends and error pages were written before that and are about something else,
 * so they sign in on this one seat, with a store in which that seat owns the
 * conversations they name. The seat rule itself is tested in
 * `seat-isolation.test.ts` and `seat-store.test.ts`.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeRecord } from "@/lib/gateway/seat-store";

/** The seat these tests' sessions are on. */
export const TEST_SEAT = "t".repeat(43);

/**
 * Point the gateway at a fresh seat store in which `TEST_SEAT` owns `ids`.
 * Call at module load, before the first request: the store reads its file once.
 */
export function seatStoreOwning(...ids: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "seat-fixture-")), "conversations.log");
  writeFileSync(path, ids.map((id, index) => `${serializeRecord(id, TEST_SEAT, index + 1)}\n`).join(""));
  process.env.SEAT_STORE_PATH = path;
  return path;
}
