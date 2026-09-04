/**
 * The cockpit ask bar, as an architecture rather than as pixels.
 *
 * The behaviour — question stays on the page, sends itself, streams inline,
 * accepts a follow-up — needs a browser and is covered by
 * `scripts/landing-ask-check.mjs`, which drives the deployment. What this file
 * guards is the property that made that change safe to make, and which no
 * browser check would notice going wrong: **the landing page reuses the one
 * conversation implementation instead of growing a second one.**
 *
 * That matters more than it sounds. The send path carries a 45-second stall
 * watchdog, a 401-drops-the-cookie path, a 100-turn cap, an artifact parser
 * kept byte-identical to FabOrchestrator's, and ten mapped failure codes. A
 * second copy on the landing page would be a second place for every one of
 * those to drift, and drift is silent — the copy keeps working while slowly
 * disagreeing with the screen it was copied from.
 *
 * Source is read as text because the thing under test is what the module
 * *imports*, which is not observable from its exports. Same technique, and the
 * same justification, as `service-worker.test.ts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const ask = read("components", "fab", "screens", "landing-ask.tsx");
const chat = read("components", "fab", "screens", "agent-chat.tsx");
const landing = read("components", "fab", "screens", "landing.tsx");

describe("the landing ask bar reuses the conversation, it does not reimplement it", () => {
  test("it renders AgentChat", () => {
    assert.match(ask, /import \{ AgentChat \} from "@\/components\/fab\/screens\/agent-chat"/);
    assert.match(ask, /<AgentChat/);
  });

  test("it owns no part of the send path", () => {
    // Each of these is a moving part of answering a question. Any of them
    // appearing here means the landing page has started answering on its own.
    for (const forbidden of [
      "readFoStream",
      "conversationReducer",
      "createFoStreamParser",
      "segmentMessageText",
      "toFoMessages",
      "/api/faborch/",
    ]) {
      assert.ok(!ask.includes(forbidden), `landing-ask.tsx must not reference ${forbidden}`);
    }
  });

  test("it adds no prompt, model or agent-selection logic", () => {
    // The rule from CLAUDE.md: this app contributes nothing that could change
    // what an answer says. Picking a different agent per question would.
    for (const forbidden of ["systemPrompt", "model:", "FO_AGENTS.backend", "modeling"]) {
      assert.ok(!ask.includes(forbidden), `landing-ask.tsx must not reference ${forbidden}`);
    }
    // Exactly one agent, named once, and it is FabInsight.
    assert.equal(ask.match(/FO_AGENTS\.\w+/g)?.length, 1);
    assert.match(ask, /FO_AGENTS\.insight/);
  });
});

describe("the no-JavaScript front door still works", () => {
  /**
   * The GET form is the whole reason `/` was usable before any bundle arrived,
   * and going inline did not have to cost it: `onSubmit` cancels the navigation
   * only when React is running to cancel it. With scripting off the browser
   * submits the form and the old behaviour happens, unchanged.
   */
  test("the form is still a real GET to /fabinsight", () => {
    assert.match(ask, /method="get"/);
    assert.match(ask, /action="\/fabinsight"/);
    assert.match(ask, /name="q"/);
  });

  test("the chips are still links to the conversation screen", () => {
    assert.match(ask, /href=\{`\/fabinsight\?q=\$\{encodeURIComponent\(chip\)\}`\}/);
  });

  test("a modified click is left to the browser, so a chip still opens in a new tab", () => {
    assert.match(ask, /isModifiedClick/);
    assert.match(ask, /metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/);
  });

  /**
   * Uncontrolled, read through `FormData` at submit. The controlled version of
   * this is the defect `components/login-page.tsx` records: React reconciles a
   * controlled field to its empty state on hydration and erases what was typed
   * in the gap before it. The ask bar is the first thing anybody touches on a
   * cold launch, so it is exactly where that gap gets hit.
   */
  test("the input is uncontrolled and read with FormData", () => {
    assert.match(ask, /new FormData\(e\.currentTarget\)\.get\("q"\)/);
    assert.ok(!/value=\{/.test(ask), "the ask input must not become controlled");
  });
});

describe("the inline variant changes layout and nothing else", () => {
  test("AgentChat takes a variant, and screen is the default", () => {
    assert.match(chat, /variant\?: AgentChatVariant/);
    assert.match(chat, /variant = "screen"/);
  });

  /**
   * The guard that keeps this honest. `inline` may gate CSS classes and whether
   * a presentational block renders; the moment it appears in the send path, the
   * two variants have stopped being the same conversation.
   */
  test("the variant never reaches the send path", () => {
    const send = chat.slice(chat.indexOf("const send"), chat.indexOf("const seeded"));
    assert.ok(send.length > 0, "could not locate the send callback");
    assert.ok(!send.includes("inline"), "the send path must not branch on the variant");
    assert.ok(!send.includes("variant"), "the send path must not branch on the variant");
  });

  test("the initial question is still sent by the existing seeding effect", () => {
    // Not re-implemented for the landing page: `/fabinsight?q=` has always
    // worked this way, and the landing page hands the question to the same prop.
    assert.match(chat, /if \(seeded\.current \|\| !initialPrompt\.trim\(\) \|\| !hasFabOrchSession\) return;/);
    assert.match(ask, /initialPrompt=\{asked\}/);
  });

  test("the transcript is bounded so the cockpit below it stays reachable", () => {
    assert.match(chat, /max-h-\[min\(420px,55vh\)\]/);
    assert.match(chat, /overscroll-contain/);
  });
});

describe("the rest of the cockpit is untouched", () => {
  test("all four agent cards are still declared, with Master Data Load still closed", () => {
    for (const name of [
      "FabInsight™",
      "AI Support Engineer",
      "Master Data Load Agent",
      "Back-end Agent",
    ]) {
      assert.ok(landing.includes(name), `${name} must still be on the cockpit`);
    }
    assert.match(landing, /unavailable: "In FabOrchestrator\. Not part of this app\."/);
  });

  test("the two agent screens still open where they did", () => {
    assert.match(landing, /href: "\/fabinsight"/);
    assert.match(landing, /href: "\/backend-agent"/);
  });
});
