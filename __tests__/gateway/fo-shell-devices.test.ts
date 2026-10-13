/**
 * The Devices button `public/fo-shell.js` adds to FabOrchestrator's overview
 * page for device administrators (13 October 2026). The real file, run in a
 * hand-built page: a body that records what is attached to it, a clock the
 * test advances, and a stand-in for this app's administrator check.
 *
 * What matters here: the button appears only when the server says this person
 * is a device administrator, it is only a link to `/device-admin`, and nothing
 * about it can change what the server allows.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SHELL = readFileSync(join(process.cwd(), "public", "fo-shell.js"), "utf8");

interface FakeElement {
  tag: string;
  id: string;
  href: string;
  textContent: string;
  attributes: Record<string, string>;
  style: { cssText: string; display: string };
  parentNode: unknown;
  setAttribute(name: string, value: string): void;
}

function loadShell(options: { path?: string; token?: string | null; admin?: number | "offline" } = {}) {
  const { token = "pwa-bearer", admin = 200 } = options;
  let now = 0;
  let adminAnswer: number | "offline" = admin;
  const timers: { at: number; every?: number; fn: () => void }[] = [];
  const store = new Map<string, string>(token ? [["llmatscale_auth_token", token], ["llmatscale_auth_session", "{}"]] : []);
  const requests: { url: string; method: string; authorization: string | null }[] = [];
  const location = { pathname: options.path ?? "/home", search: "", replace: () => {}, reload: () => {} };

  const body = {
    children: [] as FakeElement[],
    appendChild(el: FakeElement) {
      if (!this.children.includes(el)) this.children.push(el);
      el.parentNode = body;
      return el;
    },
  };
  const document = {
    hidden: false,
    body,
    addEventListener: () => {},
    createElement: (tag: string): FakeElement => ({
      tag,
      id: "",
      href: "",
      textContent: "",
      attributes: {},
      style: { cssText: "", display: "" },
      parentNode: null,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
    }),
  };
  const window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    },
    location,
    addEventListener: () => {},
  };

  const context = vm.createContext({
    window,
    document,
    navigator: {},
    setTimeout: (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }),
    setInterval: (fn: () => void, ms: number) => timers.push({ at: now + ms, every: ms, fn }),
    fetch: (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      requests.push({ url, method: (init.method ?? "GET").toUpperCase(), authorization: init.headers?.Authorization ?? null });
      if (url !== "/api/pwa/device-admin/me") return Promise.resolve(new Response("{}"));
      if (adminAnswer === "offline") return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(new Response(adminAnswer === 200 ? '{"admin":true}' : '{"code":"forbidden"}', { status: adminAnswer }));
    },
  });
  vm.runInContext(SHELL, context);

  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else timers.splice(timers.indexOf(next), 1);
      next.fn();
      await settle();
    }
    now = until;
    await settle();
  }

  return {
    advance,
    settle,
    location,
    store,
    body,
    asks: () => requests.filter((r) => r.url === "/api/pwa/device-admin/me"),
    requests,
    button: () => body.children.find((el) => el.id === "pwa-devices-link") ?? null,
    setAdmin: (answer: number | "offline") => (adminAnswer = answer),
  };
}

describe("the Devices button on FabOrchestrator's overview page", () => {
  test("a device administrator gets a link to /device-admin, asked with this app's own session", async () => {
    const page = loadShell({ path: "/home", admin: 200 });
    await page.settle();
    const button = page.button();
    assert.ok(button, "the button is on the page");
    assert.equal(button.tag, "a");
    assert.equal(button.href, "/device-admin");
    assert.equal(button.textContent, "Devices");
    assert.equal(button.style.display, "inline-flex");
    assert.equal(button.attributes["aria-label"], "Manage approved devices");
    assert.deepEqual(page.asks(), [{ url: "/api/pwa/device-admin/me", method: "GET", authorization: "Bearer pwa-bearer" }]);
  });

  test("anyone the server does not call an administrator gets no button, and is asked about once", async () => {
    for (const status of [403, 401, 404, 503]) {
      const page = loadShell({ path: "/home", admin: status });
      await page.advance(30_000);
      assert.equal(page.button(), null, `no button on ${status}`);
      assert.equal(page.asks().length, 1, `asked once on ${status}`);
    }
  });

  test("the page decides nothing: it only ever reads the check, and sends nothing else for the button", async () => {
    const page = loadShell({ path: "/home", admin: 200 });
    await page.advance(10_000);
    assert.deepEqual(
      page.requests.map((r) => `${r.method} ${r.url}`),
      ["GET /api/pwa/device-admin/me"],
      "one read; no write, no sign-out, nothing to FabOrchestrator",
    );
  });

  test("with no session in this browser there is nothing to ask with, and nothing is asked", async () => {
    const page = loadShell({ path: "/home", token: null });
    await page.advance(3_000); // before the sign-out watcher's own check at 4 s
    assert.deepEqual(page.asks(), []);
    assert.equal(page.button(), null);
  });

  test("it is shown on the overview page only, and follows a move between pages without a reload", async () => {
    const page = loadShell({ path: "/chat", admin: 200 });
    await page.settle();
    assert.equal(page.button()?.style.display, "none", "hidden on the chat page");

    page.location.pathname = "/home";
    await page.advance(1_500);
    assert.equal(page.button()?.style.display, "inline-flex");

    page.location.pathname = "/reports";
    await page.advance(1_500);
    assert.equal(page.button()?.style.display, "none");
    assert.equal(page.asks().length, 1, "the check is not repeated for a page change");
  });

  test("a failed request is tried again; a re-render that drops the button gets it back", async () => {
    const page = loadShell({ path: "/home", admin: "offline" });
    await page.settle(); // the first request fails
    await page.advance(1_500);
    assert.equal(page.button(), null);
    assert.ok(page.asks().length >= 2, "asked again after the network failed");

    page.setAdmin(200);
    await page.advance(1_500);
    assert.ok(page.button(), "shown once the check gets through");

    // FabOrchestrator re-rendered <body>: the button is detached from the page.
    for (const el of page.body.children.splice(0)) el.parentNode = null;
    await page.advance(1_500);
    assert.ok(page.button(), "attached again");
  });

  test("the script names the same check and page this app serves", () => {
    assert.ok(SHELL.includes('"/api/pwa/device-admin/me"'));
    assert.ok(SHELL.includes('var DEVICES_PAGE = "/device-admin"'));
    // A link and a GET: the script never posts to a device route.
    assert.ok(!/fetch\([^)]*\/api\/pwa\/devices/.test(SHELL));
    assert.ok(!SHELL.includes("/api/pwa/device-enrollments"));
  });
});
