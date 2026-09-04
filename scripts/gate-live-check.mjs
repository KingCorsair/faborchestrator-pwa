/**
 * The session gate, against a running app.
 *
 * ── Why this exists and the unit tests are not enough (2026-09-04) ───────────
 * `__tests__/platform/route-gate.test.ts` calls `proxy()` directly, so it
 * proves the *decision* is right and can say nothing about whether Next ever
 * asks for it. The `matcher` in `proxy.ts` is the part that decides that, it is
 * a regular expression inside a string literal, and a single missing backslash
 * turns it into one that excludes almost every route — a fix that builds, type
 * checks, passes 295 tests and does nothing at all on the deployment.
 *
 * That is not hypothetical: it was written that way once during this change.
 * Only a request over the wire can catch it, so this script makes them.
 *
 * ── Run it against the thing you are about to show somebody ──────────────────
 *   node scripts/gate-live-check.mjs                     (localhost:3002)
 *   APP_URL=https://faborch-demo.fly.dev node scripts/gate-live-check.mjs
 *
 * Every request sets `redirect: "manual"`, because the interesting answer is
 * the 307 itself — following it would report the sign-in page and hide whether
 * a redirect happened at all.
 */
import fs from "node:fs";

const ROOT = "C:/Users/ATUL ANAND/OneDrive/Documentos/Desktop/AthenaTech/faborchestrator-pwa";
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

/** A navigation, as a browser makes one: no redirect following, no cache. */
const visit = (path, cookie) =>
  fetch(`${APP}${path}`, {
    redirect: "manual",
    headers: { accept: "text/html", ...(cookie ? { cookie } : {}) },
  });

/** The path a response redirects to, or null. */
const locationOf = (res) => {
  const raw = res.headers.get("location");
  if (!raw) return null;
  const url = new URL(raw, APP);
  return url.pathname + url.search;
};

console.log(`\nsession gate · ${APP}\n`);

/* ── 1. the reported defect ─────────────────────────────────────────────── */
console.log("── 1. a launch with no session never reaches the cockpit ──────────");

const cold = await visit("/");
ok("GET / with no cookie redirects", cold.status === 307 || cold.status === 302, `HTTP ${cold.status}`);
ok("…to /login", locationOf(cold) === "/login", `→ ${locationOf(cold)}`);
ok(
  "…and the bounce is not cacheable",
  /no-store/.test(cold.headers.get("cache-control") ?? ""),
  cold.headers.get("cache-control") ?? "(none)",
);

// The thing that must not be true: the cockpit's own markup coming back to
// somebody with no session. Read the body rather than trusting the status.
const coldBody = await cold.text();
ok(
  "…and no cockpit markup is in the response body",
  !/The Nucleus|orchestration/i.test(coldBody),
  `${coldBody.length} bytes`,
);

for (const path of ["/fabinsight", "/backend-agent", "/reports"]) {
  const res = await visit(path);
  ok(
    `GET ${path} with no cookie → /login, carrying its return path`,
    locationOf(res) === `/login?next=${encodeURIComponent(path)}`,
    `HTTP ${res.status} → ${locationOf(res)}`,
  );
}

/* ── 2. the matcher actually covers what it claims ──────────────────────── */
console.log("\n── 2. the gate runs, and only where it should ─────────────────────");

// The canaries for a broken `matcher`. A 307 on any of these breaks install or
// the service worker, and a 307 on none of them while `/` also passes through
// is the shape the missing-backslash bug had.
for (const asset of ["/manifest.webmanifest", "/sw.js", "/icon-192.png"]) {
  const res = await visit(asset);
  ok(`${asset} is served, not redirected`, res.status === 200, `HTTP ${res.status}`);
}

for (const path of ["/login", "/offline", "/diagnostics"]) {
  const res = await visit(path);
  ok(`${path} is public`, res.status === 200, `HTTP ${res.status}`);
}

/* ── 3. no redirect loop ────────────────────────────────────────────────── */
console.log("\n── 3. no loop between / and /login ────────────────────────────────");

let hops = 0;
let at = "/";
while (hops < 10) {
  const res = await visit(at);
  const next = locationOf(res);
  if (!next) break;
  at = next;
  hops += 1;
}
ok("a session-less visit to / settles in one hop", hops === 1, `${hops} hop(s), ended at ${at}`);
ok("…on the sign-in page", at === "/login", at);

/* ── 4. sign in, then the reported sequence end to end ──────────────────── */
console.log("\n── 4. sign in → cockpit → sign out → cold launch ──────────────────");

const login = await fetch(`${APP}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: env.FABORCH_PROBE_EMAIL,
    password: env.FABORCH_PROBE_PASSWORD,
  }),
});
const setCookies = login.headers.getSetCookie?.() ?? [];
const jar = setCookies.map((c) => c.split(";")[0]).join("; ");
const { token } = await login.json().catch(() => ({}));
ok("sign-in succeeds", login.status === 200, `HTTP ${login.status}`);

const cockpit = await visit("/", jar);
const cockpitBody = await cockpit.text();
ok("a signed-in operator gets the cockpit", cockpit.status === 200, `HTTP ${cockpit.status}`);
ok("…and it is the real one", /The Nucleus/.test(cockpitBody), `${cockpitBody.length} bytes`);

for (const path of ["/fabinsight", "/backend-agent", "/reports"]) {
  const res = await visit(path, jar);
  ok(`…and ${path} opens`, res.status === 200, `HTTP ${res.status}`);
}

const signOut = await fetch(`${APP}/api/auth/logout`, {
  method: "POST",
  headers: { cookie: jar, Authorization: `Bearer ${token}` },
});
const cleared = (signOut.headers.getSetCookie?.() ?? []).join(" | ");
ok("sign-out succeeds", signOut.status === 200, `HTTP ${signOut.status}`);
ok(
  "…and clears the cookie the gate reads",
  /faborch_token=(;|\s|$)/.test(cleared) && /Max-Age=0/i.test(cleared),
  cleared || "(no Set-Cookie)",
);

// **The reported bug.** A force-quit and a Home Screen tap send exactly this:
// a fresh navigation to start_url with an empty cookie jar.
const relaunch = await visit("/");
const relaunchBody = await relaunch.text();
ok(
  "cold launch after sign-out redirects to sign-in",
  locationOf(relaunch) === "/login",
  `HTTP ${relaunch.status} → ${locationOf(relaunch)}`,
);
ok(
  "…and never paints a cockpit on the way",
  !/The Nucleus/.test(relaunchBody),
  `${relaunchBody.length} bytes`,
);

/* ── 5. the boundary underneath, which was never the problem ────────────── */
console.log("\n── 5. the API still refuses the revoked session ───────────────────");

const staleMe = await fetch(`${APP}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
ok("the old bearer token alone authenticates nothing", staleMe.status === 401, `HTTP ${staleMe.status}`);

/**
 * **The replay.** Both halves of a signed-out session, sent together — the
 * bearer from `localStorage` and a copy of the FO cookie taken before it was
 * cleared. This is stronger than anything the reported sequence produces, since
 * a signed-out browser no longer holds the cookie at all, and it is the case
 * "an old FO token cannot restore access" actually asks about.
 *
 * It is asserted on the routes that reach FabOrchestrator, because they are the
 * ones that can answer it: FO was told to delete the session, so FO refuses,
 * and this app turns that into `faborch_session_expired` and drops the cookie —
 * which means a replay also repairs itself, and the next navigation meets the
 * gate with nothing to send.
 */
for (const path of ["/api/faborch/reports", "/api/faborch/insight/chat"]) {
  const res = await fetch(`${APP}${path}`, {
    method: path.endsWith("/chat") ? "POST" : "GET",
    headers: {
      cookie: jar,
      Authorization: `Bearer ${token}`,
      ...(path.endsWith("/chat") ? { "Content-Type": "application/json" } : {}),
    },
    ...(path.endsWith("/chat")
      ? { body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "." }] }] }) }
      : {}),
  });
  const body = await res.json().catch(() => ({}));
  ok(`a replayed revoked session cannot reach ${path}`, res.status === 401, `HTTP ${res.status}`);
  ok(
    `…and FabOrchestrator's own verdict is what says so`,
    body.code === "faborch_session_expired",
    body.code ?? "(no code)",
  );
  ok(
    `…and the stale cookie is dropped on the way out`,
    /faborch_token=(;|\s|$)/.test((res.headers.getSetCookie?.() ?? []).join(" ")),
    (res.headers.getSetCookie?.() ?? []).join(" | ") || "(none)",
  );
}

/**
 * The one place a replay is not refused, stated rather than asserted, because
 * it is a deliberate property and not a defect to be caught by a red line.
 *
 * `/api/auth/me` answers from the signed bearer alone and never asks FO — so a
 * replayed pair gets 200 back, containing the id, email, name and role that are
 * already inside the token the caller is holding. It reveals nothing they did
 * not bring with them and opens nothing: every route above still refuses.
 *
 * Making it ask FO would fix a leak of nothing at the cost of a real one.
 * `useSession` calls this route on every screen mount, and every authenticated
 * call to FabOrchestrator sets `last_activity_at = NOW()`, so the check would
 * be a keep-alive that silently defeats FO's 30-minute idle eviction and
 * corrupts its session audit — somebody else's compliance record. That trade is
 * recorded in `lib/auth.ts` and was refused before this change; nothing here
 * alters it.
 */
const replayedMe = await fetch(`${APP}/api/auth/me`, {
  headers: { cookie: jar, Authorization: `Bearer ${token}` },
});
console.log(
  `  NOTE  /api/auth/me answers HTTP ${replayedMe.status} to a replayed pair — local-only by design, see lib/auth.ts`,
);

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}
