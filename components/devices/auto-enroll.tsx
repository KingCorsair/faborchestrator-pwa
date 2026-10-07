"use client";

/**
 * Enrolls this device as soon as the enrollment page opens: no email, no
 * password, no button. The code in the pending-enrollment cookie is the whole
 * authorization (`/api/pwa/device-enrollments/complete`).
 *
 * It runs from the page, not from the link's GET, so that a link preview or a
 * mail scanner that fetches the URL without running the page cannot spend the
 * code. One attempt per page load: React's development double-invoke of
 * effects is absorbed by the ref, and a second POST would only ever find the
 * code already used.
 *
 * It does not sign anybody in. "Open FabOrchestrator" goes to the normal front
 * door, where the approved device now meets the normal sign-in.
 */

import * as React from "react";
import { Button } from "@/components/fab/primitives";
import { Notice } from "./device-card";

function isInstalledApp(): boolean {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

type State =
  | { kind: "enrolling" }
  | { kind: "done"; deviceId: string; installed: boolean }
  | { kind: "failed"; error: string };

export function AutoEnroll() {
  const [state, setState] = React.useState<State>({ kind: "enrolling" });
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    const installed = isInstalledApp();
    void (async () => {
      try {
        const res = await fetch("/api/pwa/device-enrollments/complete", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installedApp: installed }),
        });
        const body = (await res.json().catch(() => null)) as
          | { device?: { deviceId: string }; error?: string }
          | null;
        if (res.ok && body?.device) setState({ kind: "done", deviceId: body.device.deviceId, installed });
        else setState({ kind: "failed", error: body?.error ?? "This device could not be enrolled. Try again." });
      } catch {
        setState({ kind: "failed", error: "Could not reach the server. Check the connection and scan the code again." });
      }
    })();
  }, []);

  if (state.kind === "enrolling") {
    return <Notice tone="info">Enrolling this device…</Notice>;
  }
  if (state.kind === "failed") {
    return <Notice tone="error">{state.error}</Notice>;
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
        {state.installed
          ? ""
          : " On an iPhone, this approval belongs to this browser: the Home Screen app keeps its own data and is not approved by it."}
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
