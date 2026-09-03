import type { Metadata } from "next";
import { ReportsClient } from "@/components/fab/screens/reports";

/**
 * `/reports` — the dashboards an administrator pinned in FabOrchestrator.
 *
 * Greyed in the nav until 2026-09-03 on the belief that dashboards were
 * admin-only. Source says otherwise: `isDashboardAdmin` gates creating,
 * pinning and deleting, while `GET /api/fabinsight/pinned` and
 * `GET /api/fabinsight/pinned/[id]` are behind `requireAuth` alone. So a
 * supervisor may read what an administrator published, which is precisely the
 * thing worth having on a phone.
 *
 * The screen is in `components/fab/screens/reports.tsx` and carries the
 * reasoning for the two decisions that are not obvious: no Refresh control,
 * and a stricter iframe sandbox than the product's own page uses.
 */

export const metadata: Metadata = {
  title: "Reports — FabOrchestrator",
  description:
    "Read dashboards pinned in FabOrchestrator by an administrator. Snapshots come " +
    "from the FabOrchestrator application; nothing is computed in this app.",
};

export default function Page() {
  return <ReportsClient />;
}
