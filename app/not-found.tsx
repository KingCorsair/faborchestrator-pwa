/**
 * An address nothing serves.
 *
 * Ported from the `chetan` branch (`e843b9c`). Next's own 404 is a bare line of
 * black text, and an installed app has no address bar to correct the address
 * in. This one says what happened and offers the way back.
 *
 * `proxy.ts` rewrites every `denied` and `unknown` path here (`notFound`), so a
 * signed-out visitor can meet it too; the way back is `/`, which takes a
 * signed-in operator to FabOrchestrator and anybody else to sign-in.
 *
 * ⚠ **Still open (plan RP5, finding G8):** the rewrite is not yet conditional,
 * so an unknown `/api/...` path also gets this HTML page rather than a JSON 404.
 * This file does not change that.
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
          The address may be mistyped, or the page may have moved.
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
          Go to the start page
        </Link>

        <p className="m-0 text-[12px]" style={{ color: "var(--text-subtle)" }}>
          <Link href="/diagnostics" style={{ color: "inherit" }}>
            Diagnostics
          </Link>
        </p>
      </div>
    </div>
  );
}
