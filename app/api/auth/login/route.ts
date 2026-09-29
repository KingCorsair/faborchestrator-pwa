import { NextResponse, type NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { foLogin, foMe, isFabOrchConfigured, FabOrchRequestError } from "@/lib/faborch/client";
import { setFoTokenCookie } from "@/lib/faborch/session";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { LOGIN_BODY_LIMIT, LoginSchema } from "@/lib/validation";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientAddress,
  recordLoginFailure,
} from "@/lib/rate-limit";

/**
 * The label shown under the operator's name when FabOrchestrator could not say
 * what their role is.
 *
 * ── The real role, since 2026-09-28 ─────────────────────────────────────────
 * This used to be the only label: every operator was called "Supervisor",
 * because FO's login response carries no role and a second round trip was
 * judged not worth it. That put "Supervisor" under an administrator's name.
 * The role is now read from FO's own `/api/auth/me` at sign-in (`foMe`), and
 * this neutral label appears only if that read fails — a label is not worth
 * failing a sign-in over, and it claims no role at all.
 */
const ROLE_WHEN_UNKNOWN = "Signed in";

/**
 * Sign in — **FabOrchestrator is the only identity.**
 *
 * One credential: a FabOrchestrator account, checked against FO's own
 * `/api/auth/login`. It opens everything this app offers — the agents and the
 * pinned reports, all of them FabOrchestrator's.
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
 * route handlers — the agents, conversations, reports, keep-alive and sign-out
 * routes. The response body carries this app's own session, exactly as it did
 * before.
 *
 * ── Wrong guesses are throttled, and that is new ───────────────────────────
 * Because this route forwards to a **real** FabOrchestrator, it is the only
 * thing between a public URL and a production identity store. Eight wrong
 * guesses from one address buys a ten-minute wait — see `lib/rate-limit.ts`,
 * including what that does and does not protect against. A correct password is
 * never throttled: success clears the counter.
 *
 * ── The body is size-checked before it is read ─────────────────────────────
 * This is the one route anybody on the internet can reach without a session,
 * so it is the one where an unbounded `req.json()` did the most harm. See
 * `lib/request-body.ts`.
 */
export async function POST(req: NextRequest) {
  const address = clientAddress(req.headers);
  const verdict = await checkLoginAllowed(address);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
    );
  }

  const body = await readJsonBody(req, LOGIN_BODY_LIMIT);
  if (body.tooLarge) {
    return NextResponse.json(
      { error: "That sign-in request is larger than this app accepts." },
      { status: 413 },
    );
  }
  const parsed = LoginSchema.safeParse(body.value);
  if (!parsed.success) {
    // Every rule in `LoginSchema` carries its own wording, so this is always a
    // sentence written for a person — see that schema.
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Enter your email address and password." },
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
    //
    // A `FabOrchRequestError` has been reported where it happened (`fetchFo`)
    // or is FO's own refusal, which FO records itself. Anything else is this
    // app's surprise, and is reported here.
    if (!(error instanceof FabOrchRequestError)) reportError("auth/login", error);
    const message =
      error instanceof FabOrchRequestError
        ? error.message
        : "Could not reach FabOrchestrator to check those credentials.";
    return NextResponse.json({ error: message }, { status: 503 });
  }

  if (!fo) {
    await recordLoginFailure(address);
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }

  // The operator's real role, from FO's own `/api/auth/me` — its login
  // response carries none. One more round trip, bounded like every call to FO,
  // and never allowed to fail the sign-in: if it does not answer, the label is
  // neutral rather than wrong.
  const me = await foMe(fo.token).catch(() => null);

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
      roleName: me?.roleName ?? ROLE_WHEN_UNKNOWN,
    },
    fo.expiresAt,
    fo.token,
  );

  await clearLoginFailures(address);
  const res = NextResponse.json({ ...session, faborch: true });
  setFoTokenCookie(req, res, fo.token, fo.expiresAt);
  return res;
}
