"use client";

/**
 * The agent screens' conversation drawer — FabOrchestrator's chat sidebar, on a
 * phone.
 *
 * ── This is FO's own mobile branch, not a new idea ──────────────────────────
 * `claudeai_athena/components/ui/sidebar.tsx:170-191`: below 768px the product
 * does not render its 16rem rail. It renders a **left slide-over Sheet at
 * 18rem**, dismissed by backdrop, Escape or the trigger, and every agent chat
 * there mounts that same component. The desktop rail was never the thing to
 * copy; 288px of slide-over is what FabOrchestrator itself shows on a phone.
 *
 * ── Why there is no navigation block in here any more ───────────────────────
 * There was one until 5 September — Cockpit, Agents, Workflows, Sites, Reports,
 * mirroring the top bar. It came out the same day the conversations went in,
 * because a sidebar carrying both is two things badly.
 *
 * FabOrchestrator's own sidebar is the argument. It lists twelve nav entries
 * and **exactly one of them navigates**: Dashboard, to `/home`. Projects,
 * Agents, Workflows, Reports, Sites, Integrations, Compliance and Settings have
 * no handler at all, and FO's source labels them itself — "Static workspace nav
 * — non-functional links" (`full-chat-app.tsx:452`) and "Static enterprise nav
 * — non-functional links" (`:484`). Strip the decoration and the product's real
 * structure is: New chat · one link home · Pinned · Recents · account. Which is
 * this file.
 *
 * This app cannot ship the decoration anyway: a control that looks pressable
 * and does nothing is the defect it has already been reported for once.
 *
 * The navigation those five entries offered has not been lost. `CockpitNav` now
 * carries the full set at every width, so **Back to Cockpit reaches all of it in
 * one further tap** — and the cockpit is where an operator chooses what to do
 * next anyway. That ordering matters: the cockpit was fixed first, in the same
 * change, because until it was, Reports was reachable on a phone *only* from
 * this drawer.
 *
 * ── Pinned and Recents are real, or they are absent ─────────────────────────
 * Every row here is a conversation FabOrchestrator has, read live over the
 * operator's own token from `GET /api/conversations`. Nothing is invented,
 * nothing is cached, and nothing is stored by this app. When the list cannot be
 * loaded the sections do not appear at all and the drawer degrades to New chat
 * and Back to Cockpit — because a chat screen must not stop working when a
 * history endpoint does.
 *
 * Pinned is hidden entirely when empty rather than shown as a heading with
 * nothing under it. The same rule the inline ask follows: an empty labelled box
 * reads as a thing that failed to load.
 *
 * ── Why the panel is `visibility: hidden` when closed ───────────────────────
 * It stays mounted so it can slide. `display: none` cannot transition, and a
 * panel merely translated off-screen keeps its links in the tab order — you
 * would tab off the composer into a hundred invisible conversations.
 * `visibility: hidden` removes them and still animates, provided the property
 * change is delayed until the slide finishes on the way out.
 */

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { LayoutGrid, Loader2, Pin, PinOff, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLockup } from "./brand";
import type { SessionUser } from "./use-session";

/** FO's own `SIDEBAR_WIDTH_MOBILE` is 18rem. Capped so 360px keeps a backdrop. */
const PANEL_WIDTH = "min(288px, 86vw)";

const MS = 220;

/** One row of the operator's FabOrchestrator history. */
export interface DrawerConversation {
  id: string;
  title: string;
  isPinned: boolean;
  updatedAt: string;
}

/** What the shell passes when the screen below keeps history. */
export interface DrawerHistory {
  selectedId: string | null;
  onOpen: (id: string) => void;
}

export function NavDrawer({
  open,
  onClose,
  onNewChat,
  user,
  history,
}: {
  open: boolean;
  onClose: () => void;
  /** Clears the conversation on screen. The FO thread itself is untouched. */
  onNewChat: () => void;
  user: SessionUser | null;
  /** Absent for an agent that keeps no history — see `FoAgent.keepsHistory`. */
  history?: DrawerHistory;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreTo = React.useRef<HTMLElement | null>(null);

  const [rows, setRows] = React.useState<DrawerConversation[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const bearer = () =>
    `Bearer ${typeof window === "undefined" ? "" : (localStorage.getItem("llmatscale_auth_token") ?? "")}`;

  /**
   * Load the list when the drawer opens, not on a timer and not on mount.
   *
   * On open, because that is the only moment it is about to be read and the
   * only moment it can be stale in a way anybody notices — a thread started on
   * the FabOrchestrator website a minute ago should be here. On a timer it
   * would poll a database from a phone for a panel nobody has opened.
   */
  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/faborch/conversations", { headers: { Authorization: bearer() } });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const body = (await res.json()) as { conversations?: DrawerConversation[] };
      setRows(Array.isArray(body.conversations) ? body.conversations : []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    if (!open || !history) return;
    void load();
  }, [open, history, load]);

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
      const id = window.setTimeout(() => panelRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    restoreTo.current?.focus?.();
    restoreTo.current = null;
  }, [open]);

  /**
   * A route change closes it.
   *
   * Keyed on `pathname` only. Picking a conversation changes the *query* and
   * not the path, so this deliberately does not fire for that — the drawer
   * closes itself in the row's own handler, after the navigation is under way,
   * which keeps the two cases independent.
   */
  React.useEffect(() => {
    if (open) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const pinned = rows?.filter((row) => row.isPinned) ?? [];
  const recents = rows?.filter((row) => !row.isPinned) ?? [];

  /** Pin or unpin, then reload — FO decides the order, not this component. */
  const togglePin = async (row: DrawerConversation) => {
    setBusyId(row.id);
    try {
      await fetch(`/api/faborch/conversations/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: bearer() },
        body: JSON.stringify({ isPinned: !row.isPinned }),
      });
      await load();
    } catch {
      /* Leaves the list as it was; the next open reloads it. */
    } finally {
      setBusyId(null);
    }
  };

  /** One conversation, wired to this drawer's handlers. */
  const row = (item: DrawerConversation) => (
    <ConversationRow
      key={item.id}
      row={item}
      active={history?.selectedId === item.id}
      busy={busyId === item.id}
      onOpen={() => {
        history?.onOpen(item.id);
        onClose();
      }}
      onTogglePin={() => void togglePin(item)}
    />
  );

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
        aria-label="Conversations"
        tabIndex={-1}
        className={cn(
          "absolute inset-y-0 left-0 flex flex-col overflow-hidden shadow-2xl outline-none",
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

        {/* The one scrolling region. A hundred conversations is an ordinary
            number — the demo account holds 104 — so the list scrolls inside the
            panel while New chat and Back to Cockpit stay put. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-2">
          <button
            type="button"
            onClick={() => {
              onNewChat();
              onClose();
            }}
            className="flex min-h-[44px] w-full flex-none cursor-pointer items-center gap-[10px] border-0 px-3 text-left text-[14px] font-bold transition-colors hover:bg-[var(--cockpit-surface)]"
            style={{
              borderRadius: "var(--r-chip)",
              background: "transparent",
              color: "var(--text-ink)",
            }}
          >
            <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
            New chat
          </button>

          {history ? (
            <>
              {pinned.length > 0 ? (
                <>
                  <Heading>Pinned</Heading>
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{pinned.map(row)}</ul>
                </>
              ) : null}

              <Heading>Recents</Heading>

              {rows === null && !failed ? (
                <p
                  className="m-0 flex items-center gap-2 px-3 py-2 text-[12px]"
                  style={{ color: "var(--text-subtle)" }}
                >
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  Loading your conversations…
                </p>
              ) : failed ? (
                // Named as FabOrchestrator's, because that is whose they are and
                // where they still exist. Nothing here was lost.
                <p
                  className="m-0 px-3 py-2 text-[12px] leading-[1.6]"
                  style={{ color: "var(--text-subtle)" }}
                >
                  Your conversations could not be loaded from FabOrchestrator.
                  You can still start a new chat.
                </p>
              ) : recents.length === 0 ? (
                <p
                  className="m-0 px-3 py-2 text-[12px] leading-[1.6]"
                  style={{ color: "var(--text-subtle)" }}
                >
                  No conversations yet. Ask something and it will be saved to
                  FabOrchestrator.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{recents.map(row)}</ul>
              )}
            </>
          ) : (
            // The Back-end Agent. FabOrchestrator's own Back-end Agent stores no
            // conversations and says why; this states the same thing rather than
            // showing an empty Recents that looks like a failure.
            <p
              className="m-0 px-3 py-3 text-[12px] leading-[1.6]"
              style={{ color: "var(--text-subtle)" }}
            >
              This agent does not keep conversation history, in this app or in
              FabOrchestrator.
            </p>
          )}
        </div>

        {/* The one navigation left, and the only one needed: everything else is
            one tap further, on the cockpit. */}
        <button
          type="button"
          onClick={() => {
            onClose();
            router.push("/");
          }}
          className="flex min-h-[44px] flex-none cursor-pointer items-center gap-[10px] border-0 bg-transparent px-3 text-left text-[13px] font-bold transition-colors hover:bg-[var(--cockpit-surface)]"
          style={{ borderTop: "1px solid var(--border-light)", color: "var(--text-muted-cool)" }}
        >
          <LayoutGrid size={16} strokeWidth={2} aria-hidden="true" />
          Back to Cockpit
        </button>

        {/* The header hides the name and role below `sm`. This is where they
            come back. */}
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

/** A section label. Module level so it is not a new component type per render. */
function Heading({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="m-0 px-3 pb-1 pt-4 text-[11px] font-bold uppercase tracking-[0.6px]"
      style={{ color: "var(--text-subtle)" }}
    >
      {children}
    </p>
  );
}

/**
 * One conversation: open it, or change whether it is pinned.
 *
 * The pin control is a **separate button beside** the row rather than a menu on
 * it. A phone has no hover to reveal an affordance on, and a long-press menu is
 * a gesture nobody discovers; two adjacent targets, both clearing 44px, are the
 * honest version. It is also the only write this app makes to a conversation —
 * there is deliberately no rename, no share and no delete.
 */
function ConversationRow({
  row,
  active,
  busy,
  onOpen,
  onTogglePin,
}: {
  row: DrawerConversation;
  active: boolean;
  busy: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  return (
    <li className="flex items-stretch gap-0.5">
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
        className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer items-center border-0 px-3 text-left text-[13px] font-semibold transition-colors hover:bg-[var(--cockpit-surface)]"
        style={{
          borderRadius: "var(--r-chip)",
          background: active ? "var(--nav-active)" : "transparent",
          color: active ? "var(--pure-white)" : "var(--text-muted-cool)",
        }}
      >
        {/* Truncated, never wrapped: FO titles are the question's first fifty
            characters, so wrapping would give most rows three lines and turn a
            hundred conversations into a very long scroll. */}
        <span className="truncate">{row.title}</span>
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        disabled={busy}
        aria-label={row.isPinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
        className="grid min-h-[44px] w-[38px] flex-none cursor-pointer place-items-center border-0 bg-transparent transition-colors hover:bg-[var(--cockpit-surface)]"
        style={{ borderRadius: "var(--r-chip)", color: "var(--text-subtle)" }}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : row.isPinned ? (
          <PinOff size={14} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Pin size={14} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
    </li>
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
