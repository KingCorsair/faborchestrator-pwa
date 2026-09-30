/**
 * WP6 — the embedded FabOrchestrator surfaces on a phone.
 *
 * The mobile checks that need a real browser at a real phone size: whether
 * FabOrchestrator's own sidebar can be opened at all, whether it can be opened
 * *without* a reload, what rotating the phone does, whether the composer
 * survives the keyboard, and whether anything scrolls sideways.
 *
 * ── The defect this was written for ─────────────────────────────────────────
 * Reported from a phone: in the embedded chat the sidebar is unreliable —
 * sometimes only after a reload, and in the installed app never. Two causes in
 * FabOrchestrator's own code: `useIsMobile()` returns false on its first
 * render, so the desktop rail (carrying the chat's only sidebar trigger) paints
 * and then disappears; and below 768px that trigger lives inside the closed
 * sheet, so nothing can open it. `public/fo-shell.js` adds a button that
 * presses FabOrchestrator's own Ctrl+B shortcut. These checks prove it works
 * on a first paint, after a rotation, and in a standalone-like context.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/embed-mobile-hardening-check.mjs
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
const OUT = path.join(ROOT, "docs", "probes", "wp6-shots");
if (!env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

// FabOrchestrator's own way into its sidebar on a phone (11 September): the
// `SidebarTrigger` in the slim bar at the top of its content, rendered below
// 768px. Until then this app injected a control of its own here — a hamburger,
// then a Back arrow — because FabOrchestrator had none; that is gone, and these
// assertions are now about FabOrchestrator's control. Reports and the cockpit
// use its header's menu button instead.
const TOGGLE = '#main-content [data-sidebar="trigger"]';
const MENU = 'button[aria-label="Open navigation"]';
const INJECTED = "#pwa-fo-back, #pwa-fo-sidebar-toggle";
let failures = 0;
function record(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(t) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
}

const browser = await chromium.launch();

/** Sign in through this app's own form and land on the cockpit. */
async function signedInPage(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${APP}/login`, { waitUntil: "networkidle", timeout: 60000 });
  await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
  await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
  await page.press('input[name="password"]', "Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return page;
}

/** Is FabOrchestrator's own sidebar open and showing its contents? */
function sidebarState(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('[data-slot="sheet-content"], [role="dialog"][data-state="open"]');
    const text = (sheet?.textContent ?? "").replace(/\s+/g, " ");
    return {
      open: !!sheet,
      // The things a phone user cannot otherwise reach.
      hasConversations: /today|yesterday|previous|new chat/i.test(text),
      hasDashboardLink: /dashboard/i.test(text),
      hasLogout: /log ?out|sign ?out/i.test(text),
      chars: text.length,
    };
  });
}

// ── The installed app, reproduced (11 September) ───────────────────────────
// FabOrchestrator's phone navigation belongs to the installed app only:
// (display-mode standalone or fullscreen) below 768px. iOS reports an installed
// app as `fullscreen`, and the Fullscreen API is the one way found to make
// Chromium report that too, so this enters it and the real media query
// decides. Lost on a full navigation, so re-entered after each one.
async function enterInstalled(page) {
  await page.evaluate(() => (document.fullscreenElement ? true : document.documentElement.requestFullscreen().then(() => true, () => false)));
  await page.waitForTimeout(700);
}

// Chromium refuses to resize a fullscreen window, so a rotation leaves
// fullscreen, resizes, and enters it again — a turned phone is still the
// installed app.
async function resizeInstalled(page, size) {
  await page.evaluate(() => (document.fullscreenElement ? document.exitFullscreen() : null)).catch(() => {});
  await page.waitForTimeout(300);
  await page.setViewportSize(size);
  await enterInstalled(page);
}

// ── 1. Portrait, first paint: the defect's home ─────────────────────────────
section("1. portrait 390x844, on first paint (no reload)");
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await signedInPage(ctx);
  await page.goto(`${APP}/chat`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3500);

  const toggle = page.locator(TOGGLE);
  // FabOrchestrator's sidebar trigger bar is on every phone view — browser tab
  // and installed app alike (Amay, 11 September: keep sidebars reachable).
  await toggle.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  record("phone browser tab: FabOrchestrator's own trigger is on screen", await toggle.isVisible().catch(() => false), "");
  await enterInstalled(page);
  record("installed app: the same trigger, still on screen", await toggle.isVisible().catch(() => false), "");
  record("…and this app injects no control of its own", (await page.locator(INJECTED).count()) === 0, "");

  const before = await sidebarState(page);
  record("…and the sidebar starts closed", !before.open, "");

  await toggle.click({ timeout: 15000 }).catch((e) => record("trigger tap", false, String(e).slice(0, 90)));
  await page.waitForTimeout(2000);
  const after = await sidebarState(page);
  record("tapping it opens FabOrchestrator's drawer", after.open, `${after.chars} chars`);
  record("…with the conversation history and the Dashboard link", after.hasConversations && after.hasDashboardLink,
    `conversations ${after.hasConversations}, dashboard ${after.hasDashboardLink}`);
  record("…without leaving the conversation", new URL(page.url()).pathname === "/chat", new URL(page.url()).pathname);
  await page.screenshot({ path: path.join(OUT, "toggle-tapped-portrait.png") });

  await ctx.close();
}

// ── 2. Rotation across FabOrchestrator's own breakpoint ─────────────────────
section("2. rotation across the 768px breakpoint");
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await signedInPage(ctx);
  await page.goto(`${APP}/chat`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);
  await enterInstalled(page);
  record("portrait: FabOrchestrator's phone trigger is shown", await page.locator(TOGGLE).isVisible().catch(() => false), "390px");

  // A real iPhone in landscape is 750px wide in Safari — the safe areas inset
  // the page — which is still below the breakpoint, so the phone layout stays.
  await resizeInstalled(page, { width: 750, height: 342 });
  await page.waitForTimeout(1500);
  record("real iPhone landscape (750): still the phone trigger", await page.locator(TOGGLE).isVisible().catch(() => false), "750px < 768px");

  await resizeInstalled(page, { width: 844, height: 390 });
  await page.waitForTimeout(1500);
  const railTriggers = await page.locator('[data-sidebar="sidebar"] [data-sidebar="trigger"]').count();
  const barTrigger = await page.locator(TOGGLE).isVisible().catch(() => false);
  record("844: FabOrchestrator's own rail returns", railTriggers > 0, `${railTriggers} rail triggers`);
  record("…and the phone bar steps aside", !barTrigger, "md:hidden, so there is one control, not two");

  await resizeInstalled(page, { width: 390, height: 844 });
  await page.waitForTimeout(1500);
  record("back to portrait: the phone trigger returns", await page.locator(TOGGLE).isVisible().catch(() => false), "");
  await ctx.close();
}

// ── 3. Standalone, as the installed app runs ────────────────────────────────
section("3. a phone browser tab, then the installed app");
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // Until 11 September this faked `display-mode: standalone` by replacing
  // `matchMedia` in script, which CSS never sees. The phone navigation is now
  // decided by a real CSS media query, so the real display mode is entered.
  const page = await signedInPage(ctx);
  await page.goto(`${APP}/chat`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);
  const toggle = page.locator(TOGGLE);
  record("phone browser tab: FabOrchestrator's phone trigger is on screen", await toggle.isVisible().catch(() => false), "display-mode: browser");
  await enterInstalled(page);
  record("installed app: the same trigger is on screen", await toggle.isVisible().catch(() => false), "");
  await toggle.click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const sa = await sidebarState(page);
  record("…and tapping it opens FabOrchestrator's drawer", sa.open && sa.hasConversations, `open ${sa.open}`);

  // The cockpit's phone menu is in every phone view (11 September): /home and
  // /reports are never left without Home and Reports.
  await page.goto(`${APP}/home`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);
  record("phone browser tab: the cockpit's phone menu is there", await page.locator(MENU).isVisible().catch(() => false), "");
  await enterInstalled(page);
  record("installed app: the same menu is there", await page.locator(MENU).isVisible().catch(() => false), "");
  await page.screenshot({ path: path.join(OUT, "toggle-tapped-standalone.png") });
  await ctx.close();
}

// ── 4. Layout, keyboard, safe areas, overflow ──────────────────────────────
section("4. layout, keyboard, safe areas, overflow — installed app");
for (const vp of [
  { name: "390x844", width: 390, height: 844 },
  { name: "360x640", width: 360, height: 640 },
]) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: vp.width, height: vp.height }, isMobile: true, hasTouch: true });
  const page = await signedInPage(ctx);
  for (const surface of ["/chat", "/reports"]) {
    await page.goto(`${APP}${surface}`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await enterInstalled(page);
    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const ta = document.querySelector("textarea");
      const r = ta?.getBoundingClientRect();
      return {
        path: location.pathname,
        overflowX: doc.scrollWidth - window.innerWidth,
        composerVisible: r ? r.bottom <= window.innerHeight + 2 && r.top >= 0 : null,
        composerBottom: r ? Math.round(r.bottom) : null,
        viewportHeight: window.innerHeight,
      };
    });
    record(`${vp.name} ${surface}: no sideways scrolling`, m.overflowX <= 0, `${m.overflowX}px overflow`);
    if (m.composerVisible !== null) {
      record(`${vp.name} ${surface}: the composer is on screen`, m.composerVisible, `bottom ${m.composerBottom} of ${m.viewportHeight}`);
      // Focus it, as tapping to type would. The keyboard itself cannot be
      // summoned here, so this checks the focused element stays in view.
      await page.locator("textarea").first().click().catch(() => {});
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => {
        const r = document.querySelector("textarea")?.getBoundingClientRect();
        return r ? { visible: r.bottom <= window.innerHeight + 2, bottom: Math.round(r.bottom), h: window.innerHeight } : null;
      });
      if (after) record(`${vp.name} ${surface}: still on screen once focused`, after.visible, `bottom ${after.bottom} of ${after.h}`);
    }
    // FabOrchestrator's navigation control — the phone bar's trigger on the
    // chat, the header's menu button on Reports — must be tappable.
    const clash = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (!btn || getComputedStyle(btn).display === "none") return null;
      const b = btn.getBoundingClientRect();
      const mid = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { ownsItsSpot: !!mid && (mid === btn || btn.contains(mid)), left: Math.round(b.left), bottom: Math.round(window.innerHeight - b.bottom) };
    }, surface === "/reports" ? MENU : TOGGLE);
    record(`${vp.name} ${surface}: the navigation control is there`, !!clash, "");
    if (clash) {
      record(`${vp.name} ${surface}: …tappable, nothing over it`, clash.ownsItsSpot, `${clash.left}px from the left, ${clash.bottom}px from the bottom`);
    }
    await page.screenshot({ path: path.join(OUT, `${surface.replace(/\//g, "_")}-${vp.name}.png`) });
  }
  await ctx.close();
}

// ── 5. This app's own screens are untouched by the shell ───────────────────
section("5. this app's own screens are unaffected");
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await signedInPage(ctx);
  // Not `/fabinsight`: since WP9 it redirects to FabOrchestrator's chat, which
  // does carry the shell. The cockpit and diagnostics are this app's own
  // screens in both flag states, so they are what proves the shell is only
  // injected into FabOrchestrator's documents.
  for (const own of ["/login", "/diagnostics"]) {
    await page.goto(`${APP}${own}`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1500);
    const injected = await page.locator('script[src="/fo-shell.js"]').count();
    record(`${own} carries no FabOrchestrator shell`, injected === 0, `${injected} shell scripts`);
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
