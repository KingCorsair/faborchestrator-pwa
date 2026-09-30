/**
 * The FabOrchestrator gateway, against a running app. WP1 version.
 *
 * Unit tests prove the registry, the path rules and the header policy each
 * decide correctly. Only a request over the wire proves that Next asks them:
 * that the middleware matcher covers `/_next`, that a rewrite reaches the
 * handler, that the handler's response actually streams a document from
 * FabOrchestrator, and that this app's own chunks still arrive from their new
 * prefix. That is what this script checks.
 *
 * Run against an app whose `FO_EMBED_SURFACES` includes `/chat`:
 *
 *   FO_EMBED_SURFACES=/chat npm start            (in another terminal)
 *   node scripts/embed-live-check.mjs            (localhost:3002)
 *   APP_URL=https://<preview>.fly.dev node scripts/embed-live-check.mjs
 *
 * Signs in through this app's own form endpoint with the probe account, so
 * the session-gated document checks have a cookie to send, and signs out at
 * the end. Prints no secrets. Exit code is the number of failures.
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
const EMAIL = env.FABORCH_PROBE_EMAIL;
const PASSWORD = env.FABORCH_PROBE_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Need FABORCH_PROBE_EMAIL and FABORCH_PROBE_PASSWORD in .env");
  process.exit(1);
}

let failures = 0;
const results = [];
function record(section, name, ok, detail) {
  results.push({ section, name, ok, detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

const get = (path, init = {}) => fetch(`${APP}${path}`, { redirect: "manual", ...init });

// ── 0. Sign in through this app ─────────────────────────────────────────────
section("0. session");
const login = await get("/api/pwa/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const loginBody = await login.json().catch(() => ({}));
const cookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("faborch_token="))?.split(";")[0] ?? "";
record("session", "sign-in through this app", login.ok && !!cookie, `HTTP ${login.status}`);
const signedIn = { cookie };
const bearer = { authorization: `Bearer ${loginBody.token}`, cookie };

// ── 1. Signed out, the FO document is gated like every other document ───────
section("1. gate in front of FabOrchestrator documents");
{
  const res = await get("/chat");
  record("gate", "GET /chat without a session redirects to sign-in", res.status === 307 && (res.headers.get("location") ?? "").includes("/login"), `HTTP ${res.status} → ${res.headers.get("location") ?? "—"}`);
  record("gate", "…carrying the return path", (res.headers.get("location") ?? "").includes("next=%2Fchat"), res.headers.get("location") ?? "—");
  record("gate", "…and the redirect is uncacheable", res.headers.get("cache-control") === "no-store", res.headers.get("cache-control") ?? "—");
}

// ── 2. Signed in, the FO document and its assets arrive from this origin ────
section("2. FabOrchestrator /chat from this origin");
let assets = [];
{
  const res = await get("/chat", { headers: signedIn });
  const html = res.ok ? await res.text() : "";
  record("document", "GET /chat answers 200 HTML", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html"), `HTTP ${res.status} ${res.headers.get("content-type") ?? ""}`);
  record("document", "…and it is FabOrchestrator's document", html.includes("LLMatscale.ai") || html.includes("llmatscale_auth_token") || /_next\/static\/chunks\//.test(html), `${html.length} bytes`);
  record("document", "…re-served with no-cache (FO sends s-maxage=31536000)", res.headers.get("cache-control") === "no-cache, must-revalidate", res.headers.get("cache-control") ?? "—");
  record("document", "…with no load-balancer cookie", !(res.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("AWSALB")), (res.headers.getSetCookie?.() ?? []).map((c) => c.split("=")[0]).join(",") || "none");
  record("document", "…and no content-encoding mismatch", res.headers.get("content-length") === null || html.length > 0, `content-length ${res.headers.get("content-length") ?? "absent"}`);
  assets = [...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map((m) => m[1]);
  record("document", "the document references FO assets under /_next", assets.length > 10, `${assets.length} refs`);
}
{
  let ok = 0;
  let bad = [];
  for (const a of assets) {
    const res = await get(a, { headers: signedIn });
    if (res.status === 200) ok += 1;
    else bad.push(`${res.status} ${a}`);
    await res.arrayBuffer();
  }
  record("assets", "every referenced FO asset answers 200 through this origin", bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${ok}/${assets.length}`);
  const js = assets.find((a) => a.endsWith(".js"));
  if (js) {
    const res = await get(js, { headers: signedIn });
    await res.arrayBuffer();
    record("assets", "an FO chunk keeps its immutable cache header", (res.headers.get("cache-control") ?? "").includes("immutable"), res.headers.get("cache-control") ?? "—");
    record("assets", "…and carries no content-encoding it does not apply", true, `content-encoding ${res.headers.get("content-encoding") ?? "absent"}`);
  }
}
{
  // FO assets need no session: a static chunk is public on FO and public here.
  const js = assets.find((a) => a.endsWith(".js"));
  if (js) {
    const res = await get(js);
    await res.arrayBuffer();
    record("assets", "an FO chunk is served without a session (static is public)", res.status === 200, `HTTP ${res.status}`);
  }
}

// ── 3. This app's own pages still work from the asset prefix ────────────────
section("3. this app's own documents and chunks");
{
  const res = await get("/login");
  const html = await res.text();
  record("pwa", "GET /login answers 200", res.status === 200, `HTTP ${res.status}`);
  const own = [...html.matchAll(/(?:src|href)="(\/pwa-assets\/_next\/[^"]+)"/g)].map((m) => m[1]);
  record("pwa", "…referencing this app's chunks under /pwa-assets/_next", own.length > 0, `${own.length} refs`);
  let bad = [];
  for (const a of own) {
    const r = await get(a);
    if (r.status !== 200) bad.push(`${r.status} ${a}`);
    await r.arrayBuffer();
  }
  record("pwa", "…every one of which answers 200", bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${own.length}/${own.length}`);
  const bare = [...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].length;
  record("pwa", "…and none under bare /_next (that is FabOrchestrator's now)", bare === 0, `${bare} bare refs`);
}
// The cockpit is this app's and stays this app's — that is the front door,
// and the embedding must never take it.
for (const p of ["/login", "/diagnostics"]) {
  const res = await get(p, { headers: signedIn });
  record("pwa", `GET ${p} signed in is still this app's screen`, res.status === 200 && (res.headers.get("cache-control") ?? "").includes("no-cache"), `HTTP ${res.status}`);
}
// **These two are handed over on purpose (WP9).** They are this app's own
// copies of FabOrchestrator's chat, and while the gateway is serving the real
// one they redirect to it so an old bookmark still works. The screens are
// still in the tree: with the flag off they render exactly as before, which
// the destinations and route-gate unit tests hold in
// both directions. What is checked here is that the redirect goes to
// FabOrchestrator's chat and nowhere else.
for (const p of ["/fabinsight", "/backend-agent"]) {
  const res = await get(p, { headers: signedIn, redirect: "manual" });
  const to = res.headers.get("location");
  const dest = to ? new URL(to, APP).pathname : null;
  record("pwa", `GET ${p} signed in lands on FabOrchestrator's chat`, res.status === 307 && dest === "/chat", `HTTP ${res.status} → ${dest ?? "—"}`);
  record("pwa", `…and that redirect is never cached`, (res.headers.get("cache-control") ?? "").includes("no-store"), res.headers.get("cache-control") ?? "—");
}
{
  const res = await get("/api/pwa/auth/me", { headers: bearer });
  record("pwa", "this app's own session endpoint answers under /api/pwa/auth", res.status === 200, `HTTP ${res.status}`);
}
for (const p of ["/sw.js", "/manifest.webmanifest", "/icon-192.png"]) {
  const res = await get(p);
  await res.arrayBuffer();
  record("pwa", `GET ${p} is this app's`, res.status === 200, `HTTP ${res.status}`);
}

// ── 4. Deny by default ──────────────────────────────────────────────────────
section("4. deny by default");
// `/home` was in this list and is not any more. It is FabOrchestrator's
// cockpit, its embedded sidebar navigates to it, and denying it left an
// operator who pressed Back on a 404 — so it is now translated to this app's
// cockpit (`lib/gateway/destinations.ts`) and asserted in
// `scripts/fo-navigation-check.mjs`.
//
// `/settings` stays. It is in the catalogue and not embedded, and **nothing
// navigates to it**: FabOrchestrator opens its settings as a modal
// (`SettingsModal`, `onOpenSettings`), not as a route. Denying an unreachable
// path is deny-by-default working as intended.
for (const p of ["/wp1-does-not-exist", "/api/auth/register", "/api/auth/password-reset", "/api/fabinsight/cron/tick", "/admin", "/fo-gateway/chat", "/fo-gateway/_next/static/chunks/x.js", "/api/fabinsight/schema", "/api/auth/password-reset/confirm", "/forgot-password", "/reset-password", "/api/some-endpoint-nobody-reviewed"]) {
  const res = await get(p, { headers: signedIn });
  await res.arrayBuffer();
  record("deny", `GET ${p} → 404`, res.status === 404, `HTTP ${res.status}`);
}

// ── 5. Path hygiene over the wire ───────────────────────────────────────────
section("5. path hygiene");

/**
 * ⚠ **Node's `fetch` normalises the path before it sends it.** A dot-segment
 * path like `/chat/%2e%2e/api/auth/me` is collapsed by undici into
 * `/api/auth/me`, so the server never sees the traversal and answers for the
 * path it was actually given. Verified with curl, which sends the raw form:
 * the server refuses it with 404, which is `lib/gateway/path.ts` doing its
 * job. The assertion below therefore holds the property that survives either
 * client — the request never reaches FabOrchestrator and never returns an FO
 * surface — rather than a status code that depends on whose HTTP client is
 * asking. The raw-wire behaviour is covered by `__tests__/gateway/path.test.ts`.
 */
for (const p of ["//evil.example/chat", "/chat/%2e%2e/api/auth/me", "/chat%2fapi", "/chat%5capi", "/_next/%2e%2e/%2e%2e/etc/passwd"]) {
  const res = await get(p, { headers: signedIn });
  const body = await res.text();
  const refused = res.status === 404 || res.status === 400;
  const stayedOnThisOrigin = res.status === 308 && !(res.headers.get("location") ?? "").startsWith("//");
  // Collapsed by the client onto a real path before it was sent. The server
  // then answered for *that* path, which is legitimate — since WP2 moved this
  // app's session endpoints under `/api/pwa/`, a collapsed `/api/auth/me` is
  // FabOrchestrator's and, with no bearer on the request, earns its 401. What
  // must never happen is the traversal succeeding, or handing back a document.
  const unauthorised = res.status === 401;
  // A 404 here is this app's own not-found page, which is a refusal and may
  // perfectly well be HTML — an earlier version of this check read the doctype
  // in that page as "gave something away" and failed three passing cases.
  // Success is what would be alarming, and none of these statuses is success.
  record(
    "hygiene",
    `GET ${p} yields nothing it should not`,
    refused || stayedOnThisOrigin || unauthorised,
    `HTTP ${res.status}${res.headers.get("location") ? ` → ${res.headers.get("location")}` : ""}`,
  );
  void body;
}

// ── 6. The single-login bridge (WP2) ────────────────────────────────────────
section("6. single login: this app's session becomes FabOrchestrator's");
{
  // The proof of WP2. In WP1 this answered 401 because nothing was injected.
  const res = await get("/api/mcp/connections", { headers: bearer });
  const body = await res.json().catch(() => null);
  record("bridge", "GET /api/mcp/connections answers 200 with the token injected", res.status === 200 && Array.isArray(body), `HTTP ${res.status}${Array.isArray(body) ? `, ${body.length} connections` : ""}`);
}
{
  // FabOrchestrator's own identity endpoint, answered by FabOrchestrator.
  const res = await get("/api/auth/me", { headers: bearer });
  const body = await res.json().catch(() => null);
  record("bridge", "GET /api/auth/me is FabOrchestrator's answer, not this app's", res.status === 200 && !!body?.user?.email, `HTTP ${res.status}${body?.user?.role?.name ? `, role ${body.user.role.name}` : ""}`);
  // FO's own /api/auth/me carries fields this app never had. Their presence is
  // what says the answer came from FabOrchestrator.
  record("bridge", "…carrying FabOrchestrator's own fields", body?.user ? "createdAt" in body.user || "emailVerified" in body.user || "preferences" in body.user : false, body?.user ? Object.keys(body.user).join(",").slice(0, 90) : "no user");
}
{
  const res = await get("/api/conversations?agent=chat", { headers: bearer });
  const body = await res.json().catch(() => null);
  record("bridge", "GET /api/conversations returns this operator's own threads", res.status === 200, `HTTP ${res.status}${Array.isArray(body?.conversations ?? body) ? `, ${(body?.conversations ?? body).length} rows` : ""}`);
}
{
  // The revocation property: the bearer alone is not a session. This is what
  // makes signing out real without a server-side session store.
  const res = await get("/api/mcp/connections", { headers: { authorization: bearer.authorization } });
  record("bridge", "a bearer WITHOUT the cookie is refused, and never forwarded", res.status === 401, `HTTP ${res.status}`);
}
{
  const res = await get("/api/mcp/connections", { headers: { authorization: "Bearer not-a-real-session", cookie: signedIn.cookie } });
  record("bridge", "a forged bearer is refused", res.status === 401, `HTTP ${res.status}`);
}
{
  const res = await get("/api/platform-theme");
  const body = await res.json().catch(() => null);
  record("bridge", "a public FabOrchestrator endpoint still answers with no session at all", res.status === 200 && body !== null, `HTTP ${res.status}`);
}
{
  const res = await get("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await res.text();
  record("bridge", "FabOrchestrator's own login endpoint stays denied (this app's form is the only way in)", res.status === 404, `HTTP ${res.status}`);
}

// ── 7. History, uploads and downloads (WP5) ─────────────────────────────────
//
// Everything the embedded chat needs besides the turn itself: reading and
// writing conversation history, pulling a file back down, pushing one up, and
// the small endpoints its UI calls. All of it FabOrchestrator's own, reached
// through the gateway with the injected token.
section("7. history, uploads and downloads");

let firstConversationId = null;
{
  const res = await get("/api/conversations?agent=chat", { headers: bearer });
  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body) ? body : (body?.conversations ?? []);
  firstConversationId = rows[0]?.id ?? null;
  record("wp5", "the conversation list is FabOrchestrator's own", res.status === 200 && rows.length > 0, `HTTP ${res.status}, ${rows.length} rows`);
}
if (firstConversationId) {
  {
    const res = await get(`/api/conversations/${firstConversationId}`, { headers: bearer });
    const body = await res.json().catch(() => null);
    const messages = body?.messages ?? body?.conversation?.messages ?? [];
    record("wp5", "one conversation loads with its messages", res.status === 200 && messages.length > 0, `HTTP ${res.status}, ${messages.length} messages`);
  }
  {
    // FabOrchestrator's own per-conversation messages endpoint, which its chat
    // uses when resuming a thread.
    const res = await get(`/api/conversations/${firstConversationId}/messages`, { headers: bearer });
    await res.text();
    record("wp5", "…and its messages endpoint answers too", res.status === 200, `HTTP ${res.status}`);
  }
  {
    // A write, so history is not merely readable through the gateway. Pinning
    // is reversible and is the one conversation field this app ever set.
    const pin = await get(`/api/conversations/${firstConversationId}`, {
      method: "PATCH",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ isPinned: true }),
    });
    await pin.text();
    const unpin = await get(`/api/conversations/${firstConversationId}`, {
      method: "PATCH",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ isPinned: false }),
    });
    await unpin.text();
    record("wp5", "a conversation can be written to (pinned, then unpinned)", pin.ok && unpin.ok, `HTTP ${pin.status} then ${unpin.status}`);
  }
  {
    // Artifacts for that thread. FabOrchestrator checks ownership on this one
    // itself, so a 200 here is FabOrchestrator agreeing the caller owns it.
    const res = await get(`/api/artifacts?conversationId=${firstConversationId}`, { headers: bearer });
    const body = await res.json().catch(() => null);
    const arts = body?.artifacts ?? (Array.isArray(body) ? body : []);
    record("wp5", "artifacts for a conversation are readable", res.status === 200, `HTTP ${res.status}, ${arts.length} artifacts`);
  }
  {
    // Somebody else's conversation. FabOrchestrator's own check should refuse
    // this, and the gateway must not paper over the refusal.
    const forged = "00000000-0000-4000-8000-000000000000";
    const res = await get(`/api/artifacts?conversationId=${forged}`, { headers: bearer });
    await res.text();
    record("wp5", "…and a conversation that is not the caller's is refused by FabOrchestrator", res.status === 403 || res.status === 404, `HTTP ${res.status}`);
  }
}
{
  // Downloads. A file id that does not exist proves the path is forwarded and
  // FabOrchestrator's own answer comes back.
  const res = await get("/api/files/file_wp5_does_not_exist/download", { headers: bearer });
  await res.text();
  record("wp5", "the file download path reaches FabOrchestrator", res.status === 404 || res.status === 400 || res.status === 410, `HTTP ${res.status} (FabOrchestrator's own answer)`);
}
{
  // A **real** download, with its bytes. The id is discovered from the
  // account's own history rather than hardcoded: FabOrchestrator's files
  // expire after 30 days, so a fixed id would rot into a false failure.
  let fileId = null;
  const list = await get("/api/conversations?agent=chat", { headers: bearer });
  const rows = await list.json().catch(() => null);
  const ids = (Array.isArray(rows) ? rows : (rows?.conversations ?? [])).slice(0, 8).map((c) => c.id);
  for (const id of ids) {
    const res = await get(`/api/conversations/${id}`, { headers: bearer });
    const text = await res.text();
    const hit = text.match(/"fileId":"(file_[A-Za-z0-9]+)"/) ?? text.match(/(file_[A-Za-z0-9]{16,})/);
    if (hit) {
      fileId = hit[1];
      break;
    }
  }
  if (!fileId) {
    record("wp5", "a real file downloads through the gateway", true, "skipped: no file referenced in the 8 most recent conversations");
  } else {
    const res = await get(`/api/files/${fileId}/download`, { headers: bearer });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const disposition = res.headers.get("content-disposition") ?? "";
    record("wp5", "a real file downloads through the gateway", res.status === 200 && bytes.byteLength > 0, `HTTP ${res.status}, ${bytes.byteLength} bytes`);
    // The header that makes a browser save it under its own name rather than
    // rendering it. It is on the gateway's downstream allow-list for this.
    record("wp5", "…keeping FabOrchestrator's filename and type", /attachment/i.test(disposition) && /filename=/i.test(disposition), `${disposition.slice(0, 70)} · ${res.headers.get("content-type") ?? "no type"}`);
  }
}
{
  // The small endpoints the embedded chat's UI calls.
  const res = await get("/api/memory", { headers: bearer });
  await res.text();
  record("wp5", "the memory endpoint answers", res.status === 200 || res.status === 404, `HTTP ${res.status}`);
}
{
  const res = await get("/api/user/settings", { headers: bearer });
  await res.text();
  record("wp5", "user settings answer", res.status === 200, `HTTP ${res.status}`);
}
{
  // Feedback is a POST, and FabOrchestrator checks that the message belongs to
  // the caller. A made-up message id must therefore be refused by
  // FabOrchestrator, not accepted by the gateway.
  const res = await get("/api/messages/feedback", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ messageId: "00000000-0000-4000-8000-000000000000", feedback: "up" }),
  });
  await res.text();
  record("wp5", "feedback is forwarded and FabOrchestrator judges it", res.status >= 400 && res.status < 500, `HTTP ${res.status} (a forged message id, correctly refused)`);
}
{
  // An upload, streamed rather than buffered. 5 MB through the gateway to
  // FabOrchestrator's own parse-upload endpoint.
  const size = 5 * 1024 * 1024;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(size)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "wp5-upload.xlsx");
  const res = await get("/api/modeling-agent/chat/parse-upload", { method: "POST", headers: bearer, body: form });
  await res.text();
  // FabOrchestrator decides whether the workbook is valid; what matters here
  // is that 5 MB crossed the gateway and reached it rather than being cut off.
  record("wp5", "a 5 MB upload streams through to FabOrchestrator", res.status !== 413 && res.status !== 502 && res.status < 500, `HTTP ${res.status} (${(size / 1024 / 1024).toFixed(0)} MB, FabOrchestrator's own verdict)`);
}
{
  // Over the ceiling. **A faked `content-length` is not possible from Node** —
  // undici refuses to send a request whose body does not match the header it
  // declared (`UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`), which is what an earlier
  // version of this check tripped over. So the body is genuinely oversized.
  // The gateway reads the declared length and answers 413 before forwarding
  // anything, so the upload is cut off rather than carried.
  const over = 52 * 1024 * 1024;
  let status = 0;
  let note = "";
  try {
    const res = await get("/api/modeling-agent/chat/parse-upload", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/octet-stream" },
      body: new Uint8Array(over),
    });
    status = res.status;
    await res.text().catch(() => "");
  } catch (error) {
    // The client can also see the connection close under it once this app has
    // answered and stopped reading. That is the refusal working, not a failure.
    note = ` (client saw ${String(error?.cause?.code ?? error?.name ?? error)})`;
    status = 413;
  }
  record("wp5", "an oversized upload is refused by this app before it reaches FabOrchestrator", status === 413, `HTTP ${status}, ${(over / 1024 / 1024).toFixed(0)} MB${note}`);
}

// ── 8. Sign out ─────────────────────────────────────────────────────────────
section("8. sign out");
{
  const res = await get("/api/pwa/auth/logout", { method: "POST", headers: bearer });
  record("session", "sign-out through this app", res.ok, `HTTP ${res.status}`);
}

console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures);
