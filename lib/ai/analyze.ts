/**
 * The Explain Issue call.
 *
 * Structured output via **forced tool use** — `tool_choice` names the tool, so
 * the model cannot answer in prose and there is no JSON to fish out of a text
 * block. `strict: true` makes the API guarantee the input validates against the
 * schema; Zod then re-validates on our side, because a guarantee you did not
 * check is a guarantee you are trusting a network boundary to have kept.
 *
 * ── Why the official SDK ────────────────────────────────────────────────────
 * `@anthropic-ai/sdk`, which the product also depends on. The decision recorded
 * in CLAUDE.md rule 4 was "Anthropic directly, not Bedrock"; between the two
 * Anthropic clients the product carries, the official one expresses forced tool
 * use as the API itself defines it, which is what an auditable structured-output
 * path wants.
 *
 * ── Two attempts, then the truth (Tier 2) ───────────────────────────────────
 * Output that fails Zod validation, or fails grounding validation, gets exactly
 * one corrective retry — a `tool_result` naming what was wrong, so the second
 * attempt is a correction rather than a re-roll. After that the result is
 * **flagged, not hidden**: an analysis whose citations did not check out is
 * still shown, without the "Grounded in MES data" badge and with the bad
 * citations marked. Silently swallowing it would teach an audience that the
 * badge is decoration.
 *
 * One retry rather than three: each attempt is a full 2–5 s round trip, and a
 * supervisor standing at a stopped machine is the person paying for the third.
 *
 * ── Degrading ───────────────────────────────────────────────────────────────
 * Four things can go wrong — no API key, a network or API failure, a timeout,
 * and output that fails validation twice. All four land in the same place: the
 * cached analysis for this order if one exists, otherwise an honest failure.
 * What must never happen is a cached answer presented as a live one, so the
 * result always carries its own `source`.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { DetectedIssue } from "@/lib/mes/issues";
import type { OrderDetail } from "@/lib/mes/types";
import { buildAnalysisRequest } from "./context";
import { cachedAnalysisFor } from "./fallback";
import { groundingFeedback, validateGrounding, type GroundingReport } from "./grounding";
import { ANALYSIS_SYSTEM_PROMPT } from "./system-prompt";
import { ANALYSIS_TOOL_NAME, ANALYSIS_TOOL_SCHEMA, AnalysisSchema, type Analysis } from "./schema";

/**
 * Haiku 4.5 by default — changed from `claude-opus-5` on 2026-08-11.
 *
 * The work this model does is narrow: it is handed the facts, the fired issues
 * and the exact records it may cite, and asked to explain and recommend. It does
 * not decide whether a machine stopped, how severe anything is, or what is
 * citable. A cheaper model doing a constrained job under a strict schema and a
 * grounding check is the right trade for a demo somebody runs all day.
 *
 * Overridable with `ANALYSIS_MODEL`. If output quality drops, the first thing
 * to try is `ANALYSIS_MODEL=claude-opus-5` — no code change needed.
 */
const MODEL = process.env.ANALYSIS_MODEL ?? "claude-haiku-4-5-20251001";

/**
 * A supervisor will not wait longer than this at a machine, and the cached
 * fallback exists precisely so they do not have to.
 *
 * Raised from 25 s on 2026-08-11 after the first live calls came back at 21.1 s
 * and 19.1 s on Opus 5 — a 25 s ceiling meant an ordinary call was one bad
 * network minute from timing out, and a timeout degrades straight to the cache
 * with no retry. This is a **per-attempt** budget, so a corrective retry can
 * cost twice it; `maxDuration` on the route is what bounds the pair.
 */
const TIMEOUT_MS = Number(process.env.ANALYSIS_TIMEOUT_MS ?? "40000");

/** One corrective retry. See the header for why not more. */
const MAX_ATTEMPTS = 2;

/**
 * Whether a model accepts `output_config.effort`.
 *
 * Not a guess: Haiku 4.5 was probed on 2026-08-11 and returns
 * `400 invalid_request_error: This model does not support the effort parameter`.
 * The Claude 5 family accepts it. Sending it to a model that does not is a hard
 * failure of the whole request, not a warning, so this is checked before the
 * call — and `isUnsupportedEffortError` below catches the case where this
 * predicate is wrong about a model that does not exist yet.
 */
function supportsEffort(model: string): boolean {
  return /(opus|sonnet|fable)-5/.test(model);
}

function isUnsupportedEffortError(error: unknown): boolean {
  return (
    error instanceof Anthropic.APIError &&
    error.status === 400 &&
    /does not support the effort parameter/i.test(error.message)
  );
}

/**
 * The subset of the SDK this module uses.
 *
 * Declared so tests can pass a stub. The corrective-retry loop — the branch
 * that appends a `tool_result` and asks again — cannot be exercised against the
 * real API without deliberately provoking a bad citation, which is neither
 * deterministic nor free. With this seam it is an ordinary unit test.
 */
export interface MessageCreator {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

export type AnalysisSource = "live" | "cached";

export interface AnalysisResult {
  analysis: Analysis;
  source: AnalysisSource;
  /** The model that produced it, or null when the analysis came from cache. */
  model: string | null;
  /**
   * Whether every citation resolved against the MES records the model was shown.
   * The badge renders from `grounding.grounded` and nothing else.
   */
  grounding: GroundingReport;
  /** How many model calls it took. 2 means the first attempt was corrected. */
  attempts: number;
  /**
   * Set when a live call was attempted and did not produce a usable analysis.
   * Present alongside a cached analysis — the screen shows both, so nobody
   * mistakes a fallback for a fresh answer.
   */
  degraded?: { reason: DegradeReason; detail: string };
}

export type DegradeReason = "no_api_key" | "api_error" | "timeout" | "invalid_output";

export class AnalysisUnavailableError extends Error {
  constructor(
    readonly reason: DegradeReason,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "AnalysisUnavailableError";
  }
}

export async function analyzeOrder(
  order: OrderDetail,
  issues: DetectedIssue[],
  /** Injected only by tests. Production always builds its own client. */
  injectedClient?: MessageCreator,
): Promise<AnalysisResult> {
  if (issues.length === 0) {
    throw new AnalysisUnavailableError(
      "invalid_output",
      "No rule fired on this order, so there is nothing to explain.",
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!injectedClient && !apiKey) {
    return degrade(order, issues, "no_api_key", "ANTHROPIC_API_KEY is not set on this server.");
  }

  const client: MessageCreator =
    injectedClient ?? new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  const firedTypes = issues.map((issue) => issue.type);

  // Dropped for the rest of this request if the model turns out to reject it.
  let sendEffort = supportsEffort(MODEL);

  // The running conversation. A corrective retry appends the rejected tool call
  // and a tool_result explaining the rejection, so the model sees its own bad
  // answer rather than being asked the same question twice.
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildAnalysisRequest(order, issues) },
  ];

  /** The best result seen so far — kept so a second ungrounded attempt does not lose a first one that was closer. */
  let best: { analysis: Analysis; model: string; grounding: GroundingReport } | null = null;
  let lastInvalidDetail = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const request = (): Anthropic.MessageCreateParamsNonStreaming => ({
      model: MODEL,
      max_tokens: 16000,
      // Thinking is left at each model's own default. On Opus 5 that is
      // adaptive, and it is deliberately not disabled: with thinking off, Opus 5
      // can emit a tool call as plain text — the turn succeeds, the call never
      // happens, and nothing errors. Haiku 4.5 has no such default and was
      // probed returning a clean `tool_use` under forced, strict tool choice.
      //
      // `effort` is the latency lever where it exists. Haiku 4.5 rejects the
      // parameter outright, so it is only sent to models that take it.
      ...(sendEffort ? { output_config: { effort: "medium" as const } } : {}),
      system: ANALYSIS_SYSTEM_PROMPT,
      tools: [
        {
          name: ANALYSIS_TOOL_NAME,
          description:
            "Record your analysis of this production order: a summary, one entry per detected issue, and a single recommended next action.",
          strict: true,
          input_schema: ANALYSIS_TOOL_SCHEMA,
        },
      ],
      // Forced: the model must call this tool. Never prompt-and-parse.
      tool_choice: { type: "tool", name: ANALYSIS_TOOL_NAME },
      messages,
    });

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(request());
    } catch (error) {
      // `supportsEffort` guessed wrong about this model. Drop the parameter and
      // try once more rather than failing a request over a tuning hint — this
      // costs one wasted round trip the first time a new model is configured,
      // and nothing afterwards.
      if (sendEffort && isUnsupportedEffortError(error)) {
        sendEffort = false;
        try {
          response = await client.messages.create(request());
        } catch (retryError) {
          return degrade(
            order,
            issues,
            retryError instanceof Anthropic.APIConnectionTimeoutError ? "timeout" : "api_error",
            retryError instanceof Error ? retryError.message : String(retryError),
          );
        }
      } else {
        const timedOut = error instanceof Anthropic.APIConnectionTimeoutError;
        return degrade(
          order,
          issues,
          timedOut ? "timeout" : "api_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // A safety decline arrives as a normal 200 with no tool call — check the
    // stop reason before reaching into `content`, or this throws on an empty
    // array. Not retried: a decline is a decision, not a slip.
    if (response.stop_reason === "refusal") {
      return degrade(order, issues, "api_error", "The model declined to answer this request.");
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use" && block.name === ANALYSIS_TOOL_NAME,
    );
    if (!toolUse) {
      // Nothing to correct and nothing to reply to — a forced tool call that
      // did not happen is structural, and asking again the same way is not a
      // fix. Degrade immediately.
      return degrade(
        order,
        issues,
        "invalid_output",
        `Model returned ${response.stop_reason ?? "no"} instead of a ${ANALYSIS_TOOL_NAME} call.`,
      );
    }

    const parsed = AnalysisSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      lastInvalidDetail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      if (attempt === MAX_ATTEMPTS) break;
      pushCorrection(
        messages,
        response,
        toolUse.id,
        `Your answer did not match the required schema and was rejected: ${lastInvalidDetail}. Call the tool again with a valid answer.`,
      );
      continue;
    }

    const grounding = validateGrounding(order, parsed.data, firedTypes);
    if (grounding.grounded) {
      return {
        analysis: parsed.data,
        source: "live",
        model: response.model,
        grounding,
        attempts: attempt,
      };
    }

    // Ungrounded. Keep it if it is the best so far — fewer bad citations is a
    // better answer to show when both attempts fail.
    if (!best || problemCount(grounding) < problemCount(best.grounding)) {
      best = { analysis: parsed.data, model: response.model, grounding };
    }
    if (attempt === MAX_ATTEMPTS) break;
    pushCorrection(messages, response, toolUse.id, groundingFeedback(grounding));
  }

  // Both attempts produced schema-valid but ungrounded output. Show it, flagged
  // — the badge is withheld and the failing citations are marked on screen.
  if (best) {
    return {
      analysis: best.analysis,
      source: "live",
      model: best.model,
      grounding: best.grounding,
      attempts: MAX_ATTEMPTS,
    };
  }

  // Both attempts failed Zod. There is no analysis to flag, so fall back.
  return degrade(order, issues, "invalid_output", lastInvalidDetail || "Output failed validation twice.");
}

/** Append the rejected tool call and the reason it was rejected. */
function pushCorrection(
  messages: Anthropic.MessageParam[],
  response: Anthropic.Message,
  toolUseId: string,
  feedback: string,
) {
  messages.push(
    { role: "assistant", content: response.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: true,
          content: feedback,
        },
      ],
    },
  );
}

function problemCount(report: GroundingReport): number {
  return report.problems.length + report.unfiredIssueTypes.length;
}

/**
 * Fall back to the cached analysis, or fail honestly if there is none.
 *
 * The cached analysis is grounded-checked too, against this order, rather than
 * trusted for having been hand-written. A fallback that cites a record which no
 * longer exists is worse than no fallback: it wears the badge while being wrong.
 */
function degrade(
  order: OrderDetail,
  issues: DetectedIssue[],
  reason: DegradeReason,
  detail: string,
): AnalysisResult {
  const cached = cachedAnalysisFor(order.orderNumber);
  if (!cached) throw new AnalysisUnavailableError(reason, detail);
  return {
    analysis: cached,
    source: "cached",
    model: null,
    grounding: validateGrounding(order, cached, issues.map((issue) => issue.type)),
    attempts: 0,
    degraded: { reason, detail },
  };
}
