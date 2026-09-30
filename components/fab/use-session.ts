"use client";

/**
 * The signed-in user.
 *
 * Wraps the app's localStorage session convention rather than introducing a
 * second one: the token and session blob use exactly the keys FabOrchestrator's
 * login page and cockpit already use. Three things are needed from it — the
 * email and role for the top nav, and the expiry for the session banner.
 *
 * Reads are deferred to an effect rather than done during render: touching
 * localStorage while rendering makes the server and the first client pass
 * disagree, which React reports as a hydration error.
 */

import * as React from "react";
import { endClientSession } from "@/lib/end-client-session";
import { loginHref } from "@/lib/return-path";
import { clearStoredSession, readStoredSession } from "@/lib/stored-session";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  roleName: string | null;
}

export interface Session {
  user: SessionUser | null;
  token: string | null;
  expiresAt: Date | null;
  /** False until /api/auth/me has answered, so screens can hold their skeleton. */
  ready: boolean;
  /**
   * Whether this session also carries a **FabOrchestrator** session — that is,
   * whether the operator signed in with FO credentials rather than the demo
   * pair. Only FabInsight cares: it runs inside FabOrchestrator, so a session
   * without one cannot ask it anything.
   *
   * The token itself is an httpOnly cookie this hook cannot read and must not
   * (`lib/faborch/session.ts`); the server reports the boolean on
   * `/api/pwa/auth/me`. False until that answers, like everything else here.
   */
  faborch: boolean;
}

export function clearAuthStorage() {
  clearStoredSession();
}

export function useSession(): Session {
  const [session, setSession] = React.useState<Session>({
    user: null,
    token: null,
    expiresAt: null,
    ready: false,
    faborch: false,
  });

  React.useEffect(() => {
    // Guarded (lib/stored-session.ts): storage that throws holds no session,
    // and sign-in is the screen that can say why one cannot be kept. It used
    // to throw here, outside any guard, and take the screen down.
    const stored = readStoredSession();
    if (!stored) {
      // The bearer is gone but the cookie may not be: end the session on the
      // server too (plan RP2, m3), then sign-in, carrying where they were
      // headed so sign-in returns them to it — see lib/return-path.ts.
      endClientSession("token_missing", { to: loginHref() });
      return;
    }

    const { token, raw } = stored;

    // A missing or unparseable expiry means the banner stays down, which is the
    // right failure — a wrong countdown is worse than none.
    let expiresAt: Date | null = null;
    try {
      const parsed = JSON.parse(raw) as { expiresAt?: string };
      if (parsed.expiresAt) {
        const d = new Date(parsed.expiresAt);
        if (!Number.isNaN(d.getTime())) expiresAt = d;
      }
    } catch {
      expiresAt = null;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/pwa/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.status === 401) {
          // Expired or refused. This used to clear localStorage and stop,
          // leaving the FabOrchestrator session behind the cookie alive for
          // up to 30 days (plan RP2, m3); it now ends that too — unless a new
          // sign-in (in another tab) has replaced the token checked here, in
          // which case the session to end is not this one.
          if (readStoredSession()?.token !== token) return;
          endClientSession("pwa_expired", { to: loginHref() });
          return;
        }
        const data = await res.json();
        const u = data.user as {
          id: string;
          email: string;
          name: string | null;
          role?: { name: string } | null;
        };
        setSession({
          user: { id: u.id, email: u.email, name: u.name, roleName: u.role?.name ?? null },
          token,
          expiresAt,
          ready: true,
          faborch: data.faborch === true,
        });
      } catch {
        // A network blip should not eject a signed-in operator; render the
        // shell with what the token alone tells us.
        // A network blip cannot tell us whether the FO cookie is attached, and
        // claiming it is would put the operator in front of a prompt box that
        // 401s. False is the honest guess: the screen offers sign-in, and one
        // successful reload corrects it.
        if (!cancelled) {
          setSession({ user: null, token, expiresAt, ready: true, faborch: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return session;
}

/**
 * Sign out without navigating, for a caller that navigates itself: the plan's
 * client order (`lib/end-client-session.ts`) up to step 3. Nothing here waits on
 * the network: until 2026-09-29 this awaited the server, which waited on
 * FabOrchestrator, so a slow FO held the button on "Signing out…".
 */
export async function logout(): Promise<void> {
  endClientSession("user", { navigate: false });
}
