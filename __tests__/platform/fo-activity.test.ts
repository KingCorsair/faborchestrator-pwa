/**
 * FabOrchestrator's idle clock, as this device keeps it.
 *
 * FO ends a session after 30 minutes without activity. The top bar warns in the
 * last five, and past thirty says the session has probably ended. These pin the
 * boundaries, the storage that must never throw, and the one call this module
 * may make — only when the operator presses Stay signed in.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  FO_IDLE_LIMIT_MS,
  FO_IDLE_WARNING_MS,
  clearFoActivity,
  foIdleState,
  lastFoActivity,
  markFoActivity,
  stayActive,
} from "../../lib/fo-activity";

const MIN = 60_000;
const realFetch = globalThis.fetch;
const g = globalThis as { localStorage?: Storage };

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function throwingStorage(): Storage {
  const fail = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

beforeEach(() => {
  g.localStorage = memoryStorage();
});
afterEach(() => {
  delete g.localStorage;
  globalThis.fetch = realFetch;
});

describe("where the clock stands", () => {
  const t0 = 10_000_000;

  test("nothing recorded is nothing to say", () => {
    assert.deepEqual(foIdleState(null, t0), { kind: "active" });
  });

  test("quiet until the last five minutes", () => {
    assert.deepEqual(foIdleState(t0, t0 + 24 * MIN + 59_000), { kind: "active" });
    assert.deepEqual(foIdleState(t0, t0 + FO_IDLE_LIMIT_MS - FO_IDLE_WARNING_MS), {
      kind: "warning",
      minutesLeft: 5,
    });
  });

  test("the minutes count down, and never read zero while there is time", () => {
    assert.deepEqual(foIdleState(t0, t0 + 29 * MIN + 30_000), { kind: "warning", minutesLeft: 1 });
  });

  test("at thirty minutes the session has probably ended", () => {
    assert.deepEqual(foIdleState(t0, t0 + FO_IDLE_LIMIT_MS), { kind: "ended" });
  });
});

describe("the record", () => {
  test("round-trips, and clears", () => {
    markFoActivity(12345);
    assert.equal(lastFoActivity(), 12345);
    clearFoActivity();
    assert.equal(lastFoActivity(), null);
  });

  test("storage that throws is storage that says nothing, never a crash", () => {
    g.localStorage = throwingStorage();
    assert.doesNotThrow(() => markFoActivity());
    assert.equal(lastFoActivity(), null);
    assert.doesNotThrow(() => clearFoActivity());
  });

  test("a value that is not a time is no time", () => {
    g.localStorage!.setItem("faborch_last_activity", "not a number");
    assert.equal(lastFoActivity(), null);
  });
});

describe("Stay signed in", () => {
  let requests: { url: string; method?: string; auth: string | null }[] = [];

  const answer = (response: () => Response) => {
    requests = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        url: String(input),
        method: init.method,
        auth: new Headers(init.headers as HeadersInit).get("Authorization"),
      });
      return response();
    }) as typeof fetch;
  };

  test("asks this app's keep-alive route, with the bearer, and restarts the clock", async () => {
    answer(() => Response.json({ ok: true }));
    const before = Date.now();
    assert.equal(await stayActive("pwa-token"), "ok");
    assert.deepEqual(requests, [{ url: "/api/auth/keep-alive", method: "POST", auth: "Bearer pwa-token" }]);
    assert.ok((lastFoActivity() ?? 0) >= before);
  });

  test("an ended session is 'ended', and the clock is not restarted", async () => {
    answer(() => new Response("", { status: 401 }));
    assert.equal(await stayActive("pwa-token"), "ended");
    assert.equal(lastFoActivity(), null);
  });

  test("anything else is 'failed', and the warning stays", async () => {
    answer(() => new Response("", { status: 502 }));
    assert.equal(await stayActive("pwa-token"), "failed");
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.equal(await stayActive("pwa-token"), "failed");
  });
});
