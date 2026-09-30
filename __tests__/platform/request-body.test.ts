/**
 * Reading a request body with a ceiling on its size (`lib/request-body.ts`),
 * and the sign-in route using it.
 *
 * Ported from the `chetan` branch (`e843b9c`). His cases for the native chat
 * and conversation limits were left behind with those screens; the route cases
 * at the end are new and pin the plan's 16 KiB and `body_too_large` (RP1, RP5).
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";

import { NextRequest } from "next/server";
import { readJsonBody } from "../../lib/request-body";
import { LOGIN_BODY_LIMIT, LoginSchema } from "../../lib/validation";
import { POST as LOGIN } from "../../app/api/pwa/auth/login/route";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://pwa.test/api/x", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);

/** A body that arrives in `size`-byte chunks, counting how many were pulled. */
function chunked(size: number, chunks: number) {
  const state = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled += 1;
        if (state.pulled > chunks) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(size).fill(0x20)); // spaces: valid JSON padding
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe("a body under the limit reads exactly as req.json() did", () => {
  test("JSON parses", async () => {
    const read = await readJsonBody(post(JSON.stringify({ a: 1, b: ["x"] })), 1024);
    assert.deepEqual(read, { tooLarge: false, value: { a: 1, b: ["x"] } });
  });

  test("a malformed body is null, which every schema already refuses", async () => {
    assert.deepEqual(await readJsonBody(post("{not json"), 1024), { tooLarge: false, value: null });
  });

  test("no body at all is null", async () => {
    assert.deepEqual(await readJsonBody(post(null), 1024), { tooLarge: false, value: null });
  });

  test("a body of exactly the limit is accepted", async () => {
    const body = JSON.stringify({ pad: "x".repeat(100) });
    const read = await readJsonBody(post(body), Buffer.byteLength(body));
    assert.equal(read.tooLarge, false);
  });

  test("a character split across two chunks still decodes", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "Renée" }));
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    assert.deepEqual(await readJsonBody(post(stream), 1024), {
      tooLarge: false,
      value: { name: "Renée" },
    });
  });
});

describe("a body over the limit is refused, and reading stops", () => {
  test("a declared length over the limit is refused before a byte is read", async () => {
    const { stream, state } = chunked(1024, 100);
    const read = await readJsonBody(post(stream, { "content-length": String(100 * 1024) }), 4096);
    assert.deepEqual(read, { tooLarge: true });
    assert.equal(state.pulled, 0, "nothing should have been read");
  });

  test("a body with no declared length is counted as it arrives, and reading stops", async () => {
    const { stream, state } = chunked(1024, 10_000);
    const read = await readJsonBody(post(stream), 8 * 1024);
    assert.deepEqual(read, { tooLarge: true });
    assert.ok(state.pulled <= 10, `read ${state.pulled} KB of a 10 MB body to refuse it at 8 KB`);
  });

  test("a body that understates its length is still caught", async () => {
    const { stream } = chunked(1024, 64);
    const read = await readJsonBody(post(stream, { "content-length": "10" }), 8 * 1024);
    assert.deepEqual(read, { tooLarge: true });
  });

  test("the limit counts bytes, not characters", async () => {
    const body = JSON.stringify("éééé"); // 2 quotes + 4 × 2 bytes = 10 bytes
    assert.equal((await readJsonBody(post(body), 9)).tooLarge, true);
    assert.equal((await readJsonBody(post(body), 10)).tooLarge, false);
  });
});

describe("POST /api/pwa/auth/login", () => {
  const realFetch = globalThis.fetch;
  let foCalls = 0;
  let n = 0;

  beforeEach(() => {
    foCalls = 0;
    process.env.FABORCH_BASE_URL = "https://fo.test";
    globalThis.fetch = (async () => {
      foCalls += 1;
      return new Response("", { status: 401 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const signIn = (body: BodyInit, headers: Record<string, string> = {}) => {
    n += 1;
    return LOGIN(
      new NextRequest("https://pwa.test/api/pwa/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "fly-client-ip": `10.9.0.${n}`, ...headers },
        body,
        duplex: "half",
      } as ConstructorParameters<typeof NextRequest>[1]),
    );
  };

  test("the longest legal credentials fit well under the limit", () => {
    const worst = "\u0001"; // six bytes once JSON-escaped
    const body = JSON.stringify({ email: worst.repeat(255), password: worst.repeat(128) });
    assert.ok(LoginSchema.safeParse(JSON.parse(body)).success);
    assert.ok(Buffer.byteLength(body) <= LOGIN_BODY_LIMIT);
    assert.equal(LOGIN_BODY_LIMIT, 16 * 1024, "the plan's value for /api/pwa/auth/*");
  });

  test("a declared body over 16 KiB is a coded 413, and FabOrchestrator is never asked", async () => {
    const big = JSON.stringify({ email: "a@b.example", password: "x".repeat(20 * 1024) });
    const res = await signIn(big, { "content-length": String(Buffer.byteLength(big)) });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { code: string; details: { limit: number } };
    assert.equal(body.code, "body_too_large");
    assert.equal(body.details.limit, LOGIN_BODY_LIMIT);
    assert.equal(foCalls, 0);
  });

  test("a chunked 1 MiB body is refused the same way", async () => {
    const { stream } = chunked(1024, 1024);
    const res = await signIn(stream);
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { code: string }).code, "body_too_large");
    assert.equal(foCalls, 0);
  });

  test("an ordinary sign-in still reaches FabOrchestrator", async () => {
    const res = await signIn(JSON.stringify({ email: "a@b.example", password: "pw" }));
    assert.equal(res.status, 401);
    assert.equal(foCalls, 1);
  });
});
