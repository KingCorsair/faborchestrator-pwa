/**
 * WP0 — FabOrchestrator at phone width. Read-only.
 *
 * Opens the real FabOrchestrator surfaces (`/chat`, `/reports`, `/settings`,
 * `/home`) in a headless phone-sized browser, signed in as the probe account,
 * and records what the embedding work needs to know before it opens them
 * inside the PWA: does the page scroll sideways, is the composer on screen, is
 * there a sidebar trigger and does it open as a sheet, how many tap targets
 * are under 44px, how much JavaScript loads, which API calls the page makes,
 * and how long it takes to settle. One screenshot per surface per viewport.
 *
 * Signs in through FO's own login API and seeds the two localStorage keys
 * FO's pages read, exactly as FO's login page does. Never prints the password
 * or the token. Signs out at the end.
 *
 * This is a headless Chromium with a phone viewport and touch, not an iPhone.
 * It cannot open the iOS keyboard, run in standalone mode, or reproduce
 * Safari. Those remain manual checks (docs/probes/…-wp0-embedding-baseline.md).
 *
 * Run:  node scripts/fo-mobile-probe.mjs                 → docs/probes/wp0-shots/
 *       OUT_DIR=/tmp/shots node scripts/fo-mobile-probe.mjs
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
const BASE = (process.env.FABORCH_BASE_URL ?? env.FABORCH_BASE_URL ?? "").replace(/\/$/, "");
const OUT = process.env.OUT_DIR ?? path.join(ROOT, "docs", "probes", "wp0-shots");
if (!BASE || !env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_BASE_URL, FABORCH_PROBE_EMAIL, FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: env.FABORCH_PROBE_EMAIL, password: env.FABORCH_PROBE_PASSWORD }),
});
if (!login.ok) {
  console.error(`FO login failed: ${login.status}`);
  process.exit(1);
}
const { token, expiresAt } = await login.json();

const viewports = [
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "360x640", viewport: { width: 360, height: 640 } },
];
const pages = ["/chat", "/reports", "/settings", "/home"];
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
    await ctx.addInitScript(
      ({ token, expiresAt }) => {
        if (!localStorage.getItem("llmatscale_auth_token")) {
          localStorage.setItem("llmatscale_auth_token", token);
          localStorage.setItem("llmatscale_auth_session", JSON.stringify({ expiresAt }));
        }
      },
      { token, expiresAt },
    );

    for (const p of pages) {
      const page = await ctx.newPage();
      const transfers = [];
      page.on("response", (r) => {
        const h = r.headers();
        transfers.push({
          url: r.url().replace(BASE, ""),
          status: r.status(),
          type: h["content-type"] ?? "",
          len: Number(h["content-length"] ?? 0),
        });
      });
      const t0 = Date.now();
      let navError = null;
      await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => {
        navError = String(e).split("\n")[0];
      });
      const settledMs = Date.now() - t0;
      await page.waitForTimeout(1500);

      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const ta = document.querySelector("textarea");
        const r = ta ? ta.getBoundingClientRect() : null;
        const small = [...document.querySelectorAll("button, a")].filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && (b.width < 44 || b.height < 44);
        }).length;
        return {
          finalPath: location.pathname,
          title: document.title,
          overflowX: doc.scrollWidth - window.innerWidth,
          composerBottom: r ? Math.round(r.bottom) : null,
          innerHeight: window.innerHeight,
          smallTargets: small,
          sidebarTrigger: !!document.querySelector('[data-sidebar="trigger"]'),
          textStart: document.body.innerText.replace(/\s+/g, " ").slice(0, 120),
        };
      });

      const js = transfers.filter((t) => t.type.includes("javascript"));
      const api = transfers.filter((t) => t.url.startsWith("/api/")).map((t) => `${t.status} ${t.url.split("?")[0]}`);
      const shot = path.join(OUT, `fo${p.replace(/\//g, "_")}-${vp.name}.png`);
      await page.screenshot({ path: shot });

      const row = {
        viewport: vp.name,
        path: p,
        ...m,
        settledMs,
        navError,
        jsFiles: js.length,
        jsBytesDeclared: js.reduce((a, t) => a + t.len, 0),
        apiCalls: [...new Set(api)],
        screenshot: path.relative(ROOT, shot),
      };

      // Sidebar: does the trigger open a sheet at this width?
      if (m.sidebarTrigger) {
        await page.locator('[data-sidebar="trigger"]').first().click().catch(() => {});
        await page.waitForTimeout(700);
        row.sidebarOpens = await page.evaluate(() => ({
          sheet: !!document.querySelector('[data-slot="sheet-content"], [role="dialog"][data-state="open"]'),
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
        }));
        await page.screenshot({ path: path.join(OUT, `fo${p.replace(/\//g, "_")}-sidebar-${vp.name}.png`) });
        await page.keyboard.press("Escape").catch(() => {});
      }

      // Composer focus: does the textarea stay in view once focused?
      if (m.composerBottom != null) {
        await page.locator("textarea").first().click().catch(() => {});
        await page.waitForTimeout(400);
        const b = await page.locator("textarea").first().boundingBox().catch(() => null);
        row.composerAfterFocus = b ? Math.round(b.y + b.height) : null;
      }

      results.push(row);
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
}

// Markdown summary.
const out = [];
out.push(`# FabOrchestrator at phone width — ${new Date().toISOString()}`);
out.push(`Target: \`${BASE}\` · headless Chromium, iPhone 13 descriptor, touch · screenshots in \`${path.relative(ROOT, OUT)}/\``);
out.push("");
out.push("| Viewport | Path | Landed on | Sideways overflow | Composer bottom / height | After focus | Sidebar trigger → sheet | <44px targets | JS files | Settled | API calls |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  out.push(
    `| ${r.viewport} | \`${r.path}\` | \`${r.finalPath}\` | ${r.overflowX}px | ${r.composerBottom ?? "—"} / ${r.innerHeight} | ${r.composerAfterFocus ?? "—"} | ${r.sidebarTrigger ? (r.sidebarOpens?.sheet ? "yes → sheet" : "yes → no sheet found") : "none"} | ${r.smallTargets} | ${r.jsFiles} | ${r.settledMs} ms${r.navError ? ` (${r.navError})` : ""} | ${r.apiCalls.join("; ")} |`,
  );
}
console.log(out.join("\n"));
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
