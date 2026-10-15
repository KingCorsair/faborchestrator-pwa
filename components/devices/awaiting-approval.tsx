"use client";

/**
 * A device that has scanned its enrollment QR and is waiting for an
 * administrator to approve it (14 October 2026).
 *
 * The device already holds its key; the server will not let that key open
 * anything until the request is approved on `/device-admin`. This asks the
 * server every few seconds while the page is visible (`deviceStatus`: a
 * challenge it never signs) and moves on by itself when an administrator
 * decides, so the person does not have to reload or scan again.
 *
 * Approval is the server's: this only reports it. Once approved, the browser
 * is given its install grant, so an app added to the Home Screen from it joins
 * the same device.
 */

import * as React from "react";
import { deviceStatus, keepInstallGrant, storedDevice } from "@/lib/devices/keystore";
import { Notice } from "./device-card";

const ASK_EVERY_MS = 4000;

export function AwaitingApproval({
  deviceId,
  onDecided,
}: {
  deviceId: string;
  onDecided: (status: "approved" | "refused") => void;
}) {
  const decided = React.useRef(onDecided);
  React.useEffect(() => {
    decided.current = onDecided;
  }, [onDecided]);

  React.useEffect(() => {
    let stopped = false;
    async function ask() {
      if (stopped || document.visibilityState !== "visible") return;
      const stored = await storedDevice();
      if (stopped || stored.kind !== "enrolled") return;
      const status = await deviceStatus(stored.credential);
      if (stopped) return;
      if (status === "approved") {
        stopped = true;
        void keepInstallGrant({ force: true }).catch(() => {});
        decided.current("approved");
      } else if (status === "revoked" || status === "unknown") {
        stopped = true;
        decided.current("refused");
      }
      // "pending" and "unavailable": ask again on the next tick.
    }
    void ask();
    const timer = setInterval(() => void ask(), ASK_EVERY_MS);
    const onVisible = () => void ask();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <>
      <Notice tone="info">
        <strong>Waiting for approval.</strong>
        <br />
        This device&rsquo;s request to join FabOrchestrator was sent as{" "}
        <strong className="whitespace-nowrap">{deviceId}</strong>. An administrator has to approve it before anyone can
        sign in on it.
      </Notice>
      <p
        data-testid="awaiting-approval"
        className="m-0 text-[14px] leading-[1.6]"
        style={{ color: "var(--text-muted-cool)" }}
      >
        Keep this page open: it moves on by itself once the request is approved. You can also close it and open
        FabOrchestrator again later.
      </p>
    </>
  );
}
