/**
 * Reading FabOrchestrator's answer to the end, whether or not the phone is
 * still there to see it.
 *
 * ── Why (2026-09-29) ─────────────────────────────────────────────────────────
 * A phone that is locked, or an app that is minimised, loses its connection
 * part-way through an answer; iOS suspends the page and closes its sockets
 * within seconds. The chat route used to pass the phone's disconnect straight
 * on to FabOrchestrator, and that lost the answer for good, not just the
 * screen's copy of it:
 *
 *  - FO keeps generating after its client goes (`result.consumeStream()`,
 *    "Issue 18" in `claudeai_athena/app/api/chat/route.ts`).
 *  - But it writes the answer down in `createUIMessageStream`'s `onFinish`,
 *    which runs only when its response stream is read to the end or cancelled —
 *    and FO's `withKeepAlive` wrapper swallows the cancel. So once nobody reads,
 *    nothing is ever saved. Read against `ai@6.0.97`, the version FO pins.
 *
 * So for a turn FO is writing into a conversation, this route now reads FO's
 * stream to the end regardless: the phone gets one copy, and the other is
 * drained here. FO finishes, saves the whole answer, and the screen fetches it
 * from there when the phone comes back (`lib/faborch/recover.ts`).
 *
 * It costs FabOrchestrator nothing it was not already spending — it generates
 * the answer either way. What it costs this app is the function staying up
 * until FO finishes, as it would have if the phone had never left. A turn FO
 * is *not* saving gains nothing from being read, so it is not.
 */

/**
 * The longest this route keeps reading once nobody may be watching.
 *
 * FO's own budget for a turn is 300 seconds (`maxDuration` in its route), so a
 * stream still open after six minutes is not an answer on its way. A host with
 * a shorter limit (Vercel's is the route's `maxDuration`) ends it sooner.
 */
export const KEEP_READING_LIMIT_MS = 6 * 60_000;

/**
 * Two copies of FabOrchestrator's stream: `forPhone` to return, and a promise
 * that settles once the other copy has been read to the end.
 *
 * `tee()` rather than a hand-written pump: when the phone's copy is cancelled —
 * which is what a phone disconnecting does to a response body — the source
 * keeps flowing into the other copy. It is read as fast as FO sends it, so the
 * phone's copy lags only if the phone itself is slower, as it would anyway.
 *
 * `finished` never rejects. A failure here is FO's connection failing, and the
 * phone's copy reports that to the screen if the screen is still there.
 */
export function keepReading(
  body: ReadableStream<Uint8Array>,
  limitMs = KEEP_READING_LIMIT_MS,
): { forPhone: ReadableStream<Uint8Array>; finished: Promise<void> } {
  const [forPhone, forFo] = body.tee();
  return { forPhone, finished: drain(forFo, limitMs) };
}

async function drain(stream: ReadableStream<Uint8Array>, limitMs: number): Promise<void> {
  const reader = stream.getReader();
  const limit = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, limitMs);

  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } catch {
    /* FabOrchestrator's connection failed. See above: nothing to add here. */
  } finally {
    clearTimeout(limit);
  }
}
