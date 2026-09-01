"use client";

/**
 * The scan sheet — camera in, order number out.
 *
 * A full-screen sheet rather than an inline viewfinder: scanning is a mode, and
 * a camera preview sitting permanently above a list is a battery cost the
 * supervisor pays all shift for a thing they do twice.
 *
 * Everything that can go wrong here is a thing that happens on a real shop
 * floor — permission refused, no camera on the device, a decoded label that
 * turns out to be the machine's asset tag rather than an order — so each gets
 * its own message naming what to do next, and every one of them leaves the
 * typed search working.
 */

import * as React from "react";
import { Camera, CameraOff, Keyboard, X } from "lucide-react";
import { Button } from "./primitives";
import { createScanner, extractOrderNumber, scanningIsSupported, type Scanner } from "@/lib/scan/barcode";

/** Four decode attempts a second. Faster does not find labels sooner; it only heats the device. */
const SCAN_INTERVAL_MS = 250;

type Phase = "starting" | "scanning" | "denied" | "unavailable";

export function ScanSheet({
  onFound,
  onClose,
}: {
  onFound: (orderNumber: string) => void;
  onClose: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = React.useState<Phase>("starting");
  const [detail, setDetail] = React.useState<string>();
  /** Set when a label decoded cleanly but held no order number. */
  const [wrongLabel, setWrongLabel] = React.useState<string>();
  const [backend, setBackend] = React.useState<Scanner["kind"] | null>(null);

  // `onFound` in a ref so the scan loop below does not restart — and re-request
  // the camera — every time the parent re-renders.
  const onFoundRef = React.useRef(onFound);
  React.useEffect(() => {
    onFoundRef.current = onFound;
  }, [onFound]);

  // A stable callback that reads the ref when it *fires*, not while rendering.
  // Manual entry needs the same handler the scan loop uses, and passing
  // `onFoundRef.current` down directly would read a ref during render.
  const handleFound = React.useCallback((orderNumber: string) => {
    onFoundRef.current(orderNumber);
  }, []);

  React.useEffect(() => {
    if (!scanningIsSupported()) {
      setPhase("unavailable");
      setDetail(
        "This browser cannot open a camera. On a phone or tablet the page must be served over HTTPS.",
      );
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let scanner: Scanner | null = null;
    let timer: number | null = null;

    const stop = () => {
      if (timer != null) window.clearInterval(timer);
      timer = null;
      scanner?.dispose();
      // Every track, explicitly. A MediaStream with one track left running
      // keeps the camera light on, which reads to an operator as a device that
      // is still recording them.
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // The back camera. `ideal` rather than `exact` so a laptop with only
          // a front camera still scans instead of throwing.
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) return stop();

        const video = videoRef.current;
        if (!video) return stop();
        video.srcObject = stream;
        await video.play();

        scanner = await createScanner();
        if (cancelled) return stop();
        setBackend(scanner.kind);
        setPhase("scanning");

        let busy = false;
        timer = window.setInterval(async () => {
          // Decoding is slower than the interval on the wasm path. Without this
          // guard the calls queue and the sheet freezes on the frame that
          // finally matches.
          if (busy || !scanner || !videoRef.current) return;
          busy = true;
          try {
            const values = await scanner.detect(videoRef.current);
            for (const value of values) {
              const orderNumber = extractOrderNumber(value);
              if (orderNumber) {
                stop();
                onFoundRef.current(orderNumber);
                return;
              }
              // Decoded, but not an order. Keep scanning — the operator may
              // simply be pointing at the wrong label on a crowded traveller.
              setWrongLabel(value.slice(0, 60));
            }
          } catch {
            /* One bad frame is not a failure. The next one is 250 ms away. */
          } finally {
            busy = false;
          }
        }, SCAN_INTERVAL_MS);
      } catch (error) {
        if (cancelled) return;
        stop();
        const name = error instanceof Error ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setPhase("denied");
          setDetail(
            "Camera access was refused. Allow it in the browser's site settings, or type the order number instead.",
          );
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setPhase("unavailable");
          setDetail("This device has no camera the browser can use.");
        } else {
          setPhase("unavailable");
          setDetail(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  // Escape closes, as it must for anything calling itself a dialog.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan a production order"
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--navy-3, #10153a)" }}
    >
      {/*
        Safe areas are applied to the chrome, not to the sheet, so the camera
        preview still fills the screen edge to edge while the controls stay
        reachable. `body` carries the app's insets (app/globals.css) and this
        sheet is `position: fixed`, so it is placed against the viewport and
        inherits none of them — without this the close button sits under the
        Dynamic Island and the status line under the home indicator.

        `max()` rather than the raw inset: on a device with no notch the inset
        is 0, and the sheet would lose the padding it needs on every phone.
        Landscape is the case that actually bites — a notched iPhone turned
        sideways puts a 44px inset on one edge, which is exactly where the
        close button is.
      */}
      <header
        className="flex flex-none items-center justify-between py-3"
        style={{
          paddingTop: "max(12px, env(safe-area-inset-top))",
          paddingLeft: "max(16px, env(safe-area-inset-left))",
          paddingRight: "max(16px, env(safe-area-inset-right))",
        }}
      >
        <span className="flex flex-col gap-[2px]">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/55">
            Production order
          </span>
          <span className="text-[16px] font-extrabold text-white">Scan a label</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close scanner"
          className="grid flex-none cursor-pointer place-items-center border-0 bg-white/10 text-white"
          style={{ width: 36, height: 36, borderRadius: "var(--r-chip)" }}
        >
          <X size={18} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          // The camera feed is decorative to a screen reader — the useful output
          // is the status line below, which is a live region.
          aria-hidden="true"
          className="h-full w-full object-cover"
          style={{ opacity: phase === "scanning" ? 1 : 0 }}
        />

        {phase === "scanning" ? <Reticle /> : null}

        {phase !== "scanning" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
            {phase === "starting" ? (
              <>
                <Camera size={30} strokeWidth={1.8} aria-hidden="true" className="text-white/70" />
                <p className="m-0 text-[14px] font-semibold text-white/80">Opening the camera…</p>
              </>
            ) : (
              <>
                <CameraOff size={30} strokeWidth={1.8} aria-hidden="true" className="text-white/70" />
                <p className="m-0 max-w-[320px] text-[14px] leading-[1.6] text-white/80">{detail}</p>
                <ManualEntry onFound={handleFound} />
                {/* `style` last wins in Button, so no !important games. */}
                <Button variant="ghost" onClick={onClose} style={{ color: "rgba(255,255,255,.6)" }}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <footer
        className="flex flex-none flex-col gap-[6px] pt-4 text-center"
        style={{
          paddingBottom: "calc(28px + env(safe-area-inset-bottom))",
          paddingLeft: "max(20px, env(safe-area-inset-left))",
          paddingRight: "max(20px, env(safe-area-inset-right))",
        }}
      >
        <p role="status" className="m-0 text-[14px] font-semibold text-white">
          {phase === "scanning"
            ? wrongLabel
              ? `Read “${wrongLabel}” — that is not an order number. Point at the order barcode.`
              : "Point the camera at the order barcode or QR code."
            : " "}
        </p>
        {backend ? (
          // Which backend decoded it. Not decoration: when a scan fails on one
          // device and works on another, this is the first thing to compare.
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">
            {backend === "native" ? "Device decoder" : "WebAssembly decoder"}
          </span>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * Type the order number when the camera cannot be used.
 *
 * The camera is the fast path, never the only one. A refused permission, a
 * device with no camera, a page served over plain HTTP on a LAN address, a
 * scuffed label, bad light — all of them end here, and all of them are ordinary
 * on a shop floor. Closing the sheet and asking the operator to find the search
 * box is a dead end dressed up as a fallback.
 *
 * Validated with the same `extractOrderNumber` the scanner uses, so a typed
 * number and a scanned one are the same thing by the time they leave here — and
 * a URL pasted from an MES email works too.
 */
function ManualEntry({ onFound }: { onFound: (orderNumber: string) => void }) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string>();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const orderNumber = extractOrderNumber(value);
    if (!orderNumber) {
      setError("That is not a production order number. They look like PO-10382.");
      return;
    }
    onFound(orderNumber);
  };

  return (
    <form onSubmit={submit} className="mt-1 flex w-full max-w-[320px] flex-col gap-[9px]">
      <label className="flex flex-col gap-[6px] text-left">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/55">
          Order number
        </span>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(undefined);
          }}
          placeholder="PO-10382"
          autoFocus
          // A shop-floor keyboard should not autocorrect an order number into a
          // word, or capitalise it into something the regex then has to undo.
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
          className="w-full px-[13px] py-[11px] text-[16px] font-semibold text-white outline-none"
          style={{
            background: "rgba(255,255,255,.12)",
            borderRadius: "var(--r-control)",
            border: `1px solid ${error ? "var(--status-red)" : "transparent"}`,
          }}
        />
      </label>
      {error ? (
        <span role="alert" className="text-left text-[12px] text-white/80">
          {error}
        </span>
      ) : null}
      <Button variant="primary" type="submit">
        <Keyboard size={15} strokeWidth={2.2} aria-hidden="true" />
        Open order
      </Button>
    </form>
  );
}

/**
 * The viewfinder frame. Four corners rather than a full rectangle — a closed box
 * invites the operator to fit the whole label inside it, which puts the barcode
 * too far away to resolve.
 */
function Reticle() {
  const corner: React.CSSProperties = {
    position: "absolute",
    width: 34,
    height: 34,
    borderColor: "rgba(255,255,255,.9)",
    borderStyle: "solid",
    borderWidth: 0,
  };
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{ width: "min(78vw, 320px)", height: "min(44vw, 190px)" }}
    >
      <span style={{ ...corner, top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 12 }} />
      <span style={{ ...corner, top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 12 }} />
      <span style={{ ...corner, bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 12 }} />
      <span style={{ ...corner, bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 12 }} />
    </div>
  );
}
