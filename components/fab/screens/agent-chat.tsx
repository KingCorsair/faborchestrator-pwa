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
 * ── One screen, three agents ────────────────────────────────────────────────
 * FabInsight, the Master Data Load Agent and the Back-end Agent are the same screen
 * with a different `agent` prop, because all three FO endpoints take
 * `{ messages }` and answer with the same stream. What differs is the name, the
 * chips and the endpoint — `lib/faborch/agents.ts`. Three copies of a
 * conversation with its own abort handling, seeding effect and five states
 * would be three places for those to drift.
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
import { ArrowUp, RotateCcw, Sparkles, Square } from "lucide-react";
import Link from "next/link";
import { ErrorState } from "@/components/fab/primitives";
import type { FoAgent } from "@/lib/faborch/agents";
import type { Failure } from "@/lib/faborch/conversation";
import {
  EMPTY_CONVERSATION,
  capacityFailure,
  capacityIssue,
  conversationReducer,
  historyFor,
  toFoMessages,
} from "@/lib/faborch/conversation";
import { readFoStream } from "@/lib/faborch/stream";

export function AgentChat({
  agent,
  hasFabOrchSession,
  initialPrompt = "",
}: {
  agent: FoAgent;
  hasFabOrchSession: boolean;
  initialPrompt?: string;
}) {
  const [state, dispatch] = React.useReducer(conversationReducer, EMPTY_CONVERSATION);
  const [input, setInput] = React.useState("");

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
      inFlight.current = true;
      dispatch({ type: "ask", prompt, userId, assistantId });

      const controller = new AbortController();
      abortRef.current = controller;

      void (async () => {
        try {
          const res = await fetch(`/api/faborch/${agent.id}/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${localStorage.getItem("llmatscale_auth_token") ?? ""}`,
            },
            // FO builds the model's context from this array rather than from
            // its own database, so the whole conversation travels and follow-up
            // questions work with no server state on either side.
            body: JSON.stringify({ messages: toFoMessages(history) }),
            signal: controller.signal,
          });

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
            } else {
              // Mid-stream failure. Whatever already arrived is kept — the
              // reducer decides that, not this callback.
              dispatch({
                type: "failed",
                failure: { code: "faborch_unavailable", message: event.message },
              });
            }
          });

          dispatch({ type: "settled" });
        } catch (error) {
          if ((error as Error)?.name === "AbortError") {
            dispatch({ type: "stopped" });
            return;
          }
          dispatch({
            type: "failed",
            failure: {
              code: "faborch_unavailable",
              message: "The connection to FabOrchestrator dropped part-way through the answer.",
            },
          });
        } finally {
          inFlight.current = false;
          abortRef.current = null;
        }
      })();
    },
    [agent, hasFabOrchSession],
  );

  /** The prompt typed on the landing page's ask bar, asked on arrival. */
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !initialPrompt.trim() || !hasFabOrchSession) return;
    seeded.current = true;
    send(initialPrompt);
  }, [initialPrompt, hasFabOrchSession, send]);

  /** Follow the answer down as it streams, the way the product's chat does. */
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.turns, state.activity]);

  const empty = state.turns.length === 0;

  return (
    <div className="fab flex h-full min-h-0 flex-col" style={{ background: "var(--page-surface)" }}>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-[18px]">
          {empty ? (
            <Opening agent={agent} onPick={send} disabled={!hasFabOrchSession || state.busy} />
          ) : null}

          {state.turns.map((turn) =>
            turn.role === "user" ? (
              <UserTurn key={turn.id} text={turn.text} />
            ) : (
              <AssistantTurn key={turn.id} text={turn.text} />
            ),
          )}

          {state.busy ? <Working activity={state.activity} /> : null}

          {state.failure ? (
            <FailureNotice
              agent={agent}
              failure={state.failure}
              onReset={() => dispatch({ type: "reset" })}
            />
          ) : null}
        </div>
      </div>

      <Composer
        agent={agent}
        value={input}
        onChange={setInput}
        onSubmit={() => send(input)}
        onStop={() => abortRef.current?.abort()}
        busy={state.busy}
        disabled={!hasFabOrchSession}
      />
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
function AssistantTurn({ text }: { text: string }) {
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
      <div className="fab-md min-w-0 flex-1">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
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
function Working({ activity }: { activity: string | null }) {
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
      {activity ? `FabOrchestrator is running ${activity}…` : "FabOrchestrator is working…"}
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
function FailureNotice({
  agent,
  failure,
  onReset,
}: {
  agent: FoAgent;
  failure: Failure;
  onReset: () => void;
}) {
  if (failure.code === "faborch_session_expired") {
    return (
      <SignInCard
        next={`/${agent.slug}`}
        title="Your FabOrchestrator session expired"
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

  return (
    <ErrorState
      title={
        failure.code === "not_configured"
          ? `${agent.name} is not connected to a FabOrchestrator`
          : failure.code === "question_too_long"
            ? "That question is too long"
            : "FabOrchestrator could not answer"
      }
      detail={failure.code}
      explanation={failure.message}
    />
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
}: {
  agent: FoAgent;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <div
      className="flex-none border-t px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-4 sm:px-6"
      style={{ borderColor: "var(--border-light)", background: "var(--page-surface)" }}
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
