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
 * ── Synchronous again, as of 2026-08-23 ────────────────────────────────────
 * It was `async` from 2026-08-20 so the front door could open on a real order
 * with its real detected problems, resolved through `featuredOrder()`. The
 * indigo card that displayed them was removed at the reviewer's request, so
 * there is nothing left to await. `lib/featured-order.ts` is untouched and
 * still tested — kept because the target design may want the derived count
 * ("orders awaiting review"), and its provenance is expensive to rebuild.
 *
 * `/` still prerenders as `○` in the build output either way, and that still
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
    "An enterprise AI platform for manufacturing operations. Review and approve production orders using MES evidence and AI-assisted analysis.",
};

export default function Page() {
  return <Landing />;
}
