/**
 * Everything FabOrchestrator said, on screen, in order.
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 * Answers arrived complete and rendered incomplete. Tailwind's preflight sets
 * `list-style: none` on every list; `.fab-md` restored the indent and not the
 * marker, so a six-step procedure rendered as six sentences with no numbers.
 * Measured on the deployment before the fix: 2,137 characters in, 2,041 on
 * screen, and none of `1.` through `6.`.
 *
 * ── Why the answer is canned ────────────────────────────────────────────────
 * The unit guard reads the stylesheet; this reads a browser. Neither can use a
 * live FabOrchestrator answer, because the same question does not return the
 * same shape twice — see docs/FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md.
 * A check that only passes when the model happens to emit a numbered list is a
 * check nobody can trust. So the stream below is FO's own wire format carrying
 * a fixed answer whose shape is the point: paragraphs, numbered instructions,
 * nested bullets, and a tool call between two runs of prose.
 *
 * The assertion is not "it looks right". It is that **every line FO sent is
 * present, in the order it was sent**, and that nothing is merely scrolled or
 * clipped out of sight.
 *
 *   node scripts/answer-render-check.mjs
 *   APP_URL=https://faborch-demo.fly.dev node scripts/answer-render-check.mjs
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

/** The answer under test. Shaped like the one that exposed the bug. */
const ANSWER = `Here is the sequence to follow when yield drops on Line 4.

1. **Confirm the drop is real**
   - Compare against the recent baseline, not against target.
   - Establish whether it was a step change or a slide.
2. **Localize it**
   - Break yield down by process step and by chamber.
   - Look for a single tool that diverges from its peers.
3. **Check what changed**
   - Recipe edits, maintenance events, incoming material lots.

Once those three are done, escalate with the evidence attached.

Supporting notes:

- Baseline is the trailing seven-day median.
- A chamber-level split needs the equipment log, not the lot log.
- Escalation goes to the process owner for that step.`;

/** FO's own wire format: prose, a tool call, then the rest of the prose. */
function stream() {
  const half = ANSWER.indexOf("Once those three");
  const chunks = [];
  const push = (o) => chunks.push(`data: ${JSON.stringify(o)}\n\n`);

  // Many small text-delta frames, as a real stream arrives.
  for (const piece of ANSWER.slice(0, half).match(/[\s\S]{1,60}/g) ?? []) {
    push({ type: "text-delta", delta: piece });
  }
  // Tool activity between two runs of text — the interleaving that a naive
  // renderer replaces instead of appends.
  push({ type: "tool-input-start", toolName: "mcp_query" });
  push({ type: "tool-input-available", toolCallId: "t1", input: { sql: "SELECT 1" } });
  push({ type: "tool-output-available", toolCallId: "t1", output: { rows: [] } });
  for (const piece of ANSWER.slice(half).match(/[\s\S]{1,60}/g) ?? []) {
    push({ type: "text-delta", delta: piece });
  }
  push({ type: "finish" });
  return chunks.join("") + "data: [DONE]\n\n";
}

const browser = await chromium.launch();

async function signedIn(width, height) {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    viewport: { width, height },
    isMobile: width < 900,
    hasTouch: width < 900,
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
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 60_000 });
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === "/", null, { timeout: 60_000 });
  return { context, page };
}

console.log(`\nanswer rendering · ${APP}\n`);

for (const [w, h, label] of [
  [360, 640, "360×640"],
  [390, 844, "390×844"],
  [1280, 900, "desktop"],
]) {
  console.log(`── ${label} ───────────────────────────────────────────────`);
  const { context, page } = await signedIn(w, h);

  await page.route("**/api/faborch/*/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: stream(),
    }),
  );

  await page.goto(`${APP}/fabinsight`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 30_000 });
  await page.fill("#insight-prompt", "How do I investigate a yield drop on Line 4?");
  await page.click('button[aria-label="Send"]');
  await page.waitForSelector(".fab-md", { timeout: 30_000 });
  await page.waitForFunction(
    () => /escalate with the evidence/.test(document.body.innerText),
    null,
    { timeout: 30_000 },
  ).catch(() => {});

  const seen = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll(".fab-md")];
    const el = blocks[blocks.length - 1];
    return {
      text: el.innerText,
      markers: [...el.querySelectorAll("ol > li, ul > li")].map((li) => {
        const cs = getComputedStyle(li.parentElement);
        return { tag: li.parentElement.tagName, type: cs.listStyleType, pos: cs.listStylePosition };
      }),
      clipped: [...document.querySelectorAll(".fab-md, .fab-md *")].some((n) => {
        const cs = getComputedStyle(n);
        return cs.overflow === "hidden" && n.scrollHeight > n.clientHeight + 1;
      }),
      docScroll: document.documentElement.scrollWidth,
      win: window.innerWidth,
    };
  });

  /* 1. every line FO sent is present */
  const lines = ANSWER.split("\n")
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").replace(/\*\*/g, "").trim())
    .filter((l) => l.length > 12);
  const missing = lines.filter((l) => !seen.text.includes(l));
  ok(`${label}: every line FO sent is on screen`, missing.length === 0,
    missing.length ? `missing ${missing.length}: ${JSON.stringify(missing[0].slice(0, 60))}` : `${lines.length} lines`);

  /* 2. in the order it was sent */
  let cursor = -1;
  let ordered = true;
  for (const l of lines) {
    const at = seen.text.indexOf(l);
    if (at < cursor) { ordered = false; break; }
    cursor = at;
  }
  ok(`${label}: …and in the order it was sent`, ordered);

  /* 3. the markers — the actual defect */
  const ol = seen.markers.filter((m) => m.tag === "OL");
  const ul = seen.markers.filter((m) => m.tag === "UL");
  ok(`${label}: numbered steps render their numbers`,
    ol.length > 0 && ol.every((m) => m.type !== "none"),
    ol.length ? `${ol.length} items, list-style-type: ${ol[0].type}` : "no ordered list found");
  ok(`${label}: bullets render their bullets`,
    ul.length > 0 && ul.every((m) => m.type !== "none"),
    ul.length ? `${ul.length} items, list-style-type: ${ul[0].type}` : "no bullet list found");

  /* 4. text after the tool call survived it */
  ok(`${label}: text after the tool call is not lost`,
    seen.text.includes("Escalation goes to the process owner"));

  /* 5. nothing merely hidden */
  ok(`${label}: nothing is clipped out of view`, seen.clipped === false);
  ok(`${label}: the page does not scroll sideways`, seen.docScroll <= seen.win,
    `${seen.docScroll} ≤ ${seen.win}`);

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
