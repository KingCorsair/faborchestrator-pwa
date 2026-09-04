"use client";

/**
 * The landing page's session leaf: sign out, and the backstop that decides
 * whether there is a session to sign out of.
 *
 * ── Why it exists (2026-08-19) ──────────────────────────────────────────────
 * A session persists, so `/login` is a screen you meet once and then never
 * again: every later visit goes straight through. It was reported as having
 * *gone*, twice. Merging sign-in into the landing page answered that and was
 * reverted on sight, so this is the small version of the same answer — a way
 * back to sign-in that does not restructure the front door.
 *
 * ── It now redirects rather than rendering nothing (2026-09-04) ─────────────
 * It used to render nothing when there was no token, because the landing page
 * was the one screen a signed-out visitor was expected to be on. That stopped
 * being true when `proxy.ts` put `/` behind the session: a signed-out
 * visitor never reaches this component, so a token that is missing here means
 * the two halves of the session disagree, and the honest answer is sign-in.
 *
 * **This is a backstop, not the gate.** The gate is the middleware, which
 * answers before the document exists — the only place that can keep a
 * signed-out cold launch from painting a cockpit. What this catches is the one
 * state the middleware cannot see: the FabOrchestrator cookie present while
 * `localStorage` is empty, which no sign-out, expiry or force-quit produces
 * and only clearing site storage by hand does. In that state every screen
 * behind here would bounce anyway; this makes the cockpit agree with them.
 *
 * ── Storage that throws is not storage that is empty ────────────────────────
 * A browser with site data blocked throws on read, and redirecting for that
 * would send the operator to a sign-in page that cannot store what it mints —
 * a loop. A throw therefore renders no control and no redirect, exactly as
 * before.
 *
 * ── Why not `useSession` ────────────────────────────────────────────────────
 * That hook fetches `/api/auth/me` and holds a skeleton until it answers,
 * which on this screen would trade a cold-launch cockpit for a cold-launch
 * skeleton — and this page's whole value is that it paints immediately. It
 * also pulls in `useRouter`, which this component cannot have: see below.
 *
 * The token is read in an effect rather than during render, because touching
 * `localStorage` while rendering makes the server and the first client pass
 * disagree, which React reports as a hydration error.
 *
 * ── Where it goes afterwards ────────────────────────────────────────────────
 * `/login`, not back to `/`. The whole reason somebody presses this is to
 * reach the sign-in screen; returning them to the landing page would now bounce
 * them to `/login` through the middleware anyway, one navigation later.
 */

import * as React from "react";
import { LogOut } from "lucide-react";
import { logout } from "./use-session";
import { loginHref } from "@/lib/return-path";

const AUTH_TOKEN_KEY = "llmatscale_auth_token";

export function SignOutLink() {
  const [token, setToken] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let stored: string | null;
    try {
      stored = localStorage.getItem(AUTH_TOKEN_KEY);
    } catch {
      /* Storage unavailable. No session we can prove and none we could mint —
         see the header on why this must not redirect. */
      return;
    }

    if (!stored) {
      // `location.replace`, not `router.replace`: the same document navigation
      // the sign-out button uses, and for the same two reasons — it leaves no
      // React tree holding a stale user, and it keeps `useRouter` out of a
      // component that has to render without one.
      window.location.replace(loginHref());
      return;
    }

    setToken(stored);
  }, []);

  if (!token) return null;

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // Clears the stateless token locally and tells the server, which drops
        // the FabOrchestrator cookie — see `lib/auth.ts` on why that is a
        // revocation rather than a tidy-up.
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
