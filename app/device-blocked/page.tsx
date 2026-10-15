import type { Metadata } from "next";
import { BlockedActions } from "@/components/devices/blocked-actions";
import { DeviceCard, Notice } from "@/components/devices/device-card";

export const metadata: Metadata = {
  title: "Device not approved — FabOrchestrator",
  robots: "noindex, nofollow",
};

/** Read at request time: `?reason=` decides the wording. */
export const dynamic = "force-dynamic";

/**
 * `/device-blocked` — where a device lands when it cannot enter
 * FabOrchestrator: the sign-in page found no device key here, or `proxy.ts`
 * refused a session whose device is revoked (`?reason=revoked`), or the
 * device is waiting for an administrator's approval (`?reason=pending`), whose own
 * credential was removed or replaced by a newer install (`?reason=credential`),
 * that is unbound (`?reason=session`), or that could not be checked
 * (`?reason=unavailable`).
 *
 * It renders no FabOrchestrator data. On arrival it ends the session this
 * browser holds, if that session is its to end (`components/devices/
 * blocked-actions.tsx`). An app added to the Home Screen from an approved
 * browser joins that browser's device here, with the install grant it was
 * installed with. Otherwise the page shows what this device holds, and enrolls
 * it **here**, with the in-app scanner or a pasted link.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reason } = await searchParams;
  const why =
    reason === "revoked" || reason === "pending" || reason === "credential" || reason === "session" || reason === "unavailable"
      ? reason
      : null;

  return (
    <DeviceCard eyebrow="DEVICE CHECK" title={why === "unavailable" ? "This device could not be checked" : "Device check"}>
      {why === "unavailable" ? (
        <Notice tone="error">
          FabOrchestrator could not check this device just now. Try again in a few minutes, and contact your
          administrator if this continues.
        </Notice>
      ) : null}
      <BlockedActions reason={why} />
    </DeviceCard>
  );
}
