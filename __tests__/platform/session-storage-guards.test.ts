/**
 * The signed-in screens' own session code (`components/fab/use-session.ts`)
 * against storage that throws, through its exported functions: the best
 * behavioural harness available until the plan's component harness (RP10-A
 * part 5) exists. The hook itself needs Next's router mounted; the functions
 * every screen calls to end a session do not.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearAuthStorage, logout } from "../../components/fab/use-session";

const realFetch = globalThis.fetch;
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  globalThis.fetch = realFetch;
});

function throwingStorage() {
  const deny = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: deny, setItem: deny, removeItem: deny },
  };
}

test("clearing the session never throws, whatever storage does", () => {
  throwingStorage();
  assert.doesNotThrow(() => clearAuthStorage());
});

test("sign-out with storage that throws still asks the server to end the session", async () => {
  throwingStorage();
  const sent: { url: string; keepalive?: boolean }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ url: String(input), keepalive: init.keepalive });
    return new Response("{}");
  }) as typeof fetch;
  await assert.doesNotReject(logout("pwa-token"));
  assert.deepEqual(sent, [{ url: "/api/pwa/auth/logout", keepalive: true }]);
});

test("sign-out does not wait on the network", async () => {
  throwingStorage();
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch; // never answers
  const settled = await Promise.race([
    logout("pwa-token").then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("waited"), 200)),
  ]);
  assert.equal(settled, "returned");
});
