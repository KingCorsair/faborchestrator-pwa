import { BarChart3, Building2, LayoutGrid, Sparkles, Workflow } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The sections this app shows, which are **FabOrchestrator's**, not its own.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * Two components render it: `app-shell.tsx`, which is `"use client"`, and
 * `screens/landing.tsx`, which is a server component with its own sticky
 * header. A plain array exported from the client module is a *client
 * reference* by the time a server component imports it — `NAV.map is not a
 * function`, which is exactly how the build broke when this lived in the shell.
 * Neither may own it, so it lives here, in a module with no directive at all.
 *
 * Keeping one definition is not tidiness. The cockpit header and the app shell
 * drifted apart once already: the shell stopped listing the demo's own screens
 * and the cockpit went on listing them, so the same app disagreed with itself
 * about what the platform offered depending on which page you were standing on.
 *
 * ── The list mirrors the product's cockpit nav ──────────────────────────────
 * `claudeai_athena/components/cockpit/cockpit-nav.tsx` at upstream `e5a5abd`:
 * Cockpit, Agents, Workflows, Sites, Reports. Until 2026-09-01 this app listed
 * Orders, Decisions and Activity instead — screens of a production-order
 * workflow that ran on this app's own mock MES and existed nowhere in
 * FabOrchestrator. They went with the workflow: a front door to a platform
 * should not advertise rooms the platform does not have.
 *
 * ── Reports opens, as of 2026-09-03 ────────────────────────────────────────
 * It was greyed on the belief that dashboards were admin-only. Source says
 * otherwise: `isDashboardAdmin` gates creating, pinning and deleting, while
 * reading a pinned dashboard is behind `requireAuth` alone. A supervisor may
 * read what an administrator published, so the entry is a real link and
 * `/reports` shows those dashboards read-only.
 *
 * ── Why two entries are shown but disabled ─────────────────────────────────
 * Leaving Workflows and Sites out would misrepresent the product just as surely
 * as inventing screens did. This app cannot open them — and neither does the
 * product: every cockpit nav item except Reports navigates to `/home` there, so
 * they are placeholders on both sides. Greyed states both facts at once: this
 * is what the platform has, and this is how much of it this app reaches.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Absent means reachable. Present, it is the reason the entry is greyed. */
  unavailable?: string;
}

const PLACEHOLDER_ON_BOTH_SIDES =
  "Not available in this app yet, and a placeholder on the platform's own cockpit.";

export const NAV: NavItem[] = [
  { href: "/", label: "Cockpit", icon: LayoutGrid },
  { href: "/fabinsight", label: "Agents", icon: Sparkles },
  { href: "/workflows", label: "Workflows", icon: Workflow, unavailable: PLACEHOLDER_ON_BOTH_SIDES },
  { href: "/sites", label: "Sites", icon: Building2, unavailable: PLACEHOLDER_ON_BOTH_SIDES },
  { href: "/reports", label: "Reports", icon: BarChart3 },
];
