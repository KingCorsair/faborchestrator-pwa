/**
 * The PWA's native `/api/faborch/*` routes during the soak (plan revision 3.13):
 *
 *   RP8: closed in `whole` mode (a `no-store` 404 from `proxy.ts`), because no
 *        native screen that calls them is reachable there; open in `surfaces`
 *        and `off`, where the native screens still render.
 *   RP1 part 3 item 7 (finding B5): while they are reachable, each reads its
 *        body under a declared class and refuses anything larger with the
 *        coded 413 (the chetan branch bounded the same three routes).
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import {
  CHAT_BODY_LIMIT,
  CREATE_CONVERSATION_BODY_LIMIT,
  CreateConversationSchema,
  SMALL_JSON_BODY_LIMIT,
} from "@/lib/validation";
import { POST as CHAT } from "@/app/api/faborch/[agent]/chat/route";
import { POST as CREATE } from "@/app/api/faborch/conversations/route";
import { PATCH as PIN } from "@/app/api/faborch/conversations/[id]/route";

const ORIGIN = "https://faborch-demo.fly.dev";
const FO_TOKEN = "fo-session-not-a-real-token";
const PWA_TOKEN = sessionFor(
  { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
).token;

const realMode = process.env.FO_EMBED_MODE;
const realSurfaces = process.env.FO_EMBED_SURFACES;
const realFetch = globalThis.fetch;
afterEach(() => {
  process.env.FO_EMBED_MODE = realMode;
  process.env.FO_EMBED_SURFACES = realSurfaces;
  if (realMode === undefined) delete process.env.FO_EMBED_MODE;
  if (realSurfaces === undefined) delete process.env.FO_EMBED_SURFACES;
  globalThis.fetch = realFetch;
});

function apiRequest(path: string, method = "GET"): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), {
    method,
    headers: { authorization: `Bearer ${PWA_TOKEN}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` },
  });
}

describe("closed in whole mode (RP8)", () => {
  test("whole: every /api/faborch path is a no-store 404, answered by proxy.ts", async () => {
    process.env.FO_EMBED_MODE = "whole";
    for (const [path, method] of [
      ["/api/faborch/reports", "GET"],
      ["/api/faborch/insight/chat", "POST"],
      ["/api/faborch/conversations", "POST"],
      ["/api/faborch", "GET"],
    ] as const) {
      const res = proxy(apiRequest(path, method));
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(((await res.json()) as { code: string }).code, "not_found");
    }
  });

  test("a path that only starts with the same letters is not caught", () => {
    process.env.FO_EMBED_MODE = "whole";
    const res = proxy(apiRequest("/api/faborchestra"));
    assert.notEqual(res.headers.get("cache-control"), "no-store");
  });

  test("surfaces with only /chat: the native reports API still reaches its handler", () => {
    delete process.env.FO_EMBED_MODE;
    process.env.FO_EMBED_SURFACES = "/chat";
    const res = proxy(apiRequest("/api/faborch/reports"));
    assert.notEqual(res.status, 404);
  });

  test("flag off: the native routes reach their handlers", () => {
    process.env.FO_EMBED_MODE = "off";
    const res = proxy(apiRequest("/api/faborch/insight/chat", "POST"));
    assert.notEqual(res.status, 404);
  });
});

describe("body classes while they are reachable (RP1 item 7, B5)", () => {
  const withBody = (path: string, method: string, declared: number, body = "{}") =>
    new NextRequest(new URL(path, ORIGIN), {
      method,
      headers: {
        authorization: `Bearer ${PWA_TOKEN}`,
        cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
        "content-type": "application/json",
        "content-length": String(declared),
      },
      body,
    });

  const refused = async (res: Response, limit: number) => {
    assert.equal(res.status, 413);
    const body = (await res.json()) as { code: string; details: { limit: number } };
    assert.equal(body.code, "body_too_large");
    assert.equal(body.details.limit, limit);
  };

  test("native chat: the chat policy + 1 is a coded 413, and FabOrchestrator is never asked", async () => {
    let asked = false;
    globalThis.fetch = (async () => {
      asked = true;
      return new Response("[]");
    }) as typeof fetch;
    const res = await CHAT(withBody("/api/faborch/insight/chat", "POST", CHAT_BODY_LIMIT + 1), {
      params: Promise.resolve({ agent: "insight" }),
    });
    await refused(res, CHAT_BODY_LIMIT);
    assert.equal(asked, false);
  });

  test("creating a conversation: over its limit is a coded 413", async () => {
    await refused(await CREATE(withBody("/api/faborch/conversations", "POST", CREATE_CONVERSATION_BODY_LIMIT + 1)), CREATE_CONVERSATION_BODY_LIMIT);
  });

  test("the longest legal title still fits the create limit", () => {
    const body = JSON.stringify({ title: "\u0001".repeat(20_000) }); // six bytes a character once escaped
    assert.ok(CreateConversationSchema.safeParse(JSON.parse(body)).success);
    assert.ok(Buffer.byteLength(body) <= CREATE_CONVERSATION_BODY_LIMIT);
  });

  test("pinning: small-json, 16 KiB", async () => {
    const res = await PIN(withBody("/api/faborch/conversations/abc", "PATCH", SMALL_JSON_BODY_LIMIT + 1), {
      params: Promise.resolve({ id: "abc" }),
    });
    await refused(res, SMALL_JSON_BODY_LIMIT);
  });
});
