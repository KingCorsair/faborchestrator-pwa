"use client";

/**
 * What the device-check page shows and does (`/device-blocked`).
 *
 * 1. **Ends whatever session this browser holds**, once, on arrival
 *    (`endClientSession`): a revoked device's session, or one that never
 *    proved its device, stops here and is revoked at FabOrchestrator too. A
 *    healthy session that belongs to another credential of the device (the
 *    browser's cookie, copied by iOS into a newly installed app) is only
 *    dropped from this context; the server tells the two apart
 *    (`app/api/pwa/auth/logout`).
 * 2. **Joins the device this app was installed from**, if it can: a context
 *    with no key of its own tries the install grant among its cookies
 *    (`attachFromGrant`, `lib/devices/install-grant.ts`). An app added to the
 *    Home Screen from an approved browser is approved here, with no QR.
 * 3. **Says what this device holds**, as the server reports it (`deviceStatus`;
 *    a key outlives its revocation, and `?reason=` is only as good as the link
 *    that brought the device here, 8 October 2026):
 *    - a key, still approved → "Sign in" (the sign-in page proves the device
 *      with it);
 *    - a key whose device was revoked, or that was itself removed or replaced
 *      by a newer install → refused;
 *    - a key the server could not be asked about → "Sign in", which checks it,
 *      unless `?reason=` says the server refused it a moment ago;
 *    - nothing, or a key the server does not know → "This device is not approved".
 * 4. **Enrolls this device here**: "Scan enrollment QR" opens the camera inside
 *    this page, or a pasted enrollment link does the same. The key is made in
 *    this page's own storage. For a device no browser has enrolled, and the
 *    fallback for an installed app that had no usable grant.
 */

import * as React from "react";
import { Button, Label } from "@/components/fab/primitives";
import { endClientSession } from "@/lib/end-client-session";
import { attachFromGrant, deviceStatus, enroll, isInstalledApp, isIos, storedDevice } from "@/lib/devices/keystore";
import { AwaitingApproval } from "./awaiting-approval";
import { cameraAvailable, createScanner, enrollmentCodeFrom, type Scanner } from "@/lib/devices/scanner";
import { fieldInput, fieldShell, Notice } from "./device-card";

type Held =
  | { kind: "loading" }
  /** `joined`: this app has just joined its browser's device with an install grant. */
  | { kind: "approved"; deviceId: string; joined?: boolean }
  /** Enrolled, and waiting for an administrator to approve it (14 October 2026). */
  | { kind: "pending"; deviceId: string }
  | { kind: "revoked"; deviceId: string }
  /** The device is approved, but this key's own approval was removed or replaced by a newer install. */
  | { kind: "ended"; deviceId: string }
  /** A key is here, but the server could not be asked about it just now. */
  | { kind: "unchecked"; deviceId: string }
  | { kind: "none" };

export function BlockedActions({ reason }: { reason: "revoked" | "pending" | "credential" | "session" | "unavailable" | null }) {
  const [held, setHeld] = React.useState<Held>({ kind: "loading" });
  const [scanning, setScanning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ tone: "error" | "ok" | "info"; text: string } | null>(null);
  const [ios, setIos] = React.useState(false);
  const [installed, setInstalled] = React.useState(true);
  const [camera, setCamera] = React.useState(false);

  React.useEffect(() => {
    endClientSession("device_blocked", { navigate: false });
    setIos(isIos());
    setInstalled(isInstalledApp());
    setCamera(cameraAvailable());
    void (async () => {
      const stored = await storedDevice();
      if (stored.kind === "enrolled") {
        const deviceId = stored.credential.deviceId;
        const status = await deviceStatus(stored.credential);
        return setHeld(
          status === "unknown"
            ? { kind: "none" }
            : { kind: status === "unavailable" ? "unchecked" : status === "credential-ended" ? "ended" : status, deviceId },
        );
      }
      // No key here. If this app was added to the Home Screen from an approved
      // browser, the cookies it was installed with hold a one-time install
      // grant: use it, and this app joins that browser's device.
      if (stored.kind === "none") {
        try {
          const joined = await attachFromGrant();
          if (joined.ok) return setHeld({ kind: "approved", deviceId: joined.deviceId, joined: true });
        } catch {
          /* No grant, or no network: the enrollment QR below still works. */
        }
      }
      setHeld({ kind: "none" });
    })();
  }, []);

  const runEnrollment = React.useCallback(async (code: string) => {
    setScanning(false);
    setBusy(true);
    setMessage({ tone: "info", text: "Enrolling this device…" });
    try {
      const result = await enroll(code);
      if (result.ok && result.pending) {
        setHeld({ kind: "pending", deviceId: result.deviceId });
        setMessage(null);
      } else if (result.ok) {
        setHeld({ kind: "approved", deviceId: result.deviceId });
        setMessage({ tone: "ok", text: `Device enrolled successfully. This device is now approved as ${result.deviceId}.` });
      } else {
        setMessage({ tone: "error", text: result.error });
      }
    } catch {
      setMessage({ tone: "error", text: "Could not reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  }, []);

  const onScanned = React.useCallback(
    (text: string) => {
      const code = enrollmentCodeFrom(text, window.location.origin);
      if (code) void runEnrollment(code);
      else {
        setScanning(false);
        setMessage({ tone: "error", text: "That is not an enrollment QR for this app." });
      }
    },
    [runEnrollment],
  );

  // The server's answer wins; `?reason=` speaks only when it could not be asked.
  const revoked = held.kind === "revoked" || (held.kind === "unchecked" && reason === "revoked");
  const ended = held.kind === "ended" || (held.kind === "unchecked" && reason === "credential");
  const canEnroll = held.kind === "none" || revoked || ended;

  return (
    <>
      {held.kind === "loading" ? null : held.kind === "pending" ? (
        <AwaitingApproval
          deviceId={held.deviceId}
          onDecided={(status) =>
            setHeld(status === "approved" ? { kind: "approved", deviceId: held.deviceId } : { kind: "revoked", deviceId: held.deviceId })
          }
        />
      ) : revoked ? (
        <Notice tone="error">
          This device ({held.deviceId}) has been revoked, or its request to join was refused. It cannot access
          FabOrchestrator. Contact your administrator; they can approve it again with a new enrollment QR.
        </Notice>
      ) : ended ? (
        <Notice tone="error">
          This app is no longer approved on {held.deviceId}: its approval was removed, or a newer install of the app
          replaced it. Use the app you added to the Home Screen most recently, or contact your administrator.
        </Notice>
      ) : held.kind === "approved" || held.kind === "unchecked" ? (
        <>
          {held.kind === "approved" ? (
            <Notice tone="ok">
              {held.joined ? (
                <>
                  This app was added to <strong className="whitespace-nowrap">{held.deviceId}</strong>, the device its
                  browser is approved as. Sign in to continue.
                </>
              ) : (
                <>
                  This device is approved as <strong className="whitespace-nowrap">{held.deviceId}</strong>.
                  {reason === "session" ? " Your previous session was signed out; sign in again." : ""}
                </>
              )}
            </Notice>
          ) : (
            <Notice tone="info">
              This device is <strong className="whitespace-nowrap">{held.deviceId}</strong>, but it could not be checked
              just now. Sign in to try again.
            </Notice>
          )}
          <Button
            variant="primary"
            className="w-full justify-center py-[15px] text-[16px]"
            style={{ borderRadius: 13 }}
            onClick={() => window.location.replace("/login")}
          >
            Sign in
          </Button>
        </>
      ) : (
        <>
          <p className="m-0 text-[15px] leading-[1.6]" style={{ color: "var(--text-ink)" }}>
            This device is not approved to access FabOrchestrator.
          </p>
          <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
            Please contact your administrator to enroll this device. They will show you a one-time enrollment QR.
            {ios && installed
              ? " If this phone's browser is already approved: open FabOrchestrator in that browser, remove this app, and add it to the Home Screen again. It is then approved automatically. Otherwise scan the QR here, inside the app."
              : ios
                ? " Scanning it with the Camera approves this browser, and an app you then add to the Home Screen from it is approved automatically."
                : ""}
          </p>
        </>
      )}

      {message && message.tone !== "ok" ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {canEnroll ? (
        <div className="flex flex-col gap-[10px]">
          <Button
            variant="primary"
            disabled={busy || !camera}
            className="w-full justify-center py-[15px] text-[16px]"
            style={{ borderRadius: 13 }}
            onClick={() => setScanning(true)}
          >
            Scan enrollment QR
          </Button>
          {scanning ? <ScanPanel onResult={onScanned} onClose={() => setScanning(false)} /> : null}
          <PasteLink
            disabled={busy}
            onCode={(code) => void runEnrollment(code)}
            onInvalid={() => setMessage({ tone: "error", text: "That is not an enrollment link for this app." })}
          />
        </div>
      ) : null}
    </>
  );
}

function PasteLink({ onCode, onInvalid, disabled }: { onCode: (code: string) => void; onInvalid: () => void; disabled: boolean }) {
  return (
    <form
      method="post"
      className="flex flex-col gap-[10px]"
      onSubmit={(event) => {
        event.preventDefault();
        const value = String(new FormData(event.currentTarget).get("link") ?? "");
        const code = enrollmentCodeFrom(value, window.location.origin);
        if (code) onCode(code);
        else onInvalid();
      }}
    >
      <label className="flex flex-col gap-[7px]">
        <Label>Or paste the enrollment link</Label>
        <div className="flex items-center gap-[11px] px-[15px] py-[13px]" style={fieldShell}>
          <input
            name="link"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent text-[15px] outline-none"
            style={fieldInput}
          />
        </div>
      </label>
      <Button type="submit" variant="secondary" disabled={disabled} className="w-full justify-center py-[13px]">
        Enroll with this link
      </Button>
    </form>
  );
}

function ScanPanel({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const [status, setStatus] = React.useState("Starting camera…");
  // Through a ref: a parent re-render must not restart the camera.
  const onResultRef = React.useRef(onResult);
  React.useEffect(() => {
    onResultRef.current = onResult;
  });

  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let scanner: Scanner | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped) return;
        const el = video.current!;
        el.srcObject = stream;
        await el.play();
        scanner = await createScanner();
        setStatus("Point the camera at the enrollment QR.");
        const tick = async () => {
          if (stopped || !scanner) return;
          try {
            const found = await scanner.detect(el);
            if (found[0]) {
              onResultRef.current(found[0]);
              return;
            }
          } catch {
            /* a bad frame; keep going */
          }
          timer = setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch (error) {
        setStatus(`The camera is not available (${error instanceof Error ? error.message : String(error)}). Paste the link instead.`);
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      scanner?.dispose();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="flex flex-col gap-[8px]">
      <video
        ref={video}
        playsInline
        muted
        autoPlay
        aria-label="Camera"
        style={{ width: "100%", maxHeight: 320, background: "#000", borderRadius: 12, objectFit: "cover" }}
      />
      <span className="text-[13px]" style={{ color: "var(--text-muted-cool)" }}>
        {status}
      </span>
      <Button variant="secondary" className="w-full justify-center py-[11px]" onClick={onClose}>
        Close camera
      </Button>
    </div>
  );
}
