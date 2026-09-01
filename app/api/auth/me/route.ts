import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { foTokenFrom } from "@/lib/faborch/session";

/**
 * Shaped exactly like FabOrchestrator's `/api/auth/me` — `user.role.name`, not
 * `user.roleName` — because the ported `useConsoleSession` reads that shape and
 * is otherwise unmodified from the product's copy.
 *
 * `faborch` is this app's own addition and sits beside `user`, not inside it:
 * it is a fact about the session, not about the person. The FabInsight screen
 * reads it to decide what to render **before** the operator types a prompt —
 * finding out that a session cannot reach FabOrchestrator by having a question
 * rejected is a worse way to learn it. It reports only whether a token is
 * attached; whether FO still honours it is FO's answer, and the chat route
 * relays that.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { user } = auth;
  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: { name: user.roleName },
    },
    faborch: foTokenFrom(req) !== null,
  });
}
