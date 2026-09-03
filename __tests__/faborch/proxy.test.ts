/**
 * WP4 — the connector, against a stubbed FabOrchestrator.
 *
 * This is the hop the whole architecture rests on: the browser never talks to
 * FabOrchestrator, this route does, and it holds the credential. The tests
 * below run the real route handler with `fetch` replaced, so they cover the
 * decisions the route actually makes rather than a re-description of them.
 *
 * The stub is deliberate: the plan requires the suite to run from a clean
 * checkout **with no network**, because a test that needs a live FO tells you
 * nothing on the day FO is down.
 *
 * What is asserted, in the order a request meets it:
 *   an unknown agent is rejected before any outbound call is made
 *   no PWA session          -> 401, and FO is never contacted
 *   no FO cookie            -> no_faborch_session
 *   FO 401                  -> faborch_session_expired AND the cookie is dropped
 *   FO 403 / 429 / 500      -> FO's own words reach the screen, as a string
 *   FO 200                  -> the body streams through unbuffered
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Set before anything reads it. Both modules below read `process.env` lazily,
// inside the functions that need it, so plain imports are safe here.
process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { POST } from "@/app/api/faborch/[agent]/chat/route";

const FO_TOKEN = "fo-token-not-real";

// Minted against FO_TOKEN, because the session is only valid beside the
// FabOrchestrator cookie it was issued with — see lib/auth-middleware.ts.
const PWA_TOKEN = sessionFor(
  {
    id: "u1",
    email: "supervisor@athenatech.example",
    name: "A. Supervisor",
    roleName: "Supervisor",
  },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
).token;

/** Every outbound call the route made during a test. */
let calls: { url: string; init: RequestInit }[] = [];
const realFetch = globalThis.fetch;

/** Replace fetch with a stub FabOrchestrator that answers however a test says. */
function stubFo(handler: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

const sse = (frames: string[], extraHeaders: Record<string, string> = {}) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream", ...extraHeaders },
    },
  );

const request = (opts: { auth?: boolean; foCookie?: boolean; body?: unknown } = {}) => {
  const { auth = true, foCookie = true, body } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${PWA_TOKEN}`;
  if (foCookie) headers.cookie = `${FO_TOKEN_COOKIE}=${FO_TOKEN}`;
  return new NextRequest("https://pwa.test/api/faborch/insight/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(
      body ?? { messages: [{ role: "user", parts: [{ type: "text", text: "yield?" }] }] },
    ),
  });
};

const call = (req: NextRequest, agent = "insight") =>
  POST(req, { params: Promise.resolve({ agent }) });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the request never reaches FabOrchestrator unless it should", () => {
  test("an unknown agent is a 404 and makes no outbound call", async () => {
    stubFo(() => sse([]));
    const res = await call(request(), "../../etc/passwd");
    assert.equal(res.status, 404);
    assert.equal(calls.length, 0, "an unrecognised segment must not select a URL");
  });

  test("an agent segment that is a real FO path but not an agent is still 404", async () => {
    stubFo(() => sse([]));
    assert.equal((await call(request(), "chat")).status, 404);
    assert.equal(calls.length, 0);
  });

  test("no PWA session is 401 before FabOrchestrator is contacted", async () => {
    stubFo(() => sse([]));
    const res = await call(request({ auth: false }));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  test("a session without its FabOrchestrator cookie is rejected outright", async () => {
    // The session is bound to the FO token it was minted with, so losing the
    // cookie — which is what sign-out does — invalidates the bearer token too.
    // It never reaches the route's own `no_faborch_session` branch.
    stubFo(() => sse([]));
    const res = await call(request({ foCookie: false }));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "and FabOrchestrator is never contacted");
  });

  test("a session presented with somebody else's FO cookie is rejected", async () => {
    stubFo(() => sse([]));
    const req = new NextRequest("https://pwa.test/api/faborch/insight/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PWA_TOKEN}`,
        cookie: `${FO_TOKEN_COOKIE}=a-different-fo-token`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    const res = await call(req);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  test("a malformed body is rejected without calling FO", async () => {
    stubFo(() => sse([]));
    const res = await call(request({ body: { messages: "not an array" } }));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});

describe("the credential stays server-side", () => {
  test("the FO token is sent to FO and never returned to the caller", async () => {
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([{ id: "m1", status: "connected" }])
        : sse([`data: ${JSON.stringify({ type: "text-delta", delta: "94%" })}\n\n`]),
    );
    const res = await call(request());
    assert.equal(res.status, 200);

    const chatCall = calls.find((c) => c.url.includes("/api/chat"))!;
    const sent = new Headers(chatCall.init.headers as HeadersInit);
    assert.equal(sent.get("Authorization"), `Bearer ${FO_TOKEN}`);

    // and nothing in the response carries it back out
    assert.ok(!(res.headers.get("set-cookie") ?? "").includes(FO_TOKEN));
    const text = await res.text();
    assert.ok(!text.includes(FO_TOKEN), "the FO token must not appear in the response body");
  });

  test("the caller's own bearer token is not forwarded to FabOrchestrator", async () => {
    stubFo((url) =>
      url.includes("/api/mcp/connections") ? Response.json([]) : sse([]),
    );
    await call(request());
    for (const c of calls) {
      const h = new Headers(c.init.headers as HeadersInit);
      assert.ok(!(h.get("Authorization") ?? "").includes(PWA_TOKEN));
    }
  });
});

describe("FabOrchestrator's failures arrive as something a person can act on", () => {
  test("401 clears the cookie and asks for a fresh sign-in", async () => {
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([])
        : new Response("", { status: 401 }),
    );
    const res = await call(request());
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "faborch_session_expired");
    // the idle-eviction recovery: the cookie must go, or every retry fails the
    // same way and the operator can never get back in
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`${FO_TOKEN_COOKIE}=;`));
    assert.match(setCookie, /Max-Age=0/i);
  });

  test("the nested error envelope becomes a string, not [object Object]", async () => {
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([])
        : Response.json(
            {
              error: {
                errorId: "e-9",
                type: "LAMBDA_MCP_CRASH",
                priority: "HIGH",
                message: "The data connection did not respond.",
              },
            },
            { status: 500 },
          ),
    );
    const res = await call(request());
    const body = (await res.json()) as { error: string; errorId?: string };
    assert.equal(typeof body.error, "string");
    assert.ok(!body.error.includes("[object Object]"), body.error);
    assert.match(body.error, /did not respond/);

    // The id moved out of the sentence and into its own field (WP10). It is
    // still support's only handle into `error_audit_logs`, so losing it is
    // still the failure this assertion guards — but the screen can now show it
    // as something to copy rather than buried in prose a supervisor would have
    // to transcribe by eye.
    assert.equal(body.errorId, "e-9", "the errorId is support's only handle; keep it");
    assert.ok(
      !body.error.includes("errorId="),
      "and it should not also be left inside the message",
    );
  });

  test("a 403 relays FabOrchestrator’s own permission wording", async () => {
    // No agent this app exposes is permission-gated any more — the Master Data
    // Load Agent was the only one and left on 2 September. The relay is still
    // the behaviour under test: what FO refuses with is FO’s to word, and a
    // message naming the permission an administrator must grant is the only
    // useful thing in the response.
    const message = "This model is not enabled for your role.";
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([])
        : Response.json({ error: message }, { status: 403 }),
    );
    const body = (await (await call(request())).json()) as { error: string };
    assert.equal(body.error, message);
  });

  test("a 429 is relayed as 429, so the screen can say 'wait', not 'broken'", async () => {
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([])
        : Response.json({ error: "Daily limit reached" }, { status: 429 }),
    );
    assert.equal((await call(request())).status, 429);
  });

  test("FO being unreachable reads as unavailable, not as a bad password", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await call(request());
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "faborch_unavailable");
    assert.match(body.error, /Could not reach FabOrchestrator/);
  });
});

describe("a good answer streams through", () => {
  test("the body is piped, and the no-buffering headers are set", async () => {
    const frames = [
      `data: ${JSON.stringify({ type: "text-delta", delta: "Yield " })}\n\n`,
      `data: ${JSON.stringify({ type: "text-delta", delta: "is 94%." })}\n\n`,
      "data: [DONE]\n\n",
    ];
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([{ id: "m1", status: "connected" }])
        : sse(frames),
    );
    const res = await call(request());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Accel-Buffering"), "no");
    assert.match(res.headers.get("Cache-Control") ?? "", /no-cache/);
    assert.equal(await res.text(), frames.join(""));
  });

  test("FabOrchestrator's route header is forwarded, so a turn can be told apart", async () => {
    // The platform decides, before it calls the model, whether a turn is served
    // by a deterministic metric brief, a curated dashboard, or the ordinary
    // tool-using path. The answer's prose never says which. This header does,
    // and it is the only way to tell afterwards whether an answer was grounded.
    const frames = [`data: ${JSON.stringify({ type: "text-delta", delta: "94.2%" })}

`];
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([{ id: "m1", status: "connected" }])
        : sse(frames, { "X-FabOrch-Route": "metric" }),
    );
    const res = await call(request());
    assert.equal(res.headers.get("X-FabOrch-Route"), "metric");
  });

  test("the operator's data-connection count is reported to the screen", async () => {
    // WP8's line was "refuse to send a turn with an empty tool list". Measured
    // against the live platform, that is wrong: with an empty list
    // FabOrchestrator still answers yield/scrap/OEE from real plant data,
    // because its metric path reads the warehouse directly and never touches
    // MCP. So the count is REPORTED and the screen says which half is missing,
    // rather than the proxy withholding an answer that would have worked.
    const frames = [`data: ${JSON.stringify({ type: "text-delta", delta: "94%" })}

`];
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([
            { id: "m1", status: "connected" },
            { id: "m2", status: "connected" },
            { id: "m3", status: "disconnected" },
          ])
        : sse(frames),
    );
    const res = await call(request());
    assert.equal(res.headers.get("X-FabOrch-Data-Connections"), "2");
  });

  test("zero connections is reported as zero, and the turn still goes through", async () => {
    const frames = [`data: ${JSON.stringify({ type: "text-delta", delta: "yield is 94%" })}

`];
    stubFo((url) =>
      url.includes("/api/mcp/connections") ? Response.json([]) : sse(frames),
    );
    const res = await call(request());
    assert.equal(res.status, 200, "an empty list must not withhold the answer");
    assert.equal(res.headers.get("X-FabOrch-Data-Connections"), "0");
    assert.equal(await res.text(), frames.join(""));
  });

  test("its absence is not invented — an older platform simply omits it", async () => {
    const frames = [`data: ${JSON.stringify({ type: "text-delta", delta: "hello" })}

`];
    stubFo((url) =>
      url.includes("/api/mcp/connections") ? Response.json([]) : sse(frames),
    );
    const res = await call(request());
    assert.equal(res.headers.get("X-FabOrch-Route"), null);
  });

  test("only connected data connections are forwarded", async () => {
    stubFo((url) =>
      url.includes("/api/mcp/connections")
        ? Response.json([
            { id: "up", status: "connected" },
            { id: "down", status: "error" },
          ])
        : sse([]),
    );
    await call(request());
    const chat = calls.find((c) => c.url.includes("/api/chat"))!;
    const sent = JSON.parse(String(chat.init.body)) as { activeMcpIds?: string[] };
    assert.deepEqual(sent.activeMcpIds, ["up"]);
  });

  test("the client cannot choose its own model or data connections", async () => {
    stubFo((url) =>
      url.includes("/api/mcp/connections") ? Response.json([]) : sse([]),
    );
    await call(
      request({
        body: {
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
          model: "attacker-chosen-model",
          activeMcpIds: ["someone-elses-connection"],
        },
      }),
    );
    const chat = calls.find((c) => c.url.includes("/api/chat"))!;
    const sent = JSON.parse(String(chat.init.body)) as {
      model?: string;
      activeMcpIds?: string[];
    };
    assert.notEqual(sent.model, "attacker-chosen-model");
    assert.ok(!(sent.activeMcpIds ?? []).includes("someone-elses-connection"));
  });
});
