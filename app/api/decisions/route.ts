import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { DECISIONS_ARE_DURABLE, currentDecisions } from "@/lib/decisions";

/**
 * GET — the decision standing on every order that has one, newest first, each
 * carrying the decisions it replaced.
 *
 * The review screen's source. Distinct from `GET /api/activity` on purpose:
 * activity is a flat event log answering *what happened*, this is one row per
 * order answering *what stands*. A manager looking for approvals to revisit
 * should not have to work out which of four rows on PO-10382 is still in force.
 *
 * Read-only. Overrides go to `POST /api/orders/[orderId]/decision` — the same
 * route a first decision goes to, so there is one place that appends to the log.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    decisions: await currentDecisions(),
    durable: DECISIONS_ARE_DURABLE,
  });
}
