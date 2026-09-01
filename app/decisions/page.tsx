"use client";

/**
 * `/decisions` — the decision standing on every decided order, and the place to
 * overrule one.
 *
 * Same page/screen split as the other three: fetching here, rendering in
 * `DecisionReview`. Same fetch pattern too — an effect with a `cancelled` flag
 * and the bearer token, no query library.
 *
 * The override posts to `POST /api/orders/[orderId]/decision`, the same route a
 * first decision goes to, carrying `supersedesId`. One write path into the
 * decision log, so the session-derived author and the order check cannot drift
 * between two endpoints.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/fab/app-shell";
import { DecisionReview } from "@/components/fab/screens/decision-review";
import { useSession } from "@/components/fab/use-session";
import { PageSkeleton } from "@/components/page-skeleton";
import { DecisionsResponseSchema, parseResponse } from "@/lib/api-schemas";
import type { DecisionKind, OrderDecision } from "@/lib/decisions";

type LoadState = "data" | "empty" | "loading" | "error";

export default function DecisionsPage() {
  const router = useRouter();
  const session = useSession();

  const [decisions, setDecisions] = React.useState<OrderDecision[]>([]);
  const [durable, setDurable] = React.useState(true);
  const [state, setState] = React.useState<LoadState>("loading");
  const [errorDetail, setErrorDetail] = React.useState<string>();
  const [reloadKey, setReloadKey] = React.useState(0);
  const [busyOrderNumber, setBusyOrderNumber] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!session.token) return;
    let cancelled = false;

    setState("loading");
    fetch("/api/decisions", {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET /api/decisions → ${res.status}`);
        return parseResponse(DecisionsResponseSchema, await res.json(), "GET /api/decisions");
      })
      .then((data) => {
        if (cancelled) return;
        setDecisions(data.decisions);
        setDurable(data.durable);
        setState(data.decisions.length === 0 ? "empty" : "data");
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setErrorDetail(error.message);
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [session.token, reloadKey]);

  /**
   * Record an override. Resolves to an error message for the form to show, or
   * null on success.
   *
   * `supersedesId` is the decision the row was rendered from. If somebody else
   * has overridden it in the meantime the route answers 409 rather than
   * silently undoing their change, and the message says so — which is the whole
   * reason this returns a string instead of throwing.
   */
  async function override(
    entry: OrderDecision,
    decision: DecisionKind,
    reason: string,
  ): Promise<string | null> {
    setBusyOrderNumber(entry.orderNumber);
    try {
      const res = await fetch(
        `/api/orders/${encodeURIComponent(entry.orderNumber)}/decision`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ decision, note: reason, supersedesId: entry.current.id }),
        },
      );

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const detail = payload.error ?? `Request failed (${res.status})`;
        // A 409 means the list on screen is stale, so reload it underneath the
        // message. Leaving the old row visible would invite a second attempt
        // against the same superseded decision.
        if (res.status === 409) setReloadKey((k) => k + 1);
        return detail;
      }

      setReloadKey((k) => k + 1);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      setBusyOrderNumber(null);
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
      <DecisionReview
        decisions={decisions}
        durable={durable}
        state={state}
        errorDetail={errorDetail}
        onRetry={() => setReloadKey((k) => k + 1)}
        onOpenOrder={(orderNumber) => router.push(`/orders/${orderNumber}`)}
        onOverride={override}
        busyOrderNumber={busyOrderNumber}
      />
    </AppShell>
  );
}
