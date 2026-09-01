/**
 * Render the real screens to standalone HTML for design review.
 *
 * These are the shipping components with the shipping compiled CSS and data
 * pulled from the running API — not a redrawing. A hand-rewritten mock would
 * review a prettier app than the one that exists, which is exactly the failure
 * mode this review is meant to catch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "@/components/fab/app-shell";
import { ActivityFeed } from "@/components/fab/screens/activity-feed";
import { AnalysisPanel } from "@/components/fab/screens/analysis-panel";
import { DecisionReview } from "@/components/fab/screens/decision-review";
import { Landing } from "@/components/fab/screens/landing";
import { OrderDetailScreen } from "@/components/fab/screens/order-detail";
import { OrderSearch } from "@/components/fab/screens/order-search";
import { ReviewPanel } from "@/components/fab/screens/review-panel";
import { LoginPage } from "@/components/login-page";
import type { OrderStatus } from "@/lib/mes/types";

// Run from the project root: `npx tsx --tsconfig design-review/tsconfig.json design-review/render.tsx <token>`
const ROOT = process.cwd();
const OUT = path.join(ROOT, "design-review/out");
const [, , TOKEN] = process.argv;
const API = "http://localhost:3002";

const noop = () => {};
const user = { id: "USR-DEMO-1", email: "supervisor@athenatech.example", name: "A. Anand", roleName: "Supervisor" };

async function api<T>(route: string): Promise<T> {
  const res = await fetch(`${API}${route}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${route} → ${res.status}`);
  return (await res.json()) as T;
}

/** The compiled bundle the app actually serves — tokens plus the used utilities. */
function compiledCss(): string {
  const dir = path.join(ROOT, ".next/static/chunks");
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".css") && fs.statSync(path.join(dir, f)).size > 10000);
  if (!file) throw new Error("no compiled CSS found — run `npm run build` first");
  const css = fs.readFileSync(path.join(dir, file), "utf8");
  // Drop next/font's @font-face block: it points at hashed .woff2 files under
  // .next/static/media that do not travel with these standalone pages, so every
  // rule in it 404s. The pages load Plus Jakarta Sans from Google Fonts instead.
  return css
    .split("\n")
    .filter((line) => !line.startsWith("@font-face"))
    .join("\n");
}

function page(title: string, label: string, body: React.ReactNode): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="./app.css" />
<style>
  /* next/font supplies this variable in the app; supply it here so the type is
     the product's Plus Jakarta Sans rather than a system fallback. */
  :root { --font-jakarta: "Plus Jakarta Sans", system-ui, sans-serif; }
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--font-jakarta); background: var(--page-surface, #f6f7fc); }
</style>
</head>
<body data-screen-label="${label}"><div id="root" style="min-height:100vh">${renderToStaticMarkup(body)}</div></body></html>`;
}

function shell(pathname: string, children: React.ReactNode) {
  (globalThis as Record<string, unknown>).__DESIGN_PATH = pathname;
  return (
    <AppShell user={user} token="demo" onRefresh={noop}>
      {children}
    </AppShell>
  );
}

async function main() {
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "app.css"), compiledCss());

// The landing page goes out **before** the API calls, because it is the only
// screen that reads nothing: no order, no session, no token. Rendering it first
// means `render.tsx` with no argument still produces something to look at, which
// matters when the thing you want to check is the app's front door.
//
// Wrapped in an explicit 100vh box: the page is vertically centred, and
// `min-h-full` is a percentage that resolves to nothing unless its parent has a
// definite height. In the app that comes from `html`/`body` carrying `h-full`.
// Both entry screens, as two files. Neither reads an order, a session or a
// token, so they render before the API calls and `render.tsx` with no argument
// still produces something to look at.
//
// Wrapped in an explicit 100vh box: both are vertically centred, and
// `min-h-full` is a percentage that resolves to nothing unless its parent has a
// definite height. In the app that comes from `html`/`body` carrying `h-full`.
// The landing page takes no data at all since 2026-08-23, when the indigo
// workflow card was removed from it. The property that matters is unchanged and
// now trivially true — both entry screens render with no token, which is why
// they go out before the API calls below.

for (const [file, label, body] of [
  ["00-landing.html", "Landing", <Landing key="landing" />],
  ["00-login.html", "Sign in", <LoginPage key="login" />],
] as [string, string, React.ReactNode][]) {
  fs.writeFileSync(
    path.join(OUT, file),
    page(`FabOrchestrator — ${label}`, label, <div style={{ height: "100vh" }}>{body}</div>),
  );
  console.log(`${file}  (no data required)`);
}

const orders = await api<{ orders: never[] }>("/api/orders/search");
const detail = await api<{ order: never; issues: never[]; source: string }>("/api/orders/PO-10382");
const activity = await api<{ activity: never[]; durable: boolean }>("/api/activity");
const decisions = await api<{ decisions: never[]; durable: boolean }>("/api/decisions");
// The real Explain flow, so the analysis panel is reviewed with a real
// analysis in it — grounding badge, citations and all.
const analysis = await fetch(`${API}/api/orders/PO-10382/explain`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}` },
})
  .then(async (res) => (res.ok ? ((await res.json()) as never) : null))
  .catch(() => null);
console.log(analysis ? "analysis: loaded" : "analysis: unavailable — panel renders idle");

// Thunks, not elements. `usePathname` is read during render, so building all
// four elements first and rendering afterwards would give every screen the
// pathname of the last one — and the nav highlight would be wrong in every
// screenshot.
const screens: [string, string, () => React.ReactNode][] = [
  [
    "01-orders.html",
    "Orders",
    () => shell(
      "/orders",
      <OrderSearch
        review={
          <ReviewPanel
            orders={orders.orders}
            selected=""
            onSelect={noop}
            state={{ status: "idle" }}
            onReview={noop}
            onOpenOrder={noop}
          />
        }
        orders={orders.orders}
        state="data"
        searchValue=""
        onSearchChange={noop}
        activeStatuses={new Set<OrderStatus>()}
        onToggleStatus={noop}
        onClearFilters={noop}
        onOpenOrder={noop}
        onRetry={noop}
        onScan={noop}
      />,
    ),
  ],
  [
    "02-order-detail.html",
    "Order detail",
    () => shell(
      "/orders",
      <OrderDetailScreen
        order={detail.order}
        issues={detail.issues}
        analysis={
          <AnalysisPanel
            issueCount={detail.issues.length}
            state={analysis ? "ready" : "idle"}
            result={analysis}
            onExplain={noop}
          />
        }
      />,
    ),
  ],
  [
    "03-decisions.html",
    "Decisions",
    () => shell(
      "/decisions",
      <DecisionReview
        decisions={decisions.decisions}
        durable={decisions.durable}
        state="data"
        onRetry={noop}
        onOpenOrder={noop}
        onOverride={async () => null}
      />,
    ),
  ],
  [
    "04-activity.html",
    "Activity",
    () => shell(
      "/activity",
      <ActivityFeed
        activity={activity.activity}
        durable={activity.durable}
        state="data"
        onRetry={noop}
        onOpenOrder={noop}
      />,
    ),
  ],
];

for (const [file, label, build] of screens) {
  const html = page(`FabOrchestrator — ${label}`, label, build());
  fs.writeFileSync(path.join(OUT, file), html);
  console.log(`${file}  ${(html.length / 1024).toFixed(1)} KB`);
}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
