"use client";

/**
 * `/orders` — order search, and the app's one decision surface.
 *
 * Fetching lives here and rendering lives in `OrderSearch`, matching the
 * product's page/screen split. The data-fetching pattern is the repo's own:
 * `fetch` in an effect with a `cancelled` flag and the bearer token from the
 * session — no query library, because the product does not have one and one
 * screen does not justify introducing it.
 *
 * ── Why this is not `page.tsx` any more (2026-08-20) ────────────────────────
 * `page.tsx` beside this file is now a thin **server** component that reads
 * `?order=` and hands it down as `initialOrder`. The split exists so this file
 * can stay a client component without `useSearchParams`, which would force it
 * into a Suspense boundary — the build risk CLAUDE.md records as the reason URL
 * state was skipped at Tier 0. `/login` already reads `?next=` this way; this
 * is the same move on the second page that needed it.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/fab/app-shell";
import { OrderSearch } from "@/components/fab/screens/order-search";
import { ReviewPanel, type ReviewState } from "@/components/fab/screens/review-panel";
import { ScanSheet } from "@/components/fab/scan-sheet";
import { useSession } from "@/components/fab/use-session";
import { PageSkeleton } from "@/components/page-skeleton";
import { OrderSearchResponseSchema, parseResponse } from "@/lib/api-schemas";
import { scanningIsSupported } from "@/lib/scan/barcode";
import type { DecisionKind } from "@/lib/decisions";
import type { OrderStatus, OrderSummary } from "@/lib/mes/types";

/** Long enough that typing an order number is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

type LoadState = "data" | "empty" | "loading" | "error";

export function OrdersClient({ initialOrder }: { initialOrder: string }) {
  const router = useRouter();
  const session = useSession();

  const [searchValue, setSearchValue] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [statuses, setStatuses] = React.useState<Set<OrderStatus>>(new Set());
  const [orders, setOrders] = React.useState<OrderSummary[]>([]);
  const [state, setState] = React.useState<LoadState>("loading");
  const [errorDetail, setErrorDetail] = React.useState<string>();
  const [reloadKey, setReloadKey] = React.useState(0);
  const [scanning, setScanning] = React.useState(false);

  // The review panel's own state. It lives here for the same reason every other
  // fetch does: the screens in `components/fab/screens/` stay presentational,
  // and there is exactly one place that talks to the API.
  //
  // Seeded from `?order=`, which is how the order screen hands you back with
  // the order you were reading still selected. It is only the *initial* value:
  // once the list loads, `ReviewPanel` owns the invariant that the selection is
  // an order actually on screen, and will fall back to the first row if a
  // filter or a search removes this one. A seed that survives a filter it
  // should not have survived would be worse than no seed at all.
  const [reviewOrder, setReviewOrder] = React.useState(initialOrder);
  const [reviewState, setReviewState] = React.useState<ReviewState>({ status: "idle" });

  // Whether to offer the control at all. Checked once on mount rather than
  // during render — it reads `navigator`, which does not exist on the server,
  // and a Scan button that opens a sheet saying "no camera" is worse than no
  // button.
  const [canScan, setCanScan] = React.useState(false);
  React.useEffect(() => setCanScan(scanningIsSupported()), []);

  React.useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(searchValue), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchValue]);

  React.useEffect(() => {
    if (!session.token) return;
    let cancelled = false;

    const params = new URLSearchParams();
    if (debouncedSearch.trim()) params.set("text", debouncedSearch.trim());
    for (const status of statuses) params.append("status", status);

    setState("loading");
    fetch(`/api/orders/search?${params}`, {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET /api/orders/search → ${res.status}`);
        // Parsed, not cast. Tier 4 swaps the adapter under this endpoint, and a
        // real MES returning a field in the wrong shape should say so here
        // rather than render as `NaN%` three components down.
        return parseResponse(OrderSearchResponseSchema, await res.json(), "GET /api/orders/search");
      })
      .then((data) => {
        if (cancelled) return;
        setOrders(data.orders);
        setState(data.orders.length === 0 ? "empty" : "data");
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setErrorDetail(error.message);
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [session.token, debouncedSearch, statuses, reloadKey]);

  /**
   * Records a decision straight from the list screen.
   *
   * Posts to the **same** route the order screen uses — `POST
   * /api/orders/[orderId]/decision` — rather than a second endpoint. A route of
   * its own would be a second place to keep the session-derived author, the
   * order existence check and the supersession rules correct, which is the
   * argument `/decisions` already settled.
   *
   * `analysisSource: "none"` and no `recommendedAction`: there is no analysis
   * behind a decision taken here, and the log records that rather than
   * inventing advice the model never gave.
   */
  async function submitReview(orderNumber: string, kind: DecisionKind, note: string) {
    if (!session.token) return;
    setReviewState({ status: "busy" });

    try {
      const res = await fetch(`/api/orders/${orderNumber}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({
          decision: kind,
          note: note || undefined,
          analysisSource: "none",
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setReviewState({ status: "error", message: data.error ?? `Could not record the decision (${res.status})` });
        return;
      }

      setReviewState({ status: "done", decisionId: data.decision.id, orderNumber });
    } catch {
      setReviewState({ status: "error", message: "Could not reach the server" });
    }
  }

  if (!session.ready) return <PageSkeleton />;

  return (
    <AppShell
      user={session.user}
      token={session.token}
      sessionExpiresAt={session.expiresAt}
      onRefresh={() => setReloadKey((k) => k + 1)}
    >
      <OrderSearch
        review={
          <ReviewPanel
            orders={orders}
            selected={reviewOrder}
            onSelect={(orderNumber) => {
              setReviewOrder(orderNumber);
              // A result belongs to the order it was recorded against; keeping
              // it on screen after switching would read as applying to the new
              // one.
              setReviewState({ status: "idle" });
            }}
            state={reviewState}
            onReview={submitReview}
            onOpenOrder={(orderNumber) => router.push(`/orders/${orderNumber}`)}
          />
        }
        orders={orders}
        state={state}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        activeStatuses={statuses}
        onToggleStatus={(status) =>
          setStatuses((prev) => {
            const next = new Set(prev);
            if (next.has(status)) next.delete(status);
            else next.add(status);
            return next;
          })
        }
        onClearFilters={() => setStatuses(new Set())}
        onOpenOrder={(orderNumber) => router.push(`/orders/${orderNumber}`)}
        onRetry={() => setReloadKey((k) => k + 1)}
        errorDetail={errorDetail}
        onScan={canScan ? () => setScanning(true) : undefined}
      />

      {scanning ? (
        <ScanSheet
          onClose={() => setScanning(false)}
          // Straight to the order. A scan is an unambiguous identification —
          // dropping the number into the search box and making the operator tap
          // the one result would waste the whole point of scanning it.
          onFound={(orderNumber) => {
            setScanning(false);
            router.push(`/orders/${orderNumber}`);
          }}
        />
      ) : null}
    </AppShell>
  );
}
