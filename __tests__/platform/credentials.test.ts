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

import { submittedCredentials } from "../../lib/credentials";

/** A stand-in for `FormData`, which node:test has no DOM to build. */
const form = (fields: Record<string, string>) => ({
  get: (key: string) => (key in fields ? fields[key] : null),
});

const EMPTY_STATE = { email: "", password: "" };

describe("sign-in submits what is in the fields", () => {
  test("the DOM wins when React state is empty — the bug", () => {
    // Typing landed before hydration: the field has it, state does not.
    const got = submittedCredentials(
      form({ email: "supervisor@athenatech.example", password: "hunter2hunter2" }),
      EMPTY_STATE,
    );
    assert.equal(got.email, "supervisor@athenatech.example");
    assert.equal(got.password, "hunter2hunter2");
  });

  test("state is the fallback when the form carries nothing", () => {
    // A browser that submitted without populating FormData at all.
    const got = submittedCredentials(form({}), {
      email: "typed@athenatech.example",
      password: "fromstate",
    });
    assert.equal(got.email, "typed@athenatech.example");
    assert.equal(got.password, "fromstate");
  });

  test("the two agree in the ordinary case", () => {
    const got = submittedCredentials(
      form({ email: "a@b.example", password: "pw" }),
      { email: "a@b.example", password: "pw" },
    );
    assert.deepEqual(got, { email: "a@b.example", password: "pw" });
  });

  test("a trailing space on the email is trimmed", () => {
    // A phone keyboard adds one readily, and the API rejects the address for a
    // reason nobody could guess from the screen.
    assert.equal(
      submittedCredentials(form({ email: "  a@b.example \n" }), EMPTY_STATE).email,
      "a@b.example",
    );
  });

  test("the password is NOT trimmed", () => {
    // Spaces are legitimate password characters. Silently stripping them turns
    // a correct credential into a failed sign-in, which is worse than the bug
    // this module exists to fix.
    assert.equal(
      submittedCredentials(form({ email: "a@b.example", password: "  pad  " }), EMPTY_STATE)
        .password,
      "  pad  ",
    );
  });

  test("an all-whitespace email falls back rather than submitting blanks", () => {
    assert.equal(
      submittedCredentials(form({ email: "   " }), { email: "real@b.example", password: "p" })
        .email,
      "real@b.example",
    );
  });

  test("missing everywhere stays empty, so the API's own message stands", () => {
    // Not this module's job to invent a validation error; the route already
    // says "Email is required" and that is the right message when it is true.
    assert.deepEqual(submittedCredentials(form({}), EMPTY_STATE), { email: "", password: "" });
  });
});
