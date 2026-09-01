/**
 * The cockpit's ask bar.
 *
 * Follows `claudeai_athena/components/cockpit/cockpit-ask.tsx` — 780px, rounded,
 * lifted, gradient **Ask** on the right, three suggestion chips underneath.
 *
 * ── One difference, and it is deliberate ────────────────────────────────────
 * The product answers **inline**, under the bar, on the cockpit itself. This
 * one **navigates** to `/fabinsight?q=…`, where the conversation lives.
 *
 * Two reasons. The landing page is unauthenticated and statically prerendered —
 * it is the screen a stranger meets before signing in — and answering here
 * would mean it holds a session, a stream and four error states, which is a
 * second copy of the FabInsight screen on a page that must render for somebody
 * with no session at all. And a follow-up question needs somewhere to live: the
 * cockpit's inline answer is a dead end after one turn, which is exactly the
 * conversation this is for.
 *
 * ── A plain GET form, and not a client component ────────────────────────────
 * `<form method="get" action="/fabinsight">` with `name="q"` on the input is
 * the whole mechanism: the browser builds `/fabinsight?q=…` itself. The first
 * version used `useRouter` and a click handler, which cost three things for
 * nothing —
 *
 *  - **`/` stopped shipping zero JavaScript.** The front door has to render for
 *    somebody on a cold cache before any bundle arrives, and typing a question
 *    is exactly what they do first. A GET form works with no JavaScript at all.
 *  - **`design-review/render.tsx` broke.** It renders `<Landing />` through
 *    `renderToStaticMarkup` with no Next router mounted, so `useRouter` threw
 *    *"invariant expected app router to be mounted"* and the harness produced
 *    no landing export. That harness is the only way any of these screens gets
 *    looked at (CLAUDE.md, thin-ice item 3), so breaking it is expensive.
 *  - The chips were `<button onClick>`, which are not links, cannot be
 *    middle-clicked, and say nothing to a screen reader about where they go.
 *    They are `<Link>`s now.
 *
 * ── The chips are the product's, verbatim ───────────────────────────────────
 * `cockpit-ask.tsx:23-27`. Not suggestions this demo invented about a factory
 * it cannot see.
 */

import Link from "next/link";
import { Send } from "lucide-react";

const CHIPS = ["Yield variance · Line 4", "Compliance · Fab West", "Monthly OEE trend"];

export function Ask() {
  return (
    <>
      <form
        method="get"
        action="/fabinsight"
        className="fab-card mx-auto mt-[26px] flex w-full max-w-[780px] items-center gap-3 py-2.5 pl-5 pr-2.5"
      >
        <label htmlFor="cockpit-ask" className="sr-only">
          Ask FabInsight
        </label>
        <input
          id="cockpit-ask"
          name="q"
          type="text"
          autoComplete="off"
          placeholder="Ask anything, or describe a task to orchestrate…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[16px] outline-none placeholder:text-[var(--text-subtle)]"
          style={{ color: "var(--text-ink)" }}
        />
        <button
          type="submit"
          className="flex flex-none cursor-pointer items-center gap-[7px] border-0 px-[18px] py-[11px] text-[12px] font-bold text-white transition-transform hover:-translate-y-px"
          style={{
            borderRadius: 13,
            background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
            boxShadow: "var(--shadow-brand)",
          }}
        >
          Ask
          <Send size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </form>

      <div className="mt-4 flex flex-wrap justify-center gap-2.5">
        {CHIPS.map((chip) => (
          <Link
            key={chip}
            href={`/fabinsight?q=${encodeURIComponent(chip)}`}
            className="fab-card fab-card-link px-[15px] py-2 text-[12px] font-bold no-underline"
            style={{ color: "var(--text-ink)", borderRadius: 20 }}
          >
            {chip}
          </Link>
        ))}
      </div>
    </>
  );
}
