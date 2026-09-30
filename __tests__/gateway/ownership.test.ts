/**
 * Conversation ownership for the embedded chat (`lib/gateway/ownership.ts`), WP4.
 *
 * FabOrchestrator's `/api/chat` writes into whatever `conversationId` it is
 * handed, without checking whose it is — verified against upstream `main`,
 * where that route has no `getConversation` and no `userId` comparison at all.
 * This app's own proxy route has refused to be the vehicle for that since the
 * demo. Embedding put FabOrchestrator's own client on this origin, posting its
 * own bodies, so the same rule has to hold at the gateway.
 *
 * The property: an id reaches FabOrchestrator only when it has been proved to
 * belong to the caller. An unproved id is stripped and the turn is still
 * answered, because refusing outright would punish somebody for a stale tab.
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import {
  MAX_INSPECTABLE_BODY_BYTES,
  needsOwnershipCheck,
  resetOwnershipCache,
} from "@/lib/gateway/ownership";

const TOKEN = "fo-session-not-a-real-token";
const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

/**
 * `checkChatBody` asks FabOrchestrator which conversations the caller owns, so
 * these tests stand a fetch in for that. The shape is the one
 * `GET /api/conversations` really returns (verified in WP0: a bare array).
 */
function stubConversations(ids: string[], onCall?: () => void) {
  mock.method(globalThis, "fetch", async () => {
    onCall?.();
    return new Response(JSON.stringify(ids.map((id) => ({ id, title: "t", updatedAt: new Date().toISOString() }))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** Imported lazily so each test gets the module with its stubbed fetch in place. */
async function check(path: string, body: unknown, token = TOKEN) {
  const { checkChatBody } = await import("@/lib/gateway/ownership");
  return checkChatBody(path, typeof body === "string" ? body : JSON.stringify(body), token);
}

beforeEach(() => {
  mock.restoreAll();
  resetOwnershipCache();
});

describe("which requests are inspected at all", () => {
  test("only POSTs to the two chat endpoints", () => {
    assert.equal(needsOwnershipCheck("/api/chat", "POST"), true);
    assert.equal(needsOwnershipCheck("/api/modeling-agent/chat", "POST"), true);
  });

  test("not a GET of the same path, and not other endpoints", () => {
    assert.equal(needsOwnershipCheck("/api/chat", "GET"), false);
    // Uploads must keep streaming rather than being buffered to be inspected.
    assert.equal(needsOwnershipCheck("/api/modeling-agent/chat/parse-upload", "POST"), false);
    assert.equal(needsOwnershipCheck("/api/conversations", "POST"), false);
    assert.equal(needsOwnershipCheck("/api/files/x/download", "POST"), false);
  });
});

describe("an id that belongs to the caller", () => {
  test("is forwarded untouched", async () => {
    stubConversations([MINE, "other-of-mine"]);
    const outcome = await check("/api/chat", { messages: [], conversationId: MINE });
    assert.equal(outcome.action, "forward-owned");
  });
});

describe("an id that does not", () => {
  test("is stripped, and the turn is still answered", async () => {
    stubConversations([MINE]);
    const outcome = await check("/api/chat", { messages: [{ role: "user" }], conversationId: THEIRS });
    assert.equal(outcome.action, "forward-stripped");
    if (outcome.action !== "forward-stripped") return;

    const forwarded = JSON.parse(outcome.body);
    // Absent, not null: `/api/chat` gates every write on `if (!conversationId)`.
    assert.equal("conversationId" in forwarded, false);
    // The question itself survives — the operator still gets their answer.
    assert.deepEqual(forwarded.messages, [{ role: "user" }]);
    assert.equal(outcome.conversationId, THEIRS);
  });

  test("is stripped when FabOrchestrator cannot be asked at all", async () => {
    // An unproved id is not a licence to proceed. `ownsConversation` swallows
    // the failure and answers false, and the turn goes unpersisted.
    mock.method(globalThis, "fetch", async () => {
      throw new Error("FabOrchestrator unreachable");
    });
    const outcome = await check("/api/chat", { messages: [], conversationId: MINE });
    assert.equal(outcome.action, "forward-stripped");
  });
});

describe("bodies with nothing to check", () => {
  test("no conversationId at all", async () => {
    stubConversations([MINE]);
    assert.equal((await check("/api/chat", { messages: [] })).action, "forward-unchanged");
  });

  test("an empty or non-string id", async () => {
    stubConversations([MINE]);
    assert.equal((await check("/api/chat", { conversationId: "" })).action, "forward-unchanged");
    assert.equal((await check("/api/chat", { conversationId: 42 })).action, "forward-unchanged");
    assert.equal((await check("/api/chat", { conversationId: null })).action, "forward-unchanged");
  });

  test("a body that is not JSON, or not an object", async () => {
    stubConversations([MINE]);
    // FabOrchestrator rejects these on its own terms; there is no id in them
    // to misuse, so the gateway does not have that argument on its behalf.
    assert.equal((await check("/api/chat", "not json at all")).action, "forward-unchanged");
    assert.equal((await check("/api/chat", "[1,2,3]")).action, "forward-unchanged");
    assert.equal((await check("/api/chat", "null")).action, "forward-unchanged");
  });

  test("a body too large to inspect is refused rather than forwarded unchecked", async () => {
    stubConversations([MINE]);
    const huge = "x".repeat(MAX_INSPECTABLE_BODY_BYTES + 1);
    assert.equal((await check("/api/chat", huge)).action, "refuse");
  });
});

describe("the cache remembers yes and never no", () => {
  test("a second turn in the same conversation does not ask again", async () => {
    let calls = 0;
    stubConversations([MINE], () => (calls += 1));

    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(calls, 1);
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(calls, 1, "the second turn should have been answered from the cache");
  });

  test("a refused id is asked about again every time", async () => {
    // The property that makes a brand-new conversation work: FabOrchestrator's
    // client creates one and immediately posts into it, so a cached "no" would
    // silently leave that thread empty forever.
    let calls = 0;
    stubConversations([MINE], () => (calls += 1));

    assert.equal((await check("/api/chat", { conversationId: THEIRS })).action, "forward-stripped");
    assert.equal((await check("/api/chat", { conversationId: THEIRS })).action, "forward-stripped");
    assert.equal(calls, 2, "a negative must never be cached");
  });

  test("a conversation created moments ago is found on its first turn", async () => {
    let known = [MINE];
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify(known.map((id) => ({ id, title: "t" }))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // Not yet created: refused, and not cached.
    assert.equal((await check("/api/chat", { conversationId: THEIRS })).action, "forward-stripped");
    // Now FabOrchestrator has it. The next turn must find it.
    known = [MINE, THEIRS];
    assert.equal((await check("/api/chat", { conversationId: THEIRS })).action, "forward-owned");
    assert.equal(calls, 2);
  });

  test("one operator's proof is not another's", async () => {
    stubConversations([MINE]);
    assert.equal((await check("/api/chat", { conversationId: MINE }, TOKEN)).action, "forward-owned");

    // A different session, whose list does not contain it.
    stubConversations([]);
    assert.equal(
      (await check("/api/chat", { conversationId: MINE }, "somebody-elses-token")).action,
      "forward-stripped",
    );
  });
});

describe("the modeling agent uses its own conversation bucket", () => {
  test("its ids are checked too", async () => {
    stubConversations([MINE]);
    assert.equal((await check("/api/modeling-agent/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal((await check("/api/modeling-agent/chat", { conversationId: THEIRS })).action, "forward-stripped");
  });
});

/**
 * WP8 — warming the cache from the list the client already asked for.
 *
 * The measured cost of the check was one upstream round trip on the first turn
 * of a thread. The list that would answer it has already gone past the gateway
 * by then, so it is read on the way out. These pin the two things that must
 * stay true: **nothing is remembered that FabOrchestrator did not just list for
 * that exact token**, and **the response the operator asked for is unchanged**.
 */
describe("warming the cache from a conversation list (WP8)", () => {
  test("only the collection, and only a GET", async () => {
    const { isConversationList } = await import("@/lib/gateway/ownership");
    assert.equal(isConversationList("/api/conversations", "GET"), true);
    assert.equal(isConversationList("/api/conversations", "get"), true);
    // A single thread is 1.3 MB of tool parts to learn one id from.
    assert.equal(isConversationList(`/api/conversations/${MINE}`, "GET"), false);
    // A POST creates one; its answer is not a list of what the caller owns.
    assert.equal(isConversationList("/api/conversations", "POST"), false);
    assert.equal(isConversationList("/api/chat", "GET"), false);
  });

  test("an id read from the list is not asked about again", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    assert.equal(rememberFromList(TOKEN, JSON.stringify([{ id: MINE, title: "t" }])), 1);

    // If the cache did not answer this, the stub below would — and it says no.
    let asked = 0;
    stubConversations([], () => {
      asked += 1;
    });
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(asked, 0, "the warmed entry should have answered without an upstream read");
  });

  test("what was listed for one token proves nothing for another", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]));

    stubConversations([]);
    assert.equal(
      (await check("/api/chat", { conversationId: MINE }, "somebody-elses-token")).action,
      "forward-stripped",
    );
  });

  test("an id that was never listed is still refused, warm cache or not", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]));

    let asked = 0;
    stubConversations([MINE], () => {
      asked += 1;
    });
    assert.equal((await check("/api/chat", { conversationId: THEIRS })).action, "forward-stripped");
    assert.equal(asked, 1, "a miss must still cost a fresh read — 'no' is never cached");
  });

  test("both shapes FabOrchestrator might answer with, and nothing else", async () => {
    const { rememberFromList } = await import("@/lib/gateway/ownership");
    assert.equal(rememberFromList(TOKEN, JSON.stringify([{ id: MINE }, { id: THEIRS }])), 2);
    assert.equal(rememberFromList(TOKEN, JSON.stringify({ conversations: [{ id: MINE }] })), 1);
    // Anything unrecognised warms nothing rather than being guessed at.
    assert.equal(rememberFromList(TOKEN, "not json at all"), 0);
    assert.equal(rememberFromList(TOKEN, JSON.stringify({ error: "nope" })), 0);
    assert.equal(rememberFromList(TOKEN, JSON.stringify([{ id: 42 }, { id: "" }, null, "x"])), 0);
  });

  test("the stream reaches the caller byte for byte, and only then teaches", async () => {
    const { warmFromListStream } = await import("@/lib/gateway/ownership");
    const rows = JSON.stringify([{ id: MINE, title: "split across chunks" }]);
    const half = Math.floor(rows.length / 2);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(rows.slice(0, half)));
        controller.enqueue(enc.encode(rows.slice(half)));
        controller.close();
      },
    });

    const out = await new Response(warmFromListStream(source, TOKEN)).text();
    assert.equal(out, rows, "the body must arrive exactly as FabOrchestrator sent it");

    let asked = 0;
    stubConversations([], () => {
      asked += 1;
    });
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(asked, 0);
  });

  test("a list too large to copy is still delivered whole", async () => {
    const { warmFromListStream } = await import("@/lib/gateway/ownership");
    // Past the 4 MB copy ceiling: the copy is abandoned, the body is not.
    const huge = `[{"id":"${MINE}","pad":"${"x".repeat(5 * 1024 * 1024)}"}]`;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });

    const out = await new Response(warmFromListStream(source, TOKEN)).text();
    assert.equal(out.length, huge.length, "nothing may be truncated on the way to the operator");

    // And the cache stayed cold, so the check pays for its own read as before.
    let asked = 0;
    stubConversations([MINE], () => {
      asked += 1;
    });
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(asked, 1);
  });
});

// ── Reconciled with RP6 (2026-09-30) ───────────────────────────────────────
// The chetan branch's second ownership cache (fingerprint-keyed, warmed on
// create) folded into this one, with the pieces RP6 designs around it.

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

/** Read a passed-through stream to the end, as the phone would. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("the cache holds fingerprints, never tokens (RP6)", () => {
  test("no key contains the FabOrchestrator token itself", async () => {
    const { ownershipCacheStats } = await import("@/lib/gateway/ownership");
    stubConversations([MINE]);
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

    let calls = 0;
    stubConversations([], () => (calls += 1));
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(calls, 0);
  });

  test("the create proves nothing for another token", async () => {
    const { warmFromCreateStream } = await import("@/lib/gateway/ownership");
    await drain(warmFromCreateStream(streamOf(JSON.stringify({ id: MINE })), TOKEN));
    stubConversations([]);
    assert.equal((await check("/api/chat", { conversationId: MINE }, "somebody-elses-token")).action, "forward-stripped");
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

    let calls = 0;
    stubConversations([], () => (calls += 1));
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-stripped");
    assert.equal((await check("/api/chat", { conversationId: MINE }, "second-device-token")).action, "forward-stripped");
    assert.equal(calls, 2, "both had to ask FabOrchestrator again");
  });

  test("a list read that began before the delete cannot re-warm the id", async () => {
    const { rememberFromList, forgetConversation } = await import("@/lib/gateway/ownership");
    const listRequestedAt = Date.now() - 1000;
    forgetConversation(MINE);
    assert.equal(rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]), listRequestedAt), 1);

    let calls = 0;
    stubConversations([], () => (calls += 1));
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-stripped");
    assert.equal(calls, 1, "the stale list did not warm it");
  });

  test("evidence asked for after the delete is honoured", async () => {
    const { rememberFromList, forgetConversation } = await import("@/lib/gateway/ownership");
    forgetConversation(MINE, Date.now() - 1000);
    rememberFromList(TOKEN, JSON.stringify([{ id: MINE }]), Date.now());
    let calls = 0;
    stubConversations([], () => (calls += 1));
    assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
    assert.equal(calls, 0);
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
      let calls = 0;
      stubConversations([MINE], () => (calls += 1));
      assert.equal((await check("/api/chat", { conversationId: MINE })).action, "forward-owned");
      assert.equal(calls, 1);
    } finally {
      mock.timers.reset();
    }
  });

  test("the cache never holds more than MAX_ENTRIES, dropping the least recently used", async () => {
    const { MAX_ENTRIES, ownershipCacheStats, rememberFromList } = await import("@/lib/gateway/ownership");
    const ids = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `c-${from + i}` }));
    // Fill in batches (a single list is capped at 2,000 ids).
    for (let from = 0; from < MAX_ENTRIES + 10; from += 2000) {
      rememberFromList(TOKEN, JSON.stringify(ids(from, 2000)));
    }
    assert.equal(ownershipCacheStats().size, MAX_ENTRIES);
    assert.equal(ownershipCacheStats(":c-0").contains, false, "the oldest went first");
  });
});
