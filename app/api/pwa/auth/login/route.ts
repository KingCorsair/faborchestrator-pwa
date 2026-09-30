import { NextResponse, type NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import {
  foLogin,
  foLogout,
  foMe,
  isFabOrchConfigured,
  FabOrchRequestError,
} from "@/lib/faborch/client";
import { reportError } from "@/lib/report-error";
import { setFoTokenCookie } from "@/lib/faborch/session";
import { readJsonBody } from "@/lib/request-body";
import { LOGIN_BODY_LIMIT, LoginSchema } from "@/lib/validation";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientAddress,
  recordLoginFailure,
} from "@/lib/rate-limit";

/**
 * The label used when FabOrchestrator could not say what the operator's role
 * is. It claims no role at all: "Supervisor" used to appear under an
 * administrator's name. (Dropping the label entirely is RP8's N6 residue,
 * gated on FO confirming its embedded client does not read `roleName`.)
 */
const ROLE_WHEN_UNKNOWN = "Signed in";

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

  // Size before content: this is the one route anybody can reach without a
  // session. The code and `details.limit` are the plan's (RP5 part 1).
  const body = await readJsonBody(req, LOGIN_BODY_LIMIT);
  if (body.tooLarge) {
    return NextResponse.json(
      {
        code: "body_too_large",
        error: "That sign-in request is larger than this app accepts.",
        details: { limit: LOGIN_BODY_LIMIT },
      },
      { status: 413 },
    );
  }
  const parsed = LoginSchema.safeParse(body.value);
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
    reportError("auth/not-configured", new Error("FABORCH_BASE_URL is not set; sign-in cannot work"));
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
    // A timeout or an unreachable FO was reported inside `fetchFo`; anything
    // else is this app's surprise.
    if (!(error instanceof FabOrchRequestError)) reportError("auth/login", error);
    return NextResponse.json({ error: message }, { status: 503 });
  }

  if (!fo) {
    recordLoginFailure(address);
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }

  // One extra FO call, `/api/auth/me` with the new token (plan RP2, login
  // step 2; `foMe` ported from the chetan branch). FO's login has just set its
  // idle clock, so this extends nothing. It yields the real role, and two
  // answers that change the outcome:
  //
  //  - 403 "no longer active" after a correct password: a coded failure, not
  //    "wrong password", and the token FO just minted is revoked before we
  //    answer so no session row is left behind. Not counted as a failed guess.
  //  - 401 for a token FO issued a moment ago: 502 `upstream_error`, and the
  //    token is revoked the same way.
  //
  // A forced password change (403 FORCE_PASSWORD_CHANGE) signs in as before:
  // FabOrchestrator's own pages hold the operator at /force-password-change,
  // which is in the gateway's document catalogue. Any other failure (timeout,
  // unreachable, 5xx) costs only the label.
  let roleName: string | null = null;
  try {
    const me = await foMe(fo.token);
    if (me.kind === "inactive") {
      await foLogout(fo.token);
      return NextResponse.json(
        {
          code: "account_inactive",
          error: "This account is no longer active. Contact your administrator.",
        },
        { status: 403 },
      );
    }
    if (me.kind === "unauthorized") {
      await foLogout(fo.token);
      return NextResponse.json(
        {
          code: "upstream_error",
          error: "FabOrchestrator did not confirm the new session. Try signing in again.",
        },
        { status: 502 },
      );
    }
    if (me.kind === "ok") roleName = me.roleName;
  } catch (error) {
    // A timeout or an unreachable FO has already been reported by `fetchFo`.
    if (!(error instanceof FabOrchRequestError)) reportError("auth/me-probe", error);
  }

  // This app's own session, for an operator FO has vouched for.
  //
  // `fo.expiresAt` caps this session at FabOrchestrator's own expiry, so the
  // PWA can never hold a session that outlives the token behind it — see
  // `sessionFor`.
  const session = sessionFor(
    {
      id: fo.user.id,
      email: fo.user.email,
      name: fo.user.name || fo.user.email,
      roleName: roleName ?? ROLE_WHEN_UNKNOWN,
    },
    fo.expiresAt,
    fo.token,
  );

  clearLoginFailures(address);
  const res = NextResponse.json({ ...session, faborch: true });
  setFoTokenCookie(req, res, fo.token, fo.expiresAt);
  return res;
}
