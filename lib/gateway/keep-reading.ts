/**
 * Keep reading a chat answer after the phone has gone — **a stopgap until
 * FabOrchestrator saves answers itself** (decided by Chetan, 30 September 2026).
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Minimise the installed app mid-answer, come back, and the answer is gone —
 * not only from the screen but from the conversation. Verified on the deployed
 * hardening branch on 30 September: two minutes after the connection was cut,
 * the thread held the question and no answer.
 *
 * FabOrchestrator keeps generating when the client disconnects, but it
 * **saves the answer only when its response stream is read to the end**
 * ([FO-clone] `app/api/chat/route.ts`: `withKeepAlive` swallows the client's
 * cancel, so the UI-message stream's `onFinish`, which writes the answer, never
 * runs). The same happens on FabOrchestrator's own website. The right fix is
 * in FabOrchestrator (§9 question 47); until it lands, the gateway reads the
 * answer to the end on the phone's behalf.
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 * The answer is split in two (`tee`): one branch goes to the phone exactly as
 * before, the other is read here and discarded. While the phone is connected
 * the two advance together; when it leaves, Next cancels only the phone's
 * branch and this one carries on, so FabOrchestrator's stream reaches its end
 * and the answer is saved. Reopening the conversation shows it.
 *
 * The gateway's deadlines still hold: the body read here is the one
 * `lib/gateway/deadline.ts` watches, so a FabOrchestrator that goes silent or
 * runs past the lifetime is cut exactly as before, and nothing outlives
 * `GATEWAY_TIMEOUT_STREAM_LIFE_MS`. At most `KEEP_READING_MAX_STREAMS` answers
 * (default 50) are read this way at once; beyond that a chat falls back to the
 * old behaviour, where the phone leaving ends the call.
 *
 * ── Stop, and the next question (independent review, 30 September) ─────────
 * The gateway cannot tell FabOrchestrator's Stop button from the phone being
 * minimised: both close the connection. So an answer the operator stopped is
 * also read to the end and saved whole, where FabOrchestrator's own site saves
 * nothing. What must not happen is that answer landing in the conversation
 * *after* the operator's next question: FabOrchestrator writes it when it
 * finishes. So **a new turn in the same conversation stops the read of the
 * previous answer** (`supersedeKeptReading`): that answer is then not saved,
 * exactly as on FabOrchestrator's own site, and the thread stays in order.
 *
 * This departs from the plan's RP4 rule that the phone's disconnect aborts the
 * upstream call. It is recorded in `docs/STATUS.md`; **delete this file and its
 * call sites once FabOrchestrator saves an answer on disconnect.**
 */

import { foFingerprint } from "@/lib/auth";
import { afterResponse } from "@/lib/faborch/end-session";
import { idPrefix, logEvent } from "@/lib/report-error";

const DEFAULT_MAX_STREAMS = 50;

/** How many answers may be kept reading at once. */
export function keepReadingMaxStreams(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.KEEP_READING_MAX_STREAMS);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_STREAMS;
}

let active = 0;

/** Testing seam: how many answers are being kept reading right now. */
export function keptReadingCount(): number {
  return active;
}

/** The answer being read for a conversation, by `fingerprint:conversationId`. */
const byConversation = new Map<string, () => void>();

/** The key for one conversation of one session. Never the token itself. */
export function keepReadingKey(foToken: string, conversationId: string): string {
  return `${foFingerprint(foToken)}:${conversationId}`;
}

/**
 * A new turn has started in this conversation: stop reading the previous
 * answer on the phone's behalf, so it cannot be saved after the new question.
 * A phone still reading it keeps its own half.
 */
export function supersedeKeptReading(key: string): void {
  const stop = byConversation.get(key);
  if (!stop) return;
  byConversation.delete(key);
  stop();
}

export interface KeepReadingSlot {
  /**
   * Split `body`: return the phone's branch and read the other to the end
   * here. Releases the slot when that read ends. Call at most once. `key` names
   * the conversation, so a later turn in it can supersede this read.
   */
  keepReading<T extends Uint8Array>(
    body: ReadableStream<T>,
    context: { pathname: string; phone: AbortSignal; key?: string | null },
  ): ReadableStream<T>;
  /** Give the slot back without using it (FabOrchestrator answered with no stream). */
  release(): void;
}

/**
 * Reserve a slot before the call to FabOrchestrator is made, so the call can
 * be started without the phone's abort signal. Null when every slot is taken:
 * the caller then keeps the phone's signal, the old behaviour.
 */
export function reserveKeepReading(): KeepReadingSlot | null {
  if (active >= keepReadingMaxStreams()) return null;
  active += 1;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active -= 1;
  };

  return {
    release,
    keepReading(body, { pathname, phone, key }) {
      const [forPhone, forFabOrchestrator] = body.tee();
      const reader = forFabOrchestrator.getReader();
      const startedAt = Date.now();
      let superseded = false;
      const stop = () => {
        superseded = true;
        reader.cancel().catch(() => {});
      };
      if (key) byConversation.set(key, stop);

      const finished = readToEnd(reader).then((outcome) => {
        if (key && byConversation.get(key) === stop) byConversation.delete(key);
        release();
        // Only worth a line when it did something: the phone had gone, or a
        // new turn stopped it.
        if (phone.aborted || superseded) {
          logEvent("info", "answer_kept_reading", {
            path: pathname,
            outcome: superseded ? "superseded" : outcome,
            elapsedMs: Date.now() - startedAt,
            ...(key ? { idPrefix: idPrefix(key.slice(key.indexOf(":") + 1)) } : {}),
          });
        }
      });
      // Keeps the request's work alive until the answer has been read, where
      // the host would otherwise stop it (Next's `after()`).
      afterResponse(() => finished);
      return forPhone;
    },
  };
}

async function readToEnd(reader: ReadableStreamDefaultReader<unknown>): Promise<"completed" | "errored"> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return "completed";
    }
  } catch {
    // A deadline, or FabOrchestrator failing: the phone's branch has already
    // been errored the same way. Nothing more to do here.
    return "errored";
  } finally {
    reader.releaseLock();
  }
}
