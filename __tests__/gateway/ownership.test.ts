/**
 * Conversation ownership for the embedded chat (`lib/gateway/ownership.ts`),
 * WP4 and plan RP6.
 *
 * FabOrchestrator's `/api/chat` writes into whatever `conversationId` it is
 * handed, without checking whose it is — verified against upstream `main`,
 * where that route has no `getConversation` and no `userId` comparison at all.
 * Embedding put FabOrchestrator's own client on this origin, posting its own
 * bodies, so the gateway proves ownership before a turn reaches FabOrchestrator.
 *
 * The property: an id reaches FabOrchestrator only when FabOrchestrator itself
 * has said it belongs to the caller (`GET /api/conversations/{id}`, which
 * checks `userId`). Anything else is refused with a code (RP6 part 3) — never
 * stripped into a turn that is silently not saved, as it was until 2026-09-30.
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { MAX_REQUEST_BODY_BYTES } from "@/lib/gateway/body-limit";
import { needsOwnershipCheck, resetOwnershipCache } from "@/lib/gateway/ownership";

const TOKEN = "fo-session-not-a-real-token";
const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

type Lookup = { path: string; bearer: string | null };
let lookups: Lookup[] = [];

/**
 * A FabOrchestrator whose per-conversation read answers from `owned`: 200 with
 * the conversation for an id in it, otherwise `otherwise` (403 by default, the
 * status FabOrchestrator gives for somebody else's thread).
 */
function stubFo(owned: string[], otherwise: () => Response = () => Response.json({ error: "forbidden" }, { status: 403 })) {
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    lookups.push({ path: url.pathname, bearer: new Headers(init.headers).get("authorization") });
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (owned.includes(id)) return Response.json({ id, title: "t", messages: [] });
    return otherwise();
  });
}

/** A FabOrchestrator whose every answer is `answer()`. */
function stubAnswer(answer: () => Response | Promise<Response>) {
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    lookups.push({ path: new URL(String(input)).pathname, bearer: null });
    return answer();
  });
}

async function check(path: string, body: unknown, token = TOKEN) {
  const { checkChatBody } = await import("@/lib/gateway/ownership");
  return checkChatBody(path, typeof body === "string" ? body : JSON.stringify(body), token);
}

const quiet = () => {
  mock.method(console, "error", () => {});
  mock.method(console, "warn", () => {});
  mock.method(console, "info", () => {});
};

beforeEach(() => {
  mock.restoreAll();
  resetOwnershipCache();
  lookups = [];
  quiet();
});

describe("which requests are inspected at all", () => {
  test("only POSTs to the two chat endpoints", () => {
    assert.equal(needsOwnershipCheck("/api/chat", "POST"), true);
    assert.equal(needsOwnershipCheck("/api/modeling-agent/chat", "POST"), true);
  });

  test("not a GET of the same path, and not other endpoints", () => {
    assert.equal(needsOwnershipCheck("/api/chat", "GET"), false);
    assert.equal(needsOwnershipCheck("/api/modeling-agent/chat/parse-upload", "POST"), false);
    assert.equal(needsOwnershipCheck("/api/conversations", "POST"), false);
    assert.equal(needsOwnershipCheck("/api/files/x/download", "POST"), false);
  });
});

describe("an id that belongs to the caller", () => {
  test("is proved by FabOrchestrator's own per-conversation answer, with the caller's token", async () => {
    stubFo([MINE]);
    const outcome = await check("/api/chat", { messages: [], conversationId: MINE });
    assert.equal(outcome.action, "forward-owned");
    assert.deepEqual(lookups, [{ path: `/api/conversations/${MINE}`, bearer: `Bearer ${TOKEN}` }]);
  });

  test("the modeling agent's ids are proved the same way", async () => {
    stubFo([MINE]);
    assert.equal((await check("/api/modeling-agent/chat", { conversationId: MINE })).action, "forward-owned");
  });
});

describe("an id that does not (RP6 part 3: refuse, never strip)", () => {
  test("somebody else's: 403 conversation_forbidden, and FabOrchestrator is sent nothing", async () => {
    stubFo([MINE]);
    const outcome = await check("/api/chat", { messages: [{ role: "user" }], conversationId: THEIRS });
    assert.equal(outcome.action, "refuse");
    if (outcome.action !== "refuse") return;
    assert.equal(outcome.status, 403);
    assert.equal(outcome.code, "conversation_forbidden");
    assert.match(outcome.error, /Start a new conversation/);
  });

  test("a conversation that is gone (FabOrchestrator's 404) reads the same", async () => {
    stubFo([], () => Response.json({ error: "not found" }, { status: 404 }));
    const outcome = await check("/api/chat", { conversationId: MINE });
    assert.equal(outcome.action === "refuse" && outcome.code, "conversation_forbidden");
  });

  test("FabOrchestrator no longer honouring the token ends the session", async () => {
    stubAnswer(() => Response.json({ error: "Session expired" }, { status: 401 }));
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "session-expired");
  });

  for (const [label, answer] of [
    ["an unexpected status (422)", () => Response.json({}, { status: 422 })],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "/login" } })],
    ["a server error", () => new Response("boom", { status: 500 })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a body naming a different conversation", () => Response.json({ id: THEIRS })],
  ] as const) {
    test(`${label}: 503 ownership_unavailable with Retry-After — fail closed`, async () => {
      stubAnswer(answer);
      const outcome = await check("/api/chat", { conversationId: MINE });
      assert.equal(outcome.action, "refuse");
      if (outcome.action !== "refuse") return;
      assert.equal(outcome.status, 503);
      assert.equal(outcome.code, "ownership_unavailable");
      assert.ok((outcome.retryAfterSeconds ?? 0) > 0);
    });
  }

  test("FabOrchestrator unreachable: 503, fail closed", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const outcome = await check("/api/chat", { conversationId: MINE });
    assert.equal(outcome.action === "refuse" && outcome.code, "ownership_unavailable");
  });
});

describe("input validation (RP6 part 2)", () => {
  test("absent or null is forwarded untouched, and FabOrchestrator is not asked", async () => {
    stubFo([MINE]);
    assert.equal((await check("/api/chat", { messages: [] })).action, "forward-unchanged");
    assert.equal((await check("/api/chat", { conversationId: null })).action, "forward-unchanged");
    assert.equal(lookups.length, 0);
  });

  test("anything but a UUID is 400 invalid_request, without a call to FabOrchestrator", async () => {
    stubFo([MINE]);
    for (const bad of [42, ["x"], {}, "", "not-a-uuid", "11111111-1111-1111-1111-111111111111"]) {
      const outcome = await check("/api/chat", { conversationId: bad });
      assert.equal(outcome.action === "refuse" && outcome.code, "invalid_request", JSON.stringify(bad));
    }
    assert.equal(lookups.length, 0);
  });

  test("a body that is not JSON, or not an object, is FabOrchestrator's to refuse", async () => {
    stubFo([MINE]);
    assert.equal((await check("/api/chat", "not json at all")).action, "forward-unchanged");
    assert.equal((await check("/api/chat", "[1,2,3]")).action, "forward-unchanged");
    assert.equal((await check("/api/chat", "null")).action, "forward-unchanged");
  });

  test("a body over the policy is refused rather than inspected", async () => {
    stubFo([MINE]);
    const huge = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
    const outcome = await check("/api/chat", huge);
    assert.equal(outcome.action === "refuse" && outcome.code, "body_too_large");
  });
});

describe("the cache remembers yes and never no", () => {
  test("a second turn in the same conversation does not ask again", async () => {
    stubFo([MINE]);
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(lookups.length, 1, "the second turn should have been answered from the cache");
  });

  test("a refused id is asked about again every time", async () => {
    stubFo([MINE]);
    await check("/api/chat", { conversationId: THEIRS });
    await check("/api/chat", { conversationId: THEIRS });
    assert.equal(lookups.length, 2, "a negative must never be cached");
  });

  test("a conversation created moments ago is found on its first turn", async () => {
    const known = [MINE];
    stubFo(known, () => Response.json({ error: "not found" }, { status: 404 }));
    assert.equal((await check("/api/chat", { conversationId: THEIRS })).action, "refuse");
    known.push(THEIRS);
    assert.equal((await check("/api/chat", { conversationId: THEIRS })).action, "forward-owned");
  });

  test("one operator's proof is not another's", async () => {
    stubFo([MINE]);
    assert.equal((await check("/api/chat", { conversationId: MINE }, TOKEN)).action, "forward-owned");
    mock.restoreAll();
    quiet();
    stubFo([]);
    assert.equal((await check("/api/chat", { conversationId: MINE }, "somebody-elses-token")).action, "refuse");
  });
});

describe("the log (RP10-A)", () => {
  test("a refusal is logged with an eight-character prefix and FabOrchestrator's status, never the whole id", async () => {
    mock.restoreAll();
    const warnings: string[] = [];
    mock.method(console, "warn", (...a: unknown[]) => warnings.push(a.map(String).join(" ")));
    mock.method(console, "info", () => {});
    stubFo([]);
    await check("/api/chat", { conversationId: THEIRS });
    const line = warnings.find((l) => l.includes('"event":"ownership_refused"'));
    assert.ok(line, warnings.join(" | "));
    assert.match(line!, /"idPrefix":"22222222"/);
    assert.match(line!, /"foStatus":403/);
    assert.ok(!line!.includes(THEIRS));
  });
});

/**
 * WP8 — warming the cache from the list the client already asked for. These
 * pin the two things that must stay true: **nothing is remembered that
 * FabOrchestrator did not just list for that exact token**, and **the response
 * the operator asked for is unchanged**.
 */
describe("warming the cache from a conversation list (WP8)", () => {
  test("only the collection, and only a GET", async () => {
    const { isConversationList } = await import("@/lib/gateway/ownership");
    assert.equal(isConversationList("/api/conversations", "GET"), true);
    assert.equal(isConversationList("/api/conversations", "get"), true);
    assert.equal(isConversationList(`/api/conversations/${MINE}`, "GET"), false);
    assert.equal(isConversationList("/api/conversations", "POST"), false);
    assert.equal(isConversationList("/api/chat", "GET"), false);
  });

  test("an id read from the list is not asked about again", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    assert.equal(rememberFromList(TOKEN, JSON.stringify([{ id: MINE, title: "t" }])), 1);
    stubFo([]);
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(lookups.length, 0, "the warmed entry should have answered without an upstream read");
  });

  test("what was listed for one token proves nothing for another", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]));
    stubFo([]);
    assert.equal((await check("/api/chat", { conversationId: MINE }, "somebody-elses-token")).action, "refuse");
  });

  test("an id that was never listed still costs a fresh read", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]));
    stubFo([MINE]);
    assert.equal((await check("/api/chat", { conversationId: THEIRS })).action, "refuse");
    assert.equal(lookups.length, 1, "a miss must still cost a fresh read — 'no' is never cached");
  });

  test("both shapes FabOrchestrator might answer with, and nothing else", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    assert.equal(rememberFromList(TOKEN, JSON.stringify([{ id: MINE }, { id: THEIRS }])), 2);
    assert.equal(rememberFromList(TOKEN, JSON.stringify({ conversations: [{ id: MINE }] })), 1);
    assert.equal(rememberFromList(TOKEN, "not json at all"), 0);
    assert.equal(rememberFromList(TOKEN, JSON.stringify({ error: "nope" })), 0);
    assert.equal(rememberFromList(TOKEN, JSON.stringify([{ id: 42 }, { id: "" }, null, "x"])), 0);
  });

  test("the stream reaches the caller byte for byte, and only then teaches", async () => {
    const { warmFromListStream } = await import("@/lib/gateway/ownership");
    const rows = JSON.stringify([{ id: MINE, title: "split across chunks" }]);
    const out = await new Response(warmFromListStream(streamOf(rows), TOKEN)).text();
    assert.equal(out, rows, "the body must arrive exactly as FabOrchestrator sent it");
    stubFo([]);
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(lookups.length, 0);
  });

  test("a list too large to copy is still delivered whole, and teaches nothing", async () => {
    const { warmFromListStream } = await import("@/lib/gateway/ownership");
    const huge = `[{"id":"${MINE}","pad":"${"x".repeat(5 * 1024 * 1024)}"}]`;
    const out = await new Response(warmFromListStream(streamOf(huge), TOKEN)).text();
    assert.equal(out.length, huge.length, "nothing may be truncated on the way to the operator");
    stubFo([MINE]);
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(lookups.length, 1);
  });
});

/** A stream of `text`, in two chunks, the way a response body arrives. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const half = Math.floor(bytes.length / 2);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, half));
      controller.enqueue(bytes.slice(half));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("the cache holds fingerprints, never tokens (RP6)", () => {
  test("no key contains the FabOrchestrator token itself", async () => {
    const { ownershipCacheStats } = await import("@/lib/gateway/ownership");
    stubFo([MINE]);
    await check("/api/chat", { conversationId: MINE });
    const stats = ownershipCacheStats(TOKEN);
    assert.equal(stats.size, 1);
    assert.equal(stats.contains, false, "a live credential must not sit in the cache");
  });
});

describe("a create warms the cache (RP6 warmFromCreate)", () => {
  test("the first turn in a conversation the gateway saw created needs no lookup", async () => {
    const { warmFromCreateStream } = await import("@/lib/gateway/ownership");
    const created = JSON.stringify({ id: MINE, title: "New chat", isPinned: false });
    assert.equal(await drain(warmFromCreateStream(streamOf(created), TOKEN)), created, "passed through byte-exact");
    stubFo([]);
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(lookups.length, 0);
  });

  test("the create proves nothing for another token", async () => {
    const { warmFromCreateStream } = await import("@/lib/gateway/ownership");
    await drain(warmFromCreateStream(streamOf(JSON.stringify({ id: MINE })), TOKEN));
    stubFo([]);
    assert.equal((await check("/api/chat", { conversationId: MINE }, "somebody-elses-token")).action, "refuse");
  });

  test("only a POST to the collection counts as a create", async () => {
    const { isConversationCreate } = await import("@/lib/gateway/ownership");
    assert.equal(isConversationCreate("/api/conversations", "POST"), true);
    assert.equal(isConversationCreate("/api/conversations", "GET"), false);
    assert.equal(isConversationCreate(`/api/conversations/${MINE}`, "POST"), false);
  });
});

describe("a delete the gateway sees is forgotten, with a tombstone (RP6)", () => {
  test("the id is forgotten for every token", async () => {
    const { rememberFromList, forgetConversation } = await import("@/lib/gateway/ownership");
    rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]));
    rememberFromList("second-device-token", JSON.stringify([{ id: MINE }]));
    forgetConversation(MINE);
    stubFo([], () => Response.json({ error: "not found" }, { status: 404 }));
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "refuse");
    assert.equal((await check("/api/chat", { conversationId: MINE }, "second-device-token")).action, "refuse");
    assert.equal(lookups.length, 2, "both had to ask FabOrchestrator again");
  });

  test("a list read that began before the delete cannot re-warm the id", async () => {
    const { rememberFromList, forgetConversation } = await import("@/lib/gateway/ownership");
    const listRequestedAt = Date.now() - 1000;
    forgetConversation(MINE);
    assert.equal(rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]), listRequestedAt), 1);
    stubFo([]);
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "refuse");
    assert.equal(lookups.length, 1, "the stale list did not warm it");
  });

  test("evidence asked for after the delete is honoured", async () => {
    const { rememberFromList, forgetConversation } = await import("@/lib/gateway/ownership");
    forgetConversation(MINE, Date.now() - 1000);
    rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]), Date.now());
    stubFo([]);
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(lookups.length, 0);
  });

  test("only a DELETE of one conversation names an id", async () => {
    const { deletedConversationId } = await import("@/lib/gateway/ownership");
    assert.equal(deletedConversationId(`/api/conversations/${MINE}`, "DELETE"), MINE);
    assert.equal(deletedConversationId(`/api/conversations/${MINE}`, "PATCH"), null);
    assert.equal(deletedConversationId("/api/conversations", "DELETE"), null);
    assert.equal(deletedConversationId(`/api/conversations/${MINE}/messages`, "DELETE"), null);
  });
});

describe("T_own and the size bound (RP6)", () => {
  test("T_own comes from OWNERSHIP_TTL_MS, defaulting to 30 minutes", async () => {
    const { ownershipTtlMs } = await import("@/lib/gateway/ownership");
    delete process.env.OWNERSHIP_TTL_MS;
    assert.equal(ownershipTtlMs(), 30 * 60_000);
    process.env.OWNERSHIP_TTL_MS = "300000";
    assert.equal(ownershipTtlMs(), 300_000);
    process.env.OWNERSHIP_TTL_MS = "nonsense";
    assert.equal(ownershipTtlMs(), 30 * 60_000);
    delete process.env.OWNERSHIP_TTL_MS;
  });

  test("an entry past T_own is asked about again", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    try {
      rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]));
      mock.timers.tick(30 * 60_000 + 1);
      stubFo([MINE]);
      assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
      assert.equal(lookups.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  test("the cache never holds more than MAX_ENTRIES, dropping the least recently used", async () => {
    const { MAX_ENTRIES, ownershipCacheStats, rememberFromList } = await import("@/lib/gateway/ownership");
    const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `c-${from + i}` }));
    for (let from = 0; from < MAX_ENTRIES + 10; from += 2000) {
      rememberFromList(TOKEN, JSON.stringify(ids(from, 2000)));
    }
    assert.equal(ownershipCacheStats().size, MAX_ENTRIES);
    assert.equal(ownershipCacheStats(":c-0").contains, false, "the oldest went first");
  });
});
