/**
 * A crash in the browser, turned into a report the server can record.
 *
 * Used by the crash screens (`components/fab/crash-screen.tsx`), and kept apart
 * from them so the rules are testable without rendering React: what is sent,
 * what is cut, and what is never sent at all.
 *
 * ── Never the query string ──────────────────────────────────────────────────
 * `/fabinsight?q=…` carries the question somebody typed. The report takes the
 * path alone, so a crash on that screen reports *where* it happened and not
 * what was being asked.
 *
 * Client-safe: no imports.
 */

export interface ClientErrorReport {
  /** Shown on the crash screen and written in the log, so the two can be matched. */
  reference: string;
  message: string;
  /** Next's digest, present when the failure happened while rendering on the server. */
  digest?: string;
  path: string;
}

const MESSAGE_MAX = 500;

/** A short reference an operator can read out: `ref-` and ten characters. */
export function newReference(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const text = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
  return `ref-${text.slice(0, 10)}`;
}

export function clientErrorReport(
  error: { message?: unknown; digest?: unknown },
  pathname: string,
  reference: string,
): ClientErrorReport {
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim().slice(0, MESSAGE_MAX)
      : "The screen failed to render.";
  const digest =
    typeof error.digest === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.digest)
      ? error.digest
      : undefined;

  // The path only, and only characters a path is made of; anything else is
  // replaced rather than trusted.
  const bare = (pathname.split(/[?#]/)[0] ?? "/").slice(0, 200);
  const path = /^\/[A-Za-z0-9\-._~/%]*$/.test(bare) ? bare : "/";

  return digest ? { reference, message, digest, path } : { reference, message, path };
}

/**
 * Send it, and never fail doing so.
 *
 * `sendBeacon` first, because it survives the page being reloaded or left —
 * which is what the crash screen's own buttons do next. A keepalive `fetch` is
 * the fallback for browsers without it.
 */
export function sendClientErrorReport(report: ClientErrorReport): void {
  try {
    const body = JSON.stringify(report);
    const blob = new Blob([body], { type: "application/json" });
    if (typeof navigator !== "undefined" && navigator.sendBeacon?.("/api/client-error", blob)) return;
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* A crash report that cannot be sent is not a second crash. */
  }
}
