import type { Metadata } from "next";
import { Landing } from "@/components/fab/screens/landing";

/**
 * `/` — the FabOrchestrator landing page.
 *
 * **Behind the session since 2026-09-04**, which reversed the oldest decision
 * about this page. Sign-in used to live here and now lives at `/login`; see
 * that file for why they cannot share a route.
 *
 * This was the one screen in the app that read no session, and the manifest's
 * `start_url` points at it — so every cold launch of the installed app landed
 * on the only page that never asked who you were, and a signed-out operator
 * was shown a cockpit until they pressed something. `proxy.ts` carries the
 * report, the trace and the reasoning. What matters here is the consequence: a
 * visitor with no session now meets `/login` first, and this page is what they
 * get after signing in.
 *
 * ── The front door is the platform's, not one workflow's (2026-08-21) ───────
 * This page was headed *Production Order Assistant* until 2026-08-21, which
 * made the one workflow this demo implements look like the entire product.
 * It now opens on FabOrchestrator's own cockpit. The screen is in
 * `components/fab/screens/landing.tsx`, which carries the reasoning.
 *
 * Two things this page used to carry are gone. The production order workflow
 * went on 1 September with its mock MES. The "In this PWA" list of platform
 * capabilities went on 3 September: it named five things the platform does and
 * this app does not open, which read as a feature list for a product the
 * visitor cannot reach from here.
 *
 * ── Synchronous ───────────────────────────────────────────────────────────
 * It was `async` for a few days in August, when the front door opened on a
 * real production order read through the mock MES. That card, and the whole
 * workflow behind it, are gone, and there is nothing left to await.
 *
 * `/` prerenders as `○` in the build output, and that still
 * matters even now the page is behind a session: the gate runs in middleware,
 * so a request that gets this far is one that has already been decided, and
 * what it should meet is finished HTML rather than a skeleton waiting on a
 * fetch. The cockpit paints on a cold cache, before any bundle arrives.
 *
 * Thin, like every other page in this app — the screen is in
 * `components/fab/screens/`.
 */

export const metadata: Metadata = {
  title: "FabOrchestrator",
  description:
    "FabOrchestrator on your phone: ask its agents about your operations, and read the dashboards your administrator pinned.",
};

export default function Page() {
  return <Landing />;
}
