/**
 * The sign-in limiter.
 *
 * These pin the two properties that make it worth having and the one that makes
 * it safe to have: an attacker is stopped, a real operator never is, and the
 * window actually expires rather than locking somebody out forever.
 *
 * It matters more than a normal Tier-0 unit test because `/api/auth/login`
 * forwards to a **real** FabOrchestrator, so this code is what stands between a
 * public demo URL and a production identity store. See `lib/rate-limit.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_RATE_LIMIT,
  checkLoginAllowed,
  clearLoginFailures,
  clientAddress,
  recordLoginFailure,
  resetLoginFailures,
} from "../../lib/rate-limit";

const { MAX_FAILURES, WINDOW_MS } = LOGIN_RATE_LIMIT;

test("a fresh address is allowed", () => {
  resetLoginFailures();
  assert.equal(checkLoginAllowed("1.2.3.4").allowed, true);
});

test("the limit is reached only after MAX_FAILURES wrong guesses", () => {
  resetLoginFailures();
  for (let i = 0; i < MAX_FAILURES - 1; i++) {
    recordLoginFailure("1.2.3.4");
    assert.equal(checkLoginAllowed("1.2.3.4").allowed, true, `blocked early at guess ${i + 1}`);
  }
  recordLoginFailure("1.2.3.4");
  assert.equal(checkLoginAllowed("1.2.3.4").allowed, false, "should be blocked on the last one");
});

test("a blocked address is told how long to wait", () => {
  resetLoginFailures();
  for (let i = 0; i < MAX_FAILURES; i++) recordLoginFailure("1.2.3.4");
  const verdict = checkLoginAllowed("1.2.3.4");
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.retryAfterSeconds > 0, "a block with no retry time is unactionable");
  assert.ok(verdict.retryAfterSeconds <= Math.ceil(WINDOW_MS / 1000));
});

test("the window expires rather than locking somebody out forever", () => {
  resetLoginFailures();
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_FAILURES; i++) recordLoginFailure("1.2.3.4", t0);
  assert.equal(checkLoginAllowed("1.2.3.4", t0).allowed, false);
  // One millisecond before the window closes it is still blocked...
  assert.equal(checkLoginAllowed("1.2.3.4", t0 + WINDOW_MS - 1).allowed, false);
  // ...and at the boundary it clears.
  assert.equal(checkLoginAllowed("1.2.3.4", t0 + WINDOW_MS).allowed, true);
});

test("addresses are counted separately", () => {
  resetLoginFailures();
  for (let i = 0; i < MAX_FAILURES; i++) recordLoginFailure("1.2.3.4");
  assert.equal(checkLoginAllowed("1.2.3.4").allowed, false);
  assert.equal(checkLoginAllowed("5.6.7.8").allowed, true, "one attacker must not lock out everyone");
});

test("a correct password clears the counter", () => {
  // The property that keeps this from being a nuisance: somebody who mistypes
  // their password seven times and then gets it right is not left one guess
  // from a ten-minute wait for the rest of the window.
  resetLoginFailures();
  for (let i = 0; i < MAX_FAILURES - 1; i++) recordLoginFailure("1.2.3.4");
  clearLoginFailures("1.2.3.4");
  for (let i = 0; i < MAX_FAILURES - 1; i++) recordLoginFailure("1.2.3.4");
  assert.equal(checkLoginAllowed("1.2.3.4").allowed, true);
});

test("failures older than the window do not accumulate", () => {
  resetLoginFailures();
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_FAILURES - 1; i++) recordLoginFailure("1.2.3.4", t0);
  // A guess after the window starts a fresh count rather than topping up an
  // expired one — otherwise one wrong guess a day would eventually block a user.
  recordLoginFailure("1.2.3.4", t0 + WINDOW_MS + 1);
  assert.equal(checkLoginAllowed("1.2.3.4", t0 + WINDOW_MS + 1).allowed, true);
});

test("the client address prefers fly-client-ip over the forgeable header", () => {
  // `x-forwarded-for` is caller-supplied. If it won, an attacker would rotate it
  // per request and never be counted twice — i.e. no limiter at all.
  const headers = new Headers({
    "fly-client-ip": "9.9.9.9",
    "x-forwarded-for": "1.1.1.1, 2.2.2.2",
  });
  assert.equal(clientAddress(headers), "9.9.9.9");
});

test("x-forwarded-for is used when fly-client-ip is absent, first entry only", () => {
  assert.equal(clientAddress(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })), "1.1.1.1");
});

test("with no proxy headers every caller shares one bucket", () => {
  // Local development: one caller, so one bucket is correct rather than a hole.
  assert.equal(clientAddress(new Headers()), "local");
});
