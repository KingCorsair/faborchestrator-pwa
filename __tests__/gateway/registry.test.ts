/**
 * The ownership registry (`lib/gateway/registry.ts`).
 *
 * Two properties carry the whole rollout: with the flag empty, every path is
 * this app's exactly as before; with the flag set, a path is FabOrchestrator's
 * only if the registry names it, and anything unnamed is refused.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, isForwardable, readRegistry, underPrefix } from "@/lib/gateway/registry";

describe("readRegistry", () => {
  test("unset or empty disables the registry", () => {
    const off = { mode: "off", enabled: false, surfaces: [], ignored: [] };
    assert.deepEqual(readRegistry({}), off);
    assert.deepEqual(readRegistry({ FO_EMBED_SURFACES: "" }), off);
    assert.deepEqual(readRegistry({ FO_EMBED_SURFACES: "   " }), off);
  });

  /**
   * `FO_EMBED_MODE` is the migration switch (audit, 9 September). The property
   * that matters is the **fallback**: anything this app does not recognise must
   * mean less exposure, never more.
   */
  test("the mode decides, and an unrecognised one never opens more", () => {
    assert.equal(readRegistry({ FO_EMBED_MODE: "whole" }).mode, "whole");
    assert.equal(readRegistry({ FO_EMBED_MODE: "WHOLE" }).mode, "whole");
    assert.equal(readRegistry({ FO_EMBED_MODE: "off", FO_EMBED_SURFACES: "/chat" }).mode, "off");
    assert.equal(readRegistry({ FO_EMBED_MODE: "off", FO_EMBED_SURFACES: "/chat" }).enabled, false);

    // Unset: the old variable still decides, so a deployment carrying only
    // `FO_EMBED_SURFACES` behaves exactly as it did before the audit.
    assert.equal(readRegistry({ FO_EMBED_SURFACES: "/chat" }).mode, "surfaces");

    // A typo, a future value, a half-finished edit — none of them may be read
    // as "serve the whole application".
    for (const bad of ["all", "everything", "true", "1", "wholesale", " whol e "]) {
      assert.notEqual(readRegistry({ FO_EMBED_MODE: bad }).mode, "whole", bad);
      assert.equal(readRegistry({ FO_EMBED_MODE: bad }).enabled, false, bad);
    }
  });

  test("lists catalogue entries, trims, ignores the unknown", () => {
    const r = readRegistry({ FO_EMBED_SURFACES: " /chat , /reports, /nope ,/chat" });
    assert.equal(r.enabled, true);
    assert.deepEqual(r.surfaces, ["/chat", "/reports"]);
    assert.deepEqual(r.ignored, ["/nope"]);
  });

  test("only unknown entries enables nothing", () => {
    const r = readRegistry({ FO_EMBED_SURFACES: "/admin,/evil" });
    assert.equal(r.enabled, false);
    assert.deepEqual(r.ignored, ["/admin", "/evil"]);
  });
});

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

describe("classify with the registry disabled", () => {
  const off = readRegistry({});
  for (const p of ["/", "/chat", "/reports", "/_next/static/chunks/a.js", "/api/chat", "/api/auth/login", "/anything"]) {
    test(`${p} is this app's`, () => assert.equal(classify(p, off), "pwa"));
  }
});

describe("classify with /chat enabled", () => {
  const on = readRegistry({ FO_EMBED_SURFACES: "/chat" });

  test("the front door and this app's screens stay this app's", () => {
    for (const p of ["/", "/login", "/offline", "/diagnostics", "/fabinsight", "/backend-agent", "/reports", "/reports/x"]) {
      assert.equal(classify(p, on), "pwa", p);
    }
  });

  test("this app's API, build output and install files stay this app's", () => {
    for (const p of [
      "/api/pwa/auth/login",
      "/api/pwa/auth/me",
      "/api/pwa/auth/logout",
      "/api/faborch/insight/chat",
      "/pwa-assets/_next/static/chunks/a.js",
      "/sw.js",
      "/manifest.webmanifest",
      "/icon-192.png",
      "/apple-touch-icon.png",
    ]) {
      assert.equal(classify(p, on), "pwa", p);
    }
  });

  test("the listed document and its sub-paths are FabOrchestrator's", () => {
    assert.equal(classify("/chat", on), "fo-document");
    assert.equal(classify("/chat/anything", on), "fo-document");
  });

  test("unlisted catalogue documents are not opened", () => {
    for (const p of ["/settings", "/home", "/modeling-agent", "/force-password-change"]) {
      assert.equal(classify(p, on), "unknown", p);
    }
  });

  test("FabOrchestrator's own identity and sign-out are forwarded, not answered here (WP2)", () => {
    // This is what lets the embedded page ask FabOrchestrator who the operator
    // is, and sign them out through FabOrchestrator, rather than this app
    // impersonating either answer.
    for (const p of ["/api/auth/me", "/api/auth/logout", "/api/auth/change-password"]) {
      assert.equal(classify(p, on), "fo-api", p);
    }
  });

  test("FabOrchestrator API the page calls is forwarded", () => {
    for (const p of [
      "/api/chat",
      "/api/conversations",
      "/api/conversations/abc",
      "/api/mcp/connections",
      "/api/mcp/health",
      "/api/user/models",
      "/api/user/settings",
      "/api/platform-theme",
      "/api/platform-notice",
      "/api/client-log",
      "/api/fabinsight/warm",
      "/api/fabinsight/pinned/x",
      "/api/files/x/download",
      "/api/health",
    ]) {
      assert.equal(classify(p, on), "fo-api", p);
    }
  });

  test("FabOrchestrator static output is forwarded", () => {
    for (const p of ["/_next/static/chunks/a.js", "/_next/static/media/f.woff2", "/favicon.ico", "/logos/athena-logo.jpg", "/duke_sheets_wasm_bg.wasm"]) {
      assert.equal(classify(p, on), "fo-static", p);
    }
  });

  test("credential endpoints and the scheduler are denied even though they are FO's", () => {
    for (const p of ["/api/auth/register", "/api/auth/password-reset", "/api/auth/password-reset/confirm", "/api/fabinsight/cron/tick", "/forgot-password", "/reset-password"]) {
      assert.notEqual(classify(p, on), "fo-api", p);
      assert.notEqual(classify(p, on), "fo-document", p);
      assert.ok(["denied", "pwa"].includes(classify(p, on)), `${p} → ${classify(p, on)}`);
    }
  });

  test("anything unnamed is unknown", () => {
    for (const p of ["/admin", "/api/admin/users", "/share/x", "/v/key", "/fo-gateway/chat", "/wp1-nonexistent"]) {
      assert.equal(classify(p, on), "unknown", p);
    }
  });
});

describe("classify with /reports enabled moves the one collision", () => {
  const on = readRegistry({ FO_EMBED_SURFACES: "/chat,/reports" });
  test("/reports becomes FabOrchestrator's by configuration alone", () => {
    assert.equal(classify("/reports", on), "fo-document");
  });
  test("/ and /login are still this app's", () => {
    assert.equal(classify("/", on), "pwa");
    assert.equal(classify("/login", on), "pwa");
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
