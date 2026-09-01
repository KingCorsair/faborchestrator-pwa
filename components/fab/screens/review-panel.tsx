"use client";

/**
 * The review panel — top of `/orders`, above the list.
 *
 * Pick a production order, add a note if there is one to add, and record
 * Approve / Reject / Escalate. **Always present.** It is the first thing on the
 * page behind the landing page's CTA, and it is never gated on anything.
 *
 * ── Why it exists (2026-08-18) ──────────────────────────────────────────────
 * The only way to record a decision used to be the card on the order screen,
 * and that card was hidden until an analysis had been requested and had
 * answered — a ten-second model call. So a supervisor who opened an order saw
 * no way to review it at all, which read as the feature being broken rather
 * than as it being conditional. Asked for by the reviewer relaying Jothi: the
 * option to review an order of your choice should be at the top and always
 * ready.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It records a decision. It does not act on one — rule 8, and the `MESAdapter`
 * contract still has no write method for it to call. Nothing on this panel
 * touches the shop floor.
 *
 * ── The honest part ─────────────────────────────────────────────────────────
 * A decision taken here has no analysis behind it, and it is logged saying so:
 * `analysisSource: "none"`, `recommendedAction: null`, rendered everywhere as
 * *"Decided without an AI analysis"*. The alternative — writing a placeholder
 * recommendation so the row looks complete — would put words in the model's
 * mouth in an audit trail, which is the one thing this app exists to argue
 * against. The panel says the same thing on its face, so nobody records one by
 * accident.
 */

import * as React from "react";
import { CheckCircle2, ChevronRight, ShieldQuestion, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button, Label } from "../primitives";
import type { DecisionKind } from "@/lib/decisions";
import type { OrderSummary } from "@/lib/mes/types";

const DECISIONS: { kind: DecisionKind; label: string; icon: typeof ThumbsUp }[] = [
  { kind: "APPROVE", label: "Approve", icon: ThumbsUp },
  { kind: "REJECT", label: "Reject", icon: ThumbsDown },
  { kind: "ESCALATE", label: "Escalate", icon: ShieldQuestion },
];

export type ReviewState =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "done"; decisionId: string; orderNumber: string }
  | { status: "error"; message: string };

export function ReviewPanel({
  orders,
  selected,
  onSelect,
  state,
  onReview,
  onOpenOrder,
}: {
  /** The orders currently listed. The picker offers what the list shows. */
  orders: OrderSummary[];
  selected: string;
  onSelect: (orderNumber: string) => void;
  state: ReviewState;
  onReview: (orderNumber: string, kind: DecisionKind, note: string) => void;
  onOpenOrder: (orderNumber: string) => void;
}) {
  const [note, setNote] = React.useState("");
  const busy = state.status === "busy";

  // The picker cannot offer an order the list no longer contains. If a filter
  // or a search removes the selection, fall back to the first row rather than
  // leaving a select pointing at nothing — a decision posted against a stale
  // selection is the worst possible outcome on this panel.
  React.useEffect(() => {
    if (orders.length === 0) return;
    if (!orders.some((o) => o.orderNumber === selected)) onSelect(orders[0].orderNumber);
  }, [orders, selected, onSelect]);

  const submit = (kind: DecisionKind) => {
    if (!selected) return;
    onReview(selected, kind, note.trim());
    setNote("");
  };

  return (
    <section className="fab-review-panel flex flex-col gap-3">
      <div className="flex flex-col gap-[3px]">
        <Label as="h2">Review an order</Label>
        <p className="m-0 text-[12px] font-normal" style={{ color: "var(--text-subtle)" }}>
          Record a decision on any order without leaving this page. Open an order below to see the
          problems detected against it and what the AI makes of them.
        </p>
      </div>

      <div className="fab-card flex flex-col gap-[13px] p-5">
        <div className="flex flex-col gap-[13px] sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-[7px]">
            <Label>Production order</Label>
            <select
              value={selected}
              onChange={(e) => onSelect(e.target.value)}
              disabled={orders.length === 0 || busy}
              className="w-full min-w-0 text-[16px] font-bold outline-none"
              style={{
                background: "var(--field-bg)",
                borderRadius: "var(--r-control)",
                border: 0,
                color: "var(--text-ink)",
                padding: "13px 15px",
              }}
            >
              {orders.length === 0 ? (
                <option value="">No orders listed</option>
              ) : (
                orders.map((order) => (
                  <option key={order.orderNumber} value={order.orderNumber}>
                    {order.orderNumber} — {order.product.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex min-w-0 flex-[1.4] flex-col gap-[7px]">
            <Label>Note (optional)</Label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              placeholder="Why this decision"
              className="w-full min-w-0 text-[16px] font-medium outline-none"
              style={{
                background: "var(--field-bg)",
                borderRadius: "var(--r-control)",
                border: 0,
                color: "var(--text-ink)",
                padding: "13px 15px",
              }}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-[9px]">
          {DECISIONS.map(({ kind, label, icon: Icon }) => (
            <Button
              key={kind}
              variant={kind === "APPROVE" ? "primary" : "secondary"}
              disabled={busy || !selected}
              onClick={() => submit(kind)}
              className="flex-1"
            >
              <Icon size={15} strokeWidth={2.2} aria-hidden="true" />
              {label}
            </Button>
          ))}
        </div>

        {/* Said on the panel, not only in the log. Somebody deciding from here
            has not read an analysis, and the screen should not pretend
            otherwise — this is the same claim the activity feed will carry. */}
        <p className="m-0 text-[12px] font-normal" style={{ color: "var(--text-subtle)" }}>
          Decisions recorded here are logged as taken without an AI analysis.
        </p>

        <div aria-live="polite" className="empty:hidden">
          {state.status === "done" ? (
            <p
              className="m-0 flex flex-wrap items-center gap-[9px] px-4 py-[10px] text-[14px]"
              style={{
                borderRadius: "var(--r-control)",
                background: "var(--status-green-bg)",
                color: "var(--status-green-ink)",
              }}
            >
              <CheckCircle2 size={16} strokeWidth={2.2} aria-hidden="true" />
              Recorded {state.decisionId} on {state.orderNumber}.
              <button
                type="button"
                onClick={() => onOpenOrder(state.orderNumber)}
                className="inline-flex cursor-pointer items-center gap-[4px] border-0 bg-transparent p-0 text-[14px] font-bold underline"
                style={{ color: "var(--status-green-ink)" }}
              >
                Open the order
                <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />
              </button>
            </p>
          ) : null}

          {state.status === "error" ? (
            <p
              role="alert"
              className="m-0 px-4 py-[10px] text-[14px]"
              style={{
                borderRadius: "var(--r-control)",
                background: "var(--status-red-bg)",
                border: "1px solid var(--status-red-border)",
                color: "var(--status-red)",
              }}
            >
              {state.message}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
