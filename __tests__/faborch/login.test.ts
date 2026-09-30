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

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";

import { NextRequest } from "next/server";
import { sessionFor, verifyToken } from "@/lib/auth";
import { FO_CALL_TIMEOUTS } from "@/lib/faborch/client";
import { resetRecentRevokes } from "@/lib/faborch/end-session";
import { POST } from "@/app/api/pwa/auth/login/route";
import { POST as LOGOUT } from "@/app/api/pwa/auth/logout/route";

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
  // Every sign-out below revokes the same test token; each test must see its own.
  resetRecentRevokes();
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
      "fo-token",
    );
    assert.equal(s.expiresAt, soon);
    assert.ok(verifyToken(s.token), "a capped session is still a valid one");
  });

  test("an unparseable FO expiry is ignored rather than minting a dead session", () => {
    const s = sessionFor(
      { id: "u", email: "e@x.y", name: "N", roleName: "Supervisor" },
      "nonsense",
      "fo-token",
    );
    assert.ok(new Date(s.expiresAt).getTime() > Date.now(), "must not be already expired");
    assert.ok(verifyToken(s.token));
  });
});

describe("sign-out ends the FabOrchestrator session, and never waits on it", () => {
  // Plan RP2 `endServerSession`: the cleared cookie goes back at once; FO is
  // told after the response under the revoke limit, and the outcome is a
  // `session_end` log line, not a field in the response. (Until 2026-09-29 the
  // response carried `faborchRevoked` and waited for FO to produce it.)
  const withCookie = () =>
    new NextRequest("https://pwa.test/api/pwa/auth/logout", {
      method: "POST",
      headers: { cookie: "faborch_token=fo-session-token" },
    });

  const realConsoleInfo = console.info;
  let info: string[] = [];
  beforeEach(() => {
    info = [];
    console.info = (...args: unknown[]) => {
      info.push(args.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.info = realConsoleInfo;
    mock.timers.reset();
  });

  /** Let the post-response revoke run to completion. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const sessionEnd = () => {
    const line = info.find((l) => l.includes('"event":"session_end"'));
    return line ? (JSON.parse(line) as { reason: string; revoked: boolean; sessionFp: string }) : null;
  };

  test("FabOrchestrator's own logout is called with the token, and the outcome logged", async () => {
    stubFo(() => Response.json({ success: true }));
    const res = await LOGOUT(withCookie());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") ?? "", /faborch_token=;/);

    await settle();
    await settle();
    assert.ok(
      calls.some((u) => u.endsWith("/api/auth/logout")),
      "FO must be told, or its session outlives the sign-out",
    );
    const end = sessionEnd();
    assert.equal(end?.reason, "user");
    assert.equal(end?.revoked, true);
    assert.ok(!info.join("\n").includes("fo-session-token"), "never the token itself");
  });

  test("the answer comes back while FabOrchestrator is still hanging", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    globalThis.fetch = ((_input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push("/api/auth/logout");
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof fetch;

    const res = await LOGOUT(withCookie());
    assert.equal(res.status, 200, "sign-out must not wait for a server that is down");
    assert.match(res.headers.get("set-cookie") ?? "", /faborch_token=;/);
    assert.equal(sessionEnd(), null, "FO has not answered yet");

    // The revoke gives up at its own limit and says so in the log.
    mock.timers.tick(FO_CALL_TIMEOUTS.revoke);
    await settle();
    await settle();
    assert.equal(sessionEnd()?.revoked, false);
  });

  test("a 404 from FabOrchestrator counts as revoked: the session was already gone", async () => {
    stubFo(() => new Response("", { status: 404 }));
    await LOGOUT(withCookie());
    await settle();
    await settle();
    assert.equal(sessionEnd()?.revoked, true);
  });

  test("signing out with no cookie still clears and does not call FO", async () => {
    stubFo(() => Response.json({ success: true }));
    const res = await LOGOUT(
      new NextRequest("https://pwa.test/api/pwa/auth/logout", { method: "POST" }),
    );
    await settle();
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);
    assert.match(res.headers.get("set-cookie") ?? "", /faborch_token=;/);
  });
});

/* ── Plan RP2, the rest of the login flow (2026-09-30) ────────────────────── */

/** A FabOrchestrator that records method, path and bearer for every call. */
function recordingFo(options: { canCreateDashboards?: boolean } = {}) {
  const seen: { method: string; path: string; bearer: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const bearer = new Headers(init.headers).get("authorization");
    seen.push({ method: (init.method ?? "GET").toUpperCase(), path: url.pathname, bearer });
    if (url.pathname === "/api/auth/login") {
      return Response.json({
        token: "fo-session-token",
        expiresAt: new Date(Date.now() + 30 * 864e5).toISOString(),
        user: {
          id: "fo-user-1",
          email: "operator@plant.example",
          name: "A. Operator",
          ...(options.canCreateDashboards === undefined ? {} : { canCreateDashboards: options.canCreateDashboards }),
        },
      });
    }
    if (url.pathname === "/api/auth/me") return Response.json({ user: { id: "fo-user-1", role: { name: "Business User" } } });
    if (url.pathname === "/api/auth/logout") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return seen;
}

let m = 0;
const loginWith = (headers: Record<string, string> = {}) => {
  m += 1;
  return POST(
    new NextRequest("https://pwa.test/api/pwa/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "fly-client-ip": `10.9.0.${m}`, ...headers },
      body: JSON.stringify({ email: "operator@plant.example", password: "correct-horse" }),
    }),
  );
};

describe("a new sign-in ends the session it replaces (RP2 login step 3)", () => {
  test("the older FabOrchestrator token in the cookie is revoked before the new session is answered", async () => {
    const seen = recordingFo();
    // FabOrchestrator's logout is held until released: the sign-in must still
    // be waiting on it, which is what "before it is answered" means.
    const record = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let logoutStarted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/auth/logout") {
        logoutStarted = true;
        await held;
      }
      return record(input, init);
    }) as typeof fetch;

    let answered = false;
    const pending = loginWith({ cookie: "faborch_token=an-older-fo-token" }).then((res) => {
      answered = true;
      return res;
    });
    for (let i = 0; i < 50 && !logoutStarted; i++) await new Promise<void>((r) => setImmediate(r));
    assert.ok(logoutStarted, "the replaced token's revoke was asked for");
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(answered, false, "the sign-in waits for the revoke of the session it replaces");

    release();
    const res = await pending;
    assert.equal(res.status, 200);
    const revoke = seen.find((c) => c.path === "/api/auth/logout");
    assert.equal(revoke!.bearer, "Bearer an-older-fo-token");
    assert.match(res.headers.get("set-cookie") ?? "", /faborch_token=fo-session-token/);
  });

  test("a first sign-in revokes nothing", async () => {
    const seen = recordingFo();
    await loginWith();
    assert.ok(!seen.some((c) => c.path === "/api/auth/logout"));
  });
});

describe("what a successful sign-in answers", () => {
  test("FabOrchestrator's own user fields, for the session blob its pages read (G30)", async () => {
    recordingFo({ canCreateDashboards: true });
    const body = (await (await loginWith()).json()) as {
      user: { id: string; email: string; name: string | null; canCreateDashboards?: boolean; roleName: string };
      next: string | null;
    };
    assert.deepEqual(
      { id: body.user.id, email: body.user.email, name: body.user.name, canCreateDashboards: body.user.canCreateDashboards },
      { id: "fo-user-1", email: "operator@plant.example", name: "A. Operator", canCreateDashboards: true },
    );
    assert.equal(body.user.roleName, "Business User");
    assert.equal(body.next, null, "an ordinary sign-in goes where the operator was headed");
  });

  test("when FabOrchestrator does not say, dashboard rights are left for its pages to ask", async () => {
    recordingFo();
    const body = (await (await loginWith()).json()) as { user: Record<string, unknown> };
    assert.equal("canCreateDashboards" in body.user, false);
  });

  test("the cookie lives as long as this app's session plus the grace, not FO's 30 days", async () => {
    recordingFo();
    const res = await loginWith();
    const { expiresAt } = (await res.json()) as { expiresAt: string };
    const maxAge = Number((res.headers.get("set-cookie") ?? "").match(/Max-Age=(\d+)/i)?.[1]);
    const expected = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000) + 300;
    assert.ok(Math.abs(maxAge - expected) <= 2, `Max-Age ${maxAge}, expected about ${expected}`);
    assert.ok(maxAge < 13 * 3600, "never FabOrchestrator's 30-day expiry");
  });
});

describe("failures are coded, and never carry FabOrchestrator's address (RP5, m4)", () => {
  test("a wrong password is invalid_credentials", async () => {
    stubFo(() => new Response("", { status: 401 }));
    const res = await login("operator@plant.example", "wrong");
    assert.equal(((await res.json()) as { code: string }).code, "invalid_credentials");
  });

  test("FabOrchestrator unreachable: 503 faborch_unavailable, no address", async () => {
    const realError = console.error;
    console.error = () => {};
    try {
      globalThis.fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      const res = await login("operator@plant.example", "correct-horse");
      const text = await res.text();
      assert.equal(res.status, 503);
      assert.equal((JSON.parse(text) as { code: string }).code, "faborch_unavailable");
      assert.ok(!text.includes("fo.test"), text);
    } finally {
      console.error = realError;
    }
  });

  test("FabOrchestrator too slow: 504 upstream_timeout, no address", async () => {
    const realError = console.error;
    console.error = () => {};
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      globalThis.fetch = ((_input: RequestInfo | URL, init: RequestInit = {}) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as typeof fetch;
      const pending = login("operator@plant.example", "correct-horse");
      for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
      mock.timers.tick(FO_CALL_TIMEOUTS.bounded);
      const res = await pending;
      const text = await res.text();
      assert.equal(res.status, 504);
      assert.equal((JSON.parse(text) as { code: string }).code, "upstream_timeout");
      assert.ok(!text.includes("fo.test"), text);
    } finally {
      mock.timers.reset();
      console.error = realError;
    }
  });
});

describe("sign-out comes only from this app's own pages (RP2, G26)", () => {
  const realConsoleInfo = console.info;
  let info: string[] = [];
  beforeEach(() => {
    info = [];
    console.info = (...args: unknown[]) => {
      info.push(args.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.info = realConsoleInfo;
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  const signOut = (headers: Record<string, string>, body?: unknown, foToken = "fo-session-token") =>
    LOGOUT(
      new NextRequest("https://pwa.test/api/pwa/auth/logout", {
        method: "POST",
        headers: { cookie: `faborch_token=${foToken}`, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  test("a cross-site sign-out is refused, the cookie kept and FabOrchestrator not called", async () => {
    stubFo(() => Response.json({ success: true }));
    const crossSite: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "null" },
    ];
    for (const headers of crossSite) {
      const res = await signOut(headers);
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.equal(((await res.json()) as { code: string }).code, "cross_site_request");
      assert.equal(res.headers.get("set-cookie"), null, "the cookie survives");
    }
    await settle();
    assert.equal(calls.length, 0);
  });

  test("this app's own page, and a client that sends neither header, sign out", async () => {
    stubFo(() => Response.json({ success: true }));
    const ownPages: Record<string, string>[] = [{ "sec-fetch-site": "same-origin" }, {}];
    for (const headers of ownPages) {
      const res = await signOut(headers);
      assert.equal(res.status, 200, JSON.stringify(headers));
      assert.match(res.headers.get("set-cookie") ?? "", /faborch_token=;/);
    }
  });

  test("the reason a page gives is what the log records, and only a client-side reason", async () => {
    stubFo(() => Response.json({ success: true }));
    await signOut({ "sec-fetch-site": "same-origin" }, { reason: "pwa_expired" }, "fo-token-one");
    await signOut({ "sec-fetch-site": "same-origin" }, { reason: "gateway_refusal" }, "fo-token-two");
    await settle();
    await settle();
    const reasons = info
      .filter((l) => l.includes('"event":"session_end"'))
      .map((l) => (JSON.parse(l) as { reason: string }).reason)
      .sort();
    assert.deepEqual(reasons, ["pwa_expired", "user"]);
  });
});

describe("sign-in comes only from this app's own pages, as JSON (RP2 step 1, RP3 part 5)", () => {
  const post = (headers: Record<string, string>, body = JSON.stringify({ email: "a@b.c", password: "x" })) =>
    POST(new NextRequest("https://pwa.test/api/pwa/auth/login", { method: "POST", headers, body }));

  test("a cross-site sign-in is refused before FabOrchestrator is asked", async () => {
    stubFo(() => Response.json({}));
    const res = await post({ "Content-Type": "application/json", "sec-fetch-site": "cross-site" });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "cross_site_request");
    assert.equal(calls.length, 0);
  });

  test("a form post (not JSON) is refused: a form on another site can send nothing else", async () => {
    stubFo(() => Response.json({}));
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await post({ "Content-Type": type }, '{"email":"a@b.c","password":"x","z":"="}');
      assert.equal(res.status, 415, type);
      assert.equal(((await res.json()) as { code: string }).code, "unsupported_media_type");
    }
    assert.equal(calls.length, 0);
  });
});

describe("this app's own session settings are checked before FabOrchestrator is asked", () => {
  test("no signing key id: 503 not_configured, and FabOrchestrator never sees the password", async () => {
    stubFo(() => Response.json({}));
    const saved = process.env.SESSION_SIGNING_KEY_ID;
    const realError = console.error;
    console.error = () => {};
    delete process.env.SESSION_SIGNING_KEY_ID;
    try {
      const res = await login("operator@plant.example", "correct-horse");
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, "not_configured");
      assert.equal(calls.length, 0, "no FabOrchestrator session was created that nobody could use");
    } finally {
      process.env.SESSION_SIGNING_KEY_ID = saved;
      console.error = realError;
    }
  });

  test("an unusable cookie grace: the same", async () => {
    stubFo(() => Response.json({}));
    const realError = console.error;
    console.error = () => {};
    process.env.SESSION_COOKIE_GRACE_S = "1800";
    try {
      const res = await login("operator@plant.example", "correct-horse");
      assert.equal(res.status, 503);
      assert.equal(calls.length, 0);
    } finally {
      delete process.env.SESSION_COOKIE_GRACE_S;
      console.error = realError;
    }
  });
});
