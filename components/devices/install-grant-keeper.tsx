"use client";

/**
 * Keeps an install grant ready on this app's own pages, and tells the device's
 * owner when an installed app has joined the device
 * (`lib/devices/install-grant.ts`).
 *
 * ── Why it runs all the time ────────────────────────────────────────────────
 * Nothing tells a page that its owner is about to tap "Add to Home Screen":
 * iOS fires no event, and copies the browser's cookies into the new app as
 * they are at that moment. So the grant has to be there already. While a page
 * is open and visible in an approved browser, this asks for one when the page
 * loads, when it returns to the foreground, and once a minute after that. The
 * timed call does nothing unless the grant held is close to running out; a
 * return to the foreground always asks, because the grant may have been used
 * by an app in the meantime (`keepInstallGrant`). `public/fo-shell.js` does the same on
 * FabOrchestrator's own pages, where an operator spends most of their time.
 *
 * It renders nothing, with one exception: the first time the server reports
 * an installed app attached to this device that this browser has not been
 * told about, a notice says so. An app nobody on this device added is exactly
 * what the notice is for.
 *
 * Rendered from the root layout, like the install hint, so it runs on the
 * sign-in page and the enrollment page too: a person may add the app to the
 * Home Screen before they have ever signed in.
 */

import * as React from "react";
import { X } from "lucide-react";
import { keepInstallGrant, type AttachedApp } from "@/lib/devices/keystore";

/** The installed-app credential this browser has already shown its owner. */
const SEEN_APP_KEY = "fo_install_app_seen";
const CHECK_EVERY_MS = 60_000;

export function InstallGrantKeeper() {
  const [added, setAdded] = React.useState<AttachedApp | null>(null);

  React.useEffect(() => {
    let stopped = false;
    const keep = (force = false) => {
      if (stopped || document.visibilityState !== "visible") return;
      void keepInstallGrant({ force })
        .then((result) => {
          if (stopped) return;
          // An installed app's own key is never given a grant: stop asking.
          if (result.kind === "refused") stopped = true;
          if (result.kind !== "kept" || !result.app) return;
          let seen: string | null = null;
          try {
            seen = window.localStorage.getItem(SEEN_APP_KEY);
          } catch {
            /* Unreadable storage: the notice shows, which is the safe side. */
          }
          if (seen !== result.app.credentialId) setAdded(result.app);
        })
        .catch(() => {
          /* The network, or storage: the next tick tries again. */
        });
    };
    const onVisibility = () => keep(true);
    keep();
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => keep(), CHECK_EVERY_MS);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, []);

  if (!added) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(SEEN_APP_KEY, added.credentialId);
    } catch {
      /* It will show again on the next page; nothing else depends on it. */
    }
    setAdded(null);
  };

  return (
    <div
      role="status"
      data-testid="install-app-added"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-[520px] items-start gap-3 px-4 py-3 text-[14px] leading-[1.5]"
      style={{
        background: "var(--surface, #fff)",
        color: "var(--text-ink, #10153a)",
        border: "1px solid var(--border-light, #dfe2f0)",
        borderRadius: 14,
        boxShadow: "0 10px 30px rgba(16,21,58,.18)",
      }}
    >
      <span>
        <strong>The FabOrchestrator app was added to this device</strong> on {new Date(added.addedAt).toLocaleString()}. It uses this
        device&rsquo;s approval. If that was not you, tell your administrator: they can remove it under Devices.
      </span>
      <button type="button" aria-label="Dismiss" onClick={dismiss} className="shrink-0 bg-transparent p-1" style={{ border: 0, color: "inherit" }}>
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}
