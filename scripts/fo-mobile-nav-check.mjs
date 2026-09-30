/**
 * FabOrchestrator's own responsive navigation, proved at every width.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `fo-back-nav-check.mjs` tested two floating controls this app injected
 * because FabOrchestrator hid its navigation below 768px with nothing in its
 * place. FabOrchestrator now provides that itself (branch
 * `mobile-nav-preview`, previewed through `FO_UI_BASE_URL`):
 *
 *   /home, /reports       its header keeps the desktop link row at 768px and
 *                         up; below, the row collapses into a menu button at
 *                         the left of the same header (Cockpit, Chat, Reports)
 *   /chat, /modeling-*    its sidebar is a rail at 768px and up; below, it is a
 *                         drawer, opened from a slim bar holding its own
 *                         SidebarTrigger
 *
 * So this asserts FabOrchestrator's navigation, and that this app adds none.
 *
 * ── The widths, and why 750 ─────────────────────────────────────────────────
 * Below 768px every context is the **installed app** (display-mode:
 * fullscreen, see `go()`): since 11 September the phone navigation is the
 * installed app's only, and a browser tab keeps the website's behaviour —
 * which `fo-installed-nav-check.mjs` proves separately.
 *
 *   390×664   iPhone 13 portrait
 *   390×797   the same phone with no Safari toolbars
 *   750×342   the same phone in **landscape**, as Safari measures it: notched
 *             iPhones inset a landscape page by the safe areas, so it is 750
 *             wide, not 844 — below the 768px breakpoint. An earlier version
 *             of our checks tested 844 and wrongly concluded a turned phone
 *             gets the desktop layout.
 *   844×390   the nominal landscape width, kept because other devices do
 *             produce it
 *   1280×900  desktop
 *
 * ── Parts, runnable in parallel ─────────────────────────────────────────────
 *   PART=matrix  one-navigation-system checks, every route × every width
 *   PART=taps    tapping FabOrchestrator's own controls to every destination
 *   PART=parity  desktop geometry identical to FabOrchestrator production
 *   (unset runs all three)
 *
 * Read-only: no model turns, no writes, no dashboard refresh. Opening a pinned
 * report reads its saved snapshot and never queries the MES.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/fo-mobile-nav-check.mjs
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
const DIRECT = (env.FABORCH_BASE_URL ?? "").replace(/\/$/, "");
const PART = process.env.PART ?? "all";
const OUT = path.join(ROOT, "docs", "probes", "fo-mobile-nav");
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const record = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

const phone = devices["iPhone 13"];
const WIDTHS = [
  ["390 installed app", { ...phone }, true],
  ["390x797 installed app", { ...phone, viewport: { width: 390, height: 797 } }, true],
  ["750 installed app, iPhone landscape", { ...devices["iPhone 13 landscape"] }, true],
  ["844 landscape browser", { ...phone, viewport: { width: 844, height: 390 } }, false],
  ["1280 desktop", { viewport: { width: 1280, height: 900 } }, false],
];
const COCKPIT_ROUTES = ["/home", "/reports"];
const LOADER_ID_FALLBACK = "00000000-0000-4000-8000-000000000000";

async function signIn(p, base) {
  if (base === DIRECT) {
    await p.goto(`${base}/`, { waitUntil: "networkidle", timeout: 90000 });
    await p.fill('input[type="email"]', env.FABORCH_PROBE_EMAIL);
    await p.fill('input[type="password"]', env.FABORCH_PROBE_PASSWORD);
    await p.press('input[type="password"]', "Enter");
    await p.waitForURL((u) => u.pathname !== "/", { timeout: 60000 }).catch(() => {});
  } else {
    await p.goto(`${base}/login`, { waitUntil: "networkidle", timeout: 90000 });
    await p.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
    await p.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
    await p.press('input[name="password"]', "Enter");
    await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  }
  await p.waitForTimeout(2000);
}
// The installed app, reproduced: the phone navigation belongs to
// (display-mode standalone or fullscreen) below 768px only. iOS reports an
// installed app as `fullscreen`, and the Fullscreen API is the one way found to
// make Chromium report that, so installed-app pages enter it after every full
// navigation and FabOrchestrator's real media query decides.
const installedPages = new WeakSet();
const enterInstalled = async (p) => {
  await p.evaluate(() => (document.fullscreenElement ? true : document.documentElement.requestFullscreen().then(() => true, () => false)));
  await p.waitForTimeout(700);
};
const go = async (p, base, route, settle = 7500) => {
  await p.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await p.waitForTimeout(settle);
  if (installedPages.has(p)) await enterInstalled(p);
};
const where = (p) => new URL(p.url()).pathname;

/** Everything about the page's navigation, from one read. */
const state = (p) => p.evaluate(() => {
  const vis = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight
      && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const box = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const brand = [...document.querySelectorAll("div")].find((d) => (d.innerText || "").trim() === "ATHENATEC");
  const header = brand ? brand.closest(".sticky") : null;
  const rowItems = header ? [...header.querySelectorAll("nav button")].filter(vis) : [];
  const menuBtn = [...document.querySelectorAll('button[aria-label="Open navigation"]')].filter(vis);
  const inset = document.getElementById("main-content");
  const triggers = [...document.querySelectorAll('[data-sidebar="trigger"]')].filter(vis);
  const insetTriggers = triggers.filter((t) => inset && inset.contains(t));
  const sidebarTriggers = triggers.filter((t) => t.closest('[data-sidebar="sidebar"]'));
  const rail = [...document.querySelectorAll('[data-sidebar="sidebar"]:not([data-mobile="true"])')].filter(vis);

  // The navigation control must neither cover anything nor be covered.
  const interactive = [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")].filter(vis);
  const conflicts = [...menuBtn, ...insetTriggers].flatMap((c) => {
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const covered = !(hit && (hit === c || c.contains(hit)));
    const overlaps = interactive
      .filter((o) => o !== c && !c.contains(o) && !o.contains(c))
      .filter((o) => { const q = o.getBoundingClientRect(); return !(q.right <= r.left || q.left >= r.right || q.bottom <= r.top || q.top >= r.bottom); })
      .map((o) => (o.getAttribute("aria-label") || o.innerText || o.tagName).replace(/\s+/g, " ").trim().slice(0, 24));
    return [...(covered ? [`covered by <${hit ? hit.tagName.toLowerCase() : "nothing"}>`] : []), ...overlaps];
  });

  return {
    path: location.pathname, w: innerWidth, h: innerHeight,
    header: !!header && vis(header),
    rowItems: rowItems.length, menuBtn: menuBtn.length,
    rail: rail.length,
    drawer: document.querySelectorAll('[data-sidebar="sidebar"][data-mobile="true"]').length,
    insetTriggers: insetTriggers.length, sidebarTriggers: sidebarTriggers.length,
    shell: document.querySelectorAll("#pwa-fo-back, #pwa-fo-sidebar-toggle").length,
    conflicts,
    overflowX: document.documentElement.scrollWidth - innerWidth,
    geometry: {
      header: header ? box(header) : null,
      row: rowItems.map(box),
      rail: rail.map(box),
      inset: inset ? box(inset) : null,
      triggers: triggers.map(box),
    },
  };
});

async function loaderIdRoute(p) {
  const seen = [];
  const listen = async (r) => {
    if (/\/api\//.test(r.url()) && /(package|loader|cmf)/i.test(r.url()) && r.request().method() === "GET") {
      try { seen.push(await r.json()); } catch { /* not JSON */ }
    }
  };
  p.on("response", listen);
  await go(p, APP, "/modeling-agent/loader");
  p.off("response", listen);
  const walk = (j) => {
    if (Array.isArray(j)) { for (const x of j) if (x && typeof x === "object" && "id" in x) return x.id; for (const x of j) { const r = walk(x); if (r) return r; } }
    else if (j && typeof j === "object") for (const v of Object.values(j)) { const r = walk(v); if (r) return r; }
    return null;
  };
  let id = null;
  for (const j of seen) { id = walk(j); if (id) break; }
  return `/modeling-agent/loader/${encodeURIComponent(id ?? LOADER_ID_FALLBACK)}`;
}

const browser = await chromium.launch();

// ── 1. One navigation system at every width ─────────────────────────────────
if (PART === "all" || PART === "matrix") {
  for (const [label, opts, installed] of WIDTHS) {
    section(`1. ${label}`);
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    if (installed) installedPages.add(p);
    await signIn(p, APP);
    const routes = ["/home", "/reports", "/chat", "/modeling-agent", "/modeling-agent/loader", await loaderIdRoute(p)];
    for (const route of routes) {
      const name = route.startsWith("/modeling-agent/loader/") ? "/modeling-agent/loader/[id]" : route;
      await go(p, APP, route);
      const s = await state(p);
      const mobile = installed && s.w < 768;
      if (COCKPIT_ROUTES.includes(route)) {
        record(`${name}: FabOrchestrator's header is there`, s.header, "");
        if (mobile) record(`${name}: one navigation — the menu button, not the row`, s.menuBtn === 1 && s.rowItems === 0, `menu ${s.menuBtn}, row items ${s.rowItems}`);
        else record(`${name}: one navigation — the row, not the menu`, s.rowItems === 5 && s.menuBtn === 0, `row items ${s.rowItems}, menu ${s.menuBtn}`);
      } else if (mobile) {
        record(`${name}: one navigation — the bar's trigger, drawer closed`,
          s.insetTriggers === 1 && s.sidebarTriggers === 0 && s.rail === 0 && s.drawer === 0,
          `bar trigger ${s.insetTriggers}, sidebar trigger ${s.sidebarTriggers}, rail ${s.rail}, drawer ${s.drawer}`);
      } else {
        record(`${name}: one navigation — the sidebar and its own trigger`,
          s.rail === 1 && s.sidebarTriggers === 1 && s.insetTriggers === 0,
          `rail ${s.rail}, sidebar trigger ${s.sidebarTriggers}, bar trigger ${s.insetTriggers}`);
      }
      record(`${name}: no navigation injected by this app`, s.shell === 0, `${s.shell} found`);
      record(`${name}: the control covers nothing and is not covered`, s.conflicts.length === 0, s.conflicts.join(", "));
      record(`${name}: no sideways scrolling`, s.overflowX <= 0, `${s.overflowX}px`);
      await p.screenshot({ path: path.join(OUT, `${slug(label)}_${slug(name)}.png`) });
    }
    await ctx.close();
  }
}

// ── 2. Tapping FabOrchestrator's own controls to every destination ──────────
if (PART === "all" || PART === "taps") {
  for (const [label, opts] of [WIDTHS[0], WIDTHS[2]]) {
    section(`2. ${label} — tapping through`);
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    installedPages.add(p);
    await signIn(p, APP);
    const menuItems = () => p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')]
      .map((e) => ({ t: e.innerText.trim(), current: e.getAttribute("aria-current") })));

    // The cockpit's menu.
    await go(p, APP, "/home");
    await p.locator('button[aria-label="Open navigation"]').click({ timeout: 20000 });
    await p.waitForTimeout(1200);
    let items = await menuItems();
    record("/home: the menu offers Cockpit, Chat and Reports", ["Cockpit", "Chat", "Reports"].every((t) => items.some((i) => i.t === t)), items.map((i) => i.t).join(" · "));
    record("/home: …with Cockpit marked as the current page", items.find((i) => i.t === "Cockpit")?.current === "page", "");
    await p.screenshot({ path: path.join(OUT, `${slug(label)}_home-menu-open.png`) });
    await p.getByRole("menuitem", { name: "Reports" }).click();
    await p.waitForURL((u) => u.pathname === "/reports", { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(5000);
    record("/home → menu → Reports lands on /reports", where(p) === "/reports", where(p));

    await p.locator('button[aria-label="Open navigation"]').click({ timeout: 20000 });
    await p.waitForTimeout(1200);
    items = await menuItems();
    record("/reports: the same menu, Reports current", items.find((i) => i.t === "Reports")?.current === "page", items.map((i) => `${i.t}${i.current ? "*" : ""}`).join(" · "));
    // Chat is shown but disabled in the installed app (11 September).
    const chatItem = p.getByRole("menuitem", { name: "Chat" });
    record("/reports: Chat is in the menu, disabled", await chatItem.isDisabled().catch(() => false), "");
    const chatBox = await chatItem.boundingBox();
    if (chatBox) await p.mouse.click(chatBox.x + chatBox.width / 2, chatBox.y + chatBox.height / 2);
    await p.waitForTimeout(2500);
    record("/reports: …and tapping it goes nowhere", where(p) === "/reports", where(p));
    await p.keyboard.press("Escape");
    await go(p, APP, "/chat");

    // The chat's drawer.
    const openDrawer = async () => {
      await p.locator('#main-content [data-sidebar="trigger"]').click({ timeout: 20000 });
      await p.waitForTimeout(1800);
      return p.evaluate(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const drawer = document.querySelector('[data-sidebar="sidebar"][data-mobile="true"]');
        const named = (re) => drawer ? [...drawer.querySelectorAll("button,a")].filter((e) => vis(e) && re.test(e.getAttribute("aria-label") || e.innerText)).length : 0;
        return {
          open: !!drawer,
          back: named(/back to faborchestrator overview/i),
          newChat: named(/^\s*new chat\s*$/i),
          dashboard: named(/^\s*dashboard\s*$/i),
          loader: named(/master data loader/i),
          account: drawer ? drawer.querySelectorAll('[data-slot="sidebar-footer"] button').length : 0,
        };
      });
    };
    let d = await openDrawer();
    record("/chat: the bar's trigger opens FabOrchestrator's drawer", d.open, "");
    record("/chat: …with Back to overview, New chat, Dashboard and the account menu", d.back > 0 && d.newChat > 0 && d.dashboard > 0 && d.account > 0,
      `back ${d.back}, new chat ${d.newChat}, dashboard ${d.dashboard}, account ${d.account}`);
    await p.screenshot({ path: path.join(OUT, `${slug(label)}_chat-drawer-open.png`) });
    await p.getByRole("button", { name: /^\s*Dashboard\s*$/ }).first().click({ timeout: 20000 });
    await p.waitForURL((u) => u.pathname === "/reports", { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(5000);
    record("/chat → drawer → Dashboard lands on /reports", where(p) === "/reports", where(p));

    await go(p, APP, "/chat");
    await openDrawer();
    await p.locator('[data-sidebar="sidebar"][data-mobile="true"] [aria-label="Back to FabOrchestrator overview"]').click({ timeout: 20000 });
    await p.waitForURL((u) => u.pathname === "/home", { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(4000);
    record("/chat → drawer → Back to overview lands on /home", where(p) === "/home", where(p));

    // Closing it is FabOrchestrator's own overlay.
    await go(p, APP, "/chat");
    await openDrawer();
    const vp = p.viewportSize();
    await p.mouse.click(vp.width - 12, Math.round(vp.height / 2));
    await p.waitForTimeout(1500);
    const closed = await p.evaluate(() => document.querySelectorAll('[data-sidebar="sidebar"][data-mobile="true"]').length === 0);
    record("/chat: tapping outside closes the drawer", closed, "");

    // The modeling agent's drawer.
    await go(p, APP, "/modeling-agent");
    d = await openDrawer();
    record("/modeling-agent: the bar's trigger opens its drawer", d.open, "");
    record("/modeling-agent: …with Back to overview and Master data loader", d.back > 0 && d.loader > 0, `back ${d.back}, loader ${d.loader}`);
    await p.screenshot({ path: path.join(OUT, `${slug(label)}_modeling-drawer-open.png`) });
    await p.getByRole("button", { name: /master data loader/i }).first().click({ timeout: 20000 });
    await p.waitForTimeout(3000);
    const loaderShown = await p.getByText("Master Data Loader", { exact: true }).first().isVisible().catch(() => false);
    record("/modeling-agent → drawer → Master data loader shows the loader", loaderShown, where(p));

    // Reports: a report opened from far down the list.
    await go(p, APP, "/reports");
    await p.evaluate(() => { const c = document.querySelector(".cockpit-v2"); if (c) c.scrollTo({ top: c.scrollHeight }); });
    await p.waitForTimeout(900);
    const cards = p.locator("div.group.cursor-pointer");
    const n = await cards.count();
    if (n === 0) {
      record("/reports: pinned reports to open", false, "none pinned");
    } else {
      await cards.nth(n - 1).click({ timeout: 20000 });
      await p.waitForTimeout(6000);
      const back = await p.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((e) => e.innerText.trim() === "All reports");
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight };
      });
      record("/reports: a report opened from the bottom of the list shows \"All reports\" on screen", !!back && back.top >= 60 && back.bottom <= back.h, JSON.stringify(back));
      record("/reports: …and FabOrchestrator's header is still there", (await state(p)).header, "");
      await p.screenshot({ path: path.join(OUT, `${slug(label)}_report-open.png`) });
      await p.getByRole("button", { name: "All reports" }).click({ timeout: 20000 });
      await p.waitForTimeout(1500);
      record("/reports: \"All reports\" returns to the list", await p.getByRole("button", { name: "Back to chat" }).isVisible().catch(() => false), "");
    }
    await ctx.close();
  }
}

// ── 3. Desktop identical to FabOrchestrator production ──────────────────────
if (PART === "all" || PART === "parity") {
  section("3. 1280 desktop — geometry against FabOrchestrator production");
  const read = async (base) => {
    const ctx = await browser.newContext(WIDTHS[4][1]);
    const p = await ctx.newPage();
    await signIn(p, base);
    const out = {};
    for (const route of ["/home", "/reports", "/chat", "/modeling-agent"]) {
      await go(p, base, route);
      out[route] = (await state(p)).geometry;
    }
    await ctx.close();
    return out;
  };
  const [prod, preview] = await Promise.all([read(DIRECT), read(APP)]);
  const close = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => close(x, b[i])))
    || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1);
  for (const route of Object.keys(prod)) {
    for (const key of Object.keys(prod[route])) {
      const same = close(prod[route][key], preview[route][key]);
      record(`${route}: ${key} matches production`, same, same ? "" : `production ${JSON.stringify(prod[route][key])} vs preview ${JSON.stringify(preview[route][key])}`);
    }
  }
}

await browser.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
