/**
 * Did a request come from this app's own pages? (`lib/same-origin.ts`; plan
 * RP3 part 5 `sameOriginVerdict`, used by sign-out under RP2.)
 *
 * The rule the plan fixed for sign-out: refuse what says it is cross-site,
 * allow what says nothing. Every supported browser sends `Sec-Fetch-Site`, so
 * a request with neither header is a non-browser client, which cannot be the
 * victim of a forged form post.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { publicOrigin, sameOriginVerdict } from "../../lib/same-origin";

const APP = "https://faborch-demo.fly.dev";
const verdict = (headers: Record<string, string>, origin: string | null = APP) =>
  sameOriginVerdict(new Headers(headers), origin);

describe("Sec-Fetch-Site decides when present", () => {
  test("same-origin is this app", () => assert.equal(verdict({ "sec-fetch-site": "same-origin" }), "same-origin"));
  test("cross-site and same-site are refused", () => {
    assert.equal(verdict({ "sec-fetch-site": "cross-site" }), "cross-site");
    assert.equal(verdict({ "sec-fetch-site": "same-site" }), "cross-site");
  });
  test("none (typed into the address bar) is unknown", () => assert.equal(verdict({ "sec-fetch-site": "none" }), "unknown"));
  test("it wins over a contradicting Origin", () =>
    assert.equal(verdict({ "sec-fetch-site": "cross-site", origin: APP }), "cross-site"));
});

describe("otherwise Origin", () => {
  test("this app's own origin", () => assert.equal(verdict({ origin: APP }), "same-origin"));
  test("any other origin, and the opaque null origin, are cross-site", () => {
    assert.equal(verdict({ origin: "https://evil.example" }), "cross-site");
    assert.equal(verdict({ origin: "null" }), "cross-site");
  });
  test("without PUBLIC_ORIGIN an origin is not guessed at, except null", () => {
    assert.equal(verdict({ origin: "https://evil.example" }, null), "unknown");
    assert.equal(verdict({ origin: "null" }, null), "cross-site");
  });
  test("neither header is unknown, and allowed", () => assert.equal(verdict({}), "unknown"));
});

describe("PUBLIC_ORIGIN", () => {
  test("normalised to scheme and host, or null", () => {
    assert.equal(publicOrigin({ PUBLIC_ORIGIN: "https://faborch-demo.fly.dev/some/path" }), APP);
    assert.equal(publicOrigin({}), null);
    assert.equal(publicOrigin({ PUBLIC_ORIGIN: "not a url" }), null);
  });
});
