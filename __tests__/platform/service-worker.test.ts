import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

/**
 * Drives `public/sw.js` itself, not a copy of its logic.
 *
 * The bug these tests exist for shipped in a file no test could reach: a
 * service worker is not importable, has no exports and runs in a global scope
 * Node does not have. So the untested branch was the one deciding whether a
 * supervisor sees the app or an offline screen — and it was wrong in the one
 * situation nobody could reproduce on a laptop, a cold launch of the installed
 * app on a phone.
 *
 * The worker is evaluated in a `vm` context holding a hand-built
 * ServiceWorkerGlobalScope: enough of `self`, `caches` and `fetch` for its
 * handlers to run, and nothing more. Loading the real file is the whole point —
 * a rewrite of the handler inside the test would have passed against the
 * version that had the defect.
 */

interface FakeRequest {
  url: string;
  mode: string;
  method: string;
}

interface FakeResponse {
  marker: string;
}

interface FakeFetchEvent {
  request: FakeRequest;
  preloadResponse: Promise<FakeResponse | undefined>;
  respondWith(response: Promise<FakeResponse>): void;
}

type FetchListener = (event: FakeFetchEvent) => void;

const OFFLINE_RESPONSE: FakeResponse = { marker: "offline-page" };
const LIVE_RESPONSE: FakeResponse = { marker: "live-page" };

interface Harness {
  /** Sends a navigation through the worker and returns whatever it answered. */
  navigate(options?: NavigateOptions): Promise<FakeResponse | null>;
  fetchCalls: FakeRequest[];
  /**
   * Every URL the worker looked for in the cache.
   *
   * Recorded so a test can assert what the worker **never asks for**, which is
   * the only honest way to prove a negative about caching: a worker that could
   * answer a navigation from a stored copy of `/` would have to look it up
   * here first.
   */
  cacheLookups: string[];
}

interface NavigateOptions {
  url?: string;
  mode?: string;
  method?: string;
  preload?: Promise<FakeResponse | undefined>;
}

/**
 * `fetch` behaviour is scripted per attempt: an entry is either a response to
 * return or an Error to reject with, which is how a network failure actually
 * reaches the worker. Past the end of the script fetch keeps failing — so a
 * test expecting two retries cannot pass by accident on a third.
 */
function loadWorker(script: (FakeResponse | Error)[], onLine = false): Harness {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "public", "sw.js"), "utf8");

  const listeners = new Map<string, FetchListener>();
  const fetchCalls: FakeRequest[] = [];
  const cacheLookups: string[] = [];

  const scope = {
    addEventListener(type: string, listener: FetchListener) {
      listeners.set(type, listener);
    },
    registration: { navigationPreload: undefined },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    // `self.navigator.onLine` decides whether a failed navigation is allowed to
    // claim the device is offline. Default false here so the existing
    // offline-page tests read as "genuinely offline", which is what they are.
    navigator: { onLine },
  };

  const sandbox = {
    self: scope,
    URL,
    setTimeout,
    Request: class {},
    Response: class {
      constructor(
        public body: string,
        public init?: { status?: number; headers?: Record<string, string> },
      ) {}
    },
    caches: {
      async match(url: string) {
        cacheLookups.push(url);
        return url === "/offline" ? OFFLINE_RESPONSE : undefined;
      },
      async open() {
        return { add: async () => undefined };
      },
      async keys() {
        return [] as string[];
      },
      async delete() {
        return true;
      },
    },
    async fetch(request: FakeRequest) {
      fetchCalls.push(request);
      const next = script[fetchCalls.length - 1];
      if (next === undefined) throw new Error("network unavailable");
      if (next instanceof Error) throw next;
      return next;
    },
  };

  runInContext(source, createContext(sandbox));

  return {
    fetchCalls,
    cacheLookups,
    async navigate(options: NavigateOptions = {}) {
      const listener = listeners.get("fetch");
      assert.ok(listener, "the worker registered no fetch listener");

      let responded: Promise<FakeResponse> | null = null;
      listener({
        request: {
          url: options.url ?? "https://faborch-demo.fly.dev/orders",
          mode: options.mode ?? "navigate",
          method: options.method ?? "GET",
        },
        preloadResponse: options.preload ?? Promise.resolve(undefined),
        respondWith(response) {
          responded = response;
        },
      });

      // `null` and "answered with null" are distinguishable: not calling
      // respondWith is how the worker says "let this through untouched", which
      // is a behaviour worth asserting rather than an absence.
      return responded === null ? null : await responded;
    },
  };
}

describe("service worker navigation handling", () => {
  /**
   * The defect, reproduced. A cold launch of the installed iOS app rejects the
   * first navigation fetch because the network process is not attached yet;
   * the previous worker read that one rejection as "offline" and served the
   * offline page to a phone with a working connection.
   */
  test("a navigation that fails once still reaches the network", async () => {
    const harness = loadWorker([new Error("cold start"), LIVE_RESPONSE]);

    assert.equal(await harness.navigate(), LIVE_RESPONSE);
    assert.equal(harness.fetchCalls.length, 2);
  });

  test("survives two failures, which is the whole cold-start window", async () => {
    const harness = loadWorker([
      new Error("cold start"),
      new Error("still starting"),
      LIVE_RESPONSE,
    ]);

    assert.equal(await harness.navigate(), LIVE_RESPONSE);
    assert.equal(harness.fetchCalls.length, 3);
  });

  /**
   * The other half of the contract: retrying must not turn a real outage into
   * a blank screen. Once the attempts are spent, the offline page is the honest
   * answer and it is still served.
   */
  test("falls back to the offline page when every attempt fails", async () => {
    const harness = loadWorker([]);

    assert.equal(await harness.navigate(), OFFLINE_RESPONSE);
    assert.equal(harness.fetchCalls.length, 3, "one attempt plus two retries");
  });

  /**
   * A POST navigation's body is consumed by the first attempt. Retrying one
   * either fails or double-submits, and double-submitting is the worse of those
   * by a distance.
   */
  test("never retries a POST navigation", async () => {
    const harness = loadWorker([]);

    assert.equal(await harness.navigate({ method: "POST" }), OFFLINE_RESPONSE);
    assert.equal(harness.fetchCalls.length, 1);
  });

  test("uses the browser's preloaded response and skips its own fetch entirely", async () => {
    const preloaded: FakeResponse = { marker: "preloaded" };
    const harness = loadWorker([LIVE_RESPONSE]);

    assert.equal(await harness.navigate({ preload: Promise.resolve(preloaded) }), preloaded);
    assert.equal(harness.fetchCalls.length, 0);
  });

  test("a failed preload falls through to the worker's own attempts", async () => {
    const harness = loadWorker([LIVE_RESPONSE]);
    const preload = Promise.reject(new Error("preload failed"));

    assert.equal(await harness.navigate({ preload }), LIVE_RESPONSE);
    assert.equal(harness.fetchCalls.length, 1);
  });

  /**
   * The failure that was reported twice: the app showing its own "No
   * connection" screen on a phone with a working network. A worker that cannot
   * reach the server while the browser says it is online has learned nothing
   * about the network — only about itself — and must not speak for it.
   */
  test("does not claim the device is offline when the browser says it is online", async () => {
    const harness = loadWorker([], true);
    const answer = (await harness.navigate()) as unknown as {
      body: string;
      init?: { status?: number };
    };

    assert.notEqual(answer, OFFLINE_RESPONSE, "the offline page must not be served");
    assert.equal(answer.init?.status, 503);
    assert.match(answer.body, /Could not load the app/);
  });

  /**
   * And that response has to be able to break the loop it was born in: a device
   * whose stored copies are unusable cannot fix itself with more stored copies.
   */
  test("the online-failure response carries a reset that clears workers and caches", async () => {
    const harness = loadWorker([], true);
    const answer = (await harness.navigate()) as unknown as { body: string };

    assert.match(answer.body, /getRegistrations/);
    assert.match(answer.body, /unregister/);
    assert.match(answer.body, /caches\.delete/);
    assert.match(answer.body, /location\.replace\("\/"\)/);
  });

  /** Unchanged rules, kept under test so the retry work cannot widen the net. */
  test("does not touch anything that is not a navigation", async () => {
    const harness = loadWorker([LIVE_RESPONSE]);

    assert.equal(await harness.navigate({ mode: "cors" }), null);
    assert.equal(harness.fetchCalls.length, 0);
  });

  test("never intercepts the API, even navigated to directly", async () => {
    const harness = loadWorker([LIVE_RESPONSE]);

    assert.equal(await harness.navigate({ url: "https://faborch-demo.fly.dev/api/activity" }), null);
    assert.equal(harness.fetchCalls.length, 0);
  });
});

/**
 * The half of the 2026-09-04 cold-launch defect that turned out **not** to be
 * the cause, pinned so it cannot become one.
 *
 * The report — a signed-out cold launch showing the cockpit — has an obvious
 * suspect in a service worker, because it reproduces only on the installed app
 * and only after a force-quit. It was not this file: the worker stores the
 * offline page and two icons and nothing else, and answers every navigation
 * from the network. The real cause was that `/` never checked the session, and
 * the fix is `proxy.ts`.
 *
 * That fix depends on this staying true. A gate in front of the document is
 * worth nothing if a worker can replay a document from before the sign-out, so
 * the property under test is that authenticated HTML is never stored and never
 * served — asserted from what the worker *asks the cache for*, not from what
 * the cache happens to hold.
 */
describe("no authenticated HTML survives a cold launch", () => {
  test("a launch of / is answered by the server, never by a stored copy", async () => {
    const harness = loadWorker([LIVE_RESPONSE]);

    assert.equal(await harness.navigate({ url: "https://faborch-demo.fly.dev/" }), LIVE_RESPONSE);
    assert.deepEqual(harness.cacheLookups, [], "the cockpit must never be looked for in the cache");
  });

  /**
   * And when the network really is gone, the fallback is the offline page —
   * which says the device is offline and shows nothing about anybody's session.
   * A cached cockpit here would be the same defect wearing a different cause.
   */
  test("offline, / falls back to the offline page and not to a stored cockpit", async () => {
    const harness = loadWorker([]);

    assert.equal(await harness.navigate({ url: "https://faborch-demo.fly.dev/" }), OFFLINE_RESPONSE);
    assert.deepEqual(harness.cacheLookups, ["/offline"]);
  });

  test("the redirect to sign-in is followed by the browser, not swallowed here", async () => {
    // The gate answers a session-less navigation with a 307. To the worker that
    // is an *answer*, not a failure, so it is returned untouched and the
    // browser follows it — the same rule that keeps a 404 or a 500 visible.
    const redirect: FakeResponse = { marker: "307-to-login" };
    const harness = loadWorker([redirect]);

    assert.equal(await harness.navigate({ url: "https://faborch-demo.fly.dev/" }), redirect);
    assert.equal(harness.fetchCalls.length, 1, "a redirect must not be retried as a failure");
  });

  test("only the offline page and its icons are ever precached", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "..", "public", "sw.js"), "utf8");
    const precache = source.match(/const PRECACHE = \[([^\]]*)\]/)?.[1] ?? "";

    assert.deepEqual(
      precache
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      ["OFFLINE_URL", '"/icon-192.png"', '"/apple-touch-icon.png"'],
      "adding a document here would put a cockpit back in the cache",
    );

    // `cache.add` appears once, in `install`, for the list above. A `cache.put`
    // anywhere would mean responses are being stored as they pass through,
    // which is how an app shell gets cached by accident.
    assert.ok(!/cache\.put|caches\.put/.test(source), "the worker must not store responses");
  });
});
