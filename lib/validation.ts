/**
 * Zod schemas for API request input.
 *
 * Same convention as `claudeai_athena/lib/validation.ts`: schemas live together
 * rather than beside the routes, so what the API accepts is one file someone
 * can read end to end.
 */

import { z } from "zod";

export const LoginSchema = z.object({
  email: z.string().min(1, "Email is required").max(255),
  password: z.string().min(1, "Password is required").max(128),
});

export const OrderStatusSchema = z.enum([
  "RELEASED",
  "IN_PROGRESS",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
]);

export const OrderSearchSchema = z.object({
  text: z.string().max(64).optional(),
  /** Repeated `status` query params, one per selected filter. */
  statuses: z.array(OrderStatusSchema).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Order numbers are `PO-` plus digits. Constrained rather than free text
 * because this value is a lookup key — a permissive one would be the seam a
 * real adapter's query builder gets injected through in Tier 4.
 */
export const OrderNumberSchema = z
  .string()
  .regex(/^PO-\d{1,10}$/i, "Order number must look like PO-10382");

/** `DEC-0007`. Constrained for the same reason `OrderNumberSchema` is: it is a key. */
export const DecisionIdSchema = z
  .string()
  .regex(/^DEC-\d{1,10}$/i, "Decision id must look like DEC-0007");

/**
 * Recording a supervisor's decision, or overriding one already recorded.
 *
 * `decidedByEmail` is deliberately absent — it comes from the session, never
 * from the request body. A client that can name the decider can forge one.
 *
 * The two shapes differ in what the client must supply:
 *
 *  - **A first decision** is made in front of an analysis, so it carries the
 *    recommendation and whether that analysis was live or cached.
 *  - **An override** names the decision it replaces and the client sends
 *    neither: the route inherits both from the superseded record. Letting a
 *    client restate the recommendation on an override is how the audit trail
 *    acquires a row claiming the AI advised something it never advised.
 *
 * A `note` is optional on a first decision and **required on an override**. An
 * override with no reason is precisely the row nobody can act on later — it
 * says a manager disagreed and not why.
 */
export const DecisionSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "ESCALATE"]),
    note: z.string().max(2000).optional(),
    /** The recommendation on screen when they decided, so the two stay together. */
    recommendedAction: z.string().min(1).max(2000).optional(),
    /**
     * `"none"` means there was no analysis on screen. It is required rather
     * than inferred from an absent `recommendedAction`, so a client that simply
     * forgot to send the recommendation is rejected instead of silently
     * recording "decided without asking the model" — which would be a lie in
     * the audit trail rather than a missing field.
     */
    analysisSource: z.enum(["live", "cached", "none"]).optional(),
    /** Present only on an override. */
    supersedesId: DecisionIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.supersedesId) {
      if (!value.note?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["note"],
          message: "An override needs a reason",
        });
      }
      return;
    }
    if (!value.analysisSource) {
      ctx.addIssue({
        code: "custom",
        path: ["analysisSource"],
        message: "analysisSource is required",
      });
      return;
    }
    // Only a decision taken *with* an analysis has a recommendation to record.
    if (value.analysisSource !== "none" && !value.recommendedAction) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendedAction"],
        message: "recommendedAction is required",
      });
    }
    // And one taken without an analysis cannot have one. Rejecting rather than
    // dropping it: a client sending both is confused about which it did, and
    // quietly picking one for it puts the wrong story in the log.
    if (value.analysisSource === "none" && value.recommendedAction) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendedAction"],
        message: "recommendedAction cannot accompany analysisSource \"none\"",
      });
    }
  });

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
      z.object({
        role: z.enum(["user", "assistant"]),
        parts: z
          .array(z.object({ type: z.literal("text"), text: z.string().max(20_000) }))
          .min(1)
          .max(64),
      }),
    )
    .min(1)
    // A conversation long enough to hit this is one FO would trim anyway
    // (`fitMessagesToContextWindow`); the cap is here so an unbounded body
    // cannot be posted at an authenticated route.
    .max(100),

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
  title: z.string().min(1).max(20_000),
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
