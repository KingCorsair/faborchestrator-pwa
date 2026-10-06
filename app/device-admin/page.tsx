import type { Metadata } from "next";
import { DeviceAdmin } from "@/components/devices/device-admin";

export const metadata: Metadata = {
  title: "Devices — FabOrchestrator",
  robots: "noindex, nofollow",
};

/**
 * `/device-admin` — issue one-time enrollments and revoke approved devices.
 *
 * Behind both gates in `proxy.ts` (an approved device, then a session), and
 * every call it makes is checked again by `requireDeviceAdmin`: an approved
 * device, a valid session, and an email on `DEVICE_ADMIN_EMAILS`. This app has
 * no admin console of its own, and FabOrchestrator's admin app is a separate
 * application this one does not change, so device administration lives here,
 * beside the gate it administers.
 */
export default function Page() {
  return <DeviceAdmin />;
}
