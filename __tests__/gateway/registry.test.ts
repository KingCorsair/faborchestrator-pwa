/**
 * The ownership registry (`lib/gateway/registry.ts`).
 *
 * This app serves FabOrchestrator's own pages for every document it does not
 * reserve itself. The API does not follow the same default: an endpoint is
 * forwarded only when it is listed, which is the security constraint Amay set.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, isForwardable, underPrefix } from "@/lib/gateway/registry";

describe("underPrefix matches at a segment boundary", () => {
  test("equal and continued", () => {
    assert.equal(underPrefix("/chat", "/chat"), true);
    assert.equal(underPrefix("/chat/x", "/chat"), true);
    assert.equal(underPrefix("/api/user/settings", "/api/user"), true);
  });
  test("not merely a string prefix", () => {
    assert.equal(underPrefix("/chatter", "/chat"), false);
    assert.equal(underPrefix("/reportsx", "/reports"), false);
  });
});

describe("classify", () => {
  test("this app keeps what it exists to provide", () => {
    for (const p of [
      "/",
      "/login",
      "/offline",
      "/diagnostics",
      "/fabinsight",
      "/backend-agent",
      "/api/pwa/auth/login",
      "/api/pwa/auth/me",
      "/api/pwa/auth/logout",
      "/pwa-assets/_next/static/chunks/a.js",
      "/sw.js",
      "/fo-shell.js",
      "/manifest.webmanifest",
      "/icon-192.png",
      "/apple-touch-icon.png",
    ]) {
      assert.equal(classify(p), "pwa", p);
    }
  });

  test("every other page is FabOrchestrator's, including one it has not shipped yet", () => {
    for (const p of [
      "/chat",
      "/chat/anything",
      "/reports",
      "/home",
      "/settings",
      "/modeling-agent/loader",
      "/force-password-change",
      "/some-page-nobody-has-written-yet",
    ]) {
      assert.equal(classify(p), "fo-document", p);
    }
  });

  test("FabOrchestrator's own identity and sign-out are forwarded, not answered here (WP2)", () => {
    // This is what lets the embedded page ask FabOrchestrator who the operator
    // is, and sign them out through FabOrchestrator, rather than this app
    // impersonating either answer.
    for (const p of ["/api/auth/me", "/api/auth/logout", "/api/auth/change-password"]) {
      assert.equal(classify(p), "fo-api", p);
    }
  });

  test("FabOrchestrator API the page calls is forwarded", () => {
    for (const p of [
      "/api/chat",
      "/api/conversations",
      "/api/conversations/abc",
      "/api/conversations/abc/messages",
      "/api/mcp/connections",
      "/api/user/models",
      "/api/user/settings",
      "/api/platform-theme",
      "/api/fabinsight/warm",
      "/api/fabinsight/pinned/x",
      "/api/files/x/download",
      "/api/health",
    ]) {
      assert.equal(classify(p), "fo-api", p);
    }
  });

  test("an unlisted endpoint is refused: the API does not follow the page default", () => {
    for (const p of ["/api", "/api/scheduling", "/api/anything-new", "/api/admin/users", "/api/faborch/reports"]) {
      assert.equal(classify(p), "unknown", p);
    }
  });

  test("FabOrchestrator static output is forwarded", () => {
    for (const p of ["/_next/static/chunks/a.js", "/_next/static/media/f.woff2", "/favicon.ico", "/logos/athena-logo.jpg", "/duke_sheets_wasm_bg.wasm"]) {
      assert.equal(classify(p), "fo-static", p);
    }
  });

  test("credential endpoints, the scheduler and recovery pages are denied even though they are FO's", () => {
    for (const p of [
      "/api/auth/login",
      "/api/auth/register",
      "/api/auth/password-reset",
      "/api/auth/password-reset/confirm",
      "/api/fabinsight/cron/tick",
      "/api/fabinsight/schema",
      "/api/artifacts",
      "/forgot-password",
      "/reset-password",
    ]) {
      assert.equal(classify(p), "denied", p);
    }
  });
});

test("isForwardable names exactly the FO owners", () => {
  assert.equal(isForwardable("fo-document"), true);
  assert.equal(isForwardable("fo-api"), true);
  assert.equal(isForwardable("fo-static"), true);
  assert.equal(isForwardable("pwa"), false);
  assert.equal(isForwardable("denied"), false);
  assert.equal(isForwardable("unknown"), false);
});
