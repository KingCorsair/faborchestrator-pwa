import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { detectIssues, mes } from "@/lib/mes";
import { OrderNumberSchema } from "@/lib/validation";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { orderId } = await params;
  const parsed = OrderNumberSchema.safeParse(orderId);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const order = await mes.getOrder(parsed.data);
  if (!order) {
    return NextResponse.json({ error: `No order ${parsed.data.toUpperCase()}` }, { status: 404 });
  }

  // Issues are computed server-side and sent with the order, so the client
  // never holds the thresholds and two clients can never disagree about the
  // severity of the same order.
  return NextResponse.json({ order, issues: detectIssues(order), source: mes.name });
}
