import type { Metadata } from "next";
import { Landing } from "@/components/fab/screens/landing";

/**
 * `/` — the FabOrchestrator landing page.
 *
 * Unauthenticated, and the only screen in the app that is. Sign-in used to live
 * here and now lives at `/login`; see that file for why they cannot share a
 * route.
 *
 * ── The front door is the platform's, not one workflow's (2026-08-21) ───────
 * This page was headed *Production Order Assistant* until 2026-08-21, which
 * made the one workflow this demo implements look like the entire product.
 * It now opens on FabOrchestrator, lists what the platform does, and offers the
 * production order workflow as its single primary action. The screen is in
 * `components/fab/screens/landing.tsx` and the capability list is in
 * `lib/capabilities.ts`; both carry the reasoning.
 *
 * ── Synchronous again, as of 2026-08-23 ────────────────────────────────────
 * It was `async` from 2026-08-20 so the front door could open on a real order
 * with its real detected problems, resolved through `featuredOrder()`. The
 * indigo card that displayed them was removed at the reviewer's request, so
 * there is nothing left to await. `lib/featured-order.ts` is untouched and
 * still tested — kept because the target design may want the derived count
 * ("orders awaiting review"), and its provenance is expensive to rebuild.
 *
 * `/` prerenders as `○` in the build output either way, which is what matters
 * for a public entry point: it has to render for somebody who has never signed
 * in, on a cold cache, before any bundle arrives.
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
