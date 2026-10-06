/**
 * Enrollment settings and the enrollment link.
 *
 * The link is `<PUBLIC_ORIGIN>/device-enroll/<token>`. The origin is
 * configuration, never the request's `Host` (the rule `lib/same-origin.ts`
 * states for this app): a link built from a forged `Host` would send the
 * enrollment token to somebody else's server.
 *
 * The token is in the URL only until it is opened. `app/device-enroll/[token]`
 * moves it into a short-lived httpOnly cookie and redirects to the bare
 * `/device-enroll` at once, with `Referrer-Policy: no-referrer`, so it does not
 * stay in the address bar, the history entry the user sees, or a referrer.
 */

import QRCode from "qrcode";
import { publicOrigin } from "@/lib/same-origin";
import { DEVICE_ENROLL_PAGE } from "./gate";

export const ENROLLMENT_TTL_ENV = "DEVICE_ENROLLMENT_TTL_MINUTES";

/** Ten minutes unless configured; 1 to 60. An unsound value throws rather than being guessed at. */
export function enrollmentTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[ENROLLMENT_TTL_ENV]?.trim();
  if (!raw) return 10 * 60 * 1000;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new Error(`${ENROLLMENT_TTL_ENV} must be a whole number of minutes from 1 to 60.`);
  }
  return minutes * 60 * 1000;
}

/** The enrollment link, or null when `PUBLIC_ORIGIN` is not configured. */
export function enrollmentUrl(token: string, env: Record<string, string | undefined> = process.env): string | null {
  const origin = publicOrigin(env);
  return origin ? `${origin}${DEVICE_ENROLL_PAGE}/${token}` : null;
}

/** The link as a QR code, SVG. Error correction Q, as `scripts/generate-qr.ts` uses for the same reason. */
export function enrollmentQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", errorCorrectionLevel: "Q", margin: 2, color: { dark: "#10153a", light: "#ffffff" } });
}
