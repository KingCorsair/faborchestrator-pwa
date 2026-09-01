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
 * redirects to sign-in now names `/login` — `use-session.ts` in two places and
 * the shell's log-out button.
 *
 * The manifest's `start_url` deliberately did **not** move: an installed app
 * opens at `/orders`, because somebody who installed it has already come
 * through the front door and wants their work. Changing `id` would orphan every
 * installed copy in any case (see CLAUDE.md, PWA demo behaviour).
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
