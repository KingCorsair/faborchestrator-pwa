"use client";

/**
 * What a person sees when a screen throws something nobody planned for.
 *
 * ── Why this exists (2026-09-28) ────────────────────────────────────────────
 * The app had no error boundary anywhere. An unexpected exception while a
 * screen rendered replaced it with Next's bare "Application error: a
 * client-side exception has occurred" — white, unstyled, with no control on it.
 * In an installed app there is no address bar either, so that was a dead end:
 * the only way out was to force-quit, and the same screen was often waiting.
 *
 * Rendered by `app/error.tsx` (a screen failed; the shell is intact) and
 * `app/global-error.tsx` (the root layout itself failed). Styled like
 * `/offline`, its sibling: one icon tile, one sentence of fact, ways on.
 *
 * ── Three ways on ───────────────────────────────────────────────────────────
 *  - **Try again** re-renders the screen, which is enough when the failure was
 *    a moment's bad data.
 *  - **Go to the cockpit** is a full navigation, so nothing of the failed
 *    screen's state comes with it.
 *  - **Reset and reload** unregisters the service worker, deletes its caches
 *    and reloads — the escape `public/sw.js` offers when its stored copies
 *    cannot be trusted. A page naming script chunks a deploy has since removed
 *    is the commonest way an installed app crashes, and this is its cure.
 *
 * ── It reports itself ───────────────────────────────────────────────────────
 * A short report goes to `/api/client-error` and into the server log beside
 * every other failure (`lib/report-error.ts`). The reference on this screen is
 * the one in the log, so what an operator reads out is what support searches.
 * It is made after mount, not while rendering: a random value rendered on the
 * server and again in the browser would differ, and React would say so.
 */

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { clientErrorReport, newReference, sendClientErrorReport } from "@/lib/client-error";

export function CrashScreen({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
}) {
  const [reference, setReference] = React.useState<string | null>(null);
  const [resetting, setResetting] = React.useState(false);

  React.useEffect(() => {
    const made = newReference();
    setReference(made);
    sendClientErrorReport(clientErrorReport(error, window.location.pathname, made));
  }, [error]);

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
          you did, and it has been reported.
        </p>

        {reference ? (
          <p className="m-0 text-[12px] leading-[1.6]" style={{ color: "var(--text-subtle)" }}>
            Reference <span className="font-bold">{reference}</span> — quote it if you contact
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
            Go to the cockpit
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
      </div>
    </div>
  );
}

/**
 * Forget every stored copy of the app, then load it fresh.
 *
 * Each step is allowed to fail on its own — a browser without a service worker
 * or without Cache Storage still gets the reload, which is the part that
 * matters.
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
