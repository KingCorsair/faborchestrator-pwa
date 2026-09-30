/**
 * The device's stored session, read and written so a browser that refuses
 * storage never takes a screen down (`lib/stored-session.ts`).
 *
 * The chetan branch guarded each screen's reads in place and tested it with
 * source-text assertions (`reliability-guards.test.ts`), which the plan rules
 * out (RP10-A). Here every screen reads through one module, so its behaviour is
 * tested directly against a `localStorage` that throws the way real browsers
 * do: on read, on write, and on a quota that runs out half-way.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_SESSION_KEY,
  AUTH_TOKEN_KEY,
  bearerHeader,
  clearStoredSession,
  readStored,
  readStoredSession,
  storeSession,
} from "../../lib/stored-session";

type Fake = { store: Map<string, string>; failGet?: boolean; failSet?: boolean; quotaAfter?: number; failRemove?: boolean };

function install(fake: Fake): void {
  let writes = 0;
  const localStorage = {
    getItem(k: string) {
      if (fake.failGet) throw new DOMException("The operation is insecure.", "SecurityError");
      return fake.store.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (fake.failSet) throw new DOMException("The operation is insecure.", "SecurityError");
      if (fake.quotaAfter !== undefined && writes >= fake.quotaAfter) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      writes += 1;
      fake.store.set(k, v);
    },
    removeItem(k: string) {
      if (fake.failRemove) throw new DOMException("The operation is insecure.", "SecurityError");
      fake.store.delete(k);
    },
  };
  (globalThis as { window?: unknown }).window = { localStorage };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("reading", () => {
  test("a working store returns what is there", () => {
    install({ store: new Map([[AUTH_TOKEN_KEY, "t"], [AUTH_SESSION_KEY, '{"expiresAt":"x"}']]) });
    assert.equal(readStored(AUTH_TOKEN_KEY), "t");
    assert.deepEqual(readStoredSession(), { token: "t", raw: '{"expiresAt":"x"}' });
    assert.equal(bearerHeader(), "Bearer t");
  });

  test("storage that throws on read is no session, never a crash", () => {
    install({ store: new Map([[AUTH_TOKEN_KEY, "t"]]), failGet: true });
    assert.equal(readStored(AUTH_TOKEN_KEY), null);
    assert.equal(readStoredSession(), null);
    assert.equal(bearerHeader(), "Bearer ", "an empty bearer, which the server refuses with its own 401");
  });

  test("half a session is no session", () => {
    install({ store: new Map([[AUTH_TOKEN_KEY, "t"]]) });
    assert.equal(readStoredSession(), null);
  });

  test("no window at all (a server render) is no session", () => {
    assert.equal(readStored(AUTH_TOKEN_KEY), null);
    assert.equal(bearerHeader(), "Bearer ");
  });

  test("a window whose localStorage property itself throws is no session", () => {
    (globalThis as { window?: unknown }).window = Object.defineProperty({}, "localStorage", {
      get() {
        throw new DOMException("Access is denied", "SecurityError");
      },
    });
    assert.equal(readStoredSession(), null);
  });
});

describe("writing a new session", () => {
  test("both halves are kept", () => {
    const fake: Fake = { store: new Map() };
    install(fake);
    assert.equal(storeSession("t", "2026-10-01T00:00:00.000Z"), true);
    assert.equal(fake.store.get(AUTH_TOKEN_KEY), "t");
    assert.equal(fake.store.get(AUTH_SESSION_KEY), JSON.stringify({ expiresAt: "2026-10-01T00:00:00.000Z" }));
  });

  test("a store that refuses writes says so", () => {
    install({ store: new Map(), failSet: true });
    assert.equal(storeSession("t", "x"), false);
  });

  test("a quota that runs out half-way leaves nothing behind", () => {
    const fake: Fake = { store: new Map(), quotaAfter: 1 };
    install(fake);
    assert.equal(storeSession("t", "x"), false);
    assert.equal(fake.store.size, 0, "a token with no expiry would be acted on by the next screen");
  });

  test("clearing never throws, whatever storage does", () => {
    install({ store: new Map([[AUTH_TOKEN_KEY, "t"]]), failRemove: true });
    assert.doesNotThrow(() => clearStoredSession());
  });
});
