import { Suspense } from "react";
import type { Metadata } from "next";
import { PageSkeleton } from "@/components/page-skeleton";
import { AgentChatClient } from "../fabinsight/agent-chat-client";

/**
 * `/backend-agent` — the cockpit's AGENT · 04 card, opened from the PWA.
 *
 * The conversation is forwarded to FO's own `/api/chat` — verified against
 * upstream `e5a5abd` (2026-09-01): the cockpit's Back-end Agent card routes to
 * `/chat`, the same conversation service as FabInsight, and a separate
 * `/api/backend-agent/chat` exists in no upstream branch (an earlier local
 * build of one was superseded when the product folded custom dashboards into
 * `/chat`, gated by `isDashboardAdmin`). This screen is the card's own door
 * and framing; no dashboard logic, prompt or model call exists in this app.
 */

export const metadata: Metadata = {
  title: "Back-end Agent — FabOrchestrator",
  description:
    "FabOrchestrator's workflow-integration agent. Answers come from the " +
    "FabOrchestrator application and its conversation service.",
};

export default function Page() {
  // The shared client reads `?c=` with `useSearchParams`, which needs a
  // Suspense boundary. This agent keeps no history and will never have a `?c=`
  // to read — the boundary is here because the hook runs regardless, and a
  // statically rendered page without one fails the build.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AgentChatClient agentId="backend" />
    </Suspense>
  );
}
