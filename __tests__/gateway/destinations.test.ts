/**
 * Where this app's own addresses lead (`lib/gateway/destinations.ts`).
 *
 * The old chat screens are gone, so their addresses go to FabOrchestrator's
 * `/chat`; the front door goes to FabOrchestrator's cockpit, `/home`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { frontDoorRedirect, RETIRED_CHAT_SCREENS, retiredScreenRedirect } from "@/lib/gateway/destinations";

describe("the removed chat screens", () => {
  test("are sent to FabOrchestrator's chat", () => {
    for (const screen of RETIRED_CHAT_SCREENS) {
      assert.equal(retiredScreenRedirect(screen), "/chat");
    }
    assert.deepEqual([...RETIRED_CHAT_SCREENS], ["/fabinsight", "/backend-agent"]);
  });

  test("nothing else is redirected", () => {
    for (const path of ["/", "/login", "/reports", "/diagnostics", "/offline", "/chat"]) {
      assert.equal(retiredScreenRedirect(path), null, `${path} must not be redirected`);
    }
  });

  test("a sub-path of a removed screen is not swept up with it", () => {
    // Only the screens themselves are redirected. A path that merely starts
    // with one is a different route, and guessing at it would be this app
    // deciding it owns URLs it has never served.
    assert.equal(retiredScreenRedirect("/fabinsight/extra"), null);
    assert.equal(retiredScreenRedirect("/fabinsightx"), null);
  });
});

describe("the front door", () => {
  test("leads to FabOrchestrator's cockpit", () => {
    assert.equal(frontDoorRedirect("/"), "/home");
  });

  test("only the root is redirected", () => {
    for (const path of ["/home", "/chat", "/login", "/reports", "/anything"]) {
      assert.equal(frontDoorRedirect(path), null, `${path} must not be redirected`);
    }
  });
});
