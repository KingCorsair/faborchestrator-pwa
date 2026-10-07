import { NextResponse, type NextRequest } from "next/server";
import { requireDeviceAdmin } from "@/lib/devices/admin";

/**
 * Is the person asking a device administrator, on an approved device?
 * (7 October 2026.) FabOrchestrator's top bar calls this to decide whether to
 * show its **Devices** button, which opens `/device-admin`. The same check
 * every device-administration route makes (`requireDeviceAdmin`): an approved
 * device when the gate is on, a valid session, an email on
 * `DEVICE_ADMIN_EMAILS`. Anything else answers the refusal, and the button stays
 * hidden. Says nothing else about the person or the devices.
 */
export async function GET(req: NextRequest) {
  const auth = await requireDeviceAdmin(req);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ admin: true }, { headers: { "Cache-Control": "no-store" } });
}
