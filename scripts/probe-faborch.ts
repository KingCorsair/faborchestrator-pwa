/**
 * WP0 environment probes — P1 to P5.
 *
 * Five questions about the LIVE FabOrchestrator that cannot be answered from
 * source, each mapped to a contingency driver in the plan:
 *
 *   P1  Can the probe account sign in?            (account provisioning)
 *   P2  Does the deployment serve the Master      (deployment currency —
 *       Data Load Agent API?                        the one non-/chat agent;
 *                                                   verified vs e5a5abd there
 *                                                   is no backend-agent API)
 *   P3  Do answers STREAM progressively through   (SSE through the hosting
 *       the hosting layers, or arrive in a block?  layers — broke once before)
 *   P4  Does the account have connected data      (plant data availability —
 *       connections?                               2 of 10 were down)
 *   P5  What does the modeling-access probe say?  (role permissions)
 *
 * Reads FABORCH_BASE_URL, FABORCH_PROBE_EMAIL, FABORCH_PROBE_PASSWORD from
 * .env. Never prints the password or the session token. Signs out at the end
 * so no probe session is left alive.
 *
 * Run:  npx tsx scripts/probe-faborch.ts
 */

import fs from "node:fs";

process.loadEnvFile(".env");

const BASE = (process.env.FABORCH_BASE_URL ?? "").replace(/\/$/, "");
const EMAIL = process.env.FABORCH_PROBE_EMAIL ?? "";
const PASSWORD = process.env.FABORCH_PROBE_PASSWORD ?? "";

if (!BASE || !EMAIL || !PASSWORD) {
  console.error(
    "Missing FABORCH_BASE_URL, FABORCH_PROBE_EMAIL or FABORCH_PROBE_PASSWORD in .env",
  );
  process.exit(1);
}

const mask = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");
const results: { id: string; question: string; verdict: string; detail: string }[] = [];
const record = (id: string, question: string, verdict: string, detail: string) => {
  results.push({ id, question, verdict, detail });
  console.log(`${id}  ${verdict}  ${detail}`);
};

async function main() {
  console.log(`Probing ${BASE} as ${mask(EMAIL)}\n`);

  // ── P1: login ──────────────────────────────────────────────────────────────
  let token = "";
  try {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const body = (await r.json().catch(() => ({}))) as {
      token?: string;
      user?: { email?: string };
      error?: unknown;
    };
    if (r.status === 200 && body.token) {
      token = body.token;
      record("P1", "Sign-in", "PASS", `200; session token issued`);
    } else {
      record(
        "P1",
        "Sign-in",
        "FAIL",
        `HTTP ${r.status}; error shape: ${JSON.stringify(body.error ?? body).slice(0, 200)}`,
      );
      finish();
      return;
    }
  } catch (e) {
    record("P1", "Sign-in", "FAIL", `network error: ${(e as Error).message}`);
    finish();
    return;
  }
  const auth = { Authorization: `Bearer ${token}` };

  // ── P2: Master Data Load Agent API deployed? ─────────────────────────────
  // The only agent endpoint that is not /api/chat (upstream e5a5abd: the
  // Back-end Agent card routes to /chat; no backend-agent API exists in any
  // branch). Only the status code matters. Abort as soon as headers are back
  // so a 200 does not run a full agent turn.
  try {
    const ac = new AbortController();
    const r = await fetch(`${BASE}/api/modeling-agent/chat`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { id: "probe-1", role: "user", parts: [{ type: "text", text: "probe" }] },
        ],
      }),
      signal: ac.signal,
    });
    const status = r.status;
    ac.abort();
    if (status === 404)
      record("P2", "Master Data Load Agent API present", "FAIL", "404 — deployment predates the route");
    else
      record(
        "P2",
        "Master Data Load Agent API present",
        status < 500 ? "PASS" : "WARN",
        `HTTP ${status} — route exists${status >= 500 ? " but errored" : ""}`,
      );
  } catch (e) {
    record("P2", "Master Data Load Agent API present", "WARN", `request failed: ${(e as Error).message}`);
  }

  // ── P4: connected data connections ────────────────────────────────────────
  try {
    const r = await fetch(`${BASE}/api/mcp/connections`, { headers: auth });
    const body = (await r.json().catch(() => ({}))) as {
      connections?: { id: string; name: string; status: string }[];
    };
    const all = body.connections ?? [];
    const connected = all.filter((c) => c.status === "connected");
    record(
      "P4",
      "Data connections",
      connected.length > 0 ? "PASS" : "FAIL",
      `${connected.length} connected of ${all.length} visible` +
        (connected.length ? `: ${connected.map((c) => c.name).join(", ")}` : ""),
    );
  } catch (e) {
    record("P4", "Data connections", "FAIL", `request failed: ${(e as Error).message}`);
  }

  // ── P5: modeling access ───────────────────────────────────────────────────
  try {
    const r = await fetch(`${BASE}/api/modeling-agent/access`, { headers: auth });
    const body = (await r.json().catch(() => ({}))) as { enabled?: boolean };
    record(
      "P5",
      "Modeling Agent permission",
      r.status === 200 ? "PASS" : "WARN",
      r.status === 200
        ? `enabled: ${body.enabled === true}`
        : `HTTP ${r.status} — probe route missing?`,
    );
  } catch (e) {
    record("P5", "Modeling Agent permission", "WARN", `request failed: ${(e as Error).message}`);
  }

  // ── P3: progressive streaming ─────────────────────────────────────────────
  // Ask a tiny question with NO data connections (cheap, fast) and watch when
  // bytes actually arrive. Progressive means several separate arrivals spread
  // over time; buffered means one arrival carrying everything.
  try {
    const ac = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => ac.abort(), 90_000);
    const r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            id: "probe-stream-1",
            role: "user",
            parts: [{ type: "text", text: "Count from 1 to 30, one number per line." }],
          },
        ],
        activeMcpIds: [],
        webSearch: false,
        enableReasoning: false,
      }),
      signal: ac.signal,
    });
    if (!r.ok || !r.body) {
      record("P3", "Progressive streaming", "FAIL", `HTTP ${r.status}`);
    } else {
      const reader = r.body.getReader();
      const arrivals: number[] = [];
      let deltas = 0;
      let buffered = "";
      let firstDeltaAt = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arrivals.push(Date.now() - started);
        buffered += new TextDecoder().decode(value, { stream: true });
        const found = buffered.match(/"type":"text-delta"/g);
        const n = found ? found.length : 0;
        if (n > deltas && firstDeltaAt === 0) firstDeltaAt = Date.now() - started;
        deltas = n;
        if (deltas >= 12) {
          ac.abort(); // enough evidence; do not wait out the whole answer
          break;
        }
      }
      clearTimeout(timer);
      const spread = arrivals.length > 1 ? arrivals[arrivals.length - 1] - arrivals[0] : 0;
      const progressive = arrivals.length >= 4 && spread > 300 && deltas >= 4;
      record(
        "P3",
        "Progressive streaming",
        progressive ? "PASS" : "FAIL",
        `${arrivals.length} network arrivals over ${spread} ms, ` +
          `${deltas} text-delta frames, first delta at ${firstDeltaAt} ms`,
      );
    }
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "aborted after evidence collected" : (e as Error).message;
    if (!results.some((x) => x.id === "P3"))
      record("P3", "Progressive streaming", "FAIL", msg);
  }

  // ── bonus: which models does this deployment offer? (deploy-currency hint)
  try {
    const r = await fetch(`${BASE}/api/chat`, { headers: auth });
    const body = (await r.json().catch(() => ({}))) as {
      models?: { id: string }[];
    };
    if (r.status === 200 && body.models)
      record("i", "Models offered", "INFO", body.models.map((m) => m.id).join(", "));
  } catch {
    /* informational only */
  }

  // ── sign out: leave no probe session behind ───────────────────────────────
  try {
    await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: auth });
  } catch {
    /* best effort */
  }

  finish();
}

function finish() {
  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [
    `# WP0 environment probe report — ${stamp}`,
    ``,
    `Target: \`${BASE}\`  ·  Account: \`${mask(EMAIL)}\``,
    ``,
    `| Probe | Question | Verdict | Evidence |`,
    `|---|---|---|---|`,
    ...results.map((r) => `| ${r.id} | ${r.question} | **${r.verdict}** | ${r.detail} |`),
    ``,
    `Generated by \`scripts/probe-faborch.ts\`. A FAIL on P2/P3/P4 fires the`,
    `matching contingency driver in the plan; a PASS releases it.`,
  ];
  fs.mkdirSync("docs/probes", { recursive: true });
  const out = `docs/probes/${stamp}-probe-report.md`;
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`\nReport written to ${out}`);
}

main();
