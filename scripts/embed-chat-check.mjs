/**
 * WP4 — the embedded chat is the real FabInsight.
 *
 * Everything up to here proved the plumbing: the document arrives, the session
 * carries, the caches are right. This proves the product — that a real
 * question asked through the gateway is answered by FabOrchestrator, streamed
 * progressively, with its tools, its history and its ownership rules intact.
 *
 * ── Why this is a separate script ───────────────────────────────────────────
 * `embed-live-check.mjs` runs in seconds and is run constantly. This one costs
 * **real model turns** on the FabOrchestrator account — a tool-using question
 * took 65 s when the latency baseline measured it — so it is kept apart rather
 * than folded into the fast loop. Deliberate deviation from the WP4 plan,
 * which had them in one file.
 *
 * ── The security assertion in here matters most ─────────────────────────────
 * FabOrchestrator's `/api/chat` writes into whatever `conversationId` it is
 * given without checking whose it is. The gateway proves ownership first. The
 * check below sends a **forged** id and requires that the turn is still
 * answered and that FabOrchestrator did not write it into that conversation.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/embed-chat-check.mjs
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
const APP = (process.env.APP_URL ?? "http://localhost:3002").replace(/\/$/, "");
const FO = (env.FABORCH_BASE_URL ?? "").replace(/\/$/, "");
if (!env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}

let failures = 0;
function record(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(t) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
}

// Sign in through this app's own form, exactly as the embedded page's user did.
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
const auth = { authorization: `Bearer ${token}`, cookie, "content-type": "application/json" };

/** Ask a question through the gateway and time how the answer arrives. */
async function ask(text, conversationId) {
  const mcp = await fetch(`${APP}/api/mcp/connections`, { headers: auth }).then((r) => r.json());
  const activeMcpIds = Array.isArray(mcp) ? mcp.filter((c) => c.status === "connected").map((c) => c.id) : [];

  const body = {
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
    model: "claude-opus-4-8",
    activeMcpIds,
    webSearch: false,
    enableReasoning: true,
  };
  if (conversationId) body.conversationId = conversationId;

  const t0 = Date.now();
  const res = await fetch(`${APP}/api/chat`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const out = { status: res.status, firstTextMs: null, totalMs: null, arrivals: 0, textDeltas: 0, toolCalls: 0, text: "" };
  if (!res.ok || !res.body) {
    out.totalMs = Date.now() - t0;
    out.error = (await res.text().catch(() => "")).slice(0, 200);
    return out;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let carry = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.arrivals += 1; // a separate network arrival = the answer really streamed
    carry += dec.decode(value, { stream: true });
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      if (line.includes('"type":"tool-input-start"')) out.toolCalls += 1;
      for (const m of line.matchAll(/"type":"text-delta"[^}]*"delta":"((?:[^"\\]|\\.)*)"/g)) {
        out.textDeltas += 1;
        if (out.firstTextMs === null) out.firstTextMs = Date.now() - t0;
        out.text += m[1];
      }
    }
  }
  out.totalMs = Date.now() - t0;
  return out;
}

// ── 1. A real answer, streamed ───────────────────────────────────────────────
section("1. a real question, through the gateway");
const yieldAnswer = await ask("Give me the yield by product.");
record("FabOrchestrator answered", yieldAnswer.status === 200 && yieldAnswer.textDeltas > 0, `HTTP ${yieldAnswer.status}, ${yieldAnswer.textDeltas} text frames`);
record(
  "…and it streamed rather than arriving in one lump",
  yieldAnswer.arrivals > 3 && yieldAnswer.firstTextMs !== null && yieldAnswer.firstTextMs < yieldAnswer.totalMs * 0.9,
  `${yieldAnswer.arrivals} arrivals; first text ${yieldAnswer.firstTextMs} ms of ${yieldAnswer.totalMs} ms`,
);
record(
  "…with real plant figures in it, not a refusal",
  /\d/.test(yieldAnswer.text) && !/no (live |connected )?data|cannot access/i.test(yieldAnswer.text),
  yieldAnswer.text.replace(/\s+/g, " ").slice(0, 110),
);

// ── 2. Tools ────────────────────────────────────────────────────────────────
section("2. FabOrchestrator's tools run through the gateway");
const wipAnswer = await ask("How many lots are currently in WIP?");
record("a data question was answered", wipAnswer.status === 200 && wipAnswer.textDeltas > 0, `HTTP ${wipAnswer.status}, ${wipAnswer.totalMs} ms`);
record("…and FabOrchestrator called its own tools to do it", wipAnswer.toolCalls > 0, `${wipAnswer.toolCalls} tool calls`);

// ── 3. History, in FabOrchestrator's own store ──────────────────────────────
section("3. history is FabOrchestrator's, and it persists");
const created = await fetch(`${APP}/api/conversations`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ title: "WP4 embedded check", model: "claude-opus-4-8", agent: "chat" }),
});
const createdBody = await created.json().catch(() => ({}));
const conversationId = createdBody?.id ?? null;
record("a conversation can be created through the gateway", created.ok && !!conversationId, `HTTP ${created.status}`);

if (conversationId) {
  const inThread = await ask("In one short sentence, what does yield mean here?", conversationId);
  record("a turn sent into it is answered", inThread.status === 200 && inThread.textDeltas > 0, `HTTP ${inThread.status}`);

  const stored = await fetch(`${APP}/api/conversations/${conversationId}`, { headers: auth });
  const storedBody = await stored.json().catch(() => ({}));
  const messages = storedBody?.messages ?? storedBody?.conversation?.messages ?? [];
  record("…and FabOrchestrator wrote it into that conversation", stored.ok && messages.length > 0, `HTTP ${stored.status}, ${messages.length} messages`);

  // The same thread, read straight from FabOrchestrator rather than through
  // this app: what the FabOrchestrator website would show.
  if (FO) {
    const foLogin = await fetch(`${FO}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: env.FABORCH_PROBE_EMAIL, password: env.FABORCH_PROBE_PASSWORD }),
    });
    if (foLogin.ok) {
      const foToken = (await foLogin.json()).token;
      const onSite = await fetch(`${FO}/api/conversations/${conversationId}`, { headers: { authorization: `Bearer ${foToken}` } });
      const onSiteBody = await onSite.json().catch(() => ({}));
      const onSiteMessages = onSiteBody?.messages ?? onSiteBody?.conversation?.messages ?? [];
      record("…and the same thread is visible on FabOrchestrator itself", onSite.ok && onSiteMessages.length > 0, `HTTP ${onSite.status}, ${onSiteMessages.length} messages`);
      await fetch(`${FO}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${foToken}` } }).catch(() => {});
    }
  }
}

// ── 4. The ownership rule, over the wire ────────────────────────────────────
section("4. a forged conversationId cannot be written into");
{
  const forged = "00000000-0000-4000-8000-000000000000";
  const before = await fetch(`${APP}/api/conversations/${forged}`, { headers: auth });
  const answer = await ask("Say the single word: acknowledged.", forged);
  record("the turn is still answered rather than refused", answer.status === 200 && answer.textDeltas > 0, `HTTP ${answer.status}`);
  const after = await fetch(`${APP}/api/conversations/${forged}`, { headers: auth });
  record(
    "…and FabOrchestrator did not create or write that conversation",
    before.status === after.status && after.status !== 200,
    `before HTTP ${before.status}, after HTTP ${after.status}`,
  );
}

await fetch(`${APP}/api/pwa/auth/logout`, { method: "POST", headers: auth }).catch(() => {});
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures);
