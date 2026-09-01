import { NextResponse, type NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
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
 * What this app calls its operators in the top bar.
 *
 * FabOrchestrator's login response carries no role — that lives on its
 * `/api/auth/me` — and a second round trip to label a nav item is not worth
 * making a person wait for. Previously this read `DEMO_USER_ROLE`, which
 * outlived the demo credential it belonged to.
 */
const DEFAULT_ROLE_LABEL = "Supervisor";

/**
 * Sign in — **FabOrchestrator is the only identity.**
 *
 * One credential: a FabOrchestrator account, checked against FO's own
 * `/api/auth/login`. It opens everything this app offers — the agents, and the
 * production order workflow that runs on the local mock MES.
 *
 * ── Why the demo credential was removed (WP2, 2026-09-01) ───────────────────
 * This route used to try a local `DEMO_USER_*` pair first. It authenticated
 * with no network call and issued a session with **no FO token**, so the
 * operator reached the app, opened an agent, and found the composer disabled —
 * a session that looks signed in and cannot ask a single question. That is
 * indistinguishable from a broken app, and it was reported as one.
 *
 * The alternative that was rejected at the same time is worth recording:
 * carrying a shared FO service account in the environment so any visitor gets
 * agent access. It would make every row in FO's `prompt_audit_logs`
 * attributable to a machine rather than a person, and hand whoever holds the
 * demo URL somebody else's MES access. A demo is not a reason to build that;
 * asking each person for their own FO credential is.
 *
 * ── The FO token never reaches the browser ─────────────────────────────────
 * It is set as an httpOnly cookie (`lib/faborch/session.ts`) and read only by
 * `app/api/faborch/chat/route.ts`. The response body carries this app's own
 * session, exactly as it did before.
 *
 * ── Wrong guesses are throttled, and that is new ───────────────────────────
 * Because this route forwards to a **real** FabOrchestrator, it is the only
 * thing between a public URL and a production identity store. Eight wrong
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

  // No FabOrchestrator, no sign-in. This is a **deployment fault, not a bad
  // password**, and saying "incorrect email or password" here — as this route
  // did while a local demo credential still existed — would send an operator
  // to retype a password that was never going to be checked by anything.
  if (!isFabOrchConfigured()) {
    console.error("[auth] FABORCH_BASE_URL is not set; sign-in cannot work");
    return NextResponse.json(
      { error: "Sign-in is not configured on this server: FabOrchestrator is not reachable." },
      { status: 503 },
    );
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
  //
  // `fo.expiresAt` caps this session at FabOrchestrator's own expiry, so the
  // PWA can never hold a session that outlives the token behind it — see
  // `sessionFor`.
  const session = sessionFor(
    {
      id: fo.user.id,
      email: fo.user.email,
      name: fo.user.name || fo.user.email,
      roleName: DEFAULT_ROLE_LABEL,
    },
    fo.expiresAt,
  );

  clearLoginFailures(address);
  const res = NextResponse.json({ ...session, faborch: true });
  setFoTokenCookie(req, res, fo.token, fo.expiresAt);
  return res;
}
