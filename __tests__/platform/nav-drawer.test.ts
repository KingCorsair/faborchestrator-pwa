/**
 * The agent drawer, as an architecture rather than as pixels.
 *
 * The interaction — opens, slides, lists real threads, closes — needs a
 * browser, and `scripts/nav-drawer-check.mjs` drives it on the deployment at
 * both phone widths. What this file guards is the set of properties a browser
 * check would never notice going wrong:
 *
 *  1. **The history is FabOrchestrator's, and this app stores none of it.**
 *     No database, no cache, no localStorage. The moment a copy exists here it
 *     is a second source of truth that can disagree with the product.
 *  2. **No id from a browser reaches FO's `/api/chat` unproved.** That route
 *     does not check conversation ownership; this app must not become the
 *     vehicle for the gap.
 *  3. **The drawer is not a second copy of the app's navigation**, and the
 *     navigation it dropped is still reachable on a phone.
 *  4. **The conversation is not the drawer's to reset.**
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
const landing = read("components", "fab", "screens", "landing.tsx");
const chatRoute = read("app", "api", "faborch", "[agent]", "chat", "route.ts");
const listRoute = read("app", "api", "faborch", "conversations", "route.ts");
const oneRoute = read("app", "api", "faborch", "conversations", "[id]", "route.ts");
const owns = read("lib", "faborch", "owns.ts");
const agents = read("lib", "faborch", "agents.ts");

/** Code with documentation stripped: these files necessarily *discuss* the
 *  things they must not *do*, and asserting against raw text would fail on the
 *  explanations rather than on the behaviour. */
const bare = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const code = bare(drawer);

describe("the history is FabOrchestrator's, and only FabOrchestrator's", () => {
  test("this app stores no conversation anywhere", () => {
    for (const file of [drawer, client, chat, listRoute, oneRoute]) {
      assert.ok(!bare(file).includes("localStorage.setItem"), "no thread may be stashed locally");
      assert.ok(!/indexedDB|openDatabase/.test(bare(file)));
    }
  });

  test("no PWA database was introduced", () => {
    // The rule from the plan. A local store would be a second source of truth
    // that silently disagrees with the product it demonstrates.
    for (const forbidden of ["prisma", "sqlite", "better-sqlite3", "drizzle"]) {
      assert.ok(!read("package.json").includes(forbidden), `${forbidden} must not be a dependency`);
    }
  });

  test("the rows shown come from the proxy, not from an invented list", () => {
    assert.match(code, /fetch\("\/api\/faborch\/conversations"/);
    // No literal conversation data anywhere in the file. A seeded list is the
    // exact failure this whole feature exists to avoid — the drawer showed no
    // history for a fortnight rather than showing plausible-looking history.
    assert.ok(!/title:\s*"/.test(code), "no hardcoded conversation title");
    assert.ok(!/isPinned:\s*(true|false)/.test(code), "no hardcoded pin state");
  });

  test("the list route reduces FO's rows before they leave the server", () => {
    // FO's rows carry isShared, model and agent. `toSummaries` is what keeps
    // them off the wire — isShared in particular points at /share/<id>, a page
    // that exists in no upstream branch.
    assert.match(listRoute, /toSummaries/);
    assert.ok(!bare(listRoute).includes("isShared"));
  });

  test("a thread is stripped server-side, never in the browser", () => {
    // 1,306 KB measured for one 18-message thread, almost all tool parts.
    assert.match(oneRoute, /toTurns/);
    assert.ok(!chat.includes("toTurns"), "the screen must receive turns, not raw messages");
    assert.ok(!client.includes("toTurns"));
  });
});

describe("no unproved conversation id reaches FabOrchestrator", () => {
  test("the chat route checks ownership before forwarding", () => {
    // FO's /api/chat has no getConversation and no userId comparison. This is
    // the check that stands in front of it.
    assert.match(chatRoute, /ownsConversation/);
    assert.match(
      chatRoute,
      /agent\.keepsHistory && \(await ownsConversation\(foToken, requested\)\)/,
    );
  });

  test("an unproved id becomes null rather than an error", () => {
    // The operator still gets their answer; it simply is not written down.
    assert.match(chatRoute, /\?\s*requested\s*:\s*null/);
  });

  test("the ownership check fails closed", () => {
    assert.match(owns, /catch\s*\{[\s\S]*?return false/);
  });

  test("the schema accepts the field but does not vouch for it", () => {
    const validation = read("lib", "validation.ts");
    assert.match(validation, /conversationId: z\.string\(\)\.uuid\(\)\.nullish\(\)/);
  });

  test("only pinning may be written to a conversation", () => {
    const validation = read("lib", "validation.ts");
    assert.match(validation, /UpdateConversationSchema = z\.object\(\{\s*isPinned: z\.boolean\(\)/);
    for (const forbidden of ["isShared", "title:", "model:"]) {
      assert.ok(
        !bare(oneRoute).includes(forbidden) || forbidden === "title:",
        `${forbidden} must not be writable from here`,
      );
    }
  });

  test("nothing destructive is exposed", () => {
    for (const file of [listRoute, oneRoute]) {
      assert.ok(!/export async function DELETE/.test(file), "no delete proxy");
    }
  });

  test("the agent bucket is a server constant, never a request field", () => {
    assert.match(listRoute, /const AGENT = "chat"/);
    assert.ok(!bare(listRoute).includes("searchParams.get"));
  });
});

describe("the drawer is a conversation sidebar, not a second navigation", () => {
  test("the app's sections are gone from it", () => {
    for (const label of ["Cockpit", "Agents", "Workflows", "Sites", "Reports"]) {
      assert.ok(!code.includes(`>${label}<`), `nav-drawer.tsx must not list ${label}`);
    }
    assert.ok(!code.includes("NAV.map"), "the nav list must not be rendered here any more");
    assert.ok(!drawer.includes('from "./nav-items"'), "and must not be imported");
  });

  test("one way back, and it is the cockpit", () => {
    assert.match(code, /Back to Cockpit/);
    assert.match(code, /router\.push\("\/"\)/);
  });

  test("the cockpit carries the real navigation, at every width", () => {
    // The reason removing those five entries costs nothing. Before this, the
    // cockpit's own nav was `hidden md:flex` and a phone could reach /reports
    // only from an agent screen.
    assert.ok(!landing.includes('className="hidden items-center gap-1.5 md:flex"'));
    assert.match(landing, /fab-nav-strip order-last flex w-full/);
    assert.match(landing, /NAV\.map/);
  });

  test("the agent screens carry no pill strip at all", () => {
    // FO's own /chat has no top navigation either; the sidebar is the
    // navigation. Nothing is duplicated because nothing is shared.
    assert.match(shell, /hasDrawer \? null : \(/);
  });

  test("Master Data Load is still not a destination", () => {
    for (const forbidden of ["modeling", "Master Data", "master-data"]) {
      assert.ok(!code.includes(forbidden), `nav-drawer.tsx must not link ${forbidden}`);
    }
  });
});

describe("Pinned and Recents are real, or they are absent", () => {
  test("Pinned is not rendered when empty", () => {
    assert.match(code, /pinned\.length > 0 \? \(/);
  });

  test("a failed load degrades the drawer instead of the chat", () => {
    assert.match(code, /could not be loaded from FabOrchestrator/);
    // New chat and Back to Cockpit sit outside the history block, so a failure
    // cannot take them with it.
    const historyBlock = code.slice(code.indexOf("{history ? ("), code.indexOf("Back to Cockpit"));
    assert.ok(!historyBlock.includes("New chat"));
  });

  test("an agent that keeps no history says so rather than showing an empty list", () => {
    assert.match(code, /does not keep conversation history/);
    assert.match(agents, /keepsHistory: false/);
    assert.match(agents, /keepsHistory: true/);
  });

  test("the list is loaded when the drawer opens, not polled", () => {
    assert.match(code, /if \(!open \|\| !history\) return;/);
    assert.ok(!/setInterval/.test(code), "a phone must not poll a database for a closed panel");
  });
});

describe("two threads with the same title stay two rows, and are distinguishable", () => {
  /*
   * Measured on the demo account: 187 conversations, **187 distinct ids**, and
   * "Give me the yield by product." appearing 25 times. Those are genuinely
   * different FabOrchestrator threads asked at different moments, not one
   * thread listed repeatedly — so nothing may be merged or hidden, and the
   * only honest fix is to show what already tells them apart.
   */
  test("rows are keyed by id, so identical titles cannot collapse", () => {
    assert.match(code, /key=\{item\.id\}/);
  });

  test("nothing de-duplicates the list by title", () => {
    for (const forbidden of ["new Set(", "dedupe", "uniqueBy", "filter((r, i, a)"]) {
      assert.ok(!code.includes(forbidden), `the drawer must not collapse rows (${forbidden})`);
    }
  });

  test("each row shows when it was last touched", () => {
    assert.match(code, /whenLabel\(row\.updatedAt\)/);
  });

  test("that label is FO's own timestamp, not an invention", () => {
    // `updatedAt` comes straight off the row `toSummaries` passed through.
    const helper = code.slice(code.indexOf("function whenLabel"));
    assert.match(helper, /new Date\(iso\)/);
    assert.ok(!/Date\.now\(\)\s*-/.test(helper), "no invented relative arithmetic");
  });

  test("an unparseable date shows nothing rather than 1970", () => {
    const helper = code.slice(code.indexOf("function whenLabel"));
    assert.match(helper, /Number\.isNaN\(at\.getTime\(\)\)/);
    assert.match(helper, /if \(!iso\) return "";/);
  });
});

describe("one first send creates exactly one conversation", () => {
  test("creation is guarded by the ref, not by render state", () => {
    // A ref, so two renders in the same tick cannot both pass the check —
    // React Strict Mode double-invokes effects in development.
    assert.match(chat, /if \(agent\.keepsHistory && !conversationRef\.current\)/);
    assert.match(chat, /conversationRef\.current = body\.id/);
  });

  test("it happens inside the send, which is itself guarded", () => {
    // `inFlight` closes the two-Enters-in-one-frame window before any of this
    // runs, so the create cannot be reached twice for one question.
    assert.match(chat, /if \(!prompt \|\| inFlight\.current \|\| !hasFabOrchSession\) return;/);
  });

  test("nothing else in the app creates a conversation", () => {
    // The drawer, the client and the shell must never POST one; only the send
    // path may, and only on the first question.
    for (const [name, src] of [
      ["nav-drawer.tsx", drawer],
      ["agent-chat-client.tsx", client],
      ["app-shell.tsx", shell],
    ] as const) {
      const stripped = bare(src);
      const creates =
        stripped.includes("/api/faborch/conversations") && stripped.includes('method: "POST"');
      assert.ok(!creates, `${name} must not create a conversation`);
    }
  });

  test("New chat creates nothing by itself", () => {
    // It only bumps the key and clears the URL; the next question creates.
    assert.match(client, /setNewChats\(\(n\) => n \+ 1\)/);
    assert.match(client, /setCreatedId\(null\)/);
  });
});

describe("opening the drawer cannot disturb the conversation", () => {
  test("which thread is open lives in the URL, above the shell", () => {
    assert.match(client, /search\.get\("c"\)/);
    // A loaded thread is keyed by its FO id; a new one by the New-chat counter.
    //
    // **This assertion was stale and red on `main` from 5 September.** It still
    // expected `?? "new"`, the literal the key used before a new conversation
    // needed to be told apart from the next one — see `newChats`. The code was
    // corrected during the live-check pass and this was not, and the commit went
    // out on a typecheck, lint, build and browser run without the unit suite.
    // That is the gap: a source-text guard is only as good as the discipline of
    // running it, and it is the one kind of test a green browser check cannot
    // stand in for.
    assert.match(client, /key=\{thread\?\.id \?\? `new-\$\{newChats\}`\}/);
    assert.match(shell, /const \[drawerOpen, setDrawerOpen\] = React\.useState\(false\)/);
  });

  test("a new thread is not re-seeded with ?q=", () => {
    assert.match(client, /initialPrompt=\{selected \? "" : initialPrompt\}/);
  });

  test("a conversation is created on the first send, not on New chat", () => {
    // Otherwise every stray tap leaves an empty "New Chat" row in the
    // FabOrchestrator website's own sidebar.
    assert.match(chat, /if \(agent\.keepsHistory && !conversationRef\.current\)/);
    assert.ok(!bare(drawer).includes("method: \"POST\""), "the drawer creates nothing");
  });

  test("a discarded turn is aborted, not left running", () => {
    assert.match(chat, /React\.useEffect\(\(\) => \(\) => abortRef\.current\?\.abort\(\), \[\]\)/);
  });
});

describe("it is dismissible, and reachable, the way a dialog must be", () => {
  test("Escape, backdrop and a close button all dismiss it", () => {
    assert.match(code, /e\.key === "Escape"/);
    assert.match(code, /aria-label="Close navigation"/);
    assert.match(code, /aria-label="Close"/);
  });

  test("a path change closes it, a query change does not", () => {
    // Picking a conversation changes only `?c=`, and closes the drawer in the
    // row's own handler — keeping the two cases independent.
    assert.match(code, /\[pathname\]\)/);
  });

  test("it is announced as a dialog", () => {
    assert.match(code, /role="dialog"/);
    assert.match(code, /aria-modal="true"/);
    assert.match(code, /aria-label="Conversations"/);
  });

  test("focus goes in on open and comes back on close", () => {
    assert.match(code, /restoreTo\.current\?\.focus\?\.\(\)/);
    assert.match(code, /panelRef\.current\?\.focus\(\)/);
  });

  test("closed means out of the tab order, not merely off-screen", () => {
    // A hundred conversations tabbable from the composer, otherwise.
    assert.match(code, /visibility: open \? "visible" : "hidden"/);
  });
});

describe("it fits a phone", () => {
  test("the panel is capped below the narrowest supported width", () => {
    assert.match(drawer, /min\(288px, 86vw\)/);
  });

  test("every control clears 44px", () => {
    const targets = code.match(/min-h-\[(\d+)px\]/g) ?? [];
    assert.ok(targets.length >= 4, `expected several sized targets, saw ${targets.length}`);
    for (const t of targets) {
      assert.ok(Number(t.replace(/\D/g, "")) >= 44, `touch target ${t} is under 44px`);
    }
  });

  test("the cockpit's pills clear 44px too, now that a phone sees them", () => {
    const pills = landing.match(/min-h-\[44px\] flex-none/g) ?? [];
    assert.ok(pills.length >= 3, `expected the three pill variants, saw ${pills.length}`);
  });

  test("the trigger clears 44px", () => {
    assert.match(shell, /aria-label="Open navigation"[\s\S]{0,400}min-h-\[44px\] min-w-\[44px\]/);
  });

  test("it respects a reduced-motion preference", () => {
    assert.match(code, /motion-reduce:transition-none/);
  });

  test("the thread list scrolls inside the panel", () => {
    assert.match(code, /overflow-y-auto overscroll-contain/);
  });
});
