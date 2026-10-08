/**
 * The FabOrchestrator client — **the only file in this app that knows FO's HTTP
 * contract.**
 *
 * ── What this is, and what it deliberately is not ───────────────────────────
 * FabOrchestrator's own pages do the work; this app serves them through its
 * gateway (`app/fo-gateway/[...path]/route.ts`). This file is the handful of
 * calls this app makes to FabOrchestrator **itself**: sign in, ask who the
 * operator is, sign out, and, for the gateway's checks, ask whether a
 * conversation is the caller's and delete one the seat rule could not record.
 * There is no MES query, no system prompt and no model call in this directory.
 *
 * ── Every endpoint below was read from the running product ──────────────────
 * All are in `claudeai_athena/` in the FabOrchestrator product repository
 * (`LLM-AT-SCALE/FabOrchestrator_product_code`):
 *
 *   POST /api/auth/login       app/api/auth/login/route.ts:80
 *                              {email, password} → {user, token, expiresAt}
 *   GET  /api/auth/me          app/api/auth/me/route.ts
 *   POST /api/auth/logout      app/api/auth/logout/route.ts
 *   GET, DELETE /api/conversations/{id}
 *                              app/api/conversations/[id]/route.ts
 *
 * Nothing here was invented. If FO's contract changes, this file is the whole
 * blast radius.
 *
 * ── Why the PWA cannot call FO from the browser ─────────────────────────────
 * `/api/chat` sends no `Access-Control-Allow-Origin`, so a fetch from the PWA's
 * origin (:3002) to FO's (:3000) is blocked before it leaves. Every call in
 * this file therefore runs server-side, which is also what keeps the FO session
 * token out of client JavaScript — see `app/api/auth/login/route.ts`.
 *
 * **Server-only.** Nothing in `components/` may import this: it reads
 * `process.env` and holds a session token. The `server-only` package would
 * enforce that at build time, and this app does not carry it — the enforcement
 * here is that the single caller is a route handler.
 */
import { z } from "zod";
import { reportError } from "../report-error";

/** Thrown when the integration is not configured. Never a bad password. */
export class FabOrchNotConfiguredError extends Error {}

/** Thrown when FO answered, but not with success. Carries FO's own message. */
export class FabOrchRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/* ── How long FabOrchestrator is given ──────────────────────────────────────
 *
 * Ported from the `chetan` branch (`e843b9c`, 2026-09-28). Until then no call
 * in this file had a limit: an FO that accepted a request and went quiet held
 * it for Node's own default, five minutes, and sign-out sat on "Signing out…"
 * for as long as the call hung.
 *
 * The limits are named after the call classes of the architecture plan
 * (RP4, `docs/architectural_review_issues/PWA_ARCHITECTURAL_REMEDIATION_PLAN.md`)
 * so the full lifecycle design can take them over without renaming callers.
 * **The values are provisional**: RP4 leaves every budget to checkpoint CP3,
 * bounded by the edge's own origin timeout (§9 question 48). Each can be set
 * from the environment in the meantime.
 *
 * This covers the calls this app makes to FO itself. **It does not cover the
 * gateway's forwarding** (`app/fo-gateway/[...path]/route.ts`), which has its
 * own deadlines (`lib/gateway/deadline.ts`).
 */
function limitFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const FO_CALL_TIMEOUTS = {
  /** RP4 `bounded`: a lookup, a sign-in, `/me`: headers **and** body. */
  bounded: limitFromEnv("FO_TIMEOUT_BOUNDED_MS", 15_000),
  /** RP4 `revoke`: FO's `/api/auth/logout`. Nobody should wait on it. */
  revoke: limitFromEnv("FO_TIMEOUT_REVOKE_MS", 5_000),
} as const;

/**
 * Hosts for which plain HTTP is a development convenience rather than a defect.
 *
 * Loopback only, and matched exactly. `localhost.example.com` is a public host
 * that merely *starts* with the word, so a `startsWith`/`includes` test here
 * would be a hole big enough to drive a real deployment through.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Where FabOrchestrator is.
 *
 * No default. A localhost fallback would mean a deployment that forgot to set
 * this silently answered from whatever happened to be on :3000, and the failure
 * would surface as strange answers rather than as a missing setting.
 *
 * ── The scheme is checked here, and only here ───────────────────────────────
 * Every call to FabOrchestrator is built from this one value (`fetchFo`), so
 * this function is the only place the transport can be got wrong. Everything
 * that crosses this hop is either a credential or plant data: the operator's
 * FabOrchestrator password on sign-in, their session bearer token on every
 * subsequent call, and the questions and answers themselves. Over plain HTTP
 * all of it is readable by anything on the path.
 *
 * So **HTTPS is required**, with exactly one exception: a loopback host. That
 * is the documented local-development setup in `.env.example`
 * (`http://localhost:3000`, a `claudeai_athena` running on the same machine),
 * where the traffic never leaves the box and there is no TLS to have.
 *
 * The exception is deliberately keyed on the *host*, not on `NODE_ENV`.
 * `npm start` sets `NODE_ENV=production` for an ordinary local production
 * build, so keying on it would either break that documented workflow or make
 * the guard depend on a variable that a deployment can set wrongly. A loopback
 * address is not reachable from anywhere else by construction, which is a
 * stronger guarantee than any flag.
 *
 * There is no override. An escape hatch for "just this once" is how an
 * insecure production URL gets introduced, and the failure it produces is
 * silent — everything works, and the credentials are simply in the clear.
 */
export function foBaseUrl(): string {
  const value = process.env.FABORCH_BASE_URL?.trim();
  if (!value) {
    throw new FabOrchNotConfiguredError(
      "FABORCH_BASE_URL is not set. FabInsight runs inside FabOrchestrator; " +
        "point this at that app (see .env.example).",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FabOrchNotConfiguredError(
      `FABORCH_BASE_URL is not a valid URL ("${value}"). It needs a scheme and ` +
        "a host, like https://faborchestrator.example.com.",
    );
  }

  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new FabOrchNotConfiguredError(
      `FABORCH_BASE_URL uses plain HTTP (${url.protocol}//${url.host}). Sign-in ` +
        "sends a FabOrchestrator password over this connection and every later " +
        "call carries a session token, so it must be https. Plain http is " +
        "accepted only for a FabOrchestrator on localhost.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FabOrchNotConfiguredError(
      `FABORCH_BASE_URL has an unsupported scheme (${url.protocol}). ` +
        "FabOrchestrator is reached over https.",
    );
  }

  return value.replace(/\/+$/, "");
}

/** True when the integration is configured at all. Used to pick a UI state. */
export function isFabOrchConfigured(): boolean {
  return !!process.env.FABORCH_BASE_URL?.trim();
}

/** A phone's proof for FabOrchestrator's approved devices: its id, FO's challenge, and its signature. */
export interface FoDeviceProof {
  deviceId: string;
  challenge: string;
  signature: string;
}

/** FabOrchestrator refused the device a sign-in came from (not approved, or revoked). Carries FO's own message. */
export class FoDeviceRefusedError extends Error {
  constructor(
    readonly code: "DEVICE_NOT_APPROVED" | "DEVICE_REVOKED",
    message: string,
  ) {
    super(message);
  }
}

export interface FoSession {
  token: string;
  expiresAt: string;
  /**
   * `canCreateDashboards` is part of FabOrchestrator's own login answer
   * ([FO-clone] `app/api/auth/login/route.ts:84-93`) and of the session blob
   * its pages read (plan RP2, G30); it is passed through, never computed here.
   */
  user: { id: string; email: string; name: string | null; canCreateDashboards?: boolean };
}

/**
 * Sign in to FabOrchestrator with the operator's own FO credentials.
 *
 * `device` is the phone's proof for FabOrchestrator's approved devices (its
 * Admin → Devices), passed through untouched; FO checks it before the password.
 *
 * Returns null for 401/403 — bad credentials, suspended, deleted. FO
 * distinguishes those three in its message; the caller does not pass that on,
 * for the same reason `lib/auth.ts` does not say which half was wrong.
 * FO refusing the **device** is different and is thrown as
 * `FoDeviceRefusedError`: it is checked before the password, so saying so
 * reveals nothing about the account, and it tells the person what to do.
 *
 * Throws for anything else, because "FO is down" and "your password is wrong"
 * must not read the same to somebody standing at the line.
 */
export async function foLogin(email: string, password: string, device?: FoDeviceProof): Promise<FoSession | null> {
  const res = await fetchFo("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, ...(device ? { device } : {}) }),
  });

  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { code?: unknown; error?: unknown } | null;
    if (body?.code === "DEVICE_NOT_APPROVED" || body?.code === "DEVICE_REVOKED") {
      throw new FoDeviceRefusedError(
        body.code,
        typeof body.error === "string" && body.error ? body.error : "This device is not approved for FabOrchestrator.",
      );
    }
    return null;
  }
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new FabOrchRequestError(await foErrorTextOf(res, "FabOrchestrator rejected the sign-in"), res.status);
  }

  const data = (await res.json()) as FoSession;
  if (!data?.token) {
    throw new FabOrchRequestError("FabOrchestrator returned no session token", 502);
  }
  return data;
}

/**
 * What FabOrchestrator's `/api/auth/me` says about a token it has just issued.
 *
 *   GET /api/auth/me → 200 { user: { …, role: { id, name } | null } }
 *                      403 { code: "FORCE_PASSWORD_CHANGE", … }  forced change
 *                      403 { error: "Account is no longer active…" }
 *                      401                                     token not honoured
 *
 * ([FO-clone] `lib/auth-middleware.ts:182-205`, `app/api/auth/me/route.ts`.)
 *
 * Ported from the `chetan` branch (`e843b9c`), where it returned the role or
 * `null` for every refusal. The plan's sign-in design (RP2, login step 2)
 * treats those refusals differently, so they are told apart here and the
 * login route decides.
 *
 * **Calling it counts as FO activity**, so it is called at sign-in only, where
 * FO's login has just set the idle clock anyway. Never on a timer.
 *
 * Throws `FabOrchRequestError` for anything else (timeout, unreachable, 5xx);
 * the caller treats that as "could not find out", never as a refusal.
 */
export type FoMeResult =
  | { kind: "ok"; roleName: string | null }
  | { kind: "force_password_change" }
  | { kind: "inactive" }
  | { kind: "unauthorized" };

const FoMeBodySchema = z.object({
  user: z.object({ role: z.object({ name: z.string() }).nullable().optional() }),
});

export async function foMe(token: string): Promise<FoMeResult> {
  const res = await fetchFo("/api/auth/me", { headers: authHeader(token) });
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    return body?.code === "FORCE_PASSWORD_CHANGE" ? { kind: "force_password_change" } : { kind: "inactive" };
  }
  if (!res.ok) {
    throw new FabOrchRequestError(
      await foErrorTextOf(res, "FabOrchestrator could not confirm the session."),
      res.status,
    );
  }
  // A body of the wrong shape costs the label, not the sign-in.
  const parsed = FoMeBodySchema.safeParse(await res.json().catch(() => null));
  const name = parsed.success ? parsed.data.user.role?.name.trim() : undefined;
  return { kind: "ok", roleName: name ? name : null };
}

/**
 * End the FabOrchestrator session behind this token.
 *
 * FO's `/api/auth/logout` is a real revocation: it closes the audit row and
 * **deletes** the session record (`claudeai_athena/app/api/auth/logout`), so the
 * token stops working everywhere rather than just here.
 *
 * ── Why this app calls it, having once decided not to ───────────────────────
 * The original argument was that ending FO's session would sign the operator
 * out of a FabOrchestrator tab open elsewhere. It does not, and cannot: FO's
 * logout deletes **one row by token** (`deleteSession`), while every login mints
 * a fresh token and inserts another row. Other sessions belong to other tokens
 * and are untouched. What this call ends is exactly the session the PWA was
 * handed — which is also what makes FO's own logs record a sign-out rather than
 * a session that went quiet.
 *
 * **Never throws, and never blocks sign-out.** If FO is unreachable the local
 * cookie is still dropped, which is the part that protects the handset in the
 * room. A sign-out that fails because a server is down is worse than one that
 * revokes late.
 */
export async function foLogout(token: string): Promise<boolean> {
  try {
    const res = await fetchFo(
      "/api/auth/logout",
      { method: "POST", headers: authHeader(token) },
      { timeoutMs: FO_CALL_TIMEOUTS.revoke },
    );
    // 404 means FO had already dropped it — idle eviction, or an admin force
    // logout. The session is gone either way, which is the outcome asked for.
    return res.ok || res.status === 404;
  } catch {
    // Too slow or unreachable; `fetchFo` has already reported which.
    return false;
  }
}

/**
 * Delete a conversation FabOrchestrator has just created, with the caller's own
 * token. The seat rule's undo (`lib/gateway/seats.ts`): a new conversation
 * whose ownership could not be recorded must not be left for nobody. Never
 * throws; false means it may still exist.
 */
export async function foDeleteConversation(token: string, id: string): Promise<boolean> {
  try {
    const res = await fetchFo(
      `/api/conversations/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: authHeader(token) },
      { timeoutMs: FO_CALL_TIMEOUTS.revoke },
    );
    return res.ok || res.status === 404;
  } catch {
    // Too slow or unreachable; `fetchFo` has already reported which.
    return false;
  }
}

/**
 * Does this token own that conversation? FabOrchestrator's own answer, per id
 * (plan RP6 part 3), for the gateway's ownership check.
 *
 * `GET /api/conversations/{id}` compares `conversation.userId` with the caller
 * and refuses anybody else ([FO-clone] `app/api/conversations/[id]/route.ts:31`),
 * so a 200 whose body names the same id is the one answer that proves
 * ownership. Everything else is told apart so the caller can refuse correctly:
 *
 *   owned            200 and the body's `id` is the one asked about
 *   not-owned        403 or 404: somebody else's, or gone
 *   session-expired  401: FabOrchestrator no longer honours the token
 *   unavailable      anything else — another status, a body that does not
 *                    name the id, a timeout, FabOrchestrator unreachable
 *
 * The answer carries the whole thread (1.3 MB measured for a long one), which
 * is why the gateway asks only on a cache miss. Never throws: `fetchFo` has
 * already reported a timeout or an outage.
 */
export type ConversationProof =
  | { kind: "owned" }
  | { kind: "not-owned"; status: number }
  | { kind: "session-expired" }
  | { kind: "unavailable"; status: number | null };

export async function foConversationProof(token: string, id: string): Promise<ConversationProof> {
  let res: Response;
  try {
    res = await fetchFo(`/api/conversations/${encodeURIComponent(id)}`, { headers: authHeader(token) });
  } catch {
    return { kind: "unavailable", status: null };
  }
  if (res.status === 401) return { kind: "session-expired" };
  if (res.status === 403 || res.status === 404) return { kind: "not-owned", status: res.status };
  if (res.status !== 200) return { kind: "unavailable", status: res.status };
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  return body && typeof body === "object" && body.id === id
    ? { kind: "owned" }
    : { kind: "unavailable", status: res.status };
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Every call to FabOrchestrator, with its time limit.
 *
 * `no-store` on every call: Next caches `fetch` in route handlers by default,
 * and a cached sign-in is a defect, not a saving.
 *
 * ── The limit covers the body too ───────────────────────────────────────────
 * `fetch` resolves when the headers arrive, so a limit that stopped there would
 * still let a response that starts and then stalls hang its caller. Every call
 * is therefore read to the end *inside* the limit and handed back already
 * buffered, so a caller's `res.json()` cannot hang after this returns.
 *
 * ── Three ways it fails, told apart ─────────────────────────────────────────
 *   too slow        → 504, and reported
 *   unreachable     → 503, and reported
 *   cancelled here  → 499: the caller's own abort (the operator pressed Stop or
 *                     left). Not FabOrchestrator's fault, so not reported.
 */
async function fetchFo(
  path: string,
  init: RequestInit,
  { timeoutMs = FO_CALL_TIMEOUTS.bounded }: { timeoutMs?: number } = {},
): Promise<Response> {
  const url = `${foBaseUrl()}${path}`;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;

  try {
    const res = await fetch(url, { ...init, signal, cache: "no-store" });

    const body = await res.arrayBuffer();
    return new Response(NULL_BODY_STATUSES.has(res.status) ? null : body, {
      status: res.status,
      statusText: res.statusText,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (cause) {
    if (deadline.signal.aborted) {
      const error = new FabOrchRequestError(
        `FabOrchestrator did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        504,
        { cause },
      );
      reportError("faborch/timeout", error, { path, timeoutMs });
      throw error;
    }
    if (init.signal?.aborted) {
      throw new FabOrchRequestError("The request was cancelled before FabOrchestrator answered.", 499, {
        cause,
      });
    }
    // The common one by far: FO is not running. Say so, rather than leaking
    // `fetch failed` to the screen — and without FabOrchestrator's address,
    // which this message used to carry to the phone (plan RP5, finding m4).
    const error = new FabOrchRequestError("Could not reach FabOrchestrator. Is it running?", 503, { cause });
    reportError("faborch/unreachable", error, { path });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Statuses a `Response` may not be built with a body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Reduce any FabOrchestrator error body to one displayable string.
 *
 * FO answers with **two** shapes, and the difference is not cosmetic:
 *
 *   1. The canonical envelope from `handleApiError`
 *      (`lib/errors/api-error-handler.ts`):
 *      `{ error: { errorId, type, priority, message } }`
 *   2. A bare string from routes that answer directly, e.g. the Master Data
 *      Load Agent's 403 `{ error: "…is not enabled for your role." }` and
 *      `{ error: "Invalid request body" }`.
 *
 * Reading `body.error` and hoping is the defect this function exists to
 * prevent: against shape 1 it yields an **object**, which reaches the screen
 * as `[object Object]` and, if a React child, throws instead of rendering.
 * Every value returned here is a string, whatever FO sent — including
 * `null`, an array, a number, or a body that is not JSON at all.
 *
 * The `errorId` is appended when present. It is the only handle support has
 * for finding the row in `error_audit_logs`, so dropping it costs a user the
 * ability to be helped.
 */
export function foErrorMessage(body: unknown, fallback: string): string {
  const asText = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");

  if (!body || typeof body !== "object") return fallback;
  const b = body as Record<string, unknown>;

  // Shape 2, and FO's occasional top-level `userMessage`.
  const flat = asText(b.userMessage) || asText(b.error) || asText(b.message);
  if (flat) return flat;

  // Shape 1 — the nested envelope.
  const nested = b.error;
  if (nested && typeof nested === "object") {
    const e = nested as Record<string, unknown>;
    const text = asText(e.message) || asText(e.userMessage) || asText(e.type);
    const id = asText(e.errorId);
    if (text) return id ? `${text} (errorId=${id})` : text;
    if (id) return `${fallback} (errorId=${id})`;
  }

  return fallback;
}

/** As above, but reading the body off a `Response`. Never throws. */
export async function foErrorTextOf(res: Response, fallback: string): Promise<string> {
  try {
    return foErrorMessage(await res.json(), fallback);
  } catch {
    return fallback;
  }
}
