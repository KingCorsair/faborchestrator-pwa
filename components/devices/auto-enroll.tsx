"use client";

/**
 * Enrolls this device as soon as the enrollment page opens: no email, no
 * password, no button. The enrollment code (left in a short-lived cookie by
 * the link) is the whole authorization. `lib/devices/keystore.ts` generates
 * this device's key pair, keeps the non-exportable private key in this
 * browser's (or this installed app's) IndexedDB, and registers the public key;
 * the server answers with `DEVICE-nnn`.
 *
 * It runs from the page, not from the link's GET, so a link preview or a mail
 * scanner fetching the URL cannot spend the code. One attempt per page load.
 *
 * It does not sign anybody in. "Open FabOrchestrator" goes to the normal front
 * door, where the approved device proves itself and the person signs in.
 *
 * Since 14 October 2026 the scan usually makes a **request**: the device is
 * registered and waits for an administrator to approve it. The page says so
 * and waits (`AwaitingApproval`), then offers "Open FabOrchestrator" once the
 * request is approved.
 */

import * as React from "react";
import { Button } from "@/components/fab/primitives";
import { enroll, isInstalledApp, isIos } from "@/lib/devices/keystore";
import { AwaitingApproval } from "./awaiting-approval";
import { Notice } from "./device-card";

type State =
  | { kind: "enrolling" }
  | { kind: "pending"; deviceId: string; installed: boolean; ios: boolean }
  | { kind: "refused"; deviceId: string }
  | { kind: "done"; deviceId: string; installed: boolean; ios: boolean }
  | { kind: "failed"; error: string };

export function AutoEnroll() {
  const [state, setState] = React.useState<State>({ kind: "enrolling" });
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const result = await enroll(undefined);
        if (result.ok) {
          setState({ kind: result.pending ? "pending" : "done", deviceId: result.deviceId, installed: isInstalledApp(), ios: isIos() });
        }
        else setState({ kind: "failed", error: result.error });
      } catch {
        setState({ kind: "failed", error: "Could not reach the server. Check the connection and scan the code again." });
      }
    })();
  }, []);

  if (state.kind === "enrolling") return <Notice tone="info">Enrolling this device…</Notice>;
  if (state.kind === "failed") return <Notice tone="error">{state.error}</Notice>;
  if (state.kind === "pending") {
    const { deviceId, installed, ios } = state;
    return (
      <AwaitingApproval
        deviceId={deviceId}
        onDecided={(status) => setState(status === "approved" ? { kind: "done", deviceId, installed, ios } : { kind: "refused", deviceId })}
      />
    );
  }
  if (state.kind === "refused") {
    return (
      <Notice tone="error">
        The request for <strong className="whitespace-nowrap">{state.deviceId}</strong> was not approved. Contact your
        administrator; they can issue a new enrollment QR.
      </Notice>
    );
  }
  return (
    <>
      <Notice tone="ok">
        <strong>Device enrolled successfully.</strong>
        <br />
        This device is now approved for FabOrchestrator access as{" "}
        <strong className="whitespace-nowrap">{state.deviceId}</strong>.
      </Notice>
      <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
        You are not signed in. Open FabOrchestrator and sign in as usual.
        {state.ios && !state.installed
          ? " On an iPhone, an app you add to the Home Screen from this browser joins this device by itself, with no second QR."
          : ""}
      </p>
      <Button
        variant="primary"
        className="w-full justify-center py-[15px] text-[16px]"
        style={{ borderRadius: 13 }}
        onClick={() => window.location.replace("/")}
      >
        Open FabOrchestrator
      </Button>
    </>
  );
}
