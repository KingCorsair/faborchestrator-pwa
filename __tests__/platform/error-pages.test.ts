/**
 * The crash screen and the not-found page (plan RP5, "error pages"), rendered
 * rather than read as source text (RP10-A: behaviour, not source assertions).
 *
 * The rule that matters most: an exception's own words never reach the screen.
 * `createElement` rather than JSX so the file matches the suite's `*.test.ts`
 * glob.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CrashScreen } from "../../components/fab/crash-screen";
import NotFound from "../../app/not-found";

const crash = (error: Error & { digest?: string }, reset?: () => void) =>
  renderToStaticMarkup(createElement(CrashScreen, { error, reset }));

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("the crash screen", () => {
  test("never shows the exception's own text", () => {
    const planted = "TypeError: cannot read token fo-secret-123 of undefined";
    const html = crash(new Error(planted), () => {});
    assert.ok(!html.includes("fo-secret-123"), html);
    assert.ok(!html.includes("TypeError"), html);
    assert.match(html, /Something went wrong on this screen/);
  });

  test("shows Next's digest as the reference, and no reference without one", () => {
    const withDigest = Object.assign(new Error("x"), { digest: "3141592653" });
    assert.match(crash(withDigest), /Reference <span[^>]*>3141592653</);
    assert.ok(!crash(new Error("x")).includes("Reference"));
  });

  test("offers try again, the start page, diagnostics and the offline page", () => {
    const html = crash(new Error("x"), () => {});
    assert.match(html, /Try again/);
    assert.match(html, /Reset and reload/);
    assert.deepEqual(hrefs(html).sort(), ["/", "/diagnostics", "/offline"]);
  });

  test("does not claim the crash was reported: nothing reports it", () => {
    assert.ok(!/reported/i.test(crash(new Error("x"))));
  });
});

describe("the not-found page", () => {
  test("says what happened and leads back to the start page", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    assert.match(html, /That page does not exist/);
    assert.ok(hrefs(html).includes("/"), html);
  });
});
