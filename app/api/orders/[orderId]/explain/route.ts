import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-middleware";
import { AnalysisUnavailableError, analyzeOrder } from "@/lib/ai/analyze";
import { detectIssues, mes } from "@/lib/mes";
import { OrderNumberSchema } from "@/lib/validation";

/** The model call needs longer than Next's default serverless budget. */
export const maxDuration = 60;

/**
 * POST — explain this order's detected problems.
 *
 * The rules run **here**, server-side, on facts fetched here. The client does
 * not get to say which issues fired or how severe they are: if it could, the
 * severity a supervisor sees would be whatever the last request claimed.
 */
export async function POST(
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

  const issues = detectIssues(order);

  /*
   * Nothing fired, so there is nothing to explain — and asking anyway is how
   * this product breaks its own first rule.
   *
   * Handed an empty issue list the model still answers, because that is what
   * models do: it would read the order and volunteer a problem the rules did
   * not detect. Grounding catches the shape of that (`unfiredIssueTypes` fails
   * every type it could name) but only after two API calls, and the analysis is
   * then shown unbadged rather than suppressed — which puts an invented problem
   * in front of a supervisor.
   *
   * The screen already hides the Explain button at zero issues, so this is
   * defence in depth on a public authenticated route. It became reachable on
   * 2026-08-12, when fixing PRODUCTION_DELAY left PO-10344 and PO-10402 with no
   * issues at all for the first time.
   *
   * 422 rather than 404: the order exists and the request is well-formed. The
   * order simply has no problem, which is a good answer, not an error.
   */
  if (issues.length === 0) {
    return NextResponse.json(
      {
        error: "Nothing to explain",
        detail: `No rule fired on ${order.orderNumber}. The AI explains problems the deterministic rules detected; it is never asked to look for one.`,
      },
      { status: 422 },
    );
  }

  try {
    const result = await analyzeOrder(order, issues);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AnalysisUnavailableError) {
      // 503: the order and its issues are fine, the explanation is not
      // available right now. Distinguishable from a 400/404 so the screen can
      // offer a retry rather than telling the operator they typed something
      // wrong.
      return NextResponse.json(
        { error: "Analysis unavailable", reason: error.reason, detail: error.detail },
        { status: 503 },
      );
    }
    console.error("[explain] unexpected failure:", error);
    return NextResponse.json({ error: "Analysis failed" }, { status: 500 });
  }
}
