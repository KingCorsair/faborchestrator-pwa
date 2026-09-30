/**
 * Upstream selection (`lib/gateway/upstream.ts`).
 *
 * The property that matters: a UI-only build may answer FabOrchestrator's
 * pages and their assets, and **never** its API — the API is where the data
 * and the credentials are.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { FabOrchNotConfiguredError, foBaseUrl } from "@/lib/faborch/client";
import { foUiBaseUrl, upstreamOrigin } from "@/lib/gateway/upstream";

describe("upstreamOrigin", () => {
  test("unset: every class goes to FABORCH_BASE_URL, as before", () => {
    for (const owner of ["fo-document", "fo-static", "fo-api"] as const) {
      assert.equal(upstreamOrigin(owner, {}), foBaseUrl());
      assert.equal(upstreamOrigin(owner, { FO_UI_BASE_URL: "   " }), foBaseUrl());
    }
  });

  test("set: documents and assets go to the UI build, the API never does", () => {
    const env = { FO_UI_BASE_URL: "http://faborch-fo-ui-preview.internal:3000/" };
    assert.equal(upstreamOrigin("fo-document", env), "http://faborch-fo-ui-preview.internal:3000");
    assert.equal(upstreamOrigin("fo-static", env), "http://faborch-fo-ui-preview.internal:3000");
    assert.equal(upstreamOrigin("fo-api", env), foBaseUrl());
  });
});

describe("foUiBaseUrl", () => {
  test("https anywhere, http only on the private network or loopback", () => {
    assert.equal(foUiBaseUrl({ FO_UI_BASE_URL: "https://ui.example.com" }), "https://ui.example.com");
    assert.equal(foUiBaseUrl({ FO_UI_BASE_URL: "http://app.internal:3000" }), "http://app.internal:3000");
    assert.equal(foUiBaseUrl({ FO_UI_BASE_URL: "http://localhost:3100" }), "http://localhost:3100");
    assert.throws(() => foUiBaseUrl({ FO_UI_BASE_URL: "http://ui.example.com" }), FabOrchNotConfiguredError);
    assert.throws(() => foUiBaseUrl({ FO_UI_BASE_URL: "http://internal.example.com" }), FabOrchNotConfiguredError);
    assert.throws(() => foUiBaseUrl({ FO_UI_BASE_URL: "ftp://app.internal" }), FabOrchNotConfiguredError);
    assert.throws(() => foUiBaseUrl({ FO_UI_BASE_URL: "not a url" }), FabOrchNotConfiguredError);
  });
});
