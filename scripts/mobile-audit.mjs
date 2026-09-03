/**
 * The mobile audit — WP1's acceptance, measured rather than eyeballed.
 *
 * Two viewports the plan names: 360x640 (the small Android floor) and 390x844
 * (iPhone 14/15). Signs in, asks a real question, and checks the things a
 * handheld app has to get right:
 *
 *   - neither page scrolls sideways
 *   - a wide answer table scrolls inside its own box
 *   - every tap target is at least 44px
 *   - the composer is docked and on screen
 *   - a navigation with no network answers honestly
 *
 * ── Why touch emulation is not optional ─────────────────────────────────────
 * The app's own 44px minimum-target rule lives behind
 * `@media (pointer: coarse), (hover: none)`. A default headless context reports
 * a FINE pointer, so the rule never applies and the audit reports failures that
 * no real handset would have. `hasTouch` and `isMobile` below are what make the
 * measurement true; the first run of this script without them produced seven
 * false positives — targets the app already sizes correctly on a phone.
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 * Playwright is deliberately NOT a dependency of this repo — it pulls browser
 * binaries that the app itself never needs. Install it where you run this:
 *
 *     npm i -D playwright && npx playwright install chromium
 *     npm start                       # the app on :3002
 *     node scripts/mobile-audit.mjs
 *
 * Needs FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in `.env`, like the
 * other probe scripts.
 */
import { chromium } from "playwright";
import fs from "node:fs";

const ROOT = "C:/Users/ATUL ANAND/OneDrive/Documentos/Desktop/AthenaTech/faborchestrator-pwa";
const env = Object.fromEntries(
  fs.readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
// `APP_URL` so Phase 5 can run this against the deployed app rather than a
// laptop. The default stays localhost, because that is what a developer wants.
const APP = process.env.APP_URL ?? "http://localhost:3002";
const MIN_TAP = 44;

const results = [];
const ok = (vp, name, pass, detail = "") => {
  results.push({ vp, name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  [${vp}] ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch();

/** Every element a finger is meant to hit, with its rendered box. */
const TAP_TARGETS = `
  Array.from(document.querySelectorAll(
    'button, a[href], input:not([type=hidden]), textarea, [role=button]'
  ))
   .filter(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
   })
   .map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 34),
        w: Math.round(r.width), h: Math.round(r.height),
      };
   })
`;

for (const [w, h] of [[360, 640], [390, 844]]) {
  const vp = `${w}x${h}`;
  // hasTouch + isMobile so `@media (pointer: coarse), (hover: none)` matches.
  // Without them the app's own 44px minimum-target rule never applies and the
  // audit measures a desktop that will never exist.
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  // ── sign in ───────────────────────────────────────────────────────────────
  await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', env.FABORCH_PROBE_EMAIL);
  await page.fill('input[type="password"]', env.FABORCH_PROBE_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 });

  // ── landing page ──────────────────────────────────────────────────────────
  const landingOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok(vp, "landing page does not scroll sideways", landingOverflow <= 0, `overflow ${landingOverflow}px`);

  const landingSmall = await page.evaluate(`(${TAP_TARGETS}).filter(t => t.h < ${MIN_TAP})`);
  ok(
    vp,
    "landing tap targets are at least 44px tall",
    landingSmall.length === 0,
    landingSmall.length ? landingSmall.map((t) => `${t.label || t.tag}=${t.h}px`).join(", ") : "",
  );

  // ── a real answer with a real table ───────────────────────────────────────
  await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });
  const box = page.locator("textarea");
  await box.waitFor({ timeout: 15000 });
  await box.fill("Give me the yield by product.");
  await page.keyboard.press("Enter");

  await page.waitForFunction(
    () => document.querySelector(".fab-md table") !== null,
    null,
    { timeout: 180000 },
  ).catch(() => {});
  await page.waitForTimeout(2500);

  const hasTable = (await page.locator(".fab-md table").count()) > 0;
  ok(vp, "the answer came back as a real table", hasTable);

  if (hasTable) {
    const t = await page.evaluate(() => {
      const el = document.querySelector(".fab-md table");
      const cs = getComputedStyle(el);
      return {
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        overflowX: cs.overflowX,
        scrollable: el.scrollWidth > el.clientWidth,
      };
    });
    ok(vp, "the table scrolls inside its own box", t.overflowX === "auto" || t.overflowX === "scroll",
      `overflow-x:${t.overflowX}, ${t.scrollW}>${t.clientW}=${t.scrollable}`);
  }

  const chatOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok(vp, "the conversation does not scroll the page sideways", chatOverflow <= 0, `overflow ${chatOverflow}px`);

  const chatSmall = await page.evaluate(`(${TAP_TARGETS}).filter(t => t.h < ${MIN_TAP})`);
  ok(
    vp,
    "conversation tap targets are at least 44px tall",
    chatSmall.length === 0,
    chatSmall.length ? chatSmall.map((t) => `${t.label || t.tag}=${t.w}x${t.h}`).join(", ") : "",
  );

  // ── the composer has to be reachable without hunting ─────────────────────
  const composer = await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return null;
    const r = ta.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), inView: r.bottom <= innerHeight + 1 };
  });
  ok(vp, "the composer is on screen", !!composer?.inView, composer ? `bottom ${composer.bottom} of ${h}` : "missing");

  await page.screenshot({ path: `wp1-${vp}.png`, fullPage: false });

  // ── offline honesty ───────────────────────────────────────────────────────
  // WP1 acceptance: a navigation with no network answers /offline rather than
  // the browser's error page, and never a stale answer presented as fresh.
  await page.evaluate(() => navigator.serviceWorker?.ready).catch(() => {});
  await context.setOffline(true);
  let offlineBody = '';
  try {
    await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    offlineBody = await page.evaluate(() => document.body.innerText.slice(0, 200));
  } catch (e) {
    offlineBody = 'NAVIGATION THREW: ' + String(e.message).slice(0, 80);
  }
  const answered = /offline|connection|no network|reconnect/i.test(offlineBody);
  ok(vp, 'a navigation with no network answers honestly', answered, offlineBody.replace(/\s+/g, ' ').slice(0, 90));
  await context.setOffline(false);

  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED: " + failed.map((f) => `[${f.vp}] ${f.name}`).join(" | "));
