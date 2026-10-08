/**
 * FabOrchestrator's approved-device pages and APIs pass through this app
 * (`lib/gateway/registry.ts`): its `/device-enroll` page opens without a
 * session, and its QR code request is the one API body taken without a session.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { classify, FO_ANONYMOUS_BODY_PATHS, GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { GET, POST } from "@/app/fo-gateway/[...path]/route";
import { proxy } from "@/proxy";
import { TEST_SEAT } from "./seat-fixture";

const FO_TOKEN = "fo-session-not-a-real-token";
const PWA_TOKEN = sessionFor(
  { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
  undefined,
  TEST_SEAT,
).token;

let seen: { method: string; path: string; bearer: string | null; body: string }[] = [];
const realFetch = globalThis.fetch;
const realInfo = console.info;
const realWarn = console.warn;
beforeEach(() => {
  seen = [];
  console.info = () => {};
  console.warn = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = init.body ? new TextDecoder().decode(init.body as Uint8Array) : "";
    seen.push({
      method: (init.method ?? "GET").toUpperCase(),
      path: new URL(String(input)).pathname,
      bearer: new Headers(init.headers).get("authorization"),
      body,
    });
    return Response.json({ ok: true });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.info = realInfo;
  console.warn = realWarn;
});

const call = (handler: typeof GET, method: string, path: string, opts: { signedIn?: boolean; body?: string } = {}) =>
  handler(
    new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
      method,
      headers: {
        [GATEWAY_MARKER_HEADER]: "1",
        "content-type": "application/json",
        ...(opts.signedIn ? { authorization: `Bearer ${PWA_TOKEN}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` } : {}),
      },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    }),
    { params: Promise.resolve({ path: path.slice(1).split("/") }) },
  );

describe("which owner", () => {
  test("FabOrchestrator's device APIs are forwarded, and its enroll page is FabOrchestrator's", () => {
    for (const p of ["/api/auth/device-challenge", "/api/auth/device-enroll", "/api/admin/devices", "/api/admin/devices/x/revoke", "/api/admin/devices/approval"]) {
      assert.equal(classify(p), "fo-api", p);
    }
    assert.equal(classify("/device-enroll"), "fo-document");
    // The rest of FabOrchestrator's admin API stays closed.
    assert.equal(classify("/api/admin/users"), "unknown");
    assert.deepEqual([...FO_ANONYMOUS_BODY_PATHS], ["/api/auth/device-enroll"]);
  });

  test("the enroll page opens without a session: no bounce to sign-in", () => {
    const res = proxy(new NextRequest(new URL("https://pwa.test/device-enroll")));
    assert.equal(res.headers.get("location"), null);
    assert.ok(res.headers.get("x-middleware-rewrite")?.includes("/fo-gateway/device-enroll"));
  });
});

describe("bodies without a session", () => {
  test("a phone using a device QR code reaches FabOrchestrator, with no token", async () => {
    const res = await call(POST, "POST", "/api/auth/device-enroll", { body: '{"code":"x"}' });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.bearer, null);
    assert.equal(seen[0]!.body, '{"code":"x"}');
  });

  test("the sign-in challenge is forwarded to anybody", async () => {
    assert.equal((await call(GET, "GET", "/api/auth/device-challenge")).status, 200);
    assert.equal(seen[0]?.path, "/api/auth/device-challenge");
  });

  test("but only up to 16 KiB", async () => {
    const res = await call(POST, "POST", "/api/auth/device-enroll", { body: JSON.stringify({ code: "x".repeat(20_000) }) });
    assert.equal(res.status, 413);
    assert.equal(seen.length, 0);
  });

  test("any other API body without a session is still refused before FabOrchestrator is asked", async () => {
    const res = await call(POST, "POST", "/api/chat", { body: "{}" });
    assert.equal(res.status, 401);
    assert.equal(seen.length, 0);
  });

  test("signed in, the QR code request carries the session's FabOrchestrator token (an admin approving their own phone)", async () => {
    await call(POST, "POST", "/api/auth/device-enroll", { signedIn: true, body: "{}" });
    assert.equal(seen[0]?.bearer, `Bearer ${FO_TOKEN}`);
  });
});
