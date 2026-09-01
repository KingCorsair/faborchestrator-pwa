"use client";

/**
 * `/orders/[orderId]` — order details and its detected problem.
 *
 * Ordinary document flow read on a handheld, so the page scrolls normally.
 * The one thing it must not do is what the root CLAUDE.md records for
 * `app/v/[key]/page.tsx` — become a page whose content below the fold is
 * unreachable because a global layout pinned `overflow: hidden`.
 */

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, FileQuestion } from "lucide-react";
import { AppShell } from "@/components/fab/app-shell";
import { OrderDetailScreen } from "@/components/fab/screens/order-detail";
import {
  AnalysisPanel,
  type AnalysisState,
} from "@/components/fab/screens/analysis-panel";
import { Button, Card, EmptyState, ErrorState } from "@/components/fab/primitives";
import { useSession } from "@/components/fab/use-session";
import { PageSkeleton } from "@/components/page-skeleton";
import {
  AnalysisResultSchema,
  OrderResponseSchema,
  parseResponse,
  type OrderResponse,
} from "@/lib/api-schemas";
import type { AnalysisResult } from "@/lib/ai/analyze";

export default function OrderDetailPage() {
  const router = useRouter();
  const session = useSession();
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;

  const [data, setData] = React.useState<OrderResponse | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "missing" | "error">("loading");
  const [errorDetail, setErrorDetail] = React.useState<string>();
  const [reloadKey, setReloadKey] = React.useState(0);

  // The Explain flow. Kept here rather than in the panel so a reload of the
  // order clears a stale analysis along with the data it explained.
  const [analysisState, setAnalysisState] = React.useState<AnalysisState>("idle");
  const [analysis, setAnalysis] = React.useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = React.useState<string>();

  /**
   * Back to the list **with this order still selected** on the review panel.
   *
   * `data.order.orderNumber` rather than the route param: the param is
   * whatever was typed in the address bar, and the panel matches by exact
   * string against what the adapter returned. `getOrder` is case-insensitive,
   * so `/orders/po-10382` resolves and would otherwise hand the panel a value
   * that matches no row. Falls back to a bare `/orders` before the order
   * loads, and on the missing and error states below, where there is no order
   * to carry and pretending otherwise would select something arbitrary.
   */
  const reviewHref = data
    ? `/orders?order=${encodeURIComponent(data.order.orderNumber)}`
    : "/orders";

  const authHeaders = React.useMemo(
    () => ({ Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" }),
    [session.token],
  );

  async function explain() {
    if (!orderId) return;
    setAnalysisState("loading");
    setAnalysisError(undefined);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/explain`, {
        method: "POST",
        headers: authHeaders,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 503 carries a `detail` explaining which of the four ways it failed.
        setAnalysisError(payload.detail ?? payload.error ?? `Request failed (${res.status})`);
        setAnalysisState("error");
        return;
      }
      // Validated, not cast. This is the payload the grounding badge renders
      // from, so accepting it unchecked would mean the one claim the product
      // makes about its own honesty rests on a `as` keyword.
      setAnalysis(parseResponse(AnalysisResultSchema, payload, "POST /explain"));
      setAnalysisState("ready");
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : String(error));
      setAnalysisState("error");
    }
  }

  React.useEffect(() => {
    if (!session.token || !orderId) return;
    let cancelled = false;

    setStatus("loading");
    fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: "no-store",
    })
      .then(async (res) => {
        if (res.status === 404 || res.status === 400) {
          // A typo'd or retired order number is an ordinary answer, not a
          // fault: it gets the empty state, not the red one.
          if (!cancelled) setStatus("missing");
          return null;
        }
        if (!res.ok) throw new Error(`GET /api/orders/${orderId} → ${res.status}`);
        return parseResponse(
          OrderResponseSchema,
          await res.json(),
          `GET /api/orders/${orderId}`,
        );
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        setData(payload);
        setStatus("ready");
        // A refresh re-reads the MES, so any analysis on screen now explains
        // data that is no longer displayed. Clear it rather than leave a stale
        // explanation sitting under fresh figures.
        setAnalysis(null);
        setAnalysisState("idle");
        setAnalysisError(undefined);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setErrorDetail(error.message);
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [session.token, orderId, reloadKey]);

  if (!session.ready) return <PageSkeleton />;

  return (
    <AppShell
      user={session.user}
      token={session.token}
      sessionExpiresAt={session.expiresAt}
      onRefresh={() => setReloadKey((k) => k + 1)}
    >
      {/*
        The back link, first thing in the content area and above the order's
        own label — where a back link is looked for.

        It was already here and already a quiet ghost link with a left arrow;
        what made it read as misplaced was the width. This wrapper was still
        `max-w-[860px]`, the page width from before 2026-08-12, while the
        content below it is `--page-width` (1180px). So the link sat indented
        relative to the "Production order" label underneath it — aligned to a
        column that no longer exists. Same stale width was on the missing- and
        error-state wrappers below.
      */}
      <div className="mx-auto flex w-full max-w-[var(--page-width)] flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-5">
        <Button
          variant="ghost"
          onClick={() => router.push(reviewHref)}
          className="px-0"
        >
          <ArrowLeft size={16} strokeWidth={2.2} aria-hidden="true" />
          All orders
        </Button>

        {/*
          ── The way on (2026-08-20) ────────────────────────────────────────
          This screen shows the evidence and records nothing: the decision
          section was removed on 2026-08-19 so the app has exactly one
          decision surface, the review panel on `/orders`. What was missing
          was any way to *reach* it — you read the problems, the analysis and
          the records, and then the workflow simply stopped. Reported as a
          skipped step, and it was one.

          This is a **link, not a control**. It records nothing, so it does not
          reintroduce the second decision surface that was deliberately
          removed, and F-03's objection — that a decision must not be offered
          before the evidence — is untouched, because pressing it decides
          nothing.

          It carries the order number, which is the whole point: without it the
          panel falls back to the first row of the list and you would decide
          on an order whose evidence you never saw. Same reason the back link
          above now carries it too — leaving this screen should not silently
          change which order the app is pointed at.

          `ml-auto`, never a `flex-1` spacer: this row wraps on a phone, and a
          spacer would claim the rest of its line the moment it did.
        */}
        {status === "ready" && data ? (
          <Button variant="primary" onClick={() => router.push(reviewHref)} className="ml-auto">
            Record a decision
            <ArrowRight size={16} strokeWidth={2.2} aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {status === "loading" ? (
        <PageSkeleton />
      ) : status === "missing" ? (
        <div className="mx-auto w-full max-w-[var(--page-width)] px-4 py-4">
          <Card className="p-2">
            <EmptyState
              icon={<FileQuestion size={22} strokeWidth={2} aria-hidden="true" />}
              title="No such order"
              explanation={`Nothing in the MES matches ${orderId?.toUpperCase() ?? "that order number"}. Check the number, or search from the order list.`}
              actionLabel="Back to orders"
              onAction={() => router.push("/orders")}
            />
          </Card>
        </div>
      ) : status === "error" || !data ? (
        <div className="mx-auto w-full max-w-[var(--page-width)] px-4 py-4">
          <ErrorState
            title="Could not load this order"
            detail={errorDetail ?? `GET /api/orders/${orderId}`}
            explanation="Nothing was changed. This screen only reads from the MES."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      ) : (
        <OrderDetailScreen
          order={data.order}
          issues={data.issues}
          analysis={
            <AnalysisPanel
              issueCount={data.issues.length}
              state={analysisState}
              result={analysis}
              errorDetail={analysisError}
              onExplain={explain}
            />
          }
        />
      )}
    </AppShell>
  );
}
