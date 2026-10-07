import { NextResponse, type NextRequest } from "next/server";
import { sessionFor, sessionKeyRing } from "@/lib/auth";
import {
  foLogin,
  foMe,
  isFabOrchConfigured,
  FabOrchRequestError,
  type FoSession,
} from "@/lib/faborch/client";
import { foFingerprint } from "@/lib/auth";
import { deviceAudit } from "@/lib/devices/audit";
import { DEVICE_NOT_APPROVED, deviceGateMode } from "@/lib/devices/gate";
import { verifyDeviceSignIn } from "@/lib/devices/proof";
import { deviceStore, DeviceStoreUnavailableError, type Device } from "@/lib/devices/store";
import { deviceKeyFrom, newDeviceKey, seatIdFor, setDeviceCookie } from "@/lib/faborch/device";
import { revokeFoSession, sessionConfigProblems, type SessionEndReason } from "@/lib/faborch/end-session";
import { clearPasswordChangeMark, passwordChangeMarkedFor } from "@/lib/faborch/password-mark";
import { foTokenFrom, sessionCookieGraceSeconds, setFoTokenCookie } from "@/lib/faborch/session";
import { classify, readRegistry } from "@/lib/gateway/registry";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { LOGIN_BODY_LIMIT, LoginSchema } from "@/lib/validation";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientAddress,
  recordLoginFailure,
} from "@/lib/rate-limit";

// Plan RP2 part 5 asks for a refusal at startup when the signing keys or the
// cookie grace are unusable. Until RP10-B's server entry exists there is no
// startup to refuse, so an unusable setting is reported once, when this route
// is loaded, and every sign-in answers `not_configured` before FabOrchestrator
// is asked anything. Not during `next build`, which runs without the secrets.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  for (const setting of sessionConfigProblems()) {
    reportError("auth/session-config", new Error("unusable session setting"), { setting });
  }
}

/**
 * The label used when FabOrchestrator could not say what the operator's role
 * is. It claims no role at all: "Supervisor" used to appear under an
 * administrator's name. (Dropping the label entirely is RP8's N6 residue,
 * gated on FO confirming its embedded client does not read `roleName`.)
 */
const ROLE_WHEN_UNKNOWN = "Signed in";

/** Where FabOrchestrator holds a user whose password must change (plan RP2, G20). */
const FORCED_CHANGE_PAGE = "/force-password-change";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Sign in — **FabOrchestrator is the only identity.**
 *
 * One credential: a FabOrchestrator account, checked against FO's own
 * `/api/auth/login`. It opens the whole embedded FabOrchestrator.
 *
 * ── Why the demo credential was removed (WP2, 2026-09-01) ───────────────────
 * This route used to try a local `DEMO_USER_*` pair first. It authenticated
 * with no network call and issued a session with **no FO token**, so the
 * operator reached the app, opened an agent, and found the composer disabled —
 * a session that looks signed in and cannot ask a single question. The
 * alternative rejected at the same time, a shared FO service account in the
 * environment, would make every row in FO's audit attributable to a machine
 * rather than a person.
 *
 * ── The FO token never reaches the browser ─────────────────────────────────
 * It is set as an httpOnly cookie (`lib/faborch/session.ts`). The response body
 * carries this app's own session, and the user fields FabOrchestrator's own
 * pages read from the session blob (plan RP2, G30).
 *
 * ── The flow (plan RP2 part 3, "Login") ─────────────────────────────────────
 *  1. Only from this app's own pages, and only JSON (the same-origin gate and
 *     JSON-only rule of RP3 part 5: a form on another site can send neither);
 *     the limiter, the body limit, the schema; this app's own session
 *     settings, **before** FabOrchestrator is asked anything; then `foLogin`.
 *  2. One extra FO call, `/api/auth/me` with the new token: the real role, an
 *     inactive account, or a forced password change.
 *  3. A new sign-in **ends the session it replaces**: a cookie from an older
 *     sign-in on this browser has its FabOrchestrator token revoked, before
 *     this one is answered, rather than left alive for 30 days.
 *  4. This app's session is minted, capped at FabOrchestrator's own expiry.
 *  5. The answer carries `next`: FabOrchestrator's change page when the account
 *     must change its password, which is the only way a phone can reach it.
 *     The FO cookie lives as long as this app's session plus a short grace.
 *
 * ── Which device is signing in (1 October 2026) ─────────────────────────────
 * Several people may share one FabOrchestrator account, and each device must
 * keep its own conversations. So step 4 also names the device: this browser's
 * device key (`lib/faborch/device.ts`), the one in its cookie or a new one at
 * its first sign-in, is hashed into a **seat**, and the seat is signed into
 * this app's session. The gateway then lets the session use only the
 * conversations that seat started (`lib/gateway/seats.ts`). Nothing about the
 * device is sent to FabOrchestrator. The cookie is renewed once the sign-in
 * has succeeded; sign-out never clears it.
 *
 * Anything that fails after FabOrchestrator has issued a token revokes that
 * token before answering, so a failed sign-in never leaves a live FO session.
 *
 * ── Wrong guesses are throttled ─────────────────────────────────────────────
 * Because this route forwards to a **real** FabOrchestrator, it is the only
 * thing between a public URL and a production identity store. Eight wrong
 * guesses from one address buys a ten-minute wait — see `lib/rate-limit.ts`,
 * including what that does and does not protect against. A correct password is
 * never throttled: success clears the counter.
 */
export async function POST(req: NextRequest) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json(
      { code: "cross_site_request", error: "Sign-in has to come from this app." },
      { status: 403, headers: NO_STORE },
    );
  }
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json(
      { code: "unsupported_media_type", error: "Sign-in expects JSON." },
      { status: 415, headers: NO_STORE },
    );
  }

  const address = clientAddress(req.headers);
  const verdict = checkLoginAllowed(address);
  if (!verdict.allowed) {
    return NextResponse.json(
      { code: "login_rate_limited", error: "Too many sign-in attempts. Try again in a few minutes." },
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
      { code: "invalid_request", error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { email, password } = parsed.data;

  // ── Step 0: the device, before the person (device enrollment, 6 October) ──
  // The device proves itself first: a signature over a fresh challenge with
  // the private key it generated at enrollment, checked against the public
  // key registered then (`lib/devices/proof.ts`). With the gate enforced, no
  // proof or a failed one ends here, before FabOrchestrator is asked anything
  // about the password. With the gate off, a valid proof is still recorded, so
  // sessions are already bound to their devices when the gate is turned on.
  let device: Device | null = null;
  const gate = deviceGateMode();
  if (parsed.data.device || gate === "enforce") {
    if (!parsed.data.device) {
      deviceAudit("DEVICE_LOGIN_REFUSED", { reason: "no_device_proof", address });
      return NextResponse.json(DEVICE_NOT_APPROVED, { status: 403, headers: NO_STORE });
    }
    try {
      const proof = await verifyDeviceSignIn(parsed.data.device, deviceStore());
      if (proof.ok) {
        device = proof.device;
      } else if (gate === "enforce") {
        deviceAudit("DEVICE_LOGIN_REFUSED", { deviceId: proof.deviceId, reason: proof.reason, address });
        return NextResponse.json(
          proof.reason === "revoked"
            ? { code: "device_revoked", error: `This device (${proof.deviceId}) has been revoked. Contact your administrator.` }
            : DEVICE_NOT_APPROVED,
          { status: 403, headers: NO_STORE },
        );
      }
    } catch (error) {
      if (!(error instanceof DeviceStoreUnavailableError)) throw error;
      reportError("auth/device-proof", error);
      if (gate === "enforce") {
        return NextResponse.json(
          { code: "device_check_unavailable", error: "This device could not be checked just now. Try again shortly." },
          { status: 503, headers: NO_STORE },
        );
      }
    }
  }

  // No FabOrchestrator, no sign-in. This is a **deployment fault, not a bad
  // password**, and saying "incorrect email or password" here would send an
  // operator to retype a password that was never going to be checked.
  if (!isFabOrchConfigured()) {
    reportError("auth/not-configured", new Error("FABORCH_BASE_URL is not set; sign-in cannot work"));
    return notConfigured();
  }

  // This app's own session settings, checked before FabOrchestrator is asked
  // anything: an unusable one found after `foLogin` would leave FabOrchestrator
  // holding a session nobody can use or revoke.
  try {
    sessionKeyRing();
    sessionCookieGraceSeconds();
  } catch (error) {
    reportError("auth/session-config", error);
    return notConfigured("Sign-in is not configured on this server.");
  }

  let fo: FoSession | null;
  try {
    fo = await foLogin(email, password);
  } catch (error) {
    // FO being down must not read as a wrong password: somebody typing their
    // own credentials correctly and being told they are wrong will spend the
    // demo re-typing them. The sentence is fixed and never FabOrchestrator's
    // address (plan RP5, m4); a timeout or an outage was already reported
    // inside `fetchFo`, and anything else is this app's surprise.
    if (!(error instanceof FabOrchRequestError)) reportError("auth/login", error);
    if (error instanceof FabOrchRequestError && error.status === 504) {
      return NextResponse.json(
        { code: "upstream_timeout", error: "FabOrchestrator did not answer in time. Try again in a moment." },
        { status: 504 },
      );
    }
    return NextResponse.json(
      { code: "faborch_unavailable", error: "FabOrchestrator could not be reached just now. Try again in a moment." },
      { status: 503 },
    );
  }

  if (!fo) {
    // FabOrchestrator refuses a wrong password, and a suspended or deleted
    // account, before it checks the password. All of them read as a wrong
    // password here (RP2-D1): anything else would let a caller learn an
    // account's status by posting any password.
    recordLoginFailure(address);
    return NextResponse.json({ code: "invalid_credentials", error: "Incorrect email or password" }, { status: 401 });
  }

  try {
    const res = await completeSignIn(req, fo, device);
    if (res.status === 200) clearLoginFailures(address);
    return res;
  } catch (error) {
    // Nothing below is expected to throw. If something does, FabOrchestrator
    // is holding a session this app will never use: revoke it before answering.
    reportError("auth/login-after-fo", error);
    await revokeFoSession(fo.token, "login_failed");
    return NextResponse.json(
      { code: "upstream_error", error: "Sign-in could not be completed. Try again." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** Steps 2 to 5, once FabOrchestrator has accepted the password. */
async function completeSignIn(req: NextRequest, fo: FoSession, device: Device | null): Promise<NextResponse> {
  // ── Step 2: the `/me` probe, with the token FO just issued ────────────────
  // FO's login has just set its idle clock, so this extends nothing.
  //  - 403 "no longer active" after a correct password: a coded failure, not
  //    "wrong password", and the token just minted is revoked before the answer.
  //  - 401 for a token FO issued a moment ago: 502 `upstream_error`, and the
  //    token is revoked the same way.
  //  - 403 FORCE_PASSWORD_CHANGE: signed in, and sent to FO's change page.
  //    If this user already changed the password on this browser and FO still
  //    asks, FO has not cleared its flag (§9 question 44): refused with that
  //    explanation rather than sent round the loop again.
  //  - Anything else (timeout, unreachable, 5xx) costs only the role label.
  let roleName: string | null = null;
  let forcedChange = false;
  try {
    const me = await foMe(fo.token);
    if (me.kind === "inactive") {
      return await refuseAndRevoke(fo.token, "probe_inactive", 403, {
        code: "account_inactive",
        error: "This account is no longer active. Contact your administrator.",
      });
    }
    if (me.kind === "unauthorized") {
      return await refuseAndRevoke(fo.token, "probe_unexpected", 502, {
        code: "upstream_error",
        error: "FabOrchestrator did not confirm the new session. Try signing in again.",
      });
    }
    if (me.kind === "force_password_change") {
      if (passwordChangeMarkedFor(req, fo.user.id)) {
        return await refuseAndRevoke(fo.token, "password_change_required", 403, {
          code: "password_change_required",
          error:
            "Your password was changed, but FabOrchestrator is still asking for a new one. " +
            "Ask your administrator to clear the password-change requirement on your account.",
        });
      }
      forcedChange = true;
    }
    if (me.kind === "ok") roleName = me.roleName;
  } catch (error) {
    // A timeout or an unreachable FO has already been reported by `fetchFo`.
    if (!(error instanceof FabOrchRequestError)) reportError("auth/me-probe", error);
  }

  // ── Step 3: a new sign-in ends the session it replaces ─────────────────────
  // Before this one is answered, and whether or not FabOrchestrator is quick
  // about it (the revoke has its own short limit, and never fails the login).
  const replaced = foTokenFrom(req);
  if (replaced && replaced !== fo.token) await revokeFoSession(replaced, "replaced");

  // ── Step 4: this app's own session, for an operator FO has vouched for ────
  // `fo.expiresAt` caps it at FabOrchestrator's own expiry — see `sessionFor`.
  // The session carries this browser's seat: the key it already holds, or a
  // new one for a browser signing in for the first time.
  const deviceKey = deviceKeyFrom(req) ?? newDeviceKey();
  const session = sessionFor(
    {
      id: fo.user.id,
      email: fo.user.email,
      name: fo.user.name || fo.user.email,
      roleName: roleName ?? ROLE_WHEN_UNKNOWN,
    },
    fo.expiresAt,
    fo.token,
    undefined,
    seatIdFor(deviceKey),
  );

  // ── Step 5: the answer ─────────────────────────────────────────────────────
  // FabOrchestrator's change page is named only where this origin serves it
  // (`whole` mode, or `surfaces` listing it); anywhere else it would be a 404.
  const next =
    forcedChange && classify(FORCED_CHANGE_PAGE, readRegistry()) === "fo-document" ? FORCED_CHANGE_PAGE : null;

  const res = NextResponse.json(
    {
      token: session.token,
      expiresAt: session.expiresAt,
      // FabOrchestrator's own user fields, as its login page stores them (G30):
      // its sidebar reads the name and its dashboard controls read
      // `canCreateDashboards` from the session blob the login page writes.
      user: {
        id: fo.user.id,
        email: fo.user.email,
        name: fo.user.name ?? null,
        ...(typeof fo.user.canCreateDashboards === "boolean"
          ? { canCreateDashboards: fo.user.canCreateDashboards }
          : {}),
        roleName: session.user.roleName,
      },
      next,
      faborch: true,
    },
    { headers: NO_STORE },
  );
  setFoTokenCookie(req, res, fo.token, session.expiresAt);
  // The same browser returns to the same seat at its next sign-in.
  setDeviceCookie(req, res, deviceKey);
  // The session belongs to the device that proved itself (step 0): from now on
  // every request on it is checked against that device's status
  // (`lib/devices/gate.ts`), so revoking the device ends this session's access.
  // Recorded by the FO token's fingerprint, never the token. If it cannot be
  // recorded, the sign-in fails (the caller revokes FabOrchestrator's token).
  if (device) {
    await deviceStore().bindSession(
      foFingerprint(fo.token),
      device.deviceId,
      new Date(session.expiresAt).getTime() + sessionCookieGraceSeconds() * 1000,
    );
    deviceAudit("DEVICE_ACCESS_ALLOWED", { deviceId: device.deviceId, userId: fo.user.id, reason: "sign_in" });
  }
  // FabOrchestrator no longer holds this user for a change: the mark from an
  // earlier change has done its job.
  if (!forcedChange && passwordChangeMarkedFor(req, fo.user.id)) clearPasswordChangeMark(res);
  return res;
}

function notConfigured(
  error = "Sign-in is not configured on this server: FabOrchestrator is not reachable.",
): NextResponse {
  return NextResponse.json({ code: "not_configured", error }, { status: 503, headers: NO_STORE });
}

/**
 * Refuse this sign-in and revoke the token FabOrchestrator just issued, before
 * answering, so no session row is left behind. No cookie is set.
 */
async function refuseAndRevoke(
  foToken: string,
  reason: SessionEndReason,
  status: number,
  body: { code: string; error: string },
): Promise<NextResponse> {
  await revokeFoSession(foToken, reason);
  return NextResponse.json(body, { status, headers: NO_STORE });
}
