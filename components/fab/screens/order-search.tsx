"use client";

/**
 * Screen 1 — order search.
 *
 * A list of cards, not a data table. This is read on a handheld while standing
 * at a line: a six-column grid at 12.5px is a desktop artefact, and the two
 * things a supervisor is actually scanning for — which order, and is it in
 * trouble — should survive being glanced at from arm's length.
 *
 * Presentational: it takes rows and a load state, the page owns fetching.
 * That split is what lets the empty, loading and error states be exercised
 * without a server.
 */

import * as React from "react";
import { ScanLine, Search, SearchX } from "lucide-react";
import {
  Card,
  Code,
  EmptyState,
  ErrorState,
  Label,
  Pill,
  Progress,
  SkeletonBar,
  activatable,
  type Tone,
} from "../primitives";
import type { OrderStatus, OrderSummary } from "@/lib/mes/types";

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

const ALL_STATUSES = Object.keys(STATUS_LABEL) as OrderStatus[];

export function OrderSearch({
  orders,
  state,
  searchValue,
  onSearchChange,
  activeStatuses,
  onToggleStatus,
  onClearFilters,
  onOpenOrder,
  onRetry,
  errorDetail,
  onScan,
  review,
}: {
  orders: OrderSummary[];
  state: "data" | "empty" | "loading" | "error";
  searchValue: string;
  onSearchChange: (value: string) => void;
  activeStatuses: Set<OrderStatus>;
  onToggleStatus: (status: OrderStatus) => void;
  onClearFilters: () => void;
  onOpenOrder: (orderNumber: string) => void;
  onRetry: () => void;
  errorDetail?: string;
  /** Absent when the browser cannot open a camera — the control is then not rendered at all. */
  onScan?: () => void;
  /**
   * The review panel, rendered above everything else on this screen. A slot
   * rather than a child so this component stays presentational and the page
   * keeps every fetch and every write, exactly as `order-detail.tsx` takes its
   * decision section.
   */
  review?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[var(--page-width)] flex-col gap-7 px-4 py-6">
      {/* The review panel.
          Always first, always present — it is the whole reason somebody lands
          on this page from the landing CTA. It replaced a one-line text strip
          that said "this is where you review production orders", which
          described the capability instead of offering it. See
          `review-panel.tsx`. */}
      {review}

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-[3px]">
          <Label as="h2">Shop floor</Label>
          <h1 className="text-[26px]">Production orders</h1>
        </div>
        {state === "data" ? (
          <span className="text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
            {orders.length} {orders.length === 1 ? "order" : "orders"}
          </span>
        ) : null}
      </div>

      {/* Search, with scan beside it — never instead of it. A camera fails on a
          scuffed label and in bad light; typing the number always works. */}
      <div className="flex items-stretch gap-[9px]">
        <label
          className="flex flex-1 items-center gap-[11px] px-[15px] py-[13px]"
          style={{
            background: "var(--field-bg)",
            borderRadius: "var(--r-control)",
            border: "1px solid transparent",
          }}
        >
          <Search size={18} strokeWidth={2} aria-hidden="true" style={{ color: "var(--text-subtle)" }} />
          <span className="sr-only">Search orders</span>
          <input
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Order, product or machine"
            inputMode="search"
            className="w-full min-w-0 bg-transparent text-[16px] font-medium outline-none"
            style={{ border: 0, color: "var(--text-ink)" }}
          />
        </label>

        {onScan ? (
          <button
            type="button"
            onClick={onScan}
            aria-label="Scan a production order barcode"
            className="flex flex-none cursor-pointer items-center gap-[8px] px-[15px] text-[14px] font-bold transition-all hover:-translate-y-px"
            style={{
              borderRadius: "var(--r-control)",
              background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
              color: "#fff",
              border: "1px solid transparent",
              boxShadow: "var(--shadow-brand)",
            }}
          >
            <ScanLine size={18} strokeWidth={2.2} aria-hidden="true" />
            <span className="hidden sm:inline">Scan</span>
          </button>
        ) : null}
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-[7px]" role="group" aria-label="Filter by status">
        {ALL_STATUSES.map((status) => {
          const on = activeStatuses.has(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={on}
              onClick={() => onToggleStatus(status)}
              className="cursor-pointer whitespace-nowrap px-[13px] py-[7px] text-[12px] font-bold transition-colors"
              style={{
                borderRadius: "var(--r-chip)",
                background: on ? "var(--nav-active)" : "var(--pure-white)",
                color: on ? "var(--pure-white)" : "var(--text-muted-cool)",
                border: `1px solid ${on ? "var(--nav-active)" : "var(--border-light)"}`,
              }}
            >
              {STATUS_LABEL[status]}
            </button>
          );
        })}
        {activeStatuses.size > 0 ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="cursor-pointer whitespace-nowrap px-[13px] py-[7px] text-[12px] font-bold"
            style={{
              borderRadius: "var(--r-chip)",
              background: "transparent",
              border: "1px solid transparent",
              color: "var(--cockpit-indigo)",
            }}
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* Results */}
      {state === "loading" ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex flex-col gap-3 p-5">
              <SkeletonBar width={130} height={16} delayMs={i * 90} />
              <SkeletonBar width="55%" delayMs={i * 90 + 60} />
              <SkeletonBar width="80%" height={8} delayMs={i * 90 + 120} />
            </Card>
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState
          title="Could not load orders"
          detail={errorDetail ?? "GET /api/orders/search"}
          explanation="Nothing was changed. This screen only reads from the MES."
          onRetry={onRetry}
        />
      ) : state === "empty" ? (
        <Card className="p-2">
          <EmptyState
            icon={<SearchX size={22} strokeWidth={2} aria-hidden="true" />}
            title="No orders match"
            explanation={describeFilters(searchValue, activeStatuses)}
            actionLabel={searchValue || activeStatuses.size > 0 ? "Clear search and filters" : undefined}
            onAction={
              searchValue || activeStatuses.size > 0
                ? () => {
                    onSearchChange("");
                    onClearFilters();
                  }
                : undefined
            }
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {orders.map((order) => (
            <li key={order.recordId}>
              <OrderCard order={order} onOpen={() => onOpenOrder(order.orderNumber)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderCard({ order, onOpen }: { order: OrderSummary; onOpen: () => void }) {
  const pct = order.plannedQty > 0 ? Math.round((order.completedQty / order.plannedQty) * 100) : 0;

  return (
    <Card
      interactive
      className="flex flex-col gap-[13px] p-5"
      {...activatable(onOpen, `Open order ${order.orderNumber}, ${order.product.name}`)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Code className="text-[16px] font-extrabold" style={{ color: "var(--text-ink)" }}>
          {order.orderNumber}
        </Code>
        <Pill tone={STATUS_TONE[order.status]}>{STATUS_LABEL[order.status]}</Pill>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-1">
        <span className="text-[16px] font-bold">{order.product.name}</span>
        <span className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
          {order.product.code}
        </span>
        <span className="text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
          · {order.machineId}
        </span>
      </div>

      <div className="flex flex-col gap-[6px]">
        <Progress value={order.completedQty} max={order.plannedQty} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Code className="text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
            {order.completedQty} / {order.plannedQty} units · {pct}%
          </Code>
          <span className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
            Due {formatDue(order.dueAt)}
          </span>
        </div>
      </div>
    </Card>
  );
}

function formatDue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeFilters(search: string, statuses: Set<OrderStatus>): string {
  const parts: string[] = [];
  if (search.trim()) parts.push(`a search for “${search.trim()}”`);
  if (statuses.size === 1) parts.push(`the ${STATUS_LABEL[[...statuses][0]]} filter`);
  else if (statuses.size > 1) parts.push(`${statuses.size} status filters`);

  if (parts.length === 0) return "There are no production orders in this dataset.";
  return `Nothing matches ${parts.join(" and ")}.`;
}
