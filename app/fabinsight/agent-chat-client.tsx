"use client";

/**
 * The session, the shell, and which conversation is on screen.
 *
 * Same page/screen split as the other screens: this holds the session, and
 * `components/fab/screens/agent-chat.tsx` holds the conversation. Unlike them
 * it fetches nothing on arrival — the conversation is a POST per turn, made
 * from the screen, because a chat's request is the user pressing send rather
 * than the page loading.
 *
 * One client for both agents. `/fabinsight` and `/backend-agent` differ in
 * which `FoAgent` they pass and, since 5 September, in whether that agent keeps
 * history. See `lib/faborch/agents.ts` for why they are still two doors.
 *
 * ── Where conversation history lives, and where it does not ────────────────
 * In FabOrchestrator. This file holds a **selection** — which of the operator's
 * FO threads is open — and nothing else. There is no local store, no cache and
 * no copy: `?c=<uuid>` in the URL is the entire client-side state, which is why
 * a reload restores the thread and why a thread can be linked to.
 *
 * That the URL is the state is also what makes the drawer simple. Picking a
 * conversation is a navigation, so the browser's Back button walks back through
 * the threads you opened, and nothing has to be synchronised.
 */

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/fab/app-shell";
import { AgentChat } from "@/components/fab/screens/agent-chat";
import { useSession } from "@/components/fab/use-session";
import { PageSkeleton } from "@/components/page-skeleton";
import type { FoAgentId } from "@/lib/faborch/agents";
import { FO_AGENTS } from "@/lib/faborch/agents";
import type { Turn } from "@/lib/faborch/conversation";

/** What `GET /api/faborch/conversations/[id]` answers with. */
interface LoadedThread {
  id: string;
  title: string;
  turns: Turn[];
  continuable: boolean;
}

export function AgentChatClient({
  agentId,
  initialPrompt = "",
}: {
  agentId: FoAgentId;
  initialPrompt?: string;
}) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const agent = FO_AGENTS[agentId];

  // `?c=` is read on the client rather than on the server, unlike `?q=`. The
  // difference is that this one *changes* while the screen is open — picking a
  // thread in the drawer is a client-side navigation — and a server-read prop
  // would not follow it.
  const search = useSearchParams();
  const selected = agent.keepsHistory ? search.get("c") : null;

  /**
   * The loaded thread, or null while nothing is selected.
   *
   * `pending` is separate from `thread === null` because the two look identical
   * and mean opposite things: one is "no conversation chosen", the other is "a
   * conversation is chosen and its messages are on their way". Conflating them
   * showed an empty transcript for the second, which reads as a thread that
   * lost its contents.
   */
  const [thread, setThread] = React.useState<LoadedThread | null>(null);
  const [pending, setPending] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);

  /**
   * A conversation this screen just created, whose turns are already on screen.
   *
   * Without this, asking the first question tore its own answer down. The
   * sequence: the question is sent, FabOrchestrator assigns an id, the id goes
   * into `?c=`, the effect below sees a selection it has not loaded, shows the
   * skeleton — and unmounting `AgentChat` aborts the stream that was still
   * arriving. The URL is right and the answer is gone.
   *
   * A thread created here needs no load, because it is what is being read.
   */
  const [createdId, setCreatedId] = React.useState<string | null>(null);

  /**
   * How many times New chat has been pressed.
   *
   * The thread's identity is normally its FabOrchestrator id, but two different
   * *new* conversations have no id to tell them apart — and a thread that has
   * just created one must not be re-keyed, or React would rebuild the screen in
   * the middle of the answer that created it. So a new conversation is keyed by
   * this counter and keeps that key for its whole life; only pressing New chat
   * changes it.
   */
  const [newChats, setNewChats] = React.useState(0);

  React.useEffect(() => {
    if (!selected) {
      setThread(null);
      setPending(false);
      setLoadFailed(false);
      return;
    }
    if (thread?.id === selected || createdId === selected) return;

    let cancelled = false;
    setPending(true);
    setLoadFailed(false);

    void (async () => {
      try {
        const res = await fetch(`/api/faborch/conversations/${encodeURIComponent(selected)}`, {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("llmatscale_auth_token") ?? ""}`,
          },
        });
        if (cancelled) return;
        if (!res.ok) {
          // A thread deleted on the FabOrchestrator website, or a stale link.
          // Reported rather than redirected: silently dropping somebody onto an
          // empty screen leaves them wondering what they did wrong.
          setLoadFailed(true);
          setThread(null);
          return;
        }
        const body = (await res.json()) as LoadedThread;
        if (!cancelled) setThread({ ...body, id: selected });
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setPending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, thread?.id, createdId]);

  /** Put a conversation in the URL. Replace, not push, when it is a new one. */
  const open = React.useCallback(
    (id: string | null, mode: "push" | "replace" = "push") => {
      const url = id ? `${pathname}?c=${encodeURIComponent(id)}` : pathname;
      if (mode === "replace") router.replace(url);
      else router.push(url);
    },
    [pathname, router],
  );

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
      onNewChat={() => {
        setNewChats((n) => n + 1);
        setCreatedId(null);
        open(null);
      }}
      history={
        agent.keepsHistory
          ? { selectedId: selected, onOpen: (id) => open(id) }
          : undefined
      }
    >
      {pending ? (
        <PageSkeleton />
      ) : (
        <AgentChat
          /**
           * The thread's identity, so React rebuilds the screen rather than
           * reconciling one conversation's turns into another's. `new` covers
           * the unselected case; without a distinct value, starting a new chat
           * from a loaded thread would reuse its component instance.
           */
          key={thread?.id ?? `new-${newChats}`}
          agent={agent}
          hasFabOrchSession={session.faborch}
          // Seeded only on a genuinely new conversation. `?q=` is a question
          // asked once on arrival; re-asking it inside a thread loaded from
          // history would put a question into somebody's saved conversation
          // that they did not ask there.
          initialPrompt={selected ? "" : initialPrompt}
          initialTurns={thread?.turns}
          conversationId={thread?.id ?? createdId}
          continuable={thread?.continuable ?? true}
          // FO assigns the id on the first question. Recorded before the URL
          // changes, so the effect above knows this thread is already on screen
          // and does not "load" it out from under its own answer.
          //
          // Replace rather than push: this is the same conversation gaining a
          // name, not a new place, and a push would make Back return to the
          // thread's own empty state.
          onConversationCreated={(id) => {
            setCreatedId(id);
            open(id, "replace");
          }}
        />
      )}

      {loadFailed ? (
        <p
          role="status"
          className="m-0 px-4 py-3 text-[12px] leading-[1.6] sm:px-6"
          style={{ background: "var(--status-amber-bg)", color: "var(--status-amber-ink)" }}
        >
          That conversation is no longer available in FabOrchestrator. Start a new
          chat, or pick another from the menu.
        </p>
      ) : null}
    </AppShell>
  );
}
