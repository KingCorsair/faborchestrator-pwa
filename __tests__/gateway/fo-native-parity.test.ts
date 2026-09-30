/**
 * Capabilities the chetan branch rebuilt in the PWA's native screens, which
 * embedded FabOrchestrator already provides itself. Nothing is built here;
 * these pin that the embedded path keeps them working (feature parity pass,
 * 2026-09-30):
 *
 *   idle warning      FO's own 28-minute warning and 30-minute expiry run on
 *                     its pages; when FO clears its token, `fo-shell.js` ends
 *                     this app's session too (plan RP2, "Idle, embedded")
 *   Stay logged in    FO's button is `GET /api/auth/me` with the stored
 *                     bearer ([FO-clone] `components/providers.tsx:148-166`);
 *                     the gateway must reach FO with the real token, so FO's
 *                     own idle clock resets. No PWA idle clock is involved.
 *   idle eviction     FO answering 401 ends this app's session (cookie dropped)
 *   file download     FO's chat fetches `/api/files/{id}/download` and saves
 *                     the blob ([FO-clone] `components/artifact-preview.tsx:427`);
 *                     the gateway must forward it with its filename intact
 *
 * Dashboard download needs no gateway support at all: FO's artifact preview
 * builds the file in the browser (`saveBlob`, `artifact-preview.tsx:38-48`).
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { GET } from "@/app/fo-gateway/[...path]/route";

/* ── fo-shell.js, the real file, in a hand-built page ─────────────────────── */

const SHELL = readFileSync(join(process.cwd(), "public", "fo-shell.js"), "utf8");

function loadShell({ tokenPresent = true, storageThrows = false } = {}) {
  let now = 0;
  const timers: { at: number; every?: number; fn: () => void }[] = [];
  const listeners: Record<string, ((e: { key?: string; newValue?: string | null }) => void)[]> = {};
  const store = new Map<string, string>(tokenPresent ? [["llmatscale_auth_token", "pwa-bearer"]] : []);
  const posts: string[] = [];
  const navigations: string[] = [];

  const window = {
    localStorage: {
      getItem: (k: string) => {
        if (storageThrows) throw new Error("SecurityError");
        return store.get(k) ?? null;
      },
    },
    location: { replace: (to: string) => navigations.push(to) },
    addEventListener: (type: string, fn: (e: { key?: string; newValue?: string | null }) => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  const context = vm.createContext({
    window,
    document: { hidden: false, addEventListener: () => {} },
    navigator: {},
    setTimeout: (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }),
    setInterval: (fn: () => void, ms: number) => timers.push({ at: now + ms, every: ms, fn }),
    fetch: (url: string) => {
      posts.push(url);
      return Promise.resolve(new Response("{}"));
    },
  });
  vm.runInContext(SHELL, context);

  async function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else timers.splice(timers.indexOf(next), 1);
      next.fn();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    now = until;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return {
    advance,
    posts,
    navigations,
    foClearsItsToken: () => store.delete("llmatscale_auth_token"),
    storageEvent: (e: { key: string; newValue: string | null }) => listeners.storage?.forEach((fn) => fn(e)),
  };
}

describe("FO's idle expiry ends this app's session (fo-shell.js)", () => {
  test("FO's timer clears its token, and the shell signs out and goes to /login", async () => {
    const page = loadShell();
    await page.advance(10_000);
    assert.deepEqual(page.posts, [], "a live FO session is left alone");

    page.foClearsItsToken(); // FO's own 30-minute expiry
    await page.advance(1_500);
    assert.deepEqual(page.posts, ["/api/pwa/auth/logout"]);
    assert.deepEqual(page.navigations, ["/login"]);
  });

  test("a sign-out in another tab is caught at once", async () => {
    const page = loadShell();
    await page.advance(4_000);
    page.storageEvent({ key: "llmatscale_auth_token", newValue: null });
    await page.advance(0);
    assert.deepEqual(page.posts, ["/api/pwa/auth/logout"]);
  });

  test("storage that cannot be read never signs anybody out on a guess", async () => {
    const page = loadShell({ storageThrows: true });
    await page.advance(60_000);
    assert.deepEqual(page.posts, []);
  });

  test("it signs out once, however many times it notices", async () => {
    const page = loadShell({ tokenPresent: false });
    await page.advance(20_000);
    assert.deepEqual(page.posts, ["/api/pwa/auth/logout"]);
  });
});

/* ── The gateway side ─────────────────────────────────────────────────────── */

const FO_TOKEN = "fo-session-not-a-real-token";
const PWA_TOKEN = sessionFor(
  { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
).token;

const realFetch = globalThis.fetch;
let seen: { path: string; authorization: string | null }[] = [];

function stubFo(answer: (path: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    seen.push({ path, authorization: new Headers(init.headers).get("authorization") });
    return answer(path);
  }) as typeof fetch;
}

function viaGateway(path: string): Promise<Response> {
  const req = new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
    headers: {
      [GATEWAY_MARKER_HEADER]: "1",
      authorization: `Bearer ${PWA_TOKEN}`,
      cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
    },
  });
  return GET(req, { params: Promise.resolve({ path: path.slice(1).split("/") }) });
}

beforeEach(() => {
  seen = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("FO's own Stay logged in, through the gateway", () => {
  test("GET /api/auth/me reaches FabOrchestrator with the real FO token", async () => {
    stubFo(() => Response.json({ user: { id: "u1", role: { name: "Business User" } } }));
    const res = await viaGateway("/api/auth/me");
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [{ path: "/api/auth/me", authorization: `Bearer ${FO_TOKEN}` }]);
    assert.equal(res.headers.get("set-cookie"), null, "a successful keep-alive keeps the session");
  });

  test("FO's idle eviction (401) ends this app's session too", async () => {
    stubFo(() => Response.json({ error: "Session expired" }, { status: 401 }));
    const res = await viaGateway("/api/auth/me");
    assert.equal(res.status, 401);
    assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`${FO_TOKEN_COOKIE}=;`));
  });
});

describe("FO's generated-file download, through the gateway", () => {
  test("forwarded with the real token, filename and type intact, bytes exact", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]); // a zip (pptx) header
    stubFo(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "content-disposition": 'attachment; filename="yield-review.pptx"',
          },
        }),
    );
    const res = await viaGateway("/api/files/file_011CUabcdefghijklmn/download");
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [
      { path: "/api/files/file_011CUabcdefghijklmn/download", authorization: `Bearer ${FO_TOKEN}` },
    ]);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="yield-review.pptx"');
    assert.match(res.headers.get("content-type") ?? "", /presentationml/);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  });
});

describe("FabOrchestrator unavailable is not a sign-out", () => {
  test("a connection failure on FO's own Stay logged in is a 503, and the session is kept", async () => {
    const realError = console.error;
    const lines: string[] = [];
    console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      globalThis.fetch = (async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:443"), { code: "ECONNREFUSED" }),
        });
      }) as typeof fetch;
      const res = await viaGateway("/api/auth/me");
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, "faborch_unavailable");
      assert.equal(res.headers.get("set-cookie"), null, "FO being down must not sign anybody out");
      const line = lines.find((l) => l.includes('"where":"gateway/unreachable"'));
      assert.ok(line, lines.join(" | "));
      assert.match(line!, /"errorCode":"ECONNREFUSED"/);
      assert.ok(!line!.includes("fo.test") && !line!.includes("10.0.0.9"), "never the FO address");
    } finally {
      console.error = realError;
    }
  });
});
