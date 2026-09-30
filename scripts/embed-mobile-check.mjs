/**
 * The embedded FabOrchestrator chat, in a phone-sized browser.
 *
 * The live check proves the document and its assets arrive. This proves what a
 * person actually sees: it signs in through the PWA's own form, opens `/chat`
 * on the PWA origin, and records what the page does — whether FabOrchestrator's
 * own client renders, what it does about the session, whether anything scrolls
 * sideways, and what lands in the console.
 *
 * ── What it is reading for ──────────────────────────────────────────────────
 * Under WP1 the gateway forwarded without authenticating, so FabOrchestrator
 * answered 401 to every data call its own client made, and FO's fetch wrapper
 * read that as an expired session and showed its "You've been signed out"
 * modal. Under WP2 the gateway injects the real token and those same calls
 * answer 200, so the modal must not appear and the session must survive. The
 * `expiredModal` and `tokenKeyPresent` fields are what separate the two: WP1
 * measured true/false, WP2 measures false/true.
 *
 * Screenshots and a JSON summary land in `SHOTS_DIR`, or
 * `docs/probes/wp2-shots/` — name it per package, because a later run
 * overwrites an earlier one's images in the same folder.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/embed-mobile-check.mjs
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
const APP = (process.env.APP_URL ?? "https://faborch-embed-preview.fly.dev").replace(/\/$/, "");
const OUT = process.env.OUT_DIR ?? path.join(ROOT, "docs", "probes", process.env.SHOTS_DIR ?? "wp2-shots");
if (!env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const viewports = [
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "360x640", viewport: { width: 360, height: 640 } },
];
const results = [];
const browser = await chromium.launch();

try {
  for (const vp of viewports) {
    const ctx = await browser.newContext({
      ...devices["iPhone 13"],
      viewport: vp.viewport,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    const consoleErrors = [];
    const failedRequests = [];
    const apiCalls = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
    });
    page.on("response", (r) => {
      const u = r.url().replace(APP, "");
      if (u.startsWith("/api/")) apiCalls.push(`${r.status()} ${u.split("?")[0]}`);
      if (r.status() >= 400 && !u.startsWith("/api/")) failedRequests.push(`${r.status()} ${u}`);
    });

    // Sign in through the PWA's own form.
    await page.goto(`${APP}/login`, { waitUntil: "networkidle", timeout: 60000 });
    await page.screenshot({ path: path.join(OUT, `login-${vp.name}.png`) });

    // Does anything cover the Sign in button at this width? The iOS install
    // hint is `fixed … bottom-0`, and on a short viewport it can sit over the
    // control it is asking the visitor to reach. Recorded rather than worked
    // around, because a person meets whatever this reports.
    const submitObstruction = await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      if (!btn) return "no submit button";
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || btn.contains(top) || top === btn) return null;
      const owner = top.closest("[role=status], [class*=fixed]") ?? top;
      return (owner.getAttribute("role") ?? owner.tagName.toLowerCase()) + ": " + (owner.textContent ?? "").replace(/\s+/g, " ").slice(0, 80);
    });

    await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
    await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
    // Submitted from the keyboard rather than by clicking: the install hint can
    // intercept a tap on the button (see `submitObstruction`), and pressing
    // Enter in the password field is what a person does anyway.
    await page.press('input[name="password"]', "Enter");
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const afterLogin = page.url().replace(APP, "");
    await page.screenshot({ path: path.join(OUT, `cockpit-${vp.name}.png`) });

    // Open the embedded FabOrchestrator chat.
    const t0 = Date.now();
    await page.goto(`${APP}/chat`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    const settledMs = Date.now() - t0;
    await page.waitForTimeout(3000);

    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const ta = document.querySelector("textarea");
      const r = ta ? ta.getBoundingClientRect() : null;
      const text = document.body.innerText.replace(/\s+/g, " ");
      return {
        finalPath: location.pathname,
        title: document.title,
        overflowX: doc.scrollWidth - window.innerWidth,
        innerHeight: window.innerHeight,
        composerBottom: r ? Math.round(r.bottom) : null,
        hasComposer: !!ta,
        sidebarTrigger: !!document.querySelector('[data-sidebar="trigger"]'),
        // Did FabOrchestrator's own session handling take over?
        expiredModal: /session (has )?expired|log in again|sign in again/i.test(text),
        textStart: text.slice(0, 200),
        tokenKeyPresent: !!localStorage.getItem("llmatscale_auth_token"),
      };
    });

    await page.screenshot({ path: path.join(OUT, `chat-${vp.name}.png`), fullPage: false });

    results.push({
      viewport: vp.name,
      afterLogin,
      submitObstruction,
      settledMs,
      ...m,
      apiCalls: [...new Set(apiCalls)],
      consoleErrors: [...new Set(consoleErrors)].slice(0, 6),
      failedRequests: [...new Set(failedRequests)].slice(0, 6),
    });

    await page.close();
    await ctx.close();
  }
} finally {
  await browser.close();
}

const L = [];
L.push(`# WP1 — embedded FabOrchestrator chat at phone width — ${new Date().toISOString()}`);
L.push(`Target: \`${APP}\` · headless Chromium, iPhone 13 descriptor, touch · screenshots in \`${path.relative(ROOT, OUT)}/\``);
L.push("");
for (const r of results) {
  L.push(`## ${r.viewport}`);
  L.push(`- after sign-in: \`${r.afterLogin}\``);
  L.push(`- anything covering the Sign in button: ${r.submitObstruction ?? "nothing"}`);
  L.push(`- /chat settled in ${r.settledMs} ms, landed on \`${r.finalPath}\`, title \`${r.title}\``);
  L.push(`- sideways overflow: ${r.overflowX}px · composer present: ${r.hasComposer}${r.composerBottom ? ` (bottom ${r.composerBottom} of ${r.innerHeight})` : ""} · sidebar trigger: ${r.sidebarTrigger}`);
  L.push(`- FabOrchestrator session-expired state on screen: **${r.expiredModal}**`);
  L.push(`- token key in localStorage: ${r.tokenKeyPresent}`);
  L.push(`- API calls: ${r.apiCalls.join("; ") || "none"}`);
  L.push(`- console errors: ${r.consoleErrors.join(" | ") || "none"}`);
  L.push(`- failed non-API requests: ${r.failedRequests.join(" | ") || "none"}`);
  L.push(`- first text on screen: ${r.textStart}`);
  L.push("");
}
console.log(L.join("\n"));
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
