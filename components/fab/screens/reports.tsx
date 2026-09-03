"use client";

/**
 * Reports — the dashboards an administrator pinned in FabOrchestrator, read on
 * a phone.
 *
 * ── Why this screen exists, and why it is read-only ─────────────────────────
 * FabOrchestrator's own rule, read from `lib/fabinsight/access.ts` and its two
 * routes: **an administrator creates and pins a dashboard; every authenticated
 * role may read one.** The nav entry here was greyed with "this app does not
 * open it yet" on the assumption that dashboards were admin-only. They are
 * not — only *managing* them is.
 *
 * So this screen offers exactly the read half. There is no pin, no unpin, and
 * deliberately **no Refresh**, even though FO's own `/reports` has one and its
 * refresh route is not admin-gated. Refreshing re-queries the MES and
 * overwrites the shared snapshot every other reader sees; a button that
 * rewrites other people's data does not belong on a screen whose whole claim
 * is that it only reads. What the reader gets instead is the timestamp, so the
 * snapshot is never mistaken for live.
 *
 * ── The sandbox is stricter than the product's ──────────────────────────────
 * FO renders these with `sandbox="allow-same-origin allow-scripts"`. Those two
 * together **cancel the sandbox** — the frame gets the embedder's origin and
 * can reach its cookies and DOM. That is survivable inside FO, where the frame
 * and the page are the same origin anyway. It is not survivable here: this app
 * holds an httpOnly FabOrchestrator token, and the plan's own rule (WP9) is
 * that the two flags never appear together. `allow-scripts` alone gives the
 * frame an opaque origin, which is what the charts need and nothing more.
 */

import * as React from "react";
import { BarChart3, ChevronLeft, Clock, Lock } from "lucide-react";
import { AppShell } from "@/components/fab/app-shell";
import { EmptyState, ErrorState, SkeletonBar } from "@/components/fab/primitives";
import { useSession } from "@/components/fab/use-session";
import { PageSkeleton } from "@/components/page-skeleton";

interface ReportSummary {
  id: string;
  title: string;
  dashboardId: string;
  kind: string;
  createdAt: string;
  refreshedAt: string | null;
  hasCache: boolean;
  createdBy: string;
}

interface ReportSnapshot {
  id: string;
  title: string;
  html: string | null;
  summary: string | null;
  refreshedAt: string | null;
  status: string | null;
}

interface Failure {
  code: string;
  message: string;
}

/** "2 hours ago" beats an ISO string on a phone, and never claims to be live. */
function ago(iso: string | null): string {
  if (!iso) return "never refreshed";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "refreshed at an unknown time";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "refreshed just now";
  if (mins < 60) return `refreshed ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `refreshed ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `refreshed ${days} day${days === 1 ? "" : "s"} ago`;
}

export function ReportsClient() {
  const session = useSession();
  if (!session.ready) return <PageSkeleton />;

  return (
    <AppShell user={session.user} token={session.token} sessionExpiresAt={session.expiresAt}>
      <Reports />
    </AppShell>
  );
}

function Reports() {
  const [reports, setReports] = React.useState<ReportSummary[] | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [open, setOpen] = React.useState<ReportSnapshot | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);

  const authHeaders = React.useCallback(
    (): HeadersInit => ({
      Authorization: `Bearer ${localStorage.getItem("llmatscale_auth_token") ?? ""}`,
    }),
    [],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/faborch/reports", { headers: authHeaders() });
        const body = (await res.json().catch(() => null)) as
          | { reports?: ReportSummary[]; code?: string; error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok) {
          setFailure({
            code: body?.code ?? "faborch_unavailable",
            message: body?.error ?? "Reports could not be loaded.",
          });
          return;
        }
        setReports(body?.reports ?? []);
      } catch {
        if (!cancelled) {
          setFailure({
            code: "faborch_unavailable",
            message: "The connection to FabOrchestrator dropped while loading reports.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authHeaders]);

  async function openReport(id: string) {
    setOpening(id);
    setFailure(null);
    try {
      const res = await fetch(`/api/faborch/reports/${encodeURIComponent(id)}`, {
        headers: authHeaders(),
      });
      const body = (await res.json().catch(() => null)) as
        | (ReportSnapshot & { code?: string; error?: string })
        | null;
      if (!res.ok) {
        setFailure({
          code: body?.code ?? "faborch_unavailable",
          message: body?.error ?? "That report could not be opened.",
        });
        return;
      }
      if (body) setOpen(body);
    } catch {
      setFailure({
        code: "faborch_unavailable",
        message: "The connection to FabOrchestrator dropped while opening the report.",
      });
    } finally {
      setOpening(null);
    }
  }

  if (open) return <ReportView report={open} onBack={() => setOpen(null)} />;

  return (
    <div className="fab min-h-full px-4 py-6 sm:px-6" style={{ background: "var(--page-surface)" }}>
      <div className="mx-auto flex w-full max-w-[780px] flex-col gap-[18px]">
        <header className="flex flex-col gap-[8px]">
          <h1 className="text-[26px]" style={{ color: "var(--text-ink)" }}>
            Reports
          </h1>
          <p
            className="m-0 max-w-[var(--measure)] text-[14px] font-normal leading-[1.6]"
            style={{ color: "var(--text-muted-cool)" }}
          >
            Dashboards pinned in FabOrchestrator by an administrator. They are read-only
            here: pinning, refreshing and removing stay in FabOrchestrator itself.
          </p>
        </header>

        {failure ? (
          <ErrorState
            title="Reports are unavailable"
            detail={failure.code}
            explanation={failure.message}
          />
        ) : reports === null ? (
          <div className="flex flex-col gap-[10px]" aria-hidden="true">
            <SkeletonBar width="100%" height={68} />
            <SkeletonBar width="100%" height={68} />
            <SkeletonBar width="100%" height={68} />
          </div>
        ) : reports.length === 0 ? (
          <EmptyState
            icon={<BarChart3 size={20} strokeWidth={2} aria-hidden="true" />}
            title="No reports pinned yet"
            explanation={
              "An administrator pins a dashboard in FabOrchestrator and it appears here " +
              "for everyone. Nothing has been pinned so far."
            }
          />
        ) : (
          <ul className="flex list-none flex-col gap-[10px] p-0">
            {reports.map((report) => (
              <li key={report.id}>
                <button
                  type="button"
                  onClick={() => openReport(report.id)}
                  disabled={opening !== null}
                  className="fab-card fab-card-link flex w-full cursor-pointer items-center gap-[14px] px-[18px] py-[16px] text-left disabled:cursor-wait"
                >
                  <span
                    className="grid h-[38px] w-[38px] flex-none place-items-center"
                    style={{
                      borderRadius: "var(--r-control)",
                      background: "var(--cockpit-surface)",
                      color: "var(--text-muted-cool)",
                    }}
                    aria-hidden="true"
                  >
                    <BarChart3 size={18} strokeWidth={2} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="text-[15px] font-bold" style={{ color: "var(--text-ink)" }}>
                      {report.title}
                    </span>
                    <span
                      className="flex flex-wrap items-center gap-x-[8px] text-[12px] font-normal"
                      style={{ color: "var(--text-subtle)" }}
                    >
                      <Clock size={12} strokeWidth={2} aria-hidden="true" />
                      {opening === report.id ? "Opening…" : ago(report.refreshedAt)}
                      <span aria-hidden="true">·</span>
                      pinned by {report.createdBy}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One report, full width.
 *
 * `srcDoc` with `sandbox="allow-scripts"` and **no** `allow-same-origin`: the
 * frame runs its charts in an opaque origin, so it cannot read this app's
 * cookies, storage or DOM. See the file header for why that differs from FO.
 */
function ReportView({ report, onBack }: { report: ReportSnapshot; onBack: () => void }) {
  return (
    <div className="fab flex h-full min-h-0 flex-col" style={{ background: "var(--page-surface)" }}>
      <div
        className="flex flex-none items-center gap-[10px] border-b px-4 py-[10px] sm:px-6"
        style={{ borderColor: "var(--border-light)" }}
      >
        <button
          type="button"
          onClick={onBack}
          className="flex cursor-pointer items-center gap-[4px] border-0 bg-transparent px-0 text-[13px] font-bold"
          style={{ color: "var(--brand-indigo)" }}
        >
          <ChevronLeft size={16} strokeWidth={2.4} aria-hidden="true" />
          Reports
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold" style={{ color: "var(--text-ink)" }}>
          {report.title}
        </span>
      </div>

      <p
        className="m-0 flex flex-none items-center gap-[6px] px-4 py-[8px] text-[12px] font-normal sm:px-6"
        style={{ color: "var(--text-subtle)" }}
      >
        <Lock size={12} strokeWidth={2} aria-hidden="true" />
        Read-only snapshot · {ago(report.refreshedAt)}
      </p>

      {report.html ? (
        <iframe
          srcDoc={report.html}
          title={report.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0"
        />
      ) : (
        <div className="px-4 py-6 sm:px-6">
          <EmptyState
            icon={<Clock size={20} strokeWidth={2} aria-hidden="true" />}
            title="This report has no snapshot yet"
            explanation={
              "It was pinned but has not been refreshed in FabOrchestrator, so there is " +
              "nothing stored to show. It will appear once an administrator refreshes it."
            }
          />
        </div>
      )}
    </div>
  );
}
