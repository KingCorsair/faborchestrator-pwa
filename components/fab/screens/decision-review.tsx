"use client";

/**
 * Screen 4 — decision review.
 *
 * One row per order that has been decided, showing **the decision in force**
 * and letting a manager overrule it. The activity feed answers "what happened"
 * and is a flat list of events; this answers "what stands right now", which is
 * the question somebody revisiting an approval an hour later actually has.
 *
 * ── An override is a new decision, never an edit ────────────────────────────
 * Overruling appends a record that names the one it replaced. The original
 * stays on screen, marked superseded, under a disclosure. Editing the original
 * in place would destroy the only evidence of what was first decided and by
 * whom — and that is the one thing a decision log exists to keep. "Approved at
 * 14:22, overridden at 16:40 because the feeder was still jammed" is auditable;
 * "rejected at 16:40" alone is not.
 *
 * A reason is **required** to override and optional on a first decision. The
 * asymmetry is deliberate: a first decision sits next to the analysis that
 * explains it, and an override sits next to nothing but disagreement.
 *
 * Rule 8 is untouched. Overriding an approval records that a manager disagreed.
 * It does not restart a machine, and nothing reachable from this screen can.
 */

import * as React from "react";
import { ClipboardCheck, Sparkles, Undo2 } from "lucide-react";
import { Button, Card, Code, EmptyState, ErrorState, Label, Pill, SkeletonBar } from "../primitives";
import type { Decision, DecisionKind, OrderDecision } from "@/lib/decisions";

type Filter = DecisionKind | "ALL";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "APPROVE", label: "Approved" },
  { value: "REJECT", label: "Rejected" },
  { value: "ESCALATE", label: "Escalated" },
  { value: "ALL", label: "All" },
];

export function DecisionReview({
  decisions,
  durable,
  state,
  errorDetail,
  onRetry,
  onOpenOrder,
  onOverride,
  busyOrderNumber,
}: {
  decisions: OrderDecision[];
  durable: boolean;
  state: "data" | "empty" | "loading" | "error";
  errorDetail?: string;
  onRetry: () => void;
  onOpenOrder: (orderNumber: string) => void;
  /** Resolves to an error message, or null when the override was recorded. */
  onOverride: (
    entry: OrderDecision,
    decision: DecisionKind,
    reason: string,
  ) => Promise<string | null>;
  busyOrderNumber?: string | null;
}) {
  // Approvals first, because that is what somebody comes here to revisit — a
  // rejected order is already in front of whoever it was escalated to.
  const [filter, setFilter] = React.useState<Filter>("APPROVE");

  const visible = React.useMemo(
    () => (filter === "ALL" ? decisions : decisions.filter((d) => d.current.decision === filter)),
    [decisions, filter],
  );

  return (
    <div className="mx-auto flex w-full max-w-[var(--page-width)] flex-col gap-7 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-[3px]">
          <Label as="h2">Review</Label>
          <h1 className="text-[26px]">Decisions</h1>
        </div>
        {state === "data" ? (
          <span className="text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
            {visible.length} of {decisions.length} {decisions.length === 1 ? "order" : "orders"}
          </span>
        ) : null}
      </div>

      {!durable ? (
        <p
          role="status"
          className="m-0 px-4 py-[10px] text-[12px]"
          style={{
            borderRadius: "var(--r-control)",
            background: "var(--status-amber-bg)",
            color: "var(--status-amber-ink)",
          }}
        >
          This log is held in memory only. It is cleared when the server restarts and is not shared
          between instances. Overrides recorded here are lost with it. Durable storage arrives with
          Tier 3.
        </p>
      ) : null}

      {/* Filter by the decision in force, not by anything in the history: a
          manager filtering to "Approved" wants orders that are approved now. */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by decision">
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(option.value)}
              className="cursor-pointer px-[13px] py-[7px] text-[12px] font-bold transition-colors"
              style={{
                borderRadius: "var(--r-chip)",
                border: `1px solid ${active ? "transparent" : "var(--border-light)"}`,
                background: active ? "var(--nav-active)" : "var(--pure-white)",
                color: active ? "var(--pure-white)" : "var(--text-muted-cool)",
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {state === "loading" ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex flex-col gap-3 p-5">
              <SkeletonBar width={180} height={14} delayMs={i * 90} />
              <SkeletonBar width="70%" delayMs={i * 90 + 60} />
            </Card>
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState
          title="Could not load decisions"
          detail={errorDetail ?? "GET /api/decisions"}
          explanation="Nothing was changed. No decision was recorded or altered."
          onRetry={onRetry}
        />
      ) : state === "empty" ? (
        <Card className="p-2">
          <EmptyState
            icon={<ClipboardCheck size={22} strokeWidth={2} aria-hidden="true" />}
            title="No decisions yet"
            explanation="Open an order with a detected problem, ask for an explanation, and approve, reject or escalate the recommendation. It will appear here for review."
          />
        </Card>
      ) : filter !== "ALL" && visible.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={<ClipboardCheck size={22} strokeWidth={2} aria-hidden="true" />}
            title={`No orders are currently ${LABEL[filter].toLowerCase()}`}
            explanation={`${decisions.length} ${decisions.length === 1 ? "order has" : "orders have"} a decision on record. Switch the filter to see ${decisions.length === 1 ? "it" : "them"}.`}
            actionLabel="Show all"
            onAction={() => setFilter("ALL")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {visible.map((entry) => (
            <li key={entry.orderNumber}>
              <DecisionRow
                entry={entry}
                busy={busyOrderNumber === entry.orderNumber}
                onOpenOrder={() => onOpenOrder(entry.orderNumber)}
                onOverride={(decision, reason) => onOverride(entry, decision, reason)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionRow({
  entry,
  busy,
  onOpenOrder,
  onOverride,
}: {
  entry: OrderDecision;
  busy: boolean;
  onOpenOrder: () => void;
  onOverride: (decision: DecisionKind, reason: string) => Promise<string | null>;
}) {
  const [overriding, setOverriding] = React.useState(false);
  const { current, superseded } = entry;

  return (
    <Card className="flex flex-col gap-[11px] p-5">
      <div className="flex flex-wrap items-center gap-[9px]">
        <Pill tone={toneFor(current.decision)}>{LABEL[current.decision]}</Pill>
        <button
          type="button"
          onClick={onOpenOrder}
          className="cursor-pointer border-0 bg-transparent p-0 text-[16px] font-extrabold underline-offset-2 hover:underline"
          style={{ color: "var(--cockpit-indigo)", fontVariantNumeric: "tabular-nums" }}
        >
          {entry.orderNumber}
        </button>
        {current.supersedesId ? (
          <span
            className="inline-flex items-center gap-[5px] text-[12px] font-bold"
            style={{ color: "var(--text-subtle)" }}
          >
            <Undo2 size={12} strokeWidth={2.2} aria-hidden="true" />
            Override of {current.supersedesId}
          </span>
        ) : null}
        <Code className="ml-auto text-[12px]" style={{ color: "var(--text-subtle)" }}>
          {formatWhen(current.decidedAt)} · {current.id}
        </Code>
      </div>

      {/* The human first — design review F-10. This screen exists to review what
          people decided; the model's advice is the context, not the headline. */}
      {current.note ? (
        <p className="m-0 max-w-[var(--measure)] text-[16px] leading-[1.55]" style={{ color: "var(--text-ink)" }}>
          “{current.note}”
        </p>
      ) : null}

      {/* No analysis behind this one — said plainly rather than left blank. What
          the decision was answering is exactly what a reviewer is here to
          check, and "nothing" is a legitimate answer to that. */}
      {current.analysisSource === "none" ? (
        <span className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
          Decided without an AI analysis
        </span>
      ) : (
        <div className="flex flex-col gap-[5px]">
          <span className="flex items-center gap-[6px]">
            <Sparkles
              size={12}
              strokeWidth={2.2}
              aria-hidden="true"
              style={{ color: "var(--text-subtle)" }}
            />
            <Label>
              Recommended {current.analysisSource === "cached" ? "(cached analysis)" : "(live analysis)"}
            </Label>
          </span>
          <span
            className="max-w-[var(--measure)] text-[14px] leading-[1.5]"
            style={{ color: "var(--text-muted-cool)" }}
          >
            {current.recommendedAction}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
          {current.decidedByEmail}
        </span>
        {!overriding ? (
          <Button onClick={() => setOverriding(true)} disabled={busy}>
            <Undo2 size={15} strokeWidth={2.2} aria-hidden="true" />
            Override
          </Button>
        ) : null}
      </div>

      {overriding ? (
        <OverrideForm
          current={current}
          busy={busy}
          onCancel={() => setOverriding(false)}
          onSubmit={async (decision, reason) => {
            const error = await onOverride(decision, reason);
            if (!error) setOverriding(false);
            return error;
          }}
        />
      ) : null}

      {superseded.length > 0 ? <SupersededTrail decisions={superseded} /> : null}
    </Card>
  );
}

function OverrideForm({
  current,
  busy,
  onCancel,
  onSubmit,
}: {
  current: Decision;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (decision: DecisionKind, reason: string) => Promise<string | null>;
}) {
  // Pre-selecting nothing is the point. A form that opens with the opposite
  // decision already chosen invites an override made by clicking twice.
  const [choice, setChoice] = React.useState<DecisionKind | null>(null);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const reasonId = React.useId();

  const ready = choice != null && reason.trim().length > 0 && !busy;

  return (
    <div
      className="flex flex-col gap-3 p-4"
      style={{
        borderRadius: "var(--r-control)",
        border: "1px solid var(--border-light)",
        background: "var(--cockpit-surface)",
      }}
    >
      <div className="flex flex-col gap-[7px]">
        <Label>Replace with</Label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="New decision">
          {(["APPROVE", "REJECT", "ESCALATE"] as const).map((kind) => {
            const active = choice === kind;
            const unchanged = kind === current.decision;
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={active}
                disabled={unchanged}
                title={unchanged ? `This order is already ${LABEL[kind].toLowerCase()}` : undefined}
                onClick={() => setChoice(kind)}
                className="cursor-pointer px-[13px] py-[8px] text-[12px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                style={{
                  borderRadius: "var(--r-chip)",
                  border: `1px solid ${active ? "transparent" : "var(--border-light)"}`,
                  background: active ? "var(--nav-active)" : "var(--pure-white)",
                  color: active ? "var(--pure-white)" : "var(--text-muted-cool)",
                }}
              >
                {LABEL[kind]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-[7px]">
        <label htmlFor={reasonId}>
          <Label>Reason (required)</Label>
        </label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Why the earlier decision no longer stands. This is what an auditor reads."
          className="w-full resize-y p-[11px] text-[14px] leading-[1.5]"
          style={{
            borderRadius: "var(--r-control)",
            border: "1px solid var(--border-light)",
            background: "var(--pure-white)",
            color: "var(--text-ink)",
          }}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="m-0 text-[12px]"
          style={{ color: "var(--status-red)" }}
        >
          {error}
        </p>
      ) : null}

      <p className="m-0 text-[12px]" style={{ color: "var(--text-subtle)" }}>
        {current.id} stays on record, marked superseded. This changes the decision log only — nothing
        is sent to the MES or to the machine.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!ready}
          onClick={async () => {
            if (!choice) return;
            setError(null);
            setError(await onSubmit(choice, reason.trim()));
          }}
        >
          {busy ? "Recording…" : "Record override"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The decisions this order has been through, newest first, behind a disclosure. */
function SupersededTrail({ decisions }: { decisions: Decision[] }) {
  return (
    <details style={{ borderTop: "1px solid var(--border-light)", paddingTop: 11 }}>
      <summary
        className="cursor-pointer text-[12px] font-bold"
        style={{ color: "var(--text-muted-cool)" }}
      >
        {decisions.length} superseded {decisions.length === 1 ? "decision" : "decisions"}
      </summary>
      <ul className="m-0 mt-[9px] flex list-none flex-col gap-[9px] p-0">
        {decisions.map((decision) => (
          <li
            key={decision.id}
            className="flex flex-col gap-[5px] pl-[11px]"
            style={{ borderLeft: "2px solid var(--border-light)" }}
          >
            <span className="flex flex-wrap items-center gap-[8px]">
              <Pill tone="idle" dot={false} className="line-through">
                {LABEL[decision.decision]}
              </Pill>
              <Code className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
                {formatWhen(decision.decidedAt)} · {decision.id} · {decision.decidedByEmail}
              </Code>
            </span>
            {decision.note ? (
              <span className="text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
                “{decision.note}”
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

const LABEL: Record<DecisionKind, string> = {
  APPROVE: "Approved",
  REJECT: "Rejected",
  ESCALATE: "Escalated",
};

function toneFor(kind: DecisionKind) {
  if (kind === "APPROVE") return "ok" as const;
  if (kind === "REJECT") return "danger" as const;
  return "warn" as const;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
