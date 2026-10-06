import { NextResponse, type NextRequest } from "next/server";
import { foLogin, isFabOrchConfigured, FabOrchRequestError } from "@/lib/faborch/client";
import { afterResponse, revokeFoSession } from "@/lib/faborch/end-session";
import { deviceAudit } from "@/lib/devices/audit";
import {
  clearEnrollmentCookie,
  credentialValue,
  pendingEnrollmentToken,
  presentedCredential,
  setDeviceCredentialCookie,
} from "@/lib/devices/credential";
import { describeDevice } from "@/lib/devices/metadata";
import { deviceStore, DeviceStoreUnavailableError, normaliseEmail } from "@/lib/devices/store";
import { checkLoginAllowed, clearLoginFailures, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { CompleteEnrollmentSchema, LOGIN_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Complete a device enrollment: the expected user proves who they are on the
 * device being enrolled, and that device becomes an approved one.
 *
 *  1. Only from this app's own page, only JSON, under the sign-in limiter.
 *  2. The pending enrollment (the httpOnly cookie the link set) must exist,
 *     be unexpired and unused. Checked **before** FabOrchestrator is asked
 *     anything, and again atomically when it is used (step 5).
 *  3. The email typed must be the enrollment's user, then FabOrchestrator
 *     itself must accept the password (`foLogin`, the same check sign-in
 *     uses) and name the same user. Identity is FabOrchestrator's; this app
 *     only compares.
 *  4. The FabOrchestrator session that check created is not kept: it is
 *     revoked after the response. Enrollment approves the device; signing in
 *     is the normal sign-in, which now passes the device check.
 *  5. The store uses the enrollment exactly once (`completeEnrollment`) and
 *     mints the device id and token. Only the token's hash is stored.
 *  6. The credential goes to this browser as an httpOnly cookie. It is never
 *     in the response body.
 *
 * A browser that already held a credential (re-enrolled on purpose, or a
 * replacement) has its previous device revoked: the old token is gone from the
 * browser, and an approved credential nobody holds is one only a copy could use.
 */
export async function POST(req: NextRequest) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json(
      { code: "cross_site_request", error: "Enrollment has to come from this app." },
      { status: 403, headers: NO_STORE },
    );
  }
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json(
      { code: "unsupported_media_type", error: "Enrollment expects JSON." },
      { status: 415, headers: NO_STORE },
    );
  }

  const address = clientAddress(req.headers);
  const verdict = checkLoginAllowed(address);
  if (!verdict.allowed) {
    return NextResponse.json(
      { code: "login_rate_limited", error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(verdict.retryAfterSeconds) } },
    );
  }

  const body = await readJsonBody(req, LOGIN_BODY_LIMIT);
  if (body.tooLarge) {
    return NextResponse.json({ code: "body_too_large", error: "That request is too large." }, { status: 413 });
  }
  const parsed = CompleteEnrollmentSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "invalid_request", error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400, headers: NO_STORE },
    );
  }

  const token = pendingEnrollmentToken(req);
  if (!token) return linkUnusable(req, "no_pending_enrollment");

  let store: ReturnType<typeof deviceStore>;
  try {
    store = deviceStore();
    const lookup = await store.lookupEnrollment(token);
    if (lookup.kind !== "valid") {
      return linkUnusable(req, `link_${lookup.kind}`, lookup.kind === "unknown" ? null : lookup.enrollment.enrollmentId);
    }
    if (normaliseEmail(parsed.data.email) !== lookup.enrollment.allowedEmail) {
      deviceAudit("DEVICE_ENROLLMENT_REJECTED", {
        reason: "wrong_user",
        enrollmentId: lookup.enrollment.enrollmentId,
        address,
      });
      return wrongUser();
    }
  } catch (error) {
    return storeFailure(error);
  }

  if (!isFabOrchConfigured()) {
    return NextResponse.json(
      { code: "not_configured", error: "Enrollment is not configured on this server." },
      { status: 503, headers: NO_STORE },
    );
  }

  let fo: Awaited<ReturnType<typeof foLogin>>;
  try {
    fo = await foLogin(parsed.data.email, parsed.data.password);
  } catch (error) {
    if (!(error instanceof FabOrchRequestError)) reportError("devices/enroll-login", error);
    return NextResponse.json(
      { code: "faborch_unavailable", error: "FabOrchestrator could not be reached just now. Try again in a moment." },
      { status: 503, headers: NO_STORE },
    );
  }
  if (!fo) {
    recordLoginFailure(address);
    return NextResponse.json(
      { code: "invalid_credentials", error: "Incorrect email or password" },
      { status: 401, headers: NO_STORE },
    );
  }
  clearLoginFailures(address);
  // Identity checked; this session is not the one the user will work in.
  const foToken = fo.token;
  afterResponse(() => revokeFoSession(foToken, "device_enrollment"));

  try {
    const previous = presentedCredential(req);
    const result = await store.completeEnrollment({
      token,
      userId: fo.user.id,
      email: fo.user.email,
      metadata: describeDevice(req.headers.get("user-agent"), parsed.data.installedApp === true),
    });
    if (result.kind === "wrong_user") {
      deviceAudit("DEVICE_ENROLLMENT_REJECTED", { reason: "wrong_user", enrollmentId: result.enrollment.enrollmentId, userId: fo.user.id, address });
      return wrongUser();
    }
    if (result.kind !== "enrolled") return linkUnusable(req, `link_${result.kind}`);

    const { device } = result;
    deviceAudit("DEVICE_ENROLLED", {
      deviceId: device.deviceId,
      userId: device.userId,
      enrollmentId: device.enrollmentId,
      site: device.site,
      actor: device.createdBy,
    });

    if (previous.kind === "present" && previous.credential.deviceId !== device.deviceId) {
      const replaced = await store.verifyDevice(previous.credential.deviceId, previous.credential.token);
      if (replaced.kind === "approved") {
        await store.revokeDevice(replaced.device.deviceId, { by: "self", reason: `replaced by ${device.deviceId}` });
        deviceAudit("DEVICE_REVOKED", {
          deviceId: replaced.device.deviceId,
          userId: replaced.device.userId,
          actor: "self",
          reason: `replaced by ${device.deviceId}`,
        });
      }
      deviceAudit("DEVICE_REENROLLED", {
        deviceId: device.deviceId,
        previousDeviceId: previous.credential.deviceId,
        userId: device.userId,
      });
    }

    const res = NextResponse.json(
      { ok: true, device: { deviceId: device.deviceId, friendlyName: device.friendlyName }, next: "/login" },
      { headers: NO_STORE },
    );
    setDeviceCredentialCookie(req, res, credentialValue(device.deviceId, result.token));
    clearEnrollmentCookie(req, res);
    return res;
  } catch (error) {
    return storeFailure(error);
  }
}

function linkUnusable(req: NextRequest, reason: string, enrollmentId: string | null = null): NextResponse {
  deviceAudit("DEVICE_ENROLLMENT_REJECTED", { reason, enrollmentId, address: clientAddress(req.headers) });
  const res = NextResponse.json(
    {
      code: "enrollment_invalid",
      error: "This enrollment link has expired or has already been used. Ask your administrator for a new one.",
    },
    { status: 410, headers: NO_STORE },
  );
  clearEnrollmentCookie(req, res);
  return res;
}

function wrongUser(): NextResponse {
  return NextResponse.json(
    {
      code: "enrollment_wrong_user",
      error: "This enrollment was issued for a different user. Sign in with the account it was issued for.",
    },
    { status: 403, headers: NO_STORE },
  );
}

function storeFailure(error: unknown): NextResponse {
  if (!(error instanceof DeviceStoreUnavailableError)) throw error;
  reportError("devices/enroll-complete", error);
  return NextResponse.json(
    { code: "device_store_unavailable", error: "This device could not be enrolled just now. Try again shortly." },
    { status: 503, headers: NO_STORE },
  );
}
