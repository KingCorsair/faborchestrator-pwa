/**
 * Reading a request body, with a ceiling on its size.
 *
 * Ported from the `chetan` branch (`e843b9c`, 2026-09-28). Routes read their
 * bodies with `req.json()`, which parses whatever arrives, however large,
 * before a single rule is checked; on `/api/pwa/auth/login` that is anybody on
 * the internet, before sign-in.
 *
 * So the size is checked before the content, twice: against `Content-Length`
 * before a byte is read, and against the bytes actually arriving, because that
 * header is only the caller's claim and a chunked body carries none. Past the
 * limit, reading stops. These are the "declared" and "measured" stages of the
 * plan's body policy (RP1 part 3).
 *
 * ── What this does not do ───────────────────────────────────────────────────
 * The original said an oversized body is refused "without being buffered".
 * **On Next 16.1.4 that is not true**: Next reads the whole upload (up to
 * `proxyClientMaxBodySize`) while `proxy.ts` runs, before this route is ever
 * called (plan WHOLE-R1, `next-server.js:1226-1243`). What this bounds is the
 * route's own copy and what it parses. The pre-buffer refusal is the plan's
 * thin Node entry in front of Next (RP10-B part 1), not built yet.
 *
 * `{ tooLarge: true }`, or the parsed value. A missing or malformed body is
 * `null`, exactly what `req.json().catch(() => null)` produced, so every schema
 * downstream sees the same input it always did.
 */

export type BodyRead = { tooLarge: true } | { tooLarge: false; value: unknown };

export async function readJsonBody(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  if (!req.body) return { tooLarge: false, value: null };

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // A body that broke off part-way is a malformed one: the same null that
    // `req.json()` gave, and the schema refuses it the same way.
    return { tooLarge: false, value: null };
  } finally {
    reader.releaseLock();
  }

  try {
    return { tooLarge: false, value: JSON.parse(text) };
  } catch {
    return { tooLarge: false, value: null };
  }
}
