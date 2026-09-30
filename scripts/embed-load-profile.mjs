/**
 * WP8 — what a phone actually downloads, the first time and the second.
 *
 * `embed-latency-check.mjs` times single requests. This times a *visit*: a real
 * browser at phone size, loading the embedded FabOrchestrator chat with an
 * empty cache, and then loading it again with the cache it just filled. The two
 * numbers answer different questions and only the second one describes the
 * operator who uses this every day.
 *
 * What it records for each load:
 *   · how long until the page is interactive, and until it stops loading
 *   · every request the page made, split into FabOrchestrator's and this app's
 *   · how many were served from the browser's own cache rather than the network
 *   · the bytes that crossed the wire, which is what a phone on mobile data pays
 *
 * It also records **which requests FabOrchestrator's own client makes**, because
 * WP8's cache-warming rests on a claim about one of them — that FO's sidebar
 * reads `/api/conversations` before anybody can pick a thread to type into. A
 * claim like that should be observed, not assumed.
 *
 * Costs nothing: no model turns, no writes, read-only navigation.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/embed-load-profile.mjs
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
if (!env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}

const out = [];
function say(line = "") {
  console.log(line);
  out.push(line);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();

/** Watch one navigation: what was asked for, what came back, and from where. */
function watch() {
  const rows = [];
  const onResponse = async (res) => {
    const req = res.request();
    let bytes = 0;
    try {
      const sizes = await req.sizes();
      bytes = sizes.responseBodySize + sizes.responseHeadersSize;
    } catch {
      /* a request still in flight when the page moved on */
    }
    rows.push({
      url: new URL(res.url()).pathname,
      status: res.status(),
      fromCache: bytes === 0 && res.status() === 200,
      bytes,
    });
  };
  page.on("response", onResponse);
  return {
    stop() {
      page.off("response", onResponse);
      return rows;
    },
  };
}

function summarise(rows) {
  const fo = rows.filter((r) => r.url.startsWith("/_next/") || r.url.startsWith("/api/"));
  const cached = rows.filter((r) => r.fromCache);
  return {
    n: rows.length,
    fo: fo.length,
    cached: cached.length,
    kb: Math.round(rows.reduce((a, r) => a + r.bytes, 0) / 1024),
  };
}

async function timings() {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return {
      ttfb: Math.round(nav?.responseStart ?? 0),
      dcl: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      load: Math.round(nav?.loadEventEnd || nav?.domComplete || 0),
    };
  });
}

say(`# WP8 — one visit to the embedded chat, cold then warm — ${new Date().toISOString()}`);
say(`\`${APP}\` · iPhone 13 emulation · Chromium`);
say();

// ── Sign in first, so the cold load below is the chat page and not the gate ──
await page.goto(`${APP}/login`, { waitUntil: "networkidle", timeout: 60000 });
await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
await page.press('input[name="password"]', "Enter");
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);

// An empty cache, so "first load" means what it says. The session survives:
// this clears what the browser stored, not who the operator is.
const client = await ctx.newCDPSession(page);
await client.send("Network.clearBrowserCache");

// ── Cold ────────────────────────────────────────────────────────────────────
const coldWatch = watch();
await page.goto(`${APP}/chat`, { waitUntil: "load", timeout: 90000 });
await page.waitForTimeout(6000);
const coldRows = coldWatch.stop();
const coldTiming = await timings();

// ── Warm — the same page again, with the cache it just filled ───────────────
const warmWatch = watch();
await page.goto(`${APP}/chat`, { waitUntil: "load", timeout: 90000 });
await page.waitForTimeout(6000);
const warmRows = warmWatch.stop();
const warmTiming = await timings();

const cold = summarise(coldRows);
const warm = summarise(warmRows);

say("## The visit");
say("| | First load (empty cache) | Second load (warm cache) |");
say("|---|---|---|");
say(`| time to first byte | ${coldTiming.ttfb} ms | ${warmTiming.ttfb} ms |`);
say(`| interactive (DOMContentLoaded) | ${coldTiming.dcl} ms | ${warmTiming.dcl} ms |`);
say(`| finished loading | ${coldTiming.load} ms | ${warmTiming.load} ms |`);
say(`| requests | ${cold.n} | ${warm.n} |`);
say(`| …served from the browser's own cache | ${cold.cached} | ${warm.cached} |`);
say(`| bytes over the wire | ${cold.kb} KB | ${warm.kb} KB |`);
say();
say("FabOrchestrator serves its chunks `immutable` and the gateway forwards that header");
say("untouched, so the second visit is the one an operator actually lives with. The first");
say("is paid once per deploy.");
say();

// ── What FabOrchestrator's own client asks for ──────────────────────────────
say("## What FabOrchestrator's client requested, in order");
const apiCalls = coldRows.filter((r) => r.url.startsWith("/api/"));
say("| Path | Status |");
say("|---|---|");
for (const r of apiCalls.slice(0, 15)) say(`| \`${r.url}\` | ${r.status} |`);
say();
const listCall = apiCalls.find((r) => r.url === "/api/conversations");
say(
  listCall
    ? `\`GET /api/conversations\` **was** requested (HTTP ${listCall.status}) on the way in — which is`
    : "⚠ `GET /api/conversations` was **not** requested on this load — which means",
);
say(
  listCall
    ? "what WP8's cache warming depends on: the list that proves conversation ownership has"
    : "WP8's cache warming would not fire here, and the ownership check pays for its own read.",
);
if (listCall) say("already crossed the gateway before the operator can type a word into a thread.");
say();

await ctx.close();
await browser.close();

const dir = path.join(ROOT, "docs", "probes");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-wp8-load-profile.md`);
fs.writeFileSync(file, out.join("\n") + "\n");
console.log(`\nwritten to ${path.relative(ROOT, file)}`);
