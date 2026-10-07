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
 */

import * as React from "react";
import { Button } from "@/components/fab/primitives";
import { enroll, isInstalledApp, isIos } from "@/lib/devices/keystore";
import { Notice } from "./device-card";

type State =
  | { kind: "enrolling" }
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
        if (result.ok) setState({ kind: "done", deviceId: result.deviceId, installed: isInstalledApp(), ios: isIos() });
        else setState({ kind: "failed", error: result.error });
      } catch {
        setState({ kind: "failed", error: "Could not reach the server. Check the connection and scan the code again." });
      }
    })();
  }, []);

  if (state.kind === "enrolling") return <Notice tone="info">Enrolling this device…</Notice>;
  if (state.kind === "failed") return <Notice tone="error">{state.error}</Notice>;
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
          ? " On an iPhone this approval belongs to Safari. The Home Screen app keeps its own storage and needs its own enrollment, scanned inside the app."
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
