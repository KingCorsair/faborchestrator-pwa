/**
 * The sign-in limiter.
 *
 * These pin the two properties that make it worth having and the one that makes
 * it safe to have: an attacker is stopped, a real operator never is, and the
 * window actually expires rather than locking somebody out forever.
 *
 * It matters more than a normal Tier-0 unit test because `/api/auth/login`
 * forwards to a **real** FabOrchestrator, so this code is what stands between a
 * public demo URL and a production identity store. See `lib/rate-limit.ts`.
 *
 * The first block runs with no shared store configured — the in-process count,
 * as the app ran before 2026-09-28. The second runs the same properties against
 * a stand-in for Upstash's REST API, and adds the ones that are new: the count
 * survives this process forgetting it, the address never reaches the store in
 * the clear, and an unreachable store degrades to the in-process count rather
 * than to no limiter at all.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_RATE_LIMIT,
  checkLoginAllowed,
  clearLoginFailures,
  clientAddress,
  recordLoginFailure,
  resetLoginFailures,
} from "../../lib/rate-limit";

const { MAX_FAILURES, WINDOW_MS } = LOGIN_RATE_LIMIT;

const realFetch = globalThis.fetch;

function withoutSharedStore() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

describe("in this process (no shared store configured)", () => {
  beforeEach(() => {
    withoutSharedStore();
    resetLoginFailures();
  });

  test("a fresh address is allowed", async () => {
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, true);
  });

  test("the limit is reached only after MAX_FAILURES wrong guesses", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await recordLoginFailure("1.2.3.4");
      assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, true, `blocked early at guess ${i + 1}`);
    }
    await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, false, "should be blocked on the last one");
  });

  test("a blocked address is told how long to wait", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    const verdict = await checkLoginAllowed("1.2.3.4");
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.retryAfterSeconds > 0, "a block with no retry time is unactionable");
    assert.ok(verdict.retryAfterSeconds <= Math.ceil(WINDOW_MS / 1000));
  });

  test("the window expires rather than locking somebody out forever", async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4", t0);
    assert.equal((await checkLoginAllowed("1.2.3.4", t0)).allowed, false);
    // One millisecond before the window closes it is still blocked...
    assert.equal((await checkLoginAllowed("1.2.3.4", t0 + WINDOW_MS - 1)).allowed, false);
    // ...and at the boundary it clears.
    assert.equal((await checkLoginAllowed("1.2.3.4", t0 + WINDOW_MS)).allowed, true);
  });

  test("addresses are counted separately", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, false);
    assert.equal(
      (await checkLoginAllowed("5.6.7.8")).allowed,
      true,
      "one attacker must not lock out everyone",
    );
  });

  test("a correct password clears the counter", async () => {
    // The property that keeps this from being a nuisance: somebody who mistypes
    // their password seven times and then gets it right is not left one guess
    // from a ten-minute wait for the rest of the window.
    for (let i = 0; i < MAX_FAILURES - 1; i++) await recordLoginFailure("1.2.3.4");
    await clearLoginFailures("1.2.3.4");
    for (let i = 0; i < MAX_FAILURES - 1; i++) await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, true);
  });

  test("failures older than the window do not accumulate", async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES - 1; i++) await recordLoginFailure("1.2.3.4", t0);
    // A guess after the window starts a fresh count rather than topping up an
    // expired one — otherwise one wrong guess a day would eventually block a user.
    await recordLoginFailure("1.2.3.4", t0 + WINDOW_MS + 1);
    assert.equal((await checkLoginAllowed("1.2.3.4", t0 + WINDOW_MS + 1)).allowed, true);
  });

  test("no request is made anywhere when no store is configured", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      await recordLoginFailure("1.2.3.4");
      await checkLoginAllowed("1.2.3.4");
      await clearLoginFailures("1.2.3.4");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(called, false);
  });

  test("half a configuration is no configuration", async () => {
    // A URL without a token cannot authenticate, and a token without a URL has
    // nowhere to go. Either alone must leave the in-process count in charge
    // rather than failing every sign-in against a store that cannot answer.
    process.env.UPSTASH_REDIS_REST_URL = "https://store.test";
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
      assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, false);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(called, false);
  });
});

/* ── A stand-in for Upstash ──────────────────────────────────────────────────
 *
 * Speaks the REST API's wire format — a JSON command array POSTed to the base
 * URL, a two-dimensional one to `/pipeline`, `{ result }` or `{ error }` back —
 * for the four commands the limiter sends. It does not run Lua: it applies what
 * `RECORD_FAILURE` does (count, and start the expiry when there is none). What
 * this proves is the protocol and every decision the limiter makes on the
 * replies; the script itself is proved only against a real Redis.
 */

interface FakeStore {
  keys: Map<string, { count: number; expiresAt: number }>;
  requests: { url: string; body: unknown; authorization: string | null }[];
  advance(ms: number): void;
}

function fakeUpstash(): FakeStore {
  const keys = new Map<string, { count: number; expiresAt: number }>();
  const requests: FakeStore["requests"] = [];
  let clock = 5_000_000;

  const live = (key: string) => {
    const entry = keys.get(key);
    if (entry && entry.expiresAt <= clock) {
      keys.delete(key);
      return undefined;
    }
    return entry;
  };

  const run = (cmd: unknown): { result?: unknown; error?: string } => {
    if (!Array.isArray(cmd)) return { error: "ERR not a command" };
    const [name, ...args] = cmd as string[];
    switch (name) {
      case "GET": {
        const entry = live(args[0]!);
        return { result: entry ? String(entry.count) : null };
      }
      case "PTTL": {
        const entry = live(args[0]!);
        return { result: entry ? entry.expiresAt - clock : -2 };
      }
      case "DEL":
        return { result: keys.delete(args[0]!) ? 1 : 0 };
      case "EVAL": {
        // ["EVAL", script, "1", key, windowMs]
        const [, , key, windowMs] = args;
        const entry = live(key!);
        if (entry) {
          entry.count += 1;
          return { result: entry.count };
        }
        keys.set(key!, { count: 1, expiresAt: clock + Number(windowMs) });
        return { result: 1 };
      }
      default:
        return { error: `ERR unknown command '${name}'` };
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = JSON.parse(String(init.body));
    requests.push({
      url,
      body,
      authorization: new Headers(init.headers as HeadersInit).get("Authorization"),
    });
    if (new URL(url).pathname === "/pipeline") {
      return Response.json((body as unknown[]).map(run));
    }
    return Response.json(run(body));
  }) as typeof fetch;

  return {
    keys,
    requests,
    advance(ms) {
      clock += ms;
    },
  };
}

describe("in a shared store (Upstash configured)", () => {
  let store: FakeStore;

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://store.test/";
    process.env.UPSTASH_REDIS_REST_TOKEN = "store-token-not-real";
    process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
    resetLoginFailures();
    store = fakeUpstash();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    withoutSharedStore();
  });

  test("the count lives in the store, so this process forgetting it changes nothing", async () => {
    // What a second copy of the app, a restart or a deploy looks like from here:
    // a process with an empty memory. The address must still be blocked.
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    resetLoginFailures();
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, false);
  });

  test("the limit is reached only after MAX_FAILURES wrong guesses", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, true, "blocked one guess early");
    await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, false);
  });

  test("the wait is the store's own expiry, counted from the first failure", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    store.advance(4 * 60_000);
    const verdict = await checkLoginAllowed("1.2.3.4");
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.retryAfterSeconds, Math.ceil((WINDOW_MS - 4 * 60_000) / 1000));
  });

  test("the window expires rather than locking somebody out forever", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    store.advance(WINDOW_MS);
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, true);
  });

  test("addresses are counted separately", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("5.6.7.8")).allowed, true);
  });

  test("a correct password clears the shared count", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) await recordLoginFailure("1.2.3.4");
    await clearLoginFailures("1.2.3.4");
    assert.equal(store.keys.size, 0, "the key is deleted, not merely ignored");
    for (let i = 0; i < MAX_FAILURES - 1; i++) await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, true);
  });

  test("the address never reaches the store in the clear", async () => {
    // The store is a third party and an IP address is personal data. The key is
    // a keyed digest, so it cannot be reversed by hashing the IPv4 space.
    await recordLoginFailure("203.0.113.77");
    await checkLoginAllowed("203.0.113.77");
    await clearLoginFailures("203.0.113.77");
    for (const request of store.requests) {
      assert.ok(!JSON.stringify(request.body).includes("203.0.113.77"), JSON.stringify(request.body));
    }
  });

  test("every call carries the token as a bearer, and goes where it was pointed", async () => {
    await recordLoginFailure("1.2.3.4");
    await checkLoginAllowed("1.2.3.4");
    assert.ok(store.requests.length >= 2);
    for (const request of store.requests) {
      assert.equal(request.authorization, "Bearer store-token-not-real");
      assert.ok(request.url.startsWith("https://store.test/"), request.url);
    }
  });

  test("a failure starts its expiry in the same step that counts it", async () => {
    // Counting and expiring as two commands leaves a moment in which the key
    // has no expiry — and a key with no expiry is an address locked out for
    // good. One EVAL is one step.
    await recordLoginFailure("1.2.3.4");
    const record = store.requests.find((r) => Array.isArray(r.body) && r.body[0] === "EVAL");
    assert.ok(record, "the failure is recorded with a single EVAL");
    const script = String((record!.body as unknown[])[1]);
    assert.match(script, /INCR/);
    assert.match(script, /PEXPIRE/);
    assert.equal((record!.body as unknown[])[4], String(WINDOW_MS));
  });
});

describe("when the shared store cannot be reached", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://store.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "store-token-not-real";
    resetLoginFailures();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    withoutSharedStore();
  });

  test("sign-in is not refused because the counter is down", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, true);
  });

  test("the count falls back to this process, so the limiter still holds", async () => {
    // The fallback is the protection the app had before the store existed —
    // not none at all.
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, false);
  });

  test("a store that refuses the token is treated as unreachable, not as a verdict", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: "WRONGPASS invalid password" }, { status: 401 })) as typeof fetch;
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, true);
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, false, "and the local count holds");
  });

  test("a command error inside a 200 is not mistaken for a result", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      new URL(input.toString()).pathname === "/pipeline"
        ? Response.json([{ error: "ERR something" }, { error: "ERR something" }])
        : Response.json({ error: "ERR something" })) as typeof fetch;
    for (let i = 0; i < MAX_FAILURES; i++) await recordLoginFailure("1.2.3.4");
    assert.equal((await checkLoginAllowed("1.2.3.4")).allowed, false);
  });

  test("a plain-http store is refused, because the token travels with every call", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "http://store.test";
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ result: null });
    }) as typeof fetch;
    await recordLoginFailure("1.2.3.4");
    assert.equal(called, false, "the token must not be sent over plain http");
  });
});

describe("the caller's address", () => {
  test("the client address prefers fly-client-ip over the forgeable header", () => {
    // `x-forwarded-for` is caller-supplied. If it won, an attacker would rotate it
    // per request and never be counted twice — i.e. no limiter at all.
    const headers = new Headers({
      "fly-client-ip": "9.9.9.9",
      "x-forwarded-for": "1.1.1.1, 2.2.2.2",
    });
    assert.equal(clientAddress(headers), "9.9.9.9");
  });

  test("x-forwarded-for is used when fly-client-ip is absent, first entry only", () => {
    assert.equal(clientAddress(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })), "1.1.1.1");
  });

  test("with no proxy headers every caller shares one bucket", () => {
    // Local development: one caller, so one bucket is correct rather than a hole.
    assert.equal(clientAddress(new Headers()), "local");
  });
});
