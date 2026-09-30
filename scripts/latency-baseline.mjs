/**
 * WP0 — latency baseline for the current architecture. Read-only.
 *
 * Two things are measured, because the embedding work changes both:
 *
 *  1. Static delivery. Time to first byte for the FO chat document and one FO
 *     JavaScript chunk fetched directly from FabOrchestrator, and for the PWA's
 *     own sign-in document from the deployment. This is the "extra hop" cost
 *     that embedding will add to FO assets.
 *
 *  2. A question, two ways. The same question sent (a) through the PWA's own
 *     proxy route, as the app does today, and (b) straight to FO's /api/chat
 *     with the account's connected tools, as FO's own website does. For each:
 *     time to first byte, time to the first text, total time, and how many
 *     tool calls the answer needed. This is the number the embedded path will
 *     be compared against in WP8.
 *
 * Costs: 2 questions × 2 paths = 4 model turns on the FO account. Keep it at
 * that. Signs out of both sessions at the end. Prints no secrets.
 *
 * Run:  node scripts/latency-baseline.mjs
 *       APP_URL=http://localhost:3002 node scripts/latency-baseline.mjs
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

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
const FO = (process.env.FABORCH_BASE_URL ?? env.FABORCH_BASE_URL ?? "").replace(/\/$/, "");
const APP = (process.env.APP_URL ?? "https://faborch-demo.fly.dev").replace(/\/$/, "");
const EMAIL = env.FABORCH_PROBE_EMAIL;
const PASSWORD = env.FABORCH_PROBE_PASSWORD;
if (!FO || !EMAIL || !PASSWORD) {
  console.error("Need FABORCH_BASE_URL, FABORCH_PROBE_EMAIL, FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}

const QUESTIONS = ["Give me the yield by product.", "How many lots are currently in WIP?"];

async function ttfb(url, init = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { redirect: "manual", ...init });
  const first = performance.now() - t0;
  const buf = await res.arrayBuffer();
  return { status: res.status, ttfbMs: Math.round(first), totalMs: Math.round(performance.now() - t0), bytes: buf.byteLength };
}

async function median3(fn) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await fn());
  runs.sort((a, b) => a.ttfbMs - b.ttfbMs);
  return { ...runs[1], runs: runs.map((r) => r.ttfbMs) };
}

/** Read an SSE/UI-message stream and time its milestones. */
async function timeStream(res, t0) {
  const out = { status: res.status, ttfbMs: Math.round(performance.now() - t0), firstTextMs: null, totalMs: null, toolCalls: 0, textDeltas: 0, steps: 0 };
  if (!res.ok || !res.body) {
    out.totalMs = Math.round(performance.now() - t0);
    out.error = (await res.text().catch(() => "")).slice(0, 200);
    return out;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let carry = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    carry += dec.decode(value, { stream: true });
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      if (line.includes('"type":"text-delta"')) {
        out.textDeltas += 1;
        if (out.firstTextMs == null) out.firstTextMs = Math.round(performance.now() - t0);
      }
      if (line.includes('"type":"tool-input-start"')) out.toolCalls += 1;
      if (line.includes('"type":"start-step"')) out.steps += 1;
    }
  }
  out.totalMs = Math.round(performance.now() - t0);
  return out;
}

const report = { at: new Date().toISOString(), fo: FO, app: APP, static: {}, questions: [] };

// 1. Static delivery.
const chatHtml = await fetch(`${FO}/chat`).then((r) => r.text());
const chunk = (chatHtml.match(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/) ?? [])[1];
report.static.foChatHtml = await median3(() => ttfb(`${FO}/chat`));
if (chunk) report.static.foChunk = { path: chunk, ...(await median3(() => ttfb(`${FO}${chunk}`, { headers: { "accept-encoding": "gzip, br" } }))) };
report.static.pwaLoginHtml = await median3(() => ttfb(`${APP}/login`));

// 2. Sessions.
const pwaLogin = await fetch(`${APP}/api/pwa/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!pwaLogin.ok) {
  console.error(`PWA login failed: ${pwaLogin.status}`);
  process.exit(1);
}
const pwaBody = await pwaLogin.json();
const pwaCookie = (pwaLogin.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("faborch_token="))?.split(";")[0] ?? "";
const pwaAuth = { authorization: `Bearer ${pwaBody.token}`, cookie: pwaCookie, "content-type": "application/json" };

const foLogin = await fetch(`${FO}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!foLogin.ok) {
  console.error(`FO login failed: ${foLogin.status}`);
  process.exit(1);
}
const foToken = (await foLogin.json()).token;
const foAuth = { authorization: `Bearer ${foToken}`, "content-type": "application/json" };
const conns = await fetch(`${FO}/api/mcp/connections`, { headers: foAuth }).then((r) => r.json());
const mcpIds = Array.isArray(conns) ? conns.filter((c) => c.status === "connected").map((c) => c.id) : [];

// 3. The questions, two ways.
for (const q of QUESTIONS) {
  const entry = { question: q };
  {
    const t0 = performance.now();
    const res = await fetch(`${APP}/api/faborch/insight/chat`, {
      method: "POST",
      headers: pwaAuth,
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: q }] }] }),
    });
    entry.viaPwa = await timeStream(res, t0);
  }
  {
    const t0 = performance.now();
    const res = await fetch(`${FO}/api/chat`, {
      method: "POST",
      headers: foAuth,
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: q }] }],
        model: "claude-opus-4-8",
        activeMcpIds: mcpIds,
        webSearch: false,
        enableReasoning: true,
      }),
    });
    entry.directFo = await timeStream(res, t0);
  }
  report.questions.push(entry);
}

// 4. Sign out of both.
await fetch(`${APP}/api/pwa/auth/logout`, { method: "POST", headers: pwaAuth }).catch(() => {});
await fetch(`${FO}/api/auth/logout`, { method: "POST", headers: foAuth }).catch(() => {});

// Markdown.
const L = [];
L.push(`# Latency baseline — ${report.at}`);
L.push(`FO: \`${FO}\` · PWA: \`${APP}\` · client: this machine`);
L.push("");
L.push("## Static delivery (median of 3, time to first byte)");
L.push("| Request | Status | TTFB | Total | Bytes | Runs (TTFB) |");
L.push("|---|---|---|---|---|---|");
for (const [k, v] of Object.entries(report.static)) {
  L.push(`| ${k}${v.path ? ` \`${v.path}\`` : ""} | ${v.status} | ${v.ttfbMs} ms | ${v.totalMs} ms | ${v.bytes} | ${v.runs.join(" / ")} |`);
}
L.push("");
L.push("## One question, two paths");
L.push("| Question | Path | Status | TTFB | First text | Total | Steps | Tool calls | Text deltas |");
L.push("|---|---|---|---|---|---|---|---|---|");
for (const e of report.questions) {
  for (const [label, r] of [["via PWA proxy", e.viaPwa], ["direct to FO", e.directFo]]) {
    L.push(`| ${e.question} | ${label} | ${r.status} | ${r.ttfbMs} ms | ${r.firstTextMs ?? "—"} ms | ${r.totalMs} ms | ${r.steps} | ${r.toolCalls} | ${r.textDeltas}${r.error ? ` · ${r.error}` : ""} |`);
  }
}
L.push("");
L.push(`Connected MCP ids sent on the direct path: ${mcpIds.length}`);
console.log(L.join("\n"));
