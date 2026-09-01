/**
 * WP2 — FabOrchestrator is the only identity.
 *
 * Until 2026-09-01 this route tried a local `DEMO_USER_*` pair first. It
 * authenticated with no network call and minted a session carrying **no FO
 * token**, so the operator reached the app, opened an agent, and found the
 * composer disabled. These tests exist so that credential cannot come back by
 * accident: the environment variables are set here deliberately, and the route
 * must still refuse them.
 *
 * The stub FabOrchestrator keeps the suite runnable from a clean checkout with
 * no network, which is WP11's rule for every layer below the live smoke test.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";

import { NextRequest } from "next/server";
import { sessionFor, verifyToken } from "@/lib/auth";
import { POST } from "@/app/api/auth/login/route";

const realFetch = globalThis.fetch;
let calls: string[] = [];

function stubFo(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
}

const FO_OK = (expiresAt: string) =>
  Response.json({
    token: "fo-session-token",
    expiresAt,
    user: { id: "fo-user-1", email: "operator@plant.example", name: "A. Operator" },
  });

/** A fresh address each time, so the shared rate limiter cannot bleed between tests. */
let n = 0;
const login = (email: string, password: string) => {
  n += 1;
  return POST(
    new NextRequest("https://pwa.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "fly-client-ip": `10.0.0.${n}` },
      body: JSON.stringify({ email, password }),
    }),
  );
};

beforeEach(() => {
  calls = [];
  process.env.FABORCH_BASE_URL = "https://fo.test";
  // Deliberately present. The point of the suite is that they do nothing.
  process.env.DEMO_USER_EMAIL = "supervisor@athenatech.example";
  process.env.DEMO_USER_PASSWORD = "the-old-demo-password";
  process.env.DEMO_USER_NAME = "A. Supervisor";
  process.env.DEMO_USER_ROLE = "Supervisor";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the demo credential is gone", () => {
  test("DEMO_USER_EMAIL/PASSWORD are forwarded to FabOrchestrator like any other input", async () => {
    stubFo(() => new Response("", { status: 401 }));
    const res = await login(process.env.DEMO_USER_EMAIL!, process.env.DEMO_USER_PASSWORD!);

    assert.equal(res.status, 401, "the old demo pair must not authenticate locally");
    assert.ok(
      calls.some((u) => u.includes("/api/auth/login")),
      "it must be checked by FabOrchestrator, not by this app",
    );
  });

  test("no session is minted for the demo pair", async () => {
    stubFo(() => new Response("", { status: 401 }));
    const res = await login(process.env.DEMO_USER_EMAIL!, process.env.DEMO_USER_PASSWORD!);
    const body = (await res.json()) as { token?: string; faborch?: boolean };
    assert.equal(body.token, undefined);
    assert.notEqual(body.faborch, true);
  });

  test("a `faborch: false` session can no longer be produced at all", async () => {
    stubFo(() => FO_OK(new Date(Date.now() + 864e5).toISOString()));
    const res = await login("operator@plant.example", "correct-horse");
    const body = (await res.json()) as { faborch?: boolean };
    assert.equal(res.status, 200);
    assert.equal(body.faborch, true, "every session this route issues is backed by an FO token");
  });

  test("the FO cookie is set on the only successful path", async () => {
    stubFo(() => FO_OK(new Date(Date.now() + 864e5).toISOString()));
    const res = await login("operator@plant.example", "correct-horse");
    assert.match(res.headers.get("set-cookie") ?? "", /faborch_token=fo-session-token/);
  });
});

describe("without FabOrchestrator there is no way in", () => {
  test("an unset FABORCH_BASE_URL is 503, not a wrong-password 401", async () => {
    delete process.env.FABORCH_BASE_URL;
    stubFo(() => new Response("", { status: 500 }));
    const res = await login("anyone@plant.example", "anything");

    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not configured/i);
    assert.equal(calls.length, 0);
  });

  test("FO being unreachable is 503, so a correct password is never called wrong", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await login("operator@plant.example", "correct-horse");
    assert.equal(res.status, 503);
  });

  test("FO rejecting the password is 401", async () => {
    stubFo(() => new Response("", { status: 401 }));
    assert.equal((await login("operator@plant.example", "wrong")).status, 401);
  });
});

describe("the two expiry clocks are reconciled", () => {
  test("the PWA session never outlives FabOrchestrator's own expiry", async () => {
    // FO expires in 5 minutes; the PWA's own TTL is hours.
    const foExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
    stubFo(() => FO_OK(foExpiry));

    const res = await login("operator@plant.example", "correct-horse");
    const body = (await res.json()) as { expiresAt: string };
    assert.ok(
      new Date(body.expiresAt).getTime() <= new Date(foExpiry).getTime(),
      `session expiry ${body.expiresAt} must not exceed FO's ${foExpiry}`,
    );
  });

  test("a far-future FO expiry does not extend the PWA session past its own TTL", async () => {
    const far = new Date(Date.now() + 365 * 864e5).toISOString();
    stubFo(() => FO_OK(far));
    const res = await login("operator@plant.example", "correct-horse");
    const body = (await res.json()) as { expiresAt: string };
    assert.ok(new Date(body.expiresAt).getTime() < new Date(far).getTime());
  });

  test("sessionFor caps at the earlier clock", () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const s = sessionFor(
      { id: "u", email: "e@x.y", name: "N", roleName: "Supervisor" },
      soon,
    );
    assert.equal(s.expiresAt, soon);
    assert.ok(verifyToken(s.token), "a capped session is still a valid one");
  });

  test("an unparseable FO expiry is ignored rather than minting a dead session", () => {
    const s = sessionFor({ id: "u", email: "e@x.y", name: "N", roleName: "Supervisor" }, "nonsense");
    assert.ok(new Date(s.expiresAt).getTime() > Date.now(), "must not be already expired");
    assert.ok(verifyToken(s.token));
  });
});
