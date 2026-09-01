/**
 * `/diagnostics` — device capability report.
 *
 * Thin, like every other page here, but two things differ from the rest and
 * both are deliberate:
 *
 *  - **No `useSession`, so no `AppShell`.** This is the page you open when the
 *    app is not working, and "log in first" is not a diagnostic. It reads no
 *    order, no analysis and no decision — only what the browser reports about
 *    itself — so there is nothing here to protect.
 *  - **No data fetching**, so the usual page/screen split has nothing to put on
 *    this side of it. The probing is all browser-local and lives with the view.
 *
 * Reachable by typing the path. Not linked from the nav: it is a tool for
 * whoever is running the demo, not a section of the product.
 */

import type { Metadata } from "next";
import { Diagnostics } from "@/components/fab/screens/diagnostics";

export const metadata: Metadata = {
  title: "Diagnostics — FabOrchestrator",
  robots: "noindex, nofollow",
};

export default function DiagnosticsPage() {
  return (
    <div className="fab min-h-full" style={{ background: "var(--page-surface)" }}>
      <Diagnostics />
    </div>
  );
}
