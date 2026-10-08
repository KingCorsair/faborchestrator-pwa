import type { Metadata } from "next";
import { LoginPage } from "@/components/login-page";
import { safeReturnPath } from "@/lib/return-path";

/**
 * `/login` — sign-in.
 *
 * **Moved off `/` on 2026-08-18**, when the landing page took the front door.
 * The two cannot share a route: `useSession` bounces an unauthenticated visitor
 * to sign-in, so a landing page at `/` with the form also at `/` would send
 * the landing CTA to `/orders`, back to `/`, and round again. Everything that
 * redirects to sign-in now names `/login` — `use-session.ts` in two places,
 * the shell's log-out button, and `proxy.ts`.
 *
 * ── This route is the one that must stay public (2026-09-04) ────────────────
 * `proxy.ts` now redirects every session-less navigation here, so `/login`
 * is on its `PUBLIC` allowlist and has to stay there. Gating it *is* the
 * redirect loop — the same loop the 2026-08-18 split was performed to avoid,
 * arriving from the server side instead of from `useSession`.
 *
 * The manifest's `start_url` is `/`, which is the cockpit and is now behind the
 * gate: a cold launch with no session is redirected here, signs in, and is
 * returned to `/` — or to `?next=`, if the launch was aimed at a screen deeper
 * in. `id` stays `/orders` and must: changing it would orphan every installed
 * copy (see CLAUDE.md, PWA demo behaviour), which is why it names a route this
 * app no longer has.
 */

export const metadata: Metadata = {
  title: "Sign in — FabOrchestrator",
};

/**
 * Read at request time, not build time, because `?next=` is read below and a
 * prerendered page would bake in whichever query string the build happened to
 * see — which is none.
 */
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeReturnPath(params.next);

  return <LoginPage next={next} />;
}
