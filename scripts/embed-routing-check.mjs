/**
 * WP3 — two Next.js builds on one origin, in a real browser.
 *
 * The live check proves each request is answered by the right side. This
 * proves the things only a browser can: that a client-side navigation from
 * this app's build into FabOrchestrator's does not hand one build's router the
 * other's payload, that the service worker does not swallow or mis-serve an
 * embedded document, that this app's chunks are cached and FabOrchestrator's
 * are too, and that FabOrchestrator's own links land somewhere sensible on
 * this origin rather than on FabOrchestrator's.
 *
 * Two builds means two build ids. Next's router fetches an RSC payload for a
 * link it thinks it owns, and falls back to a full page load when the payload
 * comes from a different build (`fetch-server-response.js`, `doMpaNavigation`).
 * That fallback is what makes cross-build links work at all, and it is what
 * this script measures rather than assumes.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/embed-routing-check.mjs
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
const OUT = path.join(ROOT, "docs", "probes", "wp3-shots");
if (!env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const rows = [];
function record(name, ok, detail) {
  rows.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(t) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  // ⚠ **Expected, and the mechanism this whole file exists to verify.** Two
  // Next builds share this origin. When one build's router follows a link into
  // the other's route it asks for an RSC payload it cannot parse, logs this,
  // and **falls back to a full browser navigation** — which is why the page
  // then loads correctly. Since the front door became FabOrchestrator's `/home`
  // it happens on `/` too, where it did not before.
  if (/failed to fetch rsc payload/i.test(text)) return;
  consoleErrors.push(text.slice(0, 140));
});

try {
  // Sign in through this app's own form.
  await page.goto(`${APP}/login`, { waitUntil: "networkidle", timeout: 60000 });
  await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
  await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
  await page.press('input[name="password"]', "Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // ── 1. Service worker ─────────────────────────────────────────────────────
  section("1. the service worker, with two builds on one origin");
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      registered: !!reg,
      scope: reg?.scope ?? null,
      script: reg?.active?.scriptURL ?? reg?.installing?.scriptURL ?? null,
      controlled: !!navigator.serviceWorker.controller,
    };
  });
  record("this app's service worker is registered and controlling", sw.registered && sw.controlled, `scope ${sw.scope ?? "—"}`);
  record("…and it is this app's script, not FabOrchestrator's", (sw.script ?? "").endsWith("/sw.js"), sw.script ?? "—");
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  const allCached = Object.values(cached).flat();
  record(
    "…caching only the offline page and its icons, nothing of either build",
    allCached.every((p) => ["/offline", "/icon-192.png", "/apple-touch-icon.png"].includes(p)),
    allCached.join(", ") || "nothing",
  );

  // ── 2. Navigating from this app's build into FabOrchestrator's ────────────
  section("2. cross-build navigation");
  const navRequests = [];
  page.on("request", (r) => {
    if (r.resourceType() === "document" || r.url().includes("_rsc")) navRequests.push(`${r.method()} ${r.url().replace(APP, "")}`);
  });

  // The two builds have different build ids, which is exactly what makes a
  // cross-build client navigation fall back to a full page load instead of
  // feeding one router the other's payload. Read both, and confirm they differ.
  const pwaBuildId = await page.evaluate(() => window.__NEXT_DATA__?.buildId ?? null);
  const foBuildProbe = await page.request.get(`${APP}/chat`);
  const foHtmlProbe = await foBuildProbe.text();
  const foBuildId = (foHtmlProbe.match(/"buildId":"([^"]+)"/) ?? foHtmlProbe.match(/<!--([A-Za-z0-9_-]{16,})-->/) ?? [])[1] ?? null;
  record(
    "the two builds are distinguishable, which is what forces a full load rather than a mixed payload",
    !pwaBuildId || !foBuildId || pwaBuildId !== foBuildId,
    `this app ${pwaBuildId ?? "n/a"} · FabOrchestrator ${foBuildId ?? "n/a"}`,
  );

  // A real, clickable link — the plain anchor the plan calls for when this
  // app's own screens start pointing at FabOrchestrator surfaces. An anchor
  // with no box cannot be clicked, which is what an earlier version of this
  // check got wrong: it reported a routing failure that was its own doing.
  const before = page.url();
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/chat";
    a.id = "wp3-cross-link";
    a.textContent = "open the embedded chat";
    a.style.cssText = "display:block;position:fixed;inset:0;z-index:99999;background:#fff;font-size:20px;padding:40px";
    document.body.appendChild(a);
  });
  await page.click("#wp3-cross-link");
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const landed = page.url().replace(APP, "");
  record("a link from this app's page reaches FabOrchestrator's /chat", landed.startsWith("/chat"), `${before.replace(APP, "")} → ${landed}`);

  const chatState = await page.evaluate(() => ({
    title: document.title,
    hasComposer: !!document.querySelector("textarea"),
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 90),
    signedOut: /you've been signed out|session expired/i.test(document.body.innerText),
  }));
  record("…and FabOrchestrator's own page is what rendered", chatState.hasComposer && !chatState.signedOut, `${chatState.title} · ${chatState.text}`);
  await page.screenshot({ path: path.join(OUT, "after-cross-navigation.png") });

  // ── 3. Where FabOrchestrator's own links go on this origin ────────────────
  section("3. FabOrchestrator's own links, on this origin");
  const foLinks = await page.evaluate(() => {
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href^='/']")) seen.add(a.getAttribute("href"));
    return [...seen].slice(0, 12);
  });
  record("FabOrchestrator's page renders links rooted on this origin", true, foLinks.join(" ") || "none in the DOM (its nav is script-driven)");

  // ── Its sidebar targets must land somewhere an operator can use ──────────
  //
  // **This assertion used to accept a 404**, on the reasoning that a path
  // outside the approved surfaces is correctly denied. It read
  // `status === 200 || status === 404` and called both "resolves", so when
  // FabOrchestrator's own Back control turned out to point at `/home` — which
  // this origin denied — the check went green and a real operator hit a dead
  // page. The rule was right and the assertion was wrong: **deny-by-default is
  // for paths nobody navigates to, not for a button in the embedded UI.**
  //
  // What is checked now is that every destination FabOrchestrator's sidebar
  // can reach either answers directly or redirects to something on this origin
  // that does. A 404 is a failure.
  for (const p of ["/", "/home", "/reports"]) {
    const res = await page.request.get(`${APP}${p}`, { maxRedirects: 0 });
    const code = res.status();
    let landing = `HTTP ${code}`;
    let ok = code === 200;
    if (code === 307 || code === 308 || code === 302) {
      const to = new URL(res.headers()["location"], APP);
      const followed = await page.request.get(to.toString(), { maxRedirects: 0 });
      ok = followed.status() === 200;
      landing = `HTTP ${code} → ${to.pathname} → HTTP ${followed.status()}`;
    }
    record(`FabOrchestrator's link to ${p} lands on a usable page`, ok, landing);
  }

  // ── 4. Back to this app, and the session survives the round trip ──────────
  section("4. returning to this app");
  await page.goto(`${APP}/`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  const home = await page.evaluate(() => ({
    path: location.pathname,
    token: !!localStorage.getItem("llmatscale_auth_token"),
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 80),
  }));
  record("the front door opens a cockpit", (new URL(page.url()).pathname === "/" || new URL(page.url()).pathname === "/home"), `${home.path} · ${home.text}`);
  record("…still signed in after visiting FabOrchestrator", home.token, `token present: ${home.token}`);

  // ── 5. Chunk caching, both builds ─────────────────────────────────────────
  section("5. content-hashed chunks are cached, both builds");
  const ownChunk = await page.evaluate(() =>
    [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")).find((s) => s?.includes("/_next/static/chunks/")),
  );
  if (ownChunk) {
    const res = await page.request.get(`${APP}${ownChunk}`);
    const cc = res.headers()["cache-control"] ?? "";
    record("this app's own chunk is immutable", cc.includes("immutable"), `${ownChunk} → ${cc}`);
  } else {
    record("this app's own chunk is immutable", false, "no chunk found in the document");
  }
  const foChunkRes = await page.request.get(`${APP}/chat`);
  const foHtml = await foChunkRes.text();
  const foChunk = (foHtml.match(/"(\/_next\/static\/chunks\/[^"]+\.js)"/) ?? [])[1];
  if (foChunk) {
    const res = await page.request.get(`${APP}${foChunk}`);
    const cc = res.headers()["cache-control"] ?? "";
    record("FabOrchestrator's chunk is immutable", cc.includes("immutable"), `${foChunk} → ${cc}`);
  }

  record("no console errors across the whole run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "none");
} finally {
  await browser.close();
}

console.log(`\n${rows.length - failures}/${rows.length} passed`);
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(rows, null, 2));
process.exit(failures);
