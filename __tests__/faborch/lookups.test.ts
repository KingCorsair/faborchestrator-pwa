/**
 * The two lookups every question used to pay for, remembered.
 *
 * Before 2026-09-28 the chat route asked FabOrchestrator two things ahead of
 * every single question — which data connections the operator has, and (for a
 * stored thread) whether the thread is theirs, by downloading their whole
 * conversation list — then forwarded the question. Three round trips in series
 * before the first word of an answer, two of them repeating the question
 * before's.
 *
 * These run the real routes against a stubbed FabOrchestrator and count what
 * reaches it. What is pinned:
 *
 *   the tool list is asked once every five minutes per session, and a failed ask is not remembered
 *   ownership, once proved, is not re-proved — but a refusal is never remembered
 *   creating a conversation is itself the proof
 *   nothing one session learned is ever used for another
 */

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { OWNERSHIP_TTL_MS, resetOwnershipCache } from "@/lib/faborch/owns";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { TOOL_LIST_TTL_MS, resetToolCache } from "@/lib/faborch/tools";
import { POST as CHAT } from "@/app/api/faborch/[agent]/chat/route";
import { POST as CREATE } from "@/app/api/faborch/conversations/route";

const ALICE = "fo-token-alice-not-real";
const BOB = "fo-token-bob-not-real";
const THREAD = "7b0f6a52-3c55-4a4e-9a51-5d1f2d6c9e10";

const pwaTokenFor = (foToken: string) =>
  sessionFor(
    { id: foToken, email: `${foToken}@plant.example`, name: "Operator", roleName: "Supervisor" },
    new Date(Date.now() + 864e5).toISOString(),
    foToken,
  ).token;

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

/**
 * A stub FabOrchestrator. Each handler may be replaced per test; the defaults
 * are an operator with one connected tool who owns `THREAD`.
 */
function stubFo(
  handlers: {
    tools?: (auth: string | null) => Response;
    conversations?: (auth: string | null) => Response;
    create?: () => Response;
  } = {},
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers as HeadersInit).get("Authorization");
    calls.push({
      method,
      path: url.pathname,
      auth,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });

    if (url.pathname === "/api/mcp/connections") {
      return handlers.tools?.(auth) ?? Response.json([{ id: "m1", status: "connected" }]);
    }
    if (url.pathname === "/api/conversations" && method === "GET") {
      return handlers.conversations?.(auth) ?? Response.json([{ id: THREAD, title: "Yield" }]);
    }
    if (url.pathname === "/api/conversations" && method === "POST") {
      return handlers.create?.() ?? Response.json({ id: THREAD });
    }
    if (url.pathname === "/api/chat") {
      return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

const ask = async (opts: { as?: string; thread?: string } = {}) => {
  const foToken = opts.as ?? ALICE;
  const res = await CHAT(
    new NextRequest("https://pwa.test/api/faborch/insight/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pwaTokenFor(foToken)}`,
        cookie: `${FO_TOKEN_COOKIE}=${foToken}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Yield by product?" }] }],
        ...(opts.thread ? { conversationId: opts.thread } : {}),
      }),
    }),
    { params: Promise.resolve({ agent: "insight" }) },
  );
  assert.equal(res.status, 200, "the question itself must always be answered");
  await res.text();
  return res;
};

const create = (as = ALICE) =>
  CREATE(
    new NextRequest("https://pwa.test/api/faborch/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pwaTokenFor(as)}`,
        cookie: `${FO_TOKEN_COOKIE}=${as}`,
      },
      body: JSON.stringify({ title: "Yield by product?" }),
    }),
  );

const count = (path: string, method = "GET") =>
  calls.filter((c) => c.path === path && c.method === method).length;

const chatBodies = () => calls.filter((c) => c.path === "/api/chat").map((c) => c.body!);

beforeEach(() => {
  calls = [];
  resetToolCache();
  resetOwnershipCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

describe("the tool list", () => {
  test("is asked once, then remembered for the next question", async () => {
    stubFo();
    await ask();
    await ask();
    await ask();
    assert.equal(count("/api/mcp/connections"), 1, "three questions, one lookup");
    for (const body of chatBodies()) assert.deepEqual(body.activeMcpIds, ["m1"]);
  });

  test("is asked again once five minutes have passed", async () => {
    // A tool an administrator connects mid-demo must still arrive.
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    let listed = [{ id: "m1", status: "connected" }];
    stubFo({ tools: () => Response.json(listed) });

    await ask();
    listed = [...listed, { id: "m2", status: "connected" }];
    mock.timers.tick(TOOL_LIST_TTL_MS - 1);
    await ask();
    assert.deepEqual(chatBodies().at(-1)!.activeMcpIds, ["m1"], "still remembered inside the window");

    mock.timers.tick(1);
    await ask();
    assert.deepEqual(chatBodies().at(-1)!.activeMcpIds, ["m1", "m2"], "and asked again after it");
    assert.equal(count("/api/mcp/connections"), 2);
  });

  test("a failed lookup is not remembered", async () => {
    // Remembering it would strip the operator's tools for five minutes after
    // one bad request.
    let fail = true;
    stubFo({
      tools: () =>
        fail ? new Response("", { status: 500 }) : Response.json([{ id: "m1", status: "connected" }]),
    });

    await ask();
    assert.deepEqual(chatBodies()[0]!.activeMcpIds, [], "the turn still goes, without tools");

    fail = false;
    await ask();
    assert.deepEqual(chatBodies()[1]!.activeMcpIds, ["m1"]);
    assert.equal(count("/api/mcp/connections"), 2);
  });

  test("an empty list is an answer, and is remembered like one", async () => {
    stubFo({ tools: () => Response.json([]) });
    await ask();
    await ask();
    assert.equal(count("/api/mcp/connections"), 1);
  });

  test("one session never sees another's tools", async () => {
    stubFo({
      tools: (auth) =>
        Response.json([{ id: auth === `Bearer ${ALICE}` ? "alice-tool" : "bob-tool", status: "connected" }]),
    });
    await ask({ as: ALICE });
    await ask({ as: BOB });
    assert.deepEqual(
      chatBodies().map((b) => b.activeMcpIds),
      [["alice-tool"], ["bob-tool"]],
    );
  });
});

describe("conversation ownership", () => {
  test("a thread proved once is not re-proved on the next question", async () => {
    stubFo();
    await ask({ thread: THREAD });
    await ask({ thread: THREAD });
    await ask({ thread: THREAD });
    assert.equal(count("/api/conversations"), 1, "three questions, one list download");
    for (const body of chatBodies()) assert.equal(body.conversationId, THREAD);
  });

  test("a thread that is not yours is checked again every time, and never forwarded", async () => {
    stubFo({ conversations: () => Response.json([]) });
    await ask({ thread: THREAD });
    await ask({ thread: THREAD });
    assert.equal(count("/api/conversations"), 2, "a refusal must not be remembered");
    for (const body of chatBodies()) assert.equal(body.conversationId, undefined);
  });

  test("a refusal from a moment ago does not stop a thread that now exists", async () => {
    // The screen creates a conversation and asks in it a moment later. A
    // remembered "not yours" from before it existed would unpersist that turn.
    let owned: { id: string }[] = [];
    stubFo({ conversations: () => Response.json(owned) });

    await ask({ thread: THREAD });
    owned = [{ id: THREAD }];
    await ask({ thread: THREAD });
    assert.equal(chatBodies()[1]!.conversationId, THREAD);
  });

  test("a proof is re-checked after five minutes", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    stubFo();
    await ask({ thread: THREAD });
    mock.timers.tick(OWNERSHIP_TTL_MS);
    await ask({ thread: THREAD });
    assert.equal(count("/api/conversations"), 2);
  });

  test("an unreachable FabOrchestrator proves nothing, and is not remembered", async () => {
    let down = true;
    stubFo({
      conversations: () =>
        down ? new Response("", { status: 503 }) : Response.json([{ id: THREAD }]),
    });
    await ask({ thread: THREAD });
    assert.equal(chatBodies()[0]!.conversationId, undefined, "unproved, so unpersisted");

    down = false;
    await ask({ thread: THREAD });
    assert.equal(chatBodies()[1]!.conversationId, THREAD);
  });

  test("one session's proof is never another's", async () => {
    // Alice owns the thread. Bob knows its id. The proof Alice's session earned
    // must not carry Bob's question into her thread.
    stubFo({
      conversations: (auth) =>
        Response.json(auth === `Bearer ${ALICE}` ? [{ id: THREAD }] : []),
    });
    await ask({ as: ALICE, thread: THREAD });
    await ask({ as: BOB, thread: THREAD });

    assert.equal(chatBodies()[0]!.conversationId, THREAD);
    assert.equal(chatBodies()[1]!.conversationId, undefined, "Bob's turn must not be written into Alice's thread");
  });
});

describe("creating a conversation is the proof", () => {
  test("the first question in a new conversation skips the list download", async () => {
    stubFo();
    const res = await create();
    assert.equal(((await res.json()) as { id: string }).id, THREAD);

    await ask({ thread: THREAD });
    assert.equal(count("/api/conversations"), 0, "the create already proved it");
    assert.equal(chatBodies()[0]!.conversationId, THREAD);
  });

  test("a create FabOrchestrator declined proves nothing", async () => {
    stubFo({
      create: () => new Response("", { status: 500 }),
      conversations: () => Response.json([]),
    });
    const res = await create();
    assert.equal(((await res.json()) as { id: string | null }).id, null);

    await ask({ thread: THREAD });
    assert.equal(count("/api/conversations"), 1, "so the next question checks for itself");
    assert.equal(chatBodies()[0]!.conversationId, undefined);
  });

  test("a conversation Alice created is still not Bob's", async () => {
    stubFo({ conversations: () => Response.json([]) });
    await create(ALICE);
    await ask({ as: BOB, thread: THREAD });
    assert.equal(chatBodies()[0]!.conversationId, undefined);
  });
});
