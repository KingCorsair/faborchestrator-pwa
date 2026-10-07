import { NextResponse, type NextRequest } from "next/server";
import { deviceAudit } from "@/lib/devices/audit";
import { issueChallenge } from "@/lib/devices/challenges";
import { clearEnrollmentCookie, pendingEnrollmentToken } from "@/lib/devices/credential";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { SMALL_JSON_BODY_LIMIT, StartEnrollmentSchema } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Enrollment, step 1 of 2: is this enrollment code still usable? If so, a
 * challenge bound to this enrollment.
 *
 * The code comes from the in-app scanner (`token` in the body) or from the
 * pending-enrollment cookie the enrollment link set. It is checked **before**
 * the device generates a key, so a used or expired QR changes nothing on the
 * device. Nothing is consumed here; step 2 (`complete`) consumes the code once
 * the device has proved it holds its new private key.
 */
export async function POST(req: NextRequest) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "Enrollment has to come from this app." }, { status: 403, headers: NO_STORE });
  }
  const address = clientAddress(req.headers);
  const limiterKey = `enroll:${address}`;
  const verdict = checkLoginAllowed(limiterKey);
  if (!verdict.allowed) {
    return NextResponse.json(
      { code: "rate_limited", error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(verdict.retryAfterSeconds) } },
    );
  }
  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  const parsed = StartEnrollmentSchema.safeParse(body.tooLarge ? null : (body.value ?? {}));
  if (!parsed.success) {
    return NextResponse.json({ code: "invalid_request", error: "Bad enrollment request." }, { status: 400, headers: NO_STORE });
  }
  const token = parsed.data.token ?? pendingEnrollmentToken(req);
  if (!token) {
    recordLoginFailure(limiterKey);
    return unusable(req, "no_pending_enrollment", address);
  }
  try {
    const lookup = await deviceStore().lookupEnrollment(token);
    if (lookup.kind !== "valid") {
      if (lookup.kind === "unknown") recordLoginFailure(limiterKey);
      return unusable(req, `link_${lookup.kind}`, address, lookup.kind === "unknown" ? null : lookup.enrollment.enrollmentId);
    }
    const issued = issueChallenge("enroll", lookup.enrollment.enrollmentId);
    if (!issued) return NextResponse.json({ code: "busy", error: "Try again in a moment." }, { status: 503, headers: NO_STORE });
    return NextResponse.json(
      { challengeId: issued.challengeId, challenge: issued.challenge, friendlyName: lookup.enrollment.friendlyName },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/enroll-start", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "Enrollment is not available just now. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
}

function unusable(req: NextRequest, reason: string, address: string, enrollmentId: string | null = null): NextResponse {
  deviceAudit("DEVICE_ENROLLMENT_REJECTED", { reason, enrollmentId, address });
  const res = NextResponse.json(
    {
      code: "enrollment_invalid",
      reason: reason.replace(/^link_/, ""),
      error: "This enrollment QR has expired or has already been used. Ask your administrator for a new one.",
    },
    { status: 410, headers: NO_STORE },
  );
  clearEnrollmentCookie(req, res);
  return res;
}
