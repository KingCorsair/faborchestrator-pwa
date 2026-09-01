"use client";

/**
 * `/activity` — every recorded decision, newest first.
 *
 * Same page/screen split as `/orders`: fetching here, rendering in
 * `ActivityFeed`. Same fetch pattern too — an effect with a `cancelled` flag and
 * the bearer token, no query library.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/fab/app-shell";
import { ActivityFeed } from "@/components/fab/screens/activity-feed";
import { useSession } from "@/components/fab/use-session";
import { PageSkeleton } from "@/components/page-skeleton";
import { ActivityResponseSchema, parseResponse } from "@/lib/api-schemas";
import type { Decision } from "@/lib/decisions";

type LoadState = "data" | "empty" | "loading" | "error";

export default function ActivityPage() {
  const router = useRouter();
  const session = useSession();

  const [activity, setActivity] = React.useState<Decision[]>([]);
  const [durable, setDurable] = React.useState(true);
  const [state, setState] = React.useState<LoadState>("loading");
  const [errorDetail, setErrorDetail] = React.useState<string>();
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!session.token) return;
    let cancelled = false;

    setState("loading");
    fetch("/api/activity", {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET /api/activity → ${res.status}`);
        return parseResponse(ActivityResponseSchema, await res.json(), "GET /api/activity");
      })
      .then((data) => {
        if (cancelled) return;
        setActivity(data.activity);
        setDurable(data.durable);
        setState(data.activity.length === 0 ? "empty" : "data");
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

  if (!session.ready) return <PageSkeleton />;

  return (
    <AppShell
      user={session.user}
      token={session.token}
      sessionExpiresAt={session.expiresAt}
      onRefresh={() => setReloadKey((k) => k + 1)}
    >
      <ActivityFeed
        activity={activity}
        durable={durable}
        state={state}
        errorDetail={errorDetail}
        onRetry={() => setReloadKey((k) => k + 1)}
        onOpenOrder={(orderNumber) => router.push(`/orders/${orderNumber}`)}
      />
    </AppShell>
  );
}
