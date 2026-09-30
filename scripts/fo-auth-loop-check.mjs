/**
 * The front-door authentication loop that must not exist.
 *
 * ── The loop ────────────────────────────────────────────────────────────────
 * FabOrchestrator's client-side guards navigate to `/` meaning **"go to our
 * login page"** — on its own site, `/` *is* the login page. On this origin `/`
 * is the front door, and once FabOrchestrator's `/home` is the cockpit, `/`
 * sends a signed-in operator straight to it. So a session FabOrchestrator has
 * given up on, while this app's cookie is still alive, would go:
 *
 *     FO guard → `/` → `/home` → FO guard → `/` → … for ever
 *
 * `expiredUpstream()` clears the cookie on any upstream 401, which covers every
 * case where FabOrchestrator is *asked* something. It cannot cover the one that
 * matters most: **FabOrchestrator's idle timer clears its own storage after 30
 * minutes without making a request**, so no 401 is ever produced and the cookie
 * outlives the session in silence. That is the state this file reproduces —
 * exactly, by deleting the key FabOrchestrator's own timer deletes — and then
 * proves the app escapes it.
 *
 * `public/fo-shell.js` is what closes it, at the only place both facts are
 * visible: inside a FabOrchestrator document, where its token either is or is
 * not in localStorage.
 *
 * Read-only: no model turns, no writes.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/fo-auth-loop-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const APP = (process.env.APP_URL ?? "http://localhost:3002").replace(/\/$/, "");
const OUT = path.join(ROOT, "docs", "probes", "wp10-shots");
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const record = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();

/** Every document navigation, so a loop is visible as a repeating pattern. */
const trail = [];
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) trail.push(new URL(f.url()).pathname);
});

const at = () => new URL(page.url()).pathname;
const hasCookie = async () =>
  (await ctx.cookies(APP)).some((c) => c.name === "faborch_token" && c.value);

async function signIn() {
  await page.goto(`${APP}/login`, { waitUntil: "networkidle", timeout: 60000 });
  await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
  await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
  await page.press('input[name="password"]', "Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

// ── 1. The front door leads into FabOrchestrator ────────────────────────────
section("1. the front door");
await signIn();
record("signing in lands on FabOrchestrator's cockpit", at() === "/home", at());
{
  const who = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const fields = [...document.querySelectorAll("input,textarea")];
    return {
      fo: html.split('="/_next/static/').length - 1,
      pwa: html.split("/pwa-assets/_next/").length - 1,
      // The three things the hand-built cockpit could not reproduce, and which
      // come back for nothing now that FabOrchestrator renders its own page.
      composer: fields.some((f) => /ask anything|orchestrate/i.test(f.getAttribute("placeholder") ?? "")),
      chips: /yield variance|monthly oee|compliance ·/i.test(document.body.innerText),
      badge: /all agents online/i.test(document.body.innerText),
    };
  });
  record("…and it is FabOrchestrator's own cockpit, not a copy", who.fo > 0 && who.pwa === 0, `fo=${who.fo} pwa=${who.pwa}`);
  record("…with FabOrchestrator's own composer on it", who.composer, who.composer ? 'placeholder "Ask anything, or describe a task to orchestrate…"' : "no composer found");
  record("…its suggestion chips", who.chips, "");
  record("…and its ALL AGENTS ONLINE badge", who.badge, "the three the hand-built cockpit lacked");
  await page.screenshot({ path: path.join(OUT, "front-door-home.png") });
}

// ── 2. The loop, reproduced exactly ─────────────────────────────────────────
section("2. an expired FabOrchestrator session, with this app's cookie alive");
{
  // Precisely what FabOrchestrator's own idle timer does at 30 minutes, and
  // precisely what produces no upstream 401 for the gateway to notice.
  await page.evaluate(() => {
    localStorage.removeItem("llmatscale_auth_token");
    localStorage.removeItem("llmatscale_auth_session");
    localStorage.removeItem("llmatscale_user");
  });
  record("FabOrchestrator's session is gone from the browser", true, "llmatscale_* cleared");
  record("…while this app's cookie is still alive", await hasCookie(), "faborch_token present");

  trail.length = 0;
  await page.goto(`${APP}/`, { waitUntil: "load", timeout: 60000 });
  // Long enough for several loop iterations to have happened if it looped.
  await page.waitForTimeout(15000);

  const visits = trail.filter((p) => p === "/" || p === "/home").length;
  record("it settles rather than looping", visits <= 3, `visited / or /home ${visits}×; trail: ${trail.slice(0, 10).join(" → ")}`);
  record("…and it settles on sign-in", at() === "/login", at());
  record("…having dropped this app's cookie too", !(await hasCookie()), (await hasCookie()) ? "cookie still set" : "cleared");
  await page.screenshot({ path: path.join(OUT, "expired-settles-on-login.png") });
}

// ── 3. No second login: signing in again works immediately ──────────────────
section("3. signing back in");
{
  await signIn();
  record("a fresh sign-in reaches the cockpit again", at() === "/home", at());
  const pw = await page.evaluate(() => document.querySelectorAll('input[type="password"]').length);
  record("…with no second login demanded", pw === 0, `${pw} password fields`);
}

// ── 4. Signing out of FabOrchestrator signs out of the app ─────────────────
section("4. sign-out is one action for both");
{
  await page.evaluate(() => localStorage.removeItem("llmatscale_auth_token"));
  await page.waitForTimeout(6000);
  record("dropping FabOrchestrator's token signs this app out", !(await hasCookie()), (await hasCookie()) ? "cookie survived" : "cookie cleared");
  record("…and the operator is at sign-in", at() === "/login", at());
}

// ── 5. A signed-out visitor still meets the gate, with a return path ───────
section("5. the gate is unchanged");
{
  const fresh = await browser.newContext({ ...devices["iPhone 13"] });
  const p2 = await fresh.newPage();
  await p2.goto(`${APP}/reports`, { waitUntil: "load", timeout: 60000 });
  await p2.waitForTimeout(2500);
  const u = new URL(p2.url());
  record("a signed-out request for an FO page meets sign-in", u.pathname === "/login", u.pathname + u.search);
  record("…keeping where it was going", u.searchParams.get("next") === "/reports", u.searchParams.get("next") ?? "none");
  await fresh.close();
}

await ctx.close();
await browser.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
