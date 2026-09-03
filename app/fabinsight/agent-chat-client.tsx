"use client";

/**
 * The session and the shell around an agent conversation.
 *
 * Same page/screen split as the other screens: this holds the session, and
 * `components/fab/screens/agent-chat.tsx` holds the conversation. Unlike them it
 * fetches nothing here — the conversation is a POST per turn, made from the
 * screen, because a chat's request is the user pressing send rather than the
 * page arriving.
 *
 * One client for both agents. `/fabinsight` and `/backend-agent` differ only in
 * which `FoAgent` they pass — and, since 2 September, both reach the same FO
 * service. See `lib/faborch/agents.ts` for why they are still two doors.
 */

import { AppShell } from "@/components/fab/app-shell";
import { AgentChat } from "@/components/fab/screens/agent-chat";
import { useSession } from "@/components/fab/use-session";
import { PageSkeleton } from "@/components/page-skeleton";
import type { FoAgentId } from "@/lib/faborch/agents";
import { FO_AGENTS } from "@/lib/faborch/agents";

export function AgentChatClient({
  agentId,
  initialPrompt = "",
}: {
  agentId: FoAgentId;
  initialPrompt?: string;
}) {
  const session = useSession();

  // `useSession` redirects to `/login` when there is no token at all, so the
  // skeleton here covers the moment between mount and `/api/auth/me` answering.
  // Rendering the conversation before that would flash the "sign in to
  // FabOrchestrator" card at somebody who is already signed in to it.
  if (!session.ready) return <PageSkeleton />;

  return (
    <AppShell user={session.user} token={session.token} sessionExpiresAt={session.expiresAt}>
      <AgentChat
        agent={FO_AGENTS[agentId]}
        hasFabOrchSession={session.faborch}
        initialPrompt={initialPrompt}
      />
    </AppShell>
  );
}
