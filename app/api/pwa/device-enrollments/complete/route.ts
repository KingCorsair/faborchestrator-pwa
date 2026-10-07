import { NextResponse, type NextRequest } from "next/server";
import { deviceAudit } from "@/lib/devices/audit";
import { verifyProof } from "@/lib/devices/challenges";
import { clearEnrollmentCookie, pendingEnrollmentToken } from "@/lib/devices/credential";
import { describeDevice } from "@/lib/devices/metadata";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { CompleteEnrollmentSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Enrollment, step 2 of 2: **the enrollment code is the authorization.**
 *
 * The device has generated an ECDSA P-256 key pair (private key
 * non-extractable, kept in its own IndexedDB) and signed the step-1 challenge.
 * Here:
 *
 *  1. The signature is checked against the public key it sent, which proves
 *     it holds the private key (the challenge is bound to this enrollment and
 *     spent whatever the outcome).
 *  2. The store consumes the code **exactly once** (`completeEnrollment`, an
 *     `O_EXCL` marker per enrollment) and creates `DEVICE-nnn`, APPROVED,
 *     holding that public key.
 *  3. The answer is the device id. Nothing secret is issued: the device's
 *     secret is its private key, which never leaves it. No session is created
 *     and nobody is signed in.
 */
export async function POST(req: NextRequest) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "Enrollment has to come from this app." }, { status: 403, headers: NO_STORE });
  }
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ code: "unsupported_media_type", error: "Enrollment expects JSON." }, { status: 415, headers: NO_STORE });
  }
  const address = clientAddress(req.headers);
  const limiterKey = `enroll:${address}`;
  if (!checkLoginAllowed(limiterKey).allowed) {
    return NextResponse.json({ code: "rate_limited", error: "Too many attempts. Try again in a few minutes." }, { status: 429, headers: NO_STORE });
  }

  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  const parsed = CompleteEnrollmentSchema.safeParse(body.tooLarge ? null : body.value);
  if (!parsed.success) {
    return NextResponse.json({ code: "invalid_request", error: "Bad enrollment request." }, { status: 400, headers: NO_STORE });
  }
  const token = parsed.data.token ?? pendingEnrollmentToken(req);
  if (!token) {
    recordLoginFailure(limiterKey);
    return unusable(req, "no_pending_enrollment", address);
  }

  try {
    const store = deviceStore();
    const lookup = await store.lookupEnrollment(token);
    if (lookup.kind !== "valid") {
      if (lookup.kind === "unknown") recordLoginFailure(limiterKey);
      return unusable(req, `link_${lookup.kind}`, address);
    }
    const proof = verifyProof({
      challengeId: parsed.data.challengeId,
      purpose: "enroll",
      subject: lookup.enrollment.enrollmentId,
      publicKeySpki: parsed.data.publicKeySpki,
      signature: parsed.data.signature,
    });
    if (!proof.ok) {
      deviceAudit("DEVICE_ENROLLMENT_REJECTED", { reason: `proof_${proof.reason}`, enrollmentId: lookup.enrollment.enrollmentId, address });
      return NextResponse.json(
        { code: "enrollment_proof_invalid", error: "This device could not prove its new key. Scan the QR again." },
        { status: 401, headers: NO_STORE },
      );
    }

    const result = await store.completeEnrollment({
      token,
      publicKeySpki: parsed.data.publicKeySpki,
      metadata: describeDevice(req.headers.get("user-agent"), parsed.data.installedApp === true),
    });
    if (result.kind !== "enrolled") return unusable(req, `link_${result.kind}`, address);

    const { device } = result;
    deviceAudit("DEVICE_ENROLLED", {
      deviceId: device.deviceId,
      enrollmentId: device.enrollmentId,
      site: device.site,
      actor: device.createdBy,
      address,
    });
    const res = NextResponse.json(
      { ok: true, device: { deviceId: device.deviceId, friendlyName: device.friendlyName, keyFingerprint: device.keyFingerprint } },
      { headers: NO_STORE },
    );
    clearEnrollmentCookie(req, res);
    return res;
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/enroll-complete", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "This device could not be enrolled just now. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
}

function unusable(req: NextRequest, reason: string, address: string): NextResponse {
  deviceAudit("DEVICE_ENROLLMENT_REJECTED", { reason, address });
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
