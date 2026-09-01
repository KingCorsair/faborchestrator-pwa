"use client";

/**
 * The app shell — a sticky white top nav over the page surface.
 *
 * Modelled on the shipped cockpit's `cockpit-nav.tsx` rather than on the chat
 * app's navy sidebar: on a handheld held one-handed on a shop floor, a 240px
 * sidebar costs a third of the screen to show two links. The nav pills, the
 * brand lockup, the 34px icon buttons and the gradient avatar are the
 * cockpit's; the navy fill moves to the active pill, exactly as it does there.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLockup } from "./brand";
import { NAV } from "./nav-items";
import { logout, type SessionUser } from "./use-session";

export function AppShell({
  user,
  token,
  sessionExpiresAt,
  onRefresh,
  children,
}: {
  user: SessionUser | null;
  token: string | null;
  sessionExpiresAt?: Date | null;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const minutesLeft = useSessionMinutes(sessionExpiresAt ?? null);

  return (
    <div className="fab flex min-h-full flex-col">
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
        <Link
          href="/"
          aria-label="FabOrchestrator home"
          className="flex flex-none no-underline"
        >
          <BrandLockup size="nav" />
        </Link>

        {/* Visible at every width. It was `hidden sm:flex` when Orders was the
            only section and the brand lockup already went there; with a second
            section, hiding it puts Activity out of reach on exactly the device
            this app is built for. `order-last` drops it to its own row on a
            narrow screen rather than squeezing the user block off the edge. */}
        <nav
          className="order-last flex w-full items-center gap-1.5 sm:order-none sm:ml-3 sm:w-auto"
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
                  className="flex cursor-not-allowed items-center gap-[7px] px-[14px] py-2 text-[14px] font-bold transition-colors"
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
                className="flex items-center gap-[7px] px-[14px] py-2 text-[14px] font-bold no-underline transition-colors"
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
