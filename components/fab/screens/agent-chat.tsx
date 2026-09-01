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
 * chatbot". The prohibition is against *this demo* growing an AI feature of its
 * own — a second assistant, competing with the deterministic rule layer the
 * product's whole argument rests on. This is the opposite: it is the product's
 * existing agent, reached from the place the product puts it, and the rules and
 * the grounded analysis on `/orders` are untouched beside it.
 *
 * ── Four states, and each says what to do next ──────────────────────────────
 *  - **no FabOrchestrator session** — signed in with the demo credential, which
 *    opens the order workflow and not this. Offers sign-in.
 *  - **not configured** — nobody set `FABORCH_BASE_URL`. A deployment fault,
 *    named as one, because an operator cannot fix it and should not try.
 *  - **unavailable** — FO is down, or answered with an error of its own (a role
 *    restriction and a daily quota both arrive this way, and both are worth
 *    reading verbatim).
 *  - **expired** — FO dropped the session. Offers sign-in.
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
import { ArrowUp, Sparkles, Square } from "lucide-react";
import Link from "next/link";
import { ErrorState } from "@/components/fab/primitives";
import type { FoAgent } from "@/lib/faborch/agents";
import { readFoStream } from "@/lib/faborch/stream";

/** One turn, in the shape `/api/faborch/[agent]/chat` accepts and FO understands. */
interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface Failure {
  code: string;
  message: string;
}

export function AgentChat({
  agent,
  hasFabOrchSession,
  initialPrompt = "",
}: {
  agent: FoAgent;
  hasFabOrchSession: boolean;
  initialPrompt?: string;
}) {
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [activity, setActivity] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const send = React.useCallback(
    (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy || !hasFabOrchSession) return;

      setFailure(null);
      setInput("");
      setBusy(true);
      setActivity(null);

      const history: Turn[] = [...turns, { id: `u-${Date.now()}`, role: "user", text: prompt }];
      const assistantId = `a-${Date.now()}`;
      setTurns([...history, { id: assistantId, role: "assistant", text: "" }]);

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
            body: JSON.stringify({
              messages: history.map((turn) => ({
                role: turn.role,
                parts: [{ type: "text", text: turn.text }],
              })),
            }),
            signal: controller.signal,
          });

          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => null)) as Failure | null;
            setFailure({
              code: body?.code ?? "faborch_unavailable",
              message:
                (body as unknown as { error?: string })?.error ??
                `${agent.name} could not answer that.`,
            });
            // Drop the empty assistant turn — an empty bubble beside an error
            // reads as an answer that arrived blank.
            setTurns(history);
            return;
          }

          await readFoStream(res.body, (event) => {
            if (event.type === "text") {
              setActivity(null);
              setTurns((current) =>
                current.map((turn) =>
                  turn.id === assistantId ? { ...turn, text: turn.text + event.delta } : turn,
                ),
              );
            } else if (event.type === "tool") {
              setActivity(event.name);
            } else {
              setFailure({ code: "faborch_unavailable", message: event.message });
            }
          });

          // FO answered, but with nothing in it. Rare, and it has happened in
          // the product when every step of a turn was a tool call: showing an
          // empty bubble would look like a rendering fault.
          setTurns((current) =>
            current.filter((turn) => turn.id !== assistantId || turn.text.trim().length > 0),
          );
        } catch (error) {
          if ((error as Error)?.name === "AbortError") {
            // Stopped on purpose. Whatever streamed so far stays on screen.
            setTurns((current) =>
              current.filter((turn) => turn.id !== assistantId || turn.text.trim().length > 0),
            );
            return;
          }
          setFailure({
            code: "faborch_unavailable",
            message: "The connection to FabOrchestrator dropped part-way through the answer.",
          });
          setTurns(history);
        } finally {
          setBusy(false);
          setActivity(null);
          abortRef.current = null;
        }
      })();
    },
    [agent, busy, hasFabOrchSession, turns],
  );

  /**
   * `send` closes over `turns`, so it is a new function on every token that
   * arrives. The seeding effect below must fire **once** — depending on `send`
   * directly would ask the landing page's question dozens of times — so the
   * current one is parked in a ref, written from an effect rather than during
   * render. The two effects run in declaration order, so the ref is filled
   * before the one that reads it.
   */
  const sendRef = React.useRef<(text: string) => void>(() => {});
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  /** The prompt typed on the landing page's ask bar, asked on arrival. */
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !initialPrompt.trim() || !hasFabOrchSession) return;
    seeded.current = true;
    sendRef.current(initialPrompt);
  }, [initialPrompt, hasFabOrchSession]);

  /** Follow the answer down as it streams, the way the product's chat does. */
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, activity]);

  const empty = turns.length === 0;

  return (
    <div className="fab flex h-full min-h-0 flex-col" style={{ background: "var(--page-surface)" }}>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-[18px]">
          {empty ? (
            <Opening agent={agent} onPick={send} disabled={!hasFabOrchSession || busy} />
          ) : null}

          {turns.map((turn) =>
            turn.role === "user" ? (
              <UserTurn key={turn.id} text={turn.text} />
            ) : (
              <AssistantTurn key={turn.id} text={turn.text} />
            ),
          )}

          {busy ? <Working activity={activity} /> : null}

          {failure ? <FailureNotice agent={agent} failure={failure} /> : null}
          {!hasFabOrchSession ? <NoFabOrchSession agent={agent} /> : null}
        </div>
      </div>

      <Composer
        agent={agent}
        value={input}
        onChange={setInput}
        onSubmit={() => send(input)}
        onStop={() => abortRef.current?.abort()}
        busy={busy}
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
 * Signed in here, but not to FabOrchestrator.
 *
 * Not an error — the demo credential is a legitimate way to be signed in, and
 * it opens the order workflow. It just cannot reach somebody else's product.
 */
function NoFabOrchSession({ agent }: { agent: FoAgent }) {
  return (
    <SignInCard
      next={`/${agent.slug}`}
      title="Sign in with your FabOrchestrator account"
      body={
        `${agent.blurb} So it needs your FabOrchestrator credentials, not this ` +
        "demo’s. The production order workflow is unaffected and stays open on this " +
        "session."
      }
      label="Sign in to FabOrchestrator"
    />
  );
}

/**
 * One card, two reasons to see it: never signed in to FO, or no longer.
 *
 * ── Why the link carries `upgrade=1` ────────────────────────────────────────
 * This card is shown **only** to somebody already signed in to this app — with
 * the demo credential, or with an FO session FO has since dropped. Without the
 * flag, `components/login-page.tsx` sees their existing token, concludes they
 * are signed in already, and `router.replace`s them straight back here. The
 * form appeared for one frame and vanished, so the single control that leads to
 * FabInsight could never be used (reported 2026-08-25).
 *
 * The flag means "yes, I know who you are — I am here to add a *FabOrchestrator*
 * session on top". Both callers route through this component, so the
 * expired-session path is fixed by the same line.
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
        href={`/login?next=${encodeURIComponent(next)}&upgrade=1`}
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
function FailureNotice({ agent, failure }: { agent: FoAgent; failure: Failure }) {
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

  return (
    <ErrorState
      title={
        failure.code === "not_configured"
          ? `${agent.name} is not connected to a FabOrchestrator`
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
