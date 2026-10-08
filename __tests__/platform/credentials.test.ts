/**
 * Sign-in submits what the operator typed, not what React managed to record.
 *
 * The defect: the fields are controlled inputs, so before React hydrates the
 * page is server-rendered HTML that accepts typing with no `onChange` attached.
 * State stayed empty while the field visibly held an email, the form submitted
 * `{ email: "" }`, and the operator was told **"Email is required"** while
 * looking straight at their own address.
 *
 * It was found on the Fly deployment and is invisible on localhost, where
 * hydration is too fast to race. That is exactly why it is pinned here rather
 * than left to a browser check: the browser checks all passed while it was
 * broken.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { submittedCredentials } from "../../lib/credentials";

/** A stand-in for `FormData`, which node:test has no DOM to build. */
const form = (fields: Record<string, string>) => ({
  get: (key: string) => (key in fields ? fields[key] : null),
});

describe("sign-in submits what is in the fields", () => {
  test("the fields are read, not React state — the bug", () => {
    // The fields are uncontrolled precisely so that typing which lands before
    // hydration is still there at submit. This reads them.
    const got = submittedCredentials(
      form({ email: "supervisor@athenatech.example", password: "hunter2hunter2" }),
    );
    assert.equal(got.email, "supervisor@athenatech.example");
    assert.equal(got.password, "hunter2hunter2");
  });

  test("a trailing space on the email is trimmed", () => {
    // A phone keyboard adds one readily, and the API rejects the address for a
    // reason nobody could guess from the screen.
    assert.equal(submittedCredentials(form({ email: "  a@b.example  " })).email, "a@b.example");
  });

  test("the password is NOT trimmed", () => {
    // Spaces are legitimate password characters. Silently stripping them turns
    // a correct credential into a failed sign-in, which is worse than the bug
    // this module exists to fix.
    assert.equal(
      submittedCredentials(form({ email: "a@b.example", password: "  pad  " })).password,
      "  pad  ",
    );
  });

  test("missing fields stay empty, so the API's own message stands", () => {
    // Not this module's job to invent a validation error; the route already
    // says "Email is required" and that is the right message when it is true.
    assert.deepEqual(submittedCredentials(form({})), { email: "", password: "" });
  });

  test("an all-whitespace email is empty, not whitespace", () => {
    assert.equal(submittedCredentials(form({ email: "   " })).email, "");
  });
});

/* ── The regression that fixing it introduced ─────────────────────────────── */

describe("a submit that escapes React must not leak the credential", () => {
  /**
   * Giving the fields `name` attributes — needed so the handler can read the
   * DOM — also made the form natively submittable. A click landing before
   * hydration is handled by the browser, not by React, and a form defaults to
   * **GET**: the deployed app put `?email=…&password=…` in the address bar,
   * where it reaches history, logs and referrer headers.
   *
   * Two things stop it, and both are asserted against the source because
   * neither is reachable without a DOM:
   *
   *   1. the submit button is disabled until React has attached — prevention
   *   2. `method="post"` — so a submission that still escapes carries the
   *      credential in a body that nothing serves, not in a URL
   */
  const source = readFileSync(
    new URL("../../components/login-page.tsx", import.meta.url),
    "utf8",
  );

  test("the form is POST, so a stray native submit cannot build a URL", () => {
    assert.match(
      source,
      /<form[\s\S]{0,2000}?method="post"/,
      'the login form must set method="post"',
    );
  });

  test("the submit button waits for hydration", () => {
    assert.match(
      source,
      /disabled=\{busy \|\| !hydrated\}/,
      "the submit button must be disabled until React has attached",
    );
    assert.match(source, /setHydrated\(true\)/, "and something must set that flag");
  });

  test("the fields are named, or FormData reads nothing", () => {
    assert.match(source, /name="email"/);
    assert.match(source, /name="password"/);
  });

  test("and they are uncontrolled, or hydration erases what was typed", () => {
    // A `value={...}` on either credential field re-binds it to state that does
    // not exist until React attaches, and hydration then wipes anything typed
    // into the server-rendered page. That was the bug.
    assert.ok(
      !/value=\{email\}/.test(source) && !/value=\{password\}/.test(source),
      "the credential fields must stay uncontrolled",
    );
  });
});
