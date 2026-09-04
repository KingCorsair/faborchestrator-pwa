/**
 * The session gate — the fix for the 2026-09-04 iPhone cold-launch defect.
 *
 * **The report.** On the installed iOS app: sign in, sign out, force-quit from
 * the app switcher, reopen from the Home Screen. The app opened on the cockpit
 * as though the operator were still signed in, and only revealed otherwise when
 * they pressed an agent card.
 *
 * **What it was, exactly.** Not an access-control failure — nothing behind
 * `/api/` was reachable, and the last describe block in this file holds that
 * line. `/` was simply the one screen in the app that read no session, and the
 * manifest's `start_url` points at it, so every cold launch landed there.
 *
 * The fix is `proxy.ts`, which answers before the document exists. These
 * tests drive the real exported `proxy`, not a description of it: the
 * defect was an absent check, and only the real function can prove a check is
 * present.
 *
 * The order below is the order a launch meets them — the gate first, then the
 * loop it must not create, then the API boundary underneath it that was never
 * the problem and must not become one.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { NextRequest, NextResponse } from "next/server";
import { proxy } from "@/proxy";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as signOut } from "@/app/api/auth/logout/route";

const ORIGIN = "https://faborch-demo.fly.dev";
const FO_TOKEN = "fo-session-not-a-real-token";

const USER = {
  id: "u1",
  email: "supervisor@athenatech.example",
  name: "A. Supervisor",
  roleName: "Supervisor",
};

/** The bearer this app hands to `localStorage`, bound to `FO_TOKEN`. */
const PWA_TOKEN = sessionFor(USER, new Date(Date.now() + 30 * 864e5).toISOString(), FO_TOKEN).token;

/**
 * A navigation, as the browser makes one.
 *
 * No `cookie` is the state that matters most here: it is what a cold launch
 * after a sign-out actually sends, because the cookie was deleted and there is
 * nothing left to attach.
 */
function navigation(path: string, cookie?: string): NextRequest {
  // Concatenated rather than `new URL(path, ORIGIN)`, which resolves `//host`
  // as protocol-relative and would hand the gate a request that had already
  // left this origin — a thing no browser can send, since the host comes from
  // the Host header and only the path varies.
  return new NextRequest(new URL(`${ORIGIN}${path}`), {
    headers: cookie === undefined ? {} : { cookie },
  });
}

const signedIn = (path: string) => navigation(path, `${FO_TOKEN_COOKIE}=${FO_TOKEN}`);

/** Where the gate sent this response, or null if it let the request through. */
function redirectedTo(res: NextResponse): string | null {
  const location = res.headers.get("location");
  if (!location) return null;
  const url = new URL(location, ORIGIN);
  assert.equal(url.origin, ORIGIN, "the gate must never redirect off this origin");
  return url.pathname + url.search;
}

/* ── The defect ──────────────────────────────────────────────────────────── */

describe("a launch with no session never reaches the cockpit", () => {
  /**
   * The reported sequence, at the point it went wrong. A force-quit and a Home
   * Screen tap produce exactly this: a fresh navigation to `start_url` carrying
   * no cookie, from a browser process that has been fully restarted.
   */
  test("cold launch of the installed app after sign-out goes to sign-in", () => {
    assert.equal(redirectedTo(proxy(navigation("/"))), "/login");
  });

  test("a signed-out visitor opening / is redirected, not shown a cockpit", () => {
    const res = proxy(navigation("/"));
    assert.equal(res.status, 307);
    assert.equal(redirectedTo(res), "/login");
  });

  test("an emptied cookie is a signed-out cookie, not a session", () => {
    // What `clearFoTokenCookie` leaves behind, and what a browser can send back
    // once before it drops the cookie for good.
    assert.equal(redirectedTo(proxy(navigation("/", `${FO_TOKEN_COOKIE}=`))), "/login");
  });

  test("no agent screen is reachable either, and each carries its return path", () => {
    for (const path of ["/fabinsight", "/backend-agent", "/reports"]) {
      assert.equal(
        redirectedTo(proxy(navigation(path))),
        `/login?next=${encodeURIComponent(path)}`,
        path,
      );
    }
  });

  /**
   * Deny by default. A screen added next month is behind the gate on the day it
   * is created rather than on the day somebody remembers — which is the failure
   * mode that produced this defect in the first place.
   */
  test("a route nobody has thought about yet is gated, not open", () => {
    assert.equal(
      redirectedTo(proxy(navigation("/some-future-screen"))),
      "/login?next=%2Fsome-future-screen",
    );
  });

  test("the question travels to sign-in, so an asked question survives a bounce", () => {
    const asked = "/fabinsight?q=How%20many%20lots%20are%20in%20WIP";
    assert.equal(
      redirectedTo(proxy(navigation(asked))),
      `/login?next=${encodeURIComponent(asked)}`,
    );
  });
});

describe("a launch with a session is not interrupted", () => {
  test("a signed-in operator opening / gets the cockpit, untouched", () => {
    const res = proxy(signedIn("/"));
    assert.equal(redirectedTo(res), null);
    assert.ok(res.status < 300, `status ${res.status}`);
  });

  test("and every screen behind it", () => {
    for (const path of ["/fabinsight", "/backend-agent", "/reports"]) {
      assert.equal(redirectedTo(proxy(signedIn(path))), null, path);
    }
  });
});

/* ── The loop this must not create ───────────────────────────────────────── */

describe("no redirect loop between / and /login", () => {
  test("/login is reachable without a session — it is the destination", () => {
    assert.equal(redirectedTo(proxy(navigation("/login"))), null);
    assert.equal(redirectedTo(proxy(navigation("/login?next=%2Freports"))), null);
  });

  test("the bounce is never cached, so signing in cannot be undone by a stored copy", () => {
    // The one header that can turn this fix into the loop it was written to
    // avoid: a cached 307 outlives the sign-in that was supposed to clear it,
    // and on a phone in a standalone window there is no address bar to escape
    // with.
    assert.match(proxy(navigation("/")).headers.get("cache-control") ?? "", /no-store/);
  });

  test("the return path never points back at sign-in", () => {
    const target = redirectedTo(proxy(navigation("/login")));
    assert.equal(target, null);
    // `/` is the default destination, so it is carried as nothing rather than
    // as `?next=/` — one less way for the two to disagree.
    assert.equal(redirectedTo(proxy(navigation("/"))), "/login");
  });

  test("the return path cannot be turned into an open redirect", () => {
    // `safeReturnPath` is shared with the client-side redirects; this asserts
    // the gate routes through it rather than concatenating a path of its own.
    // A browser normalises the backslash to a slash before it sends this, so
    // both of these arrive as the protocol-relative `//evil.example` — an
    // origin wearing a path's clothes, and the shape `safeReturnPath` rejects.
    for (const path of ["//evil.example", "/\\evil.example"]) {
      const target = redirectedTo(proxy(navigation(path)));
      assert.equal(target, "/login", `${path} → ${target}`);
    }
  });
});

describe("the screens a broken app needs stay reachable", () => {
  /**
   * `/offline` is served from the service worker's cache when the network is
   * gone, so a request for it can arrive from a device that could not have
   * reached the server to be redirected. `/diagnostics` is the page you open
   * when the app is not working, and "log in first" is not a diagnostic.
   */
  test("/offline and /diagnostics are public", () => {
    assert.equal(redirectedTo(proxy(navigation("/offline"))), null);
    assert.equal(redirectedTo(proxy(navigation("/diagnostics"))), null);
  });
});

/* ── Sign-out, end to end ────────────────────────────────────────────────── */

describe("sign out, then launch again", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // FO's own logout, stubbed: the suite must run from a clean checkout with
    // no network. What is under test is what this app does with the answer.
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("sign-out clears the very cookie the gate reads", async () => {
    const res = await signOut(navigation("/api/auth/logout", `${FO_TOKEN_COOKIE}=${FO_TOKEN}`));
    const line = res.headers.get("set-cookie") ?? "";
    assert.match(line, new RegExp(`${FO_TOKEN_COOKIE}=(;|$)`), line);
    assert.match(line, /Max-Age=0/i, line);
  });

  test("sign out, then open / — the browser now holds nothing to send", async () => {
    await signOut(navigation("/api/auth/logout", `${FO_TOKEN_COOKIE}=${FO_TOKEN}`));
    assert.equal(redirectedTo(proxy(navigation("/"))), "/login");
  });

  test("sign out, then a simulated cold reload, three times over", async () => {
    await signOut(navigation("/api/auth/logout", `${FO_TOKEN_COOKIE}=${FO_TOKEN}`));
    // A cold launch shares nothing with the tab that signed out except the
    // cookie jar, which is now empty. A gate that passed on the second try
    // would be worse than none, because it would pass in the demo.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(redirectedTo(proxy(navigation("/"))), "/login", `launch ${attempt + 1}`);
    }
  });
});

/* ── The boundary underneath, which was never the problem ────────────────── */

describe("the API refuses what the gate only redirects", () => {
  const withBearer = (cookie?: string) =>
    new NextRequest(new URL("/api/auth/me", ORIGIN), {
      headers: {
        authorization: `Bearer ${PWA_TOKEN}`,
        ...(cookie === undefined ? {} : { cookie }),
      },
    });

  test("a stale PWA session with no FO token authenticates nothing", async () => {
    // The state the reporter was actually in after signing out: the bearer may
    // still be sitting in localStorage, and on its own it is inert.
    assert.equal((await me(withBearer())).status, 401);
  });

  test("an old FO token cannot restore a session minted beside another", async () => {
    assert.equal((await me(withBearer(`${FO_TOKEN_COOKIE}=a-different-fo-token`))).status, 401);
  });

  test("the two halves together are what a session is", async () => {
    const res = await me(withBearer(`${FO_TOKEN_COOKIE}=${FO_TOKEN}`));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.email, USER.email);
  });
});
