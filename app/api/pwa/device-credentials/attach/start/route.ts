import { NextResponse, type NextRequest } from "next/server";
import { deviceAudit } from "@/lib/devices/audit";
import { issueChallenge } from "@/lib/devices/challenges";
import { clearInstallGrantCookie, installGrantsEnabled, installGrantToken } from "@/lib/devices/install-grant";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Step 1 of an installed app joining its device
 * (`lib/devices/install-grant.ts`): the app holds no device key, and asks
 * whether the cookies it was installed with include a usable install grant.
 *
 * If they do, the answer is a challenge bound to **that grant**, for the app to
 * sign with the key it is about to generate. If they do not, nothing on the
 * device changes and no key is made: the app falls back to an enrollment QR.
 *
 * The grant is read from its httpOnly cookie, never from the body. A request
 * with no grant cookie at all is the ordinary case for a device that was never
 * enrolled, and is answered without touching the store or the limiter.
 */
export async function POST(req: NextRequest) {
  if (!installGrantsEnabled()) {
    return NextResponse.json({ code: "not_found", error: "Not available." }, { status: 404, headers: NO_STORE });
  }
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "This has to come from this app." }, { status: 403, headers: NO_STORE });
  }
  const token = installGrantToken(req);
  if (!token) {
    return NextResponse.json({ code: "no_install_grant", error: "This app has no install grant." }, { status: 404, headers: NO_STORE });
  }
  const address = clientAddress(req.headers);
  const limiterKey = `attach:${address}`;
  if (!checkLoginAllowed(limiterKey).allowed) {
    return NextResponse.json({ code: "rate_limited", error: "Too many attempts. Try again in a few minutes." }, { status: 429, headers: NO_STORE });
  }

  try {
    const lookup = await deviceStore().lookupGrant(token);
    if (lookup.kind !== "valid") {
      if (lookup.kind === "unknown") recordLoginFailure(limiterKey);
      return unusable(req, lookup.kind, lookup.kind === "unknown" ? null : lookup.grant.grantId, address);
    }
    const issued = issueChallenge("attach", lookup.grant.grantId);
    if (!issued) {
      return NextResponse.json({ code: "busy", error: "Try again in a moment." }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ ...issued, deviceId: lookup.grant.deviceId }, { headers: NO_STORE });
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/attach-start", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "This could not be done just now. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
}

/** A grant that cannot be used is also dropped from this browser: it never will be usable. */
function unusable(req: NextRequest, reason: string, grantId: string | null, address: string): NextResponse {
  deviceAudit("INSTALL_GRANT_REJECTED", { reason: `grant_${reason}`, grantId, address });
  const res = NextResponse.json(
    { code: "install_grant_invalid", reason, error: "This app's install grant has expired or has already been used." },
    { status: 410, headers: NO_STORE },
  );
  clearInstallGrantCookie(req, res);
  return res;
}
