/**
 * `safeReturnPath` — what sign-in is allowed to send you to.
 *
 * The landing page now offers three doors, so `/login` carries a `?next=`. That
 * turns a query parameter into a navigation target on the one screen a stranger
 * is expected to trust with a password, on a deployment whose URL is public.
 * These tests are the guard, and most of them are the cases that look like
 * paths and are not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RETURN_PATH, safeReturnPath } from "../../lib/return-path";

test("keeps an ordinary same-origin path", () => {
  assert.equal(safeReturnPath("/activity"), "/activity");
  assert.equal(safeReturnPath("/decisions"), "/decisions");
  assert.equal(safeReturnPath("/orders/PO-10382"), "/orders/PO-10382");
});

test("keeps a query string and a fragment on that path", () => {
  assert.equal(safeReturnPath("/decisions?filter=approved"), "/decisions?filter=approved");
  assert.equal(safeReturnPath("/activity#DEC-0004"), "/activity#DEC-0004");
});

test("falls back when nothing is asked for", () => {
  assert.equal(safeReturnPath(undefined), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath(null), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath(""), DEFAULT_RETURN_PATH);
});

test("takes the first value when the key repeats", () => {
  // `?next=/a&next=/b` reaches the route as an array.
  assert.equal(safeReturnPath(["/activity", "/decisions"]), "/activity");
  assert.equal(safeReturnPath(["https://evil.example", "/activity"]), DEFAULT_RETURN_PATH);
});

test("rejects an absolute URL on another origin", () => {
  assert.equal(safeReturnPath("https://evil.example/pwned"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("http://evil.example"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("javascript:alert(1)"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("data:text/html,<script>"), DEFAULT_RETURN_PATH);
});

test("rejects a protocol-relative URL, which looks like a path", () => {
  // The whole trick: "//evil.example" starts with a slash and leaves the site.
  assert.equal(safeReturnPath("//evil.example"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("//evil.example/orders"), DEFAULT_RETURN_PATH);
});

test("rejects backslashes, which browsers normalise to slashes", () => {
  assert.equal(safeReturnPath("/\\evil.example"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("\\\\evil.example"), DEFAULT_RETURN_PATH);
});

test("rejects control characters a browser strips before navigating", () => {
  // "/\n/evil.example" is "//evil.example" by the time it is resolved.
  assert.equal(safeReturnPath("/\n/evil.example"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("/\t/evil.example"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("/\r/evil.example"), DEFAULT_RETURN_PATH);
});

test("rejects a relative path, which resolves against wherever it lands", () => {
  assert.equal(safeReturnPath("orders"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("../orders"), DEFAULT_RETURN_PATH);
});

test("refuses to send sign-in back to sign-in", () => {
  assert.equal(safeReturnPath("/login"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("/login?next=%2Flogin"), DEFAULT_RETURN_PATH);
  assert.equal(safeReturnPath("/login/"), DEFAULT_RETURN_PATH);
});

test("honours an explicit fallback, so loginHref can ask for none", () => {
  // `loginHref` passes "" to mean "nothing worth carrying", and must not get
  // /orders back and then append it as a redundant ?next=.
  assert.equal(safeReturnPath("https://evil.example", ""), "");
  assert.equal(safeReturnPath("/activity", ""), "/activity");
});
