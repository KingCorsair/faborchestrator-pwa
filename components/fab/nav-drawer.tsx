"use client";

/**
 * The agent screens' navigation drawer — FabOrchestrator's chat sidebar, on a phone.
 *
 * ── This is FO's own mobile branch, not a new idea ──────────────────────────
 * `claudeai_athena/components/ui/sidebar.tsx:170-191`: below 768px the product
 * does not render its 16rem rail at all. It renders a **left slide-over Sheet
 * at 18rem**, dismissed by backdrop, Escape or the trigger. Every agent chat
 * there (`full-chat-app.tsx`, `modeling-chat-app.tsx`, `backend-agent-app.tsx`)
 * mounts that same component. So the desktop rail was never the thing to copy;
 * 288px of slide-over is what the product itself shows on a phone, and this is
 * that, in this app's vocabulary.
 *
 * ── What it deliberately does NOT carry ─────────────────────────────────────
 * FO's sidebar has **Pinned** and **Recents**, read from
 * `GET /api/conversations`. This app has neither, and inventing them was the
 * one thing ruled out: `lib/faborch/client.ts` sends no `conversationId`, so
 * `app/api/chat/route.ts:882` (`if (!conversationId) return;`) never persists a
 * turn — a conversation held here exists only in `useReducer` state, and a list
 * of thread names would be a list of fictions.
 *
 * The product already set this precedent. `backend-agent-app.tsx:25` omits the
 * same section for the same kind of reason, and says so: "The sidebar has no
 * conversation history because this agent has none." The muted line where
 * Recents would sit follows that lead — it states the absence rather than
 * dressing it up, because a drawer that silently lacks the section a user saw
 * in FabOrchestrator is exactly how somebody concludes the app is broken.
 *
 * ── One nav list, and it is not this file's ─────────────────────────────────
 * `NAV` comes from `nav-items.ts`, which the top bar and the cockpit header
 * already share. That module's header records why: the shell and the cockpit
 * drifted apart once, and the app disagreed with itself about what the platform
 * offered depending on which page you stood on. A third copy here would be the
 * same bug with three ways to be wrong instead of two.
 *
 * ── Why the panel is `visibility: hidden` when closed ───────────────────────
 * It stays mounted so it can slide. `display: none` cannot transition, and a
 * panel left merely translated off-screen keeps its links in the tab order —
 * you would tab off the composer into five invisible destinations.
 * `visibility: hidden` removes them from the tab order AND animates, provided
 * the property change is delayed until the slide finishes on the way out.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLockup } from "./brand";
import { NAV } from "./nav-items";
import type { SessionUser } from "./use-session";

/** FO's own `SIDEBAR_WIDTH_MOBILE` is 18rem. Capped so 360px keeps a backdrop. */
const PANEL_WIDTH = "min(288px, 86vw)";

const MS = 220;

export function NavDrawer({
  open,
  onClose,
  onNewChat,
  user,
}: {
  open: boolean;
  onClose: () => void;
  /** Clears the conversation on screen. Nothing is stored, so nothing is lost. */
  onNewChat: () => void;
  user: SessionUser | null;
}) {
  const pathname = usePathname();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreTo = React.useRef<HTMLElement | null>(null);

  /* Escape, exactly as `artifact-sheet.tsx` does it. */
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /**
   * Focus moves in on open and back to the trigger on close.
   *
   * Without the second half, dismissing the drawer drops focus onto <body> and
   * a keyboard user starts again from the top of the document — on a chat
   * screen, that is the whole transcript away from the composer they were in.
   */
  React.useEffect(() => {
    if (open) {
      restoreTo.current = document.activeElement as HTMLElement | null;
      // After the paint that makes it visible; focusing a `visibility: hidden`
      // element does nothing at all.
      const id = window.setTimeout(() => panelRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    restoreTo.current?.focus?.();
    restoreTo.current = null;
  }, [open]);

  /**
   * A route change closes it.
   *
   * Next navigates client-side, so without this the drawer would still be
   * standing open over the page it just sent you to. Keyed on `pathname` rather
   * than on the click, so it also covers Back, a redirect, and the sign-out
   * path.
   */
  React.useEffect(() => {
    if (open) onClose();
    // Only `pathname`: adding `open` would close it in the same tick it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <div
      className="fab fixed inset-0 z-40"
      aria-hidden={!open}
      style={{
        visibility: open ? "visible" : "hidden",
        // Instant on the way in, held until the slide finishes on the way out.
        transition: open ? "visibility 0s" : `visibility 0s linear ${MS}ms`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {/* Tap-outside. A button so it is a real, labelled control rather than a
          div with a click handler that no assistive technology can reach. */}
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-label="Close navigation"
        onClick={onClose}
        className={cn(
          "absolute inset-0 h-full w-full cursor-default border-0 p-0 transition-opacity duration-200 ease-out motion-reduce:transition-none",
          open ? "opacity-100" : "opacity-0",
        )}
        style={{ background: "rgba(16, 21, 58, 0.46)" }}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
        className={cn(
          "absolute inset-y-0 left-0 flex flex-col overflow-y-auto overscroll-contain shadow-2xl outline-none",
          "transition-transform duration-200 ease-out motion-reduce:transition-none",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        style={{
          width: PANEL_WIDTH,
          background: "var(--pure-white)",
          // The notch on an installed iPhone, and the home indicator below.
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <header
          className="flex flex-none items-center justify-between gap-2 px-3 py-[10px]"
          style={{ borderBottom: "1px solid var(--border-light)" }}
        >
          <span className="pl-1">
            <BrandLockup size="nav" />
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center border-0 bg-transparent"
            style={{ color: "var(--text-muted-cool)" }}
          >
            <X size={19} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
          {/* FO's first sidebar item, and the only action in here that is not
              navigation. It resets the turns on screen; there is nothing to
              save and nothing to leave behind. */}
          <button
            type="button"
            onClick={() => {
              onNewChat();
              onClose();
            }}
            className="flex min-h-[44px] w-full cursor-pointer items-center gap-[10px] border-0 px-3 text-left text-[14px] font-bold transition-colors hover:bg-[var(--cockpit-surface)]"
            style={{
              borderRadius: "var(--r-chip)",
              background: "transparent",
              color: "var(--text-ink)",
            }}
          >
            <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
            New chat
          </button>

          <p
            className="m-0 px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.6px]"
            style={{ color: "var(--text-subtle)" }}
          >
            FabOrchestrator
          </p>

          <nav className="flex flex-col gap-1" aria-label="Sections">
            {NAV.map((item) => {
              const Icon = item.icon;

              // Same rule as the top bar: an entry this app cannot open is a
              // <span>, never a disabled <a>. A link with no destination is
              // still focusable and still looks pressable, which is the "dead
              // control" this app has been reported for once already.
              if (item.unavailable) {
                return (
                  <span
                    key={item.href}
                    title={item.unavailable}
                    aria-disabled="true"
                    className="flex min-h-[44px] cursor-not-allowed items-center gap-[10px] px-3 text-[14px] font-bold"
                    style={{
                      borderRadius: "var(--r-chip)",
                      color: "var(--text-subtle)",
                      opacity: 0.55,
                    }}
                  >
                    <Icon size={17} strokeWidth={2} aria-hidden="true" />
                    {item.label}
                  </span>
                );
              }

              const active =
                item.href === "/" ? pathname === "/" : (pathname?.startsWith(item.href) ?? false);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className="flex min-h-[44px] items-center gap-[10px] px-3 text-[14px] font-bold no-underline transition-colors"
                  style={{
                    borderRadius: "var(--r-chip)",
                    background: active ? "var(--nav-active)" : "transparent",
                    color: active ? "var(--pure-white)" : "var(--text-muted-cool)",
                  }}
                >
                  <Icon size={17} strokeWidth={2} aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Where FabOrchestrator lists Pinned and Recents. See the file
              header: this app stores no conversation, so it states that rather
              than showing names it would have to invent. */}
          <p
            className="m-0 mt-auto px-3 pb-2 pt-6 text-[11px] font-normal leading-[1.6]"
            style={{ color: "var(--text-subtle)" }}
          >
            Conversations are not saved. This thread lasts while the screen is open.
          </p>
        </div>

        {/* The header hides the name and role below `sm` to buy a row for the
            nav. This is where they come back. */}
        <div
          className="flex flex-none items-center gap-[9px] px-3 py-[10px]"
          style={{ borderTop: "1px solid var(--border-light)" }}
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
          <span className="min-w-0 leading-[1.15]">
            <span
              className="block truncate text-[12px] font-bold"
              style={{ color: "var(--text-ink)" }}
            >
              {user?.name || user?.email || "—"}
            </span>
            <span className="block text-[10px] font-bold" style={{ color: "var(--text-subtle)" }}>
              {user?.roleName ?? "—"}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Duplicated from the shell rather than exported from it: `app-shell.tsx` is
 *  the only other caller, and lifting a six-line helper into a shared module to
 *  serve two files in the same folder is more indirection than it saves. */
function initialsOf(name: string | null | undefined, email: string | undefined): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
    if (letters) return letters.toUpperCase();
  }
  if (!email) return "··";
  return email.slice(0, 2).toUpperCase();
}
