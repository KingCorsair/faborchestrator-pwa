/**
 * The two session additions of 2026-09-28, against a stubbed FabOrchestrator.
 *
 *   the real role — read from FO's own /api/auth/me at sign-in, and never
 *   allowed to fail a sign-in when that read does not answer
 *
 *   Stay signed in — one call to FO, on the operator's press, and an honest
 *   answer when FO has already ended the session
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";

import { NextRequest } from "next/server";
import { sessionFor, verifyToken } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { POST as LOGIN } from "@/app/api/auth/login/route";
import { POST as KEEP_ALIVE } from "@/app/api/auth/keep-alive/route";
import { GET as ME } from "@/app/api/auth/me/route";

const FO_TOKEN = "fo-session-token";
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

let calls: { path: string; auth: string | null }[] = [];

function stubFo(me: () => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const { pathname } = new URL(String(input));
    calls.push({ path: pathname, auth: new Headers(init.headers as HeadersInit).get("Authorization") });
    if (pathname === "/api/auth/login") {
      return Response.json({
        token: FO_TOKEN,
        expiresAt: new Date(Date.now() + 864e5).toISOString(),
        user: { id: "fo-user-1", email: "admin@plant.example", name: "A. Admin" },
      });
    }
    if (pathname === "/api/auth/me") return me();
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

let n = 0;
const signIn = () => {
  n += 1;
  return LOGIN(
    new NextRequest("https://pwa.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "fly-client-ip": `10.9.0.${n}` },
      body: JSON.stringify({ email: "admin@plant.example", password: "correct-horse" }),
    }),
  );
};

const pwaToken = sessionFor(
  { id: "u1", email: "s@plant.example", name: "S", roleName: "Supervisor" },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
).token;

const keepAlive = (opts: { auth?: boolean } = {}) =>
  KEEP_ALIVE(
    new NextRequest("https://pwa.test/api/auth/keep-alive", {
      method: "POST",
      headers: {
        ...(opts.auth === false ? {} : { Authorization: `Bearer ${pwaToken}` }),
        cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
      },
    }),
  );

beforeEach(() => {
  calls = [];
  process.env.FABORCH_BASE_URL = "https://fo.test";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.ERROR_ALERT_WEBHOOK_URL;
  console.error = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

describe("the operator's real role", () => {
  test("comes from FabOrchestrator's own /api/auth/me, not a label this app picks", async () => {
    stubFo(() => Response.json({ user: { role: { name: "Admin" } } }));
    const res = await signIn();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; user: { roleName: string } };
    assert.equal(body.user.roleName, "Admin");
    assert.equal(verifyToken(body.token)?.roleName, "Admin", "and it is what the session carries");

    const me = calls.find((c) => c.path === "/api/auth/me");
    assert.equal(me?.auth, `Bearer ${FO_TOKEN}`, "asked with the token FO just issued");
  });

  test("reaches the top bar through this app's /api/auth/me", async () => {
    stubFo(() => Response.json({ user: { role: { name: "Business User" } } }));
    const body = (await (await signIn()).json()) as { token: string };
    const res = await ME(
      new NextRequest("https://pwa.test/api/auth/me", {
        headers: { Authorization: `Bearer ${body.token}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` },
      }),
    );
    const me = (await res.json()) as { user: { role: { name: string } } };
    assert.equal(me.user.role.name, "Business User");
  });

  test("a role lookup that fails does not fail the sign-in", async () => {
    stubFo(() => new Response("", { status: 500 }));
    const res = await signIn();
    assert.equal(res.status, 200, "a label is not worth locking somebody out over");
    const body = (await res.json()) as { user: { roleName: string } };
    assert.equal(body.user.roleName, "Signed in", "neutral, rather than a role nobody has");
  });

  test("an unreachable FabOrchestrator after sign-in is the same", async () => {
    stubFo(() => {
      throw new TypeError("fetch failed");
    });
    const res = await signIn();
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { user: { roleName: string } }).user.roleName, "Signed in");
  });

  test("nobody is called Supervisor by default any more", async () => {
    stubFo(() => Response.json({ user: {} }));
    const body = (await (await signIn()).json()) as { user: { roleName: string } };
    assert.notEqual(body.user.roleName, "Supervisor");
  });
});

describe("Stay signed in", () => {
  test("is one call to FabOrchestrator, with the operator's own token", async () => {
    stubFo(() => Response.json({ user: { role: { name: "Admin" } } }));
    const res = await keepAlive();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(calls, [{ path: "/api/auth/me", auth: `Bearer ${FO_TOKEN}` }]);
  });

  test("a session FabOrchestrator has ended is said to have ended, and the cookie goes", async () => {
    stubFo(() => new Response("", { status: 401 }));
    const res = await keepAlive();
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, "faborch_session_expired");
    assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`${FO_TOKEN_COOKIE}=;`));
  });

  test("without a session it is refused before FabOrchestrator is asked", async () => {
    stubFo(() => Response.json({}));
    const res = await keepAlive({ auth: false });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  test("FabOrchestrator being down is 'unavailable', not 'signed out'", async () => {
    stubFo(() => {
      throw new TypeError("fetch failed");
    });
    const res = await keepAlive();
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, "faborch_unavailable");
  });
});
