"use client";

/**
 * "Add to Home Screen" — the prompt iOS does not give you.
 *
 * Chrome fires `beforeinstallprompt` and an app can offer a real install
 * button. **Safari fires nothing and never has.** On an iPhone the only way in
 * is Share → Add to Home Screen, buried two taps into a sheet of twenty
 * options, and a user who is not told about it will never find it. For a demo
 * whose whole point is that this installs and runs like an app, that is the
 * difference between the demo landing and the demo being a website on a phone.
 *
 * Three conditions, all required:
 *
 *  1. **iOS.** Android Chrome has its own install affordance and must not get
 *     instructions for a menu it does not have.
 *  2. **Not already installed.** Telling somebody to install the app they are
 *     standing inside is the clearest possible signal that nobody tested this.
 *  3. **Not dismissed before.** One `localStorage` flag. A hint that returns
 *     after you have refused it is an advertisement.
 *
 * Rendered from the root layout rather than from `AppShell`, so it also
 * appears on the login screen — which is the first thing anybody opening the
 * URL on a phone actually sees, and the natural moment to install.
 */

import * as React from "react";
import { Info, Share, Plus, X } from "lucide-react";
import { isIOSPlatform } from "@/lib/platform";

const DISMISSED_KEY = "faborch_install_hint_dismissed";

/**
 * `display-mode: standalone` is the standard signal; `navigator.standalone` is
 * Apple's own, predates it, and is still the reliable one on older iOS. Either
 * being true means we are already installed.
 */
function isInstalled(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function IOSInstallHint() {
  // Starts false and is only ever set inside an effect. Every check here reads
  // `navigator` or `localStorage`, neither of which exists during the server
  // render — deciding this at render time is a hydration mismatch.
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      /* Private mode can throw on read. A hint is not worth failing over. */
    }
    if (!isIOSPlatform(navigator.userAgent, navigator.maxTouchPoints) || isInstalled()) return;
    setShow(true);
  }, []);

  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* Refusing to remember is better than refusing to close. */
    }
  };

  if (!show) return null;

  return (
    <div
      // `fab` so the design tokens resolve — this renders from the root layout,
      // outside the `.fab` subtree every screen sits in.
      className="fab fixed inset-x-0 bottom-0 z-40 flex justify-center px-3"
      // Bottom, not top: in Safari the Share button is in the bottom toolbar,
      // a few millimetres below this card. A hint at the top of the screen
      // points away from the control it is describing.
      //
      // The inset is added to the padding rather than replacing it, because
      // this sits above the home indicator *and* above Safari's own toolbar.
      style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom))" }}
      role="status"
    >
      {/*
        Styled as a **notice, not a card**.

        This was a `fab-card` with `--shadow-lifted` — the exact treatment the
        app's tappable cards use. On a touchscreen there is no hover state to
        separate them, so it read as a button, and the first person to see it on
        a phone tapped the middle of it and reported that "the download button
        doesn't work". Nothing was broken: there is no button, because **iOS
        offers no API to trigger Add to Home Screen.** Safari fires no
        `beforeinstallprompt` and exposes no install method, so this can only
        ever be instructions.

        A tinted panel with a flat border and no shadow, carrying numbered
        steps: nothing here looks pressable except the dismiss control, which is
        the only thing that is.
      */}
      <div
        className="flex w-full max-w-[420px] items-start gap-[11px] p-4"
        style={{
          background: "var(--brand-indigo-bg)",
          border: "1px solid var(--brand-indigo-pale)",
          borderRadius: "var(--r-panel)",
        }}
      >
        <span
          aria-hidden="true"
          className="grid flex-none place-items-center"
          style={{ width: 26, height: 26, color: "var(--cockpit-indigo)" }}
        >
          <Info size={19} strokeWidth={2} />
        </span>

        <div className="flex min-w-0 flex-col gap-[6px]">
          <span className="text-[14px] font-bold" style={{ color: "var(--text-ink)" }}>
            To install this app
          </span>

          {/* Numbered, because it is a two-step manual procedure in somebody
              else's UI. "Add to Home Screen" is the exact string on the row
              they are hunting for, and it sits well down a long sheet — saying
              "use the share menu" is not an instruction. */}
          <ol
            className="m-0 flex list-none flex-col gap-[5px] p-0 text-[12px] leading-[1.5]"
            style={{ color: "var(--text-muted-cool)" }}
          >
            <li className="flex flex-wrap items-center gap-[5px]">
              <Step n={1} />
              Tap
              <Share size={13} strokeWidth={2.2} aria-hidden="true" />
              <strong style={{ color: "var(--text-ink)" }}>Share</strong>
              in Safari&rsquo;s bottom bar
            </li>
            <li className="flex flex-wrap items-center gap-[5px]">
              <Step n={2} />
              Scroll down, tap
              <Plus size={13} strokeWidth={2.2} aria-hidden="true" />
              <strong style={{ color: "var(--text-ink)" }}>Add to Home Screen</strong>
            </li>
          </ol>
        </div>

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install instructions"
          className="ml-auto grid flex-none cursor-pointer place-items-center bg-transparent"
          style={{
            width: 30,
            height: 30,
            borderRadius: "var(--r-chip)",
            border: "1px solid var(--brand-indigo-pale)",
            color: "var(--cockpit-indigo)",
          }}
        >
          <X size={16} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** The step number, as a chip. Keeps the two lines scannable as a sequence. */
function Step({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid flex-none place-items-center text-[10px] font-extrabold"
      style={{
        width: 16,
        height: 16,
        borderRadius: 999,
        background: "var(--cockpit-indigo)",
        color: "var(--pure-white)",
      }}
    >
      {n}
    </span>
  );
}
