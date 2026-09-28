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
import { clearFoActivity } from "@/lib/fo-activity";
import { loginHref } from "@/lib/return-path";

const AUTH_SESSION_KEY = "llmatscale_auth_session";
const AUTH_TOKEN_KEY = "llmatscale_auth_token";

/**
 * How long sign-out waits for the server before giving up on it.
 *
 * The server gives FabOrchestrator five seconds (`FO_SIGN_OUT_TIMEOUT_MS`);
 * this allows for the network either side of that.
 */
const SIGN_OUT_WAIT_MS = 8_000;

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
  clearFoActivity();
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
    // Storage that throws — site data blocked, or some private modes — holds no
    // session this screen can use. It used to throw here, outside any guard,
    // and take the screen down with nothing but "Application error" on it.
    // Sign-in is the right place to land: it is the screen that can say why a
    // session cannot be kept (`components/login-page.tsx`).
    let token: string | null;
    let raw: string | null;
    try {
      token = localStorage.getItem(AUTH_TOKEN_KEY);
      raw = localStorage.getItem(AUTH_SESSION_KEY);
    } catch {
      router.replace(loginHref());
      return;
    }
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

/**
 * Sign out: this device first, then the server.
 *
 * ── The order was the other way round until 2026-09-28 ──────────────────────
 * It waited for the server — which waits for FabOrchestrator — before clearing
 * anything here. So a FabOrchestrator that had stopped answering kept the
 * button on "Signing out…", and this device signed in, for as long as the call
 * hung: up to five minutes.
 *
 * Now the device forgets its session first, which cannot fail. Then the server
 * is asked to drop the FabOrchestrator cookie and end the FO session, and given
 * `SIGN_OUT_WAIT_MS` to do it. The cookie is httpOnly, so only the server can
 * remove it; if the network is down it stays until the next sign-in replaces it
 * or it expires — and on its own it opens nothing, because every request needs
 * the bearer token this has already deleted (`lib/auth-middleware.ts`).
 *
 * The server is asked even with no token in hand: the cookie may still be
 * there, and the route reads only the cookie.
 */
export async function logout(token: string | null) {
  clearAuthStorage();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_OUT_WAIT_MS);
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
  } catch {
    /* Signed out here already; see above for what is left and why it is inert. */
  } finally {
    clearTimeout(timer);
  }
}
