/**
 * The agent drawer, as an architecture rather than as pixels.
 *
 * The interaction — opens, slides, closes on backdrop and Escape, survives a
 * conversation — needs a browser, and `scripts/nav-drawer-check.mjs` drives it
 * on the deployment at both phone widths. What this file guards is the set of
 * properties a browser check would never notice going wrong:
 *
 *  1. **No invented conversation history.** The drawer's whole risk is that
 *     somebody fills the space where FabOrchestrator shows Recents and Pinned.
 *     This app persists no conversation — `lib/faborch/client.ts` sends no
 *     `conversationId`, so FO's `/api/chat` never writes one — and a list of
 *     thread names here would be a list of fictions. Asserted as an absence,
 *     because an absence is what a future edit will quietly remove.
 *  2. **One nav list.** `nav-items.ts` already feeds the top bar and the
 *     cockpit header. Those two drifted apart once, and the app disagreed with
 *     itself about what the platform offered depending on which page you were
 *     standing on. A third hardcoded copy would be the same bug, cubed.
 *  3. **The conversation is not the drawer's to reset.** The thread key lives
 *     above `AppShell`; the open/closed flag lives inside it. That is the
 *     structural reason opening the drawer cannot clear an answer, and it is
 *     invisible in a screenshot.
 *
 * Source is read as text for the same reason `landing-ask.test.ts` and
 * `service-worker.test.ts` do it: what a module imports, and what it declines
 * to contain, is not observable from its exports.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const drawer = read("components", "fab", "nav-drawer.tsx");
const shell = read("components", "fab", "app-shell.tsx");
const client = read("app", "fabinsight", "agent-chat-client.tsx");
const chat = read("components", "fab", "screens", "agent-chat.tsx");
const navItems = read("components", "fab", "nav-items.ts");

/** The drawer's code, with its documentation stripped out.
 *
 *  The header comment necessarily *discusses* Recents and Pinned — explaining
 *  why they are absent is most of the point. Asserting against the raw file
 *  would therefore fail on its own explanation, so the checks below run against
 *  what actually ships. */
const code = drawer
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the drawer invents no conversation history", () => {
  test("it names no history section", () => {
    for (const forbidden of ["Recents", "Recent chats", "Pinned", "isPinned"]) {
      assert.ok(!code.includes(forbidden), `nav-drawer.tsx must not render ${forbidden}`);
    }
  });

  test("it fetches nothing", () => {
    // A conversation list could only come from FO, and reaching for it is the
    // first step of the thing this change explicitly is not.
    for (const forbidden of ["fetch(", "/api/conversations", "useEffect(() => {\n    fetch"]) {
      assert.ok(!code.includes(forbidden), `nav-drawer.tsx must not reference ${forbidden}`);
    }
  });

  test("no conversation persistence was added anywhere", () => {
    // The one field that would make FO start saving threads. Its absence is
    // what makes "conversations are not saved" a true statement rather than a
    // stale one. `client.ts` documents why it is withheld; this pins it.
    const wire = read("lib", "faborch", "client.ts");
    assert.ok(
      !/conversationId:\s/.test(wire),
      "client.ts must not send conversationId — see docs and CLAUDE.md",
    );
    assert.ok(!chat.includes("conversationId"));
    assert.ok(!drawer.includes("localStorage"), "the drawer must not stash threads either");
  });

  test("it says so, rather than leaving a silent gap", () => {
    // The honest counterpart to the assertions above, and the reason somebody
    // coming from FabOrchestrator does not conclude the screen is broken.
    assert.match(code, /Conversations are not saved/);
  });
});

describe("it reuses the one navigation definition", () => {
  test("the items come from nav-items.ts", () => {
    assert.match(drawer, /import \{ NAV \} from "\.\/nav-items"/);
    assert.match(code, /NAV\.map/);
  });

  test("no label is hardcoded in the drawer", () => {
    // Every destination in the drawer must be one NAV already knows about.
    for (const label of ["Cockpit", "Workflows", "Sites", "Reports"]) {
      assert.ok(navItems.includes(`"${label}"`), `nav-items.ts should define ${label}`);
      assert.ok(!code.includes(`>${label}<`), `nav-drawer.tsx must not hardcode ${label}`);
    }
  });

  test("Master Data Load is not a destination", () => {
    // It is excluded on purpose: FO gates it behind `modeling_agent` and Jothi
    // confirmed on 2 September it does not belong in this app.
    for (const forbidden of ["modeling", "Master Data", "master-data"]) {
      assert.ok(!code.includes(forbidden), `nav-drawer.tsx must not link ${forbidden}`);
    }
  });

  test("an unreachable entry is a span, never a dead link", () => {
    // The same rule the top bar follows, and the defect this app has already
    // been reported for once: a link with no destination is still focusable and
    // still looks pressable.
    assert.match(code, /item\.unavailable/);
    assert.match(code, /aria-disabled="true"/);
  });
});

describe("the drawer belongs to the agent screens only", () => {
  test("the shell shows it only when a conversation is below", () => {
    assert.match(shell, /const hasDrawer = typeof onNewChat === "function"/);
    assert.match(shell, /hasDrawer \? \(/);
  });

  test("both agent doors get it, because both use one client", () => {
    // `/fabinsight` (FabInsight, and the AI Support Engineer card, which has no
    // separate surface) and `/backend-agent`.
    const insight = read("app", "fabinsight", "page.tsx");
    const backend = read("app", "backend-agent", "page.tsx");
    assert.match(insight, /AgentChatClient/);
    assert.match(backend, /AgentChatClient/);
    assert.match(client, /onNewChat=\{/);
  });

  test("/reports passes no callback, so it grows no drawer", () => {
    const reports = read("components", "fab", "screens", "reports.tsx");
    assert.ok(!reports.includes("onNewChat"));
  });
});

describe("opening the drawer cannot disturb the conversation", () => {
  test("the thread key is held above the shell", () => {
    // The structural guarantee. `thread` is state in the client; `drawerOpen`
    // is state in the shell. Toggling the second cannot change the first.
    assert.match(client, /const \[thread, setThread\] = React\.useState\(0\)/);
    assert.match(client, /key=\{thread\}/);
    assert.match(shell, /const \[drawerOpen, setDrawerOpen\] = React\.useState\(false\)/);
  });

  test("New chat only bumps that key", () => {
    assert.match(client, /onNewChat=\{\(\) => setThread\(\(n\) => n \+ 1\)\}/);
  });

  test("a new thread is not re-seeded with ?q=", () => {
    // Otherwise asking for a blank conversation would immediately re-ask the
    // question the URL carried.
    assert.match(client, /thread === 0 \? initialPrompt : ""/);
  });

  test("a discarded turn is aborted, not left running", () => {
    assert.match(chat, /React\.useEffect\(\(\) => \(\) => abortRef\.current\?\.abort\(\), \[\]\)/);
  });
});

describe("it is dismissible, and reachable, the way a dialog must be", () => {
  test("Escape closes it", () => {
    assert.match(code, /e\.key === "Escape"/);
  });

  test("the backdrop is a real control, not a div with a handler", () => {
    assert.match(code, /aria-label="Close navigation"/);
  });

  test("there is a close button as well", () => {
    assert.match(code, /aria-label="Close"/);
  });

  test("a route change closes it", () => {
    assert.match(code, /\[pathname\]\)/);
  });

  test("it is announced as a dialog", () => {
    assert.match(code, /role="dialog"/);
    assert.match(code, /aria-modal="true"/);
    assert.match(code, /aria-label="Navigation"/);
  });

  test("focus goes in on open and comes back on close", () => {
    assert.match(code, /restoreTo\.current\?\.focus\?\.\(\)/);
    assert.match(code, /panelRef\.current\?\.focus\(\)/);
  });

  test("closed means out of the tab order, not merely off-screen", () => {
    // `-translate-x-full` alone leaves five links tabbable from the composer.
    assert.match(code, /visibility: open \? "visible" : "hidden"/);
  });
});

describe("it fits a phone", () => {
  test("the panel is capped below the narrowest supported width", () => {
    // FO's own SIDEBAR_WIDTH_MOBILE is 18rem; 86vw keeps a backdrop to tap at
    // 360px, where a flat 288px would leave 72px and a fixed 18rem in `vw`
    // terms would not scale at all.
    assert.match(drawer, /min\(288px, 86vw\)/);
  });

  test("every control clears 44px", () => {
    const targets = code.match(/min-h-\[(\d+)px\]/g) ?? [];
    assert.ok(targets.length >= 4, `expected several sized targets, saw ${targets.length}`);
    for (const t of targets) {
      const px = Number(t.replace(/\D/g, ""));
      assert.ok(px >= 44, `touch target ${t} is under 44px`);
    }
  });

  test("the trigger clears 44px too", () => {
    assert.match(shell, /aria-label="Open navigation"[\s\S]{0,400}min-h-\[44px\] min-w-\[44px\]/);
  });

  test("it respects a reduced-motion preference", () => {
    assert.match(code, /motion-reduce:transition-none/);
  });

  test("the duplicate mobile nav row is dropped only where the drawer replaces it", () => {
    // Below `sm` the pill strip is a full-width second row carrying the same
    // five destinations. It stays at `sm` and above, and on screens with no
    // drawer it is untouched.
    assert.match(shell, /hasDrawer && "hidden sm:flex"/);
  });
});
