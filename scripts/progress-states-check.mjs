/**
 * WP10 in a real browser: do the three progress states actually appear, in
 * order, during a real answer from the live platform?
 *
 * The reducer tests prove the transitions. Only this proves the operator sees
 * them.
 */
import { chromium } from "playwright";
import fs from "node:fs";

const ROOT = "C:/Users/ATUL ANAND/OneDrive/Documentos/Desktop/AthenaTech/faborchestrator-pwa";
const env = Object.fromEntries(
  fs.readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const APP = "http://localhost:3002";

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();

await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" });
await page.fill('input[type="email"]', env.FABORCH_PROBE_EMAIL);
await page.fill('input[type="password"]', env.FABORCH_PROBE_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 });

await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });
const box = page.locator("textarea");
await box.waitFor({ timeout: 15000 });

// Poll the status line so the sequence of states is captured, not just the end.
const seen = [];
const watcher = setInterval(async () => {
  try {
    const text = await page.locator('[role="status"]').first().innerText({ timeout: 400 });
    const t = text.replace(/\s+/g, " ").trim();
    if (t && seen[seen.length - 1] !== t) seen.push(t);
  } catch { /* between renders */ }
}, 180);

// A question that needs a tool, so `working` is genuinely reached.
await box.fill("How many lots are currently in WIP?");
await page.keyboard.press("Enter");

await page.waitForFunction(
  () => (document.querySelector(".fab-md")?.textContent ?? "").length > 40,
  null,
  { timeout: 180000 },
).catch(() => {});
await page.waitForSelector('button[aria-label="Stop"]', { state: "detached", timeout: 180000 })
  .catch(() => {});
clearInterval(watcher);

console.log("\n  states observed, in order:");
for (const s of seen) console.log(`     · ${s}`);
console.log("");

ok(
  "the 'waiting' state appears first",
  /Sent to FabOrchestrator/i.test(seen[0] ?? ""),
  seen[0] ?? "(none)",
);
ok(
  "a running tool is named",
  seen.some((s) => /is running \w+/i.test(s)),
  seen.find((s) => /is running/i.test(s)) ?? "(no tool state seen)",
);
ok(
  "'answering' is distinct from waiting",
  seen.some((s) => /^Answering/i.test(s)),
  seen.find((s) => /^Answering/i.test(s)) ?? "(no answering state seen)",
);
ok("no stall warning on a healthy turn", !seen.some((s) => /45 seconds/i.test(s)));

const answer = (await page.locator(".fab-md").first().innerText()) ?? "";
ok("and the answer arrived", answer.length > 40, `${answer.length} chars`);
ok(
  "no incomplete badge on a clean answer",
  (await page.getByText(/stopped part-way and is incomplete/i).count()) === 0,
);

await page.screenshot({ path: "wp10-states.png" });
await context.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
