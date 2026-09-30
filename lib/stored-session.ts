/**
 * The session this device keeps in `localStorage`, read and written so that a
 * browser that refuses storage never takes a screen down.
 *
 * ── Why one module (2026-09-30) ─────────────────────────────────────────────
 * Storage throws in ordinary situations: site data blocked, some private
 * modes, a full quota. The chetan branch guarded its screens' reads one by one
 * (`e843b9c`); here the reads and writes live in one place, the call sites
 * cannot forget, and the behaviour can be tested without a browser.
 *
 * The key names are FabOrchestrator's own: its embedded client reads the same
 * two keys, which is what makes the single sign-in work (plan RP2).
 *
 * Client-safe: no imports, and every access is guarded, including reaching
 * `window.localStorage` itself, which can throw on property access.
 */

export const AUTH_TOKEN_KEY = "llmatscale_auth_token";
export const AUTH_SESSION_KEY = "llmatscale_auth_session";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A stored value, or null when absent or unreadable. Never throws. */
export function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Remove a key. Never throws. */
export function removeStored(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* nothing to remove, or nothing can be removed */
  }
}

/** The bearer this app's API expects, or an empty one when none can be read. */
export function bearerHeader(): string {
  return `Bearer ${readStored(AUTH_TOKEN_KEY) ?? ""}`;
}

/** Both halves of a stored session, or null if either is missing or unreadable. */
export function readStoredSession(): { token: string; raw: string } | null {
  const token = readStored(AUTH_TOKEN_KEY);
  const raw = readStored(AUTH_SESSION_KEY);
  return token && raw ? { token, raw } : null;
}

/** The user fields FabOrchestrator's own login page keeps, exactly as its login answered them. */
export interface StoredUser {
  id: string;
  email: string;
  name: string | null;
  canCreateDashboards?: boolean;
}

/**
 * The session blob, in **FabOrchestrator's own shape** (plan RP2, finding G30).
 *
 * FabOrchestrator's login page writes `{user, signedInAt, expiresAt}` under
 * this key ([FO-clone] `components/login-page.tsx:62-68`), and its embedded
 * pages read from it: the sidebar shows `user.name` and the chat decides its
 * dashboard controls from `user.canCreateDashboards`. This app used to write
 * `{expiresAt}` only, so every embedded page greeted the operator as "User".
 * Without a user (an older caller) the old shape is kept.
 */
export function sessionBlob(expiresAt: string, user?: StoredUser | null, now: Date = new Date()): object {
  if (!user) return { expiresAt };
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      ...(typeof user.canCreateDashboards === "boolean" ? { canCreateDashboards: user.canCreateDashboards } : {}),
    },
    signedInAt: now.toISOString(),
    expiresAt,
  };
}

/**
 * Keep a new session on this device. False when storage refused it, in which
 * case **nothing is left behind**: half a session (a token with no expiry, or
 * the reverse) is worse than none, because the next screen would act on it.
 */
export function storeSession(token: string, expiresAt: string, user?: StoredUser | null): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(AUTH_TOKEN_KEY, token);
    s.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionBlob(expiresAt, user)));
    return true;
  } catch {
    clearStoredSession();
    return false;
  }
}

/** Forget this device's session. Never throws. */
export function clearStoredSession(): void {
  removeStored(AUTH_TOKEN_KEY);
  removeStored(AUTH_SESSION_KEY);
}
