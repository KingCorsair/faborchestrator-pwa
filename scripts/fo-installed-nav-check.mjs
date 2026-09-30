/**
 * FabOrchestrator's navigation in every context the PWA is used in.
 *
 * ── What is supposed to hold (Amay, 11 September) ───────────────────────────
 *   desktop browser        FabOrchestrator's website, exactly
 *   phone browser          FabOrchestrator's website, plus one thing: the
 *                          sidebar trigger bar on /chat and /modeling-agent*,
 *                          so its sidebars stay reachable ("keep sidebars
 *                          reachable"). /home and /reports keep the website's
 *                          header — no phone menu
 *   installed app, phone   the phone navigation: the header menu on /home and
 *                          /reports (Cockpit, Chat **disabled**, Reports) and
 *                          the same trigger bar on the agent pages
 *
 * ── How the installed app is detected, and reproduced here ──────────────────
 * FabOrchestrator sets `data-installed-app` on <html> before first paint from
 * `display-mode` (standalone, fullscreen, minimal-ui) or iOS's own
 * `navigator.standalone` (`lib/installed-app.ts`); the `installed-phone:` CSS
 * variant is that attribute and `max-width: 767px`. iOS reports an installed
 * app with a `standalone` manifest as `display-mode: fullscreen` (WebKit bug
 * 264218). Chromium here cannot install a PWA over DevTools and ignores
 * display-mode emulation, but the Fullscreen API makes it report
 * `display-mode: fullscreen`, so installed cases enter it and FabOrchestrator's
 * own detection decides. The iPhone itself is still the final check.
 *
 * ── The cases ───────────────────────────────────────────────────────────────
 *   1  desktop browser               Chromium 1280×900
 *   2  mobile-width browser          Chromium 390×664, not a mobile device
 *   3  Safari / mobile browser       WebKit, iPhone 13 profile
 *   4  installed app, portrait       Chromium, iPhone 13, display-mode: fullscreen
 *   5  installed app, landscape      Chromium, iPhone 13 landscape (750×342), fullscreen
 *
 * Browser cases are compared with FabOrchestrator production at the same
 * engine and viewport. Installed cases also cycle the sidebar open and shut,
 * sampling every animation frame, to prove the external control never leaves.
 *
 * Read-only: no model turns, no writes. Opening a pinned report reads its saved
 * snapshot and never queries the MES.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/fo-installed-nav-check.mjs
 *       (CASE=1..5 runs one case, so they can run in parallel)
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
const DIRECT = (env.FABORCH_BASE_URL ?? "").replace(/\/$/, "");
const ONLY = process.env.CASE ? Number(process.env.CASE) : null;
const OUT = path.join(ROOT, "docs", "probes", "fo-installed-nav");
fs.mkdirSync(OUT, { recursive: true });
const LOADER_ID = "52883280-79c2-4a26-b413-b87f4066cf7d";

let failures = 0;
const record = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
const where = (p) => new URL(p.url()).pathname;

const CASES = [
  { n: 1, label: "desktop browser", engine: chromium, opts: { viewport: { width: 1280, height: 900 } }, installed: false },
  { n: 2, label: "mobile-width browser", engine: chromium, opts: { viewport: { width: 390, height: 664 } }, installed: false },
  { n: 3, label: "Safari / mobile browser (WebKit, iPhone 13)", engine: webkit, opts: { ...devices["iPhone 13"] }, installed: false },
  { n: 4, label: "installed app, 390 portrait", engine: chromium, opts: { ...devices["iPhone 13"] }, installed: true },
  { n: 5, label: "installed app, 750 real-iPhone landscape", engine: chromium, opts: { ...devices["iPhone 13 landscape"] }, installed: true },
];
const COCKPIT = ["/home", "/reports"];
const AGENT = ["/chat", "/modeling-agent", "/modeling-agent/loader", `/modeling-agent/loader/${LOADER_ID}`];
const nameOf = (r) => (r.startsWith("/modeling-agent/loader/") ? "/modeling-agent/loader/[id]" : r);

async function signIn(p, base) {
  if (base === DIRECT) {
    await p.goto(`${base}/`, { waitUntil: "load", timeout: 90000 });
    await p.waitForSelector('input[type="email"]', { timeout: 60000 });
    await p.fill('input[type="email"]', env.FABORCH_PROBE_EMAIL);
    await p.fill('input[type="password"]', env.FABORCH_PROBE_PASSWORD);
    await p.press('input[type="password"]', "Enter");
    await p.waitForURL((u) => u.pathname !== "/", { timeout: 60000 }).catch(() => {});
  } else {
    await p.goto(`${base}/login`, { waitUntil: "load", timeout: 90000 });
    await p.waitForSelector('input[name="email"]', { timeout: 60000 });
    await p.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
    await p.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
    await p.press('input[name="password"]', "Enter");
    await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  }
  await p.waitForTimeout(2000);
}

/** The display mode an installed iPhone app reports. Lost on a full navigation. */
async function enterInstalled(p) {
  await p.evaluate(() => (document.fullscreenElement ? true : document.documentElement.requestFullscreen().then(() => true, () => false)));
  await p.waitForTimeout(800);
}

async function go(p, base, route, installed) {
  await p.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await p.waitForTimeout(7500);
  if (installed) await enterInstalled(p);
}

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
  const brandBlock = brand ? brand.parentElement?.parentElement : null;
  const inset = document.getElementById("main-content");
  const menu = [...document.querySelectorAll('button[aria-label="Open navigation"]')].filter(vis);
  const bar = inset ? [...inset.querySelectorAll('[data-sidebar="trigger"]')].filter(vis) : [];
  const rail = [...document.querySelectorAll('[data-sidebar="sidebar"]:not([data-mobile="true"])')].filter(vis);
  const railTrigger = [...document.querySelectorAll('[data-sidebar="sidebar"] [data-sidebar="trigger"]')].filter(vis);

  // The external control must neither cover anything nor be covered.
  const interactive = [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")].filter(vis);
  const conflicts = [...menu, ...bar].flatMap((c) => {
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
    w: innerWidth,
    displayMode: ["browser", "standalone", "fullscreen"].find((m) => matchMedia(`(display-mode: ${m})`).matches) ?? "?",
    installedAttr: document.documentElement.hasAttribute("data-installed-app"),
    header: !!header && vis(header),
    row: header ? [...header.querySelectorAll("nav button")].filter(vis).length : 0,
    menu: menu.length, bar: bar.length, rail: rail.length, railTrigger: railTrigger.length,
    drawer: document.querySelectorAll('[data-sidebar="sidebar"][data-mobile="true"]').length,
    shell: document.querySelectorAll("#pwa-fo-back, #pwa-fo-sidebar-toggle").length,
    conflicts,
    overflowX: document.documentElement.scrollWidth - innerWidth,
    geometry: {
      header: header ? box(header) : null,
      brand: brandBlock ? box(brandBlock) : null,
      inset: inset ? box(inset) : null,
      rail: rail.map(box),
    },
  };
});

/** Scroll the Reports list to the bottom, open the last report: where is "All reports"? */
async function openFromBottom(p) {
  await p.evaluate(() => { const c = document.querySelector(".cockpit-v2"); if (c) c.scrollTo({ top: c.scrollHeight }); });
  await p.waitForTimeout(900);
  const cards = p.locator("div.group.cursor-pointer");
  const n = await cards.count();
  if (!n) return null;
  await cards.nth(n - 1).click({ timeout: 20000 });
  await p.waitForTimeout(6000);
  return p.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((e) => e.innerText.trim() === "All reports");
    const c = document.querySelector(".cockpit-v2");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { top: Math.round(r.top), onScreen: r.top >= 60 && r.bottom <= innerHeight, scrollTop: Math.round(c ? c.scrollTop : -1) };
  });
}

/**
 * Open and shut the sidebar `cycles` times, sampling every animation frame:
 * is there ever a frame with neither the sidebar nor a tappable external
 * control, and does the control ever vanish or move?
 */
async function cycleSidebar(p, cycles = 5) {
  await p.evaluate(() => {
    window.__s = [];
    window.__run = true;
    (function tick() {
      const bar = document.querySelector('#main-content [data-sidebar="trigger"]');
      const drawer = !!document.querySelector('[data-sidebar="sidebar"][data-mobile="true"]');
      let hit = false; let rect = null;
      if (bar) {
        const r = bar.getBoundingClientRect();
        rect = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`;
        const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        hit = !!h && (h === bar || bar.contains(h));
      }
      window.__s.push({ drawer, display: bar ? getComputedStyle(bar).display : "absent", hit, rect });
      if (window.__run) requestAnimationFrame(tick);
    })();
  });
  const vp = p.viewportSize();
  for (let i = 0; i < cycles; i++) {
    await p.locator('#main-content [data-sidebar="trigger"]').click({ timeout: 15000 });
    await p.waitForTimeout(1200);
    await p.mouse.click(vp.width - 12, Math.round(vp.height / 2));
    await p.waitForTimeout(1200);
  }
  return p.evaluate(() => {
    window.__run = false;
    const s = window.__s;
    return {
      frames: s.length,
      opened: s.filter((x) => x.drawer).length,
      vanished: s.filter((x) => x.display === "none" || x.display === "absent").length,
      gaps: s.filter((x) => !x.drawer && !x.hit).length,
      positions: [...new Set(s.filter((x) => !x.drawer && x.hit).map((x) => x.rect))],
      endsClosed: !s[s.length - 1].drawer,
    };
  });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i])))
  || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1);

for (const c of CASES) {
  if (ONLY && c.n !== ONLY) continue;
  section(`${c.n}. ${c.label}`);
  const browser = await c.engine.launch();
  const phone = (c.opts.viewport?.width ?? 1280) < 768;

  const read = async (base) => {
    const ctx = await browser.newContext(c.opts);
    const p = await ctx.newPage();
    const installed = c.installed && base === APP;
    await signIn(p, base);
    const out = {};
    for (const route of [...COCKPIT, ...AGENT]) {
      await go(p, base, route, installed);
      out[route] = await state(p);
      if (base === APP) await p.screenshot({ path: path.join(OUT, `${c.n}${nameOf(route).replace(/[/[\]]/g, "_")}.png`) });
    }
    await go(p, base, "/reports", installed);
    out.report = await openFromBottom(p);
    if (base === APP) await p.screenshot({ path: path.join(OUT, `${c.n}_report-open.png`) });
    return { out, p, ctx };
  };

  const gw = await read(APP);

  if (!c.installed) {
    const prod = await read(DIRECT);
    for (const route of [...COCKPIT, ...AGENT]) {
      const s = gw.out[route];
      const ref = prod.out[route];
      const n = nameOf(route);
      record(`${n}: a browser — not treated as the installed app`, s.displayMode === "browser" && !s.installedAttr, `display-mode ${s.displayMode}`);
      record(`${n}: nothing injected by this app`, s.shell === 0, `${s.shell} found`);
      if (!phone) {
        // FabOrchestrator's website, exactly.
        record(`${n}: no phone header menu`, s.menu === 0, `menu ${s.menu}`);
        record(`${n}: navigation as FabOrchestrator production`,
          s.row === ref.row && s.rail === ref.rail && s.railTrigger === ref.railTrigger && s.menu === ref.menu && s.bar === ref.bar,
          `row ${s.row}/${ref.row}, rail ${s.rail}/${ref.rail}, trigger ${s.railTrigger}/${ref.railTrigger}, bar ${s.bar}/${ref.bar}`);
        for (const k of ["header", "brand", "inset", "rail"]) {
          if (!ref.geometry[k] && !s.geometry[k]) continue;
          const ok = same(s.geometry[k], ref.geometry[k]);
          record(`${n}: ${k} geometry as production`, ok, ok ? "" : `${JSON.stringify(s.geometry[k])} vs ${JSON.stringify(ref.geometry[k])}`);
        }
      } else if (COCKPIT.includes(route)) {
        // Below 768px the header's row is replaced by its menu in every
        // context, browser included — never zero navigation (11 September).
        record(`${n}: the header's phone menu, not the row`, s.menu === 1 && s.row === 0, `menu ${s.menu}, row ${s.row}`);
        record(`${n}: …the control covers nothing and is not covered`, s.conflicts.length === 0, s.conflicts.join(", "));
      } else {
        // A phone browser on an agent page: the sidebar stays reachable.
        record(`${n}: FabOrchestrator's sidebar trigger bar, sidebar closed`, s.bar === 1 && s.drawer === 0 && s.rail === 0, `bar ${s.bar}, drawer ${s.drawer}, rail ${s.rail}`);
        record(`${n}: …the control covers nothing and is not covered`, s.conflicts.length === 0, s.conflicts.join(", "));
      }
      record(`${n}: no sideways scrolling`, s.overflowX <= 0, `${s.overflowX}px`);
    }
    const r = gw.out.report;
    const rr = prod.out.report;
    record("opened report: scrolls as on production, All reports present", !!r && !!rr && Math.abs(r.scrollTop - rr.scrollTop) <= 2,
      `${JSON.stringify(r)} vs production ${JSON.stringify(rr)}`);
    if (phone) {
      // The one addition on a phone browser must actually open the sidebar.
      const p = gw.p;
      await go(p, APP, "/chat", false);
      await p.locator('#main-content [data-sidebar="trigger"]').click({ timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(1800);
      const back = await p.locator('[data-sidebar="sidebar"][data-mobile="true"] [aria-label="Back to FabOrchestrator overview"]').isVisible().catch(() => false);
      record("/chat: the trigger opens FabOrchestrator's sidebar, with its Back to overview", back, "");
    }
    await prod.ctx.close();
  } else {
    for (const route of [...COCKPIT, ...AGENT]) {
      const s = gw.out[route];
      const n = nameOf(route);
      record(`${n}: treated as the installed app`, s.installedAttr, `display-mode ${s.displayMode}, width ${s.w}`);
      if (COCKPIT.includes(route)) {
        record(`${n}: the header's phone menu, not the row`, s.menu === 1 && s.row === 0, `menu ${s.menu}, row ${s.row}`);
      } else {
        record(`${n}: exactly one external control — the trigger bar — with the sidebar closed`,
          s.bar === 1 && s.railTrigger === 0 && s.menu === 0 && s.drawer === 0 && s.rail === 0,
          `bar ${s.bar}, rail trigger ${s.railTrigger}, menu ${s.menu}, drawer ${s.drawer}`);
      }
      record(`${n}: the control covers nothing and is not covered`, s.conflicts.length === 0, s.conflicts.join(", "));
      record(`${n}: nothing injected by this app`, s.shell === 0, `${s.shell} found`);
      record(`${n}: no sideways scrolling`, s.overflowX <= 0, `${s.overflowX}px`);
    }
    record("opened report: All reports on screen", !!gw.out.report && gw.out.report.onScreen, JSON.stringify(gw.out.report));

    const p = gw.p;

    // ── The sidebar, opened and shut: never a frame without navigation ──────
    for (const route of AGENT) {
      await go(p, APP, route, true);
      const f = await cycleSidebar(p, 5);
      const n = nameOf(route);
      record(`${n}: 5 open/close cycles — the sidebar opened`, f.opened > 0 && f.endsClosed, `${f.opened} of ${f.frames} frames open`);
      record(`${n}: …the external control never left the page`, f.vanished === 0, `${f.vanished} frames without it`);
      record(`${n}: …no frame with neither sidebar nor tappable control`, f.gaps === 0, `${f.gaps} gap frames`);
      record(`${n}: …it never moved`, f.positions.length === 1, f.positions.join(" | "));
    }

    // ── The menu, item by item ──────────────────────────────────────────────
    await go(p, APP, "/home", true);
    const menuBtn = p.locator('button[aria-label="Open navigation"]');
    await menuBtn.click({ timeout: 20000 });
    await p.waitForTimeout(1200);
    const items = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((e) => {
      const cs = getComputedStyle(e);
      return { t: e.innerText.trim(), ariaDisabled: e.getAttribute("aria-disabled"), dataDisabled: e.hasAttribute("data-disabled"),
        opacity: cs.opacity, pointer: cs.pointerEvents, bg: cs.backgroundColor };
    }));
    const it = (t) => items.find((i) => i.t === t) ?? {};
    record("menu: Cockpit, Chat, Reports — nothing added", items.map((i) => i.t).join(",") === "Cockpit,Chat,Reports", items.map((i) => i.t).join(" · "));
    record("Chat: announced as disabled", it("Chat").ariaDisabled === "true" && it("Chat").dataDisabled === true, `aria-disabled=${it("Chat").ariaDisabled}`);
    record("Chat: looks disabled", Number(it("Chat").opacity) <= 0.55, `opacity ${it("Chat").opacity}`);
    record("Chat: takes no pointer", it("Chat").pointer === "none", `pointer-events ${it("Chat").pointer}`);
    record("Cockpit and Reports: active", !it("Cockpit").ariaDisabled && !it("Reports").ariaDisabled
      && Number(it("Cockpit").opacity) === 1 && Number(it("Reports").opacity) === 1, "");

    const chat = p.getByRole("menuitem", { name: "Chat" });
    const box = await chat.boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.waitForTimeout(500);
    const hovered = await chat.evaluate((e) => ({ highlighted: e.hasAttribute("data-highlighted"), bg: getComputedStyle(e).backgroundColor }));
    record("Chat: no hover highlight", !hovered.highlighted && hovered.bg === it("Chat").bg, `highlighted ${hovered.highlighted}, background ${hovered.bg}`);
    await p.screenshot({ path: path.join(OUT, `${c.n}_menu-chat-disabled.png`) });

    await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await p.waitForTimeout(2500);
    record("Chat: tapping it does not navigate", where(p) === "/home", where(p));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(600);

    // Keyboard: open from the button, then down, down — Chat is skipped.
    await menuBtn.focus();
    await p.keyboard.press("Enter");
    await p.waitForTimeout(900);
    const focusAfter = async () => { await p.keyboard.press("ArrowDown"); await p.waitForTimeout(250); return p.evaluate(() => document.activeElement?.innerText?.trim()); };
    const f1 = await focusAfter();
    const f2 = await focusAfter();
    record("Chat: skipped by the keyboard", f1 !== "Chat" && f2 !== "Chat" && [f1, f2].includes("Reports"), `focus ${f1} → ${f2}`);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(600);

    await menuBtn.click({ timeout: 20000 });
    await p.waitForTimeout(1200);
    await p.getByRole("menuitem", { name: "Reports" }).click();
    await p.waitForURL((u) => u.pathname === "/reports", { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(4000);
    record("Reports: navigates to /reports", where(p) === "/reports", where(p));

    await menuBtn.click({ timeout: 20000 });
    await p.waitForTimeout(1200);
    await p.getByRole("menuitem", { name: "Cockpit" }).click();
    await p.waitForURL((u) => u.pathname === "/home", { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(4000);
    record("Cockpit: navigates to /home", where(p) === "/home", where(p));
  }
  await gw.ctx.close();
  await browser.close();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
