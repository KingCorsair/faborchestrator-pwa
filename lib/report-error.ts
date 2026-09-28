/**
 * Where this app's unexpected failures go.
 *
 * ── Why this exists (2026-09-28) ────────────────────────────────────────────
 * Until now a failure was a `console.error` line, worded however its file
 * chose, read by nobody unless somebody went looking in Fly's log stream. A
 * FabOrchestrator that stopped answering overnight was found out by the first
 * supervisor to try it in the morning.
 *
 * Every unexpected failure now comes through here, and two things happen:
 *
 *   1. **One line in the server log, always the same shape** — JSON, with a
 *      short incident id, so support can find the exact entry and a log
 *      platform can count them.
 *   2. **An alert, if `ERROR_ALERT_WEBHOOK_URL` is set** — one line POSTed as
 *      `{ "text": … }`, which Slack, Google Chat and Mattermost incoming
 *      webhooks all accept. At most one per kind of failure every five minutes:
 *      an outage is one alert rather than a thousand, and the next one says how
 *      many were held back.
 *
 * ── What never leaves in either ─────────────────────────────────────────────
 * Tokens, passwords, questions and answers. The message is the error's own,
 * cut to 300 characters, and `detail` is the caller's — callers pass paths,
 * counts and codes, nothing a person typed. The alert carries less than the
 * log line (no stack, no detail), because it goes to a third party.
 *
 * Never throws and never waits: reporting a failure must not become a second
 * failure, or hold up the response to the person who hit the first one.
 */

import { randomUUID } from "node:crypto";

type Detail = Record<string, string | number | boolean | null | undefined>;

/** One alert per kind of failure in this window. */
const ALERT_EVERY_MS = 5 * 60_000;

/** A webhook slower than this is abandoned; the log line has already been written. */
const ALERT_TIMEOUT_MS = 3_000;

const MESSAGE_MAX = 300;

/** Kinds are fixed strings in this codebase, so this stays small; the cap is a backstop. */
const MAX_KINDS = 200;

const alerted = new Map<string, { at: number; held: number }>();

/**
 * Record an unexpected failure. Returns its incident id.
 *
 * `where` names the kind of failure — a route, or a class of problem like
 * `faborch/timeout` — and is what alerts are throttled by. `options.alert`
 * replaces the error's message in the alert, for failures whose message came
 * from somewhere this app does not trust (a browser's crash report).
 */
export function reportError(
  where: string,
  error: unknown,
  detail: Detail = {},
  options: { alert?: string } = {},
): string {
  const incident = `inc-${randomUUID().slice(0, 8)}`;
  try {
    const { name, message, stack } = describe(error);
    console.error(
      JSON.stringify({
        level: "error",
        at: new Date().toISOString(),
        where,
        incident,
        name,
        message,
        detail,
        stack,
      }),
    );
    raiseAlert(where, incident, options.alert ?? message);
  } catch {
    /* The one failure this module will not report. */
  }
  return incident;
}

/** Test seam. Nothing in the app calls this. */
export function resetErrorAlerts(): void {
  alerted.clear();
}

function describe(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      // With its cause, when it has one: "Could not reach FabOrchestrator" is
      // the sentence, and "connect ECONNREFUSED" is the reason — a person
      // reading the log wants both.
      message: clip(error.message + causeOf(error)),
      // The top of the stack is where the failure is; the rest is framework.
      stack: error.stack?.split("\n").slice(0, 8).join("\n"),
    };
  }
  if (typeof error === "string") return { name: "Error", message: clip(error) };
  let text: string;
  try {
    text = JSON.stringify(error) ?? String(error);
  } catch {
    text = String(error);
  }
  return { name: "NonError", message: clip(text) };
}

/** " — <reason>", from the innermost cause that says something, or nothing. */
function causeOf(error: Error): string {
  let cause: unknown = error.cause;
  let reason = "";
  // `fetch failed` wraps the reason one level down (`cause.cause`), so the
  // chain is walked rather than read once — a few links at most.
  // An abort is the mechanism of a timeout, not its reason; the sentence
  // already says how long was waited.
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    const says = cause.message && cause.message !== "fetch failed";
    if (says && cause.name !== "AbortError" && cause.name !== "TimeoutError") reason = cause.message;
    cause = cause.cause;
  }
  return reason ? ` — ${reason}` : "";
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_MAX ? `${flat.slice(0, MESSAGE_MAX - 1)}…` : flat;
}

function raiseAlert(where: string, incident: string, message: string): void {
  const raw = process.env.ERROR_ALERT_WEBHOOK_URL?.trim();
  if (!raw) return;

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return;
  }
  // A webhook URL is its own credential — whoever holds it can post to the
  // channel — so it is never sent over plain http.
  if (target.protocol !== "https:") return;

  const now = Date.now();
  const last = alerted.get(where);
  if (last && now - last.at < ALERT_EVERY_MS) {
    last.held += 1;
    return;
  }
  const held = last?.held ?? 0;
  if (!last && alerted.size >= MAX_KINDS) {
    const oldest = alerted.keys().next();
    if (!oldest.done) alerted.delete(oldest.value);
  }
  alerted.set(where, { at: now, held: 0 });

  const app = process.env.FLY_APP_NAME ? ` (${process.env.FLY_APP_NAME})` : "";
  const text = escapeForChat(
    `FabOrchestrator PWA${app} · ${where}: ${message} · incident ${incident}` +
      (held > 0 ? ` · ${held} more held back since the last alert` : ""),
  );

  void fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    cache: "no-store",
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
  }).catch(() => {
    /* The log line is written; an alert that cannot be sent is not a new incident. */
  });
}

/**
 * Chat webhooks read `<…>` as a link or a mention (`<!channel>`), and `&` as
 * the start of an escape. Text is escaped so a message can only ever be text.
 */
function escapeForChat(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
