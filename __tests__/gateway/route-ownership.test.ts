/**
 * The gateway route and the one ownership cache (`lib/gateway/ownership.ts`),
 * driven through the real route handler against a stubbed FabOrchestrator.
 *
 *   a 201 from POST /api/conversations   → the first turn in it needs no lookup
 *   a 2xx DELETE /api/conversations/{id} → the next turn has to ask again
 *   an id that is not the caller's       → 403 conversation_forbidden, nothing forwarded
 *   FabOrchestrator cannot be asked      → 503 ownership_unavailable, nothing forwarded
 *   FabOrchestrator says the token died  → 401, and the cookie is cleared
 *   an id that is not an id              → 400 invalid_request, FabOrchestrator not asked
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { resetOwnershipCache } from "@/lib/gateway/ownership";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { DELETE, GET, PATCH, POST } from "@/app/fo-gateway/[...path]/route";
import { seatStoreOwning, TEST_SEAT } from "./seat-fixture";

const FO_TOKEN = "fo-session-not-a-real-token";
const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";
// These tests are about FabOrchestrator's own ownership answer, so the seat
// rule is satisfied for both ids and the proof decides (`seat-fixture.ts`).
seatStoreOwning(MINE, THEIRS);
const PWA_TOKEN = sessionFor(
  { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
  undefined,
  TEST_SEAT,
).token;

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realError = console.error;
const realInfo = console.info;
let upstream: { method: string; path: string }[] = [];
let conversations: string[] = [];
let perIdAnswer: ((id: string) => Response) | null = null;
let warnings: string[] = [];

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
    const one = /^\/api\/conversations\/([^/]+)$/.exec(url.pathname);
    if (one && method === "DELETE") return Response.json({ success: true });
    if (one && method === "PATCH") return Response.json({ error: "not yours" }, { status: 403 });
    if (one && method === "GET") {
      const id = decodeURIComponent(one[1]!);
      if (perIdAnswer) return perIdAnswer(id);
      return conversations.includes(id)
        ? Response.json({ id, title: "t", messages: [] })
        : Response.json({ error: "not yours" }, { status: 403 });
    }
    if (url.pathname === "/api/chat") return new Response("data: [DONE]\n\n", { status: 200 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function call(handler: typeof GET, method: string, path: string, body?: unknown): Promise<Response> {
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

/** Per-conversation reads: the proof, when the cache could not answer. */
const lookups = () => upstream.filter((u) => u.method === "GET" && /^\/api\/conversations\/[^/]+$/.test(u.path)).length;
const chats = () => upstream.filter((u) => u.path === "/api/chat").length;

beforeEach(() => {
  upstream = [];
  conversations = [];
  perIdAnswer = null;
  warnings = [];
  resetOwnershipCache();
  stubFo();
  console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
  console.error = () => {};
  console.info = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
  console.info = realInfo;
});

describe("the cache, through the gateway route", () => {
  test("a conversation created through the gateway needs no lookup on its first turn", async () => {
    const created = await call(POST, "POST", "/api/conversations", { title: "New chat" });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { id: MINE, title: "New chat" }, "the create passes through untouched");

    const turn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    assert.equal(turn.status, 200);
    await turn.text();
    assert.equal(lookups(), 0, "the create was the proof");
  });

  test("the sidebar's list warms the cache, and a deleted conversation has to be proved again", async () => {
    conversations = [MINE];
    const list = await call(GET, "GET", "/api/conversations");
    await list.text(); // the list warms the cache as it streams past
    const warmTurn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    await warmTurn.text();
    assert.equal(lookups(), 0, "the list answered it");

    const deleted = await call(DELETE, "DELETE", `/api/conversations/${MINE}`);
    assert.equal(deleted.status, 200);
    await deleted.text();
    conversations = [];

    const turn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    assert.equal(turn.status, 403, "the deleted id was forgotten, so FabOrchestrator was asked, and said no");
    assert.equal(lookups(), 1);
  });

  test("a change FabOrchestrator refused (403) is forgotten too, so the next turn is proved again", async () => {
    conversations = [MINE];
    await (await call(GET, "GET", "/api/conversations")).text(); // warms the cache
    const patched = await call(PATCH, "PATCH", `/api/conversations/${MINE}`, { title: "x" });
    assert.equal(patched.status, 403);
    await patched.text();
    conversations = [];
    const turn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    assert.equal(turn.status, 403);
    assert.equal(lookups(), 1, "the refused id was forgotten, so FabOrchestrator was asked again");
  });

  test("a create FabOrchestrator declined proves nothing", async () => {
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

describe("refusals, through the gateway route (RP6 part 3)", () => {
  test("somebody else's conversation: 403 conversation_forbidden, and no turn reaches FabOrchestrator", async () => {
    const turn = await call(POST, "POST", "/api/chat", { conversationId: THEIRS, messages: [] });
    assert.equal(turn.status, 403);
    const body = (await turn.json()) as { code: string; error: string };
    assert.equal(body.code, "conversation_forbidden");
    assert.match(body.error, /Start a new conversation/);
    assert.equal(chats(), 0, "never forwarded, and never forwarded stripped");
    const line = warnings.find((l) => l.includes('"event":"ownership_refused"'));
    assert.ok(line, warnings.join(" | "));
    assert.match(line!, /"idPrefix":"22222222"/);
    assert.ok(!line!.includes(THEIRS), "the whole id is access-bearing at FO");
  });

  test("FabOrchestrator cannot be asked: 503 ownership_unavailable with Retry-After, fail closed", async () => {
    perIdAnswer = () => new Response("boom", { status: 500 });
    const turn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    assert.equal(turn.status, 503);
    assert.equal(((await turn.json()) as { code: string }).code, "ownership_unavailable");
    assert.ok(Number(turn.headers.get("retry-after")) > 0);
    assert.equal(chats(), 0);
  });

  test("FabOrchestrator says the token is dead: 401 faborch_session_expired, and the cookie is cleared", async () => {
    perIdAnswer = () => Response.json({ error: "Session expired" }, { status: 401 });
    const turn = await call(POST, "POST", "/api/chat", { conversationId: MINE, messages: [] });
    assert.equal(turn.status, 401);
    assert.equal(((await turn.json()) as { code: string }).code, "faborch_session_expired");
    assert.match(turn.headers.get("set-cookie") ?? "", new RegExp(`${FO_TOKEN_COOKIE}=;`));
    assert.equal(chats(), 0);
  });

  test("an id that is not a conversation id: 400, and FabOrchestrator is not asked at all", async () => {
    const turn = await call(POST, "POST", "/api/chat", { conversationId: "not-a-uuid", messages: [] });
    assert.equal(turn.status, 400);
    assert.equal(((await turn.json()) as { code: string }).code, "invalid_request");
    assert.deepEqual(upstream, []);
  });

  test("a turn with no conversation is forwarded untouched", async () => {
    const turn = await call(POST, "POST", "/api/chat", { messages: [] });
    assert.equal(turn.status, 200);
    await turn.text();
    assert.equal(chats(), 1);
    assert.equal(lookups(), 0);
  });
});
