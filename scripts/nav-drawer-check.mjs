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
import { fileURLToPath } from "node:url";

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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

const drawer = (page) => page.locator('[role="dialog"][aria-label="Conversations"]');
const trigger = (page) => page.locator('button[aria-label="Open navigation"]');

/** Tap the backdrop where the panel does not cover it. */
async function tapOutside(page) {
  const at = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Conversations"]');
    const right = el ? el.getBoundingClientRect().right : 0;
    return { x: Math.round((right + window.innerWidth) / 2), y: Math.round(window.innerHeight / 2) };
  });
  await page.mouse.click(at.x, at.y);
}

/** Visible in the CSS sense AND actually slid in — a panel at `-translate-x-full`
 *  is still "visible" to a naive check while sitting entirely off-screen. */
const isOpen = async (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Conversations"]');
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
    const el = document.querySelector('[role="dialog"][aria-label="Conversations"]');
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
  // Give the list its round trip to FabOrchestrator.
  await page
    .waitForFunction(() => !/Loading your conversations/.test(document.body.innerText), null, {
      timeout: 30_000,
    })
    .catch(() => {});
  const text = await drawer(page).innerText();

  ok("it offers New chat", text.includes("New chat"));
  ok("it offers one way back", text.includes("Back to Cockpit"));
  // Case-insensitively: the heading is set in CSS `uppercase`, and `innerText`
  // reports what is rendered rather than what is in the source.
  ok("it lists Recents", /recents/i.test(text));

  // The app's own navigation is gone from here — it lives on the cockpit.
  for (const label of ["Agents", "Workflows", "Sites", "Reports"]) {
    ok(`the ${label} nav entry is gone from the drawer`, !text.includes(label), label);
  }
  ok("Master Data Load is not in it", !/master data/i.test(text));

  // Real threads, from FabOrchestrator, not a seeded list.
  const rowCount = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Conversations"]');
    return el.querySelectorAll("ul li").length;
  });
  ok("real conversations are listed", rowCount > 0, `${rowCount} thread(s)`);

  // Touch targets.
  const small = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="Conversations"]');
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
  ok("…and the conversation was dropped from the URL", !page.url().includes("c="), page.url());

  await context.close();
}

/* ── 4b. the thread just asked was written to FabOrchestrator ───────────── */
console.log("\n── 4b. a question asked here is saved in FabOrchestrator ──────────");

{
  const { context, page } = await signedInPage();

  // A question distinctive enough to find again in a list of a hundred.
  const marker = `PWA drawer check ${Date.now()}`;
  await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 30_000 });
  await page.fill("#insight-prompt", `${marker} — how many lots are currently in WIP?`);
  await page.click('button[aria-label="Send"]');

  // The conversation id lands in the URL as soon as FO assigns one.
  await page.waitForFunction(() => location.search.includes("c="), null, { timeout: 60_000 });
  const withId = new URL(page.url()).searchParams.get("c");
  ok("FabOrchestrator assigned a conversation id", !!withId, withId ?? "none");

  await page.waitForSelector('button[aria-label="Send"]', { timeout: 240_000 });

  // Reload: the thread must come back from FO, not from anything local.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (m) => document.body.innerText.includes(m),
    marker,
    { timeout: 60_000 },
  ).catch(() => {});
  const reloaded = await page.evaluate(() => document.body.innerText);
  ok("the thread survives a reload", reloaded.includes(marker));
  ok("…with its answer", (await page.locator(".fab-md").count()) > 0);

  // And it is in the list the drawer reads — the same list the website reads.
  await trigger(page).click();
  await page
    .waitForFunction(() => !/Loading your conversations/.test(document.body.innerText), null, {
      timeout: 30_000,
    })
    .catch(() => {});
  const listed = await drawer(page).innerText();
  ok("…and appears in Recents", listed.includes("PWA drawer check"), marker);

  await context.close();
}

/* ── 4c. opening an existing thread from Recents ────────────────────────── */
console.log("\n── 4c. an existing FabOrchestrator thread opens here ──────────────");

{
  const { context, page } = await signedInPage();
  await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });
  await trigger(page).waitFor({ timeout: 30_000 });
  await trigger(page).click();
  await page
    .waitForFunction(() => !/Loading your conversations/.test(document.body.innerText), null, {
      timeout: 30_000,
    })
    .catch(() => {});

  const first = drawer(page).locator("ul li button").first();
  const title = (await first.innerText()).trim();
  await first.click();
  await page.waitForFunction(() => location.search.includes("c="), null, { timeout: 30_000 });
  ok("picking a conversation opens it", page.url().includes("c="), page.url());
  // The 220ms slide, plus margin. Every other close assertion waits; this one
  // did not, and reported a drawer "still open" that was two frames from gone.
  await page.waitForTimeout(400);
  ok("…and the drawer closed behind it", (await isOpen(page)) === false);
  ok("…without leaving /fabinsight", new URL(page.url()).pathname === "/fabinsight");

  await page
    .waitForFunction(() => document.querySelectorAll(".fab-md").length > 0, null, { timeout: 60_000 })
    .catch(() => {});
  ok("its messages are shown", (await page.locator(".fab-md").count()) > 0, title.slice(0, 40));

  // The stripping is the point: no generated SQL may reach the phone.
  const body = await page.evaluate(() => document.body.innerText);
  ok("no tool output leaked into the transcript", !/SELECT\s+COUNT\(\*\)/i.test(body));

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
  await page.waitForTimeout(400);
  const backendText = await drawer(page).innerText();
  ok("…and says it keeps no history, rather than showing an empty list",
    /does not keep conversation history/i.test(backendText));
  ok("…and offers no Recents heading", !backendText.includes("Recents"));

  await drawer(page).getByText("Back to Cockpit", { exact: true }).click();
  await page.waitForFunction(() => location.pathname === "/", null, { timeout: 30_000 });
  ok("Back to Cockpit opens the cockpit", new URL(page.url()).pathname === "/", page.url());
  await page.waitForTimeout(400);
  ok("…and the drawer closed behind it", (await isOpen(page)) === false);

  /* The reason removing the drawer's nav costs nothing: everything it used to
     offer is one tap further, on the cockpit, at phone width. */
  const reachable = await page.evaluate(() =>
    [...document.querySelectorAll("a[href^='/']")]
      .filter((a) => {
        const b = a.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      })
      .map((a) => a.getAttribute("href")),
  );
  ok("the cockpit reaches Reports on a phone", reachable.includes("/reports"), reachable.join(" "));

  await page.goto(`${APP}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  ok("/reports offers no drawer of its own", (await trigger(page).count()) === 0);

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
    const el = document.querySelector('[role="dialog"][aria-label="Conversations"]');
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

  // The agent screen carries no pill strip at all now — FO's own /chat has
  // none either. `querySelector` rather than a height check: it must not be in
  // the document, not merely collapsed.
  const pills = await page.evaluate(
    () => !!document.querySelector('header nav[aria-label="Sections"]'),
  );
  ok(`${w}×${h}: the agent screen has no pill strip`, pills === false);

  // And the cockpit, which is now where that navigation lives, must show it
  // here without the document scrolling sideways.
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  const cockpit = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Sections"]');
    return {
      present: !!nav,
      reports: !!document.querySelector("a[href='/reports']"),
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    };
  });
  ok(`${w}×${h}: the cockpit shows its navigation`, cockpit.present);
  ok(`${w}×${h}: …including Reports`, cockpit.reports);
  ok(
    `${w}×${h}: …without scrolling the page sideways`,
    cockpit.doc <= cockpit.win,
    `${cockpit.doc} ≤ ${cockpit.win}`,
  );

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
