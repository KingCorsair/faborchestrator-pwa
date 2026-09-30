"use client";

/**
 * The cockpit's ask bar — and, once it has been asked something, the
 * conversation itself.
 *
 * Follows `claudeai_athena/components/cockpit/cockpit-ask.tsx` — 780px,
 * rounded, lifted, gradient **Ask** on the right, three suggestion chips
 * underneath, and the answer arriving in a bounded panel on this page rather
 * than on another one.
 *
 * ── It used to navigate, and that was the wrong shape (2026-09-05) ──────────
 * Until today this was a plain `<form method="get" action="/fabinsight">`: the
 * browser built `/fabinsight?q=…` and the question was asked on arrival. It
 * worked, and it did not match the product. FabOrchestrator's cockpit answers
 * where you asked, and leaving the cockpit to see an answer makes the front
 * door a menu rather than a place you can use — you lose the agent cards, the
 * Live ops panel and your place on the page in order to read one paragraph.
 *
 * **The GET form is still here and still correct.** `onSubmit` cancels it when
 * JavaScript is running; when it is not, the browser submits it and the old
 * behaviour happens exactly as before. Same for the chips, which are still real
 * links and still open in a new tab on a modified click. That is the whole
 * no-JavaScript story for the front door, kept for one `preventDefault`.
 *
 * ── No second chat implementation ───────────────────────────────────────────
 * The conversation is `AgentChat` in its `inline` variant — the same component
 * `/fabinsight` renders, with the same send path, the same stream reader, the
 * same progress states, the same failure notices and the same artifacts. The
 * variant changes layout and nothing else. A copy of that logic here would be a
 * second place for the stall watchdog, the 401 path and the artifact parser to
 * drift, and this app's whole argument is that there is one path to an answer.
 *
 * The question is handed over as `initialPrompt`, which `AgentChat` has always
 * sent on arrival — that is how `/fabinsight?q=…` worked. Nothing new was
 * needed to make the first question send itself.
 *
 * ── After the WP9 cutover it is a door, not a composer ─────────────────────
 * When the gateway is serving FabOrchestrator's own `/chat`, everything below
 * is replaced by a single control that opens it. That is not a smaller version
 * of this screen; it is the recognition that **this ask bar was always a copy
 * of FabOrchestrator's composer** — same 780px card, same gradient Ask, and,
 * as WP9 confirmed against production, the same placeholder text down to the
 * ellipsis. Keeping both would give the cockpit two composers wired to two
 * different chats, and an operator a different experience depending on whether
 * they typed here or tapped a card.
 *
 * **The typed question cannot travel, and that is why the input goes rather
 * than staying.** FabOrchestrator's chat ignores `?q=`, `?message=` and
 * `?prompt=` — all three verified against the production deployment, composer
 * still empty — so a box here could only throw away what was typed into it. An
 * input that discards your sentence is worse than no input at all. The one
 * honest alternative was to have this app's script type into FabOrchestrator's
 * composer after it hydrates, which is the same fragile class as the three
 * failed WP6 sidebar attempts and was rejected for the same reason.
 *
 * The cost is real and worth stating: the cockpit stops being ask-first, and a
 * question now begins one tap further in, in FabOrchestrator's own composer.
 * Amay made that call on 9 September against the two alternatives above.
 *
 * With the flag off, every line below runs exactly as it did.
 *
 * ── Why the session is read here rather than after the question ─────────────
 * `AgentChat` will not send until `hasFabOrchSession` is true, so resolving the
 * session only *after* somebody presses Ask would leave the first question
 * sitting for as long as `/api/pwa/auth/me` takes — on the deployment, long enough
 * to read as nothing having happened. Reading it at the top means the session
 * is already resolved by the time anyone finishes typing.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Send } from "lucide-react";
import { AgentChat } from "@/components/fab/screens/agent-chat";
import { useSession } from "@/components/fab/use-session";
import { FO_AGENTS } from "@/lib/faborch/agents";

/** The product's own chips, verbatim — `cockpit-ask.tsx:20-24`. */
const CHIPS = ["Yield variance · Line 4", "Compliance · Fab West", "Monthly OEE trend"];

/** A click the browser should still handle itself: new tab, new window. */
function isModifiedClick(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

export function Ask({ chatHref }: { chatHref: string }) {
  const session = useSession();
  const [asked, setAsked] = React.useState<string | null>(null);

  // The cutover. `chatHref` is decided on the server by
  // `lib/gateway/destinations.ts`; when it is FabOrchestrator's own chat, this
  // page offers the door and FabOrchestrator offers the composer.
  if (chatHref === "/chat") return <OpenChat href={chatHref} />;

  if (asked !== null) {
    return (
      <AgentChat
        variant="inline"
        agent={FO_AGENTS.insight}
        hasFabOrchSession={session.faborch}
        initialPrompt={asked}
      />
    );
  }

  return (
    <>
      <form
        method="get"
        action="/fabinsight"
        onSubmit={(e) => {
          e.preventDefault();
          // Read from the form rather than from React state: the input is
          // uncontrolled so that what is typed survives the gap between paint
          // and hydration — the defect `components/login-page.tsx` records in
          // full. Somebody who types here immediately must not lose it.
          const q = new FormData(e.currentTarget).get("q");
          const text = typeof q === "string" ? q.trim() : "";
          if (text) setAsked(text);
        }}
        className="fab-card mx-auto mt-[26px] flex w-full max-w-[780px] items-center gap-3 py-2.5 pl-5 pr-2.5"
      >
        <label htmlFor="cockpit-ask" className="sr-only">
          Ask FabInsight
        </label>
        <input
          id="cockpit-ask"
          name="q"
          type="text"
          autoComplete="off"
          placeholder="Ask anything, or describe a task to orchestrate…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[16px] outline-none placeholder:text-[var(--text-subtle)]"
          style={{ color: "var(--text-ink)" }}
        />
        <button
          type="submit"
          className="flex flex-none cursor-pointer items-center gap-[7px] border-0 px-[18px] py-[11px] text-[12px] font-bold text-white transition-transform hover:-translate-y-px"
          style={{
            borderRadius: 13,
            background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
            boxShadow: "var(--shadow-brand)",
          }}
        >
          Ask
          <Send size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </form>

      <div className="mt-4 flex flex-wrap justify-center gap-2.5">
        {CHIPS.map((chip) => (
          <Link
            key={chip}
            href={`/fabinsight?q=${encodeURIComponent(chip)}`}
            onClick={(e) => {
              // Still a link: a middle click or ⌘-click opens the conversation
              // screen in a new tab, which is what the markup promises and what
              // these were made links for in the first place.
              if (isModifiedClick(e)) return;
              e.preventDefault();
              setAsked(chip);
            }}
            className="fab-card fab-card-link px-[15px] py-2 text-[12px] font-bold no-underline"
            style={{ color: "var(--text-ink)", borderRadius: 20 }}
          >
            {chip}
          </Link>
        ))}
      </div>
    </>
  );
}

/**
 * The cockpit's primary action once FabOrchestrator owns the chat.
 *
 * Deliberately one control and not a row of them. The three suggestion chips
 * went with the composer: each carried a question in its URL, and a question
 * cannot be handed to FabOrchestrator's chat any more than a typed one can, so
 * a chip could only have opened the same empty screen three times over while
 * implying it would ask something.
 *
 * It keeps the ask bar's own shape — the 780px card, the gradient, the arrow —
 * because the cockpit's layout was built around that block, and because what
 * sits here should still read as "this is where you ask", which it is. It is a
 * plain `<Link>`: it works before hydration, opens in a new tab on a modified
 * click, and needs no JavaScript at all, which is more than the form it
 * replaced could say.
 */
function OpenChat({ href }: { href: string }) {
  return (
    <div className="mx-auto mt-[26px] w-full max-w-[780px]">
      <Link
        href={href}
        className="fab-card flex w-full items-center justify-between gap-3 py-[18px] pl-5 pr-[18px] no-underline transition-transform hover:-translate-y-px"
        style={{ color: "var(--text-ink)" }}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-9 w-9 flex-none items-center justify-center"
            style={{
              borderRadius: 11,
              background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
              boxShadow: "var(--shadow-brand)",
            }}
          >
            <Send size={16} strokeWidth={2} color="white" aria-hidden="true" />
          </span>
          <span className="min-w-0 text-left">
            <span className="block text-[15px] font-bold">Ask FabInsight</span>
            <span className="block truncate text-[12px]" style={{ color: "var(--text-subtle)" }}>
              Questions, dashboards and files, in FabOrchestrator
            </span>
          </span>
        </span>
        <ArrowRight size={18} strokeWidth={2} aria-hidden="true" style={{ color: "var(--text-subtle)" }} />
      </Link>
    </div>
  );
}
