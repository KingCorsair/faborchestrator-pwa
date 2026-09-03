/**
 * Phase 5 security review, run against the deployed app.
 *
 * Reading the source tells you what was intended. This asks the running
 * deployment what it actually does, which is the only thing an operator is
 * exposed to. Every check states what it would mean if it failed, because a
 * red line with no consequence attached does not get acted on.
 *
 *   APP_URL=https://faborch-demo.fly.dev node scripts/security-review.mjs
 */
import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = (process.env.APP_URL ?? "https://faborch-demo.fly.dev").replace(/\/$/, "");
// `fileURLToPath`, not `.pathname`: a Windows path with a space in it comes
// back percent-encoded otherwise, and every read fails on a machine whose user
// directory has one — which this project's does.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const env = Object.fromEntries(
  fs.readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);

const results = [];
const check = (area, name, pass, detail = "", risk = "") => {
  results.push({ area, name, pass, risk });
  console.log(`  ${pass ? "PASS" : "FAIL"}  [${area}] ${name}${detail ? "  — " + detail : ""}`);
  if (!pass && risk) console.log(`        risk: ${risk}`);
};

console.log(`Security review of ${APP}\n`);

/* ── 1. Transport ─────────────────────────────────────────────────────────── */

const httpsHead = await fetch(APP, { redirect: "manual" });
check("transport", "https serves the app", httpsHead.status === 200 || httpsHead.status === 307,
  `HTTP ${httpsHead.status}`);

try {
  const plain = await fetch(APP.replace("https://", "http://"), { redirect: "manual" });
  check("transport", "plain http redirects to https",
    plain.status >= 300 && plain.status < 400 &&
      (plain.headers.get("location") ?? "").startsWith("https://"),
    `${plain.status} → ${plain.headers.get("location")}`,
    "credentials and plant data would travel in clear text");
} catch (e) {
  check("transport", "plain http redirects to https", false, String(e).slice(0, 60),
    "credentials and plant data would travel in clear text");
}

/* ── 2. Session cookie ────────────────────────────────────────────────────── */

const login = await fetch(`${APP}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: env.FABORCH_PROBE_EMAIL, password: env.FABORCH_PROBE_PASSWORD }),
});
const setCookies = login.headers.getSetCookie?.() ?? [];
const foCookie = setCookies.find((c) => c.startsWith("faborch_token="));
const loginBody = await login.text();
const { token } = JSON.parse(loginBody || "{}");

check("session", "sign-in succeeds", login.status === 200 && !!token, `HTTP ${login.status}`);
check("session", "the FabOrchestrator token is httpOnly", /HttpOnly/i.test(foCookie ?? ""),
  "", "a script on the page could read the platform credential");
check("session", "it is Secure", /Secure/i.test(foCookie ?? ""),
  "", "the cookie would travel over plain http if the app were ever reached that way");
check("session", "it is SameSite", /SameSite/i.test(foCookie ?? ""),
  (foCookie ?? "").match(/SameSite=\w+/)?.[0] ?? "",
  "another site could cause authenticated requests");
// The FabOrchestrator credential lives in the httpOnly cookie only. If it also
// came back in the JSON, every protection on the cookie would be decorative.
const foTokenValue = (foCookie ?? "").split(";")[0].split("=")[1] ?? "";
check("session", "the FabOrchestrator token is not also in the response body",
  foTokenValue.length > 8 && !loginBody.includes(foTokenValue),
  "", "the platform credential would be readable by any script on the page");

/* ── 3. Authentication is required ────────────────────────────────────────── */

const guarded = [
  ["GET", "/api/auth/me"],
  ["GET", "/api/faborch/reports"],
  ["GET", "/api/faborch/reports/anything"],
  ["POST", "/api/faborch/insight/chat"],
  ["POST", "/api/faborch/backend/chat"],
];
for (const [method, path] of guarded) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "POST"
      ? { body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }) }
      : {}),
  });
  check("auth", `${method} ${path} refuses an anonymous caller`, res.status === 401,
    `HTTP ${res.status}`, "plant data would be readable without signing in");
}

/* ── 4. A bearer token alone is not a session ─────────────────────────────── */

const noCookie = await fetch(`${APP}/api/faborch/reports`, {
  headers: { Authorization: `Bearer ${token}` },
});
check("auth", "a stolen bearer token without the FO cookie is refused",
  noCookie.status === 401, `HTTP ${noCookie.status}`,
  "a token copied out of localStorage would be enough to impersonate someone");

const forged = await fetch(`${APP}/api/faborch/reports`, {
  headers: { Authorization: "Bearer eyJhbGciOiJub25lIn0.eyJpZCI6IngifQ.", cookie: foCookie?.split(";")[0] ?? "" },
});
check("auth", "a forged/unsigned token is refused", forged.status === 401, `HTTP ${forged.status}`,
  "anyone could mint a session");

/* ── 5. Admin surface is absent, not merely hidden ────────────────────────── */

const cookieHeader = (foCookie ?? "").split(";")[0];
const auth = { cookie: cookieHeader, Authorization: `Bearer ${token}` };
for (const [method, path] of [
  ["POST", "/api/faborch/reports"],
  ["DELETE", "/api/faborch/reports/x"],
  ["POST", "/api/faborch/reports/x/refresh"],
]) {
  const res = await fetch(`${APP}${path}`, { method, headers: auth });
  check("authz", `${method} ${path} does not exist`, res.status === 404 || res.status === 405,
    `HTTP ${res.status}`, "a non-admin could change what every other reader sees");
}

/* ── 6. Secrets are not in the bundle ─────────────────────────────────────── */

const html = await (await fetch(`${APP}/`)).text();
const leaks = [
  ["FABORCH_BASE_URL host", env.FABORCH_BASE_URL?.replace(/^https?:\/\//, "").split("/")[0]],
  ["probe password", env.FABORCH_PROBE_PASSWORD],
  ["signing secret", env.SESSION_SIGNING_SECRET],
].filter(([, v]) => v && v.length > 6);
for (const [label, value] of leaks) {
  check("secrets", `${label} is not in the served page`, !html.includes(value), "",
    "a server-side secret would be readable by anyone loading the app");
}

/* ── 7. The sandbox rule, in the shipped source ───────────────────────────── */

/**
 * Comments are stripped first.
 *
 * The first run of this review reported `reports.tsx` as unsafe. It was not:
 * the match was inside a comment **explaining that FabOrchestrator uses both
 * flags and that this app deliberately does not**. Documenting a hazard was
 * being read as committing it.
 *
 * A checker that cries wolf over its own documentation is worse than no
 * checker, because the next real finding gets waved through as "that comment
 * again".
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

for (const f of ["components/fab/artifact-sheet.tsx", "components/fab/screens/reports.tsx"]) {
  const code = stripComments(fs.readFileSync(`${ROOT}/${f}`, "utf8"));
  const sandboxes = code.match(/sandbox="[^"]*"/g) ?? [];
  check("sandbox", `${f} never pairs allow-scripts with allow-same-origin`,
    sandboxes.length > 0 && sandboxes.every((s) => !s.includes("allow-same-origin")),
    sandboxes.join(" ") || "no iframe",
    "the frame would take this app's origin and could read its cookies and DOM");
}

/* ── 8. No model key on this side of the boundary ─────────────────────────── */

let flySecrets = "";
try {
  flySecrets = execSync("flyctl secrets list --app faborch-demo", { encoding: "utf8" });
} catch { /* not signed in; reported below */ }
check("boundary", "no model API key is set on the deployment",
  flySecrets ? !/ANTHROPIC|OPENAI/i.test(flySecrets) : false,
  flySecrets ? flySecrets.trim().split("\n").length - 1 + " secret(s)" : "flyctl unavailable",
  "this app is specified to hold no model credential; one here would break that boundary");

/*
  Run with `cwd`, not `git -C "<path>"`.

  The first version embedded a path containing a space into a shell string; git
  failed to parse it, execSync swallowed the error, and the empty output was
  read as "no matches" — a **false pass** on a boundary check. A security review
  that reports success when its own command did not run is the most dangerous
  possible outcome, so this asserts the command actually worked.
*/
let repoGrep = null;
try {
  repoGrep = execSync('git grep -lE "@anthropic-ai|openai" -- "*.ts" "*.tsx"', {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
} catch (e) {
  // git grep exits 1 when it finds nothing, which is the good case here.
  repoGrep = e.status === 1 ? "" : null;
}
check("boundary", "no model SDK is imported anywhere in the app", repoGrep === "",
  repoGrep === null ? "CHECK DID NOT RUN" : repoGrep || "none",
  repoGrep === null
    ? "this check failed to execute and proves nothing"
    : "the app would be making its own model calls");

/* ── Summary ──────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  [${f.area}] ${f.name}\n      ${f.risk}`);
  process.exitCode = 1;
}
