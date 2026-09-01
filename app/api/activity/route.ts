import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { DECISIONS_ARE_DURABLE, allDecisions } from "@/lib/decisions";

/**
 * GET — every decision recorded, newest first.
 *
 * Read-only, like everything else that is not `POST /decision`. The feed shows
 * what supervisors decided; it is not a second place decisions can be made.
 *
 * `durable` rides along so the screen can say out loud that this log does not
 * survive a restart. That is true today (`lib/decisions.ts` is a module-scope
 * Map) and it stops being true in Tier 3 — at which point this flag flips in one
 * place rather than a caveat being hunted for across three screens.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    activity: await allDecisions(),
    durable: DECISIONS_ARE_DURABLE,
  });
}
