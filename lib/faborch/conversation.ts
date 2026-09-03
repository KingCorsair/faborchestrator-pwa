/**
 * What a conversation *is*, with no React in it.
 *
 * ── Why this is not inside the screen ───────────────────────────────────────
 * Every rule that decides what a conversation looks like after something
 * happens — a question asked, a token arrived, a stop pressed, a stream that
 * ended with nothing in it — used to live inside `agent-chat.tsx` as a set of
 * `setTurns` callbacks. They were correct, and they were also the one part of
 * the FabOrchestrator path with no test behind it, because testing them meant
 * rendering React.
 *
 * They are ordinary state transitions. Written as a reducer they are testable
 * as data, and the screen becomes a renderer of whatever this produces.
 *
 * ── It also removes a hazard the screen had recorded against itself ─────────
 * The old `send` closed over `turns`, so it was a **new function on every
 * token that arrived** — dozens of identities per answer — and the effect that
 * asks the landing page's question had to park it in a ref to avoid firing once
 * per token. `dispatch` is stable for the lifetime of the component, so that
 * whole arrangement goes.
 */

/** One turn, in the shape `/api/faborch/[agent]/chat` accepts and FO understands. */
export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * The answer stopped before it finished, and not because the user said so.
   *
   * A dropped connection leaves text that is true as far as it goes and
   * misleading as a whole — a yield table cut off after four rows looks like a
   * complete four-row table. Marking it is what stops a partial answer being
   * read as a total.
   */
  incomplete?: boolean;
}

export interface Failure {
  code: string;
  message: string;
  /**
   * FabOrchestrator's own error id, split out of the message it arrived in.
   *
   * The only handle support has into `error_audit_logs`, so it survives to the
   * screen as its own field rather than buried in a sentence — see
   * `splitErrorId` in `lib/faborch/errors.ts`.
   */
  errorId?: string;
}

/**
 * What is happening right now, as three distinct things rather than one spinner.
 *
 * The plan's line is that a long tool call must not look like a hang. Dots
 * alone cannot carry that: they say the same thing at second 2 and second 90.
 *
 *  - `waiting`   the request is sent and nothing has come back yet
 *  - `working`   FO is running a tool, and says which one
 *  - `answering` text is arriving
 *  - `stalled`   45 seconds of complete silence — a warning, not a verdict
 *  - `idle`      no turn in flight
 */
export type ConversationPhase = "idle" | "waiting" | "working" | "answering" | "stalled";

export interface ConversationState {
  turns: Turn[];
  /** A turn is in flight: the composer shows Stop, the send button is inert. */
  busy: boolean;
  /** Which of the three progress states to show. */
  phase: ConversationPhase;
  /** The FO tool currently running, named as FO names it. */
  activity: string | null;
  failure: Failure | null;
  /** The assistant turn currently being written into, if any. */
  streamingId: string | null;
}

export const EMPTY_CONVERSATION: ConversationState = {
  turns: [],
  busy: false,
  phase: "idle",
  activity: null,
  failure: null,
  streamingId: null,
};

export type ConversationAction =
  /** The user asked something. Both turns appear at once; the answer is empty. */
  | { type: "ask"; prompt: string; userId: string; assistantId: string }
  /** A piece of the answer arrived. */
  | { type: "delta"; delta: string }
  /** FO started a tool. */
  | { type: "activity"; name: string }
  /** The turn failed — before it began, or part-way through. */
  | { type: "failed"; failure: Failure }
  /** The stream ended on its own. */
  | { type: "settled" }
  /** The user pressed Stop. */
  | { type: "stopped" }
  /** 45 seconds of silence. The turn is still open — this is a warning. */
  | { type: "stalled" }
  /** Start again with an empty thread. */
  | { type: "reset" }
  /** Dismiss a failure notice without touching the thread. */
  | { type: "clearFailure" };

/**
 * The one rule that governs every ending.
 *
 * An assistant turn that never received a character is dropped; one that
 * received something is kept, whatever ended it. That covers three cases which
 * look different and are not:
 *
 *  - **Stop.** The acceptance line for this package is that interrupting an
 *    answer does not lose what already arrived. Half an answer is an answer.
 *  - **A stream that ended with nothing in it.** Rare, and it happens in the
 *    product when every step of a turn was a tool call. An empty bubble reads
 *    as a rendering fault.
 *  - **A failure part-way through.** The error notice explains itself; the text
 *    that did arrive is still the platform's answer and is still true.
 */
function settle(
  state: ConversationState,
  { markIncomplete = false }: { markIncomplete?: boolean } = {},
): ConversationState {
  const kept = state.turns.filter(
    (turn) => turn.id !== state.streamingId || turn.text.trim().length > 0,
  );

  return {
    ...state,
    // `markIncomplete` separates an ending the user chose from one that
    // happened to them. Stop needs no badge — they pressed it and know what
    // they have. A dropped connection does, because half a table looks exactly
    // like a whole one.
    turns: markIncomplete
      ? kept.map((turn) =>
          turn.id === state.streamingId ? { ...turn, incomplete: true } : turn,
        )
      : kept,
    busy: false,
    phase: "idle",
    activity: null,
    streamingId: null,
  };
}

/** Did the turn in flight already have text in it? */
function hasPartialAnswer(state: ConversationState): boolean {
  if (!state.streamingId) return false;
  const streaming = state.turns.find((turn) => turn.id === state.streamingId);
  return !!streaming && streaming.text.trim().length > 0;
}

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "ask":
      return {
        turns: [
          ...state.turns,
          { id: action.userId, role: "user", text: action.prompt },
          { id: action.assistantId, role: "assistant", text: "" },
        ],
        busy: true,
        phase: "waiting",
        activity: null,
        failure: null,
        streamingId: action.assistantId,
      };

    case "delta":
      return {
        ...state,
        // A delta that arrives after the turn settled has nowhere to go. It
        // cannot happen through `readFoStream`, but the reducer is the place
        // that guarantees it rather than the caller.
        turns: state.turns.map((turn) =>
          turn.id === state.streamingId ? { ...turn, text: turn.text + action.delta } : turn,
        ),
        // The answer has started, so whatever tool produced it is done — and a
        // stall warning is answered by the arrival of text, not dismissed.
        phase: "answering",
        activity: null,
      };

    case "activity":
      return { ...state, phase: "working", activity: action.name };

    // A warning, not an ending. The turn stays open, the composer still shows
    // Stop, and a delta arriving later moves it straight back to `answering`.
    case "stalled":
      return state.busy ? { ...state, phase: "stalled" } : state;

    case "failed":
      // Text already on screen plus a failure means the answer was cut off
      // part-way. Anything else failed before it began, so there is nothing to
      // mark.
      return {
        ...settle(state, { markIncomplete: hasPartialAnswer(state) }),
        failure: action.failure,
      };

    case "settled":
    case "stopped":
      return settle(state);

    case "reset":
      return EMPTY_CONVERSATION;

    case "clearFailure":
      return { ...state, failure: null };

    /* c8 ignore next 2 */
    default:
      return state;
  }
}

/**
 * The history posted for a turn: everything so far, plus the new question.
 *
 * FO builds the model's context from this array rather than from its own
 * database, so the whole conversation travels and follow-ups work with no
 * server state on either side. The empty assistant turn the screen shows while
 * it waits is **not** in it — it is a placeholder for text that has not
 * arrived, and posting it would tell FO the assistant said nothing.
 */
export function historyFor(turns: Turn[], prompt: string, userId: string): Turn[] {
  return [...turns, { id: userId, role: "user" as const, text: prompt }];
}

/** The wire shape FO understands. */
export function toFoMessages(turns: Turn[]): { role: string; parts: { type: "text"; text: string }[] }[] {
  return turns.map((turn) => ({
    role: turn.role,
    parts: [{ type: "text" as const, text: turn.text }],
  }));
}

/* ── Capacity ────────────────────────────────────────────────────────────── */

/**
 * The limits `FabInsightRequestSchema` enforces, restated here so the screen can
 * see them coming.
 *
 * **These must match `lib/validation.ts`.** They are duplicated deliberately
 * rather than imported: `lib/validation.ts` pulls in zod, and this module is
 * imported by a client component, so importing it would ship a schema library
 * to the phone to read two numbers off it. The test suite asserts the two agree,
 * which is the part that actually keeps them honest.
 */
export const MAX_MESSAGES = 100;
export const MAX_TEXT = 20_000;

export type CapacityIssue =
  /** The thread has reached the number of messages the route accepts. */
  | { kind: "thread-full" }
  /** This one question is longer than a single message may be. */
  | { kind: "question-too-long" }
  /** An answer already in the thread is too long to send back as context. */
  | { kind: "answer-too-long" };

/**
 * Can this question be asked at all?
 *
 * ── Why the screen checks a limit the route already enforces ────────────────
 * Because of what happens when it does not. The route validates with zod and
 * returns `issues[0].message`, so a conversation that reaches the hundred-and-
 * first message fails with **"Too big: expected array to have <=100 items"** —
 * a schema library's words, in a conversation, to a supervisor. Worse, it
 * fails identically on every retry: the thread is dead and the screen does not
 * say so or offer a way out.
 *
 * That is a defect regardless of what the product decides the *policy* should
 * be. **This function does not decide the policy** — it does not truncate, drop
 * the beginning, or start a new thread, because which of those should happen is
 * an open product question. It only makes the wall visible before the user
 * walks into it.
 */
export function capacityIssue(turns: Turn[], prompt: string): CapacityIssue | null {
  if (prompt.length > MAX_TEXT) return { kind: "question-too-long" };
  // `historyFor` adds one message; the placeholder answer is not posted.
  if (turns.length + 1 > MAX_MESSAGES) return { kind: "thread-full" };
  if (turns.some((turn) => turn.text.length > MAX_TEXT)) return { kind: "answer-too-long" };
  return null;
}

/**
 * What to say about it.
 *
 * Each names what happened and what to do next, per the product rule that a
 * failure with no next step sends the operator to find whoever set the demo up.
 * The codes are this app's own — no platform call was made — and are the
 * strings somebody grepping the app will search for.
 */
export function capacityFailure(issue: CapacityIssue): Failure {
  switch (issue.kind) {
    case "thread-full":
      return {
        code: "conversation_full",
        message:
          `This conversation has reached its limit of ${MAX_MESSAGES} messages. ` +
          "Start a new one to keep asking — the answers above stay on screen until you do.",
      };
    case "question-too-long":
      return {
        code: "question_too_long",
        message:
          `That question is longer than ${MAX_TEXT.toLocaleString("en-GB")} characters, ` +
          "which is the most FabOrchestrator accepts in one message. Shorten it and ask again.",
      };
    case "answer-too-long":
      return {
        code: "conversation_too_long",
        message:
          "One of the answers above is too long to send back as context for a follow-up. " +
          "Start a new conversation to keep asking.",
      };
  }
}
