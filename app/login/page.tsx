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
 * Read at request time, not build time.
 *
 * Without this Next prerenders the page during `next build` and bakes whatever
 * the environment held *then* into the HTML. In a container the build runs
 * before any secret is attached, so the prefill would always be empty and the
 * cause would be invisible — the page renders fine, it just never fills in.
 */
export const dynamic = "force-dynamic";

/**
 * Prefilling the email is **off by default and deliberately opt-in.**
 *
 * It costs something real: `lib/auth.ts` has no rate limiting, so putting the
 * username on the page leaves only the password between a public URL and a
 * session that spends `ANTHROPIC_API_KEY`. That is an acceptable trade when
 * you have handed the link to one person and want them typing one field on a
 * phone keyboard — and not acceptable as a silent default for every
 * deployment, which is why it is a switch rather than a behaviour.
 *
 * ⚠ **It prefills the *demo* address, which is now the wrong steer.** Since the
 * agents arrived, a FabOrchestrator credential opens everything and the demo
 * credential opens the order workflow alone — so putting the demo address in
 * the field walks the visitor into the one session that meets a second sign-in
 * when they open an agent. It was unset on the deployed app on 2026-08-24 for
 * that reason. Turn it on only for a demo that is deliberately about the order
 * workflow.
 */
/**
 * `?next=` is read here, on the server, rather than with `useSearchParams` in
 * the form. That hook forces the component into a Suspense boundary — the
 * build risk CLAUDE.md records as the reason URL state was skipped at Tier 0 —
 * and this page is already `force-dynamic`, so reading the query costs nothing
 * it was not already paying. `safeReturnPath` is what stops it being an open
 * redirect; see `lib/return-path.ts`.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const prefill =
    process.env.DEMO_PREFILL_EMAIL === "true" ? (process.env.DEMO_USER_EMAIL ?? "") : "";
  const params = await searchParams;
  const next = safeReturnPath(params.next);

  return <LoginPage defaultEmail={prefill} next={next} />;
}
