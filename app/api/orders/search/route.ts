import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { mes } from "@/lib/mes";
import { OrderSearchSchema } from "@/lib/validation";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const params = req.nextUrl.searchParams;
  const statuses = params.getAll("status");
  const parsed = OrderSearchSchema.safeParse({
    text: params.get("text") ?? undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid search" },
      { status: 400 },
    );
  }

  const orders = await mes.searchOrders(parsed.data);
  // `source` travels with the data so the UI can say where it came from. A
  // demo that cannot be told apart from live MES data is a hazard, not a demo.
  return NextResponse.json({ orders, source: mes.name });
}
