/**
 * A failed-attempt limiter for sign-in.
 *
 * ── Why this exists, and why it arrived on 2026-08-23 rather than at Tier 0 ──
 * CLAUDE.md's thin-ice item 1 has always said this app's auth "must not ship as
 * is": one credential pair, stateless tokens, **no rate limiting**. That was a
 * survivable trade while the worst case was a stranger guessing a demo password
 * and looking at six mock production orders.
 *
 * It stopped being survivable when `/api/auth/login` learned to forward to a
 * real FabOrchestrator (see that route). On a public URL, an unthrottled login
 * that proxies to a production identity store is a credential-testing endpoint
 * with no lockout, no alerting, and — because the attempts are made by *this*
 * server — nothing in FO's audit trail that distinguishes them from a person.
 * The deploy is what makes that reachable, so the limiter lands with the deploy.
 *
 * **This is a mitigation, not a fix.** It is per-process and per-IP: it stops a
 * script hammering one address, and it does not stop a distributed attempt. The
 * real answer is still the one thin-ice item 1 names — the product's own
 * authentication, with a user table and server-side sessions.
 *
 * ── Why in-memory is coherent here, when it was not for decisions ───────────
 * `fly.toml` pins `min_machines_running = 1` and `auto_stop_machines = false`,
 * so there is exactly one long-lived process; a Map in it sees every request.
 * That is the same property `lib/decisions/` needed and the reason Vercel was
 * ruled out. The difference is that losing this state on restart is *safe* — it
 * forgets failed attempts, which fails open for a moment rather than locking
 * anybody out — whereas losing a decision log is data loss. So this one gets a
 * Map and no apology, and there is no `durable` flag to report.
 *
 * ── Only failures count ─────────────────────────────────────────────────────
 * A successful sign-in clears the counter. Somebody who knows their password is
 * never throttled by their own logins, however many devices they open the demo
 * on; only wrong guesses accumulate.
 */

/** Wrong guesses allowed from one address before it is refused. */
const MAX_FAILURES = 8;

/** How long failures are remembered, and how long a blocked address waits. */
const WINDOW_MS = 10 * 60 * 1000;

/**
 * Cap on tracked addresses, so a spray across many source IPs cannot grow the
 * Map without bound. At the cap the oldest entry is dropped — which favours
 * whoever is attacking, and is the right way round: the alternative is refusing
 * to record anything, or refusing real users, both worse than degrading to no
 * protection for one address.
 */
const MAX_TRACKED = 10_000;

interface Attempts {
  count: number;
  /** When the window began, epoch ms. */
  since: number;
}

const failures = new Map<string, Attempts>();

/**
 * The caller's address.
 *
 * `fly-client-ip` first: Fly sets it on every request from its edge and a
 * client cannot forge it, whereas `x-forwarded-for` is caller-supplied and is
 * only trustworthy at the hop that wrote it. Falling back to the first
 * `x-forwarded-for` entry covers other hosts; falling back to a constant covers
 * local development, where every request shares one bucket, which is correct
 * because there is only one caller.
 */
export function clientAddress(headers: Headers): string {
  const fly = headers.get("fly-client-ip");
  if (fly) return fly.trim();
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "local";
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Whole seconds until the window clears. Only meaningful when blocked. */
  retryAfterSeconds: number;
}

/** Whether this address may attempt a sign-in right now. */
export function checkLoginAllowed(address: string, now = Date.now()): RateLimitVerdict {
  const record = failures.get(address);
  if (!record) return { allowed: true, retryAfterSeconds: 0 };

  const elapsed = now - record.since;
  if (elapsed >= WINDOW_MS) {
    failures.delete(address);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (record.count < MAX_FAILURES) return { allowed: true, retryAfterSeconds: 0 };

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)),
  };
}

/** Record a wrong guess. */
export function recordLoginFailure(address: string, now = Date.now()): void {
  const record = failures.get(address);

  if (!record || now - record.since >= WINDOW_MS) {
    if (failures.size >= MAX_TRACKED) {
      const oldest = failures.keys().next();
      if (!oldest.done) failures.delete(oldest.value);
    }
    failures.set(address, { count: 1, since: now });
    return;
  }

  record.count += 1;
}

/** Forget this address's failures. Called on a successful sign-in. */
export function clearLoginFailures(address: string): void {
  failures.delete(address);
}

/** Test seam. Nothing in the app calls this. */
export function resetLoginFailures(): void {
  failures.clear();
}

export const LOGIN_RATE_LIMIT = { MAX_FAILURES, WINDOW_MS } as const;
