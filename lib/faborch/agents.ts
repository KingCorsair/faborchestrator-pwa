/**
 * The FabOrchestrator agents this PWA opens, and where each one lives in FO.
 *
 * ── Why a registry rather than three routes and three screens ───────────────
 * All three agents speak the **same wire protocol**. Each FO route ends in
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
 *   - `claudeai_athena/app/api/backend-agent/chat/route.ts`
 * and the names, categories and one-line descriptions are the cockpit's own,
 * from `components/cockpit/agent-cards.tsx` on `main`.
 */

export type FoAgentId = "insight" | "modeling" | "backend";

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
   * **Only `/api/chat` reads it.** That route loads the caller's tools from the
   * list and nothing else, so an empty list there means an agent that can look
   * nothing up. The other two build their own tools server-side from the
   * authenticated user (`buildUiAgentTools(user.id)` in the back-end agent),
   * so sending the field would be inert at best and misleading in this file at
   * worst.
   */
  sendMcpIds: boolean;
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
    chips: ["Yield variance · Line 4", "Compliance · Fab West", "Monthly OEE trend"],
    blurb:
      "FabInsight runs inside FabOrchestrator and answers with your tools, your role " +
      "and your data.",
  },
  modeling: {
    id: "modeling",
    slug: "modeling-agent",
    name: "Modeling Agent",
    foPath: "/api/modeling-agent/chat",
    sendMcpIds: false,
    chips: ["Build a blank Reason template", "What object types can I model?"],
    blurb:
      "The Modeling Agent prepares MES master-data files inside FabOrchestrator. " +
      "It requires the modeling_agent permission on your role.",
  },
  backend: {
    id: "backend",
    slug: "backend-agent",
    name: "Back-end Agent",
    foPath: "/api/backend-agent/chat",
    sendMcpIds: false,
    chips: ["Show scrap by line this week", "Build a yield dashboard"],
    blurb:
      "The Back-end Agent builds dashboards inside FabOrchestrator from a plain-language " +
      "description.",
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
