import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { currentDecisionFor, decisionById, decisionsFor, recordDecision } from "@/lib/decisions";
import { mes } from "@/lib/mes";
import { DecisionSchema, OrderNumberSchema } from "@/lib/validation";

/**
 * Approve / Reject / Escalate — and override a decision already recorded.
 *
 * **This records a decision. It does not act on one.** Nothing here writes to
 * the MES, changes the order, or notifies a machine — the `MESAdapter` contract
 * has no write method to call. That is rule 8 enforced by the shape of the
 * code rather than by a promise in a comment. An override is the same thing: a
 * manager overruling an approval changes the record, never the shop floor.
 *
 * **One write path, on purpose.** The review screen at `/decisions` posts here
 * rather than to a route of its own. A second endpoint that also appends to the
 * decision log would be a second place to keep the session-derived author, the
 * order check and the inheritance rules correct.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { orderId } = await params;
  const parsedId = OrderNumberSchema.safeParse(orderId);
  if (!parsedId.success) {
    return NextResponse.json({ error: parsedId.error.issues[0].message }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = DecisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid decision" },
      { status: 400 },
    );
  }

  // A decision against an order that does not exist is a client bug, and
  // silently logging it would put an unresolvable row in the audit trail.
  const order = await mes.getOrder(parsedId.data);
  if (!order) {
    return NextResponse.json({ error: `No order ${parsedId.data.toUpperCase()}` }, { status: 404 });
  }

  // An override inherits the advice it answers from the decision it replaces,
  // rather than trusting the client to restate it.
  let recommendedAction: string | null = parsed.data.recommendedAction ?? null;
  let analysisSource = parsed.data.analysisSource;

  if (parsed.data.supersedesId) {
    const supersedesId = parsed.data.supersedesId.toUpperCase();
    const superseded = await decisionById(supersedesId);

    if (!superseded || superseded.orderNumber.toUpperCase() !== order.orderNumber.toUpperCase()) {
      return NextResponse.json(
        { error: `No decision ${supersedesId} on ${order.orderNumber}` },
        { status: 404 },
      );
    }

    // Optimistic concurrency. Overriding anything but the standing decision
    // means the screen was showing a decision somebody has already replaced —
    // recording it would silently undo their change and leave two rows each
    // claiming to supersede the same one. Reload and look again.
    const standing = await currentDecisionFor(order.orderNumber);
    if (standing && standing.id !== superseded.id) {
      return NextResponse.json(
        {
          error: `${supersedesId} is no longer the standing decision on ${order.orderNumber} — ${standing.id} is.`,
          currentId: standing.id,
        },
        { status: 409 },
      );
    }

    recommendedAction = superseded.recommendedAction;
    analysisSource = superseded.analysisSource;
  }

  // `analysisSource` is guaranteed present by here: DecisionSchema requires it
  // on a first decision, and the override branch above assigns it from the
  // record. `recommendedAction` is null exactly when the source is "none",
  // which the schema already enforces — a decision taken without an analysis.
  if (!analysisSource) {
    return NextResponse.json({ error: "Missing recommendation context" }, { status: 400 });
  }
  if (analysisSource === "none") recommendedAction = null;

  const decision = await recordDecision({
    orderNumber: order.orderNumber,
    decision: parsed.data.decision,
    note: parsed.data.note,
    recommendedAction,
    analysisSource,
    decidedByEmail: auth.user.email,
    supersedesId: parsed.data.supersedesId?.toUpperCase(),
  });

  return NextResponse.json({ decision, history: await decisionsFor(order.orderNumber) });
}

/** GET — the decisions recorded against this order, oldest first. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { orderId } = await params;
  const parsedId = OrderNumberSchema.safeParse(orderId);
  if (!parsedId.success) {
    return NextResponse.json({ error: parsedId.error.issues[0].message }, { status: 400 });
  }

  return NextResponse.json({ history: await decisionsFor(parsedId.data) });
}
