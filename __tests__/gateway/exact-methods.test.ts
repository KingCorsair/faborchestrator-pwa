/**
 * FabOrchestrator routes admitted at one exact path, for particular methods
 * only (`FO_API_EXACT_METHODS`, 13 October 2026): the four its newer build's
 * pages call. Anything else about them stays as closed as before: a sub-path,
 * another method, an anonymous body, or a neighbouring route nobody admitted.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { classify, FO_API_EXACT_METHODS, FO_API_PREFIXES, foMethodAllowed, GATEWAY_MARKER_HEADER, readRegistry } from "@/lib/gateway/registry";
import { DELETE, GET, POST, PUT } from "@/app/fo-gateway/[...path]/route";

const WHOLE = readRegistry({ FO_EMBED_MODE: "whole" });
const HANDLERS = { GET, POST, PUT, DELETE } as const;
type Method = keyof typeof HANDLERS;

describe("the registry admits the newer routes narrowly", () => {
  test("exactly five paths, each with only the methods its page uses", () => {
    assert.deepEqual(FO_API_EXACT_METHODS, {
      "/api/mcp/health": ["GET", "POST"],
      "/api/mcp/access": ["GET"],
      "/api/platform-notice": ["GET"],
      "/api/client-log": ["POST"],
      "/api/fabinsight/pin-requests": ["POST"],
    });
    for (const path of Object.keys(FO_API_EXACT_METHODS)) {
      assert.equal(classify(path, WHOLE), "fo-api", path);
      // Not also admitted by a prefix, which would let every method through.
      assert.ok(!FO_API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)), `${path} is not under a prefix`);
    }
  });

  test("an exact path has no sub-paths, and its neighbours are still unknown", () => {
    for (const path of [
      "/api/mcp/health/anything",
      "/api/mcp/access/users",
      "/api/platform-notice/edit",
      "/api/client-log/dump",
      "/api/mcp",
      "/api/mcp/servers",
      "/api/fabinsight/pin-requests/abc",
      "/api/fabinsight/pin-requests/abc/approve",
      "/api/admin/dashboards/bulk-delete",
    ]) {
      assert.equal(classify(path, WHOLE), "unknown", path);
    }
  });

  test("methods: listed ones only for these paths; every other path is unchanged", () => {
    assert.equal(foMethodAllowed("/api/mcp/health", "GET"), true);
    assert.equal(foMethodAllowed("/api/mcp/health", "post"), true);
    assert.equal(foMethodAllowed("/api/mcp/health", "DELETE"), false);
    assert.equal(foMethodAllowed("/api/mcp/access", "GET"), true);
    assert.equal(foMethodAllowed("/api/mcp/access", "POST"), false);
    assert.equal(foMethodAllowed("/api/mcp/access", "PUT"), false);
    assert.equal(foMethodAllowed("/api/platform-notice", "POST"), false);
    assert.equal(foMethodAllowed("/api/client-log", "GET"), false);
    assert.equal(foMethodAllowed("/api/fabinsight/pin-requests", "POST"), true);
    assert.equal(foMethodAllowed("/api/fabinsight/pin-requests", "GET"), false);
    assert.equal(foMethodAllowed("/api/fabinsight/pin-requests", "DELETE"), false);
    // Paths governed by the prefix lists are not this function's business.
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(foMethodAllowed("/api/conversations/abc", method), true);
      assert.equal(foMethodAllowed("/home", method), true);
    }
    // An object's own built-in names are not routes.
    assert.equal(foMethodAllowed("constructor", "GET"), true);
    assert.equal(classify("/api/constructor", WHOLE), "unknown");
  });

  test("the credential routes stay denied, and the mode does not open the API", () => {
    for (const path of ["/api/auth/login", "/api/auth/register", "/api/fabinsight/schema", "/api/artifacts/x"]) {
      assert.equal(classify(path, WHOLE), "denied", path);
    }
    assert.equal(classify("/api/something-new", WHOLE), "unknown");
  });
});

describe("the gateway forwards them for those methods only", () => {
  const FO_TOKEN = "fo-session-not-a-real-token";
  const PWA_TOKEN = sessionFor(
    { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
    new Date(Date.now() + 864e5).toISOString(),
    FO_TOKEN,
  ).token;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  let forwarded: { method: string; path: string; authorization: string | null }[] = [];
  let warned: string[] = [];
  /** Read through a call, so an earlier "nothing forwarded" assertion does not narrow the type. */
  const sent = () => forwarded;

  beforeEach(() => {
    forwarded = [];
    warned = [];
    console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      forwarded.push({
        method: (init.method ?? "GET").toUpperCase(),
        path: new URL(String(input)).pathname,
        authorization: new Headers(init.headers).get("authorization"),
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  });

  const call = (method: Method, path: string, opts: { signedIn?: boolean; body?: string } = {}) =>
    HANDLERS[method](
      new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
        method,
        headers: {
          [GATEWAY_MARKER_HEADER]: "1",
          ...(opts.signedIn === false ? {} : { authorization: `Bearer ${PWA_TOKEN}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }),
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: opts.body,
      }),
      { params: Promise.resolve({ path: path.slice(1).split("/") }) },
    );

  test("a signed-in page's calls reach FabOrchestrator with its own token, never this app's", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/mcp/health", undefined],
      ["POST", "/api/mcp/health", "{}"],
      ["GET", "/api/mcp/access", undefined],
      ["GET", "/api/platform-notice", undefined],
      ["POST", "/api/client-log", '{"level":"error","message":"x"}'],
      ["POST", "/api/fabinsight/pin-requests", '{"title":"Top lots","type":"static"}'],
    ] as const) {
      const res = await call(method, path, { body });
      assert.equal(res.status, 200, `${method} ${path}`);
      await res.text();
    }
    assert.deepEqual(
      forwarded.map((f) => `${f.method} ${f.path}`),
      [
        "GET /api/mcp/health",
        "POST /api/mcp/health",
        "GET /api/mcp/access",
        "GET /api/platform-notice",
        "POST /api/client-log",
        "POST /api/fabinsight/pin-requests",
      ],
    );
    for (const f of forwarded) assert.equal(f.authorization, `Bearer ${FO_TOKEN}`, `${f.method} ${f.path}`);
  });

  test("a method that is not listed is a coded 405, and FabOrchestrator never sees it", async () => {
    for (const [method, path] of [
      ["POST", "/api/mcp/access"],
      ["PUT", "/api/mcp/access"],
      ["DELETE", "/api/mcp/health"],
      ["POST", "/api/platform-notice"],
      ["DELETE", "/api/platform-notice"],
      ["GET", "/api/client-log"],
      ["PUT", "/api/client-log"],
      ["GET", "/api/fabinsight/pin-requests"],
      ["DELETE", "/api/fabinsight/pin-requests"],
    ] as const) {
      const res = await call(method, path, { body: method === "GET" || method === "DELETE" ? undefined : "{}" });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(((await res.json()) as { code: string }).code, "method_not_allowed");
    }
    assert.deepEqual(forwarded, [], "nothing forwarded");
    assert.ok(warned.some((l) => l.includes('"reason":"method_not_allowed"')), warned.join("\n"));
  });

  test("a sub-path or an unadmitted neighbour is not found here, and not forwarded", async () => {
    for (const path of ["/api/mcp/access/users", "/api/mcp/health/x", "/api/fabinsight/pin-requests/abc", "/api/mcp/servers"]) {
      const res = await call("GET", path);
      assert.equal(res.status, 404, path);
      await res.text();
    }
    assert.deepEqual(forwarded, []);
  });

  test("without a session: a write is refused by the gateway, and a read carries no token", async () => {
    for (const path of ["/api/mcp/health", "/api/client-log", "/api/fabinsight/pin-requests"]) {
      const res = await call("POST", path, { signedIn: false, body: "{}" });
      assert.equal(res.status, 401, path);
      await res.text();
    }
    assert.deepEqual(forwarded, [], "an anonymous body is never forwarded");

    // A read with no session is forwarded as it is, with no token attached:
    // FabOrchestrator answers its own 401 for the routes that need a user.
    for (const path of ["/api/mcp/access", "/api/mcp/health", "/api/platform-notice"]) {
      await (await call("GET", path, { signedIn: false })).text();
    }
    assert.deepEqual(sent().map((f) => f.authorization), [null, null, null]);
  });
});
