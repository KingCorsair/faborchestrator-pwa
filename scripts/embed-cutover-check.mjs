/**
 * WP9 — the cutover, walked rather than asserted.
 *
 * Every earlier embedding check reaches FabOrchestrator by *typing the URL*.
 * That is exactly the habit that hid the problem WP9 exists to fix: the
 * embedded surfaces worked perfectly and nobody could get to them, because the
 * cockpit still pointed at this app's own screens. WP5's manual pass found it
 * the hard way — a tester followed the cockpit, landed on the old chat, and
 * reported a missing download that the real one has.
 *
 * So this check types **one** URL, the front door, and after that only touches
 * things a thumb could touch. If a path cannot be walked from the cockpit, it
 * does not exist as far as this file is concerned.
 *
 * ── What it proves ──────────────────────────────────────────────────────────
 *  1. The cockpit's own controls — the Ask door, the Agents pill, the agent
 *     cards, the Reports pill — land on FabOrchestrator's surfaces.
 *  2. What arrives really is FabOrchestrator's page, not this app's copy: the
 *     document title, the bare `/_next` chunks, no `pwa-assets`.
 *  3. The retired screens redirect rather than 404, so a bookmark still works.
 *  4. This app's own composer is gone from the cockpit, so there are not two
 *     chats on one origin.
 *  5. It all works at phone width, which is the only width that matters.
 *
 * Read-only: no model turns, no writes, no refresh of anybody's dashboard.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/embed-cutover-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const env = Object.fromEntries(
  fs
    .readFileSync(`${ROOT}/.env`, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const APP = (process.env.APP_URL ?? "http://localhost:3002").replace(/\/$/, "");
const OUT = path.join(ROOT, "docs", "probes", "wp9-shots");
if (!env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function record(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(t) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

/** Is this FabOrchestrator's own document, or this app's? */
async function whoRendered(page) {
  return page.evaluate(() => ({
    path: location.pathname,
    title: document.title,
    foChunks: document.documentElement.innerHTML.split('="/_next/static/').length - 1,
    pwaChunks: document.documentElement.innerHTML.split("/pwa-assets/_next/").length - 1,
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 120),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  }));
}
const isFabOrchestrator = (s) => /LLMatscale/i.test(s.title) && s.foChunks > 0 && s.pwaChunks === 0;

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  // Expected: this app's router asks for an RSC payload for a route
  // FabOrchestrator's build now answers, cannot read it, and falls back to a
  // full browser navigation — the cross-build mechanism WP3 verified.
  if (/failed to fetch rsc payload/i.test(t) && /falling back to browser navigation/i.test(t)) return;
  consoleErrors.push(t.slice(0, 140));
});

// ── The one URL this check is allowed to type ───────────────────────────────
section("0. in through the front door");
await page.goto(`${APP}/`, { waitUntil: "networkidle", timeout: 60000 });
record("the front door meets the sign-in gate", page.url().includes("/login"), page.url().replace(APP, ""));
await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
await page.press('input[name="password"]', "Enter");
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2000);
record("signing in lands on the cockpit", new URL(page.url()).pathname === "/", page.url().replace(APP, ""));
await page.screenshot({ path: path.join(OUT, "cockpit.png") });

// ── 1. The cockpit no longer carries a chat of its own ──────────────────────
section("1. one chat on this origin, not two");
{
  const cockpit = await page.evaluate(() => ({
    composers: document.querySelectorAll('input[name="q"], #cockpit-ask').length,
    door: [...document.querySelectorAll("a")].filter((a) => /ask fabinsight/i.test(a.innerText)).length,
    chips: [...document.querySelectorAll("a")].filter((a) => /yield variance|monthly oee|compliance/i.test(a.innerText)).length,
    toFabinsight: [...document.querySelectorAll('a[href^="/fabinsight"], a[href^="/backend-agent"]')].length,
    toChat: [...document.querySelectorAll('a[href="/chat"]')].length,
  }));
  record("this app's own ask box is gone from the cockpit", cockpit.composers === 0, `${cockpit.composers} composer(s)`);
  record("…replaced by a door to FabOrchestrator's chat", cockpit.door === 1, `${cockpit.door} door(s)`);
  record("…and the question-carrying chips with it", cockpit.chips === 0, `${cockpit.chips} chip(s)`);
  record("no link on the cockpit points at a retired screen", cockpit.toFabinsight === 0, `${cockpit.toFabinsight} link(s)`);
  record("several point at FabOrchestrator's chat", cockpit.toChat >= 3, `${cockpit.toChat} link(s) → /chat`);
}

// ── 2. Each cockpit control, walked ─────────────────────────────────────────
async function walk(label, click, expectPath, expectFo) {
  await page.goto(`${APP}/`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1200);
  const target = await click();
  if (!target) {
    record(`${label}: found on the cockpit`, false, "control not found");
    return;
  }
  await page.waitForTimeout(expectFo ? 6000 : 3000);
  const state = await whoRendered(page);
  record(`${label} → ${expectPath}`, state.path === expectPath, `${state.path} · ${state.title}`);
  if (expectFo) {
    record(`${label}: FabOrchestrator's own page rendered`, isFabOrchestrator(state), `${state.foChunks} FO chunks, ${state.pwaChunks} pwa-assets`);
  }
  record(`${label}: no sideways scrolling`, state.overflowX <= 0, `${state.overflowX}px`);
  await page.screenshot({ path: path.join(OUT, `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`) });
}

section("2. every door on the cockpit, opened by tapping it");
await walk("the Ask door", async () => {
  const l = page.locator("a", { hasText: /ask fabinsight/i }).first();
  if ((await l.count()) === 0) return false;
  await l.click({ timeout: 20000 });
  return true;
}, "/chat", true);

await walk("the Agents pill", async () => {
  const l = page.locator('nav[aria-label="Sections"] a', { hasText: /^Agents$/ }).first();
  if ((await l.count()) === 0) return false;
  await l.click({ timeout: 20000 });
  return true;
}, "/chat", true);

await walk("the FabInsight card", async () => {
  const l = page.locator("a", { hasText: /FabInsight/ }).filter({ hasText: /Open/ }).first();
  if ((await l.count()) === 0) return false;
  await l.click({ timeout: 20000 });
  return true;
}, "/chat", true);

await walk("the Reports pill", async () => {
  const l = page.locator('nav[aria-label="Sections"] a', { hasText: /^Reports$/ }).first();
  if ((await l.count()) === 0) return false;
  await l.click({ timeout: 20000 });
  return true;
}, "/reports", true);

// ── 3. The retired screens still answer, reversibly ─────────────────────────
section("3. an old bookmark still works");
for (const old of ["/fabinsight", "/backend-agent"]) {
  await page.goto(`${APP}${old}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4000);
  const state = await whoRendered(page);
  record(`${old} lands on FabOrchestrator's chat`, state.path === "/chat", `${state.path} · ${state.title}`);
  record(`…and it is the real one`, isFabOrchestrator(state), `${state.foChunks} FO chunks, ${state.pwaChunks} pwa-assets`);
}
{
  // A question in an old link cannot survive: FabOrchestrator's chat accepts no
  // prefill. What must not happen is landing somewhere broken.
  await page.goto(`${APP}/fabinsight?q=Give%20me%20the%20yield`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4000);
  const state = await whoRendered(page);
  record("an old ?q= link lands on the chat, question dropped", state.path === "/chat" && !location_has(page, "q="), `${state.path}${new URL(page.url()).search}`);
}
function location_has(p, needle) {
  return new URL(p.url()).search.includes(needle);
}

// ── 4. The session is still one session ─────────────────────────────────────
section("4. one sign-in, both applications");
{
  await page.goto(`${APP}/chat`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(6000);
  const signedIn = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      signedOut: /you'?ve been signed out|sign in to continue/i.test(t),
      hasComposer: !!document.querySelector("textarea"),
    };
  });
  record("FabOrchestrator does not ask for a second sign-in", !signedIn.signedOut, signedIn.signedOut ? "signed-out state shown" : "");
  record("…and its composer is there to type into", signedIn.hasComposer, "");
}

// ── 5. Nothing else moved ───────────────────────────────────────────────────
section("5. this app's own screens are untouched");
for (const own of ["/login", "/diagnostics"]) {
  const res = await page.goto(`${APP}${own}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const html = await page.content();
  record(`${own} is still this app's own screen`, res.status() === 200 && html.includes("/pwa-assets/_next/"), `HTTP ${res.status()}`);
}
record("no unexpected console errors across the whole walk", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "none");

await ctx.close();
await browser.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
