/**
 * Reading a request body with a ceiling on its size.
 *
 * Until 2026-09-28 every route read its body with `req.json()`, which buffers
 * whatever arrives before a single rule is checked — on the sign-in route, for
 * anybody on the internet. These pin the replacement: the size is checked
 * before the content, a body that lies about its size is still caught, reading
 * stops at the limit, and everything under it parses exactly as before.
 *
 * The last block pins the limits themselves against what the app's own screens
 * can send, so a limit can never quietly start refusing a real conversation.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readJsonBody } from "../../lib/request-body";
import {
  CHAT_BODY_LIMIT,
  CREATE_CONVERSATION_BODY_LIMIT,
  CreateConversationSchema,
  FabInsightRequestSchema,
  LOGIN_BODY_LIMIT,
  LoginSchema,
} from "../../lib/validation";
import {
  MAX_QUESTION,
  capacityIssue,
  requestBytes,
  toFoMessages,
  type Turn,
} from "../../lib/faborch/conversation";

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
    // Pull only when read, so `pulled` counts exactly what the reader asked for.
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
    // "é" is two bytes. A slow connection can deliver them in different chunks,
    // and decoding each chunk alone would turn the character into garbage.
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

describe("a body over the limit is refused, and never held", () => {
  test("a declared length over the limit is refused before a byte is read", async () => {
    const { stream, state } = chunked(1024, 100);
    const read = await readJsonBody(post(stream, { "content-length": String(100 * 1024) }), 4096);
    assert.deepEqual(read, { tooLarge: true });
    assert.equal(state.pulled, 0, "nothing should have been read");
  });

  test("a body with no declared length is counted as it arrives, and reading stops", async () => {
    // Chunked uploads carry no Content-Length, so the header alone is no guard.
    const { stream, state } = chunked(1024, 10_000);
    const read = await readJsonBody(post(stream), 8 * 1024);
    assert.deepEqual(read, { tooLarge: true });
    assert.ok(state.pulled <= 10, `read ${state.pulled} KB of a 10 MB body to refuse it at 8 KB`);
  });

  test("a body that understates its length is still caught", async () => {
    // The header is the caller's claim, not a fact.
    const { stream } = chunked(1024, 64);
    const read = await readJsonBody(post(stream, { "content-length": "10" }), 8 * 1024);
    assert.deepEqual(read, { tooLarge: true });
  });

  test("the limit counts bytes, not characters", async () => {
    // Four characters, eight bytes. A character count would let a multi-byte
    // body through at several times the limit.
    const body = JSON.stringify("éééé"); // 2 quotes + 4 × 2 bytes = 10 bytes
    assert.equal((await readJsonBody(post(body), 9)).tooLarge, true);
    assert.equal((await readJsonBody(post(body), 10)).tooLarge, false);
  });
});

describe("the limits sit above everything the app's own screens send", () => {
  /** The worst character to JSON-encode: a control character, written as `\u0001`. */
  const WORST = "\u0001";

  test("the largest conversation the chat screen will post fits under CHAT_BODY_LIMIT", () => {
    // The screen measures its own request (`capacityIssue`), so the largest body
    // it sends is one that measures just under the limit — built here from the
    // most expensive characters to encode, with the same function the screen
    // uses, and posted with a real conversation id.
    const question = "and the last product with WIP?";
    const answer = (chars: number): Turn[] => [
      { id: "u1", role: "user", text: "the dashboard, please" },
      { id: "a1", role: "assistant", text: WORST.repeat(chars) },
    ];
    // Each of these characters costs exactly six bytes once encoded, so this is
    // the most that measures within the limit…
    const chars = Math.floor((CHAT_BODY_LIMIT - requestBytes(answer(0), question)) / 6);
    assert.equal(capacityIssue(answer(chars), question), null, "the screen sends this one");
    // …and one more character is refused by the screen, before it is sent.
    assert.deepEqual(capacityIssue(answer(chars + 1), question), { kind: "thread-too-large" });

    const body = JSON.stringify({
      messages: toFoMessages([...answer(chars), { id: "u2", role: "user", text: question }]),
      conversationId: "7b0f6a52-3c55-4a4e-9a51-5d1f2d6c9e10",
    });
    assert.ok(FabInsightRequestSchema.safeParse(JSON.parse(body)).success, "the schema accepts it");
    const bytes = Buffer.byteLength(body);
    assert.ok(bytes <= CHAT_BODY_LIMIT, `${bytes} bytes exceeds the ${CHAT_BODY_LIMIT}-byte limit`);
  });

  test("and it is still a limit, under what Vercel lets a request carry", () => {
    // Vercel answers 413 itself above 4.5 MB, in words that are not this app's.
    // Pinned so the limit cannot grow past it unnoticed.
    assert.ok(CHAT_BODY_LIMIT < 4_500_000, `CHAT_BODY_LIMIT is ${CHAT_BODY_LIMIT}`);
  });

  test("the longest legal credentials fit under LOGIN_BODY_LIMIT", () => {
    const body = JSON.stringify({ email: WORST.repeat(255), password: WORST.repeat(128) });
    assert.ok(LoginSchema.safeParse(JSON.parse(body)).success);
    assert.ok(Buffer.byteLength(body) <= LOGIN_BODY_LIMIT);
    assert.ok(LOGIN_BODY_LIMIT < 4 * 1024, "a sign-in is a few hundred bytes; the limit stays small");
  });

  test("the longest legal title fits under CREATE_CONVERSATION_BODY_LIMIT", () => {
    const body = JSON.stringify({ title: WORST.repeat(MAX_QUESTION) });
    assert.ok(CreateConversationSchema.safeParse(JSON.parse(body)).success);
    assert.ok(Buffer.byteLength(body) <= CREATE_CONVERSATION_BODY_LIMIT);
  });
});
