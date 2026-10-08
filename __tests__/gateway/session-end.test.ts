/**
 * The gateway ending a session (plan RP2, finding G5), driven through the real
 * route handler against a stubbed FabOrchestrator.
 *
 * When a bearer is a real session that has ended — expired — **and the cookie
 * beside it is that session's own**, the gateway answers 401 `session_invalid`
 * at once with the cookie cleared, and revokes the cookie's FabOrchestrator
 * token after the response. Clearing alone would not do: the client's
 * follow-up sign-out then arrives with no cookie and cannot revoke, and
 * FabOrchestrator keeps the session until its own 30-day expiry.
 *
 * Every other refusal leaves the cookie alone. A malformed bearer may be a
 * stray header. A bearer beside a cookie that is not its own — expired or
 * still valid — is a tab left open across a re-sign-in in another tab
 * (FabOrchestrator's chat keeps the bearer it loaded with): the cookie is the
 * *new* session's, and until 30 September 2026 this route revoked it (review
 * of c193e9e, blocking issue 1). The assertion that matters: **after the stale
 * tab is refused, the new session still works.**
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { resetRecentRevokes } from "@/lib/faborch/end-session";
import { PASSWORD_CHANGED_COOKIE, passwordMarkFor } from "@/lib/faborch/password-mark";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { GET, POST } from "@/app/fo-gateway/[...path]/route";
import { seatStoreOwning, TEST_SEAT } from "./seat-fixture";

seatStoreOwning();

const FO_TOKEN = "fo-session-not-a-real-token";
const USER = { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" };
const LIVE = sessionFor(USER, new Date(Date.now() + 864e5).toISOString(), FO_TOKEN, undefined, TEST_SEAT).token;
const EXPIRED = sessionFor(USER, new Date(Date.now() - 1000).toISOString(), FO_TOKEN, undefined, TEST_SEAT).token;
/** Session A, from an earlier sign-in on the same browser: its own FO token is not the cookie's. */
const OLD_FO_TOKEN = "a-different-fo-token";
const SOMEBODY_ELSES = sessionFor(USER, new Date(Date.now() + 864e5).toISOString(), OLD_FO_TOKEN, undefined, TEST_SEAT).token;
const OLD_AND_EXPIRED = sessionFor(USER, new Date(Date.now() - 1000).toISOString(), OLD_FO_TOKEN, undefined, TEST_SEAT).token;

const realFetch = globalThis.fetch;
const realInfo = console.info;
let seen: { method: string; path: string; bearer: string | null }[] = [];
let info: string[] = [];

function stubFo(
  // `/api/conversations` is the path these tests call, and the gateway reads
  // that answer as a list (`lib/gateway/seats.ts`): an empty one by default.
  answer: (path: string, method: string) => Response = (path) =>
    path === "/api/conversations" ? Response.json([]) : Response.json({ ok: true }),
) {
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
  test("an expired bearer beside its own cookie: 401 at once, the cookie cleared, FabOrchestrator's token revoked after", async () => {
    stubFo();
    const res = await call("GET", "/api/conversations", {
      authorization: `Bearer ${EXPIRED}`,
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

  // The stale tab (review of c193e9e, blocking issue 1). Session A was signed
  // in first; a re-sign-in in another tab replaced the cookie with session B's
  // and wrote bearer B to localStorage; a FabOrchestrator page loaded under A
  // still sends bearer A. The cookie is B's, and B must survive.
  for (const [label, staleBearer] of [
    ["an expired bearer A beside the newer cookie B", OLD_AND_EXPIRED],
    ["a still-valid bearer A beside the newer cookie B", SOMEBODY_ELSES],
  ] as const) {
    test(`${label}: 401, cookie B kept, FO session B not revoked, and B still works afterwards`, async () => {
      stubFo();
      const stale = await call("GET", "/api/conversations", {
        authorization: `Bearer ${staleBearer}`,
        cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
      });
      assert.equal(stale.status, 401);
      assert.equal(((await stale.json()) as { code: string }).code, "session_invalid");
      assert.equal(stale.headers.get("set-cookie"), null, "cookie B is not cleared");
      await settle();
      assert.deepEqual(seen, [], "nothing forwarded, and no revoke of B (or of anything)");
      assert.ok(!info.some((l) => l.includes('"event":"session_end"')), "no session ended");

      // Tab B, the session that was signed in last, carries on.
      const fresh = await call("GET", "/api/conversations", {
        authorization: `Bearer ${LIVE}`,
        cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
      });
      assert.equal(fresh.status, 200);
      assert.equal(fresh.headers.get("set-cookie"), null);
      await fresh.text();
      assert.deepEqual(seen, [{ method: "GET", path: "/api/conversations", bearer: `Bearer ${FO_TOKEN}` }]);
    });
  }

  test("an expired bearer with no cookie at all: 401 and nothing to end", async () => {
    stubFo();
    const res = await call("GET", "/api/conversations", { authorization: `Bearer ${EXPIRED}` });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    await settle();
    assert.deepEqual(seen, []);
  });

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
