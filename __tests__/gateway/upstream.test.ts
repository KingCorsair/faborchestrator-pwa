/**
 * Upstream selection (`lib/gateway/upstream.ts`).
 *
 * The properties that matter:
 *  - by default **everything** comes from the real FabOrchestrator
 *    (`FABORCH_BASE_URL`): its pages, their assets and its API;
 *  - a separate UI build answers pages and assets only when a deployment
 *    switches the preview split on deliberately (`FO_UI_SPLIT_ALLOWED=1`, plan
 *    RP1 G18), and **never** the API, where the data and the credentials are;
 *  - named without the switch, it fails closed rather than being used quietly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { FabOrchNotConfiguredError, foBaseUrl } from "@/lib/faborch/client";
import { foOrigins, foUiBaseUrl, upstreamOrigin } from "@/lib/gateway/upstream";

const UI = "http://faborch-fo-ui-preview.internal:3000";

describe("upstreamOrigin", () => {
  test("by default every class goes to the real FabOrchestrator", () => {
    for (const owner of ["fo-document", "fo-static", "fo-api"] as const) {
      assert.equal(upstreamOrigin(owner, {}), foBaseUrl());
      assert.equal(upstreamOrigin(owner, { FO_UI_BASE_URL: "   " }), foBaseUrl());
    }
  });

  test("a UI build named without the preview switch fails closed", () => {
    for (const env of [{ FO_UI_BASE_URL: UI }, { FO_UI_BASE_URL: UI, FO_UI_SPLIT_ALLOWED: "true" }]) {
      assert.throws(() => upstreamOrigin("fo-document", env), FabOrchNotConfiguredError);
    }
  });

  test("with the switch on: documents and assets go to the UI build, the API never does", () => {
    const env = { FO_UI_BASE_URL: `${UI}/`, FO_UI_SPLIT_ALLOWED: "1" };
    assert.equal(upstreamOrigin("fo-document", env), UI);
    assert.equal(upstreamOrigin("fo-static", env), UI);
    assert.equal(upstreamOrigin("fo-api", env), foBaseUrl());
  });
});

describe("foUiBaseUrl", () => {
  const allowed = (value: string) => ({ FO_UI_BASE_URL: value, FO_UI_SPLIT_ALLOWED: "1" });

  test("https anywhere, http only on the private network or loopback", () => {
    assert.equal(foUiBaseUrl(allowed("https://ui.example.com")), "https://ui.example.com");
    assert.equal(foUiBaseUrl(allowed("http://app.internal:3000")), "http://app.internal:3000");
    assert.equal(foUiBaseUrl(allowed("http://localhost:3100")), "http://localhost:3100");
    assert.throws(() => foUiBaseUrl(allowed("http://ui.example.com")), FabOrchNotConfiguredError);
    assert.throws(() => foUiBaseUrl(allowed("http://internal.example.com")), FabOrchNotConfiguredError);
    assert.throws(() => foUiBaseUrl(allowed("ftp://app.internal")), FabOrchNotConfiguredError);
    assert.throws(() => foUiBaseUrl(allowed("not a url")), FabOrchNotConfiguredError);
  });

  test("a refusal never repeats the configured value (it can name an internal host)", () => {
    try {
      foUiBaseUrl(allowed("http://secret-host.example.com"));
      assert.fail("should have thrown");
    } catch (error) {
      assert.ok(!(error as Error).message.includes("secret-host"), (error as Error).message);
    }
  });
});

describe("foOrigins (the origins a redirect may name, RP1 G17)", () => {
  test("one origin by default, both with the preview split on", () => {
    assert.deepEqual(foOrigins({}), [foBaseUrl()]);
    assert.deepEqual(foOrigins({ FO_UI_BASE_URL: UI, FO_UI_SPLIT_ALLOWED: "1" }), [foBaseUrl(), UI]);
  });
});
