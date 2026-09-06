/**
 * An answer's list markers, which are part of the answer.
 *
 * ── The bug this exists to prevent coming back ──────────────────────────────
 * Tailwind's preflight sets `list-style: none` on every `ul` and `ol`
 * (`node_modules/tailwindcss/preflight.css:205`). `.fab-md` restored the indent
 * and, until 5 September, not the marker — so every numbered step in an answer
 * rendered without its number.
 *
 * Measured on the deployment: FabOrchestrator returned six numbered steps with
 * two sub-bullets each, 2,137 characters. The PWA showed 2,041 characters and
 * **none of `1.` through `6.`**, identically at 360x640, 390x844 and desktop,
 * with `scrollHeight === clientHeight` — nothing clipped, nothing scrolled out
 * of view. The words were all there and the procedure was not.
 *
 * ── Why a stylesheet is tested as text ──────────────────────────────────────
 * Because the failure is silent and total. There is no exception, no empty
 * element and no console warning; the markup is correct and the browser is
 * told not to draw the marker. Nothing but a rule that reads the rule catches
 * it, and `scripts/answer-render-check.mjs` is the counterpart that proves the
 * markers actually appear in a browser.
 *
 * The same technique, and the same justification, as `service-worker.test.ts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");

/** The `.fab-md` rules, with comments stripped — this file's prose discusses
 *  `list-style: none`, and matching against that would test the explanation. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every declaration that applies to one selector, concatenated.
 *
 * Selector lists are split rather than substring-matched. A naive
 * `indexOf(".fab-md ol {")` finds that string inside `.fab-md ul,\n.fab-md ol {`
 * and returns the *padding* rule, which is how the first version of this file
 * reported three failures against correct CSS.
 *
 * Concatenated across rules because a selector legitimately appears more than
 * once — `.fab-md ol` carries its padding in one block and its marker in
 * another, and both are "what applies to it".
 */
function declarationsFor(selector: string): string {
  const found: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rules)) !== null) {
    const selectors = match[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) found.push(match[2]);
  }
  return found.join("\n");
}

describe("an ordered list keeps its numbers", () => {
  test("`.fab-md ol` sets a list style", () => {
    const decl = declarationsFor(".fab-md ol");
    assert.ok(decl.trim(), "`.fab-md ol` must carry declarations");
    assert.match(decl, /list-style(-type)?:\s*decimal/);
  });

  test("…and it is not `none`", () => {
    // The exact regression: preflight's `none` left in place.
    const decl = declarationsFor(".fab-md ol");
    assert.ok(!/list-style(-type)?:\s*none/.test(decl));
  });
});

describe("a bullet list keeps its bullets", () => {
  test("`.fab-md ul` sets a list style", () => {
    const decl = declarationsFor(".fab-md ul");
    assert.ok(decl.trim(), "`.fab-md ul` must carry declarations");
    assert.match(decl, /list-style(-type)?:\s*disc/);
  });

  test("a nested list is visually distinct from its parent", () => {
    // `list-style-type` inherits, so without this a sub-bullet takes the
    // parent's marker instead of the browser's usual alternation.
    assert.match(declarationsFor(".fab-md ul ul"), /list-style-type:\s*circle/);
    assert.match(declarationsFor(".fab-md ol ol"), /list-style-type:\s*lower-alpha/);
  });
});

describe("the indent that was already right", () => {
  test("lists are still indented, so a marker has somewhere to sit", () => {
    // `list-style: outside` puts the marker in the padding. Zero padding would
    // clip it against the container edge — the marker present and invisible,
    // which is the same defect wearing a different hat.
    assert.match(declarationsFor(".fab-md ol"), /padding-left:\s*20px/);
    assert.match(declarationsFor(".fab-md ul"), /padding-left:\s*20px/);
  });
});

describe("nothing in `.fab-md` hides content", () => {
  test("no max-height and no `overflow: hidden` on the answer body", () => {
    // The other way an answer can go missing: present in the DOM, clipped by
    // its container. The measurement said this was not happening; this keeps it
    // that way. `pre` and `table` scroll on purpose and are exempt.
    const fabMd = declarationsFor(".fab-md");
    assert.ok(!/max-height/.test(fabMd));
    assert.ok(!/overflow:\s*hidden/.test(fabMd));
  });

  test("the wide elements scroll rather than clip", () => {
    assert.match(declarationsFor(".fab-md pre"), /overflow-x:\s*auto/);
  });
});
