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
 * nothing**: the enrollment is consumed only by the enrollment page, so a
 * link preview or a scanner that fetches the URL first cannot spend it.
 *
 * Unknown, expired and used links all land on the same "this link cannot be
 * used" page. Wrong guesses count against the sign-in limiter for the address,
 * though at 256 bits a guess is not a realistic attack.
 *
 * ── The redirect names no host (7 October 2026) ─────────────────────────────
 * It was built from `req.nextUrl`, which in a route handler of the standalone
 * server on Fly is the address the server listens on, `0.0.0.0:3000`, not the
 * public one: phones were sent to `https://0.0.0.0:3000/device-enroll`. A
 * relative `Location` keeps the browser on whatever origin it is already on.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const address = clientAddress(req.headers);

  if (!checkLoginAllowed(`enroll:${address}`).allowed) return finish(req, "limited");
  if (!SECRET_TOKEN.test(token)) {
    recordLoginFailure(`enroll:${address}`);
    return finish(req, "invalid");
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
      return finish(req, "invalid");
    }
    const res = redirect(DEVICE_ENROLL_PAGE);
    setEnrollmentCookie(req, res, token, (lookup.enrollment.expiresAt - Date.now()) / 1000);
    return res;
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/enroll-link", error);
    return finish(req, "unavailable");
  }
}

function redirect(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      // The URL that was just opened carries the token: never send it onwards.
      "Referrer-Policy": "no-referrer",
    },
  });
}

function finish(req: NextRequest, link: "invalid" | "limited" | "unavailable"): NextResponse {
  const res = redirect(`${DEVICE_ENROLL_PAGE}?link=${link}`);
  clearEnrollmentCookie(req, res);
  return res;
}
