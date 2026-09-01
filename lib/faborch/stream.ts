/**
 * Reading FabOrchestrator's reply.
 *
 * `/api/chat` answers with an **AI SDK UI-message stream**: `text/event-stream`,
 * one JSON object per `data:` line, terminated by `data: [DONE]`. This file
 * turns that into the three things this interface shows — text, tool activity,
 * and an error — and ignores the rest.
 *
 * ── Why this is 60 lines instead of `useChat` ───────────────────────────────
 * The product renders this stream with `@ai-sdk/react`'s `useChat`
 * (`claudeai_athena/components/full-chat-app.tsx:962`), and CLAUDE.md's "reuse
 * before adding" rule says to follow the product unless there is a reason. The
 * reason is the same one that put a hand-written `components/fab/` in this app
 * instead of Radix and twenty-six shadcn files: `useChat` brings `ai` +
 * `@ai-sdk/react` for one screen that needs three of the fifteen frame types.
 * The chat app needs the rest — artifacts, file parts, reasoning panels,
 * conversation reload, message editing. This screen shows a conversation.
 *
 * What that costs is stated plainly: this parser knows about frames that exist
 * today. If FO upgrades `ai` and renames `text-delta`, this goes quiet and the
 * product's chat does not. `__tests__/faborch/stream.test.ts` pins the frame
 * shapes against `ai@6.0.97`'s `UIMessageChunk` union (`node_modules/ai/dist/
 * index.d.ts:2127`) so that failure surfaces as a red test, not as a demo where
 * nothing appears.
 *
 * ── The frames that are deliberately dropped ────────────────────────────────
 *  - `start` / `start-step` / `text-start` / `text-end` / `finish*` — envelope.
 *  - `data-keepalive` — FO writes one every 15s so CloudFront's 60s origin
 *    timeout does not cut a long tool call (`app/api/chat/route.ts:768`).
 *  - `reasoning-*` — FO asks for these (`sendReasoning: true`). The product has
 *    a panel for thinking; this screen does not, and half-rendering it would be
 *    worse than not showing it.
 *  - `tool-output-*`, `data-fileDownload`, `source-*` — the answer already
 *    contains what the tools found.
 */

/** Everything this interface can learn from FO's stream. */
export type FoStreamEvent =
  /** A piece of the assistant's answer. Append it. */
  | { type: "text"; delta: string }
  /** FO started calling one of its tools. Shown as an activity line. */
  | { type: "tool"; name: string }
  /** FO failed mid-stream. Its own message, including any `errorId`. */
  | { type: "error"; message: string };

/**
 * An incremental SSE reader.
 *
 * `push` takes whatever arrived — a chunk boundary can land in the middle of a
 * line, and does, on a slow connection — and returns the events that completed.
 * Anything partial is held until the rest turns up.
 */
export function createFoStreamParser(): { push(chunk: string): FoStreamEvent[] } {
  let buffer = "";

  return {
    push(chunk: string): FoStreamEvent[] {
      buffer += chunk;
      const events: FoStreamEvent[] = [];

      // Frames are newline-delimited; the last piece is kept because it may be
      // half a line. A `\n\n` frame separator leaves an empty piece, which the
      // `data:` check below discards.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // A frame we cannot parse is not worth interrupting an answer for.
          continue;
        }

        const event = toEvent(frame);
        if (event) events.push(event);
      }

      return events;
    },
  };
}

function toEvent(frame: Record<string, unknown>): FoStreamEvent | null {
  switch (frame.type) {
    case "text-delta":
      return typeof frame.delta === "string" && frame.delta.length > 0
        ? { type: "text", delta: frame.delta }
        : null;

    case "tool-input-start":
      return typeof frame.toolName === "string"
        ? { type: "tool", name: frame.toolName }
        : null;

    // FO's stream-level failure. `onError` in its route returns the user-facing
    // message plus `errorId=…` for anything unmapped, which is the string a
    // support engineer needs — so it is shown as sent, not replaced.
    case "error":
      return {
        type: "error",
        message:
          typeof frame.errorText === "string" && frame.errorText.trim()
            ? frame.errorText
            : "FabOrchestrator stopped part-way through the answer.",
      };

    default:
      return null;
  }
}

/**
 * Read a whole response body, calling `onEvent` as things arrive.
 *
 * Separate from the parser so the parser stays synchronous and testable without
 * constructing a `ReadableStream`.
 */
export async function readFoStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: FoStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createFoStreamParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
