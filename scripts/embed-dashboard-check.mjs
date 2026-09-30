/**
 * WP7 — the FabOrchestrator Dashboard, through the same gateway.
 *
 * The package's claim is not "a dashboard renders" but something stronger:
 * **a second FabOrchestrator capability reached the phone by configuration
 * alone.** So these checks prove the page is FabOrchestrator's own, that its
 * data path works with the WP2 token bridge, and — the part that matters for
 * the rollback — that removing `/reports` from `FO_EMBED_SURFACES` hands the
 * URL straight back to this app's own screen, unchanged.
 *
 * The two flag states cannot be exercised in one run against one deployment,
 * so the embedded half runs here and the fallback half is asserted by the unit
 * tests plus a local run with the flag unset (see `docs/STATUS.md`).
 *
 * ⚠ **`refresh` is never called.** `POST /api/fabinsight/pinned/{id}/refresh`
 * re-queries the MES and overwrites the shared snapshot every other reader
 * sees, and it is not admin-gated. Reading is safe; refreshing is somebody
 * else's data. That control is an open product decision, recorded in STATUS.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/embed-dashboard-check.mjs
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
const OUT = path.join(ROOT, "docs", "probes", "wp7-shots");
if (!env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function record(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(t) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
}

// ── 1. The document is FabOrchestrator's, not this app's ────────────────────
section("1. /reports is FabOrchestrator's own page");
const login = await fetch(`${APP}/api/pwa/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: env.FABORCH_PROBE_EMAIL, password: env.FABORCH_PROBE_PASSWORD }),
});
if (!login.ok) {
  console.error(`sign-in failed: ${login.status}`);
  process.exit(1);
}
const { token } = await login.json();
const cookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("faborch_token="))?.split(";")[0] ?? "";
const auth = { authorization: `Bearer ${token}`, cookie };

{
  const res = await fetch(`${APP}/reports`, { headers: { cookie }, redirect: "manual" });
  const html = await res.text();
  record("GET /reports answers 200 HTML", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html"), `HTTP ${res.status}`);
  // This app's own screen titles itself "Reports — FabOrchestrator"; FO's page
  // carries FabOrchestrator's own document title. That is the tell.
  const title = (html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? "";
  record("…and it is FabOrchestrator's document, not this app's screen", /LLMatscale/i.test(title), `title: ${title}`);
  record("…referencing FabOrchestrator's own chunks under bare /_next", /(?:src|href)="\/_next\/static\//.test(html), `${(html.match(/\/_next\/static\//g) ?? []).length} refs`);
  record("…with no chunk of this app's build in it", !html.includes("/pwa-assets/_next/"), "0 pwa-assets refs");
  record("…re-served no-cache, so a phone cannot hold a stale document", res.headers.get("cache-control") === "no-cache, must-revalidate", res.headers.get("cache-control") ?? "—");
  record("…and it carries the mobile shell (WP6)", html.includes('src="/fo-shell.js"'), "");
}

// ── 2. The data path, with the WP2 bridge ──────────────────────────────────
section("2. the pinned dashboards load for the signed-in account");
let firstDashboard = null;
{
  const res = await fetch(`${APP}/api/fabinsight/pinned`, { headers: auth });
  const body = await res.json().catch(() => null);
  const rows = body?.dashboards ?? (Array.isArray(body) ? body : []);
  firstDashboard = rows[0] ?? null;
  record("GET /api/fabinsight/pinned answers with this account's dashboards", res.status === 200 && rows.length > 0, `HTTP ${res.status}, ${rows.length} pinned`);
  record("…and FabOrchestrator reports the caller's own permission", body && "canManage" in body, `canManage: ${body?.canManage}`);
}
if (firstDashboard) {
  const res = await fetch(`${APP}/api/fabinsight/pinned/${firstDashboard.id}`, { headers: auth });
  const body = await res.json().catch(() => null);
  const hasSnapshot = typeof body?.html === "string" && body.html.length > 0;
  record("opening one returns its stored snapshot", res.status === 200, `HTTP ${res.status}, "${(firstDashboard.title ?? "").slice(0, 40)}"`);
  record("…which is rendered HTML FabOrchestrator produced", hasSnapshot || body?.html === null, hasSnapshot ? `${body.html.length} bytes of HTML` : "no snapshot taken yet (FabOrchestrator's own state)");
  record("…stamped with when it was last refreshed", "refreshedAt" in (body ?? {}), `refreshedAt: ${body?.refreshedAt ?? "never"}`);
}

// ── 3. On a phone, from the cockpit ────────────────────────────────────────
section("3. reachable from the cockpit at phone width");
const browser = await chromium.launch();
for (const vp of [
  // Landscape on the same handset — 844px — which is where FabOrchestrator
  // renders the cockpit nav its Reports entry lives in. See OPEN_ISSUES 0c.
  { name: "844x390", width: 844, height: 390, nav: true },
  { name: "390x844", width: 390, height: 844, nav: false },
]) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: vp.width, height: vp.height }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // ⚠ **Expected, and not a defect.** Tapping this app's own `<Link>` to
    // `/reports` makes Next's router ask for an RSC payload for a route it
    // believes it owns. FabOrchestrator's build answers with something this
    // build cannot read, so the router logs this and **falls back to a full
    // browser navigation** — which is precisely the cross-build mechanism WP3
    // verified, and the reason the page loads correctly a moment later. An
    // earlier version of this check counted it as a failure; the fix is to
    // recognise it, not to silence every console error.
    if (/failed to fetch rsc payload/i.test(text) && /falling back to browser navigation/i.test(text)) return;
    consoleErrors.push(text.slice(0, 120));
  });

  await page.goto(`${APP}/login`, { waitUntil: "networkidle", timeout: 60000 });
  await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
  await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
  await page.press('input[name="password"]', "Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // ── The cockpit's Reports entry, whosever cockpit it is ──────────────────
  //
  // This used to look for `a[href="/reports"]` — an anchor in **this app's**
  // hand-built cockpit. Since the audit the landing page is FabOrchestrator's
  // own `/home`, whose nav is script-driven rather than a set of anchors, so
  // the control is found by what it says instead of by what it links to. That
  // is the more honest selector anyway: it is the thing an operator taps.
  await page.waitForTimeout(2500);

  if (!vp.nav) {
    // ── What a portrait phone actually gets (OPEN_ISSUES 0c) ───────────────
    // FabOrchestrator hides its cockpit nav below 768px, so Reports has no
    // entry point here. That is FabOrchestrator's own breakpoint and this app
    // does not paper over it — reproducing its nav would be rebuilding one of
    // its screens. What must still be true is that the cockpit itself works.
    const phone = await page.evaluate(() => ({
      composer: [...document.querySelectorAll("input,textarea")]
        .some((f) => /ask anything|orchestrate/i.test(f.getAttribute("placeholder") ?? "")),
      cards: (document.body.innerText.match(/AGENT · 0/g) ?? []).length,
      navWidth: Math.max(0, ...[...document.querySelectorAll("a,button")]
        .filter((e) => /^\s*Reports\s*$/i.test(e.innerText))
        .map((e) => e.getBoundingClientRect().width)),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }));
    record(`${vp.name}: FabOrchestrator's composer works on a phone`, phone.composer, "");
    record(`${vp.name}: …and all four agent cards render`, phone.cards >= 4, `${phone.cards} cards`);
    record(`${vp.name}: Reports has no entry point — OPEN_ISSUES 0c, expected`, phone.navWidth === 0, `nav entry ${phone.navWidth}px wide`);
    record(`${vp.name}: no sideways scrolling`, phone.overflowX <= 0, `${phone.overflowX}px`);
    await page.screenshot({ path: path.join(OUT, `cockpit-${vp.name}.png`) });
    await ctx.close();
    continue;
  }

  // ── The product's real route to Reports ─────────────────────────────────
  //
  // **Not the cockpit nav.** Every item in FabOrchestrator's cockpit nav —
  // Reports included — is `router.push("/home")`; all five are decorative, on
  // its own site as much as here, and clicking Reports there leaves you on the
  // cockpit. An earlier version of this check tapped it and called the result a
  // defect, which was reading this app's old cockpit into FabOrchestrator's.
  //
  // The real entry point is the chat sidebar's Dashboard item
  // (`full-chat-app.tsx:514`), which is the path a desktop operator takes. So
  // that is the path exercised here: cockpit → chat → Dashboard.
  await page.goto(`${APP}/chat`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(6000);
  const dash = page.getByRole("button", { name: /^\s*Dashboard\s*$/i }).first();
  const found = (await dash.count()) > 0;
  record(`${vp.name}: FabOrchestrator's sidebar offers Dashboard`, found, found ? "" : "not rendered at this width");
  if (found) {
    await dash.click({ timeout: 20000 }).catch((e) => record(`${vp.name}: tapping it`, false, String(e).slice(0, 80)));
  }
  await page.waitForTimeout(6000);

  const state = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, " ");
    return {
      path: location.pathname,
      title: document.title,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      // FabOrchestrator's own Reports page words, which this app's screen does
      // not use.
      looksLikeFo: /recent reports/i.test(t) || /back to chat/i.test(t),
      cards: (t.match(/live report/gi) ?? []).length,
      // FabOrchestrator's "Open" is a plain div with no button or anchor
      // ancestor, so a role selector reports zero on a page that visibly has
      // fourteen. Count the text, not the role.
      openControls: [...document.querySelectorAll("div, span, button, a")].filter((e) => {
        const own = [...e.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => (n.textContent ?? "").trim())
          .join("");
        return /^open$/i.test(own);
      }).length,
      excerpt: t.slice(0, 110),
    };
  });
  record(`${vp.name}: it lands on /reports`, state.path === "/reports", `${state.path} · ${state.title}`);
  record(`${vp.name}: FabOrchestrator's own Reports page rendered`, state.looksLikeFo, state.excerpt);
  record(`${vp.name}: the pinned dashboards are listed`, state.cards > 0 || state.openControls > 0, `${state.cards} report cards, ${state.openControls} open controls`);
  record(`${vp.name}: no sideways scrolling`, state.overflowX <= 0, `${state.overflowX}px`);
  await page.screenshot({ path: path.join(OUT, `reports-${vp.name}.png`) });

  // Open one, and confirm its snapshot renders rather than an error.
  if (state.openControls > 0) {
    await page.getByText("Open", { exact: true }).first().click({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const opened = await page.evaluate(() => {
      const t = document.body.innerText.replace(/\s+/g, " ");
      return {
        hasFrame: !!document.querySelector("iframe"),
        failed: /could not|failed|error loading/i.test(t),
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    record(`${vp.name}: opening a dashboard renders its snapshot`, opened.hasFrame && !opened.failed, `iframe: ${opened.hasFrame}, error text: ${opened.failed}`);
    record(`${vp.name}: …still no sideways scrolling`, opened.overflowX <= 0, `${opened.overflowX}px`);
    await page.screenshot({ path: path.join(OUT, `dashboard-open-${vp.name}.png`) });
  }
  record(`${vp.name}: no console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "none");
  await ctx.close();
}
await browser.close();

// ── 4. This app's own chat screen is untouched ──────────────────────────────
section("4. nothing else moved");
// `/fabinsight` was here until WP9 cut it over: it is this app's own copy of
// FabOrchestrator's chat, and while the gateway serves the real one it
// redirects there. `/diagnostics` takes its place as a screen that is this
// app's and stays this app's.
for (const own of ["/login", "/diagnostics"]) {
  const res = await fetch(`${APP}${own}`, { headers: { cookie }, redirect: "manual" });
  const html = await res.text();
  record(`${own} is still this app's own screen`, res.status === 200 && html.includes("/pwa-assets/_next/"), `HTTP ${res.status}`);
}
await fetch(`${APP}/api/pwa/auth/logout`, { method: "POST", headers: auth }).catch(() => {});

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
