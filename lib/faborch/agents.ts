/**
 * The FabOrchestrator agents this PWA opens, and where each one lives in FO.
 *
 * ── Why a registry rather than three routes and three screens ───────────────
 * All the agents speak the **same wire protocol**. Each FO route ends in
 * `createUIMessageStreamResponse` over a body of `{ messages }`, authenticated
 * with the same bearer token — so `lib/faborch/stream.ts` reads all of them and
 * one proxy forwards all of them. What actually differs between them is four
 * strings and one boolean, which is this file.
 *
 * Three copies of the proxy would be three places to keep the token handling,
 * the 401-expiry path and the no-buffering headers correct, and the day FO
 * changes one of those, two of the copies would be wrong.
 *
 * ── This adds no AI to the demo, and that distinction is the rule ───────────
 * CLAUDE.md's "no generic chatbot" forbids *this app* growing an assistant of
 * its own. Every agent below is **FabOrchestrator's**, reached where the
 * product puts it. This app contributes no prompt, no model, no tool and no
 * manufacturing logic to any of them — the test in "What NOT to build" is
 * *could this change what the answer says?*, and forwarding cannot.
 *
 * ── Where these values come from ────────────────────────────────────────────
 * `foPath` is read from the product, not guessed:
 *   - `claudeai_athena/app/api/chat/route.ts`
 *   - `claudeai_athena/app/api/modeling-agent/chat/route.ts`
 * and the names, categories and one-line descriptions are the cockpit's own,
 * from `components/cockpit/agent-cards.tsx` on `main`.
 *
 * ── Verified against upstream `e5a5abd` (2026-09-01) ────────────────────────
 * The cockpit's AGENT · 04 "Back-end Agent" card routes to `/chat` — the same
 * endpoint as FabInsight. A separate `/api/backend-agent/chat` service exists
 * in NO upstream branch; the earlier local build of one was superseded when
 * the product folded custom dashboards into `/chat` itself (gated by
 * `isDashboardAdmin`, returned as `canCreateDashboards` at login).
 *
 * ── The Master Data Load Agent is deliberately absent (2026-09-02) ──────────
 * AGENT · 03 exists in FabOrchestrator, at `/api/modeling-agent/chat`, with its
 * own `modeling_agent` role gate. **Jothi confirmed on 2 September that it does
 * not belong in this app.** Loading MES master data is not a thing a supervisor
 * does one-handed on a fab floor: the real workflow is file upload, staged
 * review and a load step, none of which this app carries.
 *
 * Two consequences worth stating here, because they are easy to rediscover the
 * hard way:
 *
 *  - **Every agent below now shares `/api/chat`.** There is nothing left to
 *    route *between*, which is why the landing page's ask box needs no routing
 *    logic to satisfy the ask-first requirement.
 *  - **No exposed agent is permission-gated.** `modeling_agent` was the only
 *    one, and `/api/chat` never answers 403 itself. The proxy still relays a
 *    403 verbatim if FO ever starts sending one.
 *
 * The card stays on the landing page, greyed, saying the platform has it and
 * this app does not open it — the same treatment Workflows, Sites and Reports
 * get. Removing it from view would misrepresent the product.
 */

export type FoAgentId = "insight" | "backend";

export interface FoAgent {
  id: FoAgentId;
  /** The route this agent gets in *this* app. */
  slug: string;
  name: string;
  /** FabOrchestrator's own endpoint, relative to `FABORCH_BASE_URL`. */
  foPath: string;
  /**
   * Whether to send `activeMcpIds`.
   *
   * **Only `/api/chat` reads it**, loading the caller's tools from the list and
   * nothing else, so an empty list there means an agent that can look nothing
   * up. Every agent in this registry is currently on `/api/chat`, so the field
   * is `true` throughout — it is kept rather than collapsed because it records
   * a real distinction in FO's contract: `/api/modeling-agent/chat` builds its
   * own CMF tools server-side and ignores the field entirely. Anyone adding a
   * non-`/api/chat` agent needs to know that before they send it.
   */
  sendMcpIds: boolean;
  /**
   * Whether this agent's conversations are stored in FabOrchestrator.
   *
   * Not a capability of this app — a fact about the product. FO partitions its
   * conversation store by an `agent` column (`prisma/schema.prisma:109`), and
   * FabInsight's bucket is `"chat"`, the same one the FabOrchestrator website
   * reads. That is what makes a thread started on a phone appear in the
   * website's sidebar, and one started there open here.
   *
   * The Back-end Agent is `false` because **the product's own Back-end Agent
   * stores nothing.** `components/agent-chat/backend-agent-app.tsx:25` says it
   * outright — "The sidebar has no conversation history because this agent has
   * none: its artifacts are dashboards, not saved chats" — and a live read on
   * 5 September confirmed it: `GET /api/conversations?agent=backend-agent`
   * returns zero rows for an account holding 104 in `chat` and 35 in
   * `modeling`. Giving it history here would invent a behaviour the product
   * does not have, and would file its threads under FabInsight's list.
   */
  keepsHistory: boolean;
  /** Shown on the empty state. FabInsight's are the cockpit ask bar's own. */
  chips: string[];
  blurb: string;
}

export const FO_AGENTS: Record<FoAgentId, FoAgent> = {
  insight: {
    id: "insight",
    slug: "fabinsight",
    name: "FabInsight",
    foPath: "/api/chat",
    sendMcpIds: true,
    keepsHistory: true,
    chips: ["Yield variance · Line 4", "Compliance · Fab West", "Monthly OEE trend"],
    blurb:
      "FabInsight runs inside FabOrchestrator and answers with your tools, your role " +
      "and your data.",
  },
  backend: {
    id: "backend",
    slug: "backend-agent",
    name: "Back-end Agent",
    // The cockpit's own card routes here too — AGENT · 04 is a framing of
    // `/chat`, not a separate service (see the verification note above).
    foPath: "/api/chat",
    sendMcpIds: true,
    keepsHistory: false,
    chips: ["Show scrap by line this week", "Build a yield dashboard"],
    blurb:
      "The Back-end Agent is FabOrchestrator's workflow-integration framing of the " +
      "same conversation service that powers FabInsight.",
  },
};

/**
 * Resolves the `[agent]` path segment.
 *
 * The proxy forwards to a URL built from `foPath`, so an unrecognised segment
 * must never reach it — same rule as `lib/return-path.ts` and
 * `lib/selected-order.ts`: a value from the URL selects from a fixed set, it
 * never *becomes* the destination.
 */
export function foAgent(id: string): FoAgent | null {
  return (FO_AGENTS as Record<string, FoAgent>)[id] ?? null;
}
