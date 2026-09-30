/**
 * The navigation invariant (Amay, 11 September):
 *
 *   On every relevant route, in every context, at every width, at least one
 *   visible, tappable control capable of reaching Home and Reports exists.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * FabOrchestrator's cockpit header hides its link row below 768px
 * (`hidden md:flex`). The replacement menu was once gated on the installed app
 * as well (`installed-phone:`), which is not the row's complement: in every
 * browser below 768px — and at fractional widths between 767 and 768 even in
 * the installed app — neither showed, and /home and /reports had no Home or
 * Reports control at all. Every earlier check asserted elements one by one
 * ("this is hidden", "that is shown") and so passed that state. This asserts
 * the property instead, and proves it by tapping.
 *
 * ── Contexts and widths ─────────────────────────────────────────────────────
 *   desktop browser   1280, 768, 767.5 (a real fractional viewport: 1535 device
 *                     pixels at a device scale of 2), 767, 750, 390
 *   phone browser     Chromium and WebKit, iPhone 13 portrait (390) and
 *                     landscape (750)
 *   installed app     390, 750, 767, 768 — display-mode: fullscreen, which is
 *                     what iOS reports for an installed app, entered with the
 *                     Fullscreen API
 *
 * ── Per route ───────────────────────────────────────────────────────────────
 *   /home, /reports   exactly one of the header's row or its menu is visible
 *                     and tappable; tapping Reports opens /reports and tapping
 *                     Cockpit opens /home; in the menu, Chat is disabled
 *   an opened report  "All reports" is there
 *   agent pages       exactly one of the sidebar rail or the phone trigger bar
 *                     is visible and tappable, and it reaches Back to overview
 *                     (Home) — plus Dashboard (Reports) on /chat
 *
 * Read-only. Opening a pinned report reads its saved snapshot, never the MES.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/fo-nav-invariant-check.mjs
 *       (CONTEXTS=0,1,2 runs a subset, so groups can run in parallel)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const APP = (process.env.APP_URL ?? "http://localhost:3002").replace(/\/$/, "");
const OUT = path.join(ROOT, "docs", "probes", "fo-nav-invariant");
fs.mkdirSync(OUT, { recursive: true });
const LOADER_ID = "52883280-79c2-4a26-b413-b87f4066cf7d";

const phone = devices["iPhone 13"];
const land = devices["iPhone 13 landscape"];
const desk = (width) => ({ viewport: { width, height: 900 } });
const CONTEXTS = [
  { label: "desktop 1280", engine: chromium, opts: desk(1280) },
  { label: "desktop 768", engine: chromium, opts: desk(768) },
  // Real fractional viewports. Playwright's own viewport takes integers only,
  // and the headless shell ignores --force-device-scale-factor; Chromium's new
  // headless mode honours it, and its --window-size is in CSS pixels. 1.25 at
  // 783 is 767.2px — exactly the desktop reading behind this check (Windows at
  // 125%: innerWidth 767, max-width: 767px false).
  { label: "desktop 767.2 (125% scaling)", engine: chromium, opts: { viewport: null }, launch: { channel: "chromium", args: ["--force-device-scale-factor=1.25", "--window-size=783,900"] }, fractional: true },
  { label: "desktop 767.5 (160% scaling)", engine: chromium, opts: { viewport: null }, launch: { channel: "chromium", args: ["--force-device-scale-factor=1.6", "--window-size=784,900"] }, fractional: true },
  { label: "desktop 767", engine: chromium, opts: desk(767) },
  { label: "desktop 750", engine: chromium, opts: desk(750) },
  { label: "desktop 390", engine: chromium, opts: desk(390) },
  { label: "phone browser 390", engine: chromium, opts: { ...phone } },
  { label: "phone browser 750 landscape", engine: chromium, opts: { ...land } },
  { label: "Safari-equivalent 390", engine: webkit, opts: { ...phone } },
  { label: "Safari-equivalent 750 landscape", engine: webkit, opts: { ...land } },
  { label: "installed 390", engine: chromium, opts: { ...phone }, installed: true },
  { label: "installed 750 landscape", engine: chromium, opts: { ...land }, installed: true },
  { label: "installed 767", engine: chromium, opts: { ...phone, viewport: { width: 767, height: 700 } }, installed: true },
  { label: "installed 768", engine: chromium, opts: { ...phone, viewport: { width: 768, height: 700 } }, installed: true },
];
const pick = process.env.CONTEXTS ? process.env.CONTEXTS.split(",").map(Number) : CONTEXTS.map((_, i) => i);

let failures = 0;
const record = (label, name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${label}] ${name}${detail ? `  — ${detail}` : ""}`);
};
const where = (p) => new URL(p.url()).pathname;
const slug = (s) => s.replace(/[^a-z0-9.]+/gi, "-").toLowerCase();

async function signIn(p) {
  await p.goto(`${APP}/login`, { waitUntil: "load", timeout: 90000 });
  await p.waitForSelector('input[name="email"]', { timeout: 60000 });
  await p.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
  await p.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
  await p.press('input[name="password"]', "Enter");
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1500);
}
async function enterInstalled(p) {
  await p.evaluate(() => (document.fullscreenElement ? true : document.documentElement.requestFullscreen().then(() => true, () => false)));
  await p.waitForTimeout(800);
}

const nav = (p) => p.evaluate(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"; };
  const tappable = (e) => { const r = e.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && (h === e || e.contains(h)); };
  const brand = [...document.querySelectorAll("div")].find((d) => (d.innerText || "").trim() === "ATHENATEC");
  const header = brand ? brand.closest(".sticky") : null;
  const rowButtons = header ? [...header.querySelectorAll("nav button")].filter(vis) : [];
  const menu = [...document.querySelectorAll('button[aria-label="Open navigation"]')].filter(vis);
  const inset = document.getElementById("main-content");
  const bar = inset ? [...inset.querySelectorAll('[data-sidebar="trigger"]')].filter(vis) : [];
  const rail = [...document.querySelectorAll('[data-sidebar="sidebar"]:not([data-mobile="true"])')].filter(vis);
  const railTrigger = [...document.querySelectorAll('[data-sidebar="sidebar"]:not([data-mobile="true"]) [data-sidebar="trigger"]')].filter(vis);
  return {
    width: { inner: innerWidth, css: Number(document.documentElement.getBoundingClientRect().width.toFixed(2)), md: matchMedia("(min-width: 48rem)").matches, max767: matchMedia("(max-width: 767px)").matches },
    installed: document.documentElement.hasAttribute("data-installed-app"),
    cockpitHeader: !!header,
    row: rowButtons.map((e) => e.innerText.trim()),
    rowTappable: rowButtons.length > 0 && rowButtons.every(tappable),
    menu: menu.length, menuTappable: menu.length > 0 && menu.every(tappable),
    bar: bar.length, barTappable: bar.length > 0 && bar.every(tappable),
    rail: rail.length, railTrigger: railTrigger.length,
    drawer: document.querySelectorAll('[data-sidebar="sidebar"][data-mobile="true"]').length,
  };
});

/** Every visible "Back to FabOrchestrator overview" on the page. */
const visibleBacks = (p) => p.evaluate(() => [...document.querySelectorAll('[aria-label="Back to FabOrchestrator overview"]')]
  .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== "none"; }).length);

/**
 * The phone bar's Back (11 September): where it is, whether it is tappable and
 * covers nothing, and where the bar's sidebar trigger is — which must not move.
 */
const externalBack = (p) => p.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"; };
  const box = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const inset = document.getElementById("main-content");
  const backs = inset ? [...inset.querySelectorAll('[aria-label="Back to FabOrchestrator overview"]')].filter(vis) : [];
  const trig = inset ? [...inset.querySelectorAll('[data-sidebar="trigger"]')].filter(vis)[0] : null;
  if (!backs.length) return { n: 0, triggerRect: trig ? box(trig) : null };
  const b = backs[0];
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const overlaps = [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")]
    .filter((e) => vis(e) && e !== b && !b.contains(e) && !e.contains(b))
    .filter((o) => { const q = o.getBoundingClientRect(); return !(q.right <= r.left || q.left >= r.right || q.bottom <= r.top || q.top >= r.bottom); })
    .map((o) => (o.getAttribute("aria-label") || o.innerText || o.tagName).replace(/\s+/g, " ").trim().slice(0, 24));
  return { n: backs.length, tappable: !!hit && (hit === b || b.contains(hit)), overlaps, rect: box(b), right: Math.round(innerWidth - r.right), triggerRect: trig ? box(trig) : null };
});

async function menuItems(p) {
  return p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((e) => ({
    t: e.innerText.trim(), disabled: e.getAttribute("aria-disabled") === "true", current: e.getAttribute("aria-current") === "page",
  })));
}

/** Use whichever Home/Reports control is on screen: tap Reports, then Home. */
async function tapThrough(p, label, s, fromRoute) {
  const useRow = s.row.includes("Reports") && s.row.includes("Cockpit");
  if (useRow) {
    await p.locator(".sticky nav button", { hasText: "Reports" }).first().click({ timeout: 15000 });
  } else {
    await p.locator('button[aria-label="Open navigation"]').click({ timeout: 15000 });
    await p.waitForTimeout(900);
    const items = await menuItems(p);
    const get = (t) => items.find((i) => i.t === t) ?? {};
    record(label, `${fromRoute}: the menu holds Cockpit, Chat, Reports`, items.map((i) => i.t).join(",") === "Cockpit,Chat,Reports", items.map((i) => i.t).join(" · "));
    record(label, `${fromRoute}: Cockpit and Reports enabled, Chat disabled`, !get("Cockpit").disabled && !get("Reports").disabled && get("Chat").disabled === true, "");
    await p.getByRole("menuitem", { name: "Reports" }).click({ timeout: 15000 });
  }
  await p.waitForURL((u) => u.pathname === "/reports", { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(3500);
  record(label, `${fromRoute}: Reports ${useRow ? "(header row)" : "(menu)"} opens /reports`, where(p) === "/reports", where(p));

  const s2 = await nav(p);
  record(label, "/reports after navigating: still exactly one Home/Reports control", (s2.row.includes("Reports") ? 1 : 0) + s2.menu === 1, `row ${s2.row.length}, menu ${s2.menu}`);
  if (useRow) {
    await p.locator(".sticky nav button", { hasText: "Cockpit" }).first().click({ timeout: 15000 });
  } else {
    await p.locator('button[aria-label="Open navigation"]').click({ timeout: 15000 });
    await p.waitForTimeout(900);
    const items = await menuItems(p);
    record(label, "/reports: the menu marks Reports as the current page", items.find((i) => i.t === "Reports")?.current === true, "");
    await p.getByRole("menuitem", { name: "Cockpit" }).click({ timeout: 15000 });
  }
  await p.waitForURL((u) => u.pathname === "/home", { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(3500);
  record(label, `/reports: Cockpit ${useRow ? "(header row)" : "(menu)"} opens /home`, where(p) === "/home", where(p));
}

for (const i of pick) {
  const c = CONTEXTS[i];
  console.log(`\n── ${c.label} ${"─".repeat(Math.max(0, 60 - c.label.length))}`);
  const b = await c.engine.launch(c.launch ?? {});
  const p = await (await b.newContext(c.opts)).newPage();
  await signIn(p);
  const go = async (route) => {
    await p.goto(`${APP}${route}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.waitForTimeout(8000);
    if (c.installed) await enterInstalled(p);
  };

  // /home
  await go("/home");
  let s = await nav(p);
  if (c.fractional) record(c.label, "the viewport really is between 767 and 768", !s.width.md && !s.width.max767, JSON.stringify(s.width));
  if (c.installed) record(c.label, "treated as the installed app", s.installed, "");
  else record(c.label, "a browser, not treated as the installed app", !s.installed, "");
  const rowOk = s.row.includes("Cockpit") && s.row.includes("Reports") && s.rowTappable;
  const menuOk = s.menu === 1 && s.menuTappable;
  record(c.label, "/home: exactly one visible, tappable Home/Reports control", (rowOk ? 1 : 0) + (menuOk ? 1 : 0) === 1 && (s.row.length === 0 || s.menu === 0),
    `row [${s.row.join(",")}]${s.rowTappable ? "" : " not tappable"}, menu ${s.menu}${s.menuTappable ? "" : " not tappable"}, width ${JSON.stringify(s.width)}`);
  record(c.label, "/home: unchanged — no agent-page Back here", (await visibleBacks(p)) === 0, "");
  await p.screenshot({ path: path.join(OUT, `${slug(c.label)}_home.png`) });
  if (rowOk || menuOk) await tapThrough(p, c.label, s, "/home");

  // /reports, loaded directly, and an opened report
  await go("/reports");
  s = await nav(p);
  const rRowOk = s.row.includes("Cockpit") && s.row.includes("Reports") && s.rowTappable;
  const rMenuOk = s.menu === 1 && s.menuTappable;
  record(c.label, "/reports: exactly one visible, tappable Home/Reports control", (rRowOk ? 1 : 0) + (rMenuOk ? 1 : 0) === 1 && (s.row.length === 0 || s.menu === 0),
    `row [${s.row.join(",")}], menu ${s.menu}`);
  record(c.label, "/reports: unchanged — no agent-page Back here", (await visibleBacks(p)) === 0, "");
  await p.screenshot({ path: path.join(OUT, `${slug(c.label)}_reports.png`) });
  const cards = p.locator("div.group.cursor-pointer");
  if (await cards.count()) {
    await cards.first().click({ timeout: 20000 });
    await p.waitForTimeout(6000);
    record(c.label, "an opened report: All reports is there", await p.getByRole("button", { name: "All reports" }).isVisible().catch(() => false), "");
    const so = await nav(p);
    record(c.label, "an opened report: the Home/Reports control is still there", (so.row.includes("Reports") ? 1 : 0) + so.menu === 1, `row ${so.row.length}, menu ${so.menu}`);
  }

  // Agent pages: unchanged, and never without a control.
  for (const route of ["/chat", "/modeling-agent", "/modeling-agent/loader", `/modeling-agent/loader/${LOADER_ID}`]) {
    const name = route.startsWith("/modeling-agent/loader/") ? "/modeling-agent/loader/[id]" : route;
    await go(route);
    const a = await nav(p);
    const railOk = a.rail === 1 && a.railTrigger >= 1 && a.bar === 0;
    const barOk = a.bar === 1 && a.barTappable && a.rail === 0 && a.drawer === 0;
    record(c.label, `${name}: exactly one visible, tappable sidebar control`, (railOk ? 1 : 0) + (barOk ? 1 : 0) === 1,
      `rail ${a.rail} (trigger ${a.railTrigger}), bar ${a.bar}${a.barTappable ? "" : " not tappable"}, drawer ${a.drawer}, width ${JSON.stringify(a.width)}`);
    const eb = await externalBack(p);
    if (barOk) {
      record(c.label, `${name}: the bar's Back — visible, tappable, top-right, covering nothing`,
        eb.n === 1 && eb.tappable && eb.overlaps.length === 0 && eb.right <= 16 && !!eb.triggerRect && Math.abs(eb.rect[1] - eb.triggerRect[1]) <= 2,
        JSON.stringify(eb));
      record(c.label, `${name}: the sidebar trigger has not moved`,
        !!eb.triggerRect && eb.triggerRect[0] === 8 && eb.triggerRect[2] === 40 && eb.triggerRect[3] === 40, JSON.stringify(eb.triggerRect));
    } else {
      record(c.label, `${name}: no external Back at this width — the rail carries its own`, eb.n === 0, `${eb.n} found`);
    }
    if (barOk) {
      await p.locator('#main-content [data-sidebar="trigger"]').click({ timeout: 15000 });
      await p.waitForTimeout(1800);
    }
    const scope = barOk ? '[data-sidebar="sidebar"][data-mobile="true"]' : '[data-sidebar="sidebar"]:not([data-mobile="true"])';
    const home = await p.locator(`${scope} [aria-label="Back to FabOrchestrator overview"]`).first().isVisible().catch(() => false);
    record(c.label, `${name}: it reaches Home (Back to overview)`, home, barOk ? "in the drawer the bar opens" : "on the rail");
    if (route === "/chat") {
      const dash = await p.locator(scope).getByRole("button", { name: /^\s*Dashboard\s*$/ }).first().isVisible().catch(() => false);
      record(c.label, "/chat: …and Reports (Dashboard)", dash, "");
    }
    if (barOk) {
      const vp = p.viewportSize() ?? { width: await p.evaluate(() => innerWidth), height: await p.evaluate(() => innerHeight) };
      await p.mouse.click(vp.width - 12, Math.round(vp.height / 2));
      await p.waitForTimeout(1200);
      record(c.label, `${name}: the drawer closes again`, (await nav(p)).drawer === 0, "");
      // The bar's Back: the sidebar's own destination, router.push("/home").
      await p.locator('#main-content [aria-label="Back to FabOrchestrator overview"]').click({ timeout: 15000 });
      await p.waitForURL((u) => u.pathname === "/home", { timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(2500);
      record(c.label, `${name}: the bar's Back opens /home`, where(p) === "/home", where(p));
    }
  }
  await b.close();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
