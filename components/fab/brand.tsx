/**
 * The FabOrchestrator brand lockup — the gradient tile, the wordmark, and
 * ATHENATEC underneath it.
 *
 * Lifted from `claudeai_athena/components/cockpit/cockpit-nav.tsx` (readable on
 * `main` only — the console redesign deleted that directory), which sets the
 * name over a small tracked label in exactly this arrangement. **ATHENATEC is
 * spelled the way the product spells it**, without the trailing H. It looks
 * like a typo and it is not ours to fix here; a demo whose wordmark disagrees
 * with the product's own nav is a demo that gets asked about the wordmark.
 *
 * ── Why this is a component and was not before ──────────────────────────────
 * The same fourteen lines were pasted into `app-shell.tsx` and
 * `login-page.tsx`, differing only in tile size and in whether the ink is
 * dark-on-white or white-on-navy. A landing page would have made three copies,
 * which is the point at which the next person to adjust the mark adjusts two of
 * them and ships a product with two different logos. Per CLAUDE.md's "reuse
 * before adding": the product duplicates its console kit across two apps
 * because they have separate `node_modules`, which is not the situation inside
 * one app.
 *
 * ── Why the sizes are classes and not numbers ───────────────────────────────
 * Tailwind generates utilities by scanning source text, so `text-[${n}px]`
 * produces nothing at all. The literals below are what make the classes exist.
 * Every one of them is on the seven-step scale in `app/faborch-theme.css`; the
 * tile geometry is inline style, as it already was in both originals, because
 * it is a box measurement rather than a type step.
 */

import { cn } from "@/lib/utils";

export type BrandSize = "nav" | "panel" | "hero";
export type BrandTone = "ink" | "on-navy";

const SIZES: Record<
  BrandSize,
  { tile: number; radius: number; gap: string; initial: string; name: string; tracking: string }
> = {
  /** The sticky top nav, at every width. */
  nav: {
    tile: 32,
    radius: 10,
    gap: "gap-[10px]",
    initial: "text-[14px]",
    name: "text-[16px]",
    tracking: "tracking-[0.14em]",
  },
  /** The sign-in page's navy brand panel. */
  panel: {
    tile: 38,
    radius: 13,
    gap: "gap-[11px]",
    initial: "text-[16px]",
    name: "text-[16px]",
    tracking: "tracking-[0.16em]",
  },
  /**
   * The landing page, where the mark is the subject rather than a label in a
   * corner. `--fs-hero` is the scale's top step and the only one above the
   * page's own h1 — which is the hierarchy the landing page wants: you have
   * arrived at FabOrchestrator, and this is the part of it you are entering.
   */
  hero: {
    tile: 58,
    radius: 18,
    gap: "gap-[14px]",
    initial: "text-[26px]",
    name: "text-[30px]",
    tracking: "tracking-[0.16em]",
  },
};

const TONES: Record<BrandTone, { name: string; label: string }> = {
  ink: { name: "var(--text-ink)", label: "var(--text-subtle)" },
  "on-navy": { name: "#fff", label: "var(--on-navy-label)" },
};

export function BrandLockup({
  size = "nav",
  tone = "ink",
  className,
}: {
  size?: BrandSize;
  tone?: BrandTone;
  className?: string;
}) {
  const s = SIZES[size];
  const t = TONES[tone];

  return (
    <span className={cn("flex flex-none items-center", s.gap, className)}>
      <span
        className={cn("grid flex-none place-items-center font-extrabold text-white", s.initial)}
        style={{
          width: s.tile,
          height: s.tile,
          borderRadius: s.radius,
          background: "linear-gradient(135deg,var(--brand-indigo-light),var(--cockpit-indigo))",
        }}
        aria-hidden="true"
      >
        F
      </span>
      <span className="leading-[1.05]" style={{ color: t.name }}>
        <span className={cn("block font-extrabold", s.name)}>FabOrchestrator</span>
        <span
          className={cn("block text-[10px] font-bold", s.tracking)}
          style={{ color: t.label }}
        >
          ATHENATEC
        </span>
      </span>
    </span>
  );
}
