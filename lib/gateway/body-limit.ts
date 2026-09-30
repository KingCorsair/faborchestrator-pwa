/**
 * A ceiling on what the gateway will carry upstream (WP5).
 *
 * ── Why the gateway needs one at all ────────────────────────────────────────
 * The embedded Master Data Load agent posts workbooks to
 * `/api/modeling-agent/chat/parse-upload`, and FabOrchestrator's own nginx
 * stops at `client_max_body_size 50m`. Without a ceiling here, a larger upload
 * streams all the way across the network before FabOrchestrator's proxy cuts
 * it off — the operator waits through the whole transfer to be told no, and
 * the 413 arrives from nginx rather than from anything that can explain
 * itself. Refusing at the same size, before a byte leaves, is the same answer
 * sooner and in this app's own words.
 *
 * ── Two checks, because one is not enough ───────────────────────────────────
 * `Content-Length` is the cheap check and covers every ordinary upload, but a
 * chunked request has no length to read. So the body is also counted as it
 * streams, and the stream errors the moment it passes the ceiling. Without the
 * second check the first is a suggestion: anything sent chunked would sail
 * past it.
 *
 * Chat bodies do not come through here. Those are buffered whole so their
 * `conversationId` can be proved (`lib/gateway/ownership.ts`), and carry their
 * own, larger ceiling — a long conversation is resent in full on every turn.
 */

/**
 * The largest body forwarded upstream.
 *
 * 50 MB, matching `client_max_body_size` in FabOrchestrator's own
 * `.platform/nginx/conf.d/proxy.conf`. Raising this without raising that would
 * only move where the refusal comes from.
 */
export const MAX_UPSTREAM_BODY_BYTES = 50 * 1024 * 1024;

/** Thrown into the stream when a body outgrows the ceiling mid-flight. */
export class BodyTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Request body exceeded ${MAX_UPSTREAM_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read `Content-Length`, if the request declared one.
 *
 * A header that is not a number is treated as absent rather than as zero: the
 * counting stream will catch whatever actually arrives, and guessing here
 * would be the wrong kind of confident.
 */
export function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length")?.trim();
  // `Number("")` is 0, not NaN, so an empty header would otherwise read as a
  // declared length of zero — a malformed request claiming to be an empty one.
  // Absent is the honest answer; the counting stream measures what arrives.
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** True when the request said upfront that it is too big. */
export function declaredTooLarge(headers: Headers): boolean {
  const length = declaredLength(headers);
  return length !== null && length > MAX_UPSTREAM_BODY_BYTES;
}

/**
 * Pass a body through unchanged while counting it, and error the stream if it
 * outgrows the ceiling.
 *
 * The bytes are forwarded as they arrive — this is not a buffer, and an upload
 * is never held in memory here. What it adds is a running total and the
 * willingness to stop.
 */
export function limitBody(
  body: ReadableStream<Uint8Array>,
  max: number = MAX_UPSTREAM_BODY_BYTES,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(new BodyTooLargeError(seen));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
