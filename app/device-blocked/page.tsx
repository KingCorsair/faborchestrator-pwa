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
 * refused a session whose device is revoked (`?reason=revoked`), unbound
 * (`?reason=session`) or could not be checked (`?reason=unavailable`).
 *
 * It renders no FabOrchestrator data. On arrival it ends whatever session this
 * browser holds (which also revokes it at FabOrchestrator). It then shows what
 * this device holds, and enrolls it **here**, with the in-app scanner or a
 * pasted link: inside the installed app that is the only way to put the key in
 * the app's own storage (on an iPhone, a Camera scan opens Safari, whose
 * storage is separate).
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reason } = await searchParams;
  const why = reason === "revoked" || reason === "session" || reason === "unavailable" ? reason : null;

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
