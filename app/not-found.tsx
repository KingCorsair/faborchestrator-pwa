/**
 * An address that is not a screen in this app.
 *
 * Next's own 404 is a bare line of black text on white. In an installed app
 * there is no address bar to correct the address in, so that page had no way
 * off it either. This one is the app's, in the same shape as `/offline` and
 * the crash screen: what happened, and the way back.
 *
 * A signed-out visitor never sees it — `proxy.ts` sends every unknown path to
 * sign-in first — so it is written for somebody who is signed in.
 */

import Link from "next/link";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div
      className="fab flex min-h-full items-center justify-center px-6 py-10"
      style={{ background: "var(--page-surface)" }}
    >
      <div className="flex w-full max-w-[420px] flex-col items-center gap-[13px] text-center">
        <div
          className="grid place-items-center"
          style={{
            width: 58,
            height: 58,
            borderRadius: "var(--r-control)",
            background: "var(--brand-indigo-bg)",
            color: "var(--cockpit-indigo)",
          }}
        >
          <Compass size={26} strokeWidth={1.9} aria-hidden="true" />
        </div>

        <span
          className="text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{ color: "var(--text-subtle)" }}
        >
          FabOrchestrator
        </span>

        <h1 className="m-0 text-[20px]">That page does not exist</h1>

        <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
          The address may be mistyped, or the page may have moved. Everything this app offers is
          reachable from the cockpit.
        </p>

        <Link
          href="/"
          className="mt-1 inline-flex items-center justify-center px-[16px] py-[11px] text-[14px] font-bold no-underline"
          style={{
            borderRadius: "var(--r-control)",
            background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
            color: "#fff",
            boxShadow: "var(--shadow-brand)",
          }}
        >
          Go to the cockpit
        </Link>
      </div>
    </div>
  );
}
