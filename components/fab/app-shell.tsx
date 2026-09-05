"use client";

/**
 * The app shell — a sticky white top nav over the page surface.
 *
 * Modelled on the shipped cockpit's `cockpit-nav.tsx` rather than on the chat
 * app's navy sidebar: on a handheld held one-handed on a shop floor, a 240px
 * sidebar costs a third of the screen to show two links. The nav pills, the
 * brand lockup, the 34px icon buttons and the gradient avatar are the
 * cockpit's; the navy fill moves to the active pill, exactly as it does there.
 *
 * ── The agent screens also get a drawer, since 5 September ──────────────────
 * That reasoning holds against a *permanent* rail and only against that. The
 * product's own chat pages carry a sidebar, and below 768px they render it as a
 * slide-over — see `components/fab/nav-drawer.tsx`. `onNewChat` is what turns
 * it on here, because New chat is the one thing in that drawer this top bar
 * cannot offer: `/reports` passes no callback and shows no trigger.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLockup } from "./brand";
import { NavDrawer, type DrawerHistory } from "./nav-drawer";
import { NAV } from "./nav-items";
import { logout, type SessionUser } from "./use-session";

export function AppShell({
  user,
  token,
  sessionExpiresAt,
  onRefresh,
  onNewChat,
  history,
  children,
}: {
  user: SessionUser | null;
  token: string | null;
  sessionExpiresAt?: Date | null;
  onRefresh?: () => void;
  /**
   * Clears the conversation below. Its presence is also what says "this screen
   * is an agent conversation", which is the only place the drawer belongs.
   */
  onNewChat?: () => void;
  /**
   * The operator's FabOrchestrator conversations, when the agent below keeps
   * them. Absent for the Back-end Agent, which keeps none — in this app or in
   * the product.
   */
  history?: DrawerHistory;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const minutesLeft = useSessionMinutes(sessionExpiresAt ?? null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const hasDrawer = typeof onNewChat === "function";

  return (
    // `h-dvh`, not `min-h-full`. The conversation screen is `h-full` with its
    // own scrolling pane and a docked composer, and `h-full` only resolves
    // against a parent with a DEFINITE height. Under `min-h-full` the shell
    // grew with the answer instead, so the composer sat below the fold —
    // measured at 916px down a 640px screen, i.e. you had to scroll the whole
    // page to type. `dvh` rather than `vh` because a phone's URL bar changes
    // the viewport as you scroll, and `vh` would leave the composer under it.
    // Safe because this shell wraps the agent conversation and nothing else:
    // the landing page and diagnostics carry their own layout.
    <div className="fab flex h-dvh flex-col">
      {minutesLeft != null ? (
        <div
          role="status"
          className="flex flex-none items-center justify-center gap-2 px-4 py-[7px] text-[12px]"
          style={{ background: "var(--status-amber-bg)", color: "var(--status-amber-ink)" }}
        >
          Session expires in {minutesLeft} {minutesLeft === 1 ? "minute" : "minutes"}
        </div>
      ) : null}

      <header
        className="sticky top-0 z-10 flex flex-none flex-wrap items-center gap-2 px-4 py-[10px]"
        style={{
          background: "var(--pure-white)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {/* Brand lockup. **Points at `/`, and did not until 2026-08-21.**
            It pointed at `/orders` on the reasoning that inside the app the
            mark is a "home" affordance and home for somebody signed in is
            their work, not the front door they came through. That held while
            `/` was the Production Order Assistant's own front door, where the
            mark would have led you out of a workflow and back to its lobby.

            `/` is now FabOrchestrator's landing page, and the production order
            screens are one workflow inside it — so the mark leads to the
            product, which is both the universal convention and the only
            obvious way back to the other capabilities. `aria-label` because
            the lockup's visible text is the wordmark, which does not say where
            the link goes. */}
        {/* The drawer's trigger, where FO's `SidebarTrigger` sits: top-left,
            before the mark. Only on agent screens — see `hasDrawer`. */}
        {hasDrawer ? (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            className="-ml-1 flex min-h-[44px] min-w-[44px] flex-none cursor-pointer items-center justify-center border-0 bg-transparent transition-colors hover:bg-[var(--cockpit-surface)]"
            style={{ borderRadius: "var(--r-chip)", color: "var(--text-muted-cool)" }}
          >
            <Menu size={20} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : null}

        <Link
          href="/"
          aria-label="FabOrchestrator home"
          className="flex flex-none items-center no-underline min-h-[44px]"
        >
          <BrandLockup size="nav" />
        </Link>

        {/* Visible at every width. It was `hidden sm:flex` when Orders was the
            only section and the brand lockup already went there; with a second
            section, hiding it puts Activity out of reach on exactly the device
            this app is built for. `order-last` drops it to its own row on a
            narrow screen rather than squeezing the user block off the edge.

            **It scrolls sideways inside itself rather than widening the page.**
            Five pills measure 561px; at 360px that made the whole document
            scroll horizontally, which is the one thing the mobile rule forbids
            — a supervisor swiping to read an answer would drag the page instead.
            The strip is the same pattern the answer's tables already use: the
            wide thing scrolls in its own box. `fab-nav-strip` hides the
            scrollbar, since a visible one on a 38px-tall row is more noise than
            affordance, and the pills are ordered so the two that open come
            first and are never the ones off the edge. */}
        {/*
          **Not rendered at all on an agent screen, since 5 September.**

          FabOrchestrator's own `/chat` has no top navigation: the sidebar is
          the navigation, at every width. This now matches, and the reason is
          the same one the product has — a conversation screen with a nav strip
          above it is offering two ways to leave and none to manage the thing
          you came for.

          It briefly hid only below `sm`, when the drawer still carried a copy
          of these five pills. The drawer carries conversations now, so there is
          nothing left to duplicate, and the strip's remaining job — reaching
          Reports on a phone — moved to the cockpit's own header, which is
          visible at every width as of the same change. Removing this without
          that would have made `/reports` unreachable on a phone.

          Untouched on every screen without a drawer: `/reports` still shows it.
        */}
        {hasDrawer ? null : (
        <nav
          className="fab-nav-strip order-last flex w-full items-center gap-1.5 overflow-x-auto sm:order-none sm:ml-3 sm:w-auto sm:overflow-visible"
          aria-label="Sections"
        >
          {NAV.map((item) => {
            const Icon = item.icon;

            // Rendered as a <span>, not a disabled <a>: a link with no
            // destination is still focusable and still looks pressable, which
            // is the "dead control" this app has already been reported for
            // once. `title` carries the reason on hover, and aria-disabled
            // tells a screen reader what the colour alone says to everyone
            // else.
            if (item.unavailable) {
              return (
                <span
                  key={item.href}
                  title={item.unavailable}
                  aria-disabled="true"
                  className="flex flex-none cursor-not-allowed items-center gap-[7px] px-[14px] py-2 text-[14px] font-bold transition-colors"
                  style={{
                    borderRadius: "var(--r-chip)",
                    background: "transparent",
                    color: "var(--text-subtle)",
                    opacity: 0.55,
                  }}
                >
                  <Icon size={16} strokeWidth={2} aria-hidden="true" />
                  {item.label}
                </span>
              );
            }

            // "/" would match every path with startsWith, so the cockpit is
            // active only on exactly itself.
            const active =
              item.href === "/" ? pathname === "/" : (pathname?.startsWith(item.href) ?? false);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className="flex flex-none items-center gap-[7px] px-[14px] py-2 text-[14px] font-bold no-underline transition-colors"
                style={{
                  borderRadius: "var(--r-chip)",
                  background: active ? "var(--nav-active)" : "transparent",
                  color: active ? "var(--pure-white)" : "var(--text-muted-cool)",
                }}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        )}

        <div className="flex-1" />

        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh"
            className="grid flex-none cursor-pointer place-items-center transition-colors hover:bg-[var(--cockpit-surface)]"
            style={{
              width: 34,
              height: 34,
              borderRadius: "var(--r-chip)",
              border: 0,
              background: "transparent",
              color: "var(--text-muted-cool)",
            }}
          >
            <RefreshCw size={17} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}

        {/* User */}
        <div
          className="ml-1 flex flex-none items-center gap-[9px] pl-[12px]"
          style={{ borderLeft: "1px solid var(--border-light)" }}
        >
          <span
            className="grid flex-none place-items-center text-[12px] font-extrabold text-white"
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              background: "linear-gradient(135deg,var(--brand-indigo-light),var(--cockpit-indigo))",
            }}
            aria-hidden="true"
          >
            {initialsOf(user?.name, user?.email)}
          </span>
          {/* F-12: the avatar identifies the user at 390px; the name and role
              cost a whole header row there. Both return at sm. */}
          <span className="hidden text-left leading-[1.1] sm:block">
            <span className="block text-[12px] font-bold" style={{ color: "var(--text-ink)" }}>
              {user?.name || user?.email || "—"}
            </span>
            <span className="block text-[10px] font-bold" style={{ color: "var(--text-subtle)" }}>
              {user?.roleName ?? "—"}
            </span>
          </span>
          <button
            type="button"
            aria-label="Log out"
            onClick={async () => {
              await logout(token);
              router.replace("/login");
            }}
            className="grid flex-none cursor-pointer place-items-center transition-colors hover:bg-[var(--status-red-bg)]"
            style={{
              width: 34,
              height: 34,
              borderRadius: "var(--r-chip)",
              border: 0,
              background: "transparent",
              color: "var(--text-subtle)",
            }}
          >
            <LogOut size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main id="main-content" className={cn("min-h-0 flex-1")}>
        {children}
      </main>

      {/* Outside `<main>`, and a sibling of it: the panel is `position: fixed`
          over the whole shell, and nesting it inside the scrolling content
          would put a dialog inside the region it covers. */}
      {hasDrawer ? (
        <NavDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onNewChat={onNewChat}
          user={user}
          history={history}
        />
      ) : null}
    </div>
  );
}

/** Whole minutes left, or null while the session is comfortably alive. */
function useSessionMinutes(expiresAt: Date | null, thresholdMs = 5 * 60 * 1000) {
  const [minutes, setMinutes] = React.useState<number | null>(null);
  const time = expiresAt ? expiresAt.getTime() : null;

  React.useEffect(() => {
    if (time == null) {
      setMinutes(null);
      return;
    }
    const tick = () => {
      const ms = time - Date.now();
      setMinutes(ms <= thresholdMs && ms > 0 ? Math.max(1, Math.ceil(ms / 60000)) : null);
    };
    tick();
    const id = window.setInterval(tick, 15000);
    return () => window.clearInterval(id);
  }, [time, thresholdMs]);

  return minutes;
}

function initialsOf(name: string | null | undefined, email: string | undefined): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
    if (letters) return letters.toUpperCase();
  }
  if (!email) return "··";
  return email.slice(0, 2).toUpperCase();
}
