"use client";

/**
 * The Explain Issue panel — the AI half of the story, and the decision that
 * ends it.
 *
 * Four states, all of them real: idle (a button), loading (a genuine 2–5s
 * round trip, so a skeleton rather than a spinner that lies about progress),
 * ready, and degraded. Degraded is not an error screen — it renders the cached
 * analysis *and says so*, because the alternative is a demo that either dies on
 * a flaky network or quietly passes a saved answer off as a fresh one.
 *
 * Everything the model says is rendered beside the record it cites. That is the
 * point of the whole product: the supervisor can check the AI's homework
 * without leaving the screen.
 */

import * as React from "react";
import {
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Button, Card, Code, Label, Pill } from "../primitives";
import type { AnalysisResult, DegradeReason } from "@/lib/ai/analyze";
import type { CitationProblem, GroundingReport } from "@/lib/ai/grounding";
import type { EvidenceRefOut } from "@/lib/ai/schema";
import { formatFieldValue } from "@/lib/format";

export type AnalysisState = "idle" | "loading" | "ready" | "error";

const DEGRADE_TEXT: Record<DegradeReason, string> = {
  no_api_key: "this server has no API key configured",
  api_error: "the model could not be reached",
  timeout: "the model did not answer in time",
  invalid_output: "the model's answer failed validation",
};

export function AnalysisPanel({
  issueCount,
  state,
  result,
  errorDetail,
  onExplain,
}: {
  issueCount: number;
  state: AnalysisState;
  result: AnalysisResult | null;
  errorDetail?: string;
  onExplain: () => void;
}) {
  // Nothing fired, so there is nothing to explain. No button — a control that
  // would return "no issues found" is a control that shouldn't be there.
  if (issueCount === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <Label as="h2">AI analysis</Label>

      {state === "idle" ? (
        <Card className="flex flex-col items-start gap-3 p-5">
          <p className="m-0 text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
            {issueCount === 1
              ? "One rule fired on this order."
              : `${issueCount} rules fired on this order.`}{" "}
            Ask for an explanation of what is happening and one recommended next action.
          </p>
          <Button variant="primary" onClick={onExplain}>
            <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
            Call agent to get analysis
          </Button>
        </Card>
      ) : null}

      {state === "loading" ? <LoadingCard /> : null}

      {state === "error" ? (
        <Card className="flex flex-col items-start gap-3 p-5" style={{ borderLeft: "4px solid var(--status-red)" }}>
          <div className="flex items-center gap-[9px]">
            <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" style={{ color: "var(--status-red)" }} />
            <span className="text-[14px] font-extrabold">No analysis available</span>
          </div>
          <p className="m-0 text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
            {errorDetail ?? "The explanation could not be produced."} The order details above are
            unaffected — they come from the MES, not from the model.
          </p>
          <Button onClick={onExplain}>Try again</Button>
        </Card>
      ) : null}

      {/* The decision card is deliberately NOT here — see `DecisionSection`. */}
      {state === "ready" && result ? <AnalysisCard result={result} /> : null}
    </section>
  );
}

/* ── Loading ──────────────────────────────────────────────────────────────
   A real wait deserves a real signal. The line names what is happening so the
   pause reads as work rather than as a hang. */

function LoadingCard() {
  return (
    <Card className="flex flex-col gap-3 p-5" aria-live="polite" aria-busy="true">
      <div className="flex items-center gap-[9px]">
        <Sparkles
          size={17}
          strokeWidth={2}
          aria-hidden="true"
          className="fab-pulse motion-reduce:animate-none"
          style={{ color: "var(--cockpit-indigo)" }}
        />
        <span className="text-[14px] font-bold">Reading the MES records for this order…</span>
      </div>
      <div className="flex flex-col gap-[7px]">
        {["92%", "78%", "85%", "45%"].map((width, i) => (
          <span
            key={width}
            className="fab-pulse motion-reduce:animate-none"
            style={{
              height: 11,
              width,
              borderRadius: 999,
              background: "var(--field-bg)",
              animationDelay: `${i * 110}ms`,
            }}
          />
        ))}
      </div>
    </Card>
  );
}

/* ── The analysis ─────────────────────────────────────────────────────────── */

function AnalysisCard({ result }: { result: AnalysisResult }) {
  const { analysis, source, model, degraded, grounding } = result;

  // Failing citations, keyed by the path the validator recorded them under, so
  // each one can be marked where it is rendered rather than only summarised.
  const faults = React.useMemo(
    () => new Map(grounding.problems.map((problem) => [problem.path, problem])),
    [grounding],
  );

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-[9px]">
          <Sparkles size={17} strokeWidth={2} aria-hidden="true" style={{ color: "var(--cockpit-indigo)" }} />
          <span className="text-[14px] font-extrabold">Explanation</span>
        </div>
        <div className="flex flex-wrap items-center gap-[7px]">
          <GroundingBadge grounding={grounding} />
          <Pill tone={source === "live" ? "info" : "warn"}>
            {source === "live" ? "Live analysis" : "Cached analysis"}
          </Pill>
        </div>
      </div>

      {grounding.grounded ? null : <GroundingWarning grounding={grounding} />}

      {degraded ? (
        <p
          role="status"
          className="m-0 px-4 py-[10px] text-[12px]"
          style={{
            borderRadius: "var(--r-control)",
            background: "var(--status-amber-bg)",
            color: "var(--status-amber-ink)",
          }}
        >
          Showing a saved analysis for this order because {DEGRADE_TEXT[degraded.reason]}. It has
          not been generated from the current data.
        </p>
      ) : null}

      <p className="m-0 max-w-[var(--measure)] text-[16px] leading-[1.6]">{analysis.summary}</p>

      <div className="flex flex-col gap-3">
        {analysis.issues.map((issue, i) => (
          <div
            key={issue.type}
            className="flex flex-col gap-[9px] pt-3"
            style={{ borderTop: "1px solid var(--border-light)" }}
          >
            <Label>{titleCase(issue.type)}</Label>
            <p className="m-0 text-[14px] leading-[1.6]">{issue.explanation}</p>
            <EvidenceList refs={issue.evidence} faults={faults} pathPrefix={`issues[${i}].evidence`} />
          </div>
        ))}
      </div>

      {/* Recommendation — one action, never a plan. */}
      <div
        className="flex flex-col gap-[9px] p-4"
        style={{
          borderRadius: "var(--r-panel)",
          background: "var(--brand-indigo-bg)",
        }}
      >
        <Label>Recommended next action</Label>
        {/* Ink, not indigo — design review F-06. This was the only tinted panel
            on the screen *and* its sentence was 16px extrabold in the brand
            colour: three levels of emphasis stacked on the one paragraph that
            must never look like the system acting (rule 8). The tint and the
            eyebrow stay, so it is still the most prominent thing in this card;
            it is no longer the most prominent thing on the page. */}
        <p
          className="m-0 max-w-[var(--measure)] text-[16px] font-semibold leading-[1.5]"
          style={{ color: "var(--text-ink)" }}
        >
          {analysis.recommendation.action}
        </p>
        <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
          {analysis.recommendation.rationale}
        </p>
        <EvidenceList
          refs={analysis.recommendation.evidence}
          faults={faults}
          pathPrefix="recommendation.evidence"
        />
      </div>

      <p className="m-0 text-[12px]" style={{ color: "var(--text-subtle)" }}>
        {model ? `${model} · ` : ""}
        {grounding.citationsChecked} citation{grounding.citationsChecked === 1 ? "" : "s"} checked
        against the MES{result.attempts > 1 ? ", after one correction" : ""}. The AI explains and
        recommends. Severity comes from the rules, and only you can decide what happens next.
      </p>
    </Card>
  );
}

/* ── Grounding ────────────────────────────────────────────────────────────
   The badge is the product's central claim, so it is computed and never
   decorative: it renders from `grounding.grounded` and from nothing else. */

function GroundingBadge({ grounding }: { grounding: GroundingReport }) {
  if (grounding.grounded) {
    return (
      <Pill tone="ok" dot={false}>
        <ShieldCheck size={13} strokeWidth={2.4} aria-hidden="true" />
        Grounded in MES data
      </Pill>
    );
  }
  return (
    <Pill tone="danger" dot={false}>
      <ShieldAlert size={13} strokeWidth={2.4} aria-hidden="true" />
      Citations not verified
    </Pill>
  );
}

/**
 * Why the badge was withheld, in the supervisor's terms.
 *
 * Shown rather than hidden. An analysis that failed validation twice is still
 * on screen — swallowing it would leave the operator with nothing and teach the
 * room that the badge appears whenever the AI answers.
 */
function GroundingWarning({ grounding }: { grounding: GroundingReport }) {
  const bad = grounding.problems.length;
  return (
    <div
      role="status"
      className="flex flex-col gap-[6px] px-4 py-[11px] text-[12px]"
      style={{
        borderRadius: "var(--r-control)",
        background: "var(--status-red-bg)",
        color: "var(--status-red)",
      }}
    >
      <span className="font-bold">
        {bad > 0
          ? `${bad} of ${grounding.citationsChecked} citations did not match the MES record they name.`
          : "This analysis describes a problem the rules did not detect."}
      </span>
      <span className="font-semibold leading-[1.55]" style={{ color: "var(--text-muted-cool)" }}>
        The explanation below is shown as it was returned, with the failing citations marked. Check
        the order details above before acting on it.
        {grounding.unfiredIssueTypes.length > 0
          ? ` No rule detected: ${grounding.unfiredIssueTypes.map(titleCase).join(", ")}.`
          : ""}
      </span>
    </div>
  );
}

/** Citations, rendered exactly as the rules' own evidence is — plus what failed. */
function EvidenceList({
  refs,
  faults,
  pathPrefix,
}: {
  refs: EvidenceRefOut[];
  faults: Map<string, CitationProblem>;
  pathPrefix: string;
}) {
  if (refs.length === 0) return null;
  return (
    <div className="flex flex-col gap-[5px]">
      <Label>Evidence</Label>
      {/* One wrapping strip, not one row per citation — design review F-05.
          The AI section measured 49% of the page, largely because 23 citation
          rows stacked vertically, 8 distinct triples repeating. Wrapping them
          reclaims about a third of the card's height while **removing
          nothing**: every citation is still on screen beside its claim, which
          is the constraint that matters. `whitespace-nowrap` on each group
          keeps a record id from breaking mid-token at narrow widths. */}
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-[5px] p-0">
        {refs.map((ref, i) => {
          const fault = faults.get(`${pathPrefix}[${i}]`);
          return (
            <li key={`${ref.record_id}.${ref.field}.${i}`} className="min-w-0 max-w-full">
              {/*
                `min-w-0` on the row and the value, because a flex item's default
                `min-width: auto` refuses to shrink below its content — which is
                how a long `reason` ("Feeder jam at station 3 — magazine
                misfeed") pushed ~26px past the card edge at 390px.

                The id chip keeps `whitespace-nowrap` so a record id never breaks
                mid-token; the **value** is the only part allowed to wrap, via
                `overflow-wrap: anywhere`. Wrapping the id or splitting a pair
                across lines would orphan a value from the record it belongs to,
                and an unattributed figure is the one thing this screen must
                never show.
              */}
              <span className="flex min-w-0 max-w-full items-baseline gap-[8px] text-[12px]">
                <Code
                  className="flex-none whitespace-nowrap px-[7px] py-[2px] text-[12px]"
                  style={{
                    borderRadius: 6,
                    background: "var(--pure-white)",
                    border: `1px solid ${fault ? "var(--status-red)" : "var(--border-light)"}`,
                    color: fault ? "var(--status-red)" : "var(--cockpit-indigo)",
                  }}
                >
                  {ref.record_id}
                </Code>
                <span className="flex-none whitespace-nowrap" style={{ color: "var(--text-subtle)" }}>
                  {ref.field}
                </span>
                {/* 14px, not 12 — polish 6. The value is the fact; its key is a
                    caption. Setting both at caption size is the main reason this
                    screen reads as a dashboard. */}
                <span
                  className="min-w-0 text-[14px] font-semibold [overflow-wrap:anywhere]"
                  style={fault ? { color: "var(--status-red)", textDecoration: "line-through" } : undefined}
                >
                  {formatFieldValue(ref.value)}
                </span>
                {fault ? <FaultNote fault={fault} /> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * What the record actually holds.
 *
 * The whole point of the check: a wrong value beside a real record ID is the one
 * error a supervisor cannot catch by reading, because it looks exactly as
 * authoritative as a right one.
 */
function FaultNote({ fault }: { fault: CitationProblem }) {
  const text =
    fault.fault === "unknown_record"
      ? "no such record"
      : fault.fault === "unknown_field"
        ? "no such field on this record"
        // Formatted like every other value on screen. A correction printed as
        // raw ISO beside a formatted citation would be its own small version of
        // the defect F-01 fixed.
        : `MES holds ${fault.actual ? formatFieldValue(fault.actual) : "nothing"}`;

  return (
    <span
      className="px-[7px] py-[2px] text-[12px] font-bold"
      style={{
        borderRadius: 6,
        background: "var(--status-red-bg)",
        color: "var(--status-red)",
      }}
    >
      {text}
    </span>
  );
}

/* ── The decision ─────────────────────────────────────────────────────────── */

function titleCase(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

