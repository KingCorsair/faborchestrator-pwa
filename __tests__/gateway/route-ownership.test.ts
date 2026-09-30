/**
 * The gateway route wires RP6's create and delete hooks into the one ownership
 * cache (`lib/gateway/ownership.ts`), driven through the real route handler
 * against a stubbed FabOrchestrator.
 *
 *   a 201 from POST /api/conversations → the first turn in it needs no lookup
 *   a 2xx DELETE /api/conversations/{id} → the next turn has to ask again
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { resetOwnershipCache } from "@/lib/gateway/ownership";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { DELETE, GET, POST } from "@/app/fo-gateway/[...path]/route";

const FO_TOKEN = "fo-session-not-a-real-token";
const MINE = "11111111-1111-4111-8111-111111111111";
const PWA_TOKEN = sessionFor(
  { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
).token;

const realFetch = globalThis.fetch;
let upstream: { method: string; path: string }[] = [];
let conversations: string[] = [];

function stubFo() {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    upstream.push({ method, path: url.pathname });
    if (url.pathname === "/api/conversations" && method === "POST") {
      conversations.push(MINE);
      return Response.json({ id: MINE, title: "New chat" }, { status: 201 });
    }
    if (url.pathname === "/api/conversations" && method === "GET") {
      return Response.json(conversations.map((id) => ({ id, title: "t" })));
    }
    if (url.pathname === `/api/conversations/${MINE}` && method === "DELETE") {
      return Response.json({ success: true });
    }
    if (url.pathname === "/api/chat") return new Response("data: [DONE]\n\n", { status: 200 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function call(
  handler: typeof GET,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const req = new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
    method,
    headers: {
      [GATEWAY_MARKER_HEADER]: "1",
      authorization: `Bearer ${PWA_TOKEN}`,
      cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handler(req, { params: Promise.resolve({ path: path.slice(1).split("/") }) });
}

const lookups = () => upstream.filter((u) => u.method === "GET" && u.path === "/api/conversations").length;

beforeEach(() => {
  upstream = [];
  conversations = [];
  resetOwnershipCache();
  stubFo();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("through the gateway route", () => {
  test("a conversation created through the gateway needs no lookup on its first turn", async () => {
    const created = await call(POST, "POST", "/api/conversations", { title: "New chat" });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { id: MINE, title: "New chat" }, "the create passes through untouched");

    const turn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    assert.equal(turn.status, 200);
    await turn.text();
    assert.equal(lookups(), 0, "the create was the proof");
  });

  test("a conversation deleted through the gateway has to be proved again", async () => {
    conversations = [MINE];
    const list = await call(GET, "GET", "/api/conversations");
    await list.text(); // the list warms the cache as it streams past
    const warmTurn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    await warmTurn.text();
    assert.equal(lookups(), 1, "only the sidebar's own list read");

    const deleted = await call(DELETE, "DELETE", `/api/conversations/${MINE}`);
    assert.equal(deleted.status, 200);
    conversations = [];

    const turn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    await turn.text();
    assert.equal(lookups(), 2, "the deleted id was forgotten, so the turn asked FabOrchestrator");
  });
});

describe("what the gateway writes to the log (RP10-A)", () => {
  const realWarn = console.warn;
  afterEach(() => {
    console.warn = realWarn;
  });

  test("a refused conversation id is logged as an eight-character prefix, never whole", async () => {
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    const THEIRS = "22222222-2222-4222-8222-222222222222";
    const turn = await call(POST, "POST", "/api/chat", { conversationId: THEIRS, messages: [] });
    await turn.text();
    const line = lines.find((l) => l.includes('"event":"ownership_stripped"'));
    assert.ok(line, lines.join(" | "));
    assert.match(line!, /"idPrefix":"22222222"/);
    assert.ok(!line!.includes(THEIRS), "the whole id is access-bearing at FO");
  });
});

describe("a create FabOrchestrator declined proves nothing", () => {
  test("a refused create, even one whose body names an id, does not warm the cache", async () => {
    // FabOrchestrator answering the create with an error; the body carries an
    // id-shaped field, which must not be read as a conversation made for us.
    const answer = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/conversations" && (init.method ?? "GET").toUpperCase() === "POST") {
        upstream.push({ method: "POST", path: url.pathname });
        return Response.json({ id: MINE, error: "Conversation limit reached" }, { status: 403 });
      }
      return answer(input, init);
    }) as typeof fetch;

    const created = await call(POST, "POST", "/api/conversations", { title: "New chat" });
    assert.equal(created.status, 403);
    await created.text();

    const turn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    await turn.text();
    assert.equal(lookups(), 1, "the turn had to prove ownership: the declined create proved nothing");
  });
});
