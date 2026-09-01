/**
 * The shape the model is forced to return.
 *
 * One schema, used twice: as the tool's `input_schema` (so the API constrains
 * generation) and as a Zod validator (so nothing reaches a screen unchecked).
 * Deriving both from one definition is what stops them drifting — a tool schema
 * the validator disagrees with fails at runtime on a shop floor, not in CI.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * **No confidence score, no severity, no probability, no "likelihood" field.**
 * Severity is arithmetic from `rules-config.ts`; a model-supplied number that
 * looks like severity would compete with it, and the first time the two
 * disagreed on a real order, whichever one the screen happened to render would
 * become the truth. The model explains and recommends. It does not score.
 *
 * The analysis is **one object, not one per issue** — a single `summary` and a
 * single `recommendation` across every issue that fired. Three disconnected
 * explanations is how you get three contradictory recommendations about the
 * same machine.
 *
 * ── The length budget (2026-08-13) ──────────────────────────────────────────
 * Every prose field is **one sentence** with a word budget. Before this, the
 * three prose layers each restated the same facts: the hand-written fallback
 * for PO-10382 said "42 minutes … feeder jam at station 3" in the summary,
 * again in the MACHINE_DOWNTIME explanation, and again in PRODUCTION_DELAY.
 * Fourteen sentences to convey six. On a phone that is four screenfuls of text
 * between the supervisor and the decision buttons.
 *
 * The budget is enforced in three places, deliberately unequal:
 *
 *  1. **The `describe()` text** — what the model actually reads while
 *     generating. This is the mechanism that does the work.
 *  2. **The system prompt** — states the no-repetition rule the budgets alone
 *     cannot express (a short sentence can still restate the one above it).
 *  3. **A Zod `.max()` backstop**, set well above the stated budget. It is a
 *     runaway guard, not the primary control: a Zod failure costs a corrective
 *     retry (another ~10 s round trip) and, if the second attempt also fails,
 *     drops the whole analysis to the cache. Making a *stylistic* rule capable
 *     of taking the feature offline would be a bad trade, so the ceilings sit
 *     at roughly 1.7× the target and only fire on genuine runaway.
 *
 * **The budgets are not in the tool's JSON Schema, and must not be.** Strict
 * structured output does not support `minLength`/`maxLength` or array-length
 * constraints — adding them would either be rejected or silently dropped,
 * leaving a schema that reads as though it enforces something it does not.
 * `min(1)` has always lived only in Zod for the same reason.
 */

import { z } from "zod";

/**
 * One definition per budget, read by both the Zod validator and the two
 * description strings, so a change cannot land in one and miss the others.
 *
 * `words` is what the model is told; `maxChars` is the runaway guard. The gap
 * between them is intentional — see the header.
 */
const BUDGET = {
  summary: { words: 30, maxChars: 320 },
  explanation: { words: 25, maxChars: 260 },
  action: { words: 20, maxChars: 200 },
  rationale: { words: 25, maxChars: 260 },
  /** Records per claim. Enough to carry a sentence; not everything the model read. */
  evidence: { target: 3, maxItems: 6 },
} as const;

const DESCRIPTIONS = {
  summary: `The whole order in ONE sentence of at most ${BUDGET.summary.words} words: what is wrong, and the single thread connecting the issues. If one issue plausibly caused another, that link is the sentence. Do not list the issues — they follow. Do not restate figures your evidence already cites.`,
  issues: "One entry per detected issue, most important first.",
  issueType: "Must match the `type` of one of the detected issues you were given.",
  explanation: `ONE sentence of at most ${BUDGET.explanation.words} words: what this issue is and its likely cause. Add what the record does not already say — never repeat the summary, another issue, or a number that appears in this entry's own evidence.`,
  evidence: `The ${BUDGET.evidence.target} or so records that carry this claim — not every record you read.`,
  recommendation: "A single recommended next action across all issues.",
  action: `Exactly one next action for the supervisor, phrased as an instruction, in at most ${BUDGET.action.words} words. Not a list, not a plan — the single thing to do next.`,
  rationale: `ONE sentence of at most ${BUDGET.rationale.words} words: what this action changes, and what it costs to delay it. Not why the problem exists — the summary said that.`,
  recordId: "The exact recordId of an MES record from the context, e.g. EVT-2231.",
  field: "The field of that record you read, e.g. durationMinutes.",
  value: "The value that field holds, copied exactly.",
} as const;

/** One `{record_id, field, value}` citation. */
export const EvidenceRefSchema = z.object({
  record_id: z.string().describe(DESCRIPTIONS.recordId),
  field: z.string().describe(DESCRIPTIONS.field),
  value: z.string().describe(DESCRIPTIONS.value),
});

const EvidenceListSchema = z
  .array(EvidenceRefSchema)
  .min(1)
  .max(BUDGET.evidence.maxItems)
  .describe(DESCRIPTIONS.evidence);

export const IssueAnalysisSchema = z.object({
  type: z
    .enum(["MACHINE_DOWNTIME", "QUALITY_PROBLEM", "PRODUCTION_DELAY"])
    .describe(DESCRIPTIONS.issueType),
  explanation: z
    .string()
    .min(1)
    .max(BUDGET.explanation.maxChars)
    .describe(DESCRIPTIONS.explanation),
  evidence: EvidenceListSchema,
});

export const AnalysisSchema = z.object({
  summary: z.string().min(1).max(BUDGET.summary.maxChars).describe(DESCRIPTIONS.summary),
  issues: z.array(IssueAnalysisSchema).min(1).describe(DESCRIPTIONS.issues),
  recommendation: z
    .object({
      action: z.string().min(1).max(BUDGET.action.maxChars).describe(DESCRIPTIONS.action),
      rationale: z
        .string()
        .min(1)
        .max(BUDGET.rationale.maxChars)
        .describe(DESCRIPTIONS.rationale),
      evidence: EvidenceListSchema,
    })
    .describe(DESCRIPTIONS.recommendation),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
export type IssueAnalysis = z.infer<typeof IssueAnalysisSchema>;
export type EvidenceRefOut = z.infer<typeof EvidenceRefSchema>;

/** The tool the model is forced to call. Its name is referenced by `tool_choice`. */
export const ANALYSIS_TOOL_NAME = "record_analysis";

/**
 * The tool's JSON Schema.
 *
 * Written out rather than generated from the Zod schema: `strict: true`
 * requires `additionalProperties: false` on every object and an exact
 * `required` list, and a generator that quietly omits either turns the API's
 * guarantee off without failing. This is the contract — it is worth being able
 * to read it. A test walks it and asserts both properties hold.
 *
 * Deliberately not `as const`: the SDK's `InputSchema` is mutable, and a
 * readonly `required` array does not assign to it.
 *
 * **No `maxLength`, `minLength`, `minItems` or `maxItems` appears here.**
 * Strict structured output does not support them, so the length budget rides
 * in the `description` strings — which the model reads — and is checked by Zod
 * afterwards. A test asserts this file stays free of them, because adding one
 * would produce a schema that looks enforcing and is not.
 */
export const ANALYSIS_TOOL_SCHEMA = {
  // Only the root's `type` is typed by the SDK, and it wants the literal
  // rather than `string`. Nested nodes are untyped, so they stay plain.
  type: "object" as const,
  additionalProperties: false,
  required: ["summary", "issues", "recommendation"],
  properties: {
    summary: { type: "string", description: DESCRIPTIONS.summary },
    issues: {
      type: "array",
      description: DESCRIPTIONS.issues,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "explanation", "evidence"],
        properties: {
          type: {
            type: "string",
            enum: ["MACHINE_DOWNTIME", "QUALITY_PROBLEM", "PRODUCTION_DELAY"],
            description: DESCRIPTIONS.issueType,
          },
          explanation: { type: "string", description: DESCRIPTIONS.explanation },
          evidence: {
            type: "array",
            description: DESCRIPTIONS.evidence,
            items: evidenceRefJsonSchema(),
          },
        },
      },
    },
    recommendation: {
      type: "object",
      additionalProperties: false,
      required: ["action", "rationale", "evidence"],
      description: DESCRIPTIONS.recommendation,
      properties: {
        action: { type: "string", description: DESCRIPTIONS.action },
        rationale: { type: "string", description: DESCRIPTIONS.rationale },
        evidence: {
          type: "array",
          description: DESCRIPTIONS.evidence,
          items: evidenceRefJsonSchema(),
        },
      },
    },
  },
};

function evidenceRefJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["record_id", "field", "value"],
    properties: {
      record_id: { type: "string", description: DESCRIPTIONS.recordId },
      field: { type: "string", description: DESCRIPTIONS.field },
      value: { type: "string", description: DESCRIPTIONS.value },
    },
  };
}

/** The budgets, for tests and for anything that wants to report them. */
export const ANALYSIS_BUDGET = BUDGET;
