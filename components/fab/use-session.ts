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
import { useRouter } from "next/navigation";
import { loginHref } from "@/lib/return-path";

const AUTH_SESSION_KEY = "llmatscale_auth_session";
const AUTH_TOKEN_KEY = "llmatscale_auth_token";

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
   * `/api/auth/me`. False until that answers, like everything else here.
   */
  faborch: boolean;
}

export function clearAuthStorage() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    /* nothing useful to do if storage is unavailable */
  }
}

export function useSession(): Session {
  const router = useRouter();
  const [session, setSession] = React.useState<Session>({
    user: null,
    token: null,
    expiresAt: null,
    ready: false,
    faborch: false,
  });

  React.useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!token || !raw) {
      clearAuthStorage();
      // Carries where they were headed, so sign-in returns them to it rather
      // than to `/orders` — see lib/return-path.ts.
      router.replace(loginHref());
      return;
    }

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
        const res = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.status === 401) {
          clearAuthStorage();
          router.replace(loginHref());
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
  }, [router]);

  return session;
}

/** Clears the client session. The token is a stateless HMAC — see lib/auth.ts. */
export async function logout(token: string | null) {
  if (token) {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* still clear locally */
    }
  }
  clearAuthStorage();
}
