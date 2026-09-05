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

import * as React from "react";
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

  /**
   * Which conversation is on screen. Bumping it is "New chat".
   *
   * A counter driving `key` rather than a reset action reaching into the
   * screen, because `AgentChat` holds six pieces of state — the reducer, the
   * composer's text, the data-connection count, the last prompt, the open
   * artifact, the `seeded` ref — and a reset that cleared five of them would be
   * a bug nobody found until a demonstration. Remounting is the only way to
   * clear all six with no list to keep in step. Nothing is persisted, so
   * nothing is lost that was not already on screen.
   *
   * This state lives *above* `AppShell`, so opening and closing the drawer
   * cannot touch it: the drawer's own open/closed flag is inside the shell, and
   * toggling it re-renders the shell without ever changing this key.
   */
  const [thread, setThread] = React.useState(0);

  // `useSession` redirects to `/login` when there is no token at all, so the
  // skeleton here covers the moment between mount and `/api/auth/me` answering.
  // Rendering the conversation before that would flash the "sign in to
  // FabOrchestrator" card at somebody who is already signed in to it.
  if (!session.ready) return <PageSkeleton />;

  return (
    <AppShell
      user={session.user}
      token={session.token}
      sessionExpiresAt={session.expiresAt}
      onNewChat={() => setThread((n) => n + 1)}
    >
      <AgentChat
        key={thread}
        agent={FO_AGENTS[agentId]}
        hasFabOrchSession={session.faborch}
        // Only the first thread is seeded. `?q=` is a question asked once, on
        // arrival; carrying it into a new chat would answer it again the moment
        // you asked for a blank one — which is the opposite of the request.
        initialPrompt={thread === 0 ? initialPrompt : ""}
      />
    </AppShell>
  );
}
