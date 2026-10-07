import { NextResponse, type NextRequest } from "next/server";
import { issueChallenge } from "@/lib/devices/challenges";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { DeviceChallengeSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A fresh sign-in challenge for one device (`lib/devices/challenges.ts`): 32
 * random bytes, 60 seconds, single use, bound to this `DEVICE-nnn`. The
 * sign-in page signs it with the device's stored private key and sends the
 * signature with the password (`/api/pwa/auth/login`).
 *
 * Issued for a revoked device too: its proof still says which device it is,
 * and sign-in refuses it on status. Unknown ids count against the sign-in
 * limiter for the address.
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
  try {
    if (!(await deviceStore().publicKeyOf(parsed.data.deviceId))) {
      recordLoginFailure(address);
      return NextResponse.json(
        { code: "device_unknown", error: "This device is not enrolled. Ask your administrator for an enrollment QR." },
        { status: 404, headers: NO_STORE },
      );
    }
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/challenge", error);
    return NextResponse.json(
      { code: "device_check_unavailable", error: "This device could not be checked just now. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
  const issued = issueChallenge("sign-in", parsed.data.deviceId);
  if (!issued) {
    return NextResponse.json({ code: "busy", error: "Try again in a moment." }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json(issued, { headers: NO_STORE });
}
