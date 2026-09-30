/**
 * Is this still an installable PWA, on the pages people actually use?
 *
 * ── The regression this exists to prevent ───────────────────────────────────
 * Reported 10 September: Chrome stopped offering to install the preview — not
 * the app's own Install button, Chrome's own affordance. Whole-application
 * embedding had moved the landing page to FabOrchestrator's `/home`, and this
 * app emits `<link rel="manifest">` from `app/layout.tsx`, which only renders
 * on **its own** documents. So every page an operator stood on had no manifest,
 * and Chrome had nothing to install. Measured with Chrome's own check:
 * `Page.getAppManifest` → `hasData: false` on `/home`, `/chat` and `/reports`.
 *
 * **Nothing failed.** No error, no console warning, every check green. The app
 * simply stopped being installable. That is why this file exists and why it
 * asserts against Chrome's own manifest parser rather than against the HTML:
 * a `<link>` that is present but unparseable would pass a grep and fail a user.
 *
 * Installability needs both halves — a manifest **and** a service worker
 * controlling the page — so both are checked on every FabOrchestrator surface.
 *
 * Read-only: no model turns, no writes.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/pwa-install-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Page.enable").catch(() => {});

async function signIn(p) {
  await p.goto(`${APP}/login`, { waitUntil: "networkidle", timeout: 60000 });
  await p.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
  await p.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
  await p.press('input[name="password"]', "Enter");
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(6000);
}

// ── 1. The manifest itself ──────────────────────────────────────────────────
section("1. the manifest this app serves");
{
  const res = await page.request.get(`${APP}/manifest.webmanifest`);
  record("it is served", res.status() === 200, `HTTP ${res.status()}`);
  const m = await res.json().catch(() => null);
  record("…as JSON Chrome can parse", !!m, "");
  if (m) {
    record("…with a name and short_name", !!m.name && !!m.short_name, `${m.name} / ${m.short_name}`);
    record("…display: standalone", m.display === "standalone", m.display);
    record("…a start_url and a scope", !!m.start_url && !!m.scope, `${m.start_url} in ${m.scope}`);
    // Chrome needs a 192 and a 512 to offer installation.
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    record("…icons at 192 and 512", sizes.includes("192x192") && sizes.includes("512x512"), sizes.join(" "));
    record("…and a maskable icon for Android", (m.icons ?? []).some((i) => (i.purpose ?? "").includes("maskable")), "");
  }
  const su = await page.request.get(`${APP}${m?.start_url ?? "/"}`, { maxRedirects: 5 });
  record("start_url resolves to a real page", su.status() === 200, `HTTP ${su.status()}`);
  const sw = await page.request.get(`${APP}/sw.js`);
  record("the service worker is served", sw.status() === 200, `HTTP ${sw.status()}`);
}

// ── 2. Chrome's own verdict, on FabOrchestrator's pages ────────────────────
section("2. Chrome's own manifest parser, on the pages people use");
await signIn(page);
for (const [label, url] of [
  ["the landing page", null],
  ["/home", `${APP}/home`],
  ["/chat", `${APP}/chat`],
  ["/reports", `${APP}/reports`],
]) {
  if (url) {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(7000);
  }
  const dom = await page.evaluate(async () => {
    let reg = null, controller = null;
    try {
      const r = await navigator.serviceWorker.getRegistration("/");
      reg = r ? (r.active ? "active" : "registered") : null;
      controller = navigator.serviceWorker.controller?.scriptURL ?? null;
    } catch { /* storage unavailable */ }
    const html = document.documentElement.innerHTML;
    return {
      path: location.pathname,
      hasLink: !!document.querySelector('link[rel="manifest"]'),
      appleCapable: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'),
      reg, controller,
      isFo: html.split('="/_next/static/').length - 1 > 0 && html.split("/pwa-assets/_next/").length - 1 === 0,
    };
  });
  // The real test: not "is there a link" but "did Chrome parse a manifest".
  let parsed = { hasData: false, errors: -1 };
  try {
    const r = await cdp.send("Page.getAppManifest");
    parsed = { hasData: !!r.data, errors: (r.errors ?? []).length };
  } catch { /* CDP unavailable */ }

  record(`${label}: Chrome parsed a manifest here`, parsed.hasData && parsed.errors === 0, `hasData=${parsed.hasData} errors=${parsed.errors} · ${dom.path}`);
  record(`${label}: …a service worker controls the page`, dom.reg === "active" && !!dom.controller, `${dom.reg ?? "none"}, controller ${dom.controller ? "yes" : "no"}`);
  if (url) record(`${label}: …and it is FabOrchestrator's own page`, dom.isFo, dom.isFo ? "" : "not FO-rendered");
  record(`${label}: …with the iOS standalone tag`, dom.appleCapable, "");
}

// ── 3. A real standalone launch ────────────────────────────────────────────
section("3. launching it the way an installed copy does");
{
  // ⚠ **What this can and cannot prove.** A genuine standalone launch needs a
  // real installed app record, and Playwright cannot produce one: launched with
  // `--app=`, both headless *and* headed Chromium still report
  // `display-mode: browser` (measured both ways, 10 September). So the display
  // mode is **observed and reported, not asserted** — claiming a pass here would
  // be claiming something this harness cannot see.
  //
  // What is asserted is everything that decides whether the launch works at
  // all: that `start_url` resolves, that it lands on FabOrchestrator's cockpit
  // rather than a sign-in page or a 404, and that the session survives. The
  // manifest's own `display: standalone` is asserted in section 1. The
  // remaining question — does the installed window open without browser chrome
  // — is on the manual checklist, on a real device.
  const appBrowser = await chromium.launch({ args: [`--app=${APP}/`] });
  const appCtx = await appBrowser.newContext();
  const ap = await appCtx.newPage();
  await signIn(ap);
  await ap.goto(`${APP}/`, { waitUntil: "load", timeout: 60000 });
  await ap.waitForTimeout(7000);
  const s = await ap.evaluate(() => ({
    path: location.pathname,
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    signedOut: /sign in|log in/i.test(document.body.innerText) && document.querySelectorAll('input[type="password"]').length > 0,
    isFo: document.documentElement.innerHTML.split('="/_next/static/').length - 1 > 0,
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 80),
  }));
  record("start_url lands on FabOrchestrator's cockpit", s.path === "/home" && s.isFo, `${s.path} · ${s.text}`);
  record("…still signed in, no second login", !s.signedOut, "");
  console.log(`  NOTE  display-mode reported by this harness: ${s.standalone ? "standalone" : "browser"} — Playwright cannot open a real installed app; verify standalone on a device`);
  await ap.screenshot({ path: path.join(OUT, "standalone-launch.png") });
  await appBrowser.close();
}

await ctx.close();
await browser.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
