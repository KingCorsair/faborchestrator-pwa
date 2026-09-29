/**
 * Fetching back an answer the phone lost part-way through.
 *
 * ── The problem (2026-09-29) ─────────────────────────────────────────────────
 * Minimise the app, or lock the phone, while an answer is arriving, and the
 * connection goes: iOS suspends the page and closes its sockets within seconds.
 * Coming back showed half an answer under "This answer stopped part-way and is
 * incomplete" — with no way to get the rest short of asking again and waiting
 * the whole turn out a second time.
 *
 * The rest is not lost. For a conversation FabOrchestrator is saving, the chat
 * route now reads FO's answer to the end even after the phone has gone
 * (`lib/faborch/keep-reading.ts`), and FO writes the whole of it into the
 * conversation. So when the connection drops, the screen asks FO for the saved
 * thread until the answer is in it, and shows that.
 *
 * ── What "in it" means ───────────────────────────────────────────────────────
 * FO saves the question when the turn starts and the answer when it ends. So
 * the saved thread passes through three states, and each needs a different
 * response:
 *
 *   answered  the question, then an answer after it   → show the answer
 *   working   the question, nothing after it yet      → FO is still going; wait
 *   missing   not even the question                   → FO never got it; stop soon
 *
 * Kept free of React and of `fetch` so every rule here is testable as data.
 */

import type { Turn } from "./conversation";
import { withFile, type FoFile } from "./files";

export type StoredAnswer =
  | { kind: "answered"; text: string; files: FoFile[] }
  | { kind: "working" }
  | { kind: "missing" };

/** An answer fetched back: its text, and any file FO made with it. */
export interface RecoveredAnswer {
  text: string;
  files: FoFile[];
}

/**
 * Where FabOrchestrator's saved copy of the thread stands on the question just
 * asked.
 *
 * `questionsAsked` is how many questions the screen's own thread holds, this
 * one included. A saved copy with fewer has not recorded this one yet, even if
 * its last question happens to read the same — the operator may have asked the
 * same thing twice, and the answer to the first time is not the answer to this.
 */
export function storedAnswer(stored: Turn[], prompt: string, questionsAsked: number): StoredAnswer {
  let lastQuestion = -1;
  for (let i = stored.length - 1; i >= 0; i--) {
    if (stored[i]!.role === "user") {
      lastQuestion = i;
      break;
    }
  }

  const questions = stored.filter((turn) => turn.role === "user").length;
  if (
    lastQuestion < 0 ||
    questions < questionsAsked ||
    stored[lastQuestion]!.text.trim() !== prompt.trim()
  ) {
    return { kind: "missing" };
  }

  const replies = stored.slice(lastQuestion + 1).filter((turn) => turn.role === "assistant");
  const text = replies
    .filter((turn) => turn.text.trim())
    .map((turn) => turn.text)
    .join("\n\n");
  let files: FoFile[] = [];
  for (const file of replies.flatMap((turn) => turn.files ?? [])) files = withFile(files, file);
  return text || files.length ? { kind: "answered", text, files } : { kind: "working" };
}

/** How often to look while FabOrchestrator is still answering. */
export const RECOVER_POLL_MS = 3_000;

/**
 * How long after the question FO could still be writing the answer: its own
 * 300-second budget for a turn, plus a minute of slack.
 */
export const RECOVER_WITHIN_MS = 6 * 60_000;

/**
 * How long to look for the *question* before deciding FO never received it.
 * FO saves it before it starts answering, so this only covers the moment
 * between the request arriving and that write.
 */
export const RECOVER_MISSING_GRACE_MS = 12_000;

export interface RecoverOptions {
  conversationId: string;
  prompt: string;
  /** Questions in the screen's thread once this one was asked, this one included. */
  questionsAsked: number;
  /** When the question was sent, as `Date.now()`. */
  askedAt: number;
  /** Stop pressed, or the screen closed. */
  signal: AbortSignal;
  /**
   * FO's saved copy of the thread: its turns; `"gone"` when it can never be had
   * (signed out, or the thread deleted); `null` to try again.
   */
  load: (conversationId: string, signal: AbortSignal) => Promise<Turn[] | "gone" | null>;
  /** Resolves once the page is on screen again. Injected by the tests. */
  whenVisible?: (signal: AbortSignal) => Promise<void>;
  /** Injected by the tests. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected by the tests. */
  now?: () => number;
}

/**
 * The saved answer to the question just asked, or null once there is no point
 * waiting any longer.
 *
 * Looks only while the page is on screen: a phone that is still in somebody's
 * pocket cannot show an answer, and a suspended page cannot run a timer anyway.
 * Always looks at least once, however late the phone comes back — an answer
 * finished long ago is the easiest one to fetch.
 */
export async function recoverAnswer(options: RecoverOptions): Promise<RecoveredAnswer | null> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? pause;
  const whenVisible = options.whenVisible ?? onScreen;
  const { signal } = options;

  const started = now();
  const giveUpAt = Math.max(options.askedAt + RECOVER_WITHIN_MS, started);

  for (;;) {
    await whenVisible(signal);
    if (signal.aborted) return null;

    const stored = await options.load(options.conversationId, signal).catch(() => null);
    if (signal.aborted || stored === "gone") return null;

    if (stored) {
      const found = storedAnswer(stored, options.prompt, options.questionsAsked);
      if (found.kind === "answered") return { text: found.text, files: found.files };
      if (found.kind === "missing" && now() - started >= RECOVER_MISSING_GRACE_MS) return null;
    }

    if (now() >= giveUpAt) return null;
    await wait(RECOVER_POLL_MS, signal);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function onScreen(signal: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const changed = () => {
      if (document.visibilityState === "visible") done();
    };
    const done = () => {
      document.removeEventListener("visibilitychange", changed);
      signal.removeEventListener("abort", done);
      resolve();
    };
    document.addEventListener("visibilitychange", changed);
    signal.addEventListener("abort", done, { once: true });
  });
}
