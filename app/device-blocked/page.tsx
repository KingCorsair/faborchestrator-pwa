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
 * `/device-blocked` — where `proxy.ts` sends every document request from a
 * device that is not an enrolled, approved one (`lib/devices/gate.ts`).
 *
 * It renders no FabOrchestrator data and calls nothing but sign-out: whatever
 * session this browser still holds is ended here (the server clears the
 * FabOrchestrator cookie and revokes its token), which is how a revoked
 * device's session ends the next time the phone opens anything.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reason } = await searchParams;
  const unavailable = reason === "unavailable";

  return (
    <DeviceCard eyebrow="DEVICE CHECK" title={unavailable ? "This device could not be checked" : "This device is not approved"}>
      {unavailable ? (
        <Notice tone="error">
          FabOrchestrator could not check whether this device is approved just now. Try again in a few minutes, and
          contact your administrator if this continues.
        </Notice>
      ) : (
        <>
          <p className="m-0 text-[15px] leading-[1.6]" style={{ color: "var(--text-ink)" }}>
            This device is not approved to access FabOrchestrator.
          </p>
          <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
            Please contact your administrator to enroll this device. They will give you a one-time enrollment code to
            scan on this device.
          </p>
        </>
      )}
      <BlockedActions />
    </DeviceCard>
  );
}
