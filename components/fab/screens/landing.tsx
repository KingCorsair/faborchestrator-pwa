/**
 * The landing screen — **FabOrchestrator's cockpit, running as a PWA.**
 *
 * ── What this is, and what changed on 2026-08-23 ────────────────────────────
 * Until today this page was a landing page *about* FabOrchestrator, written
 * here: an identity block, a sentence, and a grid of capability cards. It was
 * carefully argued and it was a different page from the one the product ships.
 *
 * The requirement now is that opening this PWA feels like opening
 * FabOrchestrator. So this page reproduces the product's own front door —
 * `claudeai_athena/app/home/page.tsx` → `components/cockpit/cockpit-page.tsx`,
 * which is five files:
 *
 *   cockpit-nav.tsx           the sticky white bar, brand lockup, nav pills
 *   cockpit-hero.tsx          the status pill and *Your orchestration cockpit.*
 *   cockpit-ask.tsx           the 780px ask bar and its three chips
 *   agent-cards.tsx           "The Nucleus" — four agent cards
 *   cockpit-footer-stats.tsx  Live ops and Recent activity
 *
 * Same order, same measures (`max-w-[1180px]`, `px-[26px]`, `pt-[38px]`), same
 * composition. **FabInsight is where the product puts it**: AGENT · 01, first
 * card of the Nucleus. Since 2026-08-24 all four cards open, each onto a screen
 * in this app that forwards to that agent's own FabOrchestrator endpoint.
 *
 * ── The numbers on the Live ops panel are the product's placeholders ────────
 * `1,284`, `142`, `8,394`, `7`, `62%` and the recent-activity lines are
 * hardcoded strings in `cockpit-footer-stats.tsx` and `agent-cards.tsx` — the
 * shipped cockpit has no data source behind them either. They are reproduced
 * **at the reviewer's explicit instruction (2026-08-23)**, which was for a
 * faithful replica including the stats.
 *
 * This is the one place in this app where a number on screen resolves to no
 * record, and it is worth being precise about why that is not the thing
 * CLAUDE.md forbids. The prohibition is on *inventing* content — a metric this
 * demo made up about a factory it cannot see. These are quoted, from the
 * product's own front door, and both `AGENTS` and `KPIS` say so where they are
 * declared. Nothing on `/orders`, `/decisions` or `/activity` is affected:
 * every number on those screens still comes from the adapter and the rules.
 *
 * If that trade is judged wrong, the fix is to delete `<FooterStats />` and the
 * `metric`/`delta` fields on `AGENTS` — one component and two fields, no other
 * caller. Everything else on this page traces to something.
 *
 * ── Where the demo's own workflow went ──────────────────────────────────────
 * Below the cockpit, under its own heading. The production order workflow is
 * not on the product's cockpit — it is this demo's, built here — so putting it
 * inside the Nucleus would be inventing a fifth agent. It keeps the accent
 * border, the live icon tile and the arrow it had before, which are this app's
 * three signals for *pressable*.
 *
 * ── Still ships no JavaScript of its own ────────────────────────────────────
 * It reads no session and fetches nothing, so `/` still prerenders as static —
 * and the ask bar is a plain GET form rather than a client component, so the
 * front door works before any bundle arrives. `SignOutLink` is the one client
 * leaf, and it renders nothing without a session.
 */

import Link from "next/link";
import { ArrowRight, ClipboardList } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BrandLockup } from "@/components/fab/brand";
import { SignOutLink } from "@/components/fab/sign-out-link";
import { Label } from "@/components/fab/primitives";
import { Ask } from "@/components/fab/screens/landing-ask";
import { PLATFORM_CAPABILITIES } from "@/lib/capabilities";

/* ── The product's cockpit ───────────────────────────────────────────────── */

/**
 * The nav, in the shape of `cockpit-nav.tsx` and carrying **this app's**
 * sections rather than the product's five labels.
 *
 * The product's nav reads Cockpit · Agents · Workflows · Sites · Reports, and
 * every one of those five pills calls `router.push("/home")` — they lead
 * nowhere in the product either. Reproducing them here would put four controls
 * that do nothing at the top of the front door, which is the same failure
 * `__tests__/platform/capabilities.test.ts` exists to prevent one section
 * lower: a thing that looks like a door and opens onto nothing.
 *
 * So the *shape* is the cockpit's — sticky white bar, brand lockup, pills at
 * `--r-chip` with the navy fill on the active one — and the labels are the four
 * places this app can actually take you. It matches `app-shell.tsx`, which is
 * the nav on every screen behind this one, so the front door and the app do not
 * disagree about what this product is.
 */
function CockpitNav() {
  return (
    <div
      className="sticky top-0 z-20 flex items-center gap-1.5 px-4 py-[14px] sm:px-[26px]"
      style={{ background: "var(--pure-white)", borderBottom: "1px solid var(--border-light)" }}
    >
      <Link href="/" aria-label="FabOrchestrator home" className="mr-[22px] flex no-underline">
        <BrandLockup size="nav" />
      </Link>

      <nav className="hidden items-center gap-1.5 md:flex" aria-label="Sections">
        <span
          aria-current="page"
          className="flex items-center gap-[7px] px-[14px] py-2 text-[14px] font-bold"
          style={{
            borderRadius: "var(--r-chip)",
            background: "var(--nav-active)",
            color: "var(--pure-white)",
          }}
        >
          Cockpit
        </span>
        {[
          { href: "/fabinsight", label: "FabInsight" },
          { href: "/orders", label: "Orders" },
          { href: "/decisions", label: "Decisions" },
          { href: "/activity", label: "Activity" },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-[7px] px-[14px] py-2 text-[14px] font-bold no-underline"
            style={{ borderRadius: "var(--r-chip)", color: "var(--text-muted-cool)" }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/**
 * The hero, from `cockpit-hero.tsx`.
 *
 * ── The one element of the cockpit that is not reproduced ───────────────────
 * The product's hero opens with a green pill reading **ALL AGENTS ONLINE**. It
 * is not rendered here, and the reason is narrow rather than squeamish: this
 * page is statically prerendered and reads nothing, so it cannot know whether
 * any agent is online. The stats below it are quoted placeholders from a page
 * that shows them regardless — a *status* pill is different in kind, because
 * its entire content is a claim about right now, and a green dot asserting the
 * health of somebody else's deployment is the one thing on this page that could
 * send an operator to look for a problem that does not exist, or stop them
 * looking for one that does.
 *
 * A live version is possible and is not free: it needs a request-time read (so
 * `/` stops prerendering) and a reachability check against FO on every landing.
 * If the pill is wanted, that is what it costs.
 */
function Hero() {
  return (
    <div className="text-center">
      <h1
        className="mt-4 text-[30px] leading-[1.1] tracking-[-1px] sm:text-[42px]"
        style={{ color: "var(--text-ink)" }}
      >
        Your{" "}
        <span
          style={{
            background: "linear-gradient(120deg,var(--brand-indigo-light),var(--cockpit-indigo))",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          orchestration
        </span>{" "}
        cockpit.
      </h1>

      <p
        className="m-0 mt-2.5 text-[14px] font-normal sm:text-[16px]"
        style={{ color: "var(--text-muted-cool)" }}
      >
        Unify systems. Automate workflows. Transform the enterprise.
      </p>
    </div>
  );
}

/* ── The Nucleus ─────────────────────────────────────────────────────────── */

interface Agent {
  num: string;
  icon: LucideIcon | (() => React.ReactElement);
  name: string;
  cat: string;
  desc: string;
  metricLabel: string;
  metric: string;
  delta: string;
  /** All four carry one, and all four stay in this app. */
  href?: string;
}

/**
 * The four agents, copied from `agent-cards.tsx` — the same numbering, names,
 * categories, one-line descriptions and metrics the product's cockpit ships.
 *
 * **All four open, and all four stay in this app.** The product's routes are
 * `/chat`, `/chat`, `/modeling-agent` and `/backend-agent` — note that AGENT ·
 * 02 shares FabInsight's `/chat` there, so it is the same conversation and
 * points at `/fabinsight` here too, rather than being given a screen the
 * product does not have.
 *
 * The other two are screens in this PWA that forward to FO's own agent
 * endpoints, exactly as `/fabinsight` forwards to `/api/chat` — see
 * `lib/faborch/agents.ts` and `app/api/faborch/[agent]/chat/route.ts`. No
 * prompt, model or manufacturing logic is added by this app for any of them.
 *
 * They were drawn as inert cards until 2026-08-24, faithfully to a product
 * where all four open, and the first person to actually use the page reported
 * the front door as broken: nine card-shaped things, one of them clickable.
 * An intermediate version sent three of them *out* to FabOrchestrator in a new
 * tab, which was the wrong reading of the same complaint — the PWA is supposed
 * to be a way to use the agents, not a set of links to somewhere that has them.
 *
 * The metrics are the product's own placeholders. See the file header.
 */
const AGENTS: Agent[] = [
  {
    num: "AGENT · 01",
    icon: NucleusIcon,
    name: "FabInsight™",
    cat: "Decision Intelligence",
    desc: "Real-time decisions across MES, ERP, and quality data.",
    metricLabel: "Queries today",
    metric: "1,284",
    delta: "18%",
    href: "/fabinsight",
  },
  {
    num: "AGENT · 02",
    icon: WrenchIcon,
    name: "AI Support Engineer",
    cat: "Operations Automation",
    desc: "Automates 70% of routine ops work.",
    metricLabel: "Auto-resolve",
    metric: "71%",
    delta: "4%",
    href: "/fabinsight",
  },
  {
    num: "AGENT · 03",
    icon: ModelIcon,
    name: "Modeling Agent",
    cat: "Enterprise Configuration",
    desc: "AI-guided MES rollouts at scale.",
    metricLabel: "Sites",
    metric: "12",
    delta: "+2",
    href: "/modeling-agent",
  },
  {
    num: "AGENT · 04",
    icon: CodeIcon,
    name: "Back-end Agent",
    cat: "Workflow Integration",
    desc: "Describe a dashboard and it builds it for you.",
    metricLabel: "Dashboards",
    metric: "87",
    delta: "3x",
    href: "/backend-agent",
  },
];

function Nucleus() {
  return (
    <section aria-label="The Nucleus">
      <div className="mb-[18px] mt-[58px] flex flex-wrap items-center gap-[11px]">
        <h2 className="text-[20px] tracking-[-0.3px]" style={{ color: "var(--text-ink)" }}>
          The Nucleus
        </h2>
        <span
          className="px-[9px] py-[3px] text-[10px] font-bold tracking-[0.06em]"
          style={{
            borderRadius: 7,
            color: "var(--brand-indigo)",
            background: "var(--brand-indigo-bg)",
          }}
        >
          4 AGENTS
        </span>
        {/* Said once, above the grid: every card opens a conversation in this
            app, and every answer is computed by FabOrchestrator. That is the
            claim this whole PWA rests on, so it is worth stating where the
            agents are rather than only in a file header. */}
        <span
          className="ml-auto text-[12px] font-normal"
          style={{ color: "var(--text-subtle)" }}
        >
          Answered by FabOrchestrator, with your tools and your role.
        </span>
      </div>

      <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {AGENTS.map((agent) => (
          <AgentCard key={agent.num} {...agent} />
        ))}
      </ul>
    </section>
  );
}

function AgentCard({
  num,
  icon: Icon,
  name,
  cat,
  desc,
  metricLabel,
  metric,
  delta,
  href,
}: Agent) {
  const body = (
    <>
      <div className="text-[10px] font-bold tracking-[0.14em]" style={{ color: "var(--text-subtle)" }}>
        {num}
      </div>

      <div
        className="mb-[14px] mt-[10px] grid h-[42px] w-[42px] place-items-center text-white"
        style={{
          borderRadius: 14,
          background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
          boxShadow: "0 5px 14px rgba(91,84,232,.3)",
        }}
        aria-hidden="true"
      >
        <Icon />
      </div>

      <h3 className="text-[16px]" style={{ color: "var(--text-ink)" }}>
        {name}
      </h3>
      <div
        className="mt-[3px] text-[10px] font-bold uppercase tracking-[0.1em]"
        style={{ color: "var(--brand-indigo)" }}
      >
        {cat}
      </div>
      <p
        className="m-0 mt-2.5 min-h-[54px] text-[12px] font-normal leading-[1.5]"
        style={{ color: "var(--text-muted-cool)" }}
      >
        {desc}
      </p>

      <div
        className="mt-1.5 px-[13px] py-[11px]"
        style={{ borderRadius: 11, background: "var(--cockpit-surface)" }}
      >
        <div
          className="text-[10px] font-bold uppercase tracking-[0.1em]"
          style={{ color: "var(--text-subtle)" }}
        >
          {metricLabel}
        </div>
        <div className="mt-[5px] flex items-baseline gap-2">
          <span
            className="text-[20px] font-extrabold tracking-[-0.5px]"
            style={{ color: "var(--text-ink)", fontVariantNumeric: "tabular-nums" }}
          >
            {metric}
          </span>
          <span className="text-[12px] font-bold" style={{ color: "var(--status-green-ink)" }}>
            ↑ {delta}
          </span>
        </div>
      </div>

      {href ? (
        <span
          className="mt-[14px] flex items-center gap-1.5 text-[12px] font-bold"
          style={{ color: "var(--brand-indigo)" }}
        >
          Open
          <ArrowRight size={14} strokeWidth={2.4} aria-hidden="true" />
        </span>
      ) : null}
    </>
  );

  return (
    <li className="flex">
      {href ? (
        <Link
          href={href}
          className="fab-card fab-card-link flex w-full flex-col p-[18px] no-underline"
          style={{ border: "2px solid var(--brand-indigo)" }}
        >
          {body}
        </Link>
      ) : (
        <div className="fab-card flex w-full flex-col p-[18px]">{body}</div>
      )}
    </li>
  );
}

/* ── Live ops and Recent activity ────────────────────────────────────────── */

/** From `cockpit-footer-stats.tsx`. Placeholders — see the file header. */
const KPIS = [
  { label: "Workflows", value: "142", delta: "↑ 12%", tone: "var(--status-green-ink)" },
  { label: "Automated", value: "8,394", delta: "↑ 23%", tone: "var(--status-green-ink)" },
  { label: "Alerts", value: "7", delta: "3 to review", tone: "var(--status-amber-ink)" },
  { label: "Time saved", value: "62%", delta: "vs Q3", tone: "var(--text-subtle)" },
];

const ACTIVITY = [
  { name: "FabInsight™", desc: "Yield anomaly flagged on Line 4", ago: "2 min" },
  { name: "AI Support", desc: "42 escalations resolved", ago: "18 min" },
  { name: "Modeling Agent", desc: "Fab West Phase 2 live", ago: "1 hr" },
  { name: "Back-end Agent", desc: "6 connectors deployed", ago: "3 hr" },
];

function FooterStats() {
  return (
    <div className="mt-[34px] grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
      <section className="fab-card px-5 py-[18px]" aria-label="Live ops">
        <h2 className="mb-[14px] text-[14px]" style={{ color: "var(--text-ink)" }}>
          Live ops
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {KPIS.map((kpi) => (
            <div
              key={kpi.label}
              className="px-[15px] py-[14px]"
              style={{ borderRadius: 14, background: "var(--cockpit-surface)" }}
            >
              <div
                className="text-[10px] font-bold uppercase tracking-[0.06em]"
                style={{ color: "var(--text-muted-cool)" }}
              >
                {kpi.label}
              </div>
              <div
                className="mt-[7px] text-[26px] font-extrabold tracking-[-0.6px]"
                style={{ color: "var(--text-ink)", fontVariantNumeric: "tabular-nums" }}
              >
                {kpi.value}
              </div>
              <div className="mt-[3px] text-[12px] font-bold" style={{ color: kpi.tone }}>
                {kpi.delta}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="fab-card px-5 py-[18px]" aria-label="Recent activity">
        <h2 className="mb-[14px] text-[14px]" style={{ color: "var(--text-ink)" }}>
          Recent activity
        </h2>
        <ul className="m-0 flex list-none flex-col gap-[3px] p-0">
          {ACTIVITY.map((row) => (
            <li key={row.name} className="flex items-center gap-3 py-[9px]">
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-bold" style={{ color: "var(--text-ink)" }}>
                  {row.name}
                </span>
                <span
                  className="block text-[12px] font-normal"
                  style={{ color: "var(--text-muted-cool)" }}
                >
                  {row.desc}
                </span>
              </span>
              <span className="flex-none text-[12px] font-normal" style={{ color: "var(--text-subtle)" }}>
                {row.ago}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ── This demo's own workflow ────────────────────────────────────────────── */

/**
 * The one workflow built in this app, and the only card below the cockpit that
 * is a door.
 *
 * It is **not** in the Nucleus, because it is not one of FabOrchestrator's four
 * agents — it is this demo, and adding a fifth card there would invent an agent
 * the product does not have. It keeps the three signals this app uses for
 * *pressable*: a 2px accent border, the live icon tile, and an arrow.
 */
const DEMO_WORKFLOW = {
  href: "/orders",
  icon: ClipboardList,
  title: "Review and approve production orders",
  line: "Search or scan an order, see the problems detected from MES data, ask the AI to explain them with evidence you can check, then approve, reject or escalate.",
};

function ThisDemo() {
  return (
    <section className="mt-[58px] flex flex-col gap-[14px]" aria-label="In this demo">
      <div className="flex flex-col gap-[6px]">
        <Label as="h2">In this PWA</Label>
        <p
          className="m-0 max-w-[var(--measure)] text-[12px] font-normal"
          style={{ color: "var(--text-subtle)" }}
        >
          FabInsight above is FabOrchestrator&rsquo;s, reached from this app. The production
          order workflow below is built here, end to end, on mock MES data. The rest name
          what the platform does and are not part of this demo.
        </p>
      </div>

      <ul className="grid list-none grid-cols-1 gap-[10px] p-0 sm:grid-cols-2 lg:grid-cols-3">
        <li className="flex">
          <Link
            href={DEMO_WORKFLOW.href}
            className="fab-card fab-card-link flex w-full flex-col gap-[10px] px-[18px] py-[16px] no-underline sm:px-[20px] sm:py-[18px]"
            style={{ border: "2px solid var(--brand-indigo)" }}
          >
            <span
              className="grid flex-none place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: "var(--r-control)",
                background: "var(--brand-indigo-bg)",
                color: "var(--cockpit-indigo)",
              }}
              aria-hidden="true"
            >
              <DEMO_WORKFLOW.icon size={17} strokeWidth={2} />
            </span>
            <h3 className="text-[16px] leading-[1.3]" style={{ color: "var(--text-ink)" }}>
              {DEMO_WORKFLOW.title}
            </h3>
            <p
              className="m-0 text-[12px] font-normal leading-[1.6]"
              style={{ color: "var(--text-muted-cool)" }}
            >
              {DEMO_WORKFLOW.line}
            </p>
            <span
              className="mt-auto flex items-center gap-[8px] pt-[4px] text-[12px] font-bold"
              style={{ color: "var(--cockpit-indigo)" }}
            >
              Open workflow
              <ArrowRight size={15} strokeWidth={2.4} aria-hidden="true" />
            </span>
          </Link>
        </li>

        {PLATFORM_CAPABILITIES.map((capability) => (
          <CapabilityCard key={capability.id} {...capability} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One capability of the wider platform. **Not a link, and it must not become
 * one** — see `lib/capabilities.ts` and its test.
 */
function CapabilityCard({
  icon: Icon,
  title,
  line,
}: {
  icon: LucideIcon;
  title: string;
  line: string;
}) {
  return (
    <li className="fab-card flex flex-col gap-[10px] px-[18px] py-[16px] sm:px-[20px] sm:py-[18px]">
      <span
        className="grid flex-none place-items-center"
        style={{
          width: 32,
          height: 32,
          borderRadius: "var(--r-control)",
          background: "var(--cockpit-surface)",
          color: "var(--text-muted-cool)",
        }}
        aria-hidden="true"
      >
        <Icon size={17} strokeWidth={2} />
      </span>
      <h3 className="text-[16px] leading-[1.3]" style={{ color: "var(--text-ink)" }}>
        {title}
      </h3>
      <p
        className="m-0 text-[12px] font-normal leading-[1.6]"
        style={{ color: "var(--text-muted-cool)" }}
      >
        {line}
      </p>
    </li>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

export function Landing() {
  return (
    <div className="fab min-h-full" style={{ background: "var(--page-surface)" }}>
      <CockpitNav />

      <div className="mx-auto w-full max-w-[var(--page-width)] px-4 pb-[48px] pt-[38px] sm:px-[26px]">
        <div className="text-center">
          <Hero />
          <Ask />
        </div>

        <Nucleus />
        <FooterStats />
        <ThisDemo />

        <div className="mt-[40px] flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
          <p className="m-0 text-[12px] font-normal" style={{ color: "var(--text-subtle)" }}>
            {/* Both halves are true and both matter: the order workflow runs on
                a fixture, and FabInsight does not — it reaches a real
                FabOrchestrator. A visitor who read "mock MES data" and then
                asked FabInsight for the yield would be entitled to think the
                answer was made up too. */}
            Demo environment · production orders run on mock MES data · FabInsight answers
            from the connected FabOrchestrator
          </p>
          <SignOutLink />
        </div>
      </div>
    </div>
  );
}

/* ── The Nucleus icons ───────────────────────────────────────────────────── */

/**
 * Drawn rather than imported from lucide, because these four are the product's
 * own marks — `agent-cards.tsx` hand-writes each as an inline SVG, and a lucide
 * lookalike would be a different glyph on the card a stakeholder recognises.
 * Same 24-box, same 2px stroke, same paths.
 */
function svg(children: React.ReactNode) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function NucleusIcon() {
  return svg(
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M8.2 6H13a3 3 0 0 1 3 3v.4" />
      <path d="M8.2 18H13a3 3 0 0 0 3-3v-.4" />
    </>,
  );
}

function WrenchIcon() {
  return svg(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2-2z" />);
}

function ModelIcon() {
  return svg(
    <>
      <circle cx="7" cy="7" r="2.4" />
      <circle cx="17" cy="17" r="2.4" />
      <path d="M9.4 7H15a2 2 0 0 1 2 2v5.6" />
      <path d="M14.6 17H9a2 2 0 0 1-2-2V9.4" />
    </>,
  );
}

function CodeIcon() {
  return svg(
    <>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </>,
  );
}
