import { NextResponse, type NextRequest } from "next/server";
import { authenticate, sessionFor, type LoginResult } from "@/lib/auth";
import { foLogin, isFabOrchConfigured, FabOrchRequestError } from "@/lib/faborch/client";
import { setFoTokenCookie } from "@/lib/faborch/session";
import { LoginSchema } from "@/lib/validation";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientAddress,
  recordLoginFailure,
} from "@/lib/rate-limit";

/**
 * Sign in — **two credentials, in a deliberate order.**
 *
 * 1. **The demo credential** (`DEMO_USER_*`). Opens the production order
 *    workflow, which runs entirely on this app's mock MES. No network call.
 * 2. **A FabOrchestrator account**, checked against FO's own
 *    `/api/auth/login`. Opens the same workflow *and* FabInsight, because
 *    FabInsight is FO's agent and answers with that operator's tools, role,
 *    quota and audit trail.
 *
 * Demo first because it is local and free, and because trying it second would
 * put a network round trip in front of the credential this demo has always
 * used. Neither shadows the other: they are different passwords.
 *
 * ── What a demo-credential session cannot do, and why that is right ─────────
 * It gets no FO token, so FabInsight refuses and says so. The alternative was a
 * shared service account in the environment — one FO identity for every visitor
 * — which would have made every prompt in FO's `prompt_audit_logs` attributable
 * to a machine rather than a person, and would have handed whoever holds the
 * demo URL somebody else's MES access. A demo is not a reason to build that.
 *
 * ── The FO token never reaches the browser ─────────────────────────────────
 * It is set as an httpOnly cookie (`lib/faborch/session.ts`) and read only by
 * `app/api/faborch/chat/route.ts`. The response body carries this app's own
 * session, exactly as it did before.
 *
 * ── Wrong guesses are throttled, and that is new ───────────────────────────
 * Because branch 2 forwards to a **real** FabOrchestrator, this route is the
 * only thing between a public URL and a production identity store. Eight wrong
 * guesses from one address buys a ten-minute wait — see `lib/rate-limit.ts`,
 * including what that does and does not protect against. A correct password is
 * never throttled: success clears the counter.
 */
export async function POST(req: NextRequest) {
  const address = clientAddress(req.headers);
  const verdict = checkLoginAllowed(address);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { email, password } = parsed.data;

  let demoResult: LoginResult | null;
  try {
    demoResult = authenticate(email, password);
  } catch (error) {
    // A missing SESSION_SIGNING_SECRET is a deployment fault, not a bad
    // password, and must not read as one to the operator standing at the line.
    console.error("[auth] login failed to run:", error);
    return NextResponse.json({ error: "Sign-in is not configured on this server" }, { status: 500 });
  }

  if (demoResult) {
    clearLoginFailures(address);
    return NextResponse.json({ ...demoResult, faborch: false });
  }

  // Not the demo credential. It may still be a FabOrchestrator one.
  if (!isFabOrchConfigured()) {
    recordLoginFailure(address);
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }

  let fo;
  try {
    fo = await foLogin(email, password);
  } catch (error) {
    // FO being down must not read as a wrong password. Somebody typing their
    // own credentials correctly and being told they are wrong will spend the
    // demo re-typing them.
    const message =
      error instanceof FabOrchRequestError
        ? error.message
        : "Could not reach FabOrchestrator to check those credentials.";
    console.error("[auth] FabOrchestrator sign-in failed:", error);
    return NextResponse.json({ error: message }, { status: 503 });
  }

  if (!fo) {
    recordLoginFailure(address);
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }

  // This app's own session, for an operator FO has vouched for. `roleName` is
  // not read from FO: its `/api/auth/login` response carries no role (that is
  // on `/api/auth/me`), and a second round trip to label the top nav is not
  // worth it. The label is what this app calls its operators.
  const session = sessionFor({
    id: fo.user.id,
    email: fo.user.email,
    name: fo.user.name || fo.user.email,
    roleName: process.env.DEMO_USER_ROLE ?? "Supervisor",
  });

  clearLoginFailures(address);
  const res = NextResponse.json({ ...session, faborch: true });
  setFoTokenCookie(req, res, fo.token, fo.expiresAt);
  return res;
}
