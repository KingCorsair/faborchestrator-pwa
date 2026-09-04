/**
 * The reported iPhone sequence, driven by a real browser.
 *
 * ── What it reproduces ──────────────────────────────────────────────────────
 * Sign in · sign out · force-quit · reopen from the Home Screen. Every step of
 * that has an exact counterpart here, and the one that matters is the third:
 *
 *   force-quit          → `context.close()`, which ends the browser process
 *   Home Screen tap     → a second `launchPersistentContext` on the same
 *                         profile directory, which is a genuinely cold start
 *                         that inherits the cookie jar, `localStorage` and the
 *                         registered service worker, and inherits no page,
 *                         no React tree and no in-memory state
 *   start_url           → the manifest's `/`, navigated to directly
 *
 * That is the whole defect. Nothing in the earlier reports could be reproduced
 * in a tab, because a tab reuses a process that is already running — which is
 * also why `public/sw.js` needed its own cold-start handling in August, and why
 * this file drives a browser rather than making requests.
 *
 * The service worker is deliberately allowed to register and take control
 * before the sign-out, so the relaunch goes through a worker-controlled
 * navigation. A gate that only works when no worker is installed would pass
 * every check in `scripts/gate-live-check.mjs` and fail on the only device
 * anybody is going to look at.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 * It is Chromium with an iPhone viewport, user agent and touch emulation. It
 * is not WebKit, not iOS, and not a home-screen app in a standalone window, so
 * it cannot speak for Safari's cookie handling or for the separate storage an
 * installed iOS app may be given. **It is evidence, not the check.** The
 * physical iPhone run is still the one that decides.
 *
 *   node scripts/cold-launch-check.mjs
 *   APP_URL=https://faborch-demo.fly.dev node scripts/cold-launch-check.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Playwright, from wherever it actually is.
 *
 * Normally `"playwright"` — the devDependency. `PLAYWRIGHT_MODULE` overrides it
 * with a file URL, which is what this repo living inside a OneDrive folder
 * costs: on 2026-09-04 `node_modules/playwright-core/index.js` and `index.mjs`
 * took turns going missing between one command and the next, and the same
 * machine had lost `node.exe` out of `C:\Program Files\nodejs` entirely. An
 * install outside the synced tree is stable; this is the seam that lets one be
 * used without moving the repo.
 */
const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const ROOT = "C:/Users/ATUL ANAND/OneDrive/Documentos/Desktop/AthenaTech/faborchestrator-pwa";
const env = Object.fromEntries(
  fs
    .readFileSync(`${ROOT}/.env`, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const APP = (process.env.APP_URL ?? "http://localhost:3002").replace(/\/$/, "");
const PROFILE = path.join(os.tmpdir(), "faborch-cold-launch-profile");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/**
 * Wait for the app to be *at* a path.
 *
 * Not `waitForURL`, which waits for a navigation to reach `load`. Sign-in and
 * sign-out both move with `router.replace`, a client-side transition that fires
 * no load event — so against the deployment that call sat for its whole timeout
 * while the cockpit was already on screen behind it. Reading `location` inside
 * the page asks the question actually being asked.
 */
const waitForPath = (page, pathname) =>
  page.waitForFunction((p) => location.pathname === p, pathname, { timeout: 60_000 });

/** A fresh install: no cookies, no storage, no worker. */
fs.rmSync(PROFILE, { recursive: true, force: true });

/**
 * One launch of the installed app.
 *
 * `launchPersistentContext` is what makes a launch cold: the profile on disk
 * survives, the process does not.
 */
const launch = async () => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    ...devices["iPhone 13"],
    // Chromium refuses a service worker on plain http from a non-localhost
    // host; the deployment is https, and localhost is trusted, so neither run
    // needs an override. Kept explicit so a failure here is legible.
    ignoreHTTPSErrors: true,
  });

  /**
   * Suppress the "Add to Home Screen" hint.
   *
   * Not a workaround for the automation — it is what the emulated device is
   * being asked to be. The hint renders only on iOS, only when the app is *not*
   * installed, and only until dismissed (`ios-install-hint.tsx`), so the
   * installed app this script is imitating never shows it. Leaving it up would
   * model the wrong device: it is `position: fixed` at the bottom of the
   * viewport, and at phone width it covers both the Sign in button and the
   * cockpit's Sign out link — which is a real thing to know about Safari before
   * installing, and nothing to do with the session gate under test.
   */
  await context.addInitScript(() => {
    try {
      localStorage.setItem("faborch_install_hint_dismissed", "1");
    } catch {
      /* Private mode. The hint will show and the click will be intercepted. */
    }
  });

  return context;
};

console.log(`\ncold launch · ${APP}\n`);

/* ── 1. first launch: sign in ───────────────────────────────────────────── */
console.log("── 1. first launch, then sign in ──────────────────────────────────");

let context = await launch();
let page = await context.newPage();

await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
ok("a first visit to / lands on sign-in", new URL(page.url()).pathname === "/login", page.url());

await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);

/**
 * Wait for Sign in to be enabled before pressing it.
 *
 * `login-page.tsx` holds the button `disabled` until hydration, on purpose: the
 * form paints before `onSubmit` exists, and a button that appears to work and
 * does not is worse than one that is visibly not ready yet. A disabled default
 * button also blocks a form's implicit submission, so Enter in the password
 * field does nothing either — which is what happened here first, silently, on
 * the deployment where hydration takes longer than on localhost.
 */
await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 60_000 });
await page.click('button[type="submit"]');
await waitForPath(page, "/");

const cockpit = await page.content();
ok("signing in lands on the cockpit", new URL(page.url()).pathname === "/", page.url());
ok("…and it is the real one", cockpit.includes("The Nucleus"));

// Let the worker install and take control, so the relaunch is worker-driven.
const controlled = await page.evaluate(async () => {
  if (!navigator.serviceWorker) return "unsupported";
  await navigator.serviceWorker.ready;
  return navigator.serviceWorker.controller ? "controlled" : "registered-not-controlling";
});
ok("a service worker is installed before the relaunch", controlled !== "unsupported", controlled);

/* ── 2. sign out ────────────────────────────────────────────────────────── */
console.log("\n── 2. sign out ────────────────────────────────────────────────────");

await page.click("text=Sign out");
await waitForPath(page, "/login");
ok("sign-out lands on sign-in", new URL(page.url()).pathname === "/login", page.url());

const jarAfter = await context.cookies();
ok(
  "…and the browser is left holding no FabOrchestrator token",
  !jarAfter.some((c) => c.name === "faborch_token" && c.value),
  jarAfter.map((c) => c.name).join(", ") || "(no cookies)",
);

/* ── 3. force-quit, then reopen from the Home Screen ────────────────────── */
console.log("\n── 3. force-quit, then reopen from the Home Screen ────────────────");

await context.close(); // the app switcher swipe
context = await launch(); // the Home Screen tap
page = await context.newPage();

/**
 * Every document the relaunch receives, so the assertion can be about what was
 * *shown* rather than only about where it ended up. The defect was a cockpit
 * appearing for a moment; a check that reads the final URL alone would have
 * passed against the broken build.
 */
const documents = [];
page.on("response", async (res) => {
  if (res.request().resourceType() !== "document") return;
  const body = await res.text().catch(() => "");
  documents.push({ url: res.url(), status: res.status(), showsCockpit: body.includes("The Nucleus") });
});

await page.goto(`${APP}/`, { waitUntil: "networkidle" });

ok(
  "the cold launch settles on sign-in",
  new URL(page.url()).pathname === "/login",
  page.url(),
);
ok(
  "…and no cockpit was painted on the way",
  !documents.some((d) => d.showsCockpit),
  documents.map((d) => `${d.status} ${new URL(d.url).pathname}${d.showsCockpit ? " ⚠cockpit" : ""}`).join(" → "),
);
ok(
  "…and the visible screen is the sign-in form",
  (await page.content()).includes('name="password"'),
);

// Twice more: a gate that lets the second launch through is worse than none,
// because the demo is never the first launch.
for (const attempt of [2, 3]) {
  await context.close();
  context = await launch();
  page = await context.newPage();
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  ok(`launch ${attempt} also lands on sign-in`, new URL(page.url()).pathname === "/login", page.url());
}

await context.close();
fs.rmSync(PROFILE, { recursive: true, force: true });

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}
