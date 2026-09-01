/**
 * `/offline` — what the installed app shows when the network is gone.
 *
 * The alternative is Chrome's dinosaur or iOS's "Safari cannot open the page",
 * which in a standalone window with no address bar looks like the app itself
 * has broken. This is a FabOrchestrator screen that says what is true.
 *
 * **It states plainly that order data is not available offline**, because the
 * one thing this app must never do is show a supervisor a figure it cannot
 * stand behind. Cached MES data is not a feature this tier has, and a page that
 * implied otherwise would be worse than the dinosaur.
 *
 * Static, self-contained and precached by `public/sw.js` — it cannot fetch
 * anything, by definition of when it is shown.
 */

import type { Metadata } from "next";
import { CloudOff } from "lucide-react";

export const metadata: Metadata = {
  title: "Offline — FabOrchestrator",
  robots: "noindex, nofollow",
};

/**
 * Leaves this page by itself once the network answers.
 *
 * Two reasons it has to, and both were live defects on 2026-08-18 when the
 * installed app opened straight onto this screen while the phone was online:
 *
 *  - **A worker can be wrong.** `public/sw.js` now retries before it concludes
 *    anything, but a copy of the *old* worker is already installed on every
 *    phone that has the app, and it will serve this page one more time before
 *    the new one takes over. This script is what rescues that launch.
 *  - **iOS pins the icon to the URL that was on screen.** Add to Home Screen
 *    saves the *current* address, not the manifest's `start_url` — so an icon
 *    created while this page was showing opens `/offline` forever, on a perfect
 *    connection, and no amount of fixing the worker touches it.
 *
 * ── Why an inline script and not a component ────────────────────────────────
 * This page is served from the cache with the network presumed down, so its
 * JS chunks may not be fetchable. Anything in a `"use client"` component would
 * simply never run. Inline in the HTML, it is part of the precached document.
 *
 * ── Why it probes instead of trusting `navigator.onLine` ────────────────────
 * `onLine` reports whether there is a *link*, not whether anything is reachable
 * — it is `true` on a hotel wifi that has captured every request. A real
 * same-origin request is the only honest answer, and this file's whole argument
 * is against claiming things you cannot check.
 *
 * ── Why the guard is a cooldown and not a latch ─────────────────────────────
 * If the probe succeeds and the navigation still lands back here, the two pages
 * would bounce forever and the "Try again" button would never be reachable. So
 * there is a guard — but it stores a **timestamp**, not a flag.
 *
 * It stored a flag, and that was a bug (2026-08-19). An installed iOS web app is
 * resumed far more often than it is restarted, and `sessionStorage` survives
 * that — so one recovery attempt disabled recovery **permanently** for that
 * install. Combined with iOS pinning the Home Screen icon to whatever URL was on
 * screen when it was added, an app pinned to `/offline` then opened onto this
 * page on every launch, at full signal, with the one mechanism that could have
 * rescued it switched off by its own first success.
 *
 * Ten seconds bounds a bounce to one attempt per launch without ever taking the
 * escape away.
 */
const RECOVERY_SCRIPT = `
(function () {
  var KEY = "faborch-offline-recovery";
  var COOLDOWN_MS = 10000;
  try {
    var last = parseInt(sessionStorage.getItem(KEY) || "0", 10);
    if (last && Date.now() - last < COOLDOWN_MS) return;
  } catch (e) {
    /* Private mode can throw on read. Recovering twice beats never. */
  }

  // Served in place of /orders, the address bar still says /orders — so reload
  // where we are. Only a bookmark that literally points here needs sending on.
  var target = location.pathname === "/offline" ? "/orders" : location.href;

  function recover() {
    // Cache-busted and same-origin: a captive portal answering from cache would
    // otherwise read as a working network.
    fetch("/icon-192.png?probe=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) return;
        try {
          sessionStorage.setItem(KEY, String(Date.now()));
        } catch (e) {
          /* Nothing to do; the guard is best-effort. */
        }
        location.replace(target);
      })
      .catch(function () {
        /* Genuinely offline. Stay put — the page is telling the truth. */
      });
  }

  addEventListener("online", recover);
  recover();
})();
`;

export default function OfflinePage() {
  return (
    <div
      className="fab flex min-h-full items-center justify-center px-6 py-10"
      style={{ background: "var(--page-surface)" }}
    >
      <script dangerouslySetInnerHTML={{ __html: RECOVERY_SCRIPT }} />

      <div className="flex w-full max-w-[420px] flex-col items-center gap-[13px] text-center">
        <div
          className="grid place-items-center"
          style={{
            width: 58,
            height: 58,
            borderRadius: "var(--r-control)",
            background: "var(--brand-indigo-bg)",
            color: "var(--cockpit-indigo)",
          }}
        >
          <CloudOff size={26} strokeWidth={1.9} aria-hidden="true" />
        </div>

        <span
          className="text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{ color: "var(--text-subtle)" }}
        >
          FabOrchestrator
        </span>

        <h1 className="m-0 text-[20px]">No connection</h1>

        <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
          The app is installed and running, but it cannot reach the MES. Production order data is
          read live and is not stored on this device — so there is nothing to show rather than
          something out of date.
        </p>

        <p className="m-0 text-[12px] leading-[1.6]" style={{ color: "var(--text-subtle)" }}>
          Reconnect to the site network and try again. Anything you already approved, rejected or
          escalated was recorded when you did it.
        </p>

        {/* Deliberately a plain <a>, not next/link. This page is served from the
            service worker's cache with the network down, so its JS chunks may
            not be there — a client-side router transition would do nothing at
            all. A full navigation is also exactly the retry we want: it asks
            the network again. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/orders"
          className="mt-1 inline-flex items-center justify-center px-[16px] py-[11px] text-[14px] font-bold no-underline"
          style={{
            borderRadius: "var(--r-control)",
            background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
            color: "#fff",
            boxShadow: "var(--shadow-brand)",
          }}
        >
          Try again
        </a>
      </div>
    </div>
  );
}
