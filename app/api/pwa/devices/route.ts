import { NextResponse, type NextRequest } from "next/server";
import { requireDeviceAdmin } from "@/lib/devices/admin";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { deviceView } from "@/lib/devices/views";
import { reportError } from "@/lib/report-error";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The enrolled devices, for administrators. No token and no token hash leaves
 * the store through here, or through any other route.
 */
export async function GET(req: NextRequest) {
  const auth = await requireDeviceAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const devices = await deviceStore().listDevices();
    return NextResponse.json({ devices: devices.map(deviceView) }, { headers: NO_STORE });
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/list", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "Devices cannot be listed just now. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
}
