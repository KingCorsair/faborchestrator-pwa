"use client";

/**
 * What a person sees when one of this app's own screens throws something
 * nobody planned for.
 *
 * Ported from the `chetan` branch (`e843b9c`, 2026-09-28). The app had no
 * error boundary: an exception while rendering replaced the screen with Next's
 * bare "Application error", and an installed app has no address bar to get
 * off it. Rendered by `app/error.tsx` and `app/global-error.tsx`.
 *
 * It covers the PWA's own documents only (sign-in, `/offline`,
 * `/diagnostics`, the native screens during the soak). Embedded FabOrchestrator
 * pages have FO's own error handling.
 *
 * ── Adapted to the plan (RP5, "error pages") ────────────────────────────────
 *  - **Never the exception text.** Only a canonical sentence.
 *  - **The reference is Next's `digest`**, when there is one: the id Next
 *    writes beside a server-side failure in the log, so what an operator reads
 *    out is what support searches for. A failure purely in the browser has no
 *    digest, and then no reference is shown rather than an invented one.
 *  - **It does not report itself.** The chetan branch posted a crash report to
 *    `/api/client-error`; that is a new unauthenticated endpoint the plan does
 *    not have yet (it would need RP3's anonymous rate cap), so it was not
 *    ported, and this screen does not claim the crash "has been reported".
 *  - Ways on: try again, the start page, `/diagnostics` and `/offline`, and
 *    "reset and reload" for a service worker whose stored copies cannot be
 *    trusted (the same escape `public/sw.js` offers).
 */

import * as React from "react";
import { TriangleAlert } from "lucide-react";

export function CrashScreen({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
}) {
  const [resetting, setResetting] = React.useState(false);
  const reference = error.digest;

  return (
    <div
      className="fab flex min-h-full items-center justify-center px-6 py-10"
      style={{ background: "var(--page-surface)" }}
    >
      <div
        role="alert"
        className="flex w-full max-w-[420px] flex-col items-center gap-[13px] text-center"
      >
        <div
          className="grid place-items-center"
          style={{
            width: 58,
            height: 58,
            borderRadius: "var(--r-control)",
            background: "var(--status-amber-bg)",
            color: "var(--status-amber-ink)",
          }}
        >
          <TriangleAlert size={26} strokeWidth={1.9} aria-hidden="true" />
        </div>

        <span
          className="text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{ color: "var(--text-subtle)" }}
        >
          FabOrchestrator
        </span>

        <h1 className="m-0 text-[20px]">Something went wrong on this screen</h1>

        <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
          The app ran into a problem it did not expect. This is a fault in the app, not in anything
          you did.
        </p>

        {reference ? (
          <p className="m-0 text-[12px] leading-[1.6]" style={{ color: "var(--text-subtle)" }}>
            Reference <span className="font-bold">{reference}</span>. Quote it if you contact
            support.
          </p>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center justify-center gap-[10px]">
          {reset ? (
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex cursor-pointer items-center justify-center border-0 px-[16px] py-[11px] text-[14px] font-bold"
              style={{
                borderRadius: "var(--r-control)",
                background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
                color: "#fff",
                boxShadow: "var(--shadow-brand)",
              }}
            >
              Try again
            </button>
          ) : null}

          {/* A plain <a>, not next/link: a full navigation leaves nothing of the
              failed screen behind, and does not depend on the router that may
              be what failed. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            className="inline-flex items-center justify-center px-[16px] py-[11px] text-[14px] font-bold no-underline"
            style={{
              borderRadius: "var(--r-control)",
              background: "var(--pure-white)",
              color: "var(--text-ink)",
              border: "1px solid var(--border-light)",
            }}
          >
            Go to the start page
          </a>
        </div>

        <button
          type="button"
          disabled={resetting}
          onClick={() => {
            setResetting(true);
            void resetAndReload();
          }}
          className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-bold underline decoration-1 underline-offset-2 disabled:cursor-wait disabled:opacity-60"
          style={{ color: "var(--text-subtle)" }}
        >
          {resetting ? "Resetting…" : "Still broken? Reset and reload"}
        </button>

        <p className="m-0 text-[12px]" style={{ color: "var(--text-subtle)" }}>
          <a href="/diagnostics" style={{ color: "inherit" }}>
            Diagnostics
          </a>
          {" · "}
          <a href="/offline" style={{ color: "inherit" }}>
            Offline page
          </a>
        </p>
      </div>
    </div>
  );
}

/**
 * Forget every stored copy of the app, then load it fresh. Each step may fail
 * on its own; the reload is the part that matters.
 */
async function resetAndReload(): Promise<void> {
  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    /* No worker to unregister. */
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    /* No caches to clear. */
  }
  window.location.reload();
}
