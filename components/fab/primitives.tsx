"use client";

/**
 * The V2 vocabulary — the handful of shapes every screen is drawn from.
 *
 * Sizes here are the design system's, not Tailwind's scale: the product
 * specifies 9.5 / 12.5 / 13.5 / 14.5px and 9px / 12px / 22px radii, and those
 * values are what makes a screen read as FabOrchestrator rather than as
 * generic shadcn. See app/faborch-theme.css for where they come from.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/* ── Card ─────────────────────────────────────────────────────────────────── */

export function Card({
  className,
  interactive,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & { interactive?: boolean }) {
  return (
    <div className={cn("fab-card", interactive && "fab-card-link", className)} {...props} />
  );
}

/* ── Status ───────────────────────────────────────────────────────────────
   Never colour alone. `Pill` always renders its word; the dot is decorative
   and aria-hidden, there to be findable at a glance, not to carry meaning. */

export type Tone = "ok" | "warn" | "danger" | "info" | "idle";

/**
 * `fg` is the dot — the recognisable status hue. `ink` is the word.
 *
 * They differ because of design review F-02 (2026-08-12): the hue on its own
 * tint measured as low as 2.68:1, well under the 4.5:1 floor, so the word was
 * the least readable text on the screen while being the whole point of the
 * pill. The dot is decorative and `aria-hidden`, so it keeps the bright hue and
 * nothing on screen changes colour; only the word darkens.
 *
 * `info` needs no ink step — indigo on its pale tint already measures 5.99:1.
 */
const TONE: Record<Tone, { fg: string; ink: string; bg: string }> = {
  ok: { fg: "var(--status-green)", ink: "var(--status-green-ink)", bg: "var(--status-green-bg)" },
  warn: { fg: "var(--status-amber)", ink: "var(--status-amber-ink)", bg: "var(--status-amber-bg)" },
  danger: { fg: "var(--status-red)", ink: "var(--status-red-ink)", bg: "var(--status-red-bg)" },
  info: { fg: "var(--cockpit-indigo)", ink: "var(--cockpit-indigo)", bg: "var(--brand-indigo-bg)" },
  idle: { fg: "var(--status-idle)", ink: "var(--status-idle-ink)", bg: "var(--status-idle-bg)" },
};

/**
 * `surface` is which ground the pill is sitting on, not a second palette.
 *
 * `tint` — the default and every existing caller — is the status tint from
 * `TONE`, which only works on a white card or the page surface. The landing
 * page's featured-order card is an indigo gradient, and a pale amber tint on
 * indigo is neither readable nor recognisably a status. `white` swaps the
 * ground for `--pure-white` and changes nothing else: the ink token and the
 * dot hue are the same values, so the pill still reads as the same pill and
 * F-02's contrast floor still holds — `--status-red-ink` measures 6.9:1 on
 * white and `--status-amber-ink` 5.4:1, both above the 4.5:1 F-02 was fixing.
 *
 * A prop rather than a second component: duplicating the markup would
 * duplicate the dot-and-word structure that "status is never carried by colour
 * alone" depends on, and that is the one part of this primitive that must not
 * exist in two places.
 */
export function Pill({
  tone = "idle",
  dot = true,
  surface = "tint",
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  surface?: "tint" | "white";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        // `fab-pill` is the hook app/globals.css uses to raise the word to 14px
        // on coarse pointers — the dot is aria-hidden, so an unreadable word is
        // a pill carrying nothing.
        "fab-pill inline-flex flex-none items-center gap-[6px] whitespace-nowrap px-[10px] py-[5px]",
        "text-[12px] font-bold tracking-[0.04em]",
        className,
      )}
      style={{
        borderRadius: "var(--r-chip)",
        background: surface === "white" ? "var(--pure-white)" : TONE[tone].bg,
        color: TONE[tone].ink,
      }}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="flex-none rounded-full"
          style={{ width: 6, height: 6, background: TONE[tone].fg }}
        />
      ) : null}
      {children}
    </span>
  );
}

/**
 * The caption above a value or a section.
 *
 * **Two treatments, and only headings shout.** Reviewed 2026-08-12: the order
 * screen carried **26 uppercase, wide-tracked, bold micro-labels** — one above
 * every fact, every evidence list and every section. Small all-caps text at
 * 0.14em tracking is the single most reliable way to make an interface read as
 * an internal dashboard rather than a considered product, and at that density
 * it also stopped doing its job: when every value is announced, the
 * announcements are just texture.
 *
 * - `as="h2" | "h3"` — a section heading, a chapter of the screen. Keeps the
 *   uppercase treatment, because there are only three or four per screen and
 *   they are the thing you scan to navigate.
 * - default `span` — an inline caption inside a card. **Sentence case, 12px,
 *   regular weight.** It names the value beneath it and then gets out of the
 *   way. The value carries the emphasis, which is what makes the pair legible
 *   as a pair.
 *
 * This also removed 26 of the screen's 59 bold spans in one edit — the labels
 * were `font-bold`, so "everything is emphasised" and "everything is
 * uppercase" were the same defect wearing two hats.
 */
export function Label({
  children,
  className,
  as: Tag = "span",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "span" | "div" | "h2" | "h3";
}) {
  const heading = Tag === "h2" || Tag === "h3";
  return (
    <Tag
      className={cn(
        heading
          ? "text-[12px] font-bold uppercase tracking-[0.14em]"
          : "text-[12px] font-normal",
        className,
      )}
      style={{ color: heading ? "var(--text-muted-cool)" : "var(--text-subtle)" }}
    >
      {children}
    </Tag>
  );
}

/** A record ID or code. Tabular figures, not a monospace face — V2 is not mono. */
export function Code({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn("font-semibold tabular-nums", className)}
      style={{ fontVariantNumeric: "tabular-nums" }}
      {...props}
    >
      {children}
    </span>
  );
}

/* ── Controls ─────────────────────────────────────────────────────────────── */

export function Button({
  variant = "secondary",
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  const tone: React.CSSProperties =
    variant === "primary"
      ? {
          background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
          color: "#fff",
          border: "1px solid transparent",
          boxShadow: "var(--shadow-brand)",
        }
      : variant === "secondary"
        ? {
            background: "var(--pure-white)",
            color: "var(--text-ink)",
            border: "1px solid var(--border-light)",
          }
        : {
            background: "transparent",
            color: "var(--text-muted-cool)",
            border: "1px solid transparent",
          };

  return (
    <button
      type="button"
      className={cn(
        "inline-flex flex-none cursor-pointer items-center justify-center gap-[7px]",
        "px-[14px] py-[9px] text-[14px] font-bold leading-none",
        "transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary" && "hover:-translate-y-px",
        variant === "secondary" && "hover:bg-[var(--cockpit-surface)]",
        variant === "ghost" && "hover:bg-[var(--cockpit-surface)]",
        className,
      )}
      style={{ borderRadius: "var(--r-control)", ...tone, ...style }}
      {...props}
    />
  );
}

/**
 * Props that make a non-<button> element a real click target: role, tab stop,
 * and Enter/Space activation. A card with an onClick and no keyboard path is
 * not a control.
 */
export function activatable(onActivate: () => void, label: string) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    onClick: onActivate,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

/* ── Progress ─────────────────────────────────────────────────────────────── */

export function Progress({
  value,
  max,
  tone = "info",
  className,
}: {
  value: number;
  max: number;
  tone?: Tone;
  className?: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <span
      className={cn("block w-full overflow-hidden", className)}
      style={{ height: 8, borderRadius: 999, background: "var(--field-bg)" }}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <span
        className="block h-full"
        style={{
          width: `${ratio * 100}%`,
          borderRadius: 999,
          background:
            tone === "info"
              ? "linear-gradient(90deg,var(--brand-indigo-light),var(--cockpit-indigo))"
              : TONE[tone].fg,
        }}
      />
    </span>
  );
}

/* ── Non-happy paths ──────────────────────────────────────────────────────── */

export function ErrorState({
  title,
  detail,
  explanation,
  onRetry,
  className,
}: {
  title: string;
  /** The machine line: operation, code, trace id. */
  detail: string;
  /** Plain language, and specifically whether data is at risk. */
  explanation?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-start gap-[7px] p-5", className)}
      style={{
        borderRadius: "var(--r-panel)",
        background: "var(--status-red-bg)",
        border: "1px solid var(--status-red-border)",
        color: "var(--status-red)",
      }}
    >
      <h3 className="text-[16px]">{title}</h3>
      <Code className="text-[12px] opacity-90">{detail}</Code>
      {explanation ? (
        <p className="m-0 text-[14px] opacity-90" style={{ color: "var(--text-muted-cool)" }}>
          {explanation}
        </p>
      ) : null}
      {onRetry ? (
        <Button onClick={onRetry} className="mt-1">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * An empty state that names the filters responsible. Deliberately not generic:
 * "no records" tells an operator nothing, "a search for ASM-09 and two status
 * filters" tells them what to undo.
 */
export function EmptyState({
  icon,
  title,
  explanation,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  explanation: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-[10px] px-5 py-16 text-center">
      <div
        className="grid place-items-center"
        style={{
          width: 52,
          height: 52,
          borderRadius: "var(--r-control)",
          background: "var(--brand-indigo-bg)",
          color: "var(--cockpit-indigo)",
        }}
      >
        {icon}
      </div>
      <h3 className="text-[20px]">{title}</h3>
      <p className="m-0 max-w-[380px] text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
        {explanation}
      </p>
      {actionLabel && onAction ? (
        <Button onClick={onAction} className="mt-1">
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** A skeleton bar. Callers stagger `delayMs` so a group reads as one sweep. */
export function SkeletonBar({
  width,
  height = 12,
  delayMs = 0,
  className,
}: {
  width: number | string;
  height?: number;
  delayMs?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("fab-pulse motion-reduce:animate-none", className)}
      style={{
        height,
        width,
        borderRadius: 999,
        background: "var(--field-bg)",
        animationDelay: `${delayMs}ms`,
      }}
    />
  );
}
