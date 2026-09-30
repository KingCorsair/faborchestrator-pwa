/**
 * FabOrchestrator's own in-app navigation, used rather than probed.
 *
 * ── The defect this exists to catch ─────────────────────────────────────────
 * Reported from a phone after WP9: the Back control **inside** the embedded
 * chat produced a 404. It is `router.push("/home")` — FabOrchestrator's own
 * cockpit — and `/home` is in the document catalogue but not in
 * `FO_EMBED_SURFACES`, so `classify()` fell through to `unknown` and denied it.
 *
 * Every automated check missed it for one reason: **they all reached
 * FabOrchestrator by typing a URL, and then asserted about the page they
 * landed on.** None of them used FabOrchestrator's own controls. Embedding an
 * application brings its navigation with it, and that navigation has opinions
 * about where it is going. So this file clicks FabOrchestrator's buttons.
 *
 * Read-only: no model turns, no writes, no dashboard refresh.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/fo-navigation-check.mjs
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
const OUT = path.join(ROOT, "docs", "probes", "wp9-shots");
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const record = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

const browser = await chromium.launch();
// **Desktop width on purpose.** FabOrchestrator's sidebar — which holds the
// Back control and the FO Overview item — is a closed drawer below 768px,
// opened from FabOrchestrator's own phone bar since its mobile-navigation fix
// (OPEN_ISSUES 0a). This check is about where the controls *go*, so it runs
// where they are visible. The phone pass below re-checks the same destination
// through that phone trigger and drawer.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const status = new Map();
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.origin === APP) status.set(u.pathname, r.status());
});

async function signIn(p) {
  await p.goto(`${APP}/login`, { waitUntil: "networkidle", timeout: 60000 });
  await p.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
  await p.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
  await p.press('input[name="password"]', "Enter");
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1500);
}
const where = (p) => new URL(p.url()).pathname;
async function renderedBy(p) {
  return p.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const fo = html.split('="/_next/static/').length - 1;
    const pwa = html.split("/pwa-assets/_next/").length - 1;
    return {
      who: fo > 0 && pwa === 0 ? "FO" : pwa > 0 ? "PWA" : "?",
      title: document.title,
      is404: /404|could not be found|page could not/i.test(document.body.innerText),
      text: document.body.innerText.replace(/\s+/g, " ").slice(0, 90),
    };
  });
}

// ── 1. The Back control inside FabOrchestrator's chat ───────────────────────
section("1. the Back control inside the embedded chat");
await signIn(page);
await page.goto(`${APP}/chat`, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(6000);
{
  const before = await renderedBy(page);
  record("the embedded chat is FabOrchestrator's own page", before.who === "FO", `${where(page)} · ${before.title}`);

  // FabOrchestrator's own control, found by its own accessible name.
  const back = page.getByRole("button", { name: /back to faborchestrator overview/i }).first();
  const found = (await back.count()) > 0;
  record("FabOrchestrator's Back control is on the page", found, found ? 'aria-label="Back to FabOrchestrator overview"' : "not found");

  if (found) {
    await back.click({ timeout: 20000 });
    await page.waitForTimeout(4000);
    const after = await renderedBy(page);
    // Since the whole-application correction, "back to the overview" lands on
    // FabOrchestrator's **own** cockpit at `/home` — which is what the button
    // has always said it would do. Before the correction this app answered with
    // a cockpit of its own; that was the narrow architecture, and it is gone.
    record("…tapping it lands on the cockpit, not a 404", where(page) === "/home" && !after.is404, `${where(page)} · ${after.text}`);
    record("…and the cockpit is FabOrchestrator's own", after.who === "FO", `${after.who} · ${after.title}`);
    record("…no request to /home returned 404", (status.get("/home") ?? 0) !== 404, `/home → ${status.get("/home") ?? "not requested"}`);
    await page.screenshot({ path: path.join(OUT, "fo-back-lands-on-cockpit.png") });
  }
}

// ── 2. The "FO Overview" item, which goes to the same place ────────────────
section("2. the FO Overview item in the same sidebar");
await page.goto(`${APP}/chat`, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(6000);
{
  const overview = page.getByRole("button", { name: /fo overview/i }).first();
  const found = (await overview.count()) > 0;
  record("FO Overview is on the page", found, found ? "" : "not found (it lives under Workspace)");
  if (found) {
    await overview.click({ timeout: 20000 });
    await page.waitForTimeout(4000);
    const after = await renderedBy(page);
    record("…it lands on the cockpit too", where(page) === "/home" && !after.is404, `${where(page)} · ${after.text}`);
  }
}

// ── 3. Round trip: cockpit → chat → back → chat again ──────────────────────
section("3. the round trip the operator actually makes");
await page.goto(`${APP}/`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(1200);
{
  // ── FabOrchestrator's agent cards are clickable <article>s ──────────────
  //
  // Not buttons, not anchors: `agent-cards.tsx:96` puts the `onClick` on the
  // `<article>` itself, so a `a, button` selector matches nothing on a page
  // that visibly has four cards. The same shape as its "Open" control on
  // Reports, which is a bare `<div>`. Click what the operator clicks.
  const card = page.locator("article").filter({ hasText: /FabInsight/i }).first();
  await card.click({ timeout: 20000 }).catch((e) => console.log("   card click:", String(e).slice(0, 70)));
  await page.waitForTimeout(6000);
  record("cockpit → chat", where(page) === "/chat" && (await renderedBy(page)).who === "FO", where(page));

  await page.getByRole("button", { name: /back to faborchestrator overview/i }).first()
    .click({ timeout: 20000 })
    .catch((e) => record("chat → in-app Back: control available", false, String(e).slice(0, 70)));
  await page.waitForTimeout(4000);
  record("chat → in-app Back → cockpit", where(page) === "/home" && (await renderedBy(page)).who === "FO", where(page));

  await page.locator("article").filter({ hasText: /FabInsight/i }).first()
    .click({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const again = await renderedBy(page);
  record("cockpit → chat again", where(page) === "/chat" && again.who === "FO" && !again.is404, `${where(page)} · ${again.title}`);
}

// ── 4. The browser's own Back still works ──────────────────────────────────
section("4. the browser's Back button, unchanged");
{
  await page.goBack({ waitUntil: "load", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const after = await renderedBy(page);
  record("browser Back leaves the chat without a 404", !after.is404, `${where(page)} · ${after.who}`);
}

// ── 5. The breakpoint, on both sides ──────────────────────────────────────
//
// Below 768px FabOrchestrator's sidebar is a drawer and its Back control is
// inside it. Since its mobile-navigation fix (11 September) FabOrchestrator
// puts its own trigger in a slim bar at the top of the content, so the control
// is one tap away rather than unreachable. At 768px and up the sidebar is a
// rail with the control on it.
//
// **Correction (11 September).** This section used to call 844px "the same
// phone, landscape" and conclude that a turned phone gets the rail. Safari
// insets a landscape page on a notched iPhone by its safe areas, so an iPhone
// 13 in landscape is **750px** wide — still the phone layout. Both are pinned
// below: the real phone at 750, and 844 because other devices do produce it.
section("5. the breakpoint, on both sides");
for (const [label, vp, expectRail] of [
  ["390px (portrait phone)", { width: 390, height: 844 }, false],
  ["750px (iPhone 13 landscape, as Safari measures it)", { width: 750, height: 342 }, false],
  ["844px (nominal landscape)", { width: 844, height: 390 }, true],
]) {
  const c = await browser.newContext({ viewport: vp, isMobile: vp.width < 768, hasTouch: true, userAgent: devices["iPhone 13"].userAgent });
  const p2 = await c.newPage();
  await signIn(p2);
  await p2.goto(`${APP}/chat`, { waitUntil: "load", timeout: 60000 });
  await p2.waitForTimeout(6000);

  record(`${label}: this app injects no navigation`, (await p2.locator("#pwa-fo-back, #pwa-fo-sidebar-toggle").count()) === 0, "");
  if (!expectRail) {
    const trigger = p2.locator('#main-content [data-sidebar="trigger"]');
    // FabOrchestrator's sidebar trigger bar is on every phone view, browser
    // tab or installed app (Amay, 11 September: keep sidebars reachable).
    record(`${label}: FabOrchestrator's phone trigger is on screen`, await trigger.isVisible().catch(() => false), "");
    await trigger.click({ timeout: 20000 }).catch(() => {});
    await p2.waitForTimeout(2000);
  }
  // Scoped to the sidebar: the phone bar carries the same control (its label,
  // its destination), which the open drawer's overlay covers.
  const back = p2.locator('[data-sidebar="sidebar"] [aria-label="Back to FabOrchestrator overview"]').first();
  const visible = (await back.count()) > 0 && (await back.isVisible().catch(() => false));
  record(`${label}: FabOrchestrator's Back control is ${expectRail ? "on the rail" : "in the drawer it opens"}`, visible, visible ? "visible" : "not visible");

  if (visible) {
    await back.click({ timeout: 20000 });
    await p2.waitForTimeout(4000);
    const after = await renderedBy(p2);
    record(`${label}: …and it lands on the cockpit, not a 404`, new URL(p2.url()).pathname === "/home" && !after.is404, `${new URL(p2.url()).pathname} · ${after.who}`);
    await p2.screenshot({ path: path.join(OUT, `fo-back-${vp.width}.png`) });
  }
  await c.close();
}

await ctx.close();
await browser.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
