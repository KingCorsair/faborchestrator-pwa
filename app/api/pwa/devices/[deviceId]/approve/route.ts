import { NextResponse, type NextRequest } from "next/server";
import { requireDeviceAdmin } from "@/lib/devices/admin";
import { deviceAudit } from "@/lib/devices/audit";
import { DEVICE_ID } from "@/lib/devices/credential";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { deviceView } from "@/lib/devices/views";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Approve a device that is waiting for it (14 October 2026). A device enrolled
 * with a QR is PENDING until an administrator, having seen where the request
 * came from, approves it here; the page on the device is asking all the while
 * and moves on to sign-in by itself. Refusing it is the revoke route, which
 * marks a PENDING device REJECTED.
 *
 * The same administrator check as every action on `/device-admin`: an
 * approved device, a session of this app, an email on DEVICE_ADMIN_EMAILS.
 * Idempotent for an approved device. A rejected or revoked device is not
 * approved again (`409`): it needs a new enrollment QR.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ deviceId: string }> }) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "This has to come from this app." }, { status: 403, headers: NO_STORE });
  }
  const auth = await requireDeviceAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { deviceId } = await ctx.params;
  if (!DEVICE_ID.test(deviceId)) {
    return NextResponse.json({ code: "not_found", error: "No such device." }, { status: 404, headers: NO_STORE });
  }
  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  if (body.tooLarge) {
    return NextResponse.json({ code: "body_too_large", error: "That request is too large." }, { status: 413, headers: NO_STORE });
  }

  try {
    const result = await deviceStore().approveDevice(deviceId, { by: auth.admin.email });
    if (result.kind === "unknown") {
      return NextResponse.json({ code: "not_found", error: "No such device." }, { status: 404, headers: NO_STORE });
    }
    if (result.kind === "not_pending") {
      return NextResponse.json(
        {
          code: "not_pending",
          error: `${deviceId} was ${result.device.status === "REJECTED" ? "rejected" : "revoked"}. It needs a new enrollment QR.`,
        },
        { status: 409, headers: NO_STORE },
      );
    }
    if (result.changed) {
      deviceAudit("DEVICE_APPROVED", { deviceId, site: result.device.site, actor: auth.admin.email });
    }
    return NextResponse.json({ device: deviceView(result.device), changed: result.changed }, { headers: NO_STORE });
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/approve", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "The device could not be approved just now. Try again." },
      { status: 503, headers: NO_STORE },
    );
  }
}
