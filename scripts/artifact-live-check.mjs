/**
 * WP9 against the live platform: does a real artifact from FabOrchestrator
 * arrive as a tile, open full screen, and stay inside its sandbox?
 */
import { chromium } from "playwright";
import fs from "node:fs";

const ROOT = "C:/Users/ATUL ANAND/OneDrive/Documentos/Desktop/AthenaTech/faborchestrator-pwa";
const env = Object.fromEntries(
  fs.readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const APP = process.env.APP_URL ?? "http://localhost:3002";

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
});
const page = await context.newPage();

await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" });
await page.fill('input[type="email"]', env.FABORCH_PROBE_EMAIL);
await page.fill('input[type="password"]', env.FABORCH_PROBE_PASSWORD);
await page.waitForFunction(() => {
  const b = document.querySelector('button[type="submit"]');
  return !!b && !b.disabled;
}, null, { timeout: 60000 });
for (let i = 0; i < 3; i++) {
  await page.click('button[type="submit"]');
  try {
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), null, { timeout: 25000 });
    break;
  } catch { if (i === 2) throw new Error("sign-in failed"); }
}

await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });
const box = page.locator("textarea");
await box.waitFor({ timeout: 40000 });

// The artifacts block fires on an explicit request for visual output.
await box.fill("Make a bar chart of yield by product. Visualise it as a dashboard.");
await page.keyboard.press("Enter");

// Wait for a tile, or for the turn to end without one.
const tile = page.locator('button:has-text("tap to open")');
await tile.first().waitFor({ timeout: 240000 }).catch(() => {});

const raw = await page.locator(".fab-md").allInnerTexts();
const rawMarkup = raw.join(" ").includes("<antArtifact");
ok("the raw <antArtifact> markup is never shown as text", !rawMarkup);

const tiles = await tile.count();
ok("an artifact arrived as a tile", tiles > 0, `${tiles} tile(s)`);

if (tiles > 0) {
  const label = (await tile.first().innerText()).replace(/\s+/g, " ");
  console.log(`     tile: ${label}`);
  await tile.first().click();

  const frame = page.locator('iframe[sandbox]');
  await frame.waitFor({ timeout: 30000 }).catch(() => {});
  const shown = await frame.count();
  ok("tapping opens a sandboxed frame", shown > 0);

  if (shown > 0) {
    const sandbox = await frame.first().getAttribute("sandbox");
    ok("the sandbox is allow-scripts only", sandbox === "allow-scripts", `sandbox="${sandbox}"`);
    ok("allow-same-origin is absent", !(sandbox ?? "").includes("allow-same-origin"));

    // The frame has an opaque origin, so this app cannot read into it — which
    // is the point. Assert from outside instead: it rendered something.
    const bb = await frame.first().boundingBox();
    ok("the frame fills the sheet", !!bb && bb.height > 300, bb ? `${Math.round(bb.width)}x${Math.round(bb.height)}` : "none");

    ok("a source view is offered", (await page.getByText(/^Source$/).count()) > 0);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok("the sheet does not scroll the page sideways", overflow <= 0, `overflow ${overflow}px`);

  await page.screenshot({ path: "wp9-artifact.png" });
}

await context.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
