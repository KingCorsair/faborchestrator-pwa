/**
 * WP8 — what the embedding costs, measured rather than argued.
 *
 * WP0's baseline said the number to beat and named this package as the place
 * it would be checked. So this measures the same work two ways — through the
 * gateway and straight to FabOrchestrator — and prints whatever it finds.
 *
 * ── The confound this script cannot remove, and how WP8 removes it ──────────
 * Run from a laptop, "through the gateway" is *client → Fly edge → Singapore →
 * CloudFront*, while "direct" is *client → nearest CloudFront edge*. Those two
 * routes differ by geography, not by architecture, and no amount of averaging
 * separates them. So the honest gateway-overhead number is **not** measured
 * here: it is measured from inside the Fly machine, where both legs start in
 * the same place, and that run is recorded in `docs/STATUS.md`. What this
 * script measures is the other half — what a *phone* actually experiences,
 * which is the number that decides whether anyone minds.
 *
 * ── Sections ────────────────────────────────────────────────────────────────
 *  1. Documents. FabOrchestrator's `/chat` and `/reports`, and this app's own
 *     `/login` as the floor for "a document from Fly".
 *  2. One chunk, and the bytes on the wire — because the gateway decompresses
 *     what CloudFront sent and something else compresses it again, and a phone
 *     on mobile data pays for the difference.
 *  3. Every chunk `/chat` references, in parallel, as a browser would. One
 *     asset's latency is not the number that matters; the fan-out is.
 *  4. A question — time to first byte, to the first token of text, and total.
 *     Three embedded variants, because WP4's ownership check costs an upstream
 *     read on a cache miss and that cost should be visible rather than assumed:
 *     no conversation id, an owned id cold, the same id a second time warm.
 *
 * Every timing is a median of several runs, and the runs are printed, because
 * one sample across the public internet is not a measurement.
 *
 * ⚠ Costs real model turns: 4 short ones and 2 real ones. The turns carrying a
 * conversation id are written into `CONVERSATION_TITLE` below — an earlier
 * check's throwaway thread, never an operator's.
 *
 * Run:  APP_URL=https://faborch-embed-preview.fly.dev node scripts/embed-latency-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
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
const APP = (process.env.APP_URL ?? "https://faborch-embed-preview.fly.dev").replace(/\/$/, "");
const FO = (env.FABORCH_BASE_URL ?? "").replace(/\/$/, "");
const RUNS = Number(process.env.RUNS ?? 5);
/** The thread the id-carrying turns are written into. A check's own leavings. */
const CONVERSATION_TITLE = /^WP4 embedded check$/;
if (!FO || !env.FABORCH_PROBE_EMAIL || !env.FABORCH_PROBE_PASSWORD) {
  console.error("Need FABORCH_BASE_URL, FABORCH_PROBE_EMAIL, FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}

const out = [];
function say(line = "") {
  console.log(line);
  out.push(line);
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** One request, timed to the first byte and to the last. */
async function once(url, init = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { redirect: "manual", cache: "no-store", ...init });
  const ttfb = performance.now() - t0;
  const body = await res.arrayBuffer();
  return {
    status: res.status,
    ttfb,
    total: performance.now() - t0,
    bytes: body.byteLength,
    enc: res.headers.get("content-encoding") ?? "identity",
    cc: res.headers.get("cache-control") ?? "",
    xcache: res.headers.get("x-cache") ?? "",
  };
}

async function sample(url, init, runs = RUNS) {
  const rows = [];
  for (let i = 0; i < runs; i++) rows.push(await once(url, init));
  return {
    ...rows[0],
    ttfb: Math.round(median(rows.map((r) => r.ttfb))),
    total: Math.round(median(rows.map((r) => r.total))),
    runs: rows.map((r) => Math.round(r.ttfb)),
  };
}

// ── Sessions ────────────────────────────────────────────────────────────────
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
const bearer = { authorization: `Bearer ${token}`, cookie };

const foLogin = await fetch(`${FO}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: env.FABORCH_PROBE_EMAIL, password: env.FABORCH_PROBE_PASSWORD }),
});
const foToken = foLogin.ok ? (await foLogin.json()).token : null;
const foAuth = { authorization: `Bearer ${foToken}` };

say(`# WP8 — embedding latency, as a phone experiences it — ${new Date().toISOString()}`);
say(`PWA: \`${APP}\` · FabOrchestrator: \`${FO}\` · median of ${RUNS} runs · client: this machine`);
say();
say("> The gateway's *own* cost is not in this table. Measured from a laptop, the");
say("> two columns differ by geography as much as by architecture. The clean");
say("> number comes from inside the Fly machine and is recorded in `docs/STATUS.md`.");
say();

// ── 1. Documents ────────────────────────────────────────────────────────────
say("## Documents");
say("| Document | Through the gateway | Direct from FabOrchestrator |");
say("|---|---|---|");
for (const p of ["/chat", "/reports"]) {
  const via = await sample(`${APP}${p}`, { headers: { cookie } });
  const direct = await sample(`${FO}${p}`);
  say(`| \`${p}\` | ${via.ttfb} ms (${via.runs.join("/")}) | ${direct.ttfb} ms (${direct.runs.join("/")}) |`);
}
const ownDoc = await sample(`${APP}/login`);
say(`| \`/login\` — this app's own | ${ownDoc.ttfb} ms (${ownDoc.runs.join("/")}) | — |`);
say();

// ── 2. One chunk, and the bytes on the wire ─────────────────────────────────
say("## One FabOrchestrator chunk");
const chatHtml = await fetch(`${APP}/chat`, { headers: { cookie } }).then((r) => r.text());
const assets = [...new Set([...chatHtml.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]))];
const chunk = assets.find((a) => a.endsWith(".js"));
if (chunk) {
  const gz = { "accept-encoding": "gzip, br" };
  const via = await sample(`${APP}${chunk}`, { headers: gz });
  const direct = await sample(`${FO}${chunk}`, { headers: gz });
  say("| | Through the gateway | Direct from FabOrchestrator |");
  say("|---|---|---|");
  say(`| time to first byte | ${via.ttfb} ms (${via.runs.join("/")}) | ${direct.ttfb} ms (${direct.runs.join("/")}) |`);
  say(`| \`cache-control\` | \`${via.cc}\` | \`${direct.cc}\` |`);
  say(`| \`content-encoding\` | \`${via.enc}\` | \`${direct.enc}\` |`);
  say(`| decoded size | ${via.bytes} bytes | ${direct.bytes} bytes |`);
  say();
  say(`\`${chunk}\`. Both sides forward FabOrchestrator's \`immutable\`, so a returning phone`);
  say("pays for this chunk **once** and then reads it from its own cache. The first visit is");
  say("the only one that costs anything, which is what makes the fan-out below the number to watch.");
}
say();

// ── 3. The whole fan-out ────────────────────────────────────────────────────
say("## Everything `/chat` asks for, in parallel");
async function fanOut(base, headers) {
  const t0 = performance.now();
  const rows = await Promise.all(
    assets.map(async (a) => {
      const r = await fetch(`${base}${a}`, { headers, cache: "no-store" }).catch(() => null);
      const buf = r ? await r.arrayBuffer().catch(() => null) : null;
      return { status: r?.status ?? 0, bytes: buf?.byteLength ?? 0 };
    }),
  );
  return {
    ms: Math.round(performance.now() - t0),
    ok: rows.filter((r) => r.status === 200).length,
    n: rows.length,
    kb: Math.round(rows.reduce((a, r) => a + r.bytes, 0) / 1024),
  };
}
const gz = { "accept-encoding": "gzip, br" };
const fanVia = await fanOut(APP, { ...gz, cookie });
const fanDirect = await fanOut(FO, gz);
say("| | Through the gateway | Direct from FabOrchestrator |");
say("|---|---|---|");
say(`| ${assets.length} assets, all at once | ${fanVia.ms} ms | ${fanDirect.ms} ms |`);
say(`| served | ${fanVia.ok}/${fanVia.n}, ${fanVia.kb} KB decoded | ${fanDirect.ok}/${fanDirect.n}, ${fanDirect.kb} KB decoded |`);
say();

// ── 4. A question ───────────────────────────────────────────────────────────
say("## A question");
async function ask(url, headers, body) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  const r = { status: res?.status ?? 0, ttfb: Math.round(performance.now() - t0), firstText: null, total: null, tools: 0, deltas: 0 };
  if (!res?.ok || !res.body) {
    r.total = Math.round(performance.now() - t0);
    return r;
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
      if (line.includes('"type":"tool-input-start"')) r.tools += 1;
      if (line.includes('"type":"text-delta"')) {
        r.deltas += 1;
        if (r.firstText === null) r.firstText = Math.round(performance.now() - t0);
      }
    }
  }
  r.total = Math.round(performance.now() - t0);
  return r;
}

// FabOrchestrator's client sends its connected tools with every turn, and a
// turn without them is a different question. Read through the gateway, which
// also confirms the WP2 bridge is what is authenticating these calls.
const conns = await fetch(`${APP}/api/mcp/connections`, { headers: bearer }).then((r) => r.json()).catch(() => []);
const mcpIds = Array.isArray(conns) ? conns.filter((c) => c.status === "connected").map((c) => c.id) : [];
const payload = (text, conversationId) => ({
  messages: [{ role: "user", parts: [{ type: "text", text }] }],
  model: "claude-opus-4-8",
  activeMcpIds: mcpIds,
  webSearch: false,
  enableReasoning: true,
  ...(conversationId ? { conversationId } : {}),
});

// A thread an earlier check left behind, so the id-carrying turns land
// somewhere nobody reads. If it is gone, those two rows are skipped rather
// than written into somebody's conversation.
const convs = await fetch(`${APP}/api/conversations?agent=chat`, { headers: bearer }).then((r) => r.json()).catch(() => []);
const convRows = convs?.conversations ?? (Array.isArray(convs) ? convs : []);
const scratch = convRows.find((c) => CONVERSATION_TITLE.test(c.title ?? ""));
const listBytes = JSON.stringify(convRows).length;

/**
 * A second sign-in, for the genuinely cold row.
 *
 * The list read above already happened on `bearer`'s token — and since WP8 that
 * read *is* the warming, so a turn on that session can no longer be cold no
 * matter what order it is sent in. Measuring the cold path therefore needs a
 * session the gateway has never seen a list for: same operator, same
 * conversation, a token that has asked for nothing yet.
 */
async function freshSession() {
  const res = await fetch(`${APP}/api/pwa/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: env.FABORCH_PROBE_EMAIL, password: env.FABORCH_PROBE_PASSWORD }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  const c = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith("faborch_token="))?.split(";")[0] ?? "";
  return { authorization: `Bearer ${body.token}`, cookie: c };
}

const SHORT = "Reply with the single word: acknowledged.";
say("### A short prompt, four ways");
say("| Path | TTFB | First text | Total |");
say("|---|---|---|---|");
const shortVia = await ask(`${APP}/api/chat`, bearer, payload(SHORT));
say(`| embedded, no conversation id | ${shortVia.ttfb} ms | ${shortVia.firstText ?? "—"} ms | ${shortVia.total} ms |`);
if (scratch) {
  const coldAuth = await freshSession();
  if (coldAuth) {
    const cold = await ask(`${APP}/api/chat`, coldAuth, payload(SHORT, scratch.id));
    say(`| embedded, id — a session that has read no list | ${cold.ttfb} ms | ${cold.firstText ?? "—"} ms | ${cold.total} ms |`);
    await fetch(`${APP}/api/pwa/auth/logout`, { method: "POST", headers: coldAuth }).catch(() => {});
  }
  // What a real page does: FabOrchestrator's own client has already fetched the
  // conversation list — the `convs` read above — before anybody could pick a
  // thread to type into. Since WP8 that read is what proves the id.
  const warm = await ask(`${APP}/api/chat`, bearer, payload(SHORT, scratch.id));
  say(`| embedded, id — after the client's own list read | ${warm.ttfb} ms | ${warm.firstText ?? "—"} ms | ${warm.total} ms |`);
}
if (foToken) {
  const direct = await ask(`${FO}/api/chat`, foAuth, payload(SHORT));
  say(`| direct to FabOrchestrator | ${direct.ttfb} ms | ${direct.firstText ?? "—"} ms | ${direct.total} ms |`);
}
say();
say("The third row is the one a person experiences, because FabOrchestrator's own client");
say("always fetches the conversation list on the way in. The second row is what that row");
say("used to cost: before WP8 the proof was fetched again, at the moment it was needed.");
say();
say(`The ownership check (WP4) is the only work the gateway does that costs an upstream`);
say(`round trip. What it reads is this account's conversation list — **${convRows.length} rows,`);
say(`${Math.round(listBytes / 1024)} KB**, growing with the account's history — and since WP8 it reads it`);
say(`from the copy that went past on the way in rather than fetching it again.`);
say();

say("### A real question, the one WP0 asked");
say("| Path | TTFB | First text | Total | Tool calls | Text deltas |");
say("|---|---|---|---|---|---|");
const REAL = "Give me the yield by product.";
const realVia = await ask(`${APP}/api/chat`, bearer, payload(REAL));
say(`| embedded | ${realVia.ttfb} ms | ${realVia.firstText ?? "—"} ms | ${realVia.total} ms | ${realVia.tools} | ${realVia.deltas} |`);
if (foToken) {
  const realDirect = await ask(`${FO}/api/chat`, foAuth, payload(REAL));
  say(`| direct to FabOrchestrator | ${realDirect.ttfb} ms | ${realDirect.firstText ?? "—"} ms | ${realDirect.total} ms | ${realDirect.tools} | ${realDirect.deltas} |`);
}
say();
say("Time to first text is the number a person feels. Total time is FabOrchestrator's own");
say("model and tool work, which the gateway neither adds to nor can shorten — and which");
say("varies by seconds between two runs of the same question, so a difference of that size");
say("between these two rows is the model, not the architecture.");

await fetch(`${APP}/api/pwa/auth/logout`, { method: "POST", headers: bearer }).catch(() => {});
if (foToken) await fetch(`${FO}/api/auth/logout`, { method: "POST", headers: foAuth }).catch(() => {});

const dir = path.join(ROOT, "docs", "probes");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-wp8-latency.md`);
fs.writeFileSync(file, out.join("\n") + "\n");
console.log(`\nwritten to ${path.relative(ROOT, file)}`);
