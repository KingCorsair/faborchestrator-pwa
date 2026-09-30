/**
 * WP0 — FabOrchestrator surface probe. Read-only.
 *
 * Records what the deployed FabOrchestrator actually serves for the surfaces
 * the embedding work will open (`/chat`, `/reports`, `/settings`, `/home`) and
 * for the things that share the origin with them (manifest, service worker,
 * favicon, a 404). Every observation here feeds WP1 planning; none of it is
 * inferred from source.
 *
 * What it looks at, unauthenticated:
 *   - status, content-type, cache-control, ETag, Vary, Set-Cookie names,
 *     Location, X-Frame-Options, Content-Security-Policy for each path
 *   - the asset references inside each HTML surface (scripts, stylesheets,
 *     fonts, manifest, icons), whether any is an absolute URL, and whether the
 *     document links a manifest or declares apple-mobile-web-app tags
 *   - the cache headers on one JavaScript chunk, requested with compression
 *   - the CORS preflight answer on /api/chat from a foreign origin
 *   - the unauthenticated /api/auth/me error envelope
 *   - whether plain http redirects to https
 *
 * Then, signed in as the probe account:
 *   - /api/auth/me (role), /api/mcp/connections (count, status, tool count),
 *     /api/fabinsight/pinned (count), /api/fabinsight/access,
 *     /api/modeling-agent/access, /api/user/models
 *   and signs out again.
 *
 * Never prints the password or the session token. Makes no writes.
 *
 * Run:  node scripts/fo-surface-probe.mjs            (markdown on stdout)
 *       node scripts/fo-surface-probe.mjs --json     (JSON on stdout)
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
const BASE = (process.env.FABORCH_BASE_URL ?? env.FABORCH_BASE_URL ?? "").replace(/\/$/, "");
const EMAIL = env.FABORCH_PROBE_EMAIL ?? "";
const PASSWORD = env.FABORCH_PROBE_PASSWORD ?? "";
const JSON_OUT = process.argv.includes("--json");
if (!BASE) {
  console.error("FABORCH_BASE_URL missing");
  process.exit(1);
}

const INTERESTING = [
  "content-type",
  "cache-control",
  "etag",
  "vary",
  "location",
  "x-frame-options",
  "content-security-policy",
  "content-encoding",
  "content-length",
  "x-nextjs-cache",
  "x-nextjs-prerender",
  "server",
  "x-cache",
];

function pick(headers) {
  const out = {};
  for (const k of INTERESTING) {
    const v = headers.get(k);
    if (v) out[k] = v;
  }
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length) out["set-cookie-names"] = cookies.map((c) => c.split("=")[0]).join(", ");
  return out;
}

async function get(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", ...init });
  return res;
}

function assetsOf(html) {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const scripts = refs.filter((r) => r.endsWith(".js") || /\.js\?/.test(r));
  const styles = refs.filter((r) => r.endsWith(".css") || /\.css\?/.test(r));
  const fonts = refs.filter((r) => /\.(woff2?|ttf|otf)(\?|$)/.test(r));
  const absolute = refs.filter((r) => /^https?:\/\//.test(r));
  const nextStatic = refs.filter((r) => r.startsWith("/_next/"));
  return {
    scripts: scripts.length,
    styles: styles.length,
    fonts: fonts.length,
    nextStaticRefs: nextStatic.length,
    absoluteRefs: absolute,
    manifestLink: /<link[^>]*rel="manifest"/i.test(html),
    appleWebAppMeta: /apple-mobile-web-app/i.test(html),
    viewport: (html.match(/<meta name="viewport" content="([^"]*)"/i) ?? [])[1] ?? null,
    title: (html.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? null,
    firstScript: scripts[0] ?? null,
    bytes: html.length,
  };
}

const report = { base: BASE, at: new Date().toISOString(), surfaces: {}, extra: {}, signedIn: {} };

for (const p of [
  "/",
  "/chat",
  "/reports",
  "/settings",
  "/home",
  "/modeling-agent",
  "/manifest.webmanifest",
  "/sw.js",
  "/favicon.ico",
  "/wp0-does-not-exist",
]) {
  try {
    const res = await get(p);
    const entry = { status: res.status, headers: pick(res.headers) };
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 200 && ct.includes("text/html")) {
      entry.assets = assetsOf(await res.text());
    }
    report.surfaces[p] = entry;
  } catch (e) {
    report.surfaces[p] = { error: String(e) };
  }
}

// One chunk, compressed, as a browser would ask for it.
const firstScript = report.surfaces["/chat"]?.assets?.firstScript;
if (firstScript) {
  const res = await get(firstScript, { headers: { "accept-encoding": "gzip, br" } });
  report.extra.chunk = { path: firstScript, status: res.status, headers: pick(res.headers) };
}

// CORS preflight from a foreign origin.
{
  const res = await get("/api/chat", {
    method: "OPTIONS",
    headers: {
      origin: "https://faborch-demo.fly.dev",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  report.extra.corsPreflight = {
    status: res.status,
    allowOrigin: res.headers.get("access-control-allow-origin"),
    allow: res.headers.get("allow"),
    vary: res.headers.get("vary"),
  };
}

// Unauthenticated API shape.
{
  const res = await get("/api/auth/me");
  let body = null;
  try {
    body = await res.json();
  } catch {}
  report.extra.unauthenticatedMe = {
    status: res.status,
    errorType: body?.error?.type ?? null,
    envelope: body ? Object.keys(body).join(",") : null,
  };
}

// http → https?
try {
  const res = await fetch(BASE.replace(/^https:/, "http:") + "/chat", { redirect: "manual" });
  report.extra.plainHttp = { status: res.status, location: res.headers.get("location") };
} catch (e) {
  report.extra.plainHttp = { error: String(e) };
}

// Signed-in facts, then sign out.
if (EMAIL && PASSWORD) {
  const login = await get("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  report.signedIn.login = { status: login.status };
  if (login.ok) {
    const { token, expiresAt } = await login.json();
    const auth = { authorization: `Bearer ${token}` };
    report.signedIn.expiresAt = expiresAt;
    const me = await (await get("/api/auth/me", { headers: auth })).json();
    report.signedIn.role = me?.user?.role?.name ?? null;
    const conns = await (await get("/api/mcp/connections", { headers: auth })).json();
    report.signedIn.mcpConnections = Array.isArray(conns)
      ? conns.map((c) => ({
          name: c.name,
          status: c.status,
          tools: Array.isArray(c.availableTools) ? c.availableTools.length : null,
        }))
      : "not-an-array";
    const pinned = await (await get("/api/fabinsight/pinned", { headers: auth })).json();
    report.signedIn.pinnedReports = {
      count: Array.isArray(pinned?.dashboards) ? pinned.dashboards.length : null,
      canManage: pinned?.canManage ?? null,
    };
    report.signedIn.fabinsightAccess = await (await get("/api/fabinsight/access", { headers: auth })).json();
    report.signedIn.modelingAccess = await (await get("/api/modeling-agent/access", { headers: auth })).json();
    const models = await (await get("/api/user/models", { headers: auth })).json();
    report.signedIn.models = { default: models?.defaultModel, ids: (models?.models ?? []).map((m) => m.id) };
    const out = await get("/api/auth/logout", { method: "POST", headers: auth });
    report.signedIn.logout = { status: out.status };
  }
} else {
  report.signedIn = { skipped: "no probe credentials in .env" };
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// Markdown.
const lines = [];
lines.push(`# FabOrchestrator surface probe — ${report.at}`);
lines.push(`Target: \`${BASE}\``);
lines.push("");
lines.push("## Surfaces (unauthenticated)");
lines.push("| Path | Status | Content-Type | Cache-Control | Frame / CSP | Cookies set | Notes |");
lines.push("|---|---|---|---|---|---|---|");
for (const [p, e] of Object.entries(report.surfaces)) {
  if (e.error) {
    lines.push(`| \`${p}\` | error | | | | | ${e.error} |`);
    continue;
  }
  const h = e.headers;
  const frame = [h["x-frame-options"] ? `XFO=${h["x-frame-options"]}` : "no XFO", h["content-security-policy"] ? "CSP set" : "no CSP"].join(", ");
  const notes = [];
  if (e.assets) {
    notes.push(`${e.assets.scripts} js, ${e.assets.styles} css, ${e.assets.fonts} fonts, ${e.assets.nextStaticRefs} /_next refs`);
    notes.push(e.assets.absoluteRefs.length ? `ABSOLUTE: ${e.assets.absoluteRefs.join(" ")}` : "no absolute asset URLs");
    notes.push(e.assets.manifestLink ? "manifest link" : "no manifest link");
    notes.push(e.assets.appleWebAppMeta ? "apple-web-app meta" : "no apple-web-app meta");
    if (e.assets.viewport) notes.push(`viewport: ${e.assets.viewport}`);
  }
  if (h.location) notes.push(`Location: ${h.location}`);
  lines.push(`| \`${p}\` | ${e.status} | ${(h["content-type"] ?? "").split(";")[0]} | ${h["cache-control"] ?? ""} | ${frame} | ${h["set-cookie-names"] ?? "none"} | ${notes.join("; ")} |`);
}
lines.push("");
lines.push("## Chunk, CORS, API envelope, plain http");
if (report.extra.chunk) {
  const c = report.extra.chunk;
  lines.push(`- Chunk \`${c.path}\`: ${c.status}; cache-control \`${c.headers["cache-control"] ?? ""}\`; content-encoding \`${c.headers["content-encoding"] ?? "none"}\`; length ${c.headers["content-length"] ?? "?"}`);
}
const cors = report.extra.corsPreflight;
lines.push(`- OPTIONS /api/chat from a foreign origin: ${cors.status}; Access-Control-Allow-Origin: ${cors.allowOrigin ?? "absent"}; Allow: ${cors.allow ?? "absent"}`);
const me = report.extra.unauthenticatedMe;
lines.push(`- GET /api/auth/me without a token: ${me.status}; error.type \`${me.errorType ?? "none"}\`; keys \`${me.envelope ?? "none"}\``);
const ph = report.extra.plainHttp;
lines.push(`- Plain http → ${ph.status ?? ph.error} ${ph.location ? `→ ${ph.location}` : ""}`);
lines.push("");
lines.push("## Signed in as the probe account");
const s = report.signedIn;
if (s.skipped) lines.push(`- skipped: ${s.skipped}`);
else {
  lines.push(`- login ${s.login.status}; session expires ${s.expiresAt}; role \`${s.role}\``);
  if (Array.isArray(s.mcpConnections)) {
    lines.push(`- MCP connections: ${s.mcpConnections.length}`);
    for (const c of s.mcpConnections) lines.push(`  - ${c.name}: ${c.status}, ${c.tools} tools`);
  } else lines.push(`- MCP connections: ${s.mcpConnections}`);
  lines.push(`- pinned reports: ${s.pinnedReports.count} (canManage ${s.pinnedReports.canManage})`);
  lines.push(`- fabinsight access: ${JSON.stringify(s.fabinsightAccess)}; modeling access: ${JSON.stringify(s.modelingAccess)}`);
  lines.push(`- models: default ${s.models.default}; ${s.models.ids.join(", ")}`);
  lines.push(`- logout ${s.logout?.status}`);
}
console.log(lines.join("\n"));
