/**
 * Reports, against the real FabOrchestrator.
 *
 *  1. a normal authenticated user can list and open pinned dashboards
 *  2. no dashboard-management action is reachable through this app
 */
import fs from "node:fs";

const ROOT = "C:/Users/ATUL ANAND/OneDrive/Documentos/Desktop/AthenaTech/faborchestrator-pwa";
const env = Object.fromEntries(
  fs.readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
// `APP_URL` so Phase 5 can run this against the deployed app rather than a
// laptop. The default stays localhost, because that is what a developer wants.
const APP = process.env.APP_URL ?? "http://localhost:3002";
const FO = env.FABORCH_BASE_URL.replace(/\/$/, "");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── sign in through the PWA ────────────────────────────────────────────────
const login = await fetch(`${APP}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: env.FABORCH_PROBE_EMAIL, password: env.FABORCH_PROBE_PASSWORD }),
});
const cookies = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const { token } = await login.json();
const auth = { cookie: cookies, Authorization: `Bearer ${token}` };
console.log(`sign in: ${login.status}\n`);

// Is this account an admin? Ask FabOrchestrator directly, so the rest is read
// in the right light.
const access = await fetch(`${FO}/api/fabinsight/access`, {
  headers: { Authorization: `Bearer ${cookies.match(/faborch_token=([^;]+)/)?.[1] ?? ""}` },
});
const canCreate = access.ok ? (await access.json()).canCreateDashboards : "unknown";
console.log(`── this account: canCreateDashboards = ${canCreate}\n`);

// ── 1. a normal user can read ──────────────────────────────────────────────
console.log("── 1. a normal authenticated user can view pinned dashboards ──────");

const list = await fetch(`${APP}/api/faborch/reports`, { headers: auth });
const listBody = await list.json().catch(() => ({}));
ok("the reports list loads", list.status === 200, `HTTP ${list.status}`);
ok(
  "FabOrchestrator's own canManage is passed through",
  typeof listBody.canManage === "boolean",
  `canManage=${listBody.canManage}`,
);

const reports = listBody.reports ?? [];
console.log(`     ${reports.length} pinned report(s) visible to this account`);
for (const r of reports.slice(0, 5)) {
  console.log(`       · ${r.title}  (pinned by ${r.createdBy}, ${r.hasCache ? "has snapshot" : "no snapshot"})`);
}

if (reports.length > 0) {
  const one = await fetch(`${APP}/api/faborch/reports/${encodeURIComponent(reports[0].id)}`, { headers: auth });
  const body = await one.json().catch(() => ({}));
  ok("a pinned report opens", one.status === 200, `HTTP ${one.status}`);
  ok(
    "it carries the stored snapshot or says it has none",
    typeof body.html === "string" || body.html === null,
    body.html ? `${body.html.length} chars of HTML` : "no snapshot yet",
  );
} else {
  console.log("     (nothing pinned on this deployment — open-one not exercised live)");
}

// ── 2. no management action is reachable ───────────────────────────────────
console.log("\n── 2. no dashboard-management action is reachable through this app ─");

for (const [method, path] of [
  ["POST", "/api/faborch/reports"],
  ["DELETE", `/api/faborch/reports/${reports[0]?.id ?? "any"}`],
  ["POST", `/api/faborch/reports/${reports[0]?.id ?? "any"}/refresh`],
  ["PUT", `/api/faborch/reports/${reports[0]?.id ?? "any"}`],
]) {
  const res = await fetch(`${APP}${path}`, { method, headers: auth });
  // 405 = the handler does not exist. 404 = the route does not exist.
  ok(
    `${method} ${path.replace(reports[0]?.id ?? "any", "<id>")} is refused`,
    res.status === 404 || res.status === 405,
    `HTTP ${res.status}`,
  );
}

// And the thing that would be worst: reading must not have refreshed anything.
if (reports.length > 0) {
  const before = reports[0].refreshedAt;
  const again = await fetch(`${APP}/api/faborch/reports`, { headers: auth });
  const after = (await again.json()).reports?.[0]?.refreshedAt;
  ok(
    "reading a report did not overwrite the shared snapshot",
    before === after,
    `refreshedAt ${before} → ${after}`,
  );
}

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
