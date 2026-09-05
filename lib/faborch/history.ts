/**
 * A stored FabOrchestrator conversation, reduced to what this app can show.
 *
 * ── Why anything has to be reduced at all ───────────────────────────────────
 * A thread on the wire is not the thread you read. Measured against production
 * on 5 September, ten sampled conversations carried:
 *
 *     text x274 · step-start x211 · tool-* x332 · file-download x8
 *
 * and the largest single thread was **1,306 KB of JSON for 18 messages**. The
 * text in it was a few thousand characters. Everything else is tool inputs and
 * outputs — the SQL FO generated and the rows it got back — which this app has
 * never rendered and has no way to render.
 *
 * So this runs in the **proxy**, not the browser. Sending a phone 1.3 MB to
 * display 6 KB of it would be the single most expensive thing this app does,
 * over exactly the connection it is built for.
 *
 * ── What is kept, and why the rest goes ─────────────────────────────────────
 *   `text`            kept — the answer, and the only thing on screen
 *   `tool-*`          dropped — the bulk, and unrenderable here
 *   `step-start`      dropped — a streaming marker with nothing to show
 *   `reasoning`       dropped — FO's chat puts it behind a panel this app has
 *                     no equivalent of, and showing it inline would read as
 *                     part of the answer
 *   `file-download`   dropped — presigned S3 URLs that have since expired, and
 *                     an attachment surface this app does not have
 *   anything unknown  dropped — `toUIMessage` passes unrecognised parts through
 *                     verbatim (`lib/storage.ts:610`), so this must reject by
 *                     default rather than accept by default. A part type added
 *                     to FabOrchestrator tomorrow must not reach a screen that
 *                     has never heard of it.
 *
 * Dropping is not hiding: nothing here changes what FabOrchestrator said. The
 * text of every turn arrives whole, in order, and a turn whose text is empty
 * once the tool parts are gone is dropped rather than shown as a blank bubble.
 *
 * ── The one thing this cannot fix ───────────────────────────────────────────
 * `MAX_TEXT` caps a single message at 20,000 characters, because that is what
 * `FabInsightRequestSchema` accepts. A stored FO answer longer than that can be
 * *read* here but cannot be posted back as context, so the thread cannot be
 * continued. That is a real limit, and `capacityIssue` in `conversation.ts`
 * already names it — this module reports the fact and lets the screen say so,
 * rather than silently truncating an answer and making FO look wrong.
 */

import type { Turn } from "./conversation";

/** One stored message, in the shape `toUIMessage` produces. */
export interface FoStoredMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  parts?: unknown;
}

/** A row of FO's conversation list. */
export interface FoConversationSummary {
  id: string;
  title: string;
  isPinned: boolean;
  updatedAt: string;
}

/** A stored thread, as this app will show it. */
export interface FoStoredConversation {
  id: string;
  title: string;
  isPinned: boolean;
  updatedAt: string;
  turns: Turn[];
}

/** Part types that survive the trip to the phone. Everything else is dropped. */
const KEPT = new Set(["text"]);

/**
 * The text of one stored message, with every unrenderable part removed.
 *
 * Falls back to `content` when `parts` is absent or yields nothing: FO stores
 * both, `toUIMessage` synthesises a text part from `content` when `parts` is
 * empty, and a message written by an older build may have only `content`.
 */
function textOf(message: FoStoredMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const { type, text: value } = part as { type?: unknown; text?: unknown };
      if (typeof type !== "string" || !KEPT.has(type)) return "";
      return typeof value === "string" ? value : "";
    })
    .join("");

  if (text.trim()) return text;
  return typeof message.content === "string" ? message.content : "";
}

/**
 * Stored messages → the turns this app renders.
 *
 * Roles other than user and assistant are dropped. FO's `MessageInput` allows
 * `"tool"`, and a tool row has no place in a transcript that shows neither
 * tools nor their output.
 */
export function toTurns(messages: unknown): Turn[] {
  if (!Array.isArray(messages)) return [];

  const turns: Turn[] = [];
  for (const [index, raw] of messages.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as FoStoredMessage;

    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = textOf(message);
    // A turn that was nothing but tool calls has nothing to say once they are
    // gone. An empty bubble in a transcript reads as a failed answer.
    if (!text.trim()) continue;

    turns.push({
      id: typeof message.id === "string" && message.id ? message.id : `stored-${index}`,
      role,
      text,
    });
  }
  return turns;
}

/** FO's list rows → the rows the drawer shows, with anything unusable dropped. */
export function toSummaries(rows: unknown): FoConversationSummary[] {
  if (!Array.isArray(rows)) return [];

  const out: FoConversationSummary[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) continue;

    out.push({
      id: row.id,
      // FO defaults an untitled thread to "New Chat"; it is created with the
      // first fifty characters of the question, so this is rare rather than
      // routine. Shown as FO has it either way — renaming is not this app's.
      title: typeof row.title === "string" && row.title.trim() ? row.title : "Untitled",
      isPinned: row.isPinned === true,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    });
  }
  return out;
}

/**
 * Is every turn short enough to be posted back to FabOrchestrator?
 *
 * Read separately from `capacityIssue` because the two answer different
 * questions at different moments: this one asks whether a thread being *loaded*
 * can be continued at all, before the operator types anything into it.
 */
export function isContinuable(turns: Turn[], maxText: number): boolean {
  return turns.every((turn) => turn.text.length <= maxText);
}
