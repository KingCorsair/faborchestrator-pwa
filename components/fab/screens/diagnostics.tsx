"use client";

/**
 * `/diagnostics` — what this browser can actually do.
 *
 * **Why this screen exists.** The demo is shown from a Windows laptop to an
 * iPhone, and Windows cannot remote-debug iOS Safari. There is no console, no
 * network panel and no way to evaluate an expression on that device. Without
 * this page every iPhone failure is a guess, and the likely causes look
 * identical from across a room.
 *
 * Every check here answers a question that has actually cost time:
 *
 *  - **Secure context** gates `serviceWorker`. Over plain HTTP on a LAN address
 *    it vanishes silently and the app is simply not installable, with no error
 *    anywhere. This is the single most likely reason an iPhone demo goes wrong,
 *    so it is the first row.
 *  - **Safe-area insets** are how you confirm the notch handling is real rather
 *    than believed. They read 0 on a laptop, so a desktop check proves nothing.
 *  - **Display mode** distinguishes an installed launch from a browser tab,
 *    which is behind most of "it works in Safari but not in the app".
 *
 * Deliberately **unauthenticated**. It reports on the browser, not on
 * production data, and the moment it is worth opening is the moment nothing
 * else works — a diagnostics page behind a login you cannot complete is not a
 * diagnostics page. Nothing here reads FabOrchestrator.
 */

import * as React from "react";
import Link from "next/link";
import { ShieldCheck, Smartphone } from "lucide-react";
import { Card, Code, Label, Pill, type Tone } from "../primitives";

type Verdict = "ok" | "warn" | "bad" | "info";

interface Check {
  label: string;
  value: string;
  verdict: Verdict;
  /** Shown under the row. Only where the value alone does not say what to do. */
  note?: string;
}

const TONE: Record<Verdict, Tone> = {
  ok: "ok",
  warn: "warn",
  bad: "danger",
  info: "idle",
};

const VERDICT_WORD: Record<Verdict, string> = {
  ok: "OK",
  warn: "Check",
  bad: "Failed",
  info: "Info",
};

export function Diagnostics() {
  const [checks, setChecks] = React.useState<Check[] | null>(null);

  // Everything below reads `window`, `navigator` or the DOM. None of it exists
  // during the server render, so the screen holds a skeleton until an effect
  // has run rather than rendering two different trees.
  React.useEffect(() => {
    setChecks(collect());
  }, []);

  const report = React.useMemo(() => {
    if (!checks) return "";
    return checks
      .map((c) => `${c.label}: ${c.value} [${VERDICT_WORD[c.verdict]}]`)
      .join("\n");
  }, [checks]);

  return (
    <div className="mx-auto flex w-full max-w-[var(--page-width)] flex-col gap-7 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-[3px]">
          <Label as="h2">Device</Label>
          <h1 className="text-[26px]">Diagnostics</h1>
        </div>
        <Link href="/" className="text-[14px] font-bold no-underline" style={{ color: "var(--cockpit-indigo)" }}>
          Back to orders
        </Link>
      </div>

      <p className="m-0 max-w-[var(--measure)] text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
        What this browser supports, read from the device itself. Nothing here reads production data,
        and no check changes anything. Open this first when something does not work on a phone.
      </p>

      {checks == null ? (
        <Card className="p-5">
          <span className="text-[14px]" style={{ color: "var(--text-subtle)" }}>
            Reading device capabilities…
          </span>
        </Card>
      ) : (
        <>
          <Section
            icon={<ShieldCheck size={16} strokeWidth={2} aria-hidden="true" />}
            title="Secure context and install"
            checks={checks.filter((c) => c.label in SECURE)}
          />

          <Section
            icon={<Smartphone size={16} strokeWidth={2} aria-hidden="true" />}
            title="Layout and session"
            checks={checks.filter((c) => c.label in LAYOUT)}
          />

          {/*
            Plain text, selectable. There is no console to copy from and the
            Clipboard API needs a secure context — which is one of the things
            this page exists to tell you that you do not have. A long-press and
            "Copy" works on any iPhone regardless.
          */}
          <div className="flex flex-col gap-2">
            <Label as="h3">Report</Label>
            <Card className="p-4">
              <pre
                className="m-0 overflow-x-auto text-[12px] leading-[1.7]"
                style={{ color: "var(--text-muted-cool)", fontFamily: "inherit" }}
              >
                {report}
              </pre>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  checks,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  checks: Check[];
  children?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <span className="flex items-center gap-[7px]" style={{ color: "var(--text-muted-cool)" }}>
        {icon}
        <Label as="h2">{title}</Label>
      </span>
      <Card className="flex flex-col">
        {checks.map((check, i) => (
          <div
            key={check.label}
            className="flex flex-wrap items-center gap-x-3 gap-y-[6px] px-5 py-[14px]"
            style={{ borderTop: i === 0 ? undefined : "1px solid var(--border-light)" }}
          >
            <span className="text-[14px] font-semibold" style={{ color: "var(--text-ink)" }}>
              {check.label}
            </span>
            <Pill tone={TONE[check.verdict]} className="ml-auto">
              {VERDICT_WORD[check.verdict]}
            </Pill>
            <Code className="w-full text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
              {check.value}
            </Code>
            {check.note ? (
              <span className="w-full max-w-[var(--measure)] text-[12px]" style={{ color: "var(--text-subtle)" }}>
                {check.note}
              </span>
            ) : null}
          </div>
        ))}
        {children ? <div className="px-5 pb-5 pt-1">{children}</div> : null}
      </Card>
    </section>
  );
}

/* ── The checks ───────────────────────────────────────────────────────────── */

/* Which section each row belongs to. Kept as lookup objects rather than a
   `section` field on Check so the render above stays a filter. */
const SECURE = {
  "Secure context": 1,
  Origin: 1,
  "Service worker": 1,
  "Display mode": 1,
} as const;

const LAYOUT = {
  "Safe-area insets": 1,
  Viewport: 1,
  "Local storage": 1,
  Browser: 1,
} as const;

function collect(): Check[] {
  const checks: Check[] = [];

  /* — Secure context — the row that explains most iPhone failures — */
  const secure = window.isSecureContext;
  checks.push({
    label: "Secure context",
    value: secure ? "Yes" : "No",
    verdict: secure ? "ok" : "bad",
    note: secure
      ? undefined
      : "The service worker is unavailable on an insecure origin and reports no error — the app simply never installs. Serve it over HTTPS or through a tunnel.",
  });

  checks.push({
    label: "Origin",
    value: window.location.origin,
    verdict: "info",
    note:
      window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "localhost is treated as secure by every browser. A phone reaching this laptop by IP address is not, so this row will read differently there."
        : undefined,
  });

  /* — Service worker — installability and the offline page — */
  if (!("serviceWorker" in navigator)) {
    checks.push({
      label: "Service worker",
      value: "Not supported",
      verdict: "bad",
      note: "No offline page, and the app is not installable.",
    });
  } else {
    const controlled = navigator.serviceWorker.controller != null;
    checks.push({
      label: "Service worker",
      value: controlled ? "Registered and controlling this page" : "Supported, not yet controlling",
      verdict: controlled ? "ok" : secure ? "warn" : "bad",
      note: controlled
        ? undefined
        : secure
          ? "Normal on the very first load — the worker takes control after one reload."
          : "Registration is blocked on an insecure origin. See the secure-context row.",
    });
  }

  /* — Display mode — installed, or a tab pretending to be — */
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  checks.push({
    label: "Display mode",
    value: standalone ? "Standalone (installed)" : "Browser tab",
    verdict: "info",
    note: standalone
      ? "An installed iOS app has its own storage, separate from Safari's — signing in here does not carry over from the browser, and vice versa."
      : undefined,
  });

  /* — Safe-area insets — proof the notch handling is real —
     Read off a probe element rather than from `env()` directly: `env()` is only
     valid inside a property value, so the only way to get a number out of it is
     to apply it to something and ask for the computed result. */
  const insets = readInsets();
  const anyInset = Object.values(insets).some((v) => parseFloat(v) > 0);
  checks.push({
    label: "Safe-area insets",
    value: `top ${insets.top} · right ${insets.right} · bottom ${insets.bottom} · left ${insets.left}`,
    verdict: "info",
    note: anyInset
      ? "Non-zero, so this device reserves screen edges. The scan sheet pads its own header and footer by these amounts; check the close button clears the island in both orientations."
      : "All zero — either a device with no notch, or a browser tab rather than the installed app. A laptop always reads zero, so this row proves nothing until it is read on the phone.",
  });

  checks.push({
    label: "Viewport",
    value: `${window.innerWidth} × ${window.innerHeight} CSS px at ${window.devicePixelRatio}×`,
    verdict: window.innerWidth < 320 ? "warn" : "info",
  });

  /* — Storage — the session lives here — */
  let storage = "Unavailable";
  let storageVerdict: Verdict = "bad";
  try {
    const probe = "__faborch_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    const signedIn = localStorage.getItem("llmatscale_auth_token") != null;
    storage = signedIn ? "Writable, session token present" : "Writable, no session token";
    storageVerdict = "ok";
  } catch {
    storage = "Blocked — private browsing, or storage is disabled";
  }
  checks.push({
    label: "Local storage",
    value: storage,
    verdict: storageVerdict,
    note:
      storageVerdict === "ok"
        ? undefined
        : "The session cannot be held, so every navigation returns to the login screen.",
  });

  checks.push({ label: "Browser", value: navigator.userAgent, verdict: "info" });

  return checks;
}

/**
 * Resolved `env(safe-area-inset-*)` values, in px.
 *
 * `getComputedStyle` cannot be asked for an `env()` directly — it is not a
 * property, only something a property value may contain. So a hidden fixed
 * element takes all four as padding and the computed padding is read back.
 * Fixed rather than static because the insets only resolve against the
 * viewport.
 */
function readInsets(): { top: string; right: string; bottom: string; left: string } {
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.top = "0";
  probe.style.left = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.paddingTop = "env(safe-area-inset-top)";
  probe.style.paddingRight = "env(safe-area-inset-right)";
  probe.style.paddingBottom = "env(safe-area-inset-bottom)";
  probe.style.paddingLeft = "env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe);
  const insets = {
    top: computed.paddingTop,
    right: computed.paddingRight,
    bottom: computed.paddingBottom,
    left: computed.paddingLeft,
  };
  probe.remove();
  return insets;
}
