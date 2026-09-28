/**
 * Source guards for the reliability changes of 2026-09-28.
 *
 * Each of these is a property no unit test can reach without a browser — a
 * React error boundary, the order of two statements in a click handler, a
 * storage read on a screen — and each is the kind of line a well-meant
 * refactor removes. Same approach as `nav-drawer.test.ts` and
 * `credentials.test.ts`: assert against the source, and say why.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("a crash has somewhere to land", () => {
  test("a screen that throws gets the app's crash screen, not Next's bare page", () => {
    assert.ok(existsSync(join(ROOT, "app", "error.tsx")), "app/error.tsx must exist");
    const boundary = read("app", "error.tsx");
    assert.match(boundary, /^"use client";/, "an error boundary must be a client component");
    assert.match(boundary, /<CrashScreen error=\{error\} reset=\{reset\} \/>/);
  });

  test("a root layout that throws is caught too, with its own html and body", () => {
    const global = read("app", "global-error.tsx");
    assert.match(global, /<html/);
    assert.match(global, /<body/);
    assert.match(global, /<CrashScreen/);
  });

  test("an unknown address gets a way back", () => {
    const notFound = read("app", "not-found.tsx");
    assert.match(notFound, /href="\/"/);
  });

  test("the crash screen offers every way on, and reports itself", () => {
    const screen = read("components", "fab", "crash-screen.tsx");
    for (const label of ["Try again", "Go to the cockpit", "Reset and reload"]) {
      assert.ok(screen.includes(label), `missing: ${label}`);
    }
    assert.match(screen, /sendClientErrorReport\(clientErrorReport\(error, window\.location\.pathname/);
    // Made after mount: a random reference rendered twice would not match.
    assert.match(screen, /React\.useState<string \| null>\(null\)/);
  });
});

describe("storage that throws does not take a screen down", () => {
  test("the signed-in screens read it inside a guard", () => {
    const hook = read("components", "fab", "use-session.ts");
    const effect = hook.slice(hook.indexOf("React.useEffect(() => {"));
    const firstRead = effect.indexOf("localStorage.getItem");
    assert.ok(firstRead > 0);
    assert.ok(effect.lastIndexOf("try {", firstRead) !== -1, "the read must sit inside a try");
  });

  test("the sign-in screen reads it inside a guard", () => {
    const page = read("components", "login-page.tsx");
    assert.match(page, /try \{\s*token = localStorage\.getItem\(AUTH_TOKEN_KEY\);/);
  });

  test("and says what is wrong when it cannot keep a session, not 'could not reach the server'", () => {
    const page = read("components", "login-page.tsx");
    assert.match(page, /This browser is blocking the storage sign-in needs/);
  });
});

describe("sign-out cannot hang", () => {
  test("this device is signed out before the server is asked", () => {
    const hook = read("components", "fab", "use-session.ts");
    const body = hook.slice(hook.indexOf("export async function logout"));
    const cleared = body.indexOf("clearAuthStorage();");
    const asked = body.indexOf('fetch("/api/auth/logout"');
    assert.ok(cleared !== -1 && asked !== -1);
    assert.ok(cleared < asked, "clear first — the server may never answer");
  });

  test("and the request to the server has a limit of its own", () => {
    const hook = read("components", "fab", "use-session.ts");
    assert.match(hook, /setTimeout\(\(\) => controller\.abort\(\), SIGN_OUT_WAIT_MS\)/);
  });
});

describe("the wait for an answer to begin is watched", () => {
  test("the screen warns at STALL_MS, and stops watching once the answer begins", () => {
    const chat = read("components", "fab", "screens", "agent-chat.tsx");
    assert.match(chat, /const beginWatch = setTimeout\(\(\) => dispatch\(\{ type: "stalled" \}\), STALL_MS\);/);
    const begin = chat.indexOf("const beginWatch");
    const request = chat.indexOf("fetch(`/api/faborch/${agent.id}/chat`");
    const cleared = chat.indexOf("clearTimeout(beginWatch);");
    assert.ok(begin < request && request < cleared, "set before the request, cleared after it answers");
  });
});

describe("FabOrchestrator is never kept awake by a timer", () => {
  test("Stay signed in is called from a click, and from nothing else", () => {
    const shell = read("components", "fab", "app-shell.tsx");
    assert.equal(shell.match(/stayActive\(/g)?.length, 1, "exactly one call site");
    const call = shell.indexOf("stayActive(token)");
    assert.ok(shell.lastIndexOf("onClick={async () => {", call) > shell.lastIndexOf("setInterval", call));
    assert.ok(!/setInterval\([^)]*stayActive/.test(shell));
  });

  test("the idle clock itself makes one kind of request, and only when asked", () => {
    const activity = read("lib", "fo-activity.ts");
    assert.equal(activity.match(/fetch\(/g)?.length, 1);
    assert.match(activity, /export async function stayActive/);
  });
});

describe("failures are reported, in one shape", () => {
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === "route.ts") routes.push(path);
    }
  };
  walk(join(ROOT, "app", "api"));

  test("no route writes its own console.error any more", () => {
    assert.ok(routes.length >= 8, `found ${routes.length} routes`);
    for (const path of routes) {
      assert.ok(!readFileSync(path, "utf8").includes("console.error"), `${path} bypasses reportError`);
    }
  });

  test("the chat route never answers in the validation library's words", () => {
    const route = read("app", "api", "faborch", "[agent]", "chat", "route.ts");
    assert.ok(!/issues\[0\]\?\.message/.test(route));
  });

  test("the role lookup can never fail a sign-in", () => {
    const route = read("app", "api", "auth", "login", "route.ts");
    assert.match(route, /await foMe\(fo\.token\)\.catch\(\(\) => null\)/);
  });
});
