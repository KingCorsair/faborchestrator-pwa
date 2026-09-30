/**
 * Ending a session in the browser (`lib/end-client-session.ts`, plan RP2
 * `endClientSession`), and the signed-in screens' own session code
 * (`components/fab/use-session.ts`), against storage that throws — the best
 * behavioural harness available until the plan's component harness (RP10-A
 * part 5) exists. The hook itself needs Next's router mounted; the functions
 * every screen calls to end a session do not.
 *
 * The order is the rule: tell the server (which revokes the FabOrchestrator
 * session behind the cookie), forget this device's session, then a
 * whole-document navigation to sign-in. Until 2026-09-30 an expired session
 * cleared localStorage without telling the server (m3), so the FabOrchestrator
 * session stayed alive for up to 30 days.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearAuthStorage, logout } from "../../components/fab/use-session";
import { endClientSession } from "../../lib/end-client-session";

const realFetch = globalThis.fetch;
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  globalThis.fetch = realFetch;
});

type Sent = { url: string; keepalive?: boolean; body?: string };

function recordFetch(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ url: String(input), keepalive: init.keepalive, body: init.body as string | undefined });
    return new Response("{}");
  }) as typeof fetch;
  return sent;
}

function workingWindow() {
  const store = new Map([
    ["llmatscale_auth_token", "pwa-token"],
    ["llmatscale_auth_session", "{}"],
  ]);
  const navigations: string[] = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    location: { replace: (to: string) => navigations.push(to) },
  };
  return { store, navigations };
}

function throwingStorage() {
  const deny = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: deny, setItem: deny, removeItem: deny },
    location: { replace: () => {} },
  };
}

test("the plan's order: the server told why, both keys forgotten, then sign-in", () => {
  const sent = recordFetch();
  const { store, navigations } = workingWindow();
  endClientSession("pwa_expired", { to: "/login?next=%2Fchat" });
  assert.deepEqual(sent.map((s) => [s.url, s.keepalive]), [["/api/pwa/auth/logout", true]]);
  assert.deepEqual(JSON.parse(sent[0]!.body!), { reason: "pwa_expired" });
  assert.equal(store.size, 0);
  assert.deepEqual(navigations, ["/login?next=%2Fchat"]);
});

test("a caller that navigates itself can skip the navigation", () => {
  recordFetch();
  const { navigations } = workingWindow();
  endClientSession("storage_unavailable", { navigate: false });
  assert.deepEqual(navigations, []);
});

test("clearing the session never throws, whatever storage does", () => {
  throwingStorage();
  assert.doesNotThrow(() => clearAuthStorage());
});

test("sign-out with storage that throws still asks the server to end the session", async () => {
  throwingStorage();
  const sent = recordFetch();
  await assert.doesNotReject(logout());
  assert.deepEqual(sent.map((s) => ({ url: s.url, keepalive: s.keepalive })), [
    { url: "/api/pwa/auth/logout", keepalive: true },
  ]);
});

test("sign-out does not wait on the network", async () => {
  throwingStorage();
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch; // never answers
  const settled = await Promise.race([
    logout().then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("waited"), 200)),
  ]);
  assert.equal(settled, "returned");
});
