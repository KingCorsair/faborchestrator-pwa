import { NextResponse, type NextRequest } from "next/server";
import { issueChallenge } from "@/lib/devices/challenges";
import { credentialRevoked, deviceRefusal, logBlocked } from "@/lib/devices/gate";
import { installGrantsEnabled } from "@/lib/devices/install-grant";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { DeviceChallengeSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A fresh challenge for one of a device's credentials
 * (`lib/devices/challenges.ts`): 32 random bytes, 60 seconds, single use, bound
 * to one purpose and to **that credential**, so no other key's signature
 * answers it.
 *
 *   sign-in  (the default) the sign-in page signs it with the stored private
 *            key and sends the signature with the password
 *            (`/api/pwa/auth/login`).
 *   grant    the device's ROOT credential asking for an install grant
 *            (`lib/devices/install-grant.ts`). Issued to a ROOT only: an
 *            installed app's credential is refused here, before it can sign
 *            anything.
 *
 * Refused for a device waiting for approval, `403 device_pending` (14
 * October 2026: the page waiting for it asks this until it is approved), for
 * a revoked or rejected device, `403 device_revoked`, and for a revoked or
 * superseded credential on an approved one, `403 credential_revoked`
 * (8 October 2026). The key on a phone outlives its revocation, so the phone
 * cannot tell by itself: the sign-in page and `/device-blocked` ask for a
 * challenge as soon as they open, and this answer is how they learn to show
 * the revoked page. Before, a revoked phone reopening the app was shown
 * "Approved device: DEVICE-nnn" and refused only after typing its password.
 * Sign-in still checks the status itself, for a proof signed before the
 * revocation.
 *
 * A request that names no credential means the device's ROOT (pages loaded
 * before credentials existed name only the device). Unknown ids count against
 * the sign-in limiter for the address. A revoked id does not: it is a real
 * device, and its holder may open the app many times.
 */
export async function POST(req: NextRequest) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "This has to come from this app." }, { status: 403, headers: NO_STORE });
  }
  const address = `device-challenge:${clientAddress(req.headers)}`;
  const verdict = checkLoginAllowed(address);
  if (!verdict.allowed) {
    return NextResponse.json(
      { code: "rate_limited", error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(verdict.retryAfterSeconds) } },
    );
  }
  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  const parsed = DeviceChallengeSchema.safeParse(body.tooLarge ? null : body.value);
  if (!parsed.success) {
    return NextResponse.json({ code: "invalid_request", error: "Bad device challenge request." }, { status: 400, headers: NO_STORE });
  }
  const purpose = parsed.data.purpose ?? "sign-in";
  if (purpose === "grant" && !installGrantsEnabled()) {
    return NextResponse.json({ code: "not_found", error: "Not available." }, { status: 404, headers: NO_STORE });
  }

  let credentialId: string;
  try {
    const store = deviceStore();
    const credential = await store.resolveCredential(parsed.data.deviceId, parsed.data.credentialId);
    const device = credential ? await store.getDevice(credential.deviceId) : null;
    if (!credential || !device) {
      recordLoginFailure(address);
      return NextResponse.json(
        { code: "device_unknown", error: "This device is not enrolled. Ask your administrator for an enrollment QR." },
        { status: 404, headers: NO_STORE },
      );
    }
    if (device.status !== "APPROVED") {
      if (device.status !== "PENDING") logBlocked(req, "revoked", device.deviceId, Date.now());
      return NextResponse.json(deviceRefusal(device), { status: 403, headers: NO_STORE });
    }
    if (credential.status !== "ACTIVE") {
      logBlocked(req, "revoked", device.deviceId, Date.now());
      return NextResponse.json(credentialRevoked(device.deviceId, credential.status === "SUPERSEDED"), {
        status: 403,
        headers: NO_STORE,
      });
    }
    if (purpose === "grant" && credential.kind !== "ROOT") {
      return NextResponse.json(
        { code: "not_root", error: "Only the browser this device was enrolled in can do this." },
        { status: 403, headers: NO_STORE },
      );
    }
    credentialId = credential.credentialId;
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/challenge", error);
    return NextResponse.json(
      { code: "device_check_unavailable", error: "This device could not be checked just now. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
  const issued = issueChallenge(purpose, credentialId);
  if (!issued) {
    return NextResponse.json({ code: "busy", error: "Try again in a moment." }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json(issued, { headers: NO_STORE });
}
