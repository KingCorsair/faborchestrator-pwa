import { Suspense } from "react";
import type { Metadata } from "next";
import { PageSkeleton } from "@/components/page-skeleton";
import { AgentChatClient } from "./agent-chat-client";

/**
 * `/fabinsight` — FabOrchestrator's agent, opened from the PWA.
 *
 * A thin server component whose only job is to read `?q=` and hand it down,
 * following the pattern `/login` established for `?next=` and `/orders` for
 * `?order=`: reading the query on the server rather than with
 * `useSearchParams`, which would force a Suspense boundary (CLAUDE.md, thin-ice
 * item 2).
 *
 * `?q=` is how the landing page's ask bar works. The cockpit answers inline
 * under its own ask bar; here the answer belongs on the conversation screen, so
 * the question travels in the URL and is asked on arrival. It also means a
 * question can be linked — `/fabinsight?q=Give me the yield for the last two
 * days` opens the demo at its first step.
 *
 * Like `/orders`, reading `searchParams` costs the static render (`ƒ`, not
 * `○`). Free here for the same reason: the screen is behind a session, so its
 * prerendered HTML was only ever `PageSkeleton`.
 */

export const metadata: Metadata = {
  title: "FabInsight — FabOrchestrator",
  description:
    "Ask FabOrchestrator about your operations. Questions are answered by the " +
    "FabOrchestrator application and its agent.",
};

/**
 * A prompt is free text, so there is nothing to validate it against the way
 * `OrderNumberSchema` validates `?order=`. It is capped and trimmed instead:
 * the cap matches the per-part limit in `FabInsightRequestSchema`, so a URL
 * that would be rejected by the route cannot be seeded into the composer and
 * silently fail on send. React escapes it on render, and it reaches FO as a
 * message rather than as anything executable.
 */
function safePrompt(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim().slice(0, 20_000) : "";
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    // `?c=` — which stored conversation is open — is read on the *client* with
    // `useSearchParams`, unlike `?q=` above. The difference is that it changes
    // while the screen is open: picking a thread in the drawer is a client-side
    // navigation, and a server-read prop would not follow it. That hook needs a
    // Suspense boundary, which is this. The fallback is the same skeleton the
    // client shows while the session resolves, so nothing flashes.
    <Suspense fallback={<PageSkeleton />}>
      <AgentChatClient agentId="insight" initialPrompt={safePrompt((await searchParams).q)} />
    </Suspense>
  );
}
