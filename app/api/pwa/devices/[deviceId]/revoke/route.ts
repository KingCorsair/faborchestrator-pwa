import { NextResponse, type NextRequest } from "next/server";
import { requireDeviceAdmin } from "@/lib/devices/admin";
import { deviceAudit } from "@/lib/devices/audit";
import { DEVICE_ID } from "@/lib/devices/credential";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { deviceView } from "@/lib/devices/views";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { RevokeDeviceSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Revoke a device. From the next request it makes, the device's credential
 * opens nothing on this origin: the proxy re-reads the store whenever it
 * changes (`lib/devices/store.ts`), so there is no cache to wait out. Its
 * FabOrchestrator session is ended when the phone next opens anything, by the
 * blocked page's sign-out (see `app/device-blocked`).
 *
 * Idempotent: revoking a revoked device answers 200 and keeps the first
 * revocation's time and administrator.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ deviceId: string }> }) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json(
      { code: "cross_site_request", error: "This has to come from this app." },
      { status: 403, headers: NO_STORE },
    );
  }
  const auth = await requireDeviceAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { deviceId } = await ctx.params;
  if (!DEVICE_ID.test(deviceId)) {
    return NextResponse.json({ code: "not_found", error: "No such device." }, { status: 404, headers: NO_STORE });
  }

  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  if (body.tooLarge) {
    return NextResponse.json({ code: "body_too_large", error: "That request is too large." }, { status: 413 });
  }
  const parsed = RevokeDeviceSchema.safeParse(body.value ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { code: "invalid_request", error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await deviceStore().revokeDevice(deviceId, {
      by: auth.admin.email,
      reason: parsed.data.reason || "revoked by administrator",
    });
    if (!result) {
      return NextResponse.json({ code: "not_found", error: "No such device." }, { status: 404, headers: NO_STORE });
    }
    if (result.changed) {
      deviceAudit("DEVICE_REVOKED", {
        deviceId,
        site: result.device.site,
        actor: auth.admin.email,
        reason: result.device.revokeReason,
      });
    }
    return NextResponse.json({ device: deviceView(result.device), changed: result.changed }, { headers: NO_STORE });
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/revoke", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "The device could not be revoked just now. Try again." },
      { status: 503, headers: NO_STORE },
    );
  }
}
