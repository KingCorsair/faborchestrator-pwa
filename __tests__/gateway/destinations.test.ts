/**
 * Where this app's own navigation points — the WP9 cutover
 * (`lib/gateway/destinations.ts`).
 *
 * WP1–WP8 made FabOrchestrator's real chat work on this origin. Nothing made
 * anybody *arrive* there: every chat link on the cockpit still pointed at this
 * app's own `/fabinsight`, and WP5's manual pass found that the hard way — a
 * tester followed the cockpit, landed on the old screen, and reported a missing
 * download that the real screen has.
 *
 * The property these hold is a pair, and it is the pair that matters:
 * **with the gateway serving FabOrchestrator's chat, every door opens it; with
 * the flag off, every door opens this app's own screen exactly as before.** A
 * cutover that could not be reversed by the same switch would not be a cutover,
 * it would be a rewrite.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  chatHref,
  chatIsEmbedded,
  frontDoorRedirect,
  RETIRED_CHAT_SCREENS,
  retiredScreenRedirect,
} from "@/lib/gateway/destinations";
import { navItems } from "@/components/fab/nav-items";
import { classify, readRegistry } from "@/lib/gateway/registry";

/** The registry as it is with the flag in a given state. */
const withFlag = (value?: string) => readRegistry({ FO_EMBED_SURFACES: value });

const OFF = withFlag(undefined);
const EMPTY = withFlag("");
const CHAT = withFlag("/chat");
const BOTH = withFlag("/chat,/reports");
const REPORTS_ONLY = withFlag("/reports");
const WHOLE = readRegistry({ FO_EMBED_MODE: "whole" });

describe("where a chat link points", () => {
  test("at FabOrchestrator's chat once the gateway serves it", () => {
    assert.equal(chatHref(CHAT), "/chat");
    assert.equal(chatHref(BOTH), "/chat");
    assert.equal(chatIsEmbedded(BOTH), true);
  });

  test("at this app's own screen when it does not", () => {
    assert.equal(chatHref(OFF), "/fabinsight");
    assert.equal(chatHref(EMPTY), "/fabinsight");
    assert.equal(chatIsEmbedded(OFF), false);
  });

  test("the Dashboard alone does not move the chat", () => {
    // WP7 put `/reports` behind the flag on its own. Enabling it must not
    // silently hand the chat over too — the two surfaces are independent, and
    // an operator whose Reports were embedded but whose chat was not would
    // otherwise be sent to a `/chat` this origin answers 404 for.
    assert.equal(chatHref(REPORTS_ONLY), "/fabinsight");
    assert.equal(chatIsEmbedded(REPORTS_ONLY), false);
  });

  test("a variable of nothing but typos changes nothing", () => {
    assert.equal(chatHref(withFlag("/chatt,/reprots")), "/fabinsight");
  });
});

describe("the retired screens", () => {
  test("are sent to FabOrchestrator's chat while it is being served", () => {
    for (const screen of RETIRED_CHAT_SCREENS) {
      assert.equal(retiredScreenRedirect(screen, BOTH), "/chat");
    }
    // Both of this app's agent screens go to the same place, because in
    // FabOrchestrator they are the same place — AGENT · 01 and AGENT · 04 both
    // route to `/chat` there.
    assert.deepEqual([...RETIRED_CHAT_SCREENS], ["/fabinsight", "/backend-agent"]);
  });

  test("are left alone with the flag off — that is the rollback", () => {
    for (const screen of RETIRED_CHAT_SCREENS) {
      assert.equal(retiredScreenRedirect(screen, OFF), null);
      assert.equal(retiredScreenRedirect(screen, EMPTY), null);
    }
  });

  test("and nothing else is redirected, in either state", () => {
    for (const registry of [OFF, CHAT, BOTH]) {
      for (const path of ["/", "/login", "/reports", "/diagnostics", "/offline", "/chat"]) {
        assert.equal(retiredScreenRedirect(path, registry), null, `${path} must not be redirected`);
      }
    }
  });

  test("a sub-path of a retired screen is not swept up with it", () => {
    // Only the screens themselves are retired. A path that merely starts with
    // one is a different route, and guessing at it would be this app deciding
    // it owns URLs it has never served.
    assert.equal(retiredScreenRedirect("/fabinsight/extra", BOTH), null);
    assert.equal(retiredScreenRedirect("/fabinsightx", BOTH), null);
  });
});

describe("the Agents nav entry follows the same decision", () => {
  test("it points wherever the chat lives, and Reports never moves", () => {
    const embedded = navItems(chatHref(BOTH));
    const own = navItems(chatHref(OFF));

    assert.equal(embedded.find((i) => i.label === "Agents")?.href, "/chat");
    assert.equal(own.find((i) => i.label === "Agents")?.href, "/fabinsight");

    // `/reports` is the same URL in both worlds — the flag decides which
    // application answers it, which is the collision WP7 resolved.
    for (const items of [embedded, own]) {
      assert.equal(items.find((i) => i.label === "Reports")?.href, "/reports");
      assert.equal(items.find((i) => i.label === "Cockpit")?.href, "/");
    }
  });

  test("the sections themselves are unchanged by the cutover", () => {
    const labels = (chat: string) => navItems(chat).map((i) => i.label);
    assert.deepEqual(labels("/chat"), labels("/fabinsight"));
    assert.deepEqual(labels("/chat"), ["Cockpit", "Agents", "Workflows", "Sites", "Reports"]);
  });

  test("the two placeholders stay greyed in both states", () => {
    for (const chat of ["/chat", "/fabinsight"]) {
      const greyed = navItems(chat).filter((i) => i.unavailable);
      assert.deepEqual(greyed.map((i) => i.label), ["Workflows", "Sites"]);
    }
  });
});

/**
 * The front door, after the audit reversed it.
 *
 * Until 9 September this app answered FabOrchestrator's "back to the overview"
 * with its own hand-built cockpit, and `/home` was translated away. The audit
 * found that backwards: the product is an installable delivery of
 * FabOrchestrator, so the cockpit is **FabOrchestrator's**, and `/` leads to it.
 *
 * The property under test is the pair that makes the migration safe: **`/`
 * leads into FabOrchestrator only when FabOrchestrator is actually serving its
 * cockpit here**, and never otherwise — because a front door that redirects to a
 * page this origin answers 404 for is the worst failure the app can have.
 */
describe("the front door", () => {
  test("leads to FabOrchestrator's cockpit when FabOrchestrator serves it", () => {
    assert.equal(frontDoorRedirect("/", WHOLE), "/home");
    assert.equal(frontDoorRedirect("/", withFlag("/chat,/home")), "/home");
  });

  test("stays this app's own screen when it does not", () => {
    // `surfaces` mode without `/home`: the cockpit is still this app's, and the
    // front door must not point at a path that would 404.
    assert.equal(frontDoorRedirect("/", BOTH), null);
    assert.equal(frontDoorRedirect("/", CHAT), null);
    assert.equal(frontDoorRedirect("/", REPORTS_ONLY), null);
  });

  test("and does nothing at all with the embedding off — the rollback", () => {
    assert.equal(frontDoorRedirect("/", OFF), null);
    assert.equal(frontDoorRedirect("/", EMPTY), null);
  });

  test("only the root is redirected", () => {
    for (const path of ["/home", "/chat", "/login", "/reports", "/anything"]) {
      assert.equal(frontDoorRedirect(path, WHOLE), null, `${path} must not be redirected`);
    }
  });
});

/**
 * Whole-application embedding: what the audit corrected.
 *
 * Two of FabOrchestrator's ten pages were served while forty-eight of its
 * fifty-two API routes already were. The gateway was general and pointed at two
 * paths. `whole` mode inverts the **document** default only — the API stays an
 * explicit allow-list, which is the security constraint Amay set.
 */
describe("whole-application mode", () => {
  test("a page nobody listed is FabOrchestrator's", () => {
    // The pages that used to 404 — including the ones its own sidebar links to.
    for (const page of ["/home", "/settings", "/modeling-agent", "/modeling-agent/loader", "/force-password-change"]) {
      assert.equal(classify(page, WHOLE), "fo-document", page);
    }
    // And a page FabOrchestrator has not shipped yet, which is the whole point:
    // it appears without an edit here.
    assert.equal(classify("/workflows", WHOLE), "fo-document");
    assert.equal(classify("/some-page-nobody-has-written-yet", WHOLE), "fo-document");
  });

  test("but the API does NOT invert — an unlisted endpoint is still refused", () => {
    assert.equal(classify("/api/scheduling", WHOLE), "unknown");
    assert.equal(classify("/api/anything-new", WHOLE), "unknown");
    assert.equal(classify("/api", WHOLE), "unknown");
    // A listed one is forwarded, as before.
    assert.equal(classify("/api/conversations/abc/messages", WHOLE), "fo-api");
  });

  test("the denied endpoints stay denied, whole mode or not", () => {
    for (const registry of [WHOLE, BOTH]) {
      for (const path of [
        "/api/auth/login",
        "/api/auth/register",
        "/api/auth/password-reset",
        "/api/auth/password-reset/confirm",
        "/api/fabinsight/cron/tick",
        "/api/fabinsight/schema",
        "/forgot-password",
        "/reset-password",
      ]) {
        assert.equal(classify(path, registry), "denied", path);
      }
    }
  });

  test("this app keeps what it exists to provide", () => {
    for (const path of [
      "/", "/login", "/offline", "/diagnostics",
      "/sw.js", "/manifest.webmanifest", "/icon-192.png", "/apple-touch-icon.png",
      "/fo-shell.js", "/pwa-assets/_next/static/chunks/a.js",
      "/api/pwa/auth/me", "/api/faborch/reports",
    ]) {
      assert.equal(classify(path, WHOLE), "pwa", path);
    }
  });

  test("/reports goes to FabOrchestrator in whole mode and to this app otherwise", () => {
    assert.equal(classify("/reports", WHOLE), "fo-document");
    assert.equal(classify("/reports", BOTH), "fo-document"); // listed
    assert.equal(classify("/reports", CHAT), "pwa");          // not listed
    assert.equal(classify("/reports", OFF), "pwa");
  });

  test("this app's own agent screens are never forwarded", () => {
    // FabOrchestrator has no page at either path; forwarding would proxy a 404.
    for (const path of ["/fabinsight", "/backend-agent"]) {
      assert.equal(classify(path, WHOLE), "pwa", path);
    }
  });
});
