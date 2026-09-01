"use client";

/**
 * Screen 2 — order details, with the detected problem.
 *
 * The reading order is the supervisor's: what is this order, what is wrong with
 * it, and what did the MES actually record. The third section matters as much
 * as the second — every claim in "Detected problems" is a citation, and the
 * record it cites is on the same screen carrying the same ID. From Tier 1 the
 * LLM's explanation appears between them, citing the same IDs in the same
 * shape, and Tier 2 refuses to badge it "Grounded in MES data" unless each one
 * resolves.
 *
 * There is no AI on this screen and no placeholder for it. An "Explain" button
 * that does nothing teaches a demo audience that the feature is flaky rather
 * than absent.
 */

import * as React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, Code, Label, Pill, Progress, type Tone } from "../primitives";
import type { DetectedIssue } from "@/lib/mes/issues";
import type { Severity } from "@/lib/mes/rules-config";
import type { OrderDetail, OrderStatus } from "@/lib/mes/types";

const STATUS_TONE: Record<OrderStatus, Tone> = {
  RELEASED: "idle",
  IN_PROGRESS: "info",
  ON_HOLD: "warn",
  COMPLETED: "ok",
  CANCELLED: "danger",
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  RELEASED: "Released",
  IN_PROGRESS: "In progress",
  ON_HOLD: "On hold",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** Severity is a rule output, so it maps onto the status vocabulary. */
const SEVERITY_TONE: Record<Severity, Tone> = {
  HIGH: "danger",
  MEDIUM: "warn",
  LOW: "info",
};

export function OrderDetailScreen({
  order,
  issues,
  analysis,
}: {
  order: OrderDetail;
  issues: DetectedIssue[];
  /**
   * The Explain flow, rendered between the problems and the records they cite.
   * Passed in rather than owned here so this screen stays presentational and
   * the page keeps every fetch.
   */
  analysis?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[var(--page-width)] flex-col gap-7 px-4 py-6">
      {/*
        ── Identity ────────────────────────────────────────────────────────
        F-08: on the page surface, not in a `fab-card`.

        Every section of this screen was a white box, so the order's identity
        competed with the problem for the eye — and identity won, because it is
        first and largest. A page title is not a card; it is the thing the cards
        are about. The only white surfaces left above the fold are the ones
        carrying a detected problem, which is where the eye should land.

        The facts keep a hairline top rule instead of the card edge: they are
        still a group, they simply are not an object.
      */}
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-[3px]">
            <Label as="h2">Production order</Label>
            <Code className="text-[26px] font-extrabold leading-[1.1]">{order.orderNumber}</Code>
          </div>
          <Pill tone={STATUS_TONE[order.status]}>{STATUS_LABEL[order.status]}</Pill>
        </div>

        <div className="flex flex-col gap-[6px]">
          <Progress value={order.completedQty} max={order.plannedQty} />
          <Code className="text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
            {order.completedQty} of {order.plannedQty} units complete
          </Code>
        </div>

        <div
          className="grid gap-4 pt-4 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))]"
          style={{ borderTop: "1px solid var(--border-light)" }}
        >
          {/* F-13: Scrap leads. The five-across grid left a hole in its last
              row at 390px, and on a phone this is the number that matters. */}
          <Fact label="Scrap" value={String(order.scrapQty)} sub={usualScrap(order)} />
          <Fact label="Product" value={order.product.name} sub={order.product.code} />
          <Fact label="Machine" value={order.machineId} sub={order.site} />
          <Fact
            label="Operation"
            value={order.operation.name}
            sub={operationSub(order)}
          />
          <Fact
            label="Planned rate"
            value={`${order.plannedRatePerHour}/h`}
            sub={`Due ${formatTime(order.dueAt)}`}
          />
        </div>
      </header>

      {/*
        ── Two columns from `lg` ───────────────────────────────────────────
        F-09: 1180px was being spent on one column of full-width cards, so the
        surplus went into line length rather than into density.

        **The split is by provenance, which is the distinction this product is
        built on.** Left is the argument — what the rules found and what the
        model says about it. Right is what the MES actually recorded. A
        supervisor checking a citation looks across, not up and down four
        screenfuls.

        **DOM order inside this grid is the mobile order**: problems →
        analysis → records. The grid changes where things sit, never what order
        they are read in.

        The decision no longer ends that sequence — it moved above this grid on
        2026-08-18. What survives of F-03 here is that the evidence still reads
        problems → analysis → records when the columns stack.
      */}
      <div className="grid items-start gap-7 lg:grid-cols-[1fr_1.1fr]">
        <div className="flex min-w-0 flex-col gap-7">
          {/* ── Problems ──────────────────────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            {/*
              Heading + one caption line — **the same shape as the "MES records"
              heading opposite**, so the first card in each column shares a top
              edge (round 6, finding 9).

              Equalised by content rather than by a shared grid row: putting both
              headings in their own row would group them together when the page
              stacks below `lg`, giving "Detected problems / MES records / cards
              / cards" and breaking the reading order F-03 established. A
              `min-height` fudge would drift the moment either line wrapped.

              The caption is now unconditional, where it used to render only when
              issues existed. That is what makes the alignment hold on an order
              with no problems too — and the sentence is true either way, since
              an empty list is also the rules' verdict rather than a model's.
            */}
            <div className="flex flex-col gap-[3px]">
              <Label as="h2">Detected problems</Label>
              {/* Said once, for the section — not once per card. It was on all
                  three issue cards, so the scenario order repeated it verbatim
                  three times. Each card still carries its own threshold
                  ("Downtime above 60 min is HIGH"), which is the part that
                  differs. */}
              <p className="m-0 text-[12px]" style={{ color: "var(--text-subtle)" }}>
                Severity is set by the rule thresholds, not by a model.
              </p>
            </div>

            {issues.length === 0 ? (
              <Card className="flex items-center gap-[11px] p-5">
                <CheckCircle2
                  size={20}
                  strokeWidth={2}
                  aria-hidden="true"
                  style={{ color: "var(--status-green)" }}
                />
                <span className="text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
                  No rule fired on this order.
                </span>
              </Card>
            ) : (
              issues.map((issue) => <IssueCard key={issue.type} issue={issue} />)
            )}
          </section>

          {analysis}
        </div>

        {/*
          The right column flows normally. **Only the decision card sticks** —
          see the wrapper around `{decision}` below.

          It was the whole column, capped at `calc(100vh-104px)` with internal
          scroll (round 3). That was the wrong shape: the left column runs about
          3,400px at `lg`, so past the first screenful you scrolled roughly
          2,400px of problems and analysis beside a pinned pane and a stripe of
          empty page surface — and the decision buttons sat inside a box with
          its own scrollbar, which is a second scroll context nobody asked for.

          The cap existed to stop a tall sticky element carrying its own bottom
          off-screen. Sticking only the decision card removes that risk at the
          source: the card is short and a fixed height regardless of how many
          downtime events the order has, so it can never outgrow the viewport.
        */}
        <div className="flex min-w-0 flex-col gap-7">
          {/* ── Records ─────────────────────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            {/* Same heading-plus-caption shape as "Detected problems" opposite,
                so the two card stacks start level (round 6, finding 9). The
                caption earns its place rather than padding the height: it says
                what this column *is* — the raw records, not an interpretation
                of them, which is the distinction the whole screen turns on. */}
            <div className="flex flex-col gap-[3px]">
              <Label as="h2">MES records</Label>
              <p className="m-0 text-[12px]" style={{ color: "var(--text-subtle)" }}>
                The records cited above, exactly as the MES returned them.
              </p>
            </div>

            <RecordGroup
              caption="Downtime events"
              empty="No downtime recorded against this order."
              rows={order.downtimeEvents.map((e) => ({
                recordId: e.recordId,
                primary: e.reason,
                fields: [
                  ["durationMinutes", `${e.durationMinutes} min`],
                  ["reasonCode", e.reasonCode],
                  ["startedAt", formatTime(e.startedAt)],
                  ["endedAt", e.endedAt ? formatTime(e.endedAt) : "still down"],
                ],
              }))}
            />

            <RecordGroup
              caption="Defect records"
              empty="No defects recorded against this order."
              rows={order.defects.map((d) => ({
                recordId: d.recordId,
                primary: d.description,
                fields: [
                  ["quantity", String(d.quantity)],
                  ["defectCode", d.defectCode],
                  ["operationNumber", String(d.operationNumber)],
                  ["recordedAt", formatTime(d.recordedAt)],
                ],
              }))}
            />
          </section>

        </div>
      </div>
    </div>
  );
}

function IssueCard({ issue }: { issue: DetectedIssue }) {
  const tone = SEVERITY_TONE[issue.severity];
  const accent = tone === "danger" ? "var(--status-red)" : "var(--status-amber)";

  return (
    <Card className="flex flex-col gap-3 overflow-hidden p-5" style={{ borderLeft: `4px solid ${accent}` }}>
      <div className="flex flex-wrap items-center gap-[9px]">
        <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" style={{ color: accent }} />
        {/* The headline below is the sentence that matters; this is a category.
            At extrabold it was outweighing its own card's content. */}
        <span className="text-[14px] font-bold">{titleCase(issue.type)}</span>
        <Pill tone={tone}>{issue.severity}</Pill>
      </div>

      <p className="m-0 text-[16px] font-semibold">{issue.headline}</p>

      {/* The threshold that fired, and only that. The generic "not by a model"
          line now sits once under the section heading. */}
      <p className="m-0 text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
        {issue.rule}
      </p>

      {/*
        Record IDs only — the full key/value pairs were rendering three times on
        this screen.

        Each problem was stated as: this card's evidence rows, then the AI's
        paragraph about it with the same pairs beside its claims, then the MES
        record itself. `EVT-2231 · durationMinutes · 42` appeared twice before
        the record it names ever showed up.

        **The AI section's citations were the ones left alone**, deliberately:
        BRIEF §4.6 requires every figure the model states to keep its citation
        beside it, and that is the claim the "Grounded in MES data" badge is
        making. This card is the one place the pairs are redundant, because its
        title already carries the defining figure ("42 min", "9.0%") — so the
        chip answers the only remaining question, which is *which record says
        so*. The pairs still appear twice: beside the AI's claims and in full
        under MES records.

        Deduplicated by record ID: MACHINE_DOWNTIME cites `durationMinutes` and
        `reason` on the same event, and two identical chips side by side would
        read as two events.
      */}
      <div className="flex flex-wrap items-center gap-[7px]">
        <Label>Evidence</Label>
        {Array.from(new Set(issue.evidence.map((ref) => ref.recordId))).map((recordId) => (
          <Code
            key={recordId}
            className="px-[7px] py-[2px] text-[12px]"
            style={{
              borderRadius: 6,
              background: "var(--brand-indigo-bg)",
              color: "var(--cockpit-indigo)",
            }}
          >
            {recordId}
          </Code>
        ))}
      </div>
    </Card>
  );
}

interface RecordRow {
  recordId: string;
  primary: string;
  fields: [string, string][];
}

function RecordGroup({
  caption,
  rows,
  empty,
}: {
  caption: string;
  rows: RecordRow[];
  empty: string;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-[13px]" style={{ borderBottom: "1px solid var(--border-light)" }}>
        <Label as="h3">{caption}</Label>
      </div>

      {rows.length === 0 ? (
        <p className="m-0 px-5 py-4 text-[14px]" style={{ color: "var(--text-subtle)" }}>
          {empty}
        </p>
      ) : (
        rows.map((row, i) => (
          <div
            key={row.recordId}
            className="flex flex-col gap-[7px] px-5 py-4"
            style={i > 0 ? { borderTop: "1px solid var(--border-light)" } : undefined}
          >
            <div className="flex flex-wrap items-baseline gap-[10px]">
              <Code
                className="px-[7px] py-[2px] text-[12px]"
                style={{
                  borderRadius: 6,
                  background: "var(--brand-indigo-bg)",
                  color: "var(--cockpit-indigo)",
                }}
              >
                {row.recordId}
              </Code>
              <span className="text-[14px] font-bold">{row.primary}</span>
            </div>
            {/* Polish 6: the key stays at caption size, the **value** steps up
                to 14px. They were both 12px, which set the fact and its label
                at the same weight in the visual hierarchy — 158 of ~185 text
                nodes on this screen were 12px, and that uniformity is the main
                thing that made it read as a dashboard rather than a record.
                `min-w-0` + `anywhere` so a long reason wraps inside its card
                instead of pushing past the edge at 390px. */}
            <div className="flex flex-wrap gap-x-5 gap-y-[3px]">
              {row.fields.map(([field, value]) => (
                <span key={field} className="flex min-w-0 max-w-full items-baseline gap-[6px]">
                  <span
                    className="flex-none whitespace-nowrap text-[12px] font-semibold"
                    style={{ color: "var(--text-subtle)" }}
                  >
                    {field}
                  </span>
                  <Code className="min-w-0 text-[14px] [overflow-wrap:anywhere]">{value}</Code>
                </span>
              ))}
            </div>
          </div>
        ))
      )}
    </Card>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px]">
      <Label>{label}</Label>
      {/* `bold`, not `extrabold`. With the caption above it now regular weight,
          the value no longer has to shout to win the pair — and extrabold at
          16px was competing with the page's own h1. */}
      <span className="truncate text-[16px] font-bold">{value}</span>
      {sub ? (
        <span className="text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
          {sub}
        </span>
      ) : null}
    </div>
  );
}

function titleCase(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The product's scrap baseline, in parts — not in percent.
 *
 * The caption used to read "1.9% vs 2.0% baseline": two derived percentages,
 * neither of which anybody on a shop floor counts. Parts in a reject bin are
 * counted. `baselineDefectRate × completedQty` is the identical comparison
 * stated in the same unit as the big number directly above it, so "56" against
 * "Baseline 12 units" needs no arithmetic to read — where "9.0% vs 2.0%" needed
 * two conversions before it meant a quantity.
 *
 * Worded as *baseline* rather than as an expectation, because that is what the
 * figure is: `product.baselineDefectRate` scaled to this run. Naming its source
 * is the same discipline the rest of the screen keeps — a supervisor should
 * always be able to tell a recorded fact from a conclusion drawn off one.
 *
 * The denominator is deliberately dropped: the progress line a few pixels above
 * already says "620 of 1000 units complete", and repeating it here was most of
 * what made this caption long enough to wrap.
 *
 * Returns undefined before anything is made — a baseline scaled to a production
 * run of zero is arithmetic, not information.
 */
function usualScrap(order: OrderDetail): string | undefined {
  if (order.completedQty <= 0) return undefined;
  const baseline = Math.round(order.product.baselineDefectRate * order.completedQty);
  if (baseline === 0) return "Baseline under 1 unit";
  return `Baseline ${baseline} ${baseline === 1 ? "unit" : "units"}`;
}

/**
 * "started 32h ago" — how long the current operation has been running.
 *
 * Two things were dropped from this caption, for different reasons.
 *
 * **The absolute timestamp** ("from Aug 08, 11:00 PM") made the reader do the
 * subtraction, and the subtraction was what they wanted: elapsed time on the
 * step is what the delay rule measures and what a supervisor asks.
 *
 * **The operation number** ("Op 40") was dropped because this screen shows a
 * position in a sequence it never shows the rest of. `MESAdapter` carries one
 * `OperationRecord` — the step currently running — so there is no routing to
 * put Op 40 in context, and to a reader who does not already know the routing
 * the number says only "there is some numbering scheme and this is 40 in it".
 * The name alone is complete.
 *
 * The number is still real and still load-bearing in the data — `DefectRecord`
 * carries `operationNumber`, which is how you know 14 skewed labels came from
 * packing rather than assembly. Nothing on screen joins on it today. When the
 * contract grows the whole routing (Tier 4, against a real MES) the right move
 * is a stepper — Setup → Sub-assembly → Final assembly → **Pack** — which makes
 * the number self-explanatory instead of needing a caption to rescue it.
 *
 * Measured against `order.asOf`, never `Date.now()` — every other figure on the
 * screen is as of that instant, and a duration that quietly grew against wall
 * clock time while the quantities beside it stayed frozen would be the same
 * class of defect as the unbounded delay ratio.
 */
function operationSub(order: OrderDetail): string | undefined {
  const elapsed = elapsedSince(order.operation.startedAt, order.asOf);
  return elapsed ? `started ${elapsed} ago` : undefined;
}

/** Coarse by design: minutes under an hour, then hours, then days. */
function elapsedSince(iso: string, asOf: string): string | null {
  const ms = new Date(asOf).getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
