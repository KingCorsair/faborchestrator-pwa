/**
 * Zod schemas for API request input.
 *
 * Same convention as `claudeai_athena/lib/validation.ts`: schemas live together
 * rather than beside the routes, so what the API accepts is one file someone
 * can read end to end.
 */

import { z } from "zod";

const EMAIL_MAX = 255;
const PASSWORD_MAX = 128;

/**
 * How long a conversation posted to FabInsight may be.
 *
 * ── Bounded by its size, not by the length of each answer (2026-09-29) ─────
 * Until 2026-09-29 every message was capped at 20,000 characters, answers
 * included. An answer carrying a dashboard is longer than that, so a thread was
 * "full" after its first dashboard — often by the fourth question. The cap was
 * this app's own: FabOrchestrator's `ChatRequestSchema` sets no length on a
 * message, its nginx accepts bodies up to 50 MB (`client_max_body_size`), and it
 * trims a long conversation to the model's context window itself
 * (`fitMessagesToContextWindow`).
 *
 * So an answer may now be as long as FabOrchestrator wrote it, and what bounds a
 * conversation is `CHAT_BODY_LIMIT`, its size in bytes. A question keeps a cap
 * of its own; nobody types 20,000 characters into a phone.
 *
 * Mirrored — deliberately, see its header — as `MAX_MESSAGES`, `MAX_QUESTION`,
 * `MAX_ANSWER` and `MAX_BODY_BYTES` in `lib/faborch/conversation.ts`, and the
 * test suite asserts the two agree.
 */
const CHAT_MAX_MESSAGES = 100;
const CHAT_MAX_QUESTION = 20_000;
const CHAT_MAX_ANSWER = 1_000_000;

const textParts = (max: number) =>
  z
    .array(z.object({ type: z.literal("text"), text: z.string().max(max) }))
    .min(1)
    .max(64);

/**
 * Sign-in. **Every rule carries its own wording** (2026-09-28).
 *
 * The route shows the first failing rule's message on the sign-in screen, and a
 * rule without one speaks in the validation library's voice — "Invalid input:
 * expected object, received null", or "Too big: expected string to have <=255
 * characters". Those reached the screen. Now a malformed body, a wrong type and
 * an over-long field each say what to do in words a person would use.
 */
export const LoginSchema = z.object(
  {
    email: z
      .string({ error: "Enter your email address." })
      .min(1, "Email is required")
      .max(EMAIL_MAX, "That email address is too long."),
    password: z
      .string({ error: "Enter your password." })
      .min(1, "Password is required")
      .max(PASSWORD_MAX, "That password is too long."),
  },
  { error: "Enter your email address and password." },
);

/**
 * One turn sent to FabInsight.
 *
 * ── This is a narrowing of FO's own schema, not a new one ───────────────────
 * `claudeai_athena/lib/validation.ts:143` (`ChatRequestSchema`) accepts
 * `parts: z.array(z.unknown())`, because the product's chat sends file parts,
 * tool parts and reasoning parts through the same field. This interface sends
 * text and nothing else, so it says so — an unknown part shape reaching FO from
 * here would be a bug in this app, and a schema that accepts anything cannot
 * report it.
 *
 * **What is deliberately not accepted: `model` and `activeMcpIds`.** Both are
 * decided server-side in `app/api/faborch/chat/route.ts`. A client that could
 * name the model could pick one the operator's FO role forbids and get a 400
 * from FO instead of an answer; a client that could name `activeMcpIds` could
 * name a connection belonging to somebody else. FO checks both, so this is
 * defence in depth — but it is also the same rule the explain route already
 * follows: the client does not get to say which facts the model was given.
 */
export const FabInsightRequestSchema = z.object({
  messages: z
    .array(
      z.discriminatedUnion("role", [
        z.object({ role: z.literal("user"), parts: textParts(CHAT_MAX_QUESTION) }),
        z.object({ role: z.literal("assistant"), parts: textParts(CHAT_MAX_ANSWER) }),
      ]),
    )
    .min(1)
    // A conversation long enough to hit this is one FO would trim anyway
    // (`fitMessagesToContextWindow`); the cap is here so an unbounded body
    // cannot be posted at an authenticated route. It is checked after the body
    // is parsed, so the bytes are capped separately — `CHAT_BODY_LIMIT` below.
    .max(CHAT_MAX_MESSAGES),

  /**
   * Which FabOrchestrator conversation to write this turn into.
   *
   * **Accepting this field is not the same as trusting it.** `/api/chat` in
   * FabOrchestrator does not verify that a `conversationId` belongs to the
   * caller — it has no `getConversation` and no `userId` comparison, and passes
   * the value straight to `addMessage` and to the S3-reference lookup. Every
   * other conversation route there checks ownership. That one does not.
   *
   * So the shape is validated here and the **ownership is proved in the route**,
   * against the caller's own conversation list, before anything is forwarded.
   * A uuid that parses is still not a uuid this operator may write to.
   */
  conversationId: z.string().uuid().nullish(),
});

/**
 * Creating a conversation: the question it starts with, and nothing else.
 *
 * `model` and `agent` are **not** accepted. Both are decided server-side, for
 * the same reason the chat route decides `model` and `activeMcpIds`: a client
 * that could name the agent bucket could write rows into the Modeling Agent's
 * history, which this app does not open and has no business creating.
 */
export const CreateConversationSchema = z.object({
  title: z.string().min(1).max(CHAT_MAX_QUESTION),
});

/**
 * Updating a conversation: pinning, and only pinning.
 *
 * FO's PATCH also takes `title`, `model` and `isShared`. None is accepted here.
 * `isShared` in particular flips a flag whose only consumer is `/share/<id>`, a
 * page that exists in no upstream branch — an app that offered it would be
 * offering a link that goes nowhere.
 */
export const UpdateConversationSchema = z.object({
  isPinned: z.boolean(),
});

/* ── How many bytes each route will read ─────────────────────────────────────
 *
 * The schemas above say what a body may contain; these say how large it may be
 * before anything looks at it. `lib/request-body.ts` stops reading at the
 * limit, so an oversized body is refused without ever being held in memory.
 *
 * Each is derived from its schema rather than picked, so that nothing the app's
 * own screens can send is ever refused for its size. Six bytes per character is
 * the worst case once JSON-encoded — a control character or a lone surrogate is
 * written as `\u0001` — and real text is a fraction of it.
 */
const JSON_BYTES_PER_CHAR = 6;

/** Room for the keys and brackets around a body, generously. */
const BODY_ENVELOPE_BYTES = 1024;

/** An email and a password at their longest: about 3 KB. */
export const LOGIN_BODY_LIMIT =
  (EMAIL_MAX + PASSWORD_MAX) * JSON_BYTES_PER_CHAR + BODY_ENVELOPE_BYTES;

/**
 * The largest conversation the chat screen may post: 4 MB.
 *
 * **Chosen, not derived**, unlike the others here (2026-09-29): with answers as
 * long as FabOrchestrator writes them, the schema no longer implies a size. It
 * sits under the 4.5 MB a request to a Vercel function may carry — past that,
 * Vercel answers 413 itself, in words that are not this app's — and far under
 * FabOrchestrator's 50 MB. Four megabytes of text is dozens of dashboards; a
 * conversation that large has long since been trimmed to the model's context
 * window by FO anyway.
 *
 * The screen measures its own request against this before sending
 * (`capacityIssue`), so the operator sees "this conversation is full" with a way
 * out rather than a refusal from here.
 */
export const CHAT_BODY_LIMIT = 4_000_000;

/** A conversation's title is its first question: about 120 KB. */
export const CREATE_CONVERSATION_BODY_LIMIT =
  CHAT_MAX_QUESTION * JSON_BYTES_PER_CHAR + BODY_ENVELOPE_BYTES;

/** `{ "isPinned": true }`. */
export const PIN_BODY_LIMIT = BODY_ENVELOPE_BYTES;

/**
 * A screen crashed in somebody's browser, and the crash screen is reporting it
 * (`app/api/client-error/route.ts`).
 *
 * Narrow on purpose: this arrives unauthenticated from any browser, so every
 * field is a shape the crash screen builds and nothing else. `path` is a path
 * only — never a query string, where `?q=` would carry a question somebody
 * typed. There is no stack field: a minified stack says little, and is exactly
 * the kind of free text an unauthenticated endpoint should not be taking.
 */
export const ClientErrorSchema = z.object({
  reference: z.string().regex(/^ref-[a-z0-9]{6,16}$/),
  message: z.string().max(500),
  digest: z.string().max(64).regex(/^[A-Za-z0-9_-]*$/).optional(),
  path: z.string().max(200).regex(/^\/[A-Za-z0-9\-._~/%]*$/),
});

/** A crash report is a few hundred bytes. */
export const CLIENT_ERROR_BODY_LIMIT = 4 * 1024;
