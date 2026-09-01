/**
 * The FabOrchestrator client — **the only file in this app that knows FO's HTTP
 * contract.**
 *
 * ── What this is, and what it deliberately is not ───────────────────────────
 * FabInsight is not reimplemented here. It is AGENT · 01 on the shipped
 * cockpit (`claudeai_athena/components/cockpit/agent-cards.tsx:32`, `route:
 * "/chat"`), it runs inside the FabOrchestrator app against that app's MCP
 * tools, model registry, roles, quotas and prompt audit, and this file does
 * exactly three things: sign in, ask which tools that user has, and forward a
 * prompt. Every answer the PWA renders was computed by FO.
 *
 * There is no yield calculation, no MES query, no system prompt and no model
 * call in this directory. If one appears here, the PWA has stopped being a
 * client and started being a second product.
 *
 * ── Every endpoint below was read from the running product ──────────────────
 * All three are in `claudeai_athena/` in the FabOrchestrator product
 * repository (`LLM-AT-SCALE/FabOrchestrator_product_code`):
 *
 *   POST /api/auth/login       app/api/auth/login/route.ts:80
 *                              {email, password} → {user, token, expiresAt}
 *   GET  /api/mcp/connections  app/api/mcp/connections/route.ts:12
 *                              → personal + role MCPs, each with `status`
 *   POST /api/chat             app/api/chat/route.ts:139
 *                              Bearer + {messages, model, activeMcpIds, …}
 *                              → an AI SDK UI-message stream (SSE)
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

/**
 * FO's own default, from `GET /api/chat`'s response body
 * (`app/api/chat/route.ts:1185`: `defaultModel: 'claude-opus-4-8'`, listed as
 * "FabOrchestrator 2.0"). Overridable because FO validates the id against its
 * `model_registry` table and a deployment may allow a different set — but the
 * default is FO's, not ours, so the PWA answers like the product does.
 */
export const FO_DEFAULT_MODEL = process.env.FABORCH_MODEL || "claude-opus-4-8";

/** Thrown when the integration is not configured. Never a bad password. */
export class FabOrchNotConfiguredError extends Error {}

/** Thrown when FO answered, but not with success. Carries FO's own message. */
export class FabOrchRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Where FabOrchestrator is.
 *
 * No default. A localhost fallback would mean a deployment that forgot to set
 * this silently answered from whatever happened to be on :3000, and the failure
 * would surface as strange answers rather than as a missing setting.
 */
export function foBaseUrl(): string {
  const value = process.env.FABORCH_BASE_URL?.trim();
  if (!value) {
    throw new FabOrchNotConfiguredError(
      "FABORCH_BASE_URL is not set. FabInsight runs inside FabOrchestrator; " +
        "point this at that app (see .env.example).",
    );
  }
  return value.replace(/\/+$/, "");
}

/** True when the integration is configured at all. Used to pick a UI state. */
export function isFabOrchConfigured(): boolean {
  return !!process.env.FABORCH_BASE_URL?.trim();
}

export interface FoSession {
  token: string;
  expiresAt: string;
  user: { id: string; email: string; name: string | null };
}

/**
 * Sign in to FabOrchestrator with the operator's own FO credentials.
 *
 * Returns null for 401/403 — bad credentials, suspended, deleted. FO
 * distinguishes those three in its message; the caller does not pass that on,
 * for the same reason `lib/auth.ts` does not say which half was wrong.
 *
 * Throws for anything else, because "FO is down" and "your password is wrong"
 * must not read the same to somebody standing at the line.
 */
export async function foLogin(email: string, password: string): Promise<FoSession | null> {
  const res = await fetchFo("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    throw new FabOrchRequestError(await errorTextOf(res, "FabOrchestrator rejected the sign-in"), res.status);
  }

  const data = (await res.json()) as FoSession;
  if (!data?.token) {
    throw new FabOrchRequestError("FabOrchestrator returned no session token", 502);
  }
  return data;
}

/**
 * The MCP connections this FO user may use, filtered to the ones FO reports as
 * connected.
 *
 * **This is the call that decides whether "give me the yield for the last two
 * days" reaches real data.** `/api/chat` loads tools from `activeMcpIds` and
 * nothing else, so an empty list gets a model with no way to look anything up.
 * The product's own chat app does exactly this on mount and enables all of them
 * by default (`components/full-chat-app.tsx:722-746`); the PWA follows it
 * rather than inventing a selection rule.
 *
 * The cockpit's ask bar hardcodes `activeMcpIds: []` and therefore answers
 * without tools. That is the one thing on the cockpit this client does not
 * copy, and the reason is that a demo asking for yield needs the tools.
 *
 * A failure here is not fatal: FO answers without tools rather than not at all,
 * which is the product's own behaviour (it swallows this error too).
 */
export async function foConnectedMcpIds(token: string): Promise<string[]> {
  try {
    const res = await fetchFo("/api/mcp/connections", { headers: authHeader(token) });
    if (!res.ok) return [];
    const connections = (await res.json()) as { id: string; status: string }[];
    return Array.isArray(connections)
      ? connections.filter((c) => c?.status === "connected").map((c) => c.id)
      : [];
  } catch {
    return [];
  }
}

/** One turn of a conversation, in the shape `ChatRequestSchema` accepts. */
export interface FoUiMessage {
  role: "user" | "assistant";
  parts: { type: "text"; text: string }[];
}

/**
 * Forward a prompt to FabInsight and hand back FO's response **untouched**.
 *
 * The return value is the raw `Response` so the caller can pipe the body
 * through without buffering it: FO streams, tool calls can run for minutes, and
 * anything that waits for the whole answer before showing a character would
 * turn a live conversation into a spinner.
 *
 * `messages` carries the whole conversation. That is not a shortcut — FO's
 * route builds the model's context from the request body
 * (`convertToModelMessages(uiMessages)`), not from its database, so follow-up
 * questions work with no server state on either side. `conversationId` exists
 * and is deliberately not sent: it only adds FO-side persistence and S3 file
 * refs, neither of which this interface has.
 */
export async function foChat(options: {
  token: string;
  messages: FoUiMessage[];
  model?: string;
  /** `null` for the agents that build their own tools server-side. */
  activeMcpIds: string[] | null;
  /**
   * The agent's endpoint — `/api/chat`, `/api/modeling-agent/chat` or
   * `/api/modeling-agent/chat`. Comes from `FO_AGENTS`, never from a request.
   */
  path?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  // The three agents take different bodies, and sending a field an endpoint
  // does not read is not free: `model` and `activeMcpIds` are `/api/chat`'s
  // levers over which model answers and which tools it may call, and putting
  // them on a request to an agent that ignores them would make this file claim
  // an influence it does not have.
  const body: Record<string, unknown> =
    options.activeMcpIds === null
      ? { messages: options.messages }
      : {
          messages: options.messages,
          model: options.model || FO_DEFAULT_MODEL,
          activeMcpIds: options.activeMcpIds,
          // Both are FO's own defaults for a plain conversation, sent explicitly
          // so this request says what it is rather than depending on a default
          // we do not control. Web search is off; adaptive thinking is on for
          // the models that support it, which is what the product's chat does.
          webSearch: false,
          enableReasoning: true,
        };

  return fetchFo(options.path ?? "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(options.token) },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * `no-store` on every call: Next caches `fetch` in route handlers by default,
 * and a cached sign-in or a cached conversation turn is a defect, not a saving.
 */
async function fetchFo(path: string, init: RequestInit): Promise<Response> {
  const url = `${foBaseUrl()}${path}`;
  try {
    return await fetch(url, { ...init, cache: "no-store" });
  } catch (cause) {
    // The common one by far: FO is not running. Say so, with the address that
    // was tried, rather than leaking `fetch failed` to the screen.
    console.error("[faborch] request to", url, "failed:", cause);
    throw new FabOrchRequestError(
      `Could not reach FabOrchestrator at ${foBaseUrl()}. Is it running?`,
      503,
    );
  }
}

/** FO's error envelope varies by route; take its message if there is one. */
async function errorTextOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; userMessage?: string };
    return body?.userMessage || body?.error || fallback;
  } catch {
    return fallback;
  }
}
