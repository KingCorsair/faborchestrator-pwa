/**
 * Where this app's unexpected failures go: one JSON line, always the same
 * shape, carrying a short incident id.
 *
 * ── Where it came from ──────────────────────────────────────────────────────
 * Ported from the `chetan` branch (`e843b9c`, 2026-09-28), where it replaced
 * `console.error` lines that each file worded its own way. Two things were
 * changed on the way in, both to fit the architecture plan's observability
 * package (`docs/architectural_review_issues/PWA_ARCHITECTURAL_REMEDIATION_PLAN.md`,
 * RP10-A part 2):
 *
 *  1. **An error is logged by its name and code, not its words.** The message
 *     and the stack are where credentials, addresses and people's input leak
 *     into a log: an undici error carries the URL it failed to reach, an FO
 *     error body can echo what was sent. So the production line carries
 *     `errorName` and `errorCode` only; `LOG_STACKS=1` (development) adds the
 *     message and the top of the stack.
 *  2. **No alert webhook.** The original could post each kind of failure to a
 *     chat channel. Alerting is not in the plan yet (it belongs with the
 *     logging platform, §9 question 33), so it is left out rather than added
 *     on the side.
 *
 * `detail` is the caller's and should be codes, counts and paths. A `path` is
 * masked here anyway (query dropped, id-like segments replaced by `:id`),
 * because a conversation id in a path is an access-bearing identifier at FO.
 *
 * Never throws: reporting a failure must not become a second failure.
 */

import { randomUUID } from "node:crypto";

type Detail = Record<string, string | number | boolean | null | undefined>;

const DETAIL_STRING_MAX = 200;

/** Record an unexpected failure. Returns its incident id. */
export function reportError(where: string, error: unknown, detail: Detail = {}): string {
  const incident = `inc-${randomUUID().slice(0, 8)}`;
  try {
    const line: Record<string, unknown> = {
      level: "error",
      at: new Date().toISOString(),
      where,
      incident,
      ...describe(error),
      detail: cleanDetail(detail),
    };
    if (process.env.LOG_STACKS === "1") Object.assign(line, verbose(error));
    console.error(JSON.stringify(line));
  } catch {
    /* The one failure this module will not report. */
  }
  return incident;
}

/**
 * The name and code only (RP10-A: `e.cause?.name ?? e.name`, and the first
 * `code` found down the cause chain — undici puts `ECONNREFUSED` two causes
 * down, under a `TypeError: fetch failed`).
 */
function describe(error: unknown): { errorName: string; errorCode?: string } {
  if (!(error instanceof Error)) {
    return { errorName: typeof error === "string" ? "Error" : "NonError" };
  }
  const cause = error.cause instanceof Error ? error.cause : null;
  const errorName = cause?.name ?? error.name;
  let code: unknown;
  let link: unknown = error;
  for (let depth = 0; depth < 5 && link instanceof Error && code === undefined; depth++) {
    // A DOMException's `code` is a legacy number (20 for an abort) that says
    // nothing its name does not.
    if (!(typeof DOMException !== "undefined" && link instanceof DOMException)) {
      code = (link as { code?: unknown }).code;
    }
    link = link.cause;
  }
  return typeof code === "string" || typeof code === "number"
    ? { errorName, errorCode: String(code) }
    : { errorName };
}

/** Development only: the words and the top of the stack. */
function verbose(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: oneLine(error.message),
      stack: error.stack?.split("\n").slice(0, 8).join("\n"),
    };
  }
  let text: string;
  try {
    text = typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
  } catch {
    text = String(error);
  }
  return { message: oneLine(text) };
}

function cleanDetail(detail: Detail): Detail {
  const out: Detail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === "string") {
      const text = key === "path" ? maskPath(value) : value;
      out[key] = text.length > DETAIL_STRING_MAX ? `${text.slice(0, DETAIL_STRING_MAX - 1)}…` : text;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A path as a pattern: the query string dropped (it can carry a question or a
 * token), and every segment that looks like an identifier replaced by `:id`.
 */
export function maskPath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  return bare
    .split("/")
    .map((segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^[A-Za-z0-9_-]{16,}$/.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}
