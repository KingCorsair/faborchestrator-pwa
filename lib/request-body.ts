/**
 * Reading a request body, with a ceiling on its size.
 *
 * ── The defect this closes (2026-09-28) ─────────────────────────────────────
 * Every route that takes a body read it with `req.json()`, which buffers
 * whatever arrives, however large, before a single rule is checked. Zod then
 * refused anything malformed — but only once the whole of it was in memory.
 * `/api/auth/login` did that for anybody on the internet, before any sign-in,
 * on a machine with 512 MB. A handful of requests a few hundred megabytes each
 * would have been enough to take it down, and every signed-in operator with it.
 *
 * So the size is checked before the content, twice: against `Content-Length`
 * before a byte is read, and against the bytes actually arriving — that header
 * is only the caller's claim, and a body sent in chunks carries none. Past the
 * limit, reading stops and the rest is never buffered.
 *
 * ── What it returns ─────────────────────────────────────────────────────────
 * `{ tooLarge: true }`, or the parsed value. A missing or malformed body is
 * `null`, which is exactly what `req.json().catch(() => null)` produced before,
 * so every schema downstream sees the same input it always did.
 *
 * The limits themselves live beside the schemas in `lib/validation.ts`, because
 * each is derived from what its schema accepts.
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
