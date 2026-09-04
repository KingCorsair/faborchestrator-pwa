/**
 * Phase 5: the journeys, walked end to end on the deployed app.
 *
 * The other checks each prove one mechanism. This proves the paths a person
 * actually takes, in order, in one session — because a set of green mechanisms
 * can still add up to an app nobody can use.
 *
 *   APP_URL=https://faborch-demo.fly.dev node scripts/journeys-check.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const APP = (process.env.APP_URL ?? "https://faborch-demo.fly.dev").replace(/\/$/, "");

const results = [];
const ok = (journey, step, pass, detail = "") => {
  results.push({ journey, step, pass });
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${step}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
});
const page = await context.newPage();

async function signIn() {
  await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', env.FABORCH_PROBE_EMAIL);
  await page.fill('input[type="password"]', env.FABORCH_PROBE_PASSWORD);
  await page.waitForFunction(() => {
    const b = document.querySelector('button[type="submit"]');
    return !!b && !b.disabled;
  }, null, { timeout: 60000 });
  for (let i = 0; i < 3; i += 1) {
    await page.click('button[type="submit"]');
    try {
      await page.waitForFunction(() => !location.pathname.startsWith("/login"), null, { timeout: 25000 });
      return true;
    } catch { /* retry */ }
  }
  return false;
}

/* ── Journey 1: sign in and reach the cockpit ─────────────────────────────── */
console.log("\n  Journey 1 — a supervisor signs in");
ok("1", "sign-in completes", await signIn());
ok("1", "lands on the cockpit", new URL(page.url()).pathname === "/", page.url());
ok("1", "the agents are listed",
  (await page.locator('section[aria-label="The Nucleus"] li').count()) === 4);

/* ── Journey 2: ask a plant question from the front door ──────────────────── */
console.log("\n  Journey 2 — asks a plant question without choosing an agent");
const askBox = page.locator("#cockpit-ask");
await askBox.waitFor({ timeout: 40000 });
await askBox.fill("How many lots are currently in WIP?");
await page.locator('form[action="/fabinsight"] button[type="submit"]').click();
// **The cockpit answers where it is asked, since 5 September.** This step used
// to wait for a navigation to /fabinsight, which is what the ask bar used to do.
// The conversation now opens on the cockpit itself, the way the product's own
// cockpit does — so this waits for the transcript to appear, and asserts that
// the walk never left the front door to get it.
await page.waitForSelector("textarea", { timeout: 40000 });
ok("2", "asking from the cockpit opens a conversation in place",
  new URL(page.url()).pathname === "/", page.url());

await page.waitForFunction(
  () => (document.querySelector(".fab-md")?.textContent ?? "").length > 40,
  null, { timeout: 240000 },
).catch(() => {});
const answer = (await page.locator(".fab-md").first().innerText().catch(() => "")) ?? "";
ok("2", "an answer arrives", answer.length > 40, `${answer.length} chars`);
ok("2", "it carries real figures, not prose alone", /\d{2,}/.test(answer),
  answer.replace(/\s+/g, " ").slice(0, 90));

/* ── Journey 3: ask a follow-up in the same thread ────────────────────────── */
console.log("\n  Journey 3 — asks a follow-up");
// Wait for the first turn to finish before typing.
//
// Not politeness: the composer is deliberately disabled while a turn is in
// flight, so typing into it mid-stream does nothing. The first version of this
// walk typed as soon as the earliest tokens appeared and then reported a
// missing second answer - a fault in the walk, not in the app. A person sees
// the answer still arriving and waits.
await page
  .waitForSelector('button[aria-label="Stop"]', { state: "detached", timeout: 240000 })
  .catch(() => {});
const composer = page.locator("textarea");
await composer.waitFor({ state: "visible", timeout: 30000 });
await composer.fill("And how many of those are on hold?");
await page.keyboard.press("Enter");
await page.waitForFunction(
  () => document.querySelectorAll(".fab-md").length >= 2, null, { timeout: 240000 },
).catch(() => {});
ok("3", "the thread holds both turns",
  (await page.locator(".fab-md").count()) >= 2,
  `${await page.locator(".fab-md").count()} answers`);

/* ── Journey 4: read a pinned report ──────────────────────────────────────── */
console.log("\n  Journey 4 — reads a dashboard an administrator pinned");
await page.goto(`${APP}/reports`, { waitUntil: "domcontentloaded" });
const reportRows = page.locator("ul li button");
await reportRows.first().waitFor({ timeout: 60000 }).catch(() => {});
const rows = await reportRows.count();
ok("4", "pinned reports are listed", rows > 0, `${rows} report(s)`);
if (rows > 0) {
  await reportRows.first().click();
  const frame = page.locator("iframe");
  await frame.first().waitFor({ timeout: 60000 }).catch(() => {});
  ok("4", "a report opens in a frame", (await frame.count()) > 0);
  ok("4", "the frame is sandboxed without same-origin",
    (await frame.first().getAttribute("sandbox")) === "allow-scripts",
    `sandbox="${await frame.first().getAttribute("sandbox")}"`);
  ok("4", "no pin, unpin or refresh control is offered",
    (await page.getByRole("button", { name: /pin|unpin|refresh|delete/i }).count()) === 0);
}

/* ── Journey 5: sign out, and the session is really gone ──────────────────── */
console.log("\n  Journey 5 — signs out");
const token = await page.evaluate(() => localStorage.getItem("llmatscale_auth_token"));
await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
const signOut = page.getByRole("button", { name: /sign out/i }).or(page.getByText(/sign out/i));
await signOut.first().click({ timeout: 30000 }).catch(() => {});
await page.waitForFunction(() => location.pathname.startsWith("/login"), null, { timeout: 40000 })
  .catch(() => {});
ok("5", "returns to sign-in", page.url().includes("/login"), page.url());

// The kept token must now authenticate nothing — that is what sign-out means.
const afterOut = await fetch(`${APP}/api/faborch/reports`, {
  headers: { Authorization: `Bearer ${token}` },
});
ok("5", "the old token authenticates nothing", afterOut.status === 401, `HTTP ${afterOut.status}`);

await context.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => `J${f.journey} ${f.step}`).join(" | "));
  process.exitCode = 1;
}
