/**
 * E1 — prove the whole architecture, end to end, against the running app.
 *
 * This is the M1 / B1 gate. It exercises the real path a phone takes:
 *
 *   this script  ->  the PWA's own /api/auth/login   (FO credentials)
 *                ->  the PWA's /api/faborch/insight/chat
 *                ->  the PWA's server-side proxy, holding the FO cookie
 *                ->  FabOrchestrator
 *                ->  a streamed answer, back the same way
 *
 * Five pass criteria, from the plan:
 *   1. sign-in with FabOrchestrator credentials succeeds
 *   2. the FO token is NOT in the response body — cookie only, and httpOnly
 *   3. a real question gets a real answer through the proxy
 *   4. the answer arrives progressively, not in one block at the end
 *   5. signing out drops the FO cookie
 *
 * Needs the app running (`npm run build && npm start`) and the same
 * FABORCH_PROBE_* credentials the WP0 probes use.
 *
 * Run:  npx tsx scripts/e1-live-check.ts
 */

import fs from "node:fs";

process.loadEnvFile(".env");

const APP = process.env.E1_APP_URL ?? "http://localhost:3002";
const EMAIL = process.env.FABORCH_PROBE_EMAIL ?? "";
const PASSWORD = process.env.FABORCH_PROBE_PASSWORD ?? "";

if (!EMAIL || !PASSWORD) {
  console.error("Set FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}

const results: { id: string; criterion: string; verdict: string; detail: string }[] = [];
const record = (id: string, criterion: string, ok: boolean, detail: string) => {
  const verdict = ok ? "PASS" : "FAIL";
  results.push({ id, criterion, verdict, detail });
  console.log(`${id}  ${verdict}  ${criterion} — ${detail}`);
};

/** Pull one cookie's attributes out of a Set-Cookie header. */
function cookieLine(headers: Headers, name: string): string | null {
  const all = headers.getSetCookie?.() ?? [];
  return all.find((c) => c.startsWith(`${name}=`)) ?? null;
}

async function main() {
  console.log(`E1 against ${APP}\n`);

  // ── 1 & 2: sign in with FO credentials ────────────────────────────────────
  const login = await fetch(`${APP}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const loginText = await login.text();
  let loginBody: { token?: string; faborch?: boolean } = {};
  try {
    loginBody = JSON.parse(loginText);
  } catch {
    /* leave empty; the assertions below will fail informatively */
  }

  record(
    "1",
    "sign-in with FabOrchestrator credentials",
    login.status === 200 && !!loginBody.token && loginBody.faborch === true,
    `HTTP ${login.status}, faborch=${loginBody.faborch}`,
  );
  if (!loginBody.token) {
    finish();
    return;
  }

  const foCookie = cookieLine(login.headers, "faborch_token");
  const httpOnly = !!foCookie && /HttpOnly/i.test(foCookie);
  const tokenInBody = /"faborch_token"|Bearer /i.test(loginText) || loginText.includes("fo-");
  record(
    "2",
    "the FO token is httpOnly and absent from the body",
    httpOnly && !tokenInBody,
    httpOnly
      ? "Set-Cookie is HttpOnly; body carries only the PWA session"
      : `cookie missing or not HttpOnly: ${foCookie ?? "none"}`,
  );

  // Carry the cookie exactly as a browser would.
  const cookieHeader = (foCookie ?? "").split(";")[0]!;

  // ── 3 & 4: a real question, through the proxy, streaming ──────────────────
  const started = Date.now();
  const chat = await fetch(`${APP}/api/faborch/insight/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loginBody.token}`,
      cookie: cookieHeader,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "In one short sentence, what is FabOrchestrator?" }],
        },
      ],
    }),
  });

  if (!chat.ok || !chat.body) {
    record("3", "a question is answered through the proxy", false, `HTTP ${chat.status}: ${(await chat.text()).slice(0, 200)}`);
    finish();
    return;
  }

  const reader = chat.body.getReader();
  const decoder = new TextDecoder();
  const arrivals: number[] = [];
  let answer = "";
  let deltas = 0;
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivals.push(Date.now() - started);
    raw += decoder.decode(value, { stream: true });
    for (const m of raw.matchAll(/"type":"text-delta"[^}]*"delta":"((?:[^"\\]|\\.)*)"/g)) {
      // count only; the text is reassembled below from the full buffer
      void m;
    }
    deltas = [...raw.matchAll(/"type":"text-delta"/g)].length;
    if (deltas >= 15) break; // enough evidence; do not spend a whole answer
  }
  reader.cancel().catch(() => {});
  for (const m of raw.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)) {
    answer += JSON.parse(`"${m[1]}"`);
  }

  record(
    "3",
    "a question is answered through the proxy",
    deltas > 0 && answer.trim().length > 0,
    `${deltas} text frames; answer begins: ${JSON.stringify(answer.slice(0, 70))}`,
  );

  const spread = arrivals.length > 1 ? arrivals[arrivals.length - 1]! - arrivals[0]! : 0;
  record(
    "4",
    "the answer arrives progressively, not in one block",
    arrivals.length >= 4 && spread > 300,
    `${arrivals.length} network arrivals over ${spread} ms, first at ${arrivals[0]} ms`,
  );

  // ── 5: sign out drops the FO cookie ───────────────────────────────────────
  const out = await fetch(`${APP}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginBody.token}`, cookie: cookieHeader },
  });
  const cleared = cookieLine(out.headers, "faborch_token");
  record(
    "5",
    "signing out drops the FabOrchestrator cookie",
    !!cleared && /Max-Age=0/i.test(cleared),
    cleared ?? "no Set-Cookie on logout",
  );

  finish();
}

function finish() {
  const stamp = new Date().toISOString().slice(0, 10);
  const passed = results.filter((r) => r.verdict === "PASS").length;
  const lines = [
    `# E1 — end-to-end architecture check, ${stamp}`,
    ``,
    `App: \`${APP}\`  ·  FabOrchestrator: \`${process.env.FABORCH_BASE_URL ?? "unset"}\``,
    ``,
    `**${passed} of ${results.length} criteria passed.**`,
    ``,
    `| # | Criterion | Verdict | Evidence |`,
    `|---|---|---|---|`,
    ...results.map((r) => `| ${r.id} | ${r.criterion} | **${r.verdict}** | ${r.detail} |`),
    ``,
    `Generated by \`scripts/e1-live-check.ts\`. All five passing is the M1 / B1 gate:`,
    `a signed-in operator holding a live, streaming conversation with FabOrchestrator`,
    `through this app, with the platform credential never leaving the server.`,
  ];
  fs.mkdirSync("docs/probes", { recursive: true });
  const out = `docs/probes/${stamp}-e1-report.md`;
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`\n${passed}/${results.length} passed. Report written to ${out}`);
  if (passed !== results.length) process.exitCode = 1;
}

main();
