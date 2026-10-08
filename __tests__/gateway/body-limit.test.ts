/**
 * How large a request may be (`lib/gateway/body-limit.ts`; plan RP1 part 3,
 * findings G2 and B5).
 *
 * Next reads every body that passes `proxy.ts` and keeps only
 * `proxyClientMaxBodySize` of it — 10 MB by default — so the gateway's old
 * 50 MB ceiling could never apply: a long FabOrchestrator chat (the whole
 * thread is resent on every turn) reached FabOrchestrator cut short. Now:
 *
 *   policy   20 MiB, enforced by the gateway with a coded 413
 *   ceiling  25 MiB, what Next hands the app, set in `next.config.ts`
 *
 * and every body is read, measured and forwarded exactly — never streamed on
 * partially, never forwarded with the phone's own `content-length`.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import nextConfig from "@/next.config";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import {
  declaredLength,
  declaredTooLarge,
  MAX_REQUEST_BODY_BYTES,
  readBodyWithinLimit,
  REQUEST_BODY_CEILING_BYTES,
} from "@/lib/gateway/body-limit";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { GET, POST } from "@/app/fo-gateway/[...path]/route";

const MiB = 1024 * 1024;

/** A body delivered in `count` chunks of `size` bytes, with no declared length. */
function chunked(count: number, size: number, onPull?: () => void): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      onPull?.();
      if (sent >= count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

const requestWith = (body: BodyInit | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request("https://pwa.test/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);

describe("the two limits", () => {
  test("the policy is 20 MiB and the ceiling above it, so an oversized body is seen as oversized", () => {
    assert.equal(MAX_REQUEST_BODY_BYTES, 20 * MiB);
    assert.equal(REQUEST_BODY_CEILING_BYTES, 25 * MiB);
    assert.ok(REQUEST_BODY_CEILING_BYTES > MAX_REQUEST_BODY_BYTES);
  });

  test("next.config.ts hands the app the ceiling, not Next's 10 MB default", () => {
    assert.equal(nextConfig.experimental?.proxyClientMaxBodySize, REQUEST_BODY_CEILING_BYTES);
  });
});

describe("the declared length", () => {
  test("over the limit is refused, at the limit is not", () => {
    assert.equal(declaredTooLarge(new Headers({ "content-length": String(MAX_REQUEST_BODY_BYTES + 1) })), true);
    assert.equal(declaredTooLarge(new Headers({ "content-length": String(MAX_REQUEST_BODY_BYTES) })), false);
    assert.equal(declaredTooLarge(new Headers({ "content-length": "10" }), 5), true);
  });

  test("a chunked request declares nothing, and a nonsense length is treated as absent", () => {
    assert.equal(declaredLength(new Headers()), null);
    for (const v of ["not-a-number", "-1", ""]) {
      assert.equal(declaredLength(new Headers({ "content-length": v })), null, v);
    }
  });
});

describe("reading a body within the limit", () => {
  test("a body under the limit arrives byte for byte", async () => {
    const read = await readBodyWithinLimit(requestWith(chunked(4, 1024)), 8 * 1024);
    assert.equal(read.tooLarge, false);
    assert.equal(read.tooLarge === false && read.bytes.byteLength, 4 * 1024);
  });

  test("a body exactly at the limit still passes", async () => {
    const read = await readBodyWithinLimit(requestWith(chunked(4, 1024)), 4 * 1024);
    assert.equal(read.tooLarge, false);
  });

  test("a chunked body that outgrows the limit is refused, and reading stops part-way", async () => {
    let pulls = 0;
    const read = await readBodyWithinLimit(requestWith(chunked(1000, 1024, () => (pulls += 1))), 4 * 1024);
    assert.equal(read.tooLarge, true);
    assert.ok(pulls < 20, `read ${pulls} chunks before stopping`);
  });

  test("a declared length over the limit is refused before anything is read", async () => {
    let pulls = 0;
    const read = await readBodyWithinLimit(
      requestWith(chunked(10, 1024, () => (pulls += 1)), { "content-length": String(10 * 1024) }),
      4 * 1024,
    );
    assert.equal(read.tooLarge, true);
    assert.equal(pulls <= 1, true, "nothing to speak of was read");
  });

  test("no body at all is an empty one", async () => {
    const read = await readBodyWithinLimit(new Request("https://pwa.test/x", { method: "DELETE" }));
    assert.equal(read.tooLarge === false && read.bytes.byteLength, 0);
  });

  // One copy, sized from the declared length (review of c193e9e, issue 2).
  test("a declared length sizes the buffer once, and the bytes are exact", async () => {
    const read = await readBodyWithinLimit(requestWith(chunked(4, 1024), { "content-length": String(4 * 1024) }), 8 * 1024);
    assert.equal(read.tooLarge, false);
    if (read.tooLarge) return;
    assert.equal(read.bytes.byteLength, 4 * 1024);
    assert.equal(read.bytes.buffer.byteLength, 4 * 1024, "the buffer is exactly the declared size, not a joined copy");
    assert.ok(read.bytes.every((b) => b === 0x61));
  });

  test("a declared length larger than what arrives yields what arrived", async () => {
    const read = await readBodyWithinLimit(requestWith(chunked(2, 1024), { "content-length": String(4 * 1024) }), 8 * 1024);
    assert.equal(read.tooLarge === false && read.bytes.byteLength, 2 * 1024);
  });

  test("a declared length smaller than what arrives still yields every byte, within the limit", async () => {
    const read = await readBodyWithinLimit(requestWith(chunked(4, 1024), { "content-length": String(1024) }), 8 * 1024);
    assert.equal(read.tooLarge === false && read.bytes.byteLength, 4 * 1024);
    if (read.tooLarge) return;
    assert.ok(read.bytes.every((b) => b === 0x61));
  });

  test("a declared length under the limit does not exempt a body that outgrows the limit", async () => {
    const read = await readBodyWithinLimit(requestWith(chunked(100, 1024), { "content-length": String(1024) }), 4 * 1024);
    assert.equal(read.tooLarge, true);
  });
});

describe("through the gateway route", () => {
  const FO_TOKEN = "fo-session-not-a-real-token";
  const PWA_TOKEN = sessionFor(
    { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
    new Date(Date.now() + 864e5).toISOString(),
    FO_TOKEN,
  ).token;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  let received: { length: string | null; bytes: number }[] = [];

  beforeEach(() => {
    received = [];
    console.warn = () => {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const body = init.body as Uint8Array | undefined;
      received.push({ length: new Headers(init.headers).get("content-length"), bytes: body?.byteLength ?? 0 });
      return Response.json({ ok: true });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  });

  const upload = (body: BodyInit | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    POST(
      new NextRequest(new URL("/fo-gateway/api/modeling-agent/chat/parse-upload", "https://pwa.test"), {
        method: "POST",
        headers: {
          [GATEWAY_MARKER_HEADER]: "1",
          authorization: `Bearer ${PWA_TOKEN}`,
          cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
          "content-type": "application/octet-stream",
          ...headers,
        },
        body,
        duplex: "half",
      } as ConstructorParameters<typeof NextRequest>[1]),
      { params: Promise.resolve({ path: ["api", "modeling-agent", "chat", "parse-upload"] }) },
    );

  test("a body within the policy reaches FabOrchestrator whole, with its real length", async () => {
    const res = await upload(chunked(3, 1000));
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(received, [{ length: "3000", bytes: 3000 }]);
  });

  test("a body over the policy is a coded 413, and FabOrchestrator never sees it", async () => {
    const res = await upload(chunked(21, MiB));
    assert.equal(res.status, 413);
    const body = (await res.json()) as { code: string; error: string; details: { limit: number } };
    assert.equal(body.code, "body_too_large");
    assert.equal(body.details.limit, MAX_REQUEST_BODY_BYTES);
    assert.match(body.error, /about 20 MB/);
    assert.deepEqual(received, []);
  });

  test("a declared length over the policy is refused the same way", async () => {
    const res = await upload(new Uint8Array(10), { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) });
    assert.equal(res.status, 413);
    await res.text();
    assert.deepEqual(received, []);
  });

  // Review of c193e9e, blocking issue 2: an anonymous body to an API row was
  // read whole and forwarded before FabOrchestrator answered its own 401.
  describe("an anonymous body to an API row (no session)", () => {
    const realWarnNow = console.warn;
    let warned: string[] = [];
    beforeEach(() => {
      warned = [];
      console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
    });
    afterEach(() => {
      console.warn = realWarnNow;
    });

    const anonymous = (method: string, path: string, body?: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
      (method === "GET" ? GET : POST)(
        new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
          method,
          headers: { [GATEWAY_MARKER_HEADER]: "1", ...headers },
          body,
          duplex: "half",
        } as ConstructorParameters<typeof NextRequest>[1]),
        { params: Promise.resolve({ path: path.slice(1).split("/") }) },
      );

    test("is refused before a byte of the body is read, and FabOrchestrator never sees it", async () => {
      let pulls = 0;
      const res = await anonymous("POST", "/api/chat", chunked(20, MiB, () => (pulls += 1)), {
        "content-type": "application/json",
        "content-length": String(20 * MiB),
      });
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { code: string }).code, "session_invalid");
      assert.equal(res.headers.get("set-cookie"), null, "no session to end");
      // A ReadableStream pulls once by itself to fill its queue; the route
      // must add nothing to that (compare the declared-length test above).
      assert.ok(pulls <= 1, `the route never read the body (${pulls} pulls)`);
      assert.deepEqual(received, [], "nothing forwarded");
      assert.ok(warned.some((l) => l.includes('"reason":"anonymous_body"')), warned.join("\n"));
    });

    test("a chunked one, declaring nothing, the same", async () => {
      let pulls = 0;
      const res = await anonymous("POST", "/api/modeling-agent/chat/parse-upload", chunked(5, 1024, () => (pulls += 1)), {
        "content-type": "multipart/form-data; boundary=x",
      });
      assert.equal(res.status, 401);
      await res.text();
      assert.ok(pulls <= 1, `${pulls} pulls`);
      assert.deepEqual(received, []);
    });

    test("an anonymous GET to a public row is still forwarded (RP1 G31's two rows)", async () => {
      const res = await anonymous("GET", "/api/platform-theme");
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(received.length, 1, "FabOrchestrator answers for itself");
    });

    test("FabOrchestrator's browser log is for signed-in pages only: an anonymous one is refused", async () => {
      const res = await anonymous("POST", "/api/client-log", chunked(1, 256, () => {}), { "content-type": "application/json" });
      assert.equal(res.status, 401);
      await res.text();
      assert.deepEqual(received, []);
    });

    test("the downtime banner is public at FabOrchestrator, and forwarded without a session too", async () => {
      const res = await anonymous("GET", "/api/platform-notice");
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(received.length, 1);
    });
  });
});
