/**
 * Display formatting shared by every place a MES value reaches a screen.
 *
 * ── Why this file exists (design review F-01, 2026-08-12) ───────────────────
 * The same instant printed three different ways on the order detail screen:
 *
 *   AI prose        "the feeder jam occurred at 09:12"
 *   its citation    2026-08-10T09:12:00.000Z
 *   the record row  10 Aug, 09:12
 *
 * Record rows ran through a local `formatTime`; citation values were rendered
 * raw, straight out of the MES payload. Six raw ISO strings appeared on the
 * screen at once.
 *
 * That is the worst kind of defect this product can have. Its central promise
 * is that a supervisor can check the AI against the record printed beneath it —
 * and those two numbers disagreed on sight. A reader cannot reconcile
 * "2026-08-10T09:12:00.000Z" with "10 Aug, 09:12" at a glance, and the one who
 * tries is doing it in a noisy factory through safety glasses.
 *
 * It also put the only monospace-*looking* text on a screen whose type system
 * has no monospace face.
 *
 * ── What this does NOT touch ────────────────────────────────────────────────
 * **Formatting is display-only.** Grounding validation still compares the
 * model's cited value against the raw string in `citableRecords`, byte for
 * byte. Nothing here changes what is sent to the model, what is stored, or what
 * is checked — only what is drawn. Formatting before validating would mean the
 * badge attested to a string nobody ever compared.
 */

/** `2026-08-10T09:12:00.000Z` and friends. Anchored, so it matches whole values only. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * One instant, one string, everywhere on screen.
 *
 * Deliberately not seconds-precise: a supervisor reads to the minute, and the
 * seconds were noise in every column they appeared in.
 */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a `{record_id, field, value}` citation's value for display.
 *
 * Timestamps become the same string the MES record row shows. Everything else
 * — quantities, reason codes, machine ids — passes through untouched, because
 * a citation's job is to be checkable against the record, and altering a value
 * that is not a date would break exactly the comparison this is meant to fix.
 */
export function formatFieldValue(value: string): string {
  const trimmed = value.trim();
  return ISO_8601.test(trimmed) ? formatInstant(trimmed) : value;
}

/**
 * The site's timezone, named once on the screen.
 *
 * Every time on screen is local to whoever is reading it. On a demo laptop that
 * is the laptop's zone, not the plant's — so the screen has to say which zone
 * it is showing rather than leave a supervisor to assume it is theirs.
 */
export function timezoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local time";
  } catch {
    return "local time";
  }
}
