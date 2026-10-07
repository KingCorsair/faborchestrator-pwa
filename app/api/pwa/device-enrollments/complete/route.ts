import { NextResponse, type NextRequest } from "next/server";
import { deviceAudit } from "@/lib/devices/audit";
import {
  clearEnrollmentCookie,
  credentialValue,
  pendingEnrollmentToken,
  presentedCredential,
  setDeviceCredentialCookie,
} from "@/lib/devices/credential";
import { describeDevice } from "@/lib/devices/metadata";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { CompleteEnrollmentSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Complete a device enrollment: **the enrollment token is the authorization.**
 *
 * An administrator issued the token (`POST /api/pwa/device-enrollments`), and
 * holding it within its lifetime is permission to enroll exactly one device.
 * Nobody signs in here and FabOrchestrator is not asked anything: enrollment
 * approves the device, and who uses it is decided later, by the normal
 * sign-in, every time.
 *
 *  1. Only from this app's own page, only JSON, under a per-address limiter.
 *     The enrollment page calls this by itself as soon as it opens, so a
 *     scanned QR code enrolls the device with no prompt. It is a POST from the
 *     page rather than the link's own GET so that a link preview or a mail
 *     scanner fetching the URL cannot spend the enrollment.
 *  2. The pending enrollment (the httpOnly cookie the link set) must exist,
 *     be unexpired and unused.
 *  3. The store uses it **exactly once** (`completeEnrollment`, guarded by an
 *     `O_EXCL` marker) and mints the device id and a 256-bit token. Only the
 *     token's hash is stored.
 *  4. The credential goes to this browser as an httpOnly cookie, never in the
 *     body. No session is created.
 *
 * A browser that already held a credential has that previous device revoked:
 * the old token is gone from the browser, and an approved credential nobody
 * holds is one only a copy could use.
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
  const limiterKey = `enroll:${address}`;
  const verdict = checkLoginAllowed(limiterKey);
  if (!verdict.allowed) {
    return NextResponse.json(
      { code: "rate_limited", error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(verdict.retryAfterSeconds) } },
    );
  }

  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  if (body.tooLarge) {
    return NextResponse.json({ code: "body_too_large", error: "That request is too large." }, { status: 413 });
  }
  const parsed = CompleteEnrollmentSchema.safeParse(body.value ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { code: "invalid_request", error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400, headers: NO_STORE },
    );
  }

  const token = pendingEnrollmentToken(req);
  if (!token) {
    recordLoginFailure(limiterKey);
    return linkUnusable(req, "no_pending_enrollment");
  }

  try {
    const store = deviceStore();
    const previous = presentedCredential(req);
    const result = await store.completeEnrollment({
      token,
      metadata: describeDevice(req.headers.get("user-agent"), parsed.data.installedApp === true),
    });
    if (result.kind !== "enrolled") {
      if (result.kind === "unknown") recordLoginFailure(limiterKey);
      return linkUnusable(req, `link_${result.kind}`);
    }

    const { device } = result;
    deviceAudit("DEVICE_ENROLLED", {
      deviceId: device.deviceId,
      enrollmentId: device.enrollmentId,
      site: device.site,
      actor: device.createdBy,
      address,
    });

    if (previous.kind === "present" && previous.credential.deviceId !== device.deviceId) {
      const replaced = await store.verifyDevice(previous.credential.deviceId, previous.credential.token);
      if (replaced.kind === "approved") {
        await store.revokeDevice(replaced.device.deviceId, { by: "self", reason: `replaced by ${device.deviceId}` });
        deviceAudit("DEVICE_REVOKED", {
          deviceId: replaced.device.deviceId,
          actor: "self",
          reason: `replaced by ${device.deviceId}`,
        });
      }
      deviceAudit("DEVICE_REENROLLED", { deviceId: device.deviceId, previousDeviceId: previous.credential.deviceId });
    }

    const res = NextResponse.json(
      { ok: true, device: { deviceId: device.deviceId, friendlyName: device.friendlyName } },
      { headers: NO_STORE },
    );
    setDeviceCredentialCookie(req, res, credentialValue(device.deviceId, result.token));
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

function linkUnusable(req: NextRequest, reason: string): NextResponse {
  deviceAudit("DEVICE_ENROLLMENT_REJECTED", { reason, address: clientAddress(req.headers) });
  const res = NextResponse.json(
    {
      code: "enrollment_invalid",
      error: "This enrollment code has expired or has already been used. Ask your administrator for a new one.",
    },
    { status: 410, headers: NO_STORE },
  );
  clearEnrollmentCookie(req, res);
  return res;
}
