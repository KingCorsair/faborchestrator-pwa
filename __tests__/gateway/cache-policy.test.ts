/**
 * The cache rule, against the paths both builds actually serve (WP3).
 *
 * ── The defect this exists for (2026-09-08) ─────────────────────────────────
 * WP1 gave this app an `assetPrefix`, so its own content-hashed chunks moved
 * from `/_next/static/…` to `/pwa-assets/_next/static/…`. The `headers()` rule
 * in `next.config.ts` excluded only the bare `_next/static`, so from that
 * moment **every content-hashed file this app owns was served `no-cache,
 * must-revalidate`** — revalidated on every navigation, on a phone, for files
 * whose names change whenever their contents do.
 *
 * Nothing failed. The build passed, the type check passed, 467 tests passed,
 * every live check passed, and the app worked. It was found only by comparing
 * a chunk's `cache-control` on the preview against the same chunk on
 * production, which had been built before the prefix existed.
 *
 * That is the kind of defect a unit test is for: silent, cheap to prevent,
 * and invisible to every other check in the suite. These tests pin the rule to
 * the paths the two builds really use, so the exclusion cannot drift from the
 * prefix a second time.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PWA_ASSET_PREFIX, revalidateSourcePattern } from "@/lib/gateway/registry";

/**
 * Next matches a `headers()` source against the path without its leading
 * slash removed; the pattern is anchored whole. This mirrors that closely
 * enough to test the exclusion, which is the part that broke.
 */
function revalidates(pathname: string): boolean {
  return new RegExp(`^${revalidateSourcePattern()}$`).test(pathname);
}

describe("content-hashed output is cached forever, in both builds", () => {
  for (const p of [
    // FabOrchestrator's, arriving through the gateway at the bare path.
    "/_next/static/chunks/691d640dd1298ee5.js",
    "/_next/static/media/caa3a2e1cccd8315-s.p.3b6cae6d.woff2",
    "/_next/image",
    // This app's own, behind the prefix. These are the ones that regressed.
    `${PWA_ASSET_PREFIX}/_next/static/chunks/afb8f86568253973.js`,
    `${PWA_ASSET_PREFIX}/_next/static/chunks/3cb1d56768e05794.css`,
    `${PWA_ASSET_PREFIX}/_next/image`,
  ]) {
    test(p, () => assert.equal(revalidates(p), false, `${p} must not be forced to revalidate`));
  }
});

describe("everything else revalidates", () => {
  for (const p of [
    // Documents: the 2026-08-19 defect. A year-old document names chunks a
    // later deploy has removed, and the page paints and never hydrates.
    "/",
    "/login",
    "/fabinsight",
    "/chat",
    "/reports",
    // Unversioned files in `public/`: no hash to bust, so revalidation is the
    // only thing that keeps them current, and a 304 costs nothing.
    "/icon-192.png",
    "/apple-touch-icon.png",
    "/manifest.webmanifest",
    "/sw.js",
    // The API is never cached.
    "/api/pwa/auth/me",
    "/api/chat",
  ]) {
    test(p, () => assert.equal(revalidates(p), true, `${p} must revalidate`));
  }
});

describe("the exclusion is not a loose substring match", () => {
  test("a path that merely mentions the prefix elsewhere still revalidates", () => {
    // `_next/static` appearing deeper in a path is not this app's build output
    // and must not inherit an immutable cache header.
    assert.equal(revalidates("/chat/_next/static/not-really.js"), true);
    assert.equal(revalidates("/api/_next/static"), true);
  });

  test("the prefix and the bare path are both covered, and nothing else is", () => {
    assert.equal(revalidates("/pwa-assets/other/file.js"), true);
    assert.equal(revalidates("/_nextfoo/static/x.js"), true);
  });
});
