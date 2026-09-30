/**
 * The gateway ending a session (plan RP2, finding G5), driven through the real
 * route handler against a stubbed FabOrchestrator.
 *
 * When a bearer is a real session that has ended — expired, or paired with a
 * cookie that is not its own — the gateway answers 401 `session_invalid` at
 * once with the cookie cleared, and revokes the cookie's FabOrchestrator token
 * after the response. Clearing alone would not do: the client's follow-up
 * sign-out then arrives with no cookie and cannot revoke, and FabOrchestrator
 * keeps the session until its own 30-day expiry. A malformed bearer changes
 * nothing; it may be a stray header.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { resetRecentRevokes } from "@/lib/faborch/end-session";
import { PASSWORD_CHANGED_COOKIE, passwordMarkFor } from "@/lib/faborch/password-mark";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { GET, POST } from "@/app/fo-gateway/[...path]/route";

const FO_TOKEN = "fo-session-not-a-real-token";
const USER = { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" };
const LIVE = sessionFor(USER, new Date(Date.now() + 864e5).toISOString(), FO_TOKEN).token;
const EXPIRED = sessionFor(USER, new Date(Date.now() - 1000).toISOString(), FO_TOKEN).token;
const SOMEBODY_ELSES = sessionFor(USER, new Date(Date.now() + 864e5).toISOString(), "a-different-fo-token").token;

const realFetch = globalThis.fetch;
const realInfo = console.info;
let seen: { method: string; path: string; bearer: string | null }[] = [];
let info: string[] = [];

function stubFo(answer: (path: string, method: string) => Response = () => Response.json({ ok: true })) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const method = (init.method ?? "GET").toUpperCase();
    seen.push({ method, path, bearer: new Headers(init.headers).get("authorization") });
    return answer(path, method);
  }) as typeof fetch;
}

function call(method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown) {
  const req = new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
    method,
    headers: {
      [GATEWAY_MARKER_HEADER]: "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const handler = method === "GET" ? GET : POST;
  return handler(req, { params: Promise.resolve({ path: path.slice(1).split("/") }) });
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  seen = [];
  info = [];
  resetRecentRevokes();
  console.info = (...args: unknown[]) => {
    info.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.info = realInfo;
});

describe("a session that has ended is ended here too (G5)", () => {
  for (const [label, bearer] of [
    ["an expired bearer beside its cookie", EXPIRED],
    ["a bearer beside a cookie that is not its own", SOMEBODY_ELSES],
  ] as const) {
    test(`${label}: 401 at once, the cookie cleared, FabOrchestrator's token revoked after`, async () => {
      stubFo();
      const res = await call("GET", "/api/conversations", {
        authorization: `Bearer ${bearer}`,
        cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
      });
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { code: string }).code, "session_invalid");
      assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`${FO_TOKEN_COOKIE}=;`));
      assert.ok(!seen.some((c) => c.path === "/api/conversations"), "the request itself is never forwarded");

      await settle();
      const revoke = seen.find((c) => c.path === "/api/auth/logout");
      assert.ok(revoke, "FabOrchestrator must be told, or the session row lives for 30 days");
      assert.equal(revoke!.bearer, `Bearer ${FO_TOKEN}`);
      const end = info.find((l) => l.includes('"event":"session_end"'));
      assert.ok(end && end.includes('"reason":"gateway_refusal"'), info.join("\n"));
      assert.ok(!info.join("\n").includes(FO_TOKEN), "never the token itself");
    });
  }

  test("several calls refused at once revoke once", async () => {
    stubFo();
    const refused = () =>
      call("GET", "/api/conversations", { authorization: `Bearer ${EXPIRED}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` });
    const answers = await Promise.all([refused(), refused(), refused()]);
    assert.deepEqual(answers.map((r) => r.status), [401, 401, 401]);
    await settle();
    assert.equal(seen.filter((c) => c.path === "/api/auth/logout").length, 1);
  });

  test("unusable signing keys: 503 not_configured, never a bare 500", async () => {
    stubFo();
    const saved = process.env.SESSION_SIGNING_KEY_ID;
    const realError = console.error;
    console.error = () => {};
    delete process.env.SESSION_SIGNING_KEY_ID;
    try {
      const res = await call("GET", "/api/conversations", {
        authorization: `Bearer ${LIVE}`,
        cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
      });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, "not_configured");
      assert.deepEqual(seen, [], "nothing is forwarded without a session that can be checked");
    } finally {
      process.env.SESSION_SIGNING_KEY_ID = saved;
      console.error = realError;
    }
  });

  test("a malformed bearer: 401, and nothing else changes", async () => {
    stubFo();
    const res = await call("GET", "/api/conversations", {
      authorization: "Bearer nonsense",
      cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, "session_invalid");
    assert.equal(res.headers.get("set-cookie"), null, "the cookie is left alone");
    await settle();
    assert.deepEqual(seen, [], "FabOrchestrator is not called at all");
  });

  test("every refusal reads the same, whichever check failed", async () => {
    stubFo();
    const bodies = new Set<string>();
    const refusals: Record<string, string>[] = [
      { authorization: "Bearer nonsense", cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` },
      { authorization: `Bearer ${EXPIRED}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` },
      { authorization: `Bearer ${LIVE}` },
    ];
    for (const headers of refusals) {
      bodies.add(await (await call("GET", "/api/conversations", headers)).text());
    }
    assert.equal(bodies.size, 1, [...bodies].join(" | "));
  });

  test("a live session is forwarded with the real token, and keeps its cookie", async () => {
    stubFo();
    const res = await call("GET", "/api/conversations", {
      authorization: `Bearer ${LIVE}`,
      cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("set-cookie"), null);
    await res.text();
    assert.deepEqual(seen, [{ method: "GET", path: "/api/conversations", bearer: `Bearer ${FO_TOKEN}` }]);
  });
});

describe("a password change FabOrchestrator accepted is remembered on this browser (G20)", () => {
  const signedIn = { authorization: `Bearer ${LIVE}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` };

  test("a successful change marks the browser, for that user only", async () => {
    stubFo(() => Response.json({ success: true }));
    const res = await call("POST", "/api/auth/change-password", signedIn, { currentPassword: "a", newPassword: "b" });
    assert.equal(res.status, 200);
    const line = res.headers.get("set-cookie") ?? "";
    assert.ok(line.includes(`${PASSWORD_CHANGED_COOKIE}=${passwordMarkFor("u1")}`), line);
    assert.notEqual(passwordMarkFor("u1"), passwordMarkFor("u2"), "another user's mark differs");
    assert.match(line, /HttpOnly/i);
    await res.text();
  });

  test("a refused change marks nothing", async () => {
    stubFo(() => Response.json({ error: "Current password is incorrect" }, { status: 400 }));
    const res = await call("POST", "/api/auth/change-password", signedIn, { currentPassword: "a", newPassword: "b" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("set-cookie"), null);
    await res.text();
  });
});
