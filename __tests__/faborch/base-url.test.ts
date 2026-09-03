/**
 * The one hop that carries a FabOrchestrator password.
 *
 * Every call to FabOrchestrator is built from `foBaseUrl()` (see `fetchFo`), so
 * this is the only place the transport for that hop can be got wrong. What
 * crosses it: the operator's FO password on sign-in, their session bearer token
 * on every later call, and the plant questions and answers themselves.
 *
 * These tests exist so an insecure production URL cannot be introduced later
 * without a red test. The guard has no override by design.
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { FabOrchNotConfiguredError, foBaseUrl, isFabOrchConfigured } from "../../lib/faborch/client";

const ORIGINAL = process.env.FABORCH_BASE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FABORCH_BASE_URL;
  else process.env.FABORCH_BASE_URL = ORIGINAL;
});

const withUrl = (value: string | undefined) => {
  if (value === undefined) delete process.env.FABORCH_BASE_URL;
  else process.env.FABORCH_BASE_URL = value;
};

/* ── HTTPS is the production case ─────────────────────────────────────────── */

describe("https is accepted", () => {
  test("the deployed FabOrchestrator", () => {
    withUrl("https://d7y8a8whrch88.cloudfront.net");
    assert.equal(foBaseUrl(), "https://d7y8a8whrch88.cloudfront.net");
  });

  test("trailing slashes are stripped, so paths do not double up", () => {
    withUrl("https://fo.example.com///");
    assert.equal(foBaseUrl(), "https://fo.example.com");
  });

  test("a port and a path prefix survive", () => {
    withUrl("https://fo.example.com:8443/faborch");
    assert.equal(foBaseUrl(), "https://fo.example.com:8443/faborch");
  });
});

/* ── The production hazard this guard exists for ──────────────────────────── */

describe("plain http to a remote host is refused", () => {
  // The failure being prevented is silent: over http everything still works,
  // and the operator's FabOrchestrator password is simply readable on the wire.
  for (const value of [
    "http://d7y8a8whrch88.cloudfront.net",
    "http://faborchestrator.internal",
    "http://10.0.0.42:3000",
    "http://192.168.1.50:3000",
    "HTTP://FO.EXAMPLE.COM",
  ]) {
    test(`refuses ${value}`, () => {
      withUrl(value);
      assert.throws(() => foBaseUrl(), FabOrchNotConfiguredError);
      try {
        foBaseUrl();
      } catch (e) {
        // The message has to say what is wrong and why, because the person
        // reading it is fixing a deployment, not debugging an app.
        assert.match((e as Error).message, /plain HTTP/i);
        assert.match((e as Error).message, /password|token/i);
      }
    });
  }

  test("a host that merely starts with 'localhost' is still remote", () => {
    // `localhost.evil.example.com` resolves wherever its owner points it. A
    // `startsWith` or `includes` test would have let this through.
    withUrl("http://localhost.evil.example.com:3000");
    assert.throws(() => foBaseUrl(), FabOrchNotConfiguredError);
  });

  test("a host that merely ends with 'localhost' is still remote", () => {
    withUrl("http://notlocalhost:3000");
    assert.throws(() => foBaseUrl(), FabOrchNotConfiguredError);
  });
});

/* ── The development exception, kept narrow ───────────────────────────────── */

describe("plain http is accepted only for a loopback FabOrchestrator", () => {
  // `.env.example` documents `http://localhost:3000` — a claudeai_athena on the
  // same machine. That traffic never leaves the box, so there is no TLS to have.
  // Keyed on the host rather than NODE_ENV: `npm start` sets NODE_ENV=production
  // for an ordinary local production build, and a loopback address is not
  // reachable from elsewhere by construction, which is the stronger guarantee.
  for (const value of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "http://localhost",
  ]) {
    test(`allows ${value}`, () => {
      withUrl(value);
      assert.equal(foBaseUrl(), value.replace(/\/+$/, ""));
    });
  }

  test("https to localhost is fine too", () => {
    withUrl("https://localhost:3000");
    assert.equal(foBaseUrl(), "https://localhost:3000");
  });
});

/* ── Everything else is a configuration fault, named as one ───────────────── */

describe("malformed and unsupported values", () => {
  test("unset throws, and does not read as a wrong password", () => {
    withUrl(undefined);
    assert.throws(() => foBaseUrl(), FabOrchNotConfiguredError);
  });

  test("a bare host with no scheme is refused rather than guessed at", () => {
    // Guessing https:// here would be a kindness that hides a typo; guessing
    // http:// would be the exact hole this file exists to close.
    withUrl("fo.example.com");
    assert.throws(() => foBaseUrl(), FabOrchNotConfiguredError);
  });

  test("a non-http scheme is refused", () => {
    for (const value of ["ftp://fo.example.com", "file:///etc/passwd", "ws://fo.example.com"]) {
      withUrl(value);
      assert.throws(() => foBaseUrl(), FabOrchNotConfiguredError, value);
    }
  });

  test("whitespace only counts as unset", () => {
    withUrl("   ");
    assert.throws(() => foBaseUrl(), FabOrchNotConfiguredError);
  });
});

/* ── The UI's "is this configured at all?" check ──────────────────────────── */

describe("isFabOrchConfigured", () => {
  test("is true whenever a value is present", () => {
    withUrl("https://fo.example.com");
    assert.equal(isFabOrchConfigured(), true);
  });

  test("is false when unset or blank", () => {
    withUrl(undefined);
    assert.equal(isFabOrchConfigured(), false);
    withUrl("  ");
    assert.equal(isFabOrchConfigured(), false);
  });

  test("reports a present-but-insecure URL as configured", () => {
    // Deliberate: this picks the UI state, and the honest state for a bad
    // scheme is "configured, but the call will fail with a message that says
    // why" — not "nobody set it", which would send an operator to the wrong
    // fix. `foBaseUrl()` is what refuses.
    withUrl("http://fo.example.com");
    assert.equal(isFabOrchConfigured(), true);
    assert.throws(() => foBaseUrl(), FabOrchNotConfiguredError);
  });
});
