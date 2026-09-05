"use client";

/**
 * An agent conversation — the screen, and nothing behind it.
 *
 * ── What this screen is ─────────────────────────────────────────────────────
 * A window onto one of FabOrchestrator's own agents. Everything it shows was
 * computed by the running FO application: this file holds a `messages` array,
 * posts it to `/api/faborch/[agent]/chat`, and appends what streams back. There
 * is no prompt, no model, no MES query and no manufacturing rule anywhere in
 * it. Ask it for the yield and the yield is FO's answer, from FO's tools,
 * against FO's data.
 *
 * ── One screen, every agent ─────────────────────────────────────────────────
 * FabInsight and the Back-end Agent are the same screen with a different
 * `agent` prop, because every FO chat endpoint takes `{ messages }` and answers
 * with the same stream. What differs is the name, the chips and the endpoint —
 * `lib/faborch/agents.ts`. A copy of this conversation per agent would be one
 * more place for the abort handling, the seeding effect and the states to
 * drift.
 *
 * That is also why it looks like a chat while CLAUDE.md says "no generic
 * chatbot". The prohibition is against *this app* growing an AI feature of its
 * own — a second assistant, competing with the platform it fronts. This is the
 * opposite: it is the product's existing agent, reached from the place the
 * product puts it.
 *
 * ── Where the conversation's rules live ─────────────────────────────────────
 * Not here. `lib/faborch/conversation.ts` holds every transition — what a stop
 * keeps, what an empty answer leaves behind, when a thread is full — as a
 * reducer, so they can be tested without rendering React. This file renders
 * what that produces and owns the network call.
 *
 * ── Four states, and each says what to do next ──────────────────────────────
 *  - **not configured** — nobody set `FABORCH_BASE_URL`. A deployment fault,
 *    named as one, because an operator cannot fix it and should not try.
 *  - **unavailable** — FO is down, or answered with an error of its own (a role
 *    restriction and a daily quota both arrive this way, and both are worth
 *    reading verbatim).
 *  - **expired** — FO dropped the session. Offers sign-in.
 *  - **full** — the thread has reached the number of messages the route
 *    accepts. Offers a new conversation, and keeps this one on screen.
 *
 * ── What it deliberately does not have ──────────────────────────────────────
 * No conversation list, no artifacts panel, no file upload, no model picker, no
 * MCP picker, no reasoning panel. The product's `full-chat-app.tsx` is 2,430
 * lines and has all of them; this is the minimum that lets somebody ask a
 * question, read the answer and ask a follow-up. Anything more is a second
 * implementation of a screen that already exists in FO.
 */

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Copy,
  Database,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import Link from "next/link";
import type { FoAgent } from "@/lib/faborch/agents";
import type { ConversationPhase, Failure, Turn } from "@/lib/faborch/conversation";
import {
  EMPTY_CONVERSATION,
  capacityFailure,
  capacityIssue,
  conversationReducer,
  historyFor,
  toFoMessages,
} from "@/lib/faborch/conversation";
import {
  NEEDS_SIGN_IN,
  NEXT_STEP,
  RETRYABLE,
  splitErrorId,
  type PwaErrorCode,
} from "@/lib/faborch/errors";
import { ArtifactSheet } from "@/components/fab/artifact-sheet";
import { ArtifactTile } from "@/components/fab/artifact-tile";
import { segmentMessageText, type FoArtifact } from "@/lib/faborch/artifacts";
import { readFoStream } from "@/lib/faborch/stream";

/**
 * Where this conversation is being drawn.
 *
 * ── `"inline"` added 2026-09-05, and it changes layout only ─────────────────
 * The cockpit's ask bar now answers where it is asked, the way
 * FabOrchestrator's own does (`components/cockpit/cockpit-ask.tsx`). That is a
 * different *shape* for the same conversation, not a different conversation —
 * so it is a prop here rather than a second implementation somewhere else.
 *
 * Everything that decides what the operator actually gets is shared and
 * untouched by this flag: the send path, the stream reader, the reducer, the
 * progress states, the failure notices with their retry, the artifacts, the
 * data-connection count. A copy of that on the landing page would be a second
 * place for the 45-second stall watchdog to be wrong.
 *
 * Four things differ, all of them CSS or omission:
 *
 *   screen   owns the viewport: a full-height flex column with its own
 *            scrolling pane and a composer pinned to the bottom above the
 *            home indicator.
 *   inline   sits in a scrolling document: the transcript is a bounded card
 *            that appears only once there is something in it, and the composer
 *            is an ordinary block under it.
 *
 * `Opening` is suppressed inline because the landing page already carries the
 * hero and the suggestion chips it would duplicate.
 */
export type AgentChatVariant = "screen" | "inline";

/**
 * The default for `initialTurns`.
 *
 * A module constant rather than `[]` in the parameter list: a fresh array
 * literal is a new identity on every render, and it feeds the effect that
 * hydrates the thread. That effect is guarded by a ref so it would not have
 * looped, but a dependency that changes every render is a trap left for the
 * next person to remove the guard.
 */
const NO_TURNS: Turn[] = [];

export function AgentChat({
  agent,
  hasFabOrchSession,
  initialPrompt = "",
  variant = "screen",
  initialTurns = NO_TURNS,
  conversationId = null,
  continuable = true,
  onConversationCreated,
}: {
  agent: FoAgent;
  hasFabOrchSession: boolean;
  initialPrompt?: string;
  variant?: AgentChatVariant;
  /** A thread loaded from FabOrchestrator, already reduced by `history.ts`. */
  initialTurns?: Turn[];
  /** The FO conversation to continue, or null to start one on first send. */
  conversationId?: string | null;
  /**
   * Whether this thread can be added to.
   *
   * False when a stored answer is longer than `MAX_TEXT`, which the route
   * reports. Such a thread can be read but not continued: posting it back as
   * context would be rejected, and truncating what FabOrchestrator said to make
   * it fit would misrepresent the product.
   */
  continuable?: boolean;
  /** Called once, with the id FO assigned, when the first question creates one. */
  onConversationCreated?: (id: string) => void;
}) {
  const [state, dispatch] = React.useReducer(conversationReducer, EMPTY_CONVERSATION);
  const [input, setInput] = React.useState("");

  /**
   * How many data connections FabOrchestrator loaded for this operator, as the
   * proxy reported them. Null until a turn has been answered.
   *
   * This is shown, not enforced. WP8's line was "refuse to send a turn with an
   * empty tool list", and measurement says that would be wrong: with an empty
   * list FabOrchestrator still answers yield, scrap and OEE from real plant
   * data, because those go through its own metric path and never touch MCP.
   * What an empty list actually costs is every OTHER plant question — WIP,
   * lots, equipment, throughput — so the honest thing is to say which half is
   * missing rather than to block the half that works.
   */
  const [dataConnections, setDataConnections] = React.useState<number | null>(null);

  /**
   * The last question asked, so a failure can offer to ask it again.
   *
   * Kept here rather than read back off the turns: a failure before the answer
   * began drops the placeholder assistant turn, and after a `reset` there are
   * no turns at all — but in both cases the question is still the thing the
   * operator wanted answered.
   */
  const [lastPrompt, setLastPrompt] = React.useState<string | null>(null);

  /** The artifact being read full-screen, if any. */
  const [openArtifact, setOpenArtifact] = React.useState<FoArtifact | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  /**
   * The live conversation, readable from a callback that must not be rebuilt.
   *
   * `send` needs the turns so far in order to post them. Taking them from
   * `state` would put `state` in the dependency array and rebuild `send` on
   * every token — the exact hazard this package was here to remove. A mirror
   * ref is read at call time instead, so `send` is stable for as long as the
   * agent is. Written from an effect rather than during render, and declared
   * first so it is filled before any effect that sends.
   */
  const live = React.useRef(state);
  React.useEffect(() => {
    live.current = state;
  }, [state]);

  /**
   * Whether a turn is already running.
   *
   * Separate from `state.busy`, and not derived from it, because the guard has
   * to hold **within a single tick**: two Enters in the same frame both read a
   * `busy` that React has not re-rendered yet, and both send. A ref set before
   * the request is the only version of this check that closes that window.
   */
  const inFlight = React.useRef(false);

  /**
   * The FabOrchestrator conversation this thread is being written into.
   *
   * A ref, not state, for the same reason `live` is a ref: `send` must stay
   * stable for the lifetime of the screen. Putting the id in its dependency
   * array would rebuild `send` the moment a conversation is created — in the
   * middle of the very turn that created it.
   *
   * Null means the turn is not persisted, which is the correct state for the
   * Back-end Agent always, and for FabInsight until its first question.
   */
  const conversationRef = React.useRef<string | null>(conversationId ?? null);
  React.useEffect(() => {
    conversationRef.current = conversationId ?? null;
  }, [conversationId]);

  /**
   * The "a conversation now exists" callback, kept current without rebuilding
   * `send`.
   *
   * The caller passes a new closure on every render. Captured directly, `send`
   * would hold the first one forever — which happens to work today and would
   * break silently the first time that callback closed over changing state.
   * Same mirror-ref treatment as `live`, and for the same reason.
   */
  const onCreatedRef = React.useRef(onConversationCreated);
  React.useEffect(() => {
    onCreatedRef.current = onConversationCreated;
  }, [onConversationCreated]);

  /**
   * A thread loaded from FabOrchestrator, put on screen.
   *
   * Runs on mount only. The screen is remounted by `key` whenever the thread
   * changes — New chat, or picking a different conversation — so there is no
   * case where turns arrive for a conversation already in progress, and no need
   * to reconcile one thread's answer with another's.
   */
  const hydrated = React.useRef(false);
  React.useEffect(() => {
    if (hydrated.current || initialTurns.length === 0) return;
    hydrated.current = true;
    dispatch({ type: "hydrate", turns: initialTurns });
  }, [initialTurns]);

  const send = React.useCallback(
    (text: string) => {
      const prompt = text.trim();
      if (!prompt || inFlight.current || !hasFabOrchSession) return;

      // The route enforces these too. Checked here so the wall is visible
      // before the user walks into it — see `capacityIssue`.
      const issue = capacityIssue(live.current.turns, prompt);
      if (issue) {
        dispatch({ type: "failed", failure: capacityFailure(issue) });
        return;
      }

      const userId = `u-${Date.now()}`;
      const assistantId = `a-${Date.now()}`;
      const history = historyFor(live.current.turns, prompt, userId);

      setInput("");
      setLastPrompt(prompt);
      inFlight.current = true;
      dispatch({ type: "ask", prompt, userId, assistantId });

      const controller = new AbortController();
      abortRef.current = controller;

      void (async () => {
        try {
          const bearer = `Bearer ${localStorage.getItem("llmatscale_auth_token") ?? ""}`;

          /**
           * Start the FabOrchestrator conversation, on the first question only.
           *
           * Lazily, exactly as the product does it (`full-chat-app.tsx:1425`).
           * Creating one when New chat is pressed instead would fill the
           * FabOrchestrator website's sidebar with identical empty "New Chat"
           * rows every time somebody opened the drawer and changed their mind.
           *
           * A failure here is not the operator's problem: `id` comes back null,
           * the turn goes unpersisted, and the answer arrives exactly as it did
           * before any of this existed. History is an enhancement; answering is
           * the product.
           */
          if (agent.keepsHistory && !conversationRef.current) {
            try {
              const made = await fetch("/api/faborch/conversations", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: bearer },
                body: JSON.stringify({ title: prompt }),
                signal: controller.signal,
              });
              const body = (await made.json().catch(() => null)) as { id?: string } | null;
              if (made.ok && typeof body?.id === "string") {
                conversationRef.current = body.id;
                onCreatedRef.current?.(body.id);
              }
            } catch {
              /* Unpersisted is a worse conversation, not a broken one. */
            }
          }

          const res = await fetch(`/api/faborch/${agent.id}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: bearer },
            // FO builds the model's context from this array rather than from
            // its own database, so the whole conversation travels and follow-up
            // questions work with no server state on either side.
            //
            // `conversationId` decides only whether FO writes the turn down.
            // The route proves it belongs to this operator before forwarding it
            // — FO's own `/api/chat` does not check.
            body: JSON.stringify({
              messages: toFoMessages(history),
              conversationId: conversationRef.current,
            }),
            signal: controller.signal,
          });

          const connectionHeader = res.headers.get("X-FabOrch-Data-Connections");
          if (connectionHeader !== null) {
            const count = Number(connectionHeader);
            if (Number.isFinite(count)) setDataConnections(count);
          }

          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => null)) as Partial<Failure> | null;
            dispatch({
              type: "failed",
              failure: {
                code: body?.code ?? "faborch_unavailable",
                message:
                  (body as unknown as { error?: string })?.error ??
                  `${agent.name} could not answer that.`,
              },
            });
            return;
          }

          await readFoStream(res.body, (event) => {
            if (event.type === "text") {
              dispatch({ type: "delta", delta: event.delta });
            } else if (event.type === "tool") {
              dispatch({ type: "activity", name: event.name });
            } else if (event.type === "stalled") {
              // Not a failure. The stream is still open and FO may still be
              // working — this only stops the screen claiming progress it has
              // no evidence for.
              dispatch({ type: "stalled" });
            } else {
              // Mid-stream failure. Whatever already arrived is kept and marked
              // incomplete — the reducer decides that, not this callback.
              const { message, errorId } = splitErrorId(event.message);
              dispatch({
                type: "failed",
                failure: { code: "faborch_unavailable", message, errorId },
              });
            }
          });

          dispatch({ type: "settled" });
        } catch (error) {
          if ((error as Error)?.name === "AbortError") {
            dispatch({ type: "stopped" });
            return;
          }
          // The reader threw: the connection went away part-way through. Its own
          // code, because "retry" is the right offer here and is not the right
          // offer for a quota or a permission.
          dispatch({
            type: "failed",
            failure: {
              code: "connection_lost",
              message: "The connection to FabOrchestrator dropped part-way through the answer.",
            },
          });
        } finally {
          inFlight.current = false;
          abortRef.current = null;
        }
      })();
    },
    // `onConversationCreated` is deliberately absent, and reached through
    // `onCreatedRef` instead: the caller passes a fresh closure on every render,
    // and depending on it would rebuild `send` constantly — the exact hazard the
    // `live` ref removed.
    [agent, hasFabOrchSession],
  );

  /** The prompt typed on the landing page's ask bar, asked on arrival. */
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !initialPrompt.trim() || !hasFabOrchSession) return;
    seeded.current = true;
    send(initialPrompt);
  }, [initialPrompt, hasFabOrchSession, send]);

  /**
   * A turn in flight is abandoned when this screen goes.
   *
   * Added with "New chat" (5 September), which discards the conversation by
   * remounting. Without it the fetch behind the old thread keeps running and
   * keeps FabOrchestrator generating an answer nobody will ever see — on a
   * phone, over a metered connection, for a question the operator has visibly
   * cancelled. It applies just as well to navigating away mid-answer, which
   * had the same leak and no one had noticed.
   */
  React.useEffect(() => () => abortRef.current?.abort(), []);

  /** Follow the answer down as it streams, the way the product's chat does. */
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.turns, state.activity]);

  const empty = state.turns.length === 0;
  const inline = variant === "inline";

  /**
   * Inline, the transcript card appears only when it has something to say —
   * the same rule as `hasMessages &&` on the product's cockpit. An empty
   * bordered box under the ask bar reads as a thing that failed to load.
   *
   * `state.busy` is in the condition because the first turn is dispatched and
   * the panel must already be open to show it; `state.failure` because a turn
   * that fails before the answer starts drops its placeholder, and the notice
   * would otherwise have nowhere to appear.
   */
  const showTranscript = !inline || !empty || state.busy || state.failure !== null;

  return (
    <div
      // `max-w-[780px]` so the transcript lines up with the ask bar above it,
      // and `text-left` because the cockpit centres its hero and this is prose.
      className={
        inline
          ? "mx-auto mt-[26px] flex w-full max-w-[780px] flex-col gap-4 text-left"
          : "fab flex h-full min-h-0 flex-col"
      }
      style={inline ? undefined : { background: "var(--page-surface)" }}
    >
      <div
        ref={scrollRef}
        className={
          inline
            ? // Bounded rather than growing without limit: the cockpit continues
              // below this, and a long answer that pushed the agent cards off
              // the page would hide the rest of the product. `55vh` keeps the
              // ask bar and the start of the answer on screen together at
              // 360×640, where a fixed 420px would not.
              (showTranscript ? "fab-card max-h-[min(420px,55vh)] overflow-y-auto overscroll-contain px-4 py-4" : "hidden")
            : "min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"
        }
      >
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-[18px]">
          {empty && !inline ? (
            <Opening agent={agent} onPick={send} disabled={!hasFabOrchSession || state.busy} />
          ) : null}

          {state.turns.map((turn) =>
            turn.role === "user" ? (
              <UserTurn key={turn.id} text={turn.text} />
            ) : (
              <AssistantTurn
                key={turn.id}
                text={turn.text}
                incomplete={turn.incomplete}
                onOpenArtifact={setOpenArtifact}
              />
            ),
          )}

          {state.busy ? <Working phase={state.phase} activity={state.activity} /> : null}

          {dataConnections === 0 ? <NoDataConnections /> : null}

          {state.failure ? (
            <FailureNotice
              agent={agent}
              failure={state.failure}
              onReset={() => dispatch({ type: "reset" })}
              onRetry={lastPrompt ? () => send(lastPrompt) : undefined}
            />
          ) : null}
        </div>
      </div>

      {/* Full screen, above everything, so a dashboard gets the whole phone. */}
      {openArtifact ? (
        <ArtifactSheet artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
      ) : null}

      {/* A thread FabOrchestrator stored, carrying an answer longer than one
          message may be. It can be read; it cannot be added to, because posting
          it back as context would be rejected and shortening what FO said to
          make it fit would misrepresent the product. Said plainly, with the way
          out, rather than leaving a composer that fails on every press. */}
      {!continuable ? (
        <p
          className="m-0 flex-none border-t px-4 py-3 text-[12px] leading-[1.6] sm:px-6"
          style={{
            borderColor: "var(--border-light)",
            background: "var(--status-amber-bg)",
            color: "var(--status-amber-ink)",
          }}
          role="status"
        >
          This conversation is too long to continue here. You can read it, and
          start a new chat to ask something else.
        </p>
      ) : (
        <Composer
          agent={agent}
          value={input}
          onChange={setInput}
          onSubmit={() => send(input)}
          onStop={() => abortRef.current?.abort()}
          busy={state.busy}
          disabled={!hasFabOrchSession}
          inline={inline}
        />
      )}
    </div>
  );
}

/* ── Turns ───────────────────────────────────────────────────────────────── */

function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] px-4 py-[10px] text-[14px] whitespace-pre-wrap"
        style={{
          background: "var(--brand-indigo-bg)",
          color: "var(--text-ink)",
          borderRadius: "var(--r-panel)",
        }}
      >
        {text}
      </div>
    </div>
  );
}

/**
 * The answer, rendered as Markdown.
 *
 * `react-markdown` + `remark-gfm` rather than a hand-rolled renderer, and that
 * is "reuse before adding" pointing *toward* a dependency for once: the product
 * renders assistant output with exactly these two
 * (`claudeai_athena/components/prompt-kit/markdown.tsx`), and an agent asked for
 * two days of yield answers with a GFM table. Its `remark-math`/`rehype-katex`
 * and syntax-highlighted code blocks are left behind — this screen has no
 * equations and no code.
 *
 * Styling is `.fab-md` in `app/globals.css`, so the answer is set in the
 * product's own type scale rather than in browser defaults.
 */
function AssistantTurn({
  text,
  incomplete,
  onOpenArtifact,
}: {
  text: string;
  incomplete?: boolean;
  onOpenArtifact: (artifact: FoArtifact) => void;
}) {
  /*
    An answer is not always one block of prose.

    When the operator asks for something visual, FabOrchestrator writes a whole
    document into the middle of the text stream inside an <antArtifact> tag.
    Rendered as markdown that is a wall of raw HTML, which is what this screen
    used to show. Split into segments, the prose stays prose and the document
    becomes a tile.

    Recomputed on every token, which is why the parser has a fast path for text
    with no tag in it — the overwhelming majority of turns.
  */
  const { segments } = React.useMemo(() => segmentMessageText(text), [text]);
  return (
    <div className="flex gap-3">
      <span
        className="grid h-7 w-7 flex-none place-items-center text-white"
        style={{
          borderRadius: "var(--r-chip)",
          background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
        }}
        aria-hidden="true"
      >
        <Sparkles size={15} strokeWidth={2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[10px]">
        {segments.map((segment, i) =>
          segment.type === "text" ? (
            <div className="fab-md" key={`t${i}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.content}</ReactMarkdown>
            </div>
          ) : (
            <ArtifactTile
              key={segment.artifact.identifier || `a${i}`}
              artifact={segment.artifact}
              isStreaming={segment.isStreaming}
              onOpen={() => onOpenArtifact(segment.artifact)}
            />
          ),
        )}

        {/* An answer cut off part-way is true as far as it goes and misleading
            as a whole: a yield table that stopped after four rows looks like a
            complete four-row table, and nothing in the text says otherwise.
            This is the only thing that does. */}
        {incomplete ? (
          <p
            className="m-0 mt-[8px] flex items-center gap-[6px] text-[12px] font-bold"
            style={{ color: "var(--status-amber-ink)" }}
          >
            <AlertTriangle size={13} strokeWidth={2.4} aria-hidden="true" />
            This answer stopped part-way and is incomplete.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Waiting.
 *
 * When FO starts a tool it names it, and the name is shown — an operator
 * watching a fifteen-second pause should be able to tell that something is
 * being looked up rather than that the app has hung. The tool names are FO's
 * own (its MCP servers expose them); they are shown as sent rather than
 * prettified, because a name this app invented for somebody else's tool would
 * be a name nobody could search for.
 */
/**
 * What is happening, as three distinct things.
 *
 * Dots alone say the same at second 2 and second 90, which is how a working
 * fifteen-second tool call comes to look like a hang. Each state here answers a
 * different question the operator is actually asking:
 *
 *  - **waiting**   — did it hear me?
 *  - **working**   — is it doing something? (and what: FO's own tool name)
 *  - **answering** — is it nearly there?
 *  - **stalled**   — should I still be waiting?
 *
 * The tool name is FO's, shown unprettified. A name this app invented for
 * somebody else's tool would be a name nobody could search for.
 */
function Working({ phase, activity }: { phase: ConversationPhase; activity: string | null }) {
  if (phase === "stalled") {
    return (
      <div
        className="flex items-start gap-[10px] px-[14px] py-[10px] text-[12px] font-normal"
        style={{
          borderRadius: "var(--r-panel)",
          background: "var(--status-amber-bg, var(--cockpit-surface))",
          color: "var(--text-muted-cool)",
        }}
        role="status"
      >
        <AlertTriangle
          size={14}
          strokeWidth={2.2}
          aria-hidden="true"
          className="mt-[2px] flex-none"
          style={{ color: "var(--status-amber-ink)" }}
        />
        <span className="leading-[1.6]">
          <span className="font-bold" style={{ color: "var(--text-ink)" }}>
            Nothing has arrived for 45 seconds.
          </span>{" "}
          A long lookup can take minutes, so this may still be working — or you can
          stop and ask again.
        </span>
      </div>
    );
  }

  // Answering: text is already on screen and moving. Dots beside it would
  // compete with the thing they are meant to be reassuring you about.
  if (phase === "answering") {
    return (
      <div
        className="flex items-center gap-[8px] text-[12px] font-normal"
        style={{ color: "var(--text-subtle)" }}
        role="status"
      >
        <span
          className="fab-pulse block h-[11px] w-[2px]"
          style={{ background: "var(--brand-indigo)" }}
          aria-hidden="true"
        />
        Answering…
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-[10px] text-[12px] font-normal"
      style={{ color: "var(--text-muted-cool)" }}
      role="status"
    >
      <span className="flex gap-[3px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="fab-pulse block h-[5px] w-[5px] rounded-full"
            style={{ background: "var(--brand-indigo)", animationDelay: `${i * 180}ms` }}
          />
        ))}
      </span>
      {phase === "working" && activity
        ? `FabOrchestrator is running ${activity}…`
        : "Sent to FabOrchestrator…"}
    </div>
  );
}

/**
 * This account has no data connections.
 *
 * Deliberately narrow about what that costs. FabOrchestrator answers yield,
 * scrap and OEE from its own metric path, which reads the warehouse directly
 * and never consults the caller's connections — measured, on an account with
 * an empty list. What the empty list actually costs is the tool path: WIP,
 * lots, equipment, throughput, downtime.
 *
 * Saying "no plant data is available" would therefore be false, and would send
 * an operator to an administrator over a question that already works. This
 * names the half that is missing and who can restore it.
 *
 * Not an error state: nothing failed, and the conversation is still usable.
 */
function NoDataConnections() {
  return (
    <div
      className="flex items-start gap-[10px] px-[16px] py-[12px]"
      style={{
        borderRadius: "var(--r-panel)",
        background: "var(--status-amber-bg, var(--cockpit-surface))",
        color: "var(--text-muted-cool)",
      }}
      role="status"
    >
      <Database size={15} strokeWidth={2} aria-hidden="true" className="mt-[2px] flex-none" />
      <p className="m-0 text-[12px] font-normal leading-[1.6]">
        <span className="font-bold" style={{ color: "var(--text-ink)" }}>
          No data connections are enabled for your account.
        </span>{" "}
        Questions about yield, scrap and OEE are still answered from plant data.
        Questions that need to look something up — WIP, lots, equipment, throughput
        — cannot be answered until an administrator enables a connection for your
        role in FabOrchestrator.
      </p>
    </div>
  );
}

/* ── States ──────────────────────────────────────────────────────────────── */

/**
 * The chips are the product's own where it has them — FabInsight's are verbatim
 * from the cockpit's ask bar (`components/cockpit/cockpit-ask.tsx:23-27`). They
 * are not suggestions this demo invented about a factory it cannot see, and
 * whether FO can answer them depends on that deployment's tools, which is
 * exactly the honest situation. See `FO_AGENTS`.
 */
function Opening({
  agent,
  onPick,
  disabled,
}: {
  agent: FoAgent;
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-[14px] py-[8px]">
      <div className="flex flex-col gap-[8px]">
        <h1 className="text-[26px]" style={{ color: "var(--text-ink)" }}>
          Ask {agent.name}
        </h1>
        <p
          className="m-0 max-w-[var(--measure)] text-[14px] font-normal leading-[1.6]"
          style={{ color: "var(--text-muted-cool)" }}
        >
          {/* Says where the answer comes from, because that is the whole point
              of this screen and the thing a reviewer is entitled to check. */}
          Questions are answered by the FabOrchestrator application — its agent, its
          approved tools, your data. This screen sends the question and shows what comes
          back.
        </p>
      </div>

      <div className="flex flex-wrap gap-[10px]">
        {agent.chips.map((chip) => (
          <button
            key={chip}
            type="button"
            disabled={disabled}
            onClick={() => onPick(chip)}
            className="fab-card fab-card-link cursor-pointer px-[15px] py-[8px] text-[12px] font-bold disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: "var(--text-ink)", borderRadius: 20 }}
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One card, two reasons to see it: never signed in to FO, or no longer.
 *
 * The link carries only `next`, so signing in returns to this agent. The
 * form is always usable, even when a session already exists.
 */
function SignInCard({
  next,
  title,
  body,
  label,
}: {
  next: string;
  title: string;
  body: string;
  label: string;
}) {
  return (
    <div className="fab-card flex flex-col gap-[10px] px-[20px] py-[18px]">
      <h2 className="text-[16px]" style={{ color: "var(--text-ink)" }}>
        {title}
      </h2>
      <p
        className="m-0 max-w-[var(--measure)] text-[12px] font-normal leading-[1.6]"
        style={{ color: "var(--text-muted-cool)" }}
      >
        {body}
      </p>
      <Link
        href={`/login?next=${encodeURIComponent(next)}`}
        className="mt-[2px] w-fit px-[18px] py-[10px] text-[12px] font-bold text-white no-underline"
        style={{
          borderRadius: "var(--r-control)",
          background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
          boxShadow: "var(--shadow-brand)",
        }}
      >
        {label}
      </Link>
    </div>
  );
}

/**
 * Something went wrong, and which thing decides what is offered.
 *
 * `detail` is the code, set in `Code` by `ErrorState`, because it is the string
 * somebody grepping this app's routes will search for. `explanation` is
 * **FabOrchestrator's own message**, relayed rather than replaced: a role model
 * restriction and a daily token quota both arrive here, and both tell the
 * operator something they can act on that no wording of ours could.
 */
/** Titles per code. The message beneath is FO's own words where it has any. */
const FAILURE_TITLE: Record<string, string> = {
  not_configured: "Not connected to a FabOrchestrator",
  faborch_rejected: "FabOrchestrator would not accept that request",
  agent_forbidden: "Your role does not have that permission",
  quota_exceeded: "Daily limit reached",
  faborch_unavailable: "FabOrchestrator could not answer",
  connection_lost: "The connection dropped part-way",
  stream_stalled: "No response from FabOrchestrator",
  bad_request: "That request could not be sent",
  question_too_long: "That question is too long",
};

function FailureNotice({
  agent,
  failure,
  onReset,
  onRetry,
}: {
  agent: FoAgent;
  failure: Failure;
  onReset: () => void;
  onRetry?: () => void;
}) {
  const code = failure.code as PwaErrorCode;

  if (NEEDS_SIGN_IN.has(code)) {
    return (
      <SignInCard
        next={`/${agent.slug}`}
        title={
          code === "faborch_session_expired"
            ? "Your FabOrchestrator session expired"
            : "Sign in with your FabOrchestrator account"
        }
        body={failure.message}
        label="Sign in again"
      />
    );
  }

  // The two this app raises before calling FO at all. They are not platform
  // failures and nothing is wrong with the answers above, so the way out is a
  // fresh thread rather than a retry — offered here, because a notice that
  // names a dead end without one is the notice that sends somebody looking for
  // whoever set the demo up.
  if (failure.code === "conversation_full" || failure.code === "conversation_too_long") {
    return (
      <div className="fab-card flex flex-col gap-[10px] px-[20px] py-[18px]">
        <h2 className="text-[16px]" style={{ color: "var(--text-ink)" }}>
          This conversation is full
        </h2>
        <p
          className="m-0 max-w-[var(--measure)] text-[12px] font-normal leading-[1.6]"
          style={{ color: "var(--text-muted-cool)" }}
        >
          {failure.message}
        </p>
        <button
          type="button"
          onClick={onReset}
          className="mt-[2px] flex w-fit cursor-pointer items-center gap-[8px] border-0 px-[18px] py-[10px] text-[12px] font-bold text-white"
          style={{
            borderRadius: "var(--r-control)",
            background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
            boxShadow: "var(--shadow-brand)",
          }}
        >
          <RotateCcw size={14} strokeWidth={2.4} aria-hidden="true" />
          Start a new conversation
        </button>
      </div>
    );
  }

  const title =
    FAILURE_TITLE[failure.code] ??
    (failure.code === "not_configured"
      ? `${agent.name} is not connected to a FabOrchestrator`
      : "FabOrchestrator could not answer");

  // Only where retrying can actually work. A quota does not move because you
  // pressed a button, and a permission refusal asks the same question of the
  // same role — offering the control there invites somebody to keep pressing it
  // instead of telling an administrator.
  const canRetry = !!onRetry && RETRYABLE.has(code);

  return (
    <div className="fab-card flex flex-col gap-[10px] px-[20px] py-[18px]">
      <h2 className="flex items-center gap-[8px] text-[16px]" style={{ color: "var(--text-ink)" }}>
        <AlertTriangle
          size={16}
          strokeWidth={2.4}
          aria-hidden="true"
          style={{ color: "var(--status-amber-ink)" }}
        />
        {title}
      </h2>

      {/* FabOrchestrator's own words where it sent any. A role restriction and a
          quota both arrive here and both name something the operator can act
          on, which no wording of ours could improve. */}
      <p
        className="m-0 max-w-[var(--measure)] text-[12px] font-normal leading-[1.6]"
        style={{ color: "var(--text-muted-cool)" }}
      >
        {failure.message}
      </p>

      {/* And ours: what to do about it. A failure with no next step is what
          sends an operator to find whoever set the demo up. */}
      {NEXT_STEP[code] ? (
        <p
          className="m-0 max-w-[var(--measure)] text-[12px] font-normal leading-[1.6]"
          style={{ color: "var(--text-subtle)" }}
        >
          {NEXT_STEP[code]}
        </p>
      ) : null}

      {failure.errorId ? <ErrorIdChip errorId={failure.errorId} /> : null}

      {canRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-[2px] flex w-fit cursor-pointer items-center gap-[8px] border-0 px-[18px] py-[10px] text-[12px] font-bold text-white"
          style={{
            borderRadius: "var(--r-control)",
            background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
            boxShadow: "var(--shadow-brand)",
          }}
        >
          <RefreshCw size={14} strokeWidth={2.4} aria-hidden="true" />
          Ask again
        </button>
      ) : null}
    </div>
  );
}

/**
 * FabOrchestrator's error id, as something to copy.
 *
 * It is the only handle support has into `error_audit_logs`, and a supervisor
 * on a fab floor is not going to transcribe a UUID off a phone screen
 * correctly. One tap puts it on the clipboard.
 *
 * The clipboard API needs a secure context, which the deployed app has and a
 * plain-http LAN test does not — so the failure path leaves the id selectable
 * rather than pretending the copy worked.
 */
function ErrorIdChip({ errorId }: { errorId: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex flex-wrap items-center gap-[8px]">
      <code
        className="select-all px-[8px] py-[4px] text-[11px]"
        style={{
          borderRadius: "var(--r-chip)",
          background: "var(--cockpit-surface)",
          color: "var(--text-muted-cool)",
        }}
      >
        {errorId}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(errorId)
            .then(() => setCopied(true))
            .catch(() => {
              /* Not a secure context. The code above is `select-all`. */
            });
        }}
        className="flex cursor-pointer items-center gap-[5px] border-0 bg-transparent px-0 text-[11px] font-bold"
        style={{ color: "var(--brand-indigo)" }}
      >
        {copied ? (
          <>
            <Check size={12} strokeWidth={2.6} aria-hidden="true" />
            Copied
          </>
        ) : (
          <>
            <Copy size={12} strokeWidth={2.4} aria-hidden="true" />
            Copy reference
          </>
        )}
      </button>
      <span className="text-[11px] font-normal" style={{ color: "var(--text-subtle)" }}>
        Support can trace this.
      </span>
    </div>
  );
}

/* ── Composer ────────────────────────────────────────────────────────────── */

/**
 * The ask bar, following the cockpit's own
 * (`claudeai_athena/components/cockpit/cockpit-ask.tsx`): one line, rounded,
 * lifted, with the gradient action on the right. It docks to the bottom here
 * rather than sitting under a hero, because this screen is a conversation and
 * the product's chat docks its input too.
 *
 * A `textarea` rather than an `input`, so a long question is readable while it
 * is being typed. Enter sends; Shift+Enter is a newline — the convention every
 * chat interface including the product's uses.
 */
function Composer({
  agent,
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  disabled,
  inline = false,
}: {
  agent: FoAgent;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  /**
   * On the cockpit this is an ordinary block in a scrolling page, so it drops
   * the rule above it, the page-surface fill and the home-indicator padding —
   * all three of which exist to make a *pinned* bar read as one, and all three
   * of which are wrong for a control sitting in the middle of a document.
   */
  inline?: boolean;
}) {
  return (
    <div
      className={
        inline
          ? "flex-none"
          : "flex-none border-t px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-4 sm:px-6"
      }
      style={
        inline
          ? undefined
          : { borderColor: "var(--border-light)", background: "var(--page-surface)" }
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="fab-card mx-auto flex w-full max-w-[780px] items-end gap-[10px] py-[10px] pl-[18px] pr-[10px]"
      >
        <label htmlFor={`${agent.id}-prompt`} className="sr-only">
          Ask {agent.name}
        </label>
        <textarea
          id={`${agent.id}-prompt`}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={
            disabled ? "Sign in to FabOrchestrator to ask" : "Ask about your operations…"
          }
          className="max-h-[160px] min-h-[24px] flex-1 resize-none border-0 bg-transparent py-[6px] text-[14px] outline-none disabled:cursor-not-allowed"
          style={{ color: "var(--text-ink)" }}
        />

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="grid h-[38px] w-[38px] flex-none cursor-pointer place-items-center border-0"
            style={{
              borderRadius: "var(--r-control)",
              background: "var(--cockpit-surface)",
              color: "var(--text-ink)",
            }}
          >
            <Square size={15} strokeWidth={2.4} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={disabled || !value.trim()}
            className="grid h-[38px] w-[38px] flex-none cursor-pointer place-items-center border-0 text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              borderRadius: "var(--r-control)",
              background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
            }}
          >
            <ArrowUp size={17} strokeWidth={2.4} aria-hidden="true" />
          </button>
        )}
      </form>
    </div>
  );
}
