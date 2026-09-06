/**
 * The cockpit ask bar answering where it is asked.
 *
 * The unit suite guards the architecture — that the landing page reuses the one
 * conversation implementation. This drives a browser, because the thing that
 * was asked for is an interaction: type, stay put, watch it stream, ask again.
 *
 * Two of the checks are served from a canned stream rather than from
 * FabOrchestrator. That is deliberate and it is not a weaker test: the error
 * path and the artifact path are the two that a live run cannot reach on
 * demand, and a check that only passes when FO happens to fail is a check
 * nobody ever sees pass. The canned frames are FO's own wire format, read from
 * `lib/faborch/stream.ts`.
 *
 *   node scripts/landing-ask-check.mjs
 *   APP_URL=https://faborch-demo.fly.dev node scripts/landing-ask-check.mjs
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
const CHAT = "**/api/faborch/*/chat";

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
  // The button is disabled until hydration, on purpose — see login-page.tsx.
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 60_000 });
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === "/", null, { timeout: 60_000 });
  return { context, page };
}

const askOnLanding = async (page, text) => {
  await page.fill("#cockpit-ask", text);
  await page.click('form[action="/fabinsight"] button[type="submit"]');
};

/** Text of the whole cockpit, for "did an answer appear here" questions. */
const bodyText = (page) => page.evaluate(() => document.body.innerText);

console.log(`\nlanding ask · ${APP}\n`);

/* ── 1. the interaction ─────────────────────────────────────────────────── */
console.log("── 1. ask on the cockpit, stay on the cockpit ─────────────────────");

{
  const { context, page } = await signedInPage();

  // Every chat request this page makes, so "sent itself" is a fact rather than
  // an inference from something appearing on screen.
  const sends = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/faborch\/\w+\/chat/.test(r.url())) sends.push(r.url());
  });

  // Waited for as a *request*, not as text on screen.
  //
  // Since 5 September the first question also creates a FabOrchestrator
  // conversation, so there is a round trip between the question appearing in
  // the transcript and the chat request leaving. This step used to wait for the
  // text and then count the sends, and read zero — the question was on screen
  // and its request was still one hop away. What it means to assert is "the
  // question sent itself", so it waits for the send itself.
  const chatSent = page.waitForRequest(
    (r) => r.method() === "POST" && /\/api\/faborch\/\w+\/chat$/.test(r.url()),
    { timeout: 60_000 },
  );
  await askOnLanding(page, "How many lots are currently in WIP?");
  await chatSent;

  // No second press. The question must go on its own.
  await page.waitForFunction(() => document.body.innerText.includes("WIP"), null, {
    timeout: 30_000,
  });
  ok("the question is sent without a second press", sends.length === 1, `${sends.length} request(s)`);
  ok("…to the existing chat proxy", /\/api\/faborch\/insight\/chat$/.test(sends[0] ?? ""), sends[0]);
  ok("the browser stays on the cockpit", new URL(page.url()).pathname === "/", page.url());

  // The answer, streamed, on this page.
  await page.waitForFunction(
    () => /\d/.test(document.body.innerText.split("WIP")[1] ?? ""),
    null,
    { timeout: 120_000 },
  );
  const answered = await bodyText(page);
  ok("the answer appears inline", answered.includes("WIP"), `${answered.length} chars on page`);
  ok(
    "…and the cockpit is still underneath it",
    answered.includes("The Nucleus") && answered.includes("Live ops"),
  );
  ok("…still on /", new URL(page.url()).pathname === "/");

  /* ── 2. the follow-up ─────────────────────────────────────────────────── */
  console.log("\n── 2. the follow-up stays in the same conversation ────────────────");

  // The inline composer, not the ask bar — the ask bar is gone by now.
  //
  // Waiting for Send to exist is waiting for the turn to finish: the composer
  // shows Stop for as long as it is streaming, and there is no Send to press.
  // Typing into a half-finished turn is what failed the journey check twice,
  // and it is the one thing to get right when demonstrating this by hand.
  await page.waitForSelector('button[aria-label="Send"]', { timeout: 180_000 });
  await page.fill("#insight-prompt", "Which equipment is running right now?");
  await page.click('button[aria-label="Send"]');

  await page.waitForFunction(
    () => document.body.innerText.includes("Which equipment is running right now?"),
    null,
    { timeout: 30_000 },
  );
  ok("the follow-up is asked in place", sends.length === 2, `${sends.length} request(s)`);
  ok("…still on /", new URL(page.url()).pathname === "/", page.url());

  const both = await bodyText(page);
  ok(
    "…and the first question is still in the transcript",
    both.includes("How many lots are currently in WIP?"),
  );

  /* ── 3. mobile ────────────────────────────────────────────────────────── */
  console.log("\n── 3. no horizontal overflow with a conversation open ─────────────");

  for (const [w, h] of [
    [360, 640],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    }));
    ok(`${w}×${h}: the page does not scroll sideways`, overflow.doc <= overflow.win, `${overflow.doc} ≤ ${overflow.win}`);
  }

  await context.close();
}

/* ── 4. errors and artifacts, from a canned stream ──────────────────────── */
console.log("\n── 4. failures and artifacts still render inline ──────────────────");

{
  const { context, page } = await signedInPage();
  await page.route(CHAT, (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ code: "faborch_unavailable", error: "FabOrchestrator is unavailable." }),
    }),
  );

  await askOnLanding(page, "anything at all");
  await page.waitForFunction(
    () => /unavailable/i.test(document.body.innerText),
    null,
    { timeout: 30_000 },
  );
  const errored = await bodyText(page);
  ok("a failure is shown inline", /unavailable/i.test(errored));
  ok("…on the cockpit, not on another page", new URL(page.url()).pathname === "/", page.url());
  ok("…with the cockpit still intact", errored.includes("The Nucleus"));
  await context.close();
}

{
  const { context, page } = await signedInPage();

  // FO's own wire format — `text-delta` frames terminated by `[DONE]`, carrying
  // an artifact tag whose regex is kept byte-identical in lib/faborch/artifacts.ts.
  const frames = [
    { type: "text-delta", delta: "Here is the dashboard you asked for.\n\n" },
    {
      type: "text-delta",
      delta:
        '<antArtifact identifier="wip-board" type="text/html" title="WIP by area">' +
        "<h1>WIP by area</h1></antArtifact>",
    },
  ];
  const body =
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";

  await page.route(CHAT, (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-FabOrch-Data-Connections": "1" },
      body,
    }),
  );

  await askOnLanding(page, "build me a WIP dashboard");
  await page.waitForFunction(
    () => document.body.innerText.includes("WIP by area"),
    null,
    { timeout: 30_000 },
  );
  const withArtifact = await bodyText(page);
  ok("an artifact renders inline", withArtifact.includes("WIP by area"));
  ok("…and the prose around it survives", withArtifact.includes("Here is the dashboard"));
  ok("…on the cockpit", new URL(page.url()).pathname === "/", page.url());
  await context.close();
}

/* ── 5. the conversation screen is untouched ────────────────────────────── */
console.log("\n── 5. /fabinsight and the agent cards are unchanged ───────────────");

{
  const { context, page } = await signedInPage();

  // The cards, before anything is asked.
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll("h3")].map((h) => h.textContent?.trim()),
  );
  for (const name of ["FabInsight™", "AI Support Engineer", "Master Data Load Agent", "Back-end Agent"]) {
    ok(`the ${name} card is still there`, cards.includes(name));
  }
  const masterDataOpens = await page.evaluate(
    () => !!document.querySelector('a[href="/fabinsight"], a[href="/backend-agent"]')
      && document.body.innerText.includes("In FabOrchestrator. Not part of this app."),
  );
  ok("Master Data Load is still shown and still closed", masterDataOpens);

  // And the separate screen still works on its own, with ?q= as before.
  await page.goto(`${APP}/fabinsight?q=${encodeURIComponent("How many lots are currently in WIP?")}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => /\d/.test(document.body.innerText.split("WIP")[1] ?? ""),
    null,
    { timeout: 120_000 },
  );
  ok("/fabinsight?q= still answers on its own screen", new URL(page.url()).pathname === "/fabinsight", page.url());
  ok("…and it answered", (await bodyText(page)).includes("WIP"));

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
