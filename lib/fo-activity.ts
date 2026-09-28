/**
 * How long it has been since this device last reached FabOrchestrator — the
 * clock FabOrchestrator signs people out by.
 *
 * ── Why the phone keeps this clock (2026-09-28) ─────────────────────────────
 * FabOrchestrator ends a session after 30 minutes without an authenticated
 * call. This app used to learn that only when the next question failed: the
 * operator typed, waited, and was told to sign in again — after the top bar's
 * countdown, which tracks this app's own 12-hour session, had said nothing.
 *
 * This app is the only thing that uses its session's FO token, so every call
 * FO counted as activity came through here. The moment of the last one that
 * succeeded is FO's idle clock, give or take a round trip — and the top bar can
 * warn before it runs out (`components/fab/app-shell.tsx`).
 *
 * ── What it never does ──────────────────────────────────────────────────────
 * Call FabOrchestrator by itself. `stayActive` runs when the operator presses
 * Stay signed in, and at no other time. `lib/auth.ts` records why: a timer that
 * kept sessions alive would defeat FO's idle eviction and falsify its session
 * audit.
 *
 * ── And what it cannot know ─────────────────────────────────────────────────
 * Whether FO has actually ended the session. Asking would itself be activity,
 * which would keep alive the very session being asked about. So past thirty
 * minutes the top bar says the session has *probably* ended — the one thing it
 * can say truthfully.
 *
 * Client-safe: no imports, and every storage access is guarded, because a
 * browser that blocks site data throws on read.
 */

/** FabOrchestrator's idle limit (`claudeai_athena/lib/session-audit.ts`). */
export const FO_IDLE_LIMIT_MS = 30 * 60_000;

/** The warning starts this long before the limit. */
export const FO_IDLE_WARNING_MS = 5 * 60_000;

/** How long "Stay signed in" waits before giving up. The server's own limit is 15 s. */
const STAY_ACTIVE_WAIT_MS = 20_000;

const KEY = "faborch_last_activity";

/** Record that FabOrchestrator just answered a request on this session. */
export function markFoActivity(now: number = Date.now()): void {
  try {
    localStorage.setItem(KEY, String(now));
  } catch {
    /* Storage unavailable: no warning, which is where this app was before. */
  }
}

/** When FabOrchestrator last answered on this session, or null if unknown. */
export function lastFoActivity(): number | null {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Forget it. Called on sign-out. */
export function clearFoActivity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Nothing to forget. */
  }
}

export type FoIdle =
  /** Nothing to say: recently active, or nothing recorded yet. */
  | { kind: "active" }
  /** Inside the last five minutes. */
  | { kind: "warning"; minutesLeft: number }
  /** Past the limit: FO has probably ended the session. */
  | { kind: "ended" };

export function foIdleState(last: number | null, now: number): FoIdle {
  if (last == null) return { kind: "active" };
  const idle = now - last;
  if (idle >= FO_IDLE_LIMIT_MS) return { kind: "ended" };
  if (idle >= FO_IDLE_LIMIT_MS - FO_IDLE_WARNING_MS) {
    return { kind: "warning", minutesLeft: Math.max(1, Math.ceil((FO_IDLE_LIMIT_MS - idle) / 60_000)) };
  }
  return { kind: "active" };
}

/**
 * Stay signed in: one call to FabOrchestrator, on the operator's press.
 *
 *   "ok"     FO answered, and its idle clock starts again
 *   "ended"  FO had already ended the session — sign-in is the only way on
 *   "failed" FO or the network did not answer; the warning stays up
 */
export async function stayActive(token: string | null): Promise<"ok" | "ended" | "failed"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STAY_ACTIVE_WAIT_MS);
  try {
    const res = await fetch("/api/auth/keep-alive", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.ok) {
      markFoActivity();
      return "ok";
    }
    return res.status === 401 ? "ended" : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
