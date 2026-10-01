/**
 * Two devices, one FabOrchestrator account, through the gateway route
 * (`lib/gateway/seats.ts`, 1 October 2026).
 *
 * The FabOrchestrator here is a stub that behaves as the real one does: it
 * knows one user, lists every conversation of that user to any of their
 * sessions, lets any of them open, change or delete any of them, and accepts a
 * chat turn for any conversation id at all. That is exactly what two phones on
 * a shared account get today. Everything these tests assert is therefore added
 * by this app, in front of an unchanged FabOrchestrator:
 *
 *   · each device's list holds only what it started;
 *   · a conversation another device started, or nobody recorded, is refused
 *     before FabOrchestrator is asked anything;
 *   · what is forwarded is forwarded unchanged;
 *   · every failure of the store, the list or a claim ends in a refusal.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { resetRecentRevokes } from "@/lib/faborch/end-session";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { resetOwnershipCache } from "@/lib/gateway/ownership";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { parseRecord, resetSeatStores, serializeRecord } from "@/lib/gateway/seat-store";
import { conversationIdInChatBody, seatGateFor } from "@/lib/gateway/seats";
import { DELETE, GET, PATCH, POST } from "@/app/fo-gateway/[...path]/route";

const USER = { id: "shared-user", email: "shared@plant.example", name: "Shared", roleName: "Operator" };
const FAR = new Date(Date.now() + 864e5).toISOString();
const seatId = () => randomBytes(32).toString("base64url");

/** One signed-in device: its own FabOrchestrator token, its own seat, the same account. */
function device(name: string, seat: string | null = seatId()) {
  const foToken = `fo-token-of-${name}`;
  return { name, seat, foToken, bearer: sessionFor(USER, FAR, foToken, undefined, seat ?? undefined).token };
}
type Device = ReturnType<typeof device>;

/* ── The stub FabOrchestrator: one user, no idea about devices ─────────────── */
interface Row {
  id: string;
  title: string;
  isPinned: boolean;
  messages: { role: string; text: string }[];
  deleted: boolean;
}
let fo = new Map<string, Row>();
let upstream: { method: string; path: string; bearer: string | null; body: string | null }[] = [];
/** Overrides for one test: what FabOrchestrator answers to a list or a create. */
let listAnswer: (() => Response) | null = null;
let createAnswer: (() => Response) | null = null;
let nextCreateId: string | null = null;

function stubFo() {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body == null ? null : new TextDecoder().decode(init.body as Uint8Array);
    upstream.push({ method, path: url.pathname, bearer: new Headers(init.headers).get("authorization"), body });
    const live = () => [...fo.values()].filter((r) => !r.deleted);

    if (url.pathname === "/api/auth/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/api/conversations" && method === "GET") {
      if (listAnswer) return listAnswer();
      return Response.json(live().map((r) => ({ id: r.id, title: r.title, isPinned: r.isPinned, agent: "chat" })));
    }
    if (url.pathname === "/api/conversations" && method === "POST") {
      if (createAnswer) return createAnswer();
      const id = nextCreateId ?? randomUUID();
      nextCreateId = null;
      const title = (JSON.parse(body ?? "{}") as { title?: string }).title ?? "New Chat";
      fo.set(id, { id, title, isPinned: false, messages: [], deleted: false });
      return Response.json({ id, title, isPinned: false }, { status: 201 });
    }
    const one = /^\/api\/conversations\/([^/]+)(\/messages|\/title)?$/.exec(url.pathname);
    if (one) {
      const row = fo.get(decodeURIComponent(one[1]!));
      if (!row || row.deleted) return Response.json({ error: "not found" }, { status: 404 });
      if (one[2] === "/messages" && method === "GET") return Response.json(row.messages);
      if (one[2] === "/messages" && method === "POST") {
        row.messages.push({ role: "user", text: body ?? "" });
        return Response.json({ ok: true }, { status: 201 });
      }
      if (one[2] === "/messages" && method === "DELETE") {
        row.messages = [];
        return Response.json({ success: true });
      }
      if (one[2] === "/title") {
        row.title = "retitled";
        return Response.json({ title: row.title });
      }
      if (method === "GET") return Response.json({ id: row.id, title: row.title, messages: row.messages });
      if (method === "PATCH") {
        Object.assign(row, JSON.parse(body ?? "{}"));
        return Response.json({ id: row.id, title: row.title, isPinned: row.isPinned });
      }
      if (method === "DELETE") {
        row.deleted = true;
        return Response.json({ success: true });
      }
    }
    if (url.pathname === "/api/chat" || url.pathname === "/api/modeling-agent/chat") {
      const turn = JSON.parse(body ?? "{}") as { conversationId?: string };
      // The real one checks nothing here: any id is written to.
      if (turn.conversationId) fo.get(turn.conversationId)?.messages.push({ role: "user", text: body ?? "" });
      return new Response('data: {"type":"text-delta","delta":"real answer"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === "/api/messages/feedback") return Response.json({ success: true });
    if (url.pathname === "/api/user/models") return Response.json({ models: [] });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

const HANDLERS = { GET, POST, PATCH, DELETE } as const;
function call(who: Device | null, method: keyof typeof HANDLERS, path: string, body?: unknown, raw?: string) {
  const text = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const [pathname, query = ""] = path.split("?");
  const req = new NextRequest(new URL(`/fo-gateway${pathname}${query ? `?${query}` : ""}`, "https://pwa.test"), {
    method,
    headers: {
      [GATEWAY_MARKER_HEADER]: "1",
      ...(who ? { authorization: `Bearer ${who.bearer}`, cookie: `${FO_TOKEN_COOKIE}=${who.foToken}` } : {}),
      ...(text === undefined ? {} : { "content-type": "application/json" }),
    },
    body: text,
  });
  return HANDLERS[method](req, { params: Promise.resolve({ path: pathname!.slice(1).split("/") }) });
}
const json = async (res: Response) => (await res.json()) as Record<string, unknown> & { id?: string };
const listOf = async (who: Device) => {
  const res = await call(who, "GET", "/api/conversations");
  assert.equal(res.status, 200);
  return ((await res.json()) as { id: string }[]).map((r) => r.id);
};
const create = async (who: Device, title: string) => {
  const res = await call(who, "POST", "/api/conversations", { title });
  assert.equal(res.status, 201, `create by ${who.name}`);
  return (await json(res)).id!;
};
/** Calls FabOrchestrator received since `mark`. */
const sent = (path: RegExp, method?: string) =>
  upstream.filter((u) => path.test(u.path) && (!method || u.method === method));
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const realFetch = globalThis.fetch;
const real = { error: console.error, warn: console.warn, info: console.info };
let dir = "";
let storePath = "";
let A: Device;
let B: Device;

beforeEach(async () => {
  await resetSeatStores();
  resetOwnershipCache();
  resetRecentRevokes();
  fo = new Map();
  upstream = [];
  listAnswer = null;
  createAnswer = null;
  nextCreateId = null;
  dir = mkdtempSync(join(tmpdir(), "seat-isolation-"));
  storePath = join(dir, "conversations.log");
  process.env.SEAT_STORE_PATH = storePath;
  A = device("A");
  B = device("B");
  stubFo();
  console.error = () => {};
  console.warn = () => {};
  console.info = () => {};
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  Object.assign(console, real);
  await resetSeatStores();
  rmSync(dir, { recursive: true, force: true });
});

describe("each device sees only what it started", () => {
  test("A sees A1 and not B1; B sees B1 and not A1; FabOrchestrator holds both for the one user", async () => {
    const a1 = await create(A, "A1");
    const b1 = await create(B, "B1");
    assert.equal(fo.size, 2, "FabOrchestrator has both conversations under the same user");

    assert.deepEqual(await listOf(A), [a1]);
    assert.deepEqual(await listOf(B), [b1]);
  });

  test("the rows that are kept are FabOrchestrator's own, untouched", async () => {
    const a1 = await create(A, "A1");
    await create(B, "B1");
    const res = await call(A, "GET", "/api/conversations");
    assert.deepEqual(await res.json(), [{ id: a1, title: "A1", isPinned: false, agent: "chat" }]);
  });

  test("a third device on the same account starts empty", async () => {
    await create(A, "A1");
    await create(B, "B1");
    assert.deepEqual(await listOf(device("C")), []);
  });

  test("a list wrapped in an object is filtered the same way", async () => {
    const a1 = await create(A, "A1");
    const b1 = await create(B, "B1");
    listAnswer = () => Response.json({ total: 2, conversations: [{ id: a1 }, { id: b1 }, { title: "no id" }, null] });
    const res = await call(B, "GET", "/api/conversations");
    assert.deepEqual(await res.json(), { total: 2, conversations: [{ id: b1 }] });
  });
});

describe("a conversation another device started is refused before FabOrchestrator is asked", () => {
  const attempts: [string, keyof typeof HANDLERS, (id: string) => string, unknown?][] = [
    ["open it", "GET", (id) => `/api/conversations/${id}`],
    ["rename or pin it", "PATCH", (id) => `/api/conversations/${id}`, { title: "HIJACKED", isPinned: true }],
    ["delete it", "DELETE", (id) => `/api/conversations/${id}`],
    ["read its messages", "GET", (id) => `/api/conversations/${id}/messages`],
    ["write a message into it", "POST", (id) => `/api/conversations/${id}/messages`, { role: "user", content: "x" }],
    ["clear its messages", "DELETE", (id) => `/api/conversations/${id}/messages`],
    ["regenerate its title", "POST", (id) => `/api/conversations/${id}/title`, { message: "x" }],
    ["reach a path under it this app has never heard of", "GET", (id) => `/api/conversations/${id}/export`],
  ];

  for (const [what, method, path, body] of attempts) {
    test(`A cannot ${what}`, async () => {
      const b1 = await create(B, "B1");
      upstream = [];
      const res = await call(A, method, path(b1), body);
      assert.equal(res.status, 403);
      assert.equal((await json(res)).code, "conversation_forbidden");
      assert.equal(upstream.length, 0, "FabOrchestrator is not asked anything");
      const row = fo.get(b1)!;
      assert.deepEqual([row.title, row.isPinned, row.deleted, row.messages.length], ["B1", false, false, 0]);
    });
  }

  test("and the owner can do every one of those things", async () => {
    const b1 = await create(B, "B1");
    assert.equal((await call(B, "GET", `/api/conversations/${b1}`)).status, 200);
    assert.equal((await call(B, "GET", `/api/conversations/${b1}/messages`)).status, 200);
    assert.equal((await call(B, "POST", `/api/conversations/${b1}/messages`, { role: "user", content: "x" })).status, 201);
    assert.equal((await call(B, "PATCH", `/api/conversations/${b1}`, { title: "B1 renamed" })).status, 200);
    assert.equal(fo.get(b1)!.title, "B1 renamed");
    assert.equal((await call(B, "DELETE", `/api/conversations/${b1}`)).status, 200);
    assert.equal(fo.get(b1)!.deleted, true);
  });

  test("A cannot continue B's conversation: the turn never reaches FabOrchestrator", async () => {
    const b1 = await create(B, "B1");
    upstream = [];
    for (const path of ["/api/chat", "/api/modeling-agent/chat"]) {
      const res = await call(A, "POST", path, { conversationId: b1, messages: [{ role: "user", parts: [] }] });
      assert.equal(res.status, 403, path);
      assert.equal((await json(res)).code, "conversation_forbidden");
    }
    assert.equal(upstream.length, 0, "no turn, and no ownership lookup either");
    assert.equal(fo.get(b1)!.messages.length, 0);
  });

  test("the refusal is the same for another device's conversation and for one that does not exist", async () => {
    const b1 = await create(B, "B1");
    const theirs = await call(A, "GET", `/api/conversations/${b1}`);
    const nobodys = await call(A, "GET", `/api/conversations/${randomUUID()}`);
    assert.equal(theirs.status, nobodys.status);
    assert.deepEqual(await theirs.json(), await nobodys.json());
  });
});

describe("what is allowed is forwarded unchanged, to the real FabOrchestrator", () => {
  test("a turn in the device's own conversation: the same bytes, the device's own FabOrchestrator token", async () => {
    const a1 = await create(A, "A1");
    upstream = [];
    const raw = `{"messages":[{"role":"user","parts":[{"type":"text","text":"yield on line 3?"}]}],"model":"claude-opus-4-8","conversationId":"${a1}","webSearch":false,"activeMcpIds":["7f3b6d0e-0000-4000-8000-000000000001"]}`;
    const res = await call(A, "POST", "/api/chat", undefined, raw);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /real answer/, "the answer is FabOrchestrator's, passed through");

    const turn = sent(/^\/api\/chat$/)[0]!;
    assert.equal(turn.body, raw, "not one byte of the question is changed");
    assert.equal(turn.bearer, `Bearer ${A.foToken}`);
  });

  test("a turn with no conversation is forwarded, and writes into none", async () => {
    upstream = [];
    const res = await call(A, "POST", "/api/chat", { messages: [{ role: "user", parts: [] }], conversationId: null });
    assert.equal(res.status, 200);
    assert.equal(sent(/^\/api\/chat$/).length, 1);
  });

  test("a route that is not about a conversation is untouched by the rule", async () => {
    const res = await call(A, "GET", "/api/user/models");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { models: [] });
  });

  test("a new conversation's first turn needs no ownership lookup: the create proved it", async () => {
    const a1 = await create(A, "A1");
    upstream = [];
    await call(A, "POST", "/api/chat", { conversationId: a1, messages: [] });
    assert.equal(sent(/^\/api\/conversations\//, "GET").length, 0);
    assert.equal(sent(/^\/api\/chat$/).length, 1);
  });
});

describe("an unmapped conversation is nobody's", () => {
  test("one that existed before, or was started on FabOrchestrator's own site, is hidden from every device and refused to all", async () => {
    const legacy = randomUUID();
    fo.set(legacy, { id: legacy, title: "from the website", isPinned: false, messages: [], deleted: false });
    const a1 = await create(A, "A1");

    assert.deepEqual(await listOf(A), [a1]);
    assert.deepEqual(await listOf(B), []);
    for (const who of [A, B]) {
      assert.equal((await call(who, "GET", `/api/conversations/${legacy}`)).status, 403);
      assert.equal((await call(who, "DELETE", `/api/conversations/${legacy}`)).status, 403);
      assert.equal((await call(who, "POST", "/api/chat", { conversationId: legacy, messages: [] })).status, 403);
    }
    assert.equal(fo.get(legacy)!.deleted, false, "and it is untouched in FabOrchestrator");
    assert.equal(fo.get(legacy)!.messages.length, 0);
  });

  test("a conversation whose record is corrupt is hidden from its own device too", async () => {
    const b1 = await create(B, "B1");
    await resetSeatStores();
    // The file is damaged while the app is down: B1's record no longer verifies.
    writeFileSync(storePath, readFileSync(storePath, "utf8").replace(B.seat!, A.seat!));

    assert.deepEqual(await listOf(B), [], "not B's any more");
    assert.deepEqual(await listOf(A), [], "and not A's, though the altered record names A");
    assert.equal((await call(A, "GET", `/api/conversations/${b1}`)).status, 403);
    assert.equal((await call(B, "GET", `/api/conversations/${b1}`)).status, 403);
  });
});

describe("paths that name no single valid conversation are refused", () => {
  test("an id that is not a conversation id, in every disguise", async () => {
    const b1 = await create(B, "B1");
    upstream = [];
    for (const path of [
      "/api/conversations/not-a-uuid",
      `/api/conversations/${b1}x`,
      `/api/conversations/${b1}%20`,
      `/api/conversations/${b1.toUpperCase()}`,
      "/api/conversations/..",
      "/api/conversations/%",
    ]) {
      const res = await call(A, "GET", path);
      assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    }
    assert.equal(upstream.length, 0, "none of them reaches FabOrchestrator");
  });

  test("a percent-encoded id is still the id it decodes to", async () => {
    const b1 = await create(B, "B1");
    const encoded = b1.replace("-", "%2D");
    upstream = [];
    assert.equal((await call(A, "GET", `/api/conversations/${encoded}`)).status, 403);
    assert.equal(upstream.length, 0);
  });

  test("a method on the collection that is neither list nor create is refused", async () => {
    await create(A, "A1");
    upstream = [];
    assert.equal((await call(A, "DELETE", "/api/conversations")).status, 403);
    assert.equal((await call(A, "PATCH", "/api/conversations", { isPinned: true })).status, 403);
    assert.equal(upstream.length, 0);
  });

  test("the gate, from the path alone", () => {
    const id = randomUUID();
    assert.deepEqual(seatGateFor("/api/conversations", "GET"), { kind: "list" });
    assert.deepEqual(seatGateFor("/api/conversations", "POST"), { kind: "create" });
    assert.deepEqual(seatGateFor("/api/conversations", "DELETE"), { kind: "refuse" });
    assert.deepEqual(seatGateFor(`/api/conversations/${id}`, "DELETE"), { kind: "conversation", id });
    assert.deepEqual(seatGateFor(`/api/conversations/${id}/messages`, "POST"), { kind: "conversation", id });
    assert.deepEqual(seatGateFor(`/api/conversations/${id}/anything/else`, "GET"), { kind: "conversation", id });
    assert.deepEqual(seatGateFor("/api/conversations/", "GET"), { kind: "refuse" });
    assert.deepEqual(seatGateFor("/api/chat", "POST"), { kind: "chat" });
    assert.deepEqual(seatGateFor("/api/modeling-agent/chat", "POST"), { kind: "chat" });
    assert.deepEqual(seatGateFor("/api/chat", "GET"), { kind: "none" });
    assert.deepEqual(seatGateFor("/api/conversationsX", "GET"), { kind: "none" });
    assert.deepEqual(seatGateFor("/api/user/models", "GET"), { kind: "none" });
  });

  test("the conversation a chat body names", () => {
    const id = randomUUID();
    assert.equal(conversationIdInChatBody(JSON.stringify({ conversationId: id })), id);
    assert.equal(conversationIdInChatBody(`{"conversationId":"x","conversationId":"${id}"}`), id, "the last one, as FabOrchestrator reads it");
    assert.equal(conversationIdInChatBody(JSON.stringify({ conversationId: null })), null);
    assert.equal(conversationIdInChatBody(JSON.stringify({ messages: [] })), null);
    assert.equal(conversationIdInChatBody(JSON.stringify({ conversationId: 7 })), null);
    assert.equal(conversationIdInChatBody("not json"), null);
    assert.equal(conversationIdInChatBody("[]"), null);
  });

  test("artifacts are closed: an artifact id cannot be tied to a device", async () => {
    const b1 = await create(B, "B1");
    upstream = [];
    for (const path of [`/api/artifacts?conversationId=${b1}`, `/api/artifacts/${randomUUID()}`]) {
      const res = await call(A, "GET", path);
      assert.equal(res.status, 404, path);
    }
    assert.equal((await call(B, "POST", "/api/artifacts", { conversationId: b1, title: "t", content: "c" })).status, 404);
    assert.equal(upstream.length, 0);
  });

  test("feedback names a message, not a conversation: it is not seat-checked (documented limit)", async () => {
    // Pinned so that the limit stays a decision: a message id is random and
    // reaches a browser only inside a conversation its seat owns.
    const res = await call(A, "POST", "/api/messages/feedback", { messageId: randomUUID(), feedback: "positive" });
    assert.equal(res.status, 200);
  });
});

describe("a session with no seat cannot use a conversation route", () => {
  test("it is ended: 401, the cookie cleared, FabOrchestrator's token revoked, nothing forwarded", async () => {
    const old = device("old-session", null); // minted before seats existed
    assert.equal(old.seat, null);
    await create(A, "A1");
    upstream = [];

    for (const [method, path, body] of [
      ["GET", "/api/conversations", undefined],
      ["POST", "/api/conversations", { title: "x" }],
      ["GET", `/api/conversations/${randomUUID()}`, undefined],
      ["POST", "/api/chat", { messages: [] }],
    ] as const) {
      const res = await call(old, method, path, body);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await json(res)).code, "session_invalid");
      assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`${FO_TOKEN_COOKIE}=;`));
    }
    await settle();
    assert.ok(upstream.every((u) => u.path === "/api/auth/logout"), "only the revoke reaches FabOrchestrator");
    assert.ok(upstream.some((u) => u.bearer === `Bearer ${old.foToken}`));
    assert.equal(fo.size, 1, "and it created nothing");
  });

  test("it can still use a route that is not about conversations, until it signs in again", async () => {
    const old = device("old-session", null);
    assert.equal((await call(old, "GET", "/api/user/models")).status, 200);
  });
});

describe("every failure ends in a refusal", () => {
  test("no store configured: conversation routes answer 503, and nothing is created in FabOrchestrator", async () => {
    await resetSeatStores();
    delete process.env.SEAT_STORE_PATH;
    upstream = [];
    for (const [method, path, body] of [
      ["GET", "/api/conversations", undefined],
      ["POST", "/api/conversations", { title: "x" }],
      ["GET", `/api/conversations/${randomUUID()}`, undefined],
      ["POST", "/api/chat", { conversationId: randomUUID(), messages: [] }],
    ] as const) {
      const res = await call(A, method, path, body);
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal((await json(res)).code, "ownership_unavailable");
      assert.equal(res.headers.get("retry-after"), "15");
    }
    assert.equal(upstream.length, 0, "FabOrchestrator is never asked");
    assert.equal(fo.size, 0);
  });

  test("a store that cannot be read: the same", async () => {
    await resetSeatStores();
    mkdirSync(storePath, { recursive: true }); // a directory where the file should be
    upstream = [];
    assert.equal((await call(A, "GET", "/api/conversations")).status, 503);
    assert.equal((await call(A, "POST", "/api/conversations", { title: "x" })).status, 503);
    assert.equal(upstream.length, 0);
  });

  test("a list this app cannot read is refused, never passed through unfiltered", async () => {
    await create(B, "B1");
    for (const answer of [() => Response.json({ ok: true }), () => new Response("<html>oops</html>"), () => Response.json("a string")]) {
      listAnswer = answer;
      const res = await call(A, "GET", "/api/conversations");
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.ok(!text.includes("B1") && !text.includes("oops"), "nothing of FabOrchestrator's answer comes back");
    }
  });

  test("a create whose ownership cannot be recorded is undone in FabOrchestrator, and the phone told to retry", async () => {
    // FabOrchestrator hands A an id the store already has as B's.
    const taken = randomUUID();
    writeFileSync(storePath, `${serializeRecord(taken, B.seat!, 1)}\n`);
    nextCreateId = taken;
    upstream = [];

    const res = await call(A, "POST", "/api/conversations", { title: "collides" });
    assert.equal(res.status, 503);
    assert.equal((await json(res)).code, "ownership_unavailable");
    assert.ok(sent(new RegExp(`^/api/conversations/${taken}$`), "DELETE").length === 1, "the new conversation is deleted again");
    assert.equal(fo.get(taken)!.deleted, true);
    assert.deepEqual(await listOf(A), []);
    assert.equal((await call(A, "GET", `/api/conversations/${taken}`)).status, 403, "A never gets it");
  });

  test("a create FabOrchestrator answers without a usable id is not handed over", async () => {
    for (const answer of [
      () => Response.json({ title: "no id" }, { status: 201 }),
      () => Response.json({ id: "not-a-uuid" }, { status: 201 }),
      () => new Response("not json", { status: 201 }),
    ]) {
      createAnswer = answer;
      const res = await call(A, "POST", "/api/conversations", { title: "x" });
      assert.equal(res.status, 503);
    }
    assert.deepEqual(await listOf(A), []);
  });

  test("a create FabOrchestrator refuses is passed back as it is, and claims nothing", async () => {
    createAnswer = () => Response.json({ error: "Daily request limit reached." }, { status: 429 });
    const res = await call(A, "POST", "/api/conversations", { title: "x" });
    assert.equal(res.status, 429);
    assert.equal((await json(res)).error, "Daily request limit reached.");
    assert.equal(readFileSync(storePath, { encoding: "utf8", flag: "a+" }), "");
  });
});

describe("concurrency and restart", () => {
  test("twenty conversations created at once by each of two devices: none lost, none crossed", async () => {
    const made = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? create(B, `B-${i}`) : create(A, `A-${i}`)).then((id) => ({ id, by: i % 2 ? "B" : "A" }))),
    );
    const mineA = made.filter((m) => m.by === "A").map((m) => m.id).sort();
    const mineB = made.filter((m) => m.by === "B").map((m) => m.id).sort();
    assert.deepEqual((await listOf(A)).sort(), mineA);
    assert.deepEqual((await listOf(B)).sort(), mineB);

    const lines = readFileSync(storePath, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 40);
    assert.ok(lines.every((l) => parseRecord(l) !== null));
  });

  test("after a restart each device still has exactly its own", async () => {
    const a1 = await create(A, "A1");
    const b1 = await create(B, "B1");
    await resetSeatStores(); // the process is gone; only the file remains
    resetOwnershipCache();

    // The same devices sign in again: new sessions, new FabOrchestrator tokens, the same seats.
    const A2 = device("A-again", A.seat);
    const B2 = device("B-again", B.seat);
    assert.deepEqual(await listOf(A2), [a1]);
    assert.deepEqual(await listOf(B2), [b1]);
    assert.equal((await call(A2, "GET", `/api/conversations/${b1}`)).status, 403);
    assert.equal((await call(B2, "GET", `/api/conversations/${b1}`)).status, 200);
  });

  test("a deleted conversation's id never passes to another device", async () => {
    const a1 = await create(A, "A1");
    assert.equal((await call(A, "DELETE", `/api/conversations/${a1}`)).status, 200);
    nextCreateId = a1; // FabOrchestrator would never reuse an id; if it did:
    fo.delete(a1);
    const res = await call(B, "POST", "/api/conversations", { title: "reused id" });
    assert.equal(res.status, 503);
    assert.deepEqual(await listOf(B), []);
  });
});
