import { NextResponse, type NextRequest } from "next/server";
import { deviceAudit } from "@/lib/devices/audit";
import { clearEnrollmentCookie, SECRET_TOKEN, setEnrollmentCookie } from "@/lib/devices/credential";
import { DEVICE_ENROLL_PAGE } from "@/lib/devices/gate";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";

/**
 * The enrollment link: `GET /device-enroll/<token>`, what the QR code opens.
 *
 * It does one thing: check the token names an enrollment that is still usable,
 * move it into a short-lived httpOnly cookie, and redirect to the bare
 * `/device-enroll`, so the token leaves the address bar at once. It **uses
 * nothing**: the enrollment is consumed only by the sign-in on that page, so a
 * link preview or a scanner that fetches the URL first cannot spend it.
 *
 * Unknown, expired and used links all land on the same "this link cannot be
 * used" page. Wrong guesses count against the sign-in limiter for the address,
 * though at 256 bits a guess is not a realistic attack.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const address = clientAddress(req.headers);

  const target = req.nextUrl.clone();
  target.pathname = DEVICE_ENROLL_PAGE;
  target.search = "";

  if (!checkLoginAllowed(`enroll:${address}`).allowed) return finish(req, target, "limited");
  if (!SECRET_TOKEN.test(token)) {
    recordLoginFailure(`enroll:${address}`);
    return finish(req, target, "invalid");
  }

  try {
    const lookup = await deviceStore().lookupEnrollment(token);
    if (lookup.kind !== "valid") {
      if (lookup.kind === "unknown") recordLoginFailure(`enroll:${address}`);
      deviceAudit("DEVICE_ENROLLMENT_REJECTED", {
        reason: `link_${lookup.kind}`,
        enrollmentId: lookup.kind === "unknown" ? null : lookup.enrollment.enrollmentId,
        address,
      });
      return finish(req, target, "invalid");
    }
    const res = redirect(target);
    setEnrollmentCookie(req, res, token, (lookup.enrollment.expiresAt - Date.now()) / 1000);
    return res;
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/enroll-link", error);
    return finish(req, target, "unavailable");
  }
}

function redirect(target: URL): NextResponse {
  const res = NextResponse.redirect(target, 303);
  res.headers.set("Cache-Control", "no-store");
  // The URL that was just opened carries the token: never send it onwards.
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

function finish(req: NextRequest, target: URL, link: "invalid" | "limited" | "unavailable"): NextResponse {
  target.searchParams.set("link", link);
  const res = redirect(target);
  clearEnrollmentCookie(req, res);
  return res;
}
