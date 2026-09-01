import type { Metadata } from "next";
import { OrdersClient } from "./orders-client";
import { safeSelectedOrder } from "@/lib/selected-order";

/**
 * `/orders` — the order list and the app's one decision surface.
 *
 * A thin server component whose only job is to read `?order=` and hand it to
 * the client component beside it. The screen itself is `orders-client.tsx`.
 *
 * ── Why the split (2026-08-20) ──────────────────────────────────────────────
 * The order screen needed a way to send you here **with the order you were
 * reading still selected**. Without it, `router.push("/orders")` landed on a
 * review panel that had fallen back to the first row of the list — a different,
 * completed order carrying no detected issues — so the workflow's last step
 * silently changed its subject. See `lib/selected-order.ts`.
 *
 * Reading the query **on the server** rather than with `useSearchParams` is the
 * pattern `/login` established for `?next=`: that hook forces its caller into a
 * Suspense boundary, which is the build risk CLAUDE.md records as the reason
 * URL state was skipped at Tier 0. Thin-ice item 2 is now answered on both the
 * pages that needed it, by the same move, and still without the hook.
 *
 * ── What it costs ───────────────────────────────────────────────────────────
 * `/orders` drops from `○` to `ƒ` in the build output, because reading
 * `searchParams` is a request-time read. That is close to free here: the screen
 * is a client component that fetches everything with the session's bearer
 * token, so its prerendered HTML was only ever `PageSkeleton`. Nothing that was
 * visible without JavaScript stops being visible.
 */

export const metadata: Metadata = {
  title: "Production orders — FabOrchestrator",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <OrdersClient initialOrder={safeSelectedOrder((await searchParams).order)} />;
}
