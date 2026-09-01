"use client";

/**
 * Sign out, from the landing page.
 *
 * ── Why this exists (2026-08-19) ────────────────────────────────────────────
 * A session persists, so `/login` is a screen you meet once and then never
 * again: every later visit goes straight through. It was reported as having
 * *gone*, twice. Merging sign-in into the landing page answered that and was
 * reverted on sight, so this is the small version of the same answer — a way
 * back to sign-in that does not restructure the front door.
 *
 * ── Renders nothing without a session ───────────────────────────────────────
 * Offering "Sign out" to somebody who is not signed in is nonsense, and the
 * landing page is the one screen a signed-out visitor is expected to be on. The
 * token is read in an effect rather than during render: touching localStorage
 * while rendering makes the server and the first client pass disagree, which
 * React reports as a hydration error — the same reason `useSession` defers it.
 *
 * ── Why not `useSession` ────────────────────────────────────────────────────
 * That hook **redirects to `/login` when there is no token**, which is right for
 * a screen behind auth and would make the landing page unreachable for exactly
 * the visitors it is built for. This reads the one key it needs and nothing
 * else.
 *
 * ── Where it goes afterwards ────────────────────────────────────────────────
 * `/login`, not back to `/`. The whole reason somebody presses this is to reach
 * the sign-in screen; returning them to the landing page would leave them to
 * find it through `/orders` and a redirect.
 */

import * as React from "react";
import { LogOut } from "lucide-react";
import { logout } from "./use-session";

const AUTH_TOKEN_KEY = "llmatscale_auth_token";

export function SignOutLink() {
  const [token, setToken] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    try {
      setToken(localStorage.getItem(AUTH_TOKEN_KEY));
    } catch {
      /* Storage unavailable. No session we can prove, so no control. */
      setToken(null);
    }
  }, []);

  if (!token) return null;

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // Clears the stateless token locally and tells the server, which is all
        // logging out can mean here — see `lib/auth.ts` on why revocation is
        // not available.
        await logout(token);
        // A whole-document navigation rather than `router.replace`, changed
        // 2026-08-23 for two reasons that point the same way.
        //
        // **It is the more correct sign-out.** A client-side replace keeps the
        // React tree, so any component still holding a decision list, an order
        // or a user object keeps holding it. Signing out should leave nothing
        // behind, and a document navigation is the only thing that guarantees
        // that.
        //
        // **And `useRouter` made this component unrenderable outside Next.**
        // `design-review/render.tsx` draws every screen through
        // `renderToStaticMarkup` with no router mounted, and this leaf is on
        // the landing page — so the harness threw *"invariant expected app
        // router to be mounted"* and produced no landing export at all. That
        // harness is the only way any screen in this app has ever been looked
        // at (CLAUDE.md, thin-ice item 3), and the front door is the screen it
        // matters most for.
        window.location.assign("/login");
      }}
      className="inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 text-[12px] font-bold underline decoration-1 underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      style={{ color: "var(--text-subtle)" }}
    >
      <LogOut size={13} strokeWidth={2.2} aria-hidden="true" />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
