/**
 * How large a request may be, and how the gateway makes sure (plan RP1 part 3,
 * findings G2 and B5).
 *
 * ── The defect this replaces (verified 23 September, re-measured on 16.3.6) ─
 * Next reads the whole body of every request that passes `proxy.ts` before any
 * route runs, and keeps only `proxyClientMaxBodySize` of it — **10 MB by
 * default**. The gateway's own ceiling was 50 MB, so it could never apply:
 * a declared-length upload over 10 MB became a misleading 502, and a chunked
 * one reached FabOrchestrator cut short, as if complete. In practice the one
 * that bit was chat: FabOrchestrator's client sends the whole conversation on
 * every turn, so a long thread with dashboards in it simply stopped working.
 *
 * ── Two limits, deliberately different ──────────────────────────────────────
 *   policy   `MAX_REQUEST_BODY_BYTES`, 20 MiB: the largest request this app
 *            supports. The gateway refuses anything larger with a coded 413.
 *   ceiling  `REQUEST_BODY_CEILING_BYTES`, 25 MiB: what Next hands the app
 *            (`next.config.ts` sets `proxyClientMaxBodySize` from it).
 *
 * The ceiling must be above the policy, or the gateway cannot *see* that a
 * body is too large: with both at 20 MiB, a 20 MiB + 1 body arrives cut to
 * exactly 20 MiB and passes (measured, plan Appendix B). With the ceiling
 * above, anything over the policy is measured as over it and refused.
 *
 * ── Buffer, measure, then forward ───────────────────────────────────────────
 * Next has already buffered the body by the time the route runs, so streaming
 * it onwards saves no memory and would let a partial body reach
 * FabOrchestrator on an abort. The gateway therefore reads it (at most the
 * ceiling), refuses it past the policy, and otherwise forwards exactly the
 * bytes it holds with `content-length` set from them. **No partial or
 * truncated body can reach FabOrchestrator.**
 *
 * 20 MiB is provisional (RP1: FabOrchestrator's own nginx allows 50 MB; the
 * largest realistic phone request is about 15 MB). Chat attachments are sent
 * inline as base64, so files up to about 14 MB fit.
 */

/** The largest request body this app supports: 20 MiB (RP1 part 3, tier A). */
export const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

/** What Next hands the app: the policy plus headroom (RP1 part 3, tier B). */
export const REQUEST_BODY_CEILING_BYTES = 25 * 1024 * 1024;

/**
 * Read `Content-Length`, if the request declared one.
 *
 * A header that is not a number is treated as absent rather than as zero: the
 * read below measures whatever actually arrives, and guessing here would be
 * the wrong kind of confident.
 */
export function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length")?.trim();
  // `Number("")` is 0, not NaN, so an empty header would otherwise read as a
  // declared length of zero — a malformed request claiming to be an empty one.
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** True when the request said upfront that it is larger than `limit`. */
export function declaredTooLarge(headers: Headers, limit: number = MAX_REQUEST_BODY_BYTES): boolean {
  const length = declaredLength(headers);
  return length !== null && length > limit;
}

export type BufferedBody = { tooLarge: true } | { tooLarge: false; bytes: Uint8Array<ArrayBuffer> };

/**
 * Read a request body whole, stopping as soon as it passes `limit`.
 *
 * Refuses on the declared length before reading anything, then measures what
 * actually arrives: the declared length is only the caller's claim, and a
 * chunked body makes none.
 */
export async function readBodyWithinLimit(
  req: Request,
  limit: number = MAX_REQUEST_BODY_BYTES,
): Promise<BufferedBody> {
  if (declaredTooLarge(req.headers, limit)) return { tooLarge: true };
  if (!req.body) return { tooLarge: false, bytes: new Uint8Array(new ArrayBuffer(0)) };

  // One copy, not two (review of c193e9e, blocking issue 2). A browser always
  // declares the length of a JSON, form or file body, so the buffer is sized
  // from it up front and each chunk is written straight in; the chunk is then
  // garbage the moment it is read. Only a chunked body, which declares
  // nothing, is collected and joined once at the end. Neither path trusts the
  // declared length: what is measured is what arrives.
  const declared = declaredLength(req.headers);
  let single: Uint8Array<ArrayBuffer> | null =
    declared !== null && declared <= limit ? new Uint8Array(new ArrayBuffer(declared)) : null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const start = total;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      if (single && total <= single.byteLength) {
        single.set(value, start);
        continue;
      }
      if (single) {
        // More arrived than was declared: keep what was written and fall back
        // to collecting the rest.
        chunks.push(single.subarray(0, start));
        single = null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (single) return { tooLarge: false, bytes: total === single.byteLength ? single : single.subarray(0, total) };

  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, bytes };
}

/** The coded refusal for a body over the policy (plan RP5: 413 `body_too_large`). */
export function bodyTooLargeBody(limit: number = MAX_REQUEST_BODY_BYTES) {
  return {
    code: "body_too_large",
    error:
      "That is more than this app can send in one go (about 20 MB, attachments included). " +
      "Send smaller files, or start a new conversation.",
    details: { limit },
  } as const;
}
