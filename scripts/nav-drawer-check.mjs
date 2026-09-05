/**
 * The agent drawer, driven on a phone.
 *
 * The unit suite guards the architecture — one nav list, no invented history,
 * the thread key held above the shell. This drives a browser, because what was
 * asked for is an interaction: tap the menu, watch it slide, navigate, come
 * back, and find the answer still on screen.
 *
 * The conversation checks matter most. "Opening the drawer must not reset the
 * conversation" is a claim about React state that no amount of reading proves;
 * it needs a real answer on a real screen, the drawer opened and closed over
 * the top of it, and the same text still there afterwards.
 *
 *   node scripts/nav-drawer-check.mjs
 *   APP_URL=https://faborch-demo.fly.dev node scripts/nav-drawer-check.mjs
 */
import fs from "node:fs";

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const ROOT = "C:/Users/ATUL ANAND/OneDrive/Documentos/Desktop/AthenaTech/faborchestrator-pwa";
const env = Object.fromEntries(
  fs
    .readFileSync(`${ROOT}/.env`, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const APP = (process.env.APP_URL ?? "http://localhost:3002").replace(/\/$/, "");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch();

/** A signed-in phone, at one of the two viewports the mobile audit uses. */
async function signedInPage(width = 390, height = 844) {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    viewport: { width, height },
  });
  // The install hint never renders in an installed app, and at phone width it
  // sits over the controls this check taps.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("faborch_install_hint_dismissed", "1");
    } catch {
      /* private mode */
    }
  });
  const page = await context.newPage();

  await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', env.FABORCH_PROBE_EMAIL);
  await page.fill('input[name="password"]', env.FABORCH_PROBE_PASSWORD);
  // Disabled until hydration, on purpose — see login-page.tsx.
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 60_000 });
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === "/", null, { timeout: 60_000 });
  return { context, page };
}

const drawer = (page) => page.locator('[role="dialog"][aria-label="Navigation"]');
const trigger = (page) => page.locator('button[aria-label="Open navigation"]');

/** Tap the backdrop where the panel does not cover it. */
async function tapOutside(page) {
  const at = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Navigation"]');
    const right = el ? el.getBoundingClientRect().right : 0;
    return { x: Math.round((right + window.innerWidth) / 2), y: Math.round(window.innerHeight / 2) };
  });
  await page.mouse.click(at.x, at.y);
}

/** Visible in the CSS sense AND actually slid in — a panel at `-translate-x-full`
 *  is still "visible" to a naive check while sitting entirely off-screen. */
const isOpen = async (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Navigation"]');
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return getComputedStyle(el).visibility === "visible" && box.right > 8;
  });

console.log(`\nagent drawer · ${APP}\n`);

/* ── 1. it opens and closes, three ways ─────────────────────────────────── */
console.log("── 1. open, then close by backdrop, Escape and the button ─────────");

{
  const { context, page } = await signedInPage();
  await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });

  await trigger(page).waitFor({ timeout: 30_000 });
  ok("the agent screen offers a menu button", await trigger(page).isVisible());
  ok("…and it starts closed", (await isOpen(page)) === false);

  await trigger(page).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Navigation"]');
    return el && el.getBoundingClientRect().right > 8;
  }, null, { timeout: 10_000 });
  ok("tapping it opens the drawer", await isOpen(page));

  // Close by tapping outside.
  //
  // Tapped by coordinate, to the RIGHT of the panel. The backdrop element
  // spans the whole viewport, so an offset click near its left edge lands
  // underneath the drawer — which is correct behaviour, and cost this check an
  // hour of "the backdrop does not close it" that was never true. "Outside" is
  // the strip the panel does not cover.
  await tapOutside(page);
  await page.waitForTimeout(400);
  ok("tapping outside closes it", (await isOpen(page)) === false);

  // Close by Escape.
  await trigger(page).click();
  await page.waitForTimeout(350);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  ok("Escape closes it", (await isOpen(page)) === false);

  // Close by the button.
  await trigger(page).click();
  await page.waitForTimeout(350);
  await drawer(page).locator('button[aria-label="Close"]').click();
  await page.waitForTimeout(400);
  ok("the close button closes it", (await isOpen(page)) === false);

  /* ── 2. what it contains, and what it must not ────────────────────────── */
  console.log("\n── 2. the contents are honest ─────────────────────────────────────");

  await trigger(page).click();
  await page.waitForTimeout(350);
  const text = await drawer(page).innerText();

  for (const label of ["New chat", "Cockpit", "Agents", "Workflows", "Sites", "Reports"]) {
    ok(`it offers ${label}`, text.includes(label));
  }
  for (const forbidden of ["Recents", "Pinned"]) {
    ok(`it shows no ${forbidden}`, !text.includes(forbidden), forbidden);
  }
  ok("it states that conversations are not saved", /not saved/i.test(text));
  ok("Master Data Load is not in it", !/master data/i.test(text));

  // The two placeholders must not be links — the "dead control" rule.
  const deadLinks = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Navigation"]');
    return [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  });
  ok(
    "Workflows and Sites are not links",
    !deadLinks.includes("/workflows") && !deadLinks.includes("/sites"),
    deadLinks.join(" "),
  );

  // Touch targets.
  const small = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Navigation"]');
    return [...el.querySelectorAll("a,button")]
      .map((n) => ({ t: (n.innerText || n.getAttribute("aria-label") || "?").slice(0, 20), h: Math.round(n.getBoundingClientRect().height) }))
      .filter((n) => n.h > 0 && n.h < 44);
  });
  ok("every control clears 44px", small.length === 0, small.map((s) => `${s.t}:${s.h}px`).join(" "));

  await context.close();
}

/* ── 3. the conversation survives the drawer ────────────────────────────── */
console.log("\n── 3. opening and closing it does not reset the conversation ──────");

{
  const { context, page } = await signedInPage();
  await page.goto(`${APP}/fabinsight?q=${encodeURIComponent("Give me the yield by product.")}`, {
    waitUntil: "domcontentloaded",
  });

  // Wait for a real answer, then for the turn to finish — the composer shows
  // Stop while streaming, and Send only once it is done.
  await page.waitForFunction(
    () => (document.querySelector(".fab-md")?.textContent ?? "").length > 40,
    null,
    { timeout: 240_000 },
  );
  await page.waitForSelector('button[aria-label="Send"]', { timeout: 240_000 });
  const before = await page.locator(".fab-md").first().innerText();
  ok("an answer arrives", before.length > 40, `${before.length} chars`);

  await trigger(page).click();
  await page.waitForTimeout(350);
  ok("the drawer opens over it", await isOpen(page));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const after = await page.locator(".fab-md").first().innerText();
  ok("the answer is untouched afterwards", after === before, `${after.length} chars`);
  ok("the question is still in the transcript",
    (await page.evaluate(() => document.body.innerText)).includes("Give me the yield by product."));

  /* ── 4. New chat clears it, and only it ───────────────────────────────── */
  console.log("\n── 4. New chat starts an empty thread ─────────────────────────────");

  await trigger(page).click();
  await page.waitForTimeout(350);
  await drawer(page).getByText("New chat", { exact: true }).click();
  await page.waitForTimeout(600);

  ok("the drawer closed itself", (await isOpen(page)) === false);
  ok("the transcript is empty", (await page.locator(".fab-md").count()) === 0);
  const cleared = await page.evaluate(() => document.body.innerText);
  ok("the old question is gone", !cleared.includes("Give me the yield by product."));
  ok("…and it did not re-ask the ?q= question",
    (await page.locator('button[aria-label="Stop"]').count()) === 0);
  ok("the composer is ready for a new one", await page.locator("textarea").isVisible());
  ok("…still on /fabinsight", new URL(page.url()).pathname === "/fabinsight", page.url());

  await context.close();
}

/* ── 5. navigation, and the drawer on the second agent ──────────────────── */
console.log("\n── 5. the destinations work, and close it behind them ─────────────");

{
  const { context, page } = await signedInPage();
  await page.goto(`${APP}/backend-agent`, { waitUntil: "domcontentloaded" });
  await trigger(page).waitFor({ timeout: 30_000 });
  ok("the Back-end Agent screen has one too", await trigger(page).isVisible());

  await trigger(page).click();
  await page.waitForTimeout(350);
  await drawer(page).getByText("Reports", { exact: true }).click();
  await page.waitForFunction(() => location.pathname === "/reports", null, { timeout: 30_000 });
  ok("Reports opens", new URL(page.url()).pathname === "/reports", page.url());
  await page.waitForTimeout(400);
  ok("…and the drawer closed behind it", (await isOpen(page)) === false);
  ok("…and /reports offers no drawer of its own",
    (await trigger(page).count()) === 0);

  await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });
  await trigger(page).click();
  await page.waitForTimeout(350);
  await drawer(page).getByText("Cockpit", { exact: true }).click();
  await page.waitForFunction(() => location.pathname === "/", null, { timeout: 30_000 });
  ok("Cockpit opens", new URL(page.url()).pathname === "/", page.url());

  await context.close();
}

/* ── 6. both phone widths ───────────────────────────────────────────────── */
console.log("\n── 6. 360×640 and 390×844, open and closed ────────────────────────");

for (const [w, h] of [
  [360, 640],
  [390, 844],
]) {
  const { context, page } = await signedInPage(w, h);
  await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });
  await trigger(page).waitFor({ timeout: 30_000 });

  const closed = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  ok(`${w}×${h}: no sideways scroll with it closed`, closed.doc <= closed.win, `${closed.doc} ≤ ${closed.win}`);

  await trigger(page).click();
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Navigation"]');
    const box = el.getBoundingClientRect();
    return {
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
      width: Math.round(box.width),
      backdrop: Math.round(window.innerWidth - box.right),
    };
  });
  ok(`${w}×${h}: no sideways scroll with it open`, open.doc <= open.win, `${open.doc} ≤ ${open.win}`);
  ok(`${w}×${h}: the panel fits`, open.width <= w, `${open.width}px panel`);
  ok(`${w}×${h}: there is backdrop left to tap`, open.backdrop >= 40, `${open.backdrop}px`);

  // The pill strip must not also be showing — that was the duplicate row.
  const pills = await page.evaluate(() => {
    const nav = document.querySelector('header nav[aria-label="Sections"]');
    return nav ? nav.getBoundingClientRect().height : 0;
  });
  ok(`${w}×${h}: the duplicate nav row is gone`, pills === 0, `${pills}px`);

  await context.close();
}

await browser.close();

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}
