"use client";

/**
 * Screen 3 — the activity feed.
 *
 * Every decision a supervisor recorded, newest first, across every order. The
 * point is not the list: it is that each row carries **the recommendation the
 * decision answered**. A log that says "PO-10382 · rejected · 14:22" is
 * unauditable six weeks later, because nobody remembers what was rejected. A
 * row that says what the AI advised, whether that advice was live or cached,
 * and what the supervisor did about it is a record somebody can actually review.
 *
 * Read-only by construction. There is no control here that changes anything —
 * decisions are made on the order, in front of the evidence, which is the only
 * place they should be.
 */

import * as React from "react";
import { ClipboardList, Sparkles, Undo2 } from "lucide-react";
import { Card, Code, EmptyState, ErrorState, Label, Pill, SkeletonBar } from "../primitives";
import type { Decision, DecisionKind } from "@/lib/decisions";

export function ActivityFeed({
  activity,
  durable,
  state,
  errorDetail,
  onRetry,
  onOpenOrder,
}: {
  activity: Decision[];
  durable: boolean;
  state: "data" | "empty" | "loading" | "error";
  errorDetail?: string;
  onRetry: () => void;
  onOpenOrder: (orderNumber: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[var(--page-width)] flex-col gap-7 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-[3px]">
          <Label as="h2">Audit</Label>
          <h1 className="text-[26px]">Activity</h1>
        </div>
        {state === "data" ? (
          <span className="text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
            {activity.length} {activity.length === 1 ? "decision" : "decisions"}
          </span>
        ) : null}
      </div>

      {/* Said on screen, not buried in a comment. A log that forgets on restart
          and does not admit it is worse than no log — somebody will cite it. */}
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
          between instances. Durable storage arrives with Tier 3.
        </p>
      ) : null}

      {state === "loading" ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex flex-col gap-3 p-5">
              <SkeletonBar width={160} height={14} delayMs={i * 90} />
              <SkeletonBar width="70%" delayMs={i * 90 + 60} />
            </Card>
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState
          title="Could not load activity"
          detail={errorDetail ?? "GET /api/activity"}
          explanation="Nothing was changed. This screen only reads the decision log."
          onRetry={onRetry}
        />
      ) : state === "empty" ? (
        <Card className="p-2">
          <EmptyState
            icon={<ClipboardList size={22} strokeWidth={2} aria-hidden="true" />}
            title="No decisions yet"
            explanation="Open an order with a detected problem, ask for an explanation, and approve, reject or escalate the recommendation. It will appear here."
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {activity.map((entry) => (
            <li key={entry.id}>
              <ActivityRow entry={entry} onOpenOrder={() => onOpenOrder(entry.orderNumber)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityRow({ entry, onOpenOrder }: { entry: Decision; onOpenOrder: () => void }) {
  return (
    <Card className="flex flex-col gap-[11px] p-5">
      <div className="flex flex-wrap items-center gap-[9px]">
        <Pill tone={toneFor(entry.decision)}>{LABEL[entry.decision]}</Pill>
        <button
          type="button"
          onClick={onOpenOrder}
          className="cursor-pointer border-0 bg-transparent p-0 text-[16px] font-extrabold underline-offset-2 hover:underline"
          style={{ color: "var(--cockpit-indigo)", fontVariantNumeric: "tabular-nums" }}
        >
          {entry.orderNumber}
        </button>
        {/* Without this the feed shows two contradictory decisions on one order
            and no relationship between them. Overrides are ordinary rows here —
            the feed is a list of events, and an override is an event. */}
        {entry.supersedesId ? (
          <span
            className="inline-flex items-center gap-[5px] text-[12px] font-bold"
            style={{ color: "var(--text-subtle)" }}
          >
            <Undo2 size={12} strokeWidth={2.2} aria-hidden="true" />
            Override of {entry.supersedesId}
          </span>
        ) : null}
        <Code className="ml-auto text-[12px]" style={{ color: "var(--text-subtle)" }}>
          {formatWhen(entry.decidedAt)} · {entry.id}
        </Code>
      </div>

      {/* What the human said, as the body of the card — design review F-10.
          This is an audit trail of human decisions; the AI's advice is context
          for it, not the headline. */}
      {entry.note ? (
        <p className="m-0 max-w-[var(--measure)] text-[16px] leading-[1.55]" style={{ color: "var(--text-ink)" }}>
          “{entry.note}”
        </p>
      ) : null}

      {/* The advice the decision answered. Without this the row is unauditable —
          nobody remembers six weeks later what was approved. Unfilled and
          smaller than the note, but the sparkle and label keep it clearly the
          model's words and not the supervisor's.

          When there was no analysis the row says exactly that, rather than
          hiding the block. An absent recommendation is itself auditable
          information: this decision was taken without asking the model. */}
      {entry.analysisSource === "none" ? (
        <span className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
          Decided without an AI analysis
        </span>
      ) : (
        <div className="flex flex-col gap-[5px]">
          <span className="flex items-center gap-[6px]">
            <Sparkles size={12} strokeWidth={2.2} aria-hidden="true" style={{ color: "var(--text-subtle)" }} />
            <Label>
              Recommended {entry.analysisSource === "cached" ? "(cached analysis)" : "(live analysis)"}
            </Label>
          </span>
          <span
            className="max-w-[var(--measure)] text-[14px] leading-[1.5]"
            style={{ color: "var(--text-muted-cool)" }}
          >
            {entry.recommendedAction}
          </span>
        </div>
      )}

      <span className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
        {entry.decidedByEmail}
      </span>
    </Card>
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
