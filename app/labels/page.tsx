/**
 * `/labels` — printable production order labels, for demonstrating the scanner.
 *
 * Point a phone at this page on a laptop screen, or print it and stick it on a
 * machine. Either way it is the thing the Scan button exists to read.
 *
 * **Deliberately unauthenticated.** These are pictures of order numbers, which
 * the order screens already show to anyone who is signed in — there is nothing
 * here to protect, and a login wall between a presenter and the barcode they
 * are about to scan is a demo that fails live. It is `noindex` all the same.
 *
 * A server component: no state, no session, no fetching. It renders faster than
 * the shell and cannot break the way a client screen can.
 */

import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Production order labels — FabOrchestrator",
  robots: "noindex, nofollow",
};

/**
 * Every order in the mock dataset, with what a supervisor would find on it.
 * Scanning the last two is worth showing too: an order with no detected problem
 * is a perfectly good answer, and the screen says so rather than inventing one.
 */
const LABELS: { order: string; product: string; note: string }[] = [
  { order: "PO-10382", product: "Widget A · ASM-04", note: "Three problems — the demo scenario" },
  { order: "PO-10365", product: "Widget B · ASM-07", note: "Downtime and delay, both HIGH" },
  { order: "PO-10344", product: "Widget A · ASM-04", note: "Behind schedule" },
  { order: "PO-10402", product: "Bracket C · PRS-02", note: "Behind schedule" },
  { order: "PO-10377", product: "Widget B · ASM-07", note: "Running clean — no rule fires" },
  { order: "PO-10391", product: "Bracket C · PRS-02", note: "Running clean — no rule fires" },
];

export default function LabelsPage() {
  return (
    <div className="fab min-h-full px-5 py-8" style={{ background: "var(--page-surface)" }}>
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5">
        <header className="flex flex-col gap-[3px]">
          <span
            className="text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{ color: "var(--text-subtle)" }}
          >
            Shop floor
          </span>
          <h1 className="text-[26px]">Production order labels</h1>
          <p className="m-0 max-w-[560px] text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
            Code 39, the symbology production travellers are printed with. Open the app, tap{" "}
            <strong>Scan</strong>, and point the camera at one of these — it opens that order.
          </p>
        </header>

        <ul className="m-0 grid list-none gap-4 p-0 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {LABELS.map(({ order, product, note }) => (
            <li key={order}>
              <div
                className="flex h-full flex-col gap-[10px] p-5"
                style={{
                  background: "var(--pure-white)",
                  borderRadius: "var(--r-panel)",
                  border: "1px solid var(--border-light)",
                }}
              >
                {/* Fixed height and `contain` so the bars never resample to a
                    width that stops decoding. */}
                <Image
                  src={`/demo-labels/${order}.png`}
                  alt={`Code 39 barcode for ${order}`}
                  width={432}
                  height={150}
                  unoptimized
                  className="h-[92px] w-full"
                  style={{ objectFit: "contain" }}
                />
                <span
                  className="text-[20px] font-extrabold"
                  style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-ink)" }}
                >
                  {order}
                </span>
                <span className="text-[12px] font-semibold" style={{ color: "var(--text-subtle)" }}>
                  {product}
                </span>
                <span className="text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
                  {note}
                </span>
              </div>
            </li>
          ))}
        </ul>

        <Link
          href="/orders"
          className="text-[14px] font-bold no-underline"
          style={{ color: "var(--cockpit-indigo)" }}
        >
          ← Back to orders
        </Link>
      </div>
    </div>
  );
}
