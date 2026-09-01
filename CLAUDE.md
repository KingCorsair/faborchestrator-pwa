# CLAUDE.md — FabOrchestrator PWA Demo (Production Order Exception Assistant)

## What this project is

A PWA demo. A shop-floor supervisor searches or scans a production order, sees
its status and any detected problems, asks the AI to explain, gets a
recommended action with verifiable evidence, and approves / rejects /
escalates. The decision is recorded.

One story only: **a production order has a problem → FabOrchestrator detects
it → AI explains it → the supervisor decides.**

### Where it lives — decided 2026-08-10

A **standalone Next.js app in this directory**, not inside
`FabOrchestrator_product_code/`. The original brief said "built inside the
existing FabOrchestrator repository"; that turned out to be impossible without
authorisation, because that repo's own `CLAUDE.md` opened with a hard constraint
— *"Do NOT modify application code… Only write/edit files under `docs/`"* — and
carried nine individually authorised exceptions with a standing instruction to
ask before adding a tenth. Building here kept that constraint intact and keeps
the demo's diff reviewable on its own.

**That constraint was lifted on 2026-08-25** — the FO repo now permits application
changes without asking, keeping only a change log. **This app stays where it is.**
The constraint was the *blocking* reason, not the only one: a demo whose diff is
separable from the product's is reviewable, deployable and revertible on its own,
it deploys to Fly without granting a host read access to the product source
(`fly.toml`), and merging it now would mean one repo, one lockfile and one release
cadence for two things with very different risk profiles. The copied-not-imported
cost below is unchanged and still worth paying.

The cost is that shared code is **copied, not imported**. That is the same
trade the product already makes: its console kit is duplicated verbatim across
its two apps for the same reason (separate `node_modules`, no shared package).
See "Reuse before adding" for exactly what was copied.

**The plan document exists**, as `faborchestrator-pwa-demo-plan-v2.pdf` in this
directory. It arrived on 2026-08-10 after Tier 0 and Tier 1 were built, so
everything up to that point was built from this file alone. The plan is the
upstream source; where the two disagree, the plan wins unless a decision has
been explicitly taken since (the visual language and the LLM provider are both
such decisions — see Visual rules and rule 4).

**Known divergences from the plan, still open** — none of these block the demo,
all of them are the reviewer's call:

| Plan says | This app does | Why it matters |
|---|---|---|
| Output schema `{summary, likely_cause, issue_priority[], evidence[], recommended_action}` | `{summary, issues[{type, explanation, evidence}], recommendation{action, rationale, evidence}}` | Richer — per-issue explanations and per-claim citations rather than one flat evidence list. Costs the explicit `likely_cause` field (root cause is folded into the summary) and `issue_priority` (issue order carries it). **Resolved in Tier 2:** the plan's third grounding check is implemented as `unfiredIssueTypes` in `lib/ai/grounding.ts`, asserted against `issues[].type`. |
| A fourth rule, `MATERIAL_SHORTAGE` | Three rules | The adapter carries no material data at all, so the rule has nothing to read. Adding it means extending the MES contract and the fixture. |
| `MESAdapter`: `getProductionOrder`, `getOperations`, `getMachineStatus`, `getDefects`, `getMaterialStatus`, `getEvents` | `searchOrders`, `getOrder` | Coarser. One call returns the whole order graph rather than six. Tier 4 replaces this adapter against a real MES, and the plan calls the contract a Tier 0 non-negotiable — so this is the divergence most worth settling before Tier 4. |
| `POST /analyze`, `POST /actions`, `GET /activity`, `GET /issues` | `POST /explain`, `POST+GET /decision`, `GET /activity` ✅, issues returned with the order | The plan calls these "the contract, not necessarily new conventions". `GET /api/activity` now matches. The remaining two names are still ours; renaming is one route folder each and no longer gets cheaper by waiting. |
| Claude Design for every screen, with a **mandatory design review gate before implementation** | Screens written directly in code | The one process requirement that was skipped outright. It is also why the visual language went wrong twice before the reviewer caught it. |

## Hard deadline

A working Tier 0 demo by Friday. Do not start higher-tier features until the
current tier works cleanly end to end.

## Non-negotiable architecture rules

1. **Separation of responsibilities:** MES data provides facts → deterministic
   TypeScript rules detect problems and assign severity → the LLM only
   explains and recommends → a human always decides. The LLM never determines
   whether a machine stopped or a defect rate is high.
2. **Evidence is cited by record ID, never by prose.** Every mock/real MES
   record carries a stable ID (e.g. `EVT-2231`, `DEF-0417`). LLM output cites
   `{record_id, field, value}` triples. Grounding validation is an exact
   lookup against the context that was sent.
3. **No LLM confidence scores anywhere.** Severity comes from the
   deterministic rules (e.g. downtime 30–60 min = MEDIUM, >60 = HIGH).
4. **Structured output via forced tool use** — never prompt-and-parse JSON from
   free text. Validate with Zod.
   **Provider: `@anthropic-ai/sdk` against `ANTHROPIC_API_KEY`** — decided
   2026-08-10, superseding this rule's original wording.
   The rule named the *Bedrock Converse API*. There is no Bedrock anywhere in
   FabOrchestrator: the single grep hit is a stale comment in
   `app/api/chat/route.ts`, and the product calls Anthropic directly through
   `@ai-sdk/anthropic` (Vercel AI SDK) and `@anthropic-ai/sdk`, with a
   DB-backed `model_registry` for model choice. Honouring "Bedrock" literally
   would have added `@aws-sdk/client-bedrock-runtime` and a second LLM path
   existing nowhere else in the product, plus AWS model access to arrange
   before anything could run.

   Between the product's two Anthropic clients the official SDK was chosen
   over `@ai-sdk/anthropic`: `tool_choice: {type: "tool"}` plus `strict: true`
   is forced tool use as the API itself defines it, which is what an auditable
   structured-output path wants, and the Anthropic API skill treats the
   official SDK as the default for exactly this reason. Swapping to the AI SDK
   would touch one file (`lib/ai/analyze.ts`).
   *The requirement that survives is the one that matters: **forced** tool use,
   never prompt-and-parse.* Revisit only if the demo has to run inside a VPC
   with no egress to the Anthropic API.
5. **All rule thresholds live in one config object** — tunable, auditable, no
   magic numbers scattered in rule code.
6. **The MESAdapter contract is stable from day one.** `MockMESAdapter` (JSON)
   now; `FabOrchestratorMESAdapter` later. Nothing outside the adapter may
   care which one is active. Mock data must include stable record IDs from
   the start.
7. **Multi-issue analysis is unified.** When several rules fire, the LLM gets
   all issues together and returns one prioritized analysis — never one
   disconnected explanation per issue.
8. **The AI recommends; it never executes manufacturing actions.**
   Approve / Reject / Escalate buttons record the decision only (in-memory or
   simple log at first).

## Reuse before adding

Before adding any dependency or pattern, check whether FabOrchestrator already
has an equivalent and follow that instead. The survey was done on 2026-08-10
against `FabOrchestrator_product_code/claudeai_athena`; findings:

| Concern | What the product does | What this demo does |
|---|---|---|
| Data fetching | `fetch` in a `useEffect` with a `cancelled` flag and a bearer token. **No TanStack Query.** | Same. Do not add a query library. |
| API routes | `NextRequest`/`NextResponse`, `requireAuth(req)` first, Zod on input | Same, `lib/auth-middleware.ts` mirrors the signature |
| Validation | Zod 4, schemas collected in `lib/validation.ts` | Same |
| Persistence | Prisma 7 + PostgreSQL | **None.** Tier 0 is mock JSON; Tier 3 decides. Do not add Prisma before then. |
| Tests | `node --test` via tsx for unit suites; Jest + RTL + jest-axe for `__tests__/a11y/**`; Playwright for e2e. **No Vitest.** | `node --test` via tsx (`npm run test:mes`). Add Jest only when there are components worth an axe scan. |
| LLM | `@ai-sdk/anthropic` + `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`, DB `model_registry`. **No Bedrock, no AthenaTech gateway.** | `@anthropic-ai/sdk` (also a product dependency), `claude-opus-5`, forced tool use. See rule 4. |
| Barcode scanning | Nothing. The product has no scanner and no barcode library. | `BarcodeDetector` first, `zxing-wasm` (1 MB) only when absent. **The one dependency in this app with no product precedent** — the plan names it, and without it the scanner cannot be demonstrated on a Windows laptop, where `BarcodeDetector` does not exist. Its wasm is self-hosted, never CDN-loaded. |
| UI kit | shadcn primitives under `components/ui/`, themed by `:root[data-theme="fab-blue"]` + the V2 brand token block in `app/globals.css` | Tokens copied into `app/faborch-theme.css`; a small hand-written vocabulary in `components/fab/` rather than pulling in Radix and 26 shadcn files for two screens |
| Rendering an assistant's answer | `react-markdown` + `remark-gfm` (+ `remark-math`/`rehype-katex`) in `components/prompt-kit/markdown.tsx` | **`react-markdown` + `remark-gfm`, added 2026-08-23.** The one place this rule pointed *toward* a dependency: an agent asked for two days of yield answers with a GFM table, and the product already renders assistant output with exactly these two. The math/KaTeX half and the syntax-highlighted code blocks are left behind. Styling is `.fab-md` in `app/globals.css`, so the answer is set in this app's type scale. |
| Reading FO's streamed reply | `@ai-sdk/react`'s `useChat` (`full-chat-app.tsx:962`), over `ai` | **A 60-line parser, `lib/faborch/stream.ts`.** Same reasoning as the UI kit row: `useChat` brings `ai` + `@ai-sdk/react` for a screen that needs three of fifteen frame types, because the product's chat also has artifacts, file parts, reasoning panels and conversation reload. What it costs is that the frame names live here — `__tests__/faborch/stream.test.ts` pins them against `ai@6.0.97`'s `UIMessageChunk` union so a version bump fails a test rather than emptying a screen. |

**Copied from `claudeai_athena`:** the V2 token values (into
`app/faborch-theme.css`, cited in its header) and `lib/utils.ts`. The
components are *modelled on* the product's — `components/fab/app-shell.tsx`
follows `components/cockpit/cockpit-nav.tsx`, `components/login-page.tsx`
follows the product's login — but written against this app's needs rather than
copied, because the originals carry SSO buttons, marketing copy, a Prisma-backed
session and a chat sidebar that this demo has no use for.

## Visual rules

- The UI must look like FabOrchestrator: the **V2 / Fab Blue** design language
  in `app/faborch-theme.css`, scoped to `.fab`. Plus Jakarta Sans; indigo
  `#5b54e8` → `#4842d4`; navy `#10153a`; page surface `#f6f7fc`; white cards at
  radius 22 with soft shadows; fields and pills at radius 12 and 9. Every hex
  is copied from `claudeai_athena/app/globals.css`, not re-picked.

  *This rule has been wrong twice.* It first named `app/cmf-theme.css` — a
  theme scoped to `[data-theme="cmf"]` that styles **generated dashboards
  only**, and which the product's own log records as having caused a defect
  when applied more widely. It was then corrected to `app/console-theme.css`,
  which was also wrong: the console theme is the *Board* redesign **proposal**
  on an unmerged local branch, and its flat grey, square corners, hairline
  borders and Barlow Condensed read almost identically to CMF — which is
  exactly what the reviewer said when they saw it. The test to apply is not
  "which stylesheet is newest" but **"what does a stakeholder recognise as
  FabOrchestrator?"** That is the login page, the cockpit and the chat shell,
  and all three ship V2.

- **Rounded, lifted, airy.** Cards are white surfaces with a soft shadow, not
  square-cornered line drawings. If a screen starts growing hairline boxes and
  registration marks, it has drifted back to the console proposal.

- **The type scale is seven steps and no more** — `--fs-label` 10, `--fs-meta`
  12, `--fs-body` 14, `--fs-strong` 16, `--fs-title` 20, `--fs-page` 26,
  `--fs-hero` 30, defined in `app/faborch-theme.css`. Added 2026-08-12, when a
  review found the screens using **nineteen** sizes — 9.5, 10, 11, 11.5, 12,
  12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 18, 19, 22, 26, 28, 30. Eight of those
  sat half a pixel from a neighbour, which nobody can see: a difference below
  perception is not hierarchy, it is noise, and it made every new element a
  fresh guess between three near-identical values. The product's own cockpit
  uses fourteen across four files, so this demo was *more* ad-hoc than the
  thing it imitates. Components write the concrete px in the Tailwind class
  because that is what generates a utility — but only these seven px values.

- **The content column is `--page-width` (1180px), matching the product.**
  It was 860px until 2026-08-12, which rendered a visibly narrower ribbon than
  `claudeai_athena/components/cockpit/cockpit-page.tsx` — the very screen the
  look is copied from. Running prose does **not** fill that width: a 1180px
  line of 14px text is about 140 characters, roughly twice a comfortable
  measure, so text blocks carry `max-w-[var(--measure)]` (72ch). Tabular rows
  and evidence lists still fill, because those are scanned, not read.

- **Weight is for contrast, not for everything.** The same review found 34
  `semibold` + 26 `bold` + 15 `extrabold` and **zero** regular-weight text in
  `components/`. When all text is emphasised none of it is, and dense small
  bold type is what makes a screen read as a cramped internal dashboard rather
  than a considered product. Meta lines (timestamps, authors, counts) and
  running text are now 400; headings, pills, buttons and eyebrow labels keep
  their weight.

- **Do not use a `flex-1` spacer inside a `flex-wrap` row.** When the row wraps
  the spacer eats the remainder of its line and the pushed-right element drops
  to a line of its own with a gap above it. `ml-auto` on that element pushes
  right without claiming a slot, so a wrapped row closes up. Fixed in
  `activity-feed.tsx` and `decision-review.tsx` on 2026-08-12.
- Status is never carried by colour alone. Every pill renders its word beside
  its dot; the dot is `aria-hidden`. A supervisor reading through safety
  glasses on a lit shop floor is exactly who a colour-only signal fails.
- Numerals are **tabular, not monospace**. V2 has no mono face — the cockpit
  sets "1,284" in Plus Jakarta Sans. Use `Code` for IDs and figures, which
  applies `tabular-nums` so columns still line up.

### Where the FabOrchestrator look comes from

**The requirement is simply: it must look like FabOrchestrator.** These are the
files that were read to make that true. All paths are relative to
`../FabOrchestrator_product_code/claudeai_athena/`. Read these before changing
anything visual here — and prefer them over any description in this file, which
is a summary and can go stale.

| Source | Line range | What was taken | Where it landed here |
|---|---|---|---|
| `app/globals.css` | **194–244** | The V2 brand palette — `--brand-indigo`, `--cockpit-indigo`, the navy family, `--page-surface`, `--border-light`, `--text-ink`/`-subtle`/`-muted-cool`, `--status-green`/`-amber` and the error pair. Its own comment says these were "lifted verbatim from login-page, cockpit/* and full-chat-app". | `app/faborch-theme.css` — copied by value, not re-picked |
| `app/globals.css` | **806–855** | `:root[data-theme="fab-blue"]` — the product's default theme: `#f7faff` body, `#2563eb` primary, `#0c1844` sidebar, `--radius: 0.5rem` | Confirmed the palette and, more importantly, that the product is **rounded** |
| `components/login-page.tsx` | whole file | The card at radius 22 with `0 24px 60px rgba(16,21,58,.16)`, filled fields at radius 12, the gradient primary button at radius 13, the navy brand panel, the pill-shaped eyebrow badge | `components/login-page.tsx` |
| `components/cockpit/cockpit-nav.tsx` | whole file | The sticky top nav: brand lockup (14.5px bold over 9.5px at .14em tracking), nav pills at radius 9 with `--nav-active` navy fill when selected, 34px icon buttons, the 30px gradient avatar | `components/fab/app-shell.tsx` |
| `components/cockpit/agent-cards.tsx` | whole file | Card composition — eyebrow label, title, supporting line, a metric with its delta | `components/fab/screens/*` |
| `components/ui/card.tsx`, `components/ui/button.tsx` | — | Radius conventions (`rounded-2xl` cards, `rounded-lg` controls) and the control height scale | `components/fab/primitives.tsx` |
| `app/layout.tsx` | whole file | How fonts are loaded — `next/font`, self-hosted, so a factory network that cannot reach `fonts.googleapis.com` still renders correctly | `app/layout.tsx` (Plus Jakarta Sans) |

⚠ **`components/cockpit/` only exists on `main`.** The `ui_console_board_redesign`
branch **deleted** all six files when it replaced the cockpit with the console
shell. Checked out on that branch you will find nothing, and may wrongly
conclude the console kit is the only shell the product has. Read them with:

```bash
git show main:./claudeai_athena/components/cockpit/cockpit-nav.tsx
```

**What was deliberately *not* copied:** the login page's SSO buttons, marketing
propositions and password-reset flow; the chat app's navy sidebar; the shadcn
component set. This demo has two screens and no chat — copying a 24KB sidebar
to render two nav links, or shipping SSO buttons that do nothing, would make it
look less like a real product, not more.
- No chatbot interface. No decorative AI styling or gradients. AI is
  secondary to the manufacturing workflow.
- The Explain Issue flow needs a real loading state (2–5 s per round trip, and
  a corrective retry doubles that) and a degraded state for validation failure.
  The original wording said "Bedrock"; rule 4 supersedes it.
- Approved Claude Design screens are the visual spec when provided.

## Demo scenario (mock data)

Order `PO-10382`, product Widget A, machine ASM-04, status IN_PROGRESS.
Planned 1000, completed 620, expected-by-now 750. Downtime 42 min.
Defect rate 9% vs normal 2%. Three rules fire: MACHINE_DOWNTIME,
QUALITY_PROBLEM, PRODUCTION_DELAY.

Delay rule definition:
```
expected_qty = planned_rate_per_hour × hours_elapsed_on_current_operation
delay_ratio  = (expected_qty − completed_qty) / expected_qty
PRODUCTION_DELAY fires when delay_ratio > 0.10 (configurable)
```

Keep a cached known-good analysis response for `PO-10382` as a fallback so the
demo survives an API timeout. It is grounding-checked against the live order
like any other analysis — a hand-written fallback that cites a record which no
longer exists would wear the badge while being wrong.

## Tier plan (work strictly in order)

- **Tier 0 (Friday): ✅ done 2026-08-10.** FabOrchestrator-style screen, order
  search, mock JSON order with record IDs, order details, one hard-coded
  problem, PWA manifest. No AI. See "Current state" below.
- **Tier 1: ✅ done 2026-08-10.** Real rules + severities, Explain Issue with
  loading state, Claude with forced tool use, unified analysis,
  Approve/Reject/Escalate with in-memory log, cached fallback.
- **Tier 2: ✅ done 2026-08-11.** Grounding validation with one corrective
  retry then a flag, Zod on responses as well as requests, the "Grounded in MES
  data" badge, barcode/QR scan (`BarcodeDetector`, zxing-wasm fallback),
  activity feed. See "Current state (Tier 2)" below.
- **Tier 3: persistence ▶ in progress 2026-08-19.** The decision log has a
  Postgres store behind a contract; see "Tier 3: the decision log persists"
  below, including why SQLite lost. Still to do: full LLM-input snapshots in the
  audit trail, more scenarios, Promptfoo harness.
- **Tier 4:** Real FabOrchestratorMESAdapter.
- **Tier 5:** Push notifications, offline caching.

Write tests for the rule layer and grounding validation as they are built.

## Current state (Tier 2, 2026-08-11)

```
npm install               # postinstall copies zxing's wasm into public/zxing/
cp .env.example .env      # then set SESSION_SIGNING_SECRET and the demo password
npm run dev               # http://localhost:3002
npm test                  # 162 tests: rules, AI contract, grounding, retry, scan, decisions, platform, faborch
npm run icons && npm run labels   # regenerate PWA icons and demo barcodes
```

**Layout.** `lib/mes/` is the whole manufacturing layer: `types.ts` is the
`MESAdapter` contract, `rules-config.ts` is every threshold, `issues.ts` is
deterministic detection, `mock-adapter.ts` reads `mock-data/orders.json`, and
`index.ts` is the only file that picks an adapter. `lib/scan/` is the scanner,
and nothing outside it knows which decoder ran. `app/api/orders/*`,
`app/api/activity` and `app/api/decisions` are the authenticated routes.
`app/orders`, `app/orders/[orderId]`, `app/activity` and `app/decisions` are the
four working screens; all thin, with fetching in the page and rendering in
`components/fab/screens/`. `app/page.tsx` is **FabOrchestrator's** landing
page — since 2026-08-23 a reproduction of the product's own cockpit — and
`app/login` is sign-in; see "The landing page" below for why those are two
routes. `lib/capabilities.ts` is what that page says the platform does, each
entry carrying the document it was read from.

`lib/faborch/` and `app/api/faborch/chat` are the **FabInsight** integration and
hold no manufacturing logic of any kind: `/fabinsight` forwards a prompt to the
running FabOrchestrator, and FO's agent and its approved tools answer it. See
"FabInsight, and the front door becomes the product's cockpit" below, and the
rule that keeps it thin in "What NOT to build".
`components/fab/` is the whole presentation layer — the V2 vocabulary
(`primitives.tsx`), the brand lockup (`brand.tsx`), the top-nav shell, the scan
sheet, the session hook.

**What is real.** Six mock orders, every record carrying a stable ID.
`PO-10382` is the scenario order — 42 min down on ASM-04, 620 of 1000 against
750 expected, 56 defects on 620 completed (9.0% against a 2% baseline).
MACHINE_DOWNTIME fires at MEDIUM, and its severity comes from
`RULE_CONFIG.machineDowntime`, not from a literal in the screen. Its evidence
is `{record_id, field, value}` triples that resolve against `recordIndex()`.
All three rules fire on it: QUALITY_PROBLEM HIGH (4.5×), MACHINE_DOWNTIME
MEDIUM (42 min), PRODUCTION_DELAY MEDIUM (17.3%).

**The AI layer (Tier 1).** `lib/ai/` is the whole of it. `schema.ts` is the
contract — one definition used twice, as the tool's `input_schema` so the API
constrains generation and as a Zod validator so nothing reaches a screen
unchecked. `system-prompt.ts` is extracted for the same reason the product
extracted its Back-end Agent prompt: a prompt inline in a route cannot be
hashed or evaluated without dragging routing code along. `context.ts` builds
what the model sees **and** what a citation is later checked against, from one
object — the two cannot drift. `analyze.ts` makes the call: forced
`tool_choice`, `strict: true`, thinking left at the Opus 5 default.

**The model is Haiku 4.5** — changed from `claude-opus-5` on 2026-08-11 on
cost grounds. The job is narrow: the model is handed the facts, the fired
issues and the exact records it may cite, then held to a strict schema and a
grounding check. Both models produced grounded, well-formed analyses on the
first attempt; Haiku is roughly twice as fast. `ANALYSIS_MODEL=claude-opus-5`
switches back with no code change.

**`output_config.effort` is model-dependent.** Haiku 4.5 rejects it outright —
`400 invalid_request_error: This model does not support the effort parameter`,
probed 2026-08-11. `analyze.ts` sends it only to models that accept it
(`supportsEffort`), and drops it and retries once if that predicate turns out to
be wrong about a model that does not exist yet.

**Thinking is deliberately not disabled.** With thinking off, Opus 5 can emit
a tool call as plain text — the turn succeeds, the call never happens, and
nothing errors. Haiku 4.5 has no such default and was probed returning a clean
`tool_use` under forced, strict tool choice. Where `effort` exists it is the
latency lever instead.

**Measured latency, first real calls (2026-08-11).** Opus 5: 21.1 s and 19.1 s.
Haiku 4.5: 10.8 s and 8.7 s. `ANALYSIS_TIMEOUT_MS` was raised from 25 s to 40 s
as a result — it is a **per-attempt** budget, and at 25 s an ordinary Opus call
was one bad network minute from timing out. A timeout degrades straight to the
cache with no retry, so it is the failure that costs the most.

**Four ways it degrades, one destination.** No API key, an API failure, a
timeout, and output that fails validation all fall back to the cached analysis
for that order, and every result carries its own `source`. A cached answer is
never rendered as a live one — the card says which it is, and why it fell back.
Orders with no cached analysis get an honest 503 rather than a plausible
invention.

**Grounding (Tier 2).** `lib/ai/grounding.ts` resolves every
`{record_id, field, value}` the model returned against `citableRecords(order)` —
the same object that built the prompt, so the validator can never judge a
citation invalid because it read a different copy of the order. Three checks per
citation (record exists, field exists, **value matches**) plus one over the
analysis as a whole: every issue type explained must be one the rules detected,
because an invented issue cites nothing and would otherwise pass by having
nothing to fail.

The value check is the one that earns the badge. A model can name a real record
and a real field and still put the wrong number beside it, and that is the only
error a supervisor cannot catch by reading — "EVT-2231 durationMinutes 24" looks
exactly as authoritative as "42".

**One corrective retry, then the truth.** Output that fails Zod or fails
grounding gets exactly one retry, sent as a `tool_result` naming each bad
citation and what the record actually holds — a correction, not a re-roll. If
the second attempt also fails grounding the analysis is **shown anyway**,
without the badge, with the failing citations struck through and the real value
beside them. Hiding it would teach an audience that the badge appears whenever
the AI answers.

**Zod on the way out as well as in.** `lib/validation.ts` is what the API
accepts; `lib/api-schemas.ts` is what a screen accepts. Pages used to write
`payload as AnalysisResult` — a cast that checks nothing at runtime, on the
payload the honesty badge renders from. Each schema is tied to its interface by
an `Assignable<>` type assertion, so a drift fails the build rather than a
screen.

**Scanning.** `lib/scan/barcode.ts` picks `BarcodeDetector` when the browser has
it with Code 128 support, and lazy-loads zxing-wasm otherwise — which is the
path Windows and Firefox take, i.e. the demo laptop. `extractOrderNumber` pulls
`PO-…` out of whatever the label encodes (a URL, a pipe-delimited traveller
record, a printer's prefix) and normalises it to the form `OrderNumberSchema`
accepts, so a successful scan can never 400 the route it navigates to. Scan sits
**beside** the search field, never instead of it: a camera fails on a scuffed
label and in bad light, and typing always works.

**Activity feed.** `GET /api/activity` returns every decision, newest first,
each carrying the recommendation it answered — a row saying only
"PO-10382 · rejected · 14:22" is unauditable six weeks later. The response
carries `durable: false` and the screen says so out loud, because a log that
forgets on restart and does not admit it is worse than no log.

### Decision review and override (2026-08-12)

`/decisions` is the fourth screen: **one row per decided order, showing the
decision in force**, with an Override control. Deliberately not a second
activity feed — activity answers *what happened* and is a flat event list, this
answers *what stands now*, which is the question somebody revisiting an approval
an hour later actually has. Filtered by the standing decision, defaulting to
Approved.

- **An override is an append, never an edit.** It records a new decision
  carrying `supersedesId`; the original stays visible, struck through, behind a
  "N superseded decisions" disclosure. Rewriting the original would destroy the
  only record of what was first decided and by whom — the one thing a decision
  log exists to keep. It also keeps the store append-only, so Tier 3 can persist
  it as an insert-only table rather than a table with an update path and a
  history trigger.
- **One write path.** `/decisions` posts to `POST /api/orders/[orderId]/decision`
  — the same route a first decision uses — rather than a route of its own. A
  second endpoint appending to the log would be a second place to keep the
  session-derived author, the order existence check and the inheritance rules
  correct.
- **The override inherits `recommendedAction` and `analysisSource` from the
  record it supersedes**, and the client cannot send them. A manager overriding
  an approval is not looking at a fresh analysis, and a client that could restate
  the recommendation could put advice in the audit trail that the model never
  gave.
- **A reason is required to override, optional on a first decision.** The
  asymmetry is the point: a first decision sits beside the analysis that explains
  it, an override sits beside nothing but disagreement.
- **Optimistic concurrency.** `supersedesId` must be the standing decision or the
  route answers 409 with the id that actually stands, and the screen reloads
  underneath the message. Without it, two managers on one order silently undo
  each other and the log grows two rows each claiming to supersede the same one.
- **Rule 8 is untouched.** Overriding records that a manager disagreed. Nothing
  reachable from the screen writes to the MES — the adapter still has no write
  method.
- Overrides are marked in the activity feed ("Override of DEC-0004") and the
  order-detail history strikes through everything but the standing decision.
  Two contradictory pills with no relationship between them is worse than one.
- `__tests__/decisions/decisions.test.ts` — 16 tests over supersession, the
  standing-decision selector and `DecisionSchema`. `npm run test:decisions`.

**What this screen does not have: any notion of a manager.** `lib/auth.ts` has
one credential pair and a `roleName` read from `DEMO_USER_ROLE`, so there is no
role to gate on — anyone logged in can override anyone. Adding a fake role check
over a single-user auth would look like authorisation while being none, so it
was left out rather than faked. It belongs with the item 1 replacement below,
not before it.

### PWA demo behaviour (2026-08-11)

Installability was already met; what was missing was everything you only notice
once somebody installs it.

- **`apple-touch-icon` (180×180) was absent.** iOS reads that link and nothing
  else — without it, "Add to Home Screen" uses a *screenshot of the page* as the
  icon. Generated by `scripts/generate-icons.ts` alongside the others.
- **`statusBarStyle` was `black-translucent`, which is wrong for this app.** It
  slides the page under the status bar and makes iOS draw the clock and battery
  in white, over a white header. Now `default`.
- **Manifest gained `id`, `lang`, `dir`, `orientation`.** Without `id`, Chrome
  derives app identity from `start_url`, so changing that route would orphan
  every installed copy.
- **Touch targets reach 44px under `@media (pointer: coarse)` only.** The V2
  control scale is a desktop scale — a 13.5px button with 9px padding is ~33px,
  fine for a mouse and not for a gloved thumb. Desktop density is untouched,
  because that density is what makes the screens read as FabOrchestrator.
- **`/labels` and `public/demo-labels/*.png`.** The scanner had nothing to point
  at. `scripts/generate-demo-labels.ts` hand-rolls **Code 39** — the symbology
  production travellers are actually printed with, already in the scanner's
  format list, and ~40 lines because it has no error correction and no matrix.
  A QR encoder is Reed–Solomon and masking: several hundred lines or a second
  wasm, for a demo prop. `__tests__/scan/labels.test.ts` reads every label back
  with the same `zxing-wasm` the app uses and asserts it decodes to its own
  order number — the closest the scanner gets to end-to-end without a camera.
- **Manual order entry inside the scan sheet.** A refused permission, no camera,
  plain HTTP on a LAN address, a scuffed label — all ordinary on a shop floor,
  and all previously ended at a button that just closed the sheet. Validated
  with the same `extractOrderNumber` a scan goes through, so typed and scanned
  input are the same thing by the time they leave.
- **`/offline`, served by the service worker on failed navigation only.** In a
  standalone window with no address bar, Chrome's dinosaur reads as the app
  having crashed. The page states plainly that order data is not stored on the
  device — **nothing under `/api/` is cached, and that is deliberate**: a cached
  downtime figure is a wrong downtime figure. Only the offline page and two
  icons are precached.

### iPhone deployment (2026-08-12)

**The blocker was never code.** `getUserMedia` and `serviceWorker.register` both
require a secure context. `localhost` is exempt; a phone reaching the laptop at
`http://192.168.x.x:3002` is not — so over plain HTTP on a LAN the scanner is
silently dead (`scanningIsSupported()` returns false, the sheet offers manual
entry as though there were no camera) and no worker registers. iOS still allows
Add to Home Screen over HTTP, which is the trap: you get an installed app that
is missing both features the install was meant to demonstrate. The README
carries the procedure; a Cloudflare quick tunnel is the recommended path and
**Vercel is not**, because `lib/decisions.ts` is a module-level `Map` and
serverless would drop decisions between invocations.

Most of the iOS surface was already right — `apple-touch-icon`, `statusBarStyle:
default`, `viewportFit: cover`, `playsInline` + `muted` on the scanner video,
`facingMode: environment`, and 16px inputs. Four things were not:

- **Safe areas did not reach the scan sheet.** `body` carries the insets
  (`app/globals.css`), which covers document flow and **nothing that is
  `position: fixed`** — a fixed element is placed against the viewport and
  inherits none of it. The sheet is the app's only fixed element, so its close
  button sat under the Dynamic Island and its status line under the home
  indicator. It now pads its own header and footer with
  `max(<designed>, env(safe-area-inset-*))` — `max()` because the raw inset is 0
  on a device with no notch, which would strip the padding every phone needs.
  The video stays full-bleed; only the chrome insets. **Landscape is the case
  that bites**: a notched iPhone turned sideways puts a 44px inset on the edge
  the close button is on.
- **The two decision notes were 14px.** iOS zooms the page when a focused
  control is under 16px and does not zoom back out, so the one field a
  supervisor types into at length was the one that stranded them on a magnified
  page. Raised to 16px under `(pointer: coarse)` only, beside the existing
  touch-target block, so desktop density is untouched.
- **Safari fires no `beforeinstallprompt`, ever.** Without a hint, Add to Home
  Screen is two taps into a sheet of twenty options and nobody finds it — which
  for a demo whose point is that it installs is the whole demo.
  `components/fab/ios-install-hint.tsx` shows one at the bottom of the screen
  (where Safari's Share button actually is), gated on iOS **and** not already
  standalone **and** not previously dismissed. Rendered from the root layout so
  it also appears on the login screen, which is what somebody opening the URL on
  a phone sees first. iPadOS is detected by touch points, because it reports
  itself as "Macintosh".
- **`overscroll-behavior-y: none`.** iOS rubber-band under a sticky header reads
  as the header having come loose.

**`/diagnostics` is the new screen, and it exists because Windows cannot
remote-debug iOS Safari.** No console, no network panel, no way to evaluate an
expression on the device the demo runs on. It reports secure context, origin,
service-worker state, display mode, camera availability, native-decoder
presence, **resolved safe-area insets**, viewport, storage and UA, plus two
gesture-gated probes — Test camera (reports resolution, `facingMode` and device
label, then stops every track) and Test decoder (calls the real
`createScanner()`, so a pass means the scanner's hardest dependency genuinely
resolves on that device).

- **Unauthenticated, deliberately.** It reads no order, no analysis and no
  decision — only what the browser says about itself — and the moment it is
  worth opening is the moment nothing else works. A diagnostics page behind a
  login you cannot complete is not a diagnostics page.
- **Insets are read off a hidden fixed probe element**, because `env()` is not a
  property and `getComputedStyle` cannot be asked for one directly. Applying all
  four as padding and reading the computed padding back is the only way to get a
  number out. They read 0 on a laptop, so this row proves nothing until it is
  read on the phone — which is exactly why the row exists.
- **Neither probe runs on load.** Both need a user gesture and both have side
  effects (a camera light, a 1 MB download). A diagnostics page that opens the
  camera by itself is one nobody trusts.
- Not linked from the nav. It is a tool for whoever runs the demo, not a section
  of the product.

**Two iOS behaviours that are not bugs and will still surprise somebody
mid-demo:** an installed iOS web app has its own storage jar, so signing in in
Safari does not carry into the installed app; and camera access inside a
standalone home-screen web app needs **iOS 16.4+** — below that, scanning works
in Safari but not from the home-screen icon.

### Hosted deployment and the QR handoff (2026-08-13)

The ask changed from "show it on a phone next to the laptop" to **"someone else
opens it whenever they like"**, and that is a different problem. A tunnel cannot
answer it: the URL is ephemeral, so a QR code made from it stops resolving the
moment the tunnel stops, and a code that resolves to nothing reads to the
recipient as a broken demo rather than a stopped tunnel. `scripts/generate-qr.ts`
**refuses tunnel hostnames and non-https URLs** for exactly that reason.

**Fly.io, deployed from this directory with `flyctl`.** The three constraints
that picked it:

- **`lib/decisions.ts` is a module-level `Map`,** so the host must run one
  long-lived process. That is what still rules out Vercel, unchanged since the
  iPhone entry above.
- **It must not sleep.** Render's free tier stops after ~15 minutes idle, and a
  ~50 s cold start on a link somebody opened unprompted looks like a fault. A
  stop also empties the decision store. `auto_stop_machines = false` and
  `min_machines_running = 1` in `fly.toml` are load-bearing, not defaults.
- **No GitHub connection.** This directory is a subfolder of
  `athenatech-work-projects`, which also tracks 551 files of FabOrchestrator
  product source. Connecting a host to that repo would grant a third party read
  access to all of it; `flyctl deploy` uploads only this directory.
  (`passwords.txt`, `login details.txt` and `to do list.txt` sit in the parent
  and are all untracked — verified, not assumed.)

**`output: "standalone"` + a three-stage Dockerfile.** Two things in it are
deliberate rather than boilerplate. `npm ci --ignore-scripts` in the deps stage,
because `postinstall` runs a script that is not in that layer yet — so the
zxing copy is an explicit step in the builder, followed by
`test -f public/zxing/zxing_reader.wasm`. That turns the silent degradation this
file already warns about (a host skipping lifecycle scripts ships a dead
scanner) into a failed build, which is the only place it is cheap to catch. And
`HOSTNAME=0.0.0.0`, because the standalone server binds loopback by default and
inside a container that means the health check never connects.

**`npm run build` on Windows now prints a wall of `EINVAL: copyfile`.** Harmless
and explained in `next.config.ts`: Turbopack names externals chunks
`[externals]_node:path_….js`, and a colon cannot appear in an NTFS filename, so
only the copy into `.next/standalone/` fails. Exit code is 0, `npm start` serves
`.next/` and is unaffected, and the deploy builds on Linux.

**Prefilling the sign-in email is opt-in (`DEMO_PREFILL_EMAIL`), not a default.**
`lib/auth.ts` has no rate limiting, so on a permanently public URL putting the
username on the page leaves only the password. Worth it for one named person
typing on a phone; not worth it silently, for every deployment, forever.

**What this deployment makes worse, stated plainly:** item 1 below — auth — goes
from "must not ship as is" to "is shipped, publicly, indefinitely, and every
successful login spends `ANTHROPIC_API_KEY` with no cap". The README asks for a
spend-limited key and a real password; that is mitigation, not a fix. And item 6
— the in-memory decision store — is now user-visible in a new way: a decision
recorded today is gone after any redeploy or restart. The screen still says
`durable: false`, so it remains honest.

### The offline screen on a working network, twice (2026-08-19)

Reported again, days after the cold-start fix: the installed app showing the
app's own *"No connection"* screen while the phone was online. The server was
verified healthy first this time — machine started, every route 200, login and
all five API routes answering, `sw.js` serving v2, `/offline` carrying its
recovery script, the probe target 200. **Nothing was wrong at the origin.**

**The device was in a loop that no deploy could reach.** A v1 worker still in
control serves its own *v1-cached* offline page on a single failed fetch. That
HTML is from an earlier build, so its content-hashed chunks 404, so no
JavaScript runs, so `RegisterServiceWorker` never executes, so the worker never
updates — and the inline recovery scripts added since are in documents this
device will never fetch. Every fix shipped after the poisoning is invisible to
the thing that needs it.

**Two structural changes, and one that is only a mitigation.**

1. **`self.navigator.onLine === false` now gates the offline page.** `onLine` is
   a weak signal — it reports a link, not reachability — but it is decisive in
   one direction: false means there is genuinely no network. A worker that
   cannot reach the server while the browser says it is online has learned
   something about *itself*, not about the network, and must not speak for it.
   This is the same error as the cold-start bug in a different costume:
   concluding from one local failure that the world is down.
2. **When online and still failing, the worker answers with HTML it generates as
   a string** — no stylesheet, no chunk, no cache entry. A device in this state
   is one whose stored copies cannot be trusted, because that is how it got
   here; a response built at runtime cannot be stale. It carries a **Reset and
   reload** button that unregisters every worker, deletes every cache and
   replaces the location. That is the only in-app way out of the loop above,
   and it is why the button exists rather than a link.
3. `CACHE` is `faborch-offline-v3`, so activating drops the v1 and v2 caches and
   with them the stale offline documents.

**None of that rescues a device already stuck**, and the entry should say so
plainly. The reliable reset from outside is: delete the home-screen icon, then
open the URL in a **private tab**, which uses no worker and no cache — if it
works there and not in the installed copy, the diagnosis above is confirmed
rather than assumed.

**The pattern worth carrying forward.** This app's offline page has now been
wrong twice, and both times it was wrong in the same direction: it claimed a
fact about the world from evidence that only supported a fact about itself. A
degraded state must be able to say *"I could not do this"* without upgrading it
to *"this cannot be done"*.

### The installed app opened on /offline (2026-08-18)

**The first defect found by somebody actually using it on a phone.** Tapping the
Home Screen icon showed the app's own "No connection" screen; the *same URL*
from the QR code, in Safari, was fine. The device was online throughout, the Fly
machine was `started`, and `https://faborch-demo.fly.dev/orders` answered 200 in
0.37 s from here. Nothing was down. The app was lying.

**The cause was one rejected fetch treated as a verdict.** `public/sw.js`
intercepted the navigation, called `fetch(request)` once, and served the
precached offline page on *any* rejection. A standalone iOS web app launches its
own WebKit process and issues the `start_url` navigation immediately — before
the networking stack is necessarily attached — so that first fetch can reject on
a perfectly good connection. Safari never showed it because a tab navigation
happens in a process that is already running and already has the network. **The
bug needed a cold start to exist, so it could only ever appear on the installed
copy** — which is to say, only in the thing the PWA demo is for.

It is also the sharpest example so far of a failure this file keeps predicting
by another name: everything downstream was honest. The offline page said what it
always says, correctly and in the product's voice. The *premise* handed to it
was false, and no amount of careful wording downstream of a wrong input rescues
it. Compare the rule-layer entry above — true records, false inference.

**Fixed, cheapest defence first:**

1. **Navigation preload** (`self.registration.navigationPreload.enable()`,
   feature-detected because WebKit only shipped it in Safari 17). The browser
   starts the navigation itself, in parallel with booting the worker, so the
   response no longer depends on a fetch issued from a worker that is still
   starting.
2. **Two retries at 300 ms and 600 ms** before concluding anything. **GET only**
   — a POST navigation's body is consumed by the first attempt, so retrying one
   either fails or double-submits, and there is a test pinning that.
3. **The offline page only then**, which makes it mean what it says.
4. **`/offline` now recovers by itself.** An inline `<script>` in the page —
   inline because the page is served from cache on the assumption that the
   network is down, so a `"use client"` component's chunks may not be fetchable
   — probes `/icon-192.png?probe=<now>` and, if that answers, replaces the
   location. It **probes rather than trusting `navigator.onLine`**, which
   reports a link and not reachability. Once per launch, guarded in
   `sessionStorage`, so a genuinely dead network cannot bounce between two pages
   forever and put "Try again" out of reach.

Point 4 is not belt-and-braces. It covers two cases the worker fix cannot:
a phone already carrying the **old** worker, which will serve the stale offline
page one more time before the new one takes over; and **iOS pinning the icon to
whatever URL was on screen when you added it** — Add to Home Screen saves the
current address, not the manifest's `start_url`, so an icon created while that
screen was showing opens `/offline` forever, at full signal, and fixing the
worker never touches it.

**`__tests__/platform/service-worker.test.ts` drives `public/sw.js` itself**, in
a `node:vm` context holding a hand-built `ServiceWorkerGlobalScope`, with `fetch`
scripted per attempt. Loading the real file is the point: this defect shipped in
a file no test could reach — no exports, no importable module, a global scope
Node does not have — and a handler rewritten inside the test would have passed
against the version that was broken. Eight tests; the first one fails the old
worker.

**The general lesson, for whatever ships next:** every one of the four failure
paths in the AI layer degrades on a *decided* condition, and this was a
degradation on a **transient** one. Worth asking of any fallback added later:
what happens if the condition that triggered it was simply early?

**What this does not fix.** `min_machines_running = 1` is still a request rather
than a guarantee (see `fly.toml`), and a stopped machine still empties the
decision store. Item 6 below is unchanged.

### The hosted demo reaches production FabOrchestrator (2026-08-23)

**The QR code now opens a PWA whose FabInsight answers from the real product.**
`fly.toml` gained an `[env]` block —
`FABORCH_BASE_URL = "https://d7y8a8whrch88.cloudfront.net"` — and the app was
redeployed. That distribution is the end-user entry point
`docs/05-deployment-and-ci.md` names for FabOrchestrator, confirmed serving the
product (`GET /api/chat` returns FabOrchestrator 1.0/1.1/2.0).

**`[env]` rather than `flyctl secrets`**, because it is not a secret: it is a
public CloudFront hostname, and putting it in the repo means the deployed
configuration is readable here rather than only in the Fly dashboard.

**HTTPS is load-bearing, not a preference.** The EB origin behind that
distribution (`faborchestratorai-prod.eba-dk3f4zhh.us-west-2.elasticbeanstalk.com`)
answers on plain http and was rejected for that reason — pointing at it would
put FabOrchestrator passwords and session tokens in cleartext across the public
internet. CloudFront terminates TLS.

*(An earlier candidate, `faborchestratorai-dr-test.us-west-2.elasticbeanstalk.com`,
does not resolve — NXDOMAIN. EB hostnames in this account carry an `eba-…`
label, which that one lacks.)*

#### Thin-ice item 1 got worse, so half of it was paid down

The item has always said this app's auth "must not ship as is": one credential
pair, stateless tokens, **no rate limiting**. That was survivable while the worst
case was a stranger guessing a demo password and reading six mock orders.

**It stopped being survivable the moment `/api/auth/login` learned to forward to
a real FabOrchestrator.** On a public URL that is an unthrottled
credential-testing endpoint against a production identity store, with no
lockout, no alerting, and nothing in FO's audit trail distinguishing the
attempts from a person — because *this* server makes them.

`lib/rate-limit.ts` is the mitigation: eight failed guesses from one address
buys a ten-minute wait. Three properties are load-bearing and all three are
tested (`__tests__/platform/rate-limit.test.ts`, 10 tests):

- **Only failures count, and success clears the counter.** Somebody who knows
  their password is never throttled by their own logins.
- **The window expires.** A limiter that can lock a demo operator out
  permanently is worse than none the day it matters.
- **The address comes from `fly-client-ip` before `x-forwarded-for`.** The
  latter is caller-supplied; if it won, an attacker would rotate it per request
  and never be counted twice, which is no limiter at all.

**It is a mitigation, not a fix, and the entry should say so.** It is per-process
and per-IP: it stops a script against one address and does nothing about a
distributed attempt. The real answer is still the product's own authentication
with a user table and server-side sessions. Item 1 stands.

In-memory is coherent here for the reason `fly.toml` already documents —
`min_machines_running = 1`, `auto_stop_machines = false`, one long-lived
process. Unlike the decision log, losing this state on restart is *safe*: it
forgets failed attempts, failing open for a moment rather than locking anybody
out. So it gets a Map and no `durable` flag.

#### Verified end to end against production, before and after the deploy

Signed in through the PWA as a real FabOrchestrator account and asked the demo
question. **It answered with real MES data**: a Material Yield table across
twelve products, 846,951 units started, 763,782 remaining, 90.18% overall,
worst-performer analysis and a flagged data quirk (one product above 100% from
lot merges). Two minutes, streamed, rendered as a GFM table by `.fab-md`.

**Eight `data-keepalive` frames arrived across that turn** — 15 seconds apart,
exactly the case they exist for, and the reason the pass-through must not
buffer.

A follow-up — *"Which product should I look at first, and why?"* — came back in
38 seconds reasoning from the first turn's figures ("~70,000 of ~83,000 units"),
which is the proof that conversation history reaches FO and that
`conversationId` was correctly not needed.

The limiter was exercised against the running server: attempts 1–8 → 401,
attempt 9 → **429 with `Retry-After: 599`**, a second address unaffected, and a
correct credential still 200 on a fresh address.

#### Which FabOrchestrator account to demo with

Two production accounts were compared:

| | `athena.admin@llmatscale.ai` | `entegris@llmatscale.ai` |
|---|---|---|
| Role | Admin | **Business User** |
| Connected MCP servers | 4 (one with **0 tools**) | 2 (11 + 9 tools) |
| Answer to the demo prompt | identical | identical |

**Use the Business User.** It is the role the demo is *about* — FO's chat route
has a distinct non-admin path for role `allowedModels` and daily limits, so
demoing as an Admin risks showing a journey a real customer would not get. Its
tool surface is smaller and entirely populated, where the admin account carries
a `connected` server with zero tools that `activeMcpIds` dutifully includes and
that contributes nothing. And it is the lesser credential to have travelling in
a `.env` behind a public URL.

**⚠ Worth ten minutes from whoever owns those MCP connections:** both accounts
return *byte-identical* data, and the Entegris-scoped account answers with what
look like Lumentum part numbers. The benign reading is very likely right — the
connection is named `Entegris_DB_Test3` and these servers probably share one
demo fixture database. The other reading is that customer-scoped accounts are
not scoped. Not asserted, but not something to find out in front of a customer.

### FabInsight, and the front door becomes the product's cockpit (2026-08-23)

**The requirement, from the stakeholder:** a user should be able to reach the
**existing** FabOrchestrator/FabInsight system through this PWA. *"Give me the
yield for the last two days"* goes in here, the real FO application and its
agents answer it, and the answer is displayed here. **The PWA is a mediator, not
a second product.**

Four decisions were the stakeholder's, taken before any code was written,
because none of them could be settled from the repository:

| Question | Answer |
|---|---|
| Which FabOrchestrator? | The local `claudeai_athena` on `:3000`. `FABORCH_BASE_URL`, no default. |
| How does the PWA get an FO session? | **The operator signs in with their own FabOrchestrator credentials.** Not a service account. |
| The cockpit's hardcoded stats? | **Reproduce them.** Faithful replica including *1,284 queries today* and the Live ops panel. |
| The three agents this PWA cannot open? | **Show all four**, only FabInsight opens; production orders stays reachable below. |

#### What was found before building, and it decided the shape

FabInsight is **AGENT · 01 on the product's cockpit** —
`claudeai_athena/components/cockpit/agent-cards.tsx:32`, `route: "/chat"` — which
is `components/full-chat-app.tsx` (2,430 lines) posting to `/api/chat`. The
cockpit's own ask bar (`cockpit-ask.tsx`, 180 lines) is a thin client on the
identical endpoint, and that is the one this app follows.

```
POST {FO}/api/chat
  Authorization: Bearer <FO session token>
  { messages: UIMessage[], model, activeMcpIds, webSearch, enableReasoning }
  → an AI SDK UI-message stream (SSE), 15s keep-alive frames, X-Accel-Buffering: no
```

Three findings from that read are load-bearing:

1. **FO builds the model's context from the request body**, not from its
   database (`convertToModelMessages(uiMessages)`). So follow-up questions work
   by sending the whole conversation, with **no server state on either side**.
   `conversationId` exists, only adds FO-side persistence and S3 file refs, and
   is deliberately not sent.
2. **`activeMcpIds` decides whether the agent can look anything up.**
   `/api/chat` loads tools from that list and nothing else. The cockpit's ask bar
   hardcodes `[]`, so it answers *without tools* — the one thing on the cockpit
   this app does not copy, because a demo asking for yield needs them. The
   product's chat app is followed instead: `GET /api/mcp/connections`, enable
   every `status === "connected"` (`full-chat-app.tsx:722-746`).
3. **`/api/chat` sends no CORS headers**, so the browser cannot call FO directly
   from `:3002`. The proxy hop is not an architectural preference; it is the only
   way in. It pays for itself twice over — the FO token stays out of client
   JavaScript, and `activeMcpIds` is decided server-side rather than by whatever
   the page posts.

#### The integration is four files and no manufacturing logic

```
components/fab/screens/fabinsight.tsx   the conversation
app/api/faborch/chat/route.ts           auth → cookie → FO, streamed back untouched
lib/faborch/client.ts                   FO's HTTP contract, in one place
lib/faborch/stream.ts                   reading FO's reply
```

**There is no yield calculation, no MES query, no system prompt and no model
call in any of them**, and the rule for keeping it that way is in "What NOT to
build" at the bottom of this file: *could this change what the answer says?*

`lib/faborch/client.ts` is the whole blast radius if FO's contract moves. Every
endpoint in it carries the file and line it was read from.

#### Two credentials, and what a demo session deliberately cannot do

`app/api/auth/login/route.ts` tries the demo credential first (local, free, and
it is what this demo has always used), then FabOrchestrator's own
`/api/auth/login`. A demo-credential session opens the production order workflow
and **not** FabInsight, which says so and offers sign-in.

**The alternative was a service account in the environment** — one FO identity
for every visitor — and it was rejected. It would attribute every prompt in FO's
`prompt_audit_logs` to a machine rather than a person, and hand whoever holds
the demo URL somebody else's MES access. A demo is not a reason to build that.

**The FO token is an httpOnly cookie** (`lib/faborch/session.ts`), not a payload
in the localStorage session. This app's own token is a stateless HMAC in
localStorage and that is a considered trade for a credential that unlocks mock
data; a real session against a real FabOrchestrator, carrying somebody's role,
tools, quota and audit trail, is not the same object and does not get the same
treatment. It also cannot then leak into a screenshot, a log line or a
service-worker cache.

**One defect was found and fixed during verification.** `secure` was set from
`NODE_ENV === "production"` — and the README's own instruction is *"for a demo,
always use production mode"*, on `http://localhost:3002`. That marks the cookie
`Secure` on an origin that is not, which Chrome tolerates for localhost and
Safari has not always: sign-in succeeds, the cookie never arrives, and FabInsight
claims no FO session on every turn. It reads the request scheme now
(`x-forwarded-proto` first, because CloudFront and Fly both terminate TLS in
front of the container).

**A second defect, reported 2026-08-25: the "Sign in to FabOrchestrator" card was a
dead control.** `login-page.tsx` opened with *"An operator who is already signed in
should never see this form"* and `router.replace(next)` whenever
`llmatscale_auth_token` existed. That was right when there was one kind of session.
It became wrong the day FO sign-in arrived, because there are now **two** — and the
card is shown *only* to somebody holding a token and lacking an FO session. Its own
audience was precisely the audience the guard turned away: the form rendered for one
frame and vanished, and there was no route from a demo session to an FO session in
the UI at all. Both agent-screen cards route through `SignInCard`, which now links to
`/login?next=…&upgrade=1`; the guard skips itself on that flag, so the
expired-session path is fixed by the same line. Strict `=== "1"`, so a stray
`?upgrade=anything` does not disable the guard. The demo session is not cleared on
the way — `/api/auth/login` tries the demo pair, falls through to `foLogin`, and
attaches the FO cookie, which is what the card's "the production order workflow is
unaffected" promises.

Found by running the app rather than by reading it, which is the point: the guard,
the card and the login route are each defensible alone and only wrong in
combination. Nothing typechecks or tests differently — all 162 tests passed before
the fix as well.

#### The landing page is the cockpit now

`components/fab/screens/landing.tsx` reproduces
`claudeai_athena/components/cockpit/cockpit-page.tsx` — nav, hero, ask bar, *The
Nucleus*, Live ops, Recent activity — in that order, at the same measures. What
was there before (an identity block and a capability grid, argued over three
times between 2026-08-18 and 2026-08-23) is below it, under *In this PWA*.

Four deviations, each deliberate:

- **The nav pills are this app's sections, not the product's five labels.** All
  five of FO's pills call `router.push("/home")` — they lead nowhere there
  either — and four dead controls at the top of the front door is the failure
  `capabilities.test.ts` exists to prevent one section lower. The shape is the
  cockpit's; the labels are the four places this app can actually take you, so
  the front door and `app-shell.tsx` do not disagree about what this product is.
- **The green ALL AGENTS ONLINE pill is not reproduced.** `/` is statically
  prerendered and reads nothing, so it cannot know. The stats are quoted
  placeholders from a page that shows them regardless; a *status* pill is
  different in kind, because its whole content is a claim about right now.
- **The ask bar navigates rather than answering inline.** `/fabinsight?q=…`.
  The landing page must render for somebody with no session, and a follow-up
  question needs somewhere to live — the cockpit's inline answer is a dead end
  after one turn.
- **`--fs-display: 42px` is an eighth type step**, for the cockpit headline and
  nothing else. The seven-step rule is not relaxed: every *other* cockpit size
  (9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 23, 27) is mapped to the nearest existing
  step rather than imported, which is where that rule does its work. 42 against
  30 is a full tier apart and is copied from the product, not picked.

**`conversational-analysis` was removed from `PLATFORM_CAPABILITIES`.** That
entry *was* FabInsight, on a list whose contract is *none of these is
implemented here*. The test's own failure message said what to do — *"If one
becomes real, move it into the workflow section"* — and it is now AGENT · 01,
where the product puts it. Five capabilities remain and the no-href test is
untouched.

#### Verified, against a running FabOrchestrator

`claudeai_athena` was started on `:3000` against the local Postgres, and the
whole path exercised with the PWA built and served:

- sign-in with FO credentials → 200, `faborch: true`, `Set-Cookie … HttpOnly`
- sign-in with the demo credential → 200, `faborch: false`
- a wrong password → 401 *Incorrect email or password*, identical either way
- `/api/auth/me` → `faborch: true`
- the demo prompt → PWA → `GET /api/mcp/connections` **200** → `POST /api/chat`
  **200**, and FO's log shows it ran the whole turn: role check, model registry,
  context-window fitting, prompt caching, adaptive thinking, tool attachment
- every failure path: no FO session → `no_faborch_session` 401; no session at
  all → 401; empty `messages` → 400; **a token FO rejects →
  `faborch_session_expired` 401 with the cookie cleared**, confirmed against the
  real FO
- `FABORCH_BASE_URL` unset → FO credentials are simply a wrong password, the
  demo credential still works, and `/api/orders/PO-10382` still returns
  QUALITY_PROBLEM HIGH · MACHINE_DOWNTIME MEDIUM · PRODUCTION_DELAY MEDIUM
- `/` renders the cockpit, still `○` static, with **exactly five hrefs** —
  `/`, `/fabinsight` ×2, `/orders` ×2, `/decisions`, `/activity` — and no href
  on AGENT · 02–04

**⚠ The model never answered.** The local FabOrchestrator's `ANTHROPIC_API_KEY`
returns `401 API key is invalid` — the same dead key this file already records
against this app on 2026-08-21 — so FO's reply was two `error` frames and
`[DONE]`. **Everything up to the model call is proven against the real product;
the last hop is not.** The success path was proven separately, against a stub in
the scratchpad speaking FO's exact wire format: the route piped
`tool-input-start` → keep-alive → four `text-delta`s → `[DONE]` through
unmodified, and replaying that capture through `lib/faborch/stream.ts` in 7-byte
chunks — i.e. across every frame boundary — reconstructed the GFM table exactly.
That proves the plumbing and the parser. It does not prove a real answer, and
**replacing that key is what closes this.**

**The local FO account has zero MCP connections** (`/api/mcp/connections` → `[]`,
confirmed for `localtest@athenatec.local`). So even with a valid key, that
account's FabInsight has no tools and cannot look up a yield. That is an
environment fact rather than a code one, and the README says where to look.

#### Two things fixed on the way, neither of them the feature

**The ask bar is a plain GET form, not `useRouter`.** The first version was a
client component with a click handler, and it broke
`design-review/render.tsx` — that harness draws every screen through
`renderToStaticMarkup` with no Next router mounted, so it threw *"invariant
expected app router to be mounted"* and produced no landing export. Since that
harness is the only way any screen in this app has ever been looked at, breaking
it while rewriting the front door was the expensive kind of mistake.
`<form method="get" action="/fabinsight">` does the same job with no hook, and
`/` goes back to shipping no JavaScript of its own — which matters for a page a
stranger meets on a cold cache.

**`SignOutLink` was the same fault, and it pre-dates this work.** It has been on
the landing page since 2026-08-19 calling `useRouter`, so
`design-review/out/00-landing.html` has not regenerated for **any** version of
this screen since — including the three redesigns this file records arguing
about. It uses `window.location.assign("/login")` now, which is also the more
correct sign-out: a client-side replace keeps the React tree, and anything still
holding a decision list or a user object keeps holding it.

The landing export renders again, carrying the four agent cards, Live ops, and
the three chips as real `/fabinsight?q=…` links. `LoginPage` still throws on the
same hook and is left alone — a different screen, and not this change's to fix.

**Nobody has looked at any of this either.** Thin-ice item 3 is unchanged and
`/fabinsight` and the cockpit landing page are now the newest things on it.

### The front door is the platform's, not this workflow's (2026-08-21)

> ⚠ **The indigo workflow card was removed on 2026-08-23.** The reviewer's
> reasoning, and it is the right one: *this is the landing page for the whole
> of FabOrchestrator, so a full-width accented banner for one workflow does not
> belong on it* — distracting, and the same scope error this entry was written
> to fix, in a smaller costume. Gone with it: the "Start here" eyebrow, the
> `PO-10382` evidence strip, the severity pills and *Enter workflow*.
>
> **`/` now has no link on it at all**, so nothing reaches the production order
> workflow from the front door. That is a known gap, not the design: the target
> audited the same day puts *Review and Approve Production Orders* back as one
> clickable card in a grid, accented with a 2px border rather than a gradient,
> beside `/decisions` and `/activity`, under a "What would you like to do?"
> line and a persistent top bar. **Do not leave the screen here.**
>
> An earlier attempt the same day removed the platform section as well and was
> rolled back — the instruction was the card only. `lib/featured-order.ts` and
> its four tests are untouched and now unimported; kept because the target may
> want the derived "orders awaiting review" count. Everything below describes
> the screen as it was before this removal.

**The complaint, and it is about scope rather than about the screen.** `/` was
headed **Production Order Assistant**, so this demo looked like the whole of
FabOrchestrator. It is one workflow inside a platform that also does
conversational analysis over live operational data, master-data loading into
the MES, generated dashboards, roles and quotas, cost accounting and a platform
audit trail. A visitor who met this app first would have concluded none of that
existed.

`/` now opens on **FabOrchestrator**, says what the platform does, and offers
the production order workflow as its one primary action. The requested shape was
a public-service homepage — the major functions on the surface, and you pick one.

**What did not change: the workflow behind the door.** `/orders`,
`/orders/[orderId]`, `/decisions` and `/activity`, the rules, the AI layer, the
grounding check, the decision store and the scanner are untouched. The whole
change is the front door, the mark's destination, and three strings that named a
workflow where they should have named the product.

#### What survived from the 2026-08-20 design

`design-review/LANDING-BRIEF.md` and Direction 1a still hold, because their
findings were never about the Production Order Assistant in particular:

- **Task labels, never audience labels.** NN/G's finding, and the brief's
  reframing that the segmentation which matters is arrival context rather than
  job title. Every heading and card title on the page names a task.
- **The strongest proof a demo has is the product working on real data.** The
  primary card still carries `PO-10382`, its product, machine and status, and
  the problems the rules actually found on it worst-first — still from
  `lib/featured-order.ts`, still the same adapter and the same rules the order
  screen runs, still nothing typed in.
- **One primary action.** Taken further than the brief did: the two quieter
  doors and the "Production order workflow" heading that grouped them with the
  card were removed at the reviewer's request the same day, on sight of the
  running page. **`/` now has exactly one link on it.** Nothing is lost —
  `/decisions` and `/activity` are nav pills on every screen behind the door.
  The six platform capabilities are not links at all.

#### The featured order stopped being the destination and became the evidence

The card used to link to `/orders/PO-10382`. It links to **`/orders`** now,
because the journey it opens is *workflow → search/review → analysis →
decision*, and `/orders` is that first step. The order is still on the card —
as a strip of facts inside it, not a second link. Two reasons, and the first is
absolute: **a link inside a link is invalid markup**, so the strip could not
have been a link without splitting the card into two controls, which is the
competing-CTA failure the brief names as the most common way a landing page
fails.

What it costs: one extra click to reach `PO-10382`, which is the first row a
search for it returns and is flagged in the list either way.

#### The capability cards are not a feature grid, and the distinction is the same one as last time

CLAUDE.md forbids a feature grid on this page. That prohibition is about
**invented content** — metric tiles, "trusted by", statistics resolving to no
MES record. These six cards name capabilities of the shipped product and each
one carries, in `lib/capabilities.ts`, the document it was read from: five cite
`FabOrchestrator_product_code/docs/08-customer-safe-overview.md` §2 (its "Core
capabilities" table, already written for an audience outside the engineering
team and therefore already at the right altitude), and the sixth cites the
routes that implement it. A capability that traces to nothing would be the
forbidden thing; adding one is how this file goes wrong.

**None of them is implemented here, and the page says so three ways** — the
heading ("Also in the FabOrchestrator platform"), a line under it that says they
are not part of this demo and not reachable from here, and the cards themselves,
which carry no href, no `fab-card-link` hover lift, no arrow, and a neutral icon
tile rather than the indigo the real doors use. `__tests__/platform/capabilities.test.ts`
pins the no-href property, because the change that would break it is an obvious
and well-meant one: making the cards "clickable for the demo". A card that looks
like a door and opens onto nothing is a hard-coded severity wearing a different
costume.

#### The mark in the top nav now goes to `/`, reversing 2026-08-18

`app-shell.tsx` pointed the brand lockup at `/orders`, on the reasoning that
inside the app the mark is a "home" affordance and home for somebody signed in
is their work, not the front door they came through. **That was right while `/`
was this workflow's own lobby** — the mark would have led you out of a workflow
and back to a page about it.

`/` is the product's front door now, so the mark leads to the product. That is
both the universal convention and the only obvious way from the order screens to
the rest of what FabOrchestrator does, which the brief for this change asked for
explicitly. It carries `aria-label="FabOrchestrator home"`, because the lockup's
visible text is a wordmark and does not say where the link goes.

#### The 560px column widened, and what that rule was protecting is intact

"Desktop is the phone screen" (2026-08-20) says `/` renders **one layout at every
width — the 560px column, centred** — because *"the desktop app looks like the
phone app"*. That rule was written for a front door with three doors on it. This
page has a workflow section and six capability cards, and the same reviewer has
since asked that it "look good when demonstrated on a large screen"; a 560px
column would run nine cards down a 1920px screen as a ribbon of whitespace.

The column is now `--page-width` (1180px — the product's own cockpit measure,
which is where every other screen here already sits). **The content, its order
and its components are identical at every width.** The only responsive change is
that grids of identical cards reflow 1 → 2 → 3 columns. There is no second
arrangement, no desktop-only element, and no `lg` variant of any card — which is
what the earlier rule was actually protecting, and is why the reverted
`lg:grid-cols-[1fr_1.1fr]` brand-panel experiment is still the wrong answer. A
phone gets the same page, in one column, in the same order.

The vertical centring went with it: a page this tall centred on a short viewport
pushes its own heading off the top.

#### Everything else it touched

- `app/layout.tsx` and `public/manifest.webmanifest` name **the platform** in
  their title and description instead of "Production Orders". **`id` was not
  touched** — it is still `/orders`, and it is the field that carries app
  identity, so changing it orphans every installed copy. `start_url` stays `/`.
- `app/page.tsx`'s own metadata title is now `FabOrchestrator`. `/orders` still
  titles itself "Production orders — FabOrchestrator"; this is the fallback for
  the pages that are not about orders.
- README's demo path step 1 was rewritten. It still said **Click here to get
  started**, a string that has not existed since 2026-08-19.

#### Verified

`/` still prerenders as **static** (`○ /` in the build output) — the doors are
`<Link>`s and the capability cards are plain markup, so the screen still renders
for somebody who has never signed in, on a cold cache, before any bundle
arrives. Build, types and lint clean; **142 tests** pass, up from 139.

The whole journey was exercised against the running dev server: sign-in →
`/api/orders/search` (6 orders) → `PO-10382` with its three issues at the
severities `rules-config.ts` assigns → analysis → decision → `/api/decisions`
and `/api/activity` both carrying it with the recommendation it answered. The
server log is clean across every route. The rendered `/` was read back and
carries `PO-10382`, `Widget A · Machine ASM-04 · In progress`, the three
severity pills worst-first, **exactly one link (`/orders`)** and six `<li>`
capability cards with no href among them.

**The Anthropic key in `.env` is returning `401 authentication_error`**, so the
analysis came from the cached fallback (`source: "cached"`,
`degraded.reason: "api_error"`), grounding-checked at 14 citations. That is the
documented degrade path working exactly as designed, and it is an environment
problem rather than a code one — but the live Explain call cannot be
demonstrated until the key is replaced.

**Nobody has looked at this screen.** `list_connected_browsers` returned empty
again on 2026-08-21 — the seventh date. `design-review/out/00-landing.html` was
regenerated against a fresh build (per the harness's own trap: it reads its
stylesheet from the last `npm run build`, so a rebuild has to come first) and
the reflow utilities `grid-cols-1/2/3` were confirmed present in the compiled
CSS. That proves the markup, the data path and the stylesheet — never what a
human sees. Thin-ice item 3 is unchanged and this screen is now the newest thing
on it.

### The workflow crossed a route boundary and dropped the order (2026-08-20)

**Reported as a skipped step, and it was one.** The new front door deep-links to
`/orders/PO-10382`, you read the problems, the analysis and the MES records —
and then the workflow stops. The order screen has recorded nothing since
2026-08-19, when decisions were consolidated onto the review panel at the top of
`/orders`, and **nothing on it led there**. Evidence with no way to a decision.

**The sharper half, found while confirming it.** `app/orders/[orderId]/page.tsx`
had a back link doing `router.push("/orders")` with nothing carried. The panel's
selection is component state, and `ReviewPanel` falls back to `orders[0]` when
the selection is not in the list. The default sort is `dueAt` ascending, so
`orders[0]` is **`PO-10344`** — completed, and carrying no detected issues at
all. So you could read `PO-10382`'s evidence, leave, and be pointed at a
different order. That is the outcome `review-panel.tsx` names in its own comment
as the worst one it has — *a decision posted against a stale selection* —
reached not by a filter or a race but by using the app as the landing page
invites you to.

**The dead end pre-dates the landing change**; it arrived when the decision
section was removed. What the featured-order card did was promote it from an
edge case to the first thing a new visitor does.

**What was deliberately not done: putting the buttons back.** That fixes it in
one edit and undoes a decision taken the day before, for a stated reason — *"one
surface cannot disagree with itself."* That section has moved four times. The
fix had to keep exactly one place that writes a decision.

**So the order travels instead.**

1. `/orders` accepts `?order=PO-10382` and seeds the panel's selection from it.
2. The order screen gained **Record a decision**, opposite the back link, which
   goes to `/orders?order=<this order>`. It is a **link, not a control** — it
   records nothing, so there is still one decision surface, and F-03's objection
   that a decision must not be offered before the evidence is untouched, because
   pressing it decides nothing.
3. The back link carries the order too. Leaving a screen should not silently
   change which order the app is pointed at.

**`app/orders/page.tsx` is now a thin server component** that reads
`searchParams` and hands `initialOrder` down to `orders-client.tsx`. That is the
pattern `/login` established for `?next=`: `useSearchParams` would force the
screen into a Suspense boundary, which is the build risk thin-ice item 2 records
as the reason URL state was skipped at Tier 0. **Item 2 is now answered on both
pages that needed it, by the same move, still without the hook** — though the
filters and the search on `/orders` are still component state, so the item
stands.

**It costs `/orders` its static render** — `ƒ` rather than `○` in the build
output. Close to free: the screen fetches everything client-side with the
session's bearer token, so its prerendered HTML was only ever `PageSkeleton`.
Nothing that rendered without JavaScript stopped rendering.

**`lib/selected-order.ts` validates the parameter** the way `safeReturnPath`
validates `next`, reusing `OrderNumberSchema` rather than re-expressing it — a
value this page would select but the decision route would reject is one that
fails late instead of early. Anything else resolves to `""`, which is exactly
what the page held before the parameter existed, so a bad value degrades to the
old default rather than to an error. It also uppercases, because `getOrder` is
case-insensitive and `?order=po-10382` would otherwise select nothing while
looking like a fixture typo.

**Verified against a running server**, not just typechecked: `?order=PO-10382`,
`po-10382` and `  Po-10382  ` all reach the client as `PO-10382`; `WO-999`,
`PO-10382x`, `../../etc/passwd` and `<script>` all reach it as `""`; a repeated
key takes the first. `__tests__/platform/selected-order.test.ts` is 7 tests;
`npm run test:platform` is 40 and the suite is 139.

**What is still unverified: the button itself.** It lives in the page rather
than in `OrderDetailScreen`, so `design-review/render.tsx` does not render it
and neither does `curl` — the page serves `PageSkeleton` until the session
resolves. Types, lint and the build pass and the href logic is tested through
`safeSelectedOrder`, but nobody has pressed it. See thin-ice item 3, again.

### The front door opens on a problem (2026-08-20)

> ⚠ **Superseded in scope on 2026-08-21** — see "The front door is the
> platform's, not this workflow's" above. `/` is now FabOrchestrator's landing
> page rather than this workflow's, the featured card links to `/orders`
> instead of to `/orders/PO-10382`, and the column is 1180px. **Everything
> below about *why* the card is derived rather than typed in still holds** and
> is still the reason `lib/featured-order.ts` exists.

**The landing page was designed properly this time, and the process is half the
point.** Jothi's note — *there are several different reasons somebody might
visit, cater to all of them* — was researched, written up as
`design-review/LANDING-BRIEF.md`, taken into **Claude Design** as four
directions, and one was chosen. That is the plan's "design review gate before
implementation", which the divergence table at the top of this file records as
**the one process requirement skipped outright**. It is no longer skipped for
this screen. The brief is self-contained and is the thing to hand anybody who
redesigns `/` next.

**The research finding that shaped it, and it cuts against the obvious
reading.** The intuitive way to serve several kinds of visitor is an audience
switcher — *I am a supervisor / a manager / an auditor*. NN/G gives five reasons
that fails and four apply here: people cannot quickly self-identify (a shift
lead who signs off overrides is two of those three), users arrive
task-oriented rather than identity-oriented, the categories breed information
anxiety, and here they would overlap almost entirely because `lib/auth.ts` has
one credential and no roles. Their recommendation is tasks over audiences —
which the three doors already did. **The doors were right; what was missing was
proof.**

The brief's own reframing: the segmentation that matters is **arrival context,
not job title**, and the dominant visitors today are a stranger who was sent a
QR code and the person opening it to demo it. The supervisor is hypothetical.

**Direction 1a shipped: the primary door stopped being a category and became an
order.** `PO-10382`, its product and machine, the three problems the rules found
on it worst-first, and *Review this order*. The other two doors are compact —
title and chevron, no supporting line — so there is one clear primary action
rather than three competing ones.

**Nothing on it is typed in.** `lib/featured-order.ts` runs the same adapter and
the same rules the order screen runs; the card renders what comes back. A
hard-coded `QUALITY HIGH` would be a claim about a factory frozen at the moment
somebody typed it — and **this app has already proved it would go stale**: the
2026-08-12 delay-rule fix took `PO-10344` from a HIGH problem to no issues at
all, and a written-down card would still be announcing the old severity from the
front door while every screen behind it disagreed.

**It is still static.** `app/page.tsx` is `async` now and `/` still prerenders
(`○ /` in the build output): `MockMESAdapter` is a JSON import, `detectIssues`
is arithmetic, and neither touches `cookies()`, `headers()` or `searchParams`,
so it resolves at build time. Tier 4's real adapter turns this into a
request-time read and ends the static render — correct then, not now.

**It degrades to the door that was there before.** No order, or an order the
rules find nothing wrong with, returns null and the plain gradient *Review
production orders* door renders instead. A card headed "3 problems detected"
with no problems to name is the failure this file keeps describing in other
costumes, and an exception assistant should not open on a clean order.

**Identity moved onto the page surface.** The mark, the title and the sentence
were in a white card with the login page's lift; they are not any more. This is
F-08 applied to the front door for F-08's own reason — when every section is a
white box, identity competes with the problem for the eye and wins by being
first and largest. The only lifted surfaces are the ways in. `BrandLockup` drops
from `hero` to `panel`, so the h1 is now the largest type on the page, which is
the right hierarchy for a screen whose subject is an order rather than a logo.

**`Pill` gained one prop, `surface="white"`.** The featured card is an indigo
gradient and a pale amber tint on indigo is neither readable nor recognisably a
status. It swaps the ground and changes nothing else — same ink token, same dot
hue, so F-02's floor still holds (`--status-red-ink` is 6.9:1 on white,
`--status-amber-ink` 5.4:1). A prop rather than a second component, because
duplicating the markup would duplicate the dot-and-word structure that "status
is never carried by colour alone" depends on.

**`__tests__/platform/featured-order.test.ts`** — 4 tests. `npm run
test:platform` is 33, the suite is 132. The one that matters is *shows nothing
rather than a clean order*: the derived card is only safe if it has somewhere
honest to land, and that is the branch nobody would notice breaking.

**Nobody has looked at this screen either.** `list_connected_browsers` returned
empty again on 2026-08-20 — the sixth date — so Claude Design's own verify loop
could not run and the four directions were never rendered to a screenshot
either. Build, types, lint, 132 tests and `design-review/out/00-landing.html`
all pass, and the export was read back to confirm the card carries `PO-10382`,
`Widget A · Machine ASM-04 · In progress`, the three severity pills in
worst-first order and an href to `/orders/PO-10382`. That proves the data path
and the markup, never what a human sees. Thin-ice item 3 is unchanged and this
screen is still the newest thing on it.

**Still open from the brief**, and all of it is the reviewer's call: the desktop
layout at 1180px was deliberately not designed until a direction was picked; the
other three directions (`1b` the four-step chain, `1c` a page that branches on
session, `1d` search-and-scan on the front door) are recorded in the Claude
Design project and are mixable with this one; and the shop-floor guidance of
**60px touch targets for a gloved hand** against this app's 44px is flagged and
untouched, because it is a decision about the whole app rather than one screen.

#### Desktop is the phone screen, and that is the requirement (2026-08-20)

> ⚠ **Relaxed on 2026-08-21, deliberately and narrowly.** `/` is now the
> platform's front door with nine cards on it and was asked to "look good when
> demonstrated on a large screen", so the column is `--page-width` and grids of
> identical cards reflow 1 → 2 → 3 columns. **What this entry was protecting is
> intact**: same content, same order, same components at every width, no
> desktop-only element, and the brand-panel split below is still the wrong
> answer. See the 2026-08-21 entry above.

**`/` renders one layout at every width: the 560px column, centred.** No `lg`
rule, no second arrangement. The requirement, in the reviewer's words, is that
*"the desktop app looks like the phone app"* — so anything that makes the two
diverge is the defect, not the fix.

**This reverses a change made the same day and it is worth recording why.** Asked
to "make sure that the desktop also looks the same", the change built was
`lg:grid-cols-[1fr_1.1fr]` with `/login`'s navy brand panel — reading "the same"
as *the same as the other entry screen*. It meant **the same as the phone**, and
the panel is the one thing on the desktop layout that the phone has never shown.
The commit is `6501378` and its revert is the commit after it, if the diff is
ever worth reading.

The argument that produced it is not wrong on its own terms — `/` and `/login`
still shape differently above 1024px, and somebody will notice that eventually.
But it is a smaller problem than the front door not matching itself across
devices, and it is not the one that was asked about. If it is ever taken up
again, the answer is to bring `/login` down to the column, not to push `/` up to
the panel.

`components/fab/brand-panel.tsx` went with it: extracted so two screens could
share the panel, and with one caller again it was inlined back into
`login-page.tsx`, which renders exactly what it always did.

**One lesson from the detour is worth keeping, because it cost real time.**
`design-review/render.tsx` reads its stylesheet from `.next/static/chunks` —
that is, from the **last `npm run build`**, not from the source it is rendering.
So an export taken after adding a new Tailwind utility produces correct markup
against a stylesheet that has no such rule, and `grep` reports the class as
missing. It looks exactly like Tailwind having failed to generate a utility,
which would be a real bug. **Rebuild before re-rendering the harness**, or the
export silently reviews the previous build's CSS against the current build's
HTML.

### The order screen stops asking for a decision (2026-08-19)

**Removed: the "Your decision" section on order detail** — the heading, the note
field, the buttons and the history. The order screen now reads order → detected
problems → AI analysis → MES records, and nothing on it records anything.

**Decisions are taken in one place: the review panel at the top of `/orders`.**
Asked for after several rounds of moving the same section around, and it is the
right end state rather than a retreat: there were two decision surfaces, they
looked different, and which one you met depended on how you had navigated. One
surface cannot disagree with itself.

**This supersedes almost everything below about where the decision sits.** The
dock under the order header, the withdrawal of F-11's action bar, F-03's reading
order — all of them were arguments about the placement of a section that no
longer exists. Those entries stay because they explain how the screen got here,
but do not read them as describing the app.

Gone with it: `DecisionSection` and `DecisionCard` in `analysis-panel.tsx`, the
`decision` slot on `OrderDetailScreen`, `.fab-decision-dock`, the `decide`
handler and the decision-history fetch on the order page, and the `DECISIONS`
table with the two helpers only that card used. `.fab-review-panel` keeps the
sticky rule they shared.

**`POST /api/orders/[orderId]/decision` is untouched** and still the single
write path — the review panel posts to it, and so does an override from
`/decisions`. Removing a screen's UI is not the same as removing its route, and
the route is what the audit trail runs through.

**What this costs, and it is worth stating.** Opening an order no longer shows
what was decided on it. Approve `PO-10382` from the panel, open it, and there is
no sign anything happened — the record lives on `/decisions` and `/activity`
instead. That is a real loss for a screen whose whole argument is that evidence
and conclusion belong side by side. **If it turns out to matter, the fix is a
read-only line under the order header** — "Approved by … at …", no controls —
which is much smaller than the section that was removed, and would not
reintroduce a second place to decide.

### The decision buttons come off the bottom bar (2026-08-19)

**⚠ Superseded the same day — the section this describes was removed
entirely. See "The order screen stops asking for a decision" above.**

Asked for directly: the approve / reject / escalate section should be at the top
of an order, including when you have opened one for more detail.

**It already was — and on a phone it had no buttons.** The section docked under
the order header, but F-11 hid the in-card button row on coarse pointers and put
the controls in a fixed bar at the bottom of the screen instead. So the thing at
the top of the order was a heading, a note field and nothing to press, and the
controls were somewhere else entirely. That is the second time this bar has cost
more than it bought.

**F-11 is withdrawn.** The bar and its spacer are gone from `analysis-panel.tsx`
and from `app/globals.css`, and the in-card row now renders at every width. The
invariant F-11 established survives intact — **exactly one set of decision
controls at any width** — it is simply the in-card set now rather than the
fixed one.

What F-11 bought was thumb reach: the controls one tap away at the bottom of a
phone, instead of four screenfuls up. That is a real loss and it is being
accepted deliberately. Reach is worth nothing to somebody who cannot find the
buttons, and "where are the approve buttons" has now been raised more often than
"the approve buttons are too far away".

**The dock is gated on width alone now.** It required `hover: hover` and
`pointer: fine` because a touch device got the bottom bar and a docked card
would have been a card whose buttons were elsewhere. With the buttons in the
card, a landscape tablet should dock exactly like a laptop. Phones stay
unpinned — the panel is already the first thing on the page there, and pinning a
card with a field and three buttons would cost a third of the viewport for the
whole scroll.

**`--shell-h` is a token now** (`app/faborch-theme.css`), because the sticky
offset is the shell header's exact height and that height differs by device: the
44px touch minimum grows the nav's control row from 34px, so the header is 55px
with a mouse and 65px under a coarse pointer. It was a literal `55px` while the
dock was mouse-only. Widening the query made the number wrong for half the
devices it now covers, which is exactly the kind of thing a hard-coded
measurement hides.

### Tier 3: the decision log persists (2026-08-19)

`lib/decisions.ts` was a module-level `Map` — item 6 on the thin-ice list, and
the constraint that shaped every hosting decision this project ever made. It
ruled out Vercel, forced `--ha=false`, and turned "must not sleep" into a
hosting requirement. It also cost real data: **every one of the eight deploys on
2026-08-18 emptied the log.**

It is now `lib/decisions/`, shaped exactly like `lib/mes/`: a contract in
`types.ts`, one file per backing store, and an `index.ts` that is the only place
which picks. Nothing above that line changed shape — the routes call the same
five functions and read the same `DECISIONS_ARE_DURABLE`.

**`DATABASE_URL` set → Postgres, `durable: true`. Unset → the Map, which says
so.** No third setting, and no way to ask for the Map when a database is
configured: a deployment that has a database and is quietly not using it is the
failure this tier exists to end. **It does not fall back on a connection
error** either — if Postgres is configured and unreachable the routes fail
loudly, because falling back would mean reporting `durable: true` while writing
to something that forgets, which is precisely the dishonesty the flag was added
to prevent.

**The store contract is async, including in memory.** A synchronous contract
would have been comfortable for the Map and impossible for a database, and the
point of writing a contract at Tier 3 is that Tier 3's second implementation
has to fit it. Every call site gained an `await`; the routes were already async.

**SQLite lost, and the plan said to check it first.** It needs a persistent
disk, which means a host with volumes — the same shape of constraint the Map
imposed, just further along. Postgres is what the product uses, and a free
managed instance (Neon, Supabase) works on any host including serverless. So the
check happened and the answer was no.

**`pg`, not Prisma — a reversal worth recording.** The recommendation given to
the reviewer was Prisma, on "reuse before adding" grounds: the product runs
Prisma 7 + PostgreSQL. Installing it changed the answer. **Prisma 7 dropped
`url` from the datasource block and requires a driver adapter** —
`@prisma/adapter-pg`, over `pg`. So `pg` is the driver either way, and Prisma
would sit on top as a query builder and migration tool, in exchange for a
generated client, a `prisma.config.ts`, an engine download and a `prisma
generate` step in the Dockerfile. This file already records what a build step
that silently does not run costs: a host skipping lifecycle scripts ships a dead
scanner. A second one of those, holding the audit trail, is a bad trade for one
append-only table with nine columns and five queries.

What that costs: no migration history and no generated types. The table is
created by `CREATE TABLE IF NOT EXISTS` on first use and rows are mapped by
hand. Revisit the moment a second table appears — at which point the product's
Prisma is the right destination anyway.

**Insert-only by construction.** There is no UPDATE and no DELETE anywhere in
`postgres-store.ts`. An override is a new row carrying `supersedes_id`. The
property is expressed as an absence, which is stronger than a comment promising
it.

**The display id is derived, not stored.** `DEC-0007` is `seq` rendered, and
`decisionSeq` parses it back, so the name on screen and the ordering can never
disagree about which decision came first. `decisionId`/`decisionSeq` and
`groupByOrder` are shared by both stores and tested directly — they are exactly
where two implementations could silently diverge about which decision is
standing. `npm run test:decisions` is 28 tests, up from 21.

**⚠ The Postgres store has never run against a database.** Docker's daemon was
not running on the machine this was written on, and the Fly trial had ended, so
there was nowhere to point it. Everything above is verified against the memory
store: record, override, the 409 on a stale `supersedesId`, the activity feed,
the grouping, and `durable: false` reported correctly. The SQL is
straightforward and the mapping is tested through `groupByOrder`, but **first
contact with a real Postgres is still ahead** and belongs on the thin-ice list
until it happens.

### A sign-out link on the landing page (2026-08-19)

The small version of what the reverted merge was reaching for. `/login` is a
screen you meet once and then never again, because the session persists — so the
landing page carries a way back to it.

`components/fab/sign-out-link.tsx`, below the card beside the *Demo environment*
line rather than inside it: the card has one primary control and this is not it.

- **It renders nothing without a session.** Offering "Sign out" to somebody who
  is not signed in is nonsense, and the landing page is the one screen a
  signed-out visitor is expected to be on. The token is read in an effect, not
  during render, for the hydration reason `useSession` already documents.
- **It does not use `useSession`.** That hook redirects to `/login` when there is
  no token — correct for a screen behind auth, and it would make the landing page
  unreachable for exactly the visitors it exists for. This reads the one key it
  needs.
- **It goes to `/login` afterwards, not back to `/`.** The reason anybody presses
  it is to reach sign-in; returning them to the landing page would leave them to
  find it through `/orders` and a redirect.
- `/` still prerenders as static — the client component is a leaf, and the
  server HTML carries the environment line and no link, which is the correct
  output for a request that cannot know whether there is a session.

**It does not appear in `design-review/out/00-landing.html`**, and that is not a
bug in the export: a static render has no localStorage, so the component
correctly renders nothing.

### The front door merge, tried and reverted (2026-08-19)

For a few hours `/` was **one card with two states** — sign-in that turned into
the landing page in place, with `/login` reduced to a redirect. It was built
after the login page was reported missing, on the reasoning that two routes meant
whichever door you were not standing at looked absent.

**Reverted at the reviewer's request on sight.** The arrangement below is what
ships: the landing page at `/`, sign-in at `/login`. Recorded rather than erased
because the problem it was answering is still real and will be raised again — a
session persists, so `/login` is a screen you meet once and then never again, and
somebody looking for it will conclude it has gone. Whatever answers that next
should not be this.

Everything the merge dragged along came back with it: `login-page.tsx` owns the
navy panel and the layout again, `landing.tsx` is a page rather than a card body,
and `use-session.ts` and the log-out button name `/login`. The commit is
`0b2eefa` and its revert is the commit after `437c94a`, if the diff is ever worth
reading.

### The front door has three doors (2026-08-19)

> ⚠ **Gone as of 2026-08-21.** The three doors became one — the workflow card
> "Review and Approve Production Orders", pointing at `/orders`. `/decisions`
> and `/activity` are no longer on the front door at all; they are nav pills on
> every screen behind it, which is where somebody looking for a decision or an
> audit row already is. The reasoning below about controls-not-content still
> holds and is why the capability cards are drawn as content instead.

Jothi's point, relayed: the PWA demo needs a landing page **because there are
several different ways somebody might use this app**, and it should cater to
them. The landing page existed; it had one handle.

`/` now offers three, as cards on the page surface under the identity card:

| Door | Goes to | For |
|---|---|---|
| **Review production orders** (primary, gradient, "Start here") | `/orders` | the supervisor chasing a live problem |
| **Check what stands on an order** | `/decisions` | somebody revisiting a decision taken an hour ago |
| **Read the audit trail** | `/activity` | whoever is auditing what was decided and why |

**Same destinations, same icons, same order as `NAV` in `app-shell.tsx`.** The
front door and the nav must not disagree about what this app is, and matching
the icon is what lets somebody who came in through the second door recognise the
pill that takes them back to it. The titles are task-shaped rather than
section-shaped — "Read the audit trail" is what you came for, "Activity" is
where it is filed.

**This is not the feature grid the entry below forbids, and the distinction is
worth stating because they look alike.** That prohibition is about *invented
content*: metric tiles, "trusted by", statistics resolving to no MES record.
These are **controls** — each is a link to a section that exists, carrying one
line of what you would do there. Nothing on the screen asserts a fact about the
factory.

**What it costs: the literal string "Click here to get started" is gone.** That
was the reviewer's own wording on 2026-08-18, so if it is missed, this is where
it went — the primary door carries a `Start here` eyebrow and the gradient, and
is the same link to `/orders` it always was.

**The doors are cards on the page surface, not rows inside the identity card.**
A white row on a white card has to draw its own edge to exist, and hairline
boxes are the exact drift the Visual rules warn about. White surfaces with a
soft shadow and `.fab-card-link`'s 1px hover lift is the shape the cockpit
already ships.

**Every value on it already existed.** The gradient and `--shadow-brand` are the
old CTA's; the icon tiles are `--brand-indigo-bg` at `--r-control`; the cards
are `.fab-card`. All type is on the seven-step scale (10 eyebrow / 12 line / 16
title / 26 h1). The primary door's text is **pure white throughout** rather than
a tinted white — 5.4:1 on `--brand-indigo`, with hierarchy carried by size and
case. A 10px eyebrow at 85% white would have read as hierarchy while failing AA,
which is the trade this app refuses everywhere else.

**`/` still prerenders as static** (`○ /` in the build output). The doors are
`<Link>`s, not client components, so the screen still ships no JavaScript of its
own and still renders for somebody who has never signed in, on a cold cache.

#### Sign-in now returns you to the door you pressed

**The change that made the other two doors honest.** `useSession` bounces an
unauthenticated visitor to `/login`, and sign-in **always** landed on `/orders`
— from wherever it had caught you. With one door pointing at `/orders` that was
invisible. With three, "Read the audit trail" would have deposited you on the
order list, which is the front door making a promise it does not keep.

`lib/return-path.ts` is the whole of it. `loginHref()` builds
`/login?next=<here>` from `window.location`; `app/login/page.tsx` reads `next`
**on the server** and passes a validated value down as a prop.

- **`useSearchParams` is deliberately not used.** That hook forces the caller
  into a Suspense boundary — thin-ice item 2's own reason for skipping URL state
  at Tier 0. The login route is already `force-dynamic`, so reading the query
  server-side costs nothing it was not already paying, and `loginHref` reads
  `window.location` from inside an effect that only ever runs in the browser.
  Item 2 is otherwise untouched: filters and search are still component state.
- **`safeReturnPath` exists because a redirect target taken from the URL is the
  textbook open redirect.** Anyone can post `…/login?next=https://evil.example`,
  and it would be the *sign-in screen* — the one page a stranger is expected to
  trust with a password — that forwards them. On a permanently public
  deployment (see "Hosted deployment") that link is postable to anyone. The rule
  is narrow: one leading slash, no scheme, no backslash (browsers normalise it
  to `/`, so `/\evil.example` is `//evil.example`), no control characters
  (a literal newline in `/<LF>/evil.example` is stripped, making it
  protocol-relative by the time it is resolved), and
  never `/login` itself, which is a loop rather than a destination. **Everything
  rejected falls back to `/orders`** — the behaviour that shipped before — so a
  bad value degrades to the old default rather than to an error.
- Verified against the running server: `?next=https://evil.example` reaches the
  client component as `next: "/orders"`. The hostile string still appears in the
  page's flight payload, because Next echoes the current URL in its router
  state; that is the address bar, not a navigation target.
- `__tests__/platform/return-path.test.ts` — 11 tests, most of them strings
  that look like paths and are not. `npm run test:platform` is 29, up from 18;
  the whole suite is 128.

**Logging out still goes to a bare `/login`.** The shell's log-out button and
the landing page's sign-out link do not carry a `next`: pressing sign out is not
a request to come back where you were.

**Nobody has looked at this screen either.** `list_connected_browsers` returned
empty again on 2026-08-19 — the fifth date. Build, types, lint, 128 tests and
`design-review/out/00-landing.html` all pass, and the export was read back to
confirm the three doors render in order with the right hrefs. That proves the
markup, never what a human sees. Thin-ice item 3 is unchanged and this screen is
still the newest thing on it.

### The landing page (2026-08-18)

`/` is now a landing page: the brand lockup, **Production Order Assistant**, one
sentence, and **Click here to get started**. Sign-in moved to `/login`.

**The two cannot share a route.** `useSession` bounces an unauthenticated
visitor to sign-in, so with the landing page at `/` and the form also at `/`,
the CTA would go `/orders` → `/` → `/orders` and spin. Everything that
sends a user to sign in now names `/login`: `use-session.ts` in two places
(no token, and a 401 from `/api/auth/me`) and the shell's log-out button.

**`start_url` moved to `/` on 2026-08-18, and `id` did not.** They are separate
fields and only `id` carries app identity — changing that orphans every
installed copy (see "PWA demo behaviour"), while `start_url` only says where a
launch lands.

It shipped as `/orders` on the argument that somebody who installed the app has
already come through the front door and wants their work. **That was wrong in
practice**, and the way it was wrong is worth keeping: the reviewer opened the
installed icon, landed on `/orders`, and reported the landing page as *gone* —
which from where they were standing it was. A front door that the primary
device never renders is not a front door. The old behaviour is one line if a
supervisor using this daily ever finds the extra tap worse than the
orientation.

**The CTA points at `/orders`, not at `/login`.** One destination, and it is
the ordinary deep-link path — a signed-in visitor goes straight to work, and
everyone else meets sign-in through the same redirect that already handles a
pasted order link. A second button wired to a second route would be a second
thing to keep right.

**Nothing new was invented visually.** The mark, the wordmark, ATHENATEC
underneath it, the card at radius 22 with the login page's own
`0 24px 60px rgba(16,21,58,.16)` lift, the gradient CTA at radius 13 — all of it
is already in this app, and all of it traces to `claudeai_athena`. The one new
value is the hero tile's 58px/18px geometry, scaled from the nav's 32/10 and the
login panel's 38/13; every type size on the page is on the seven-step scale.

**`components/fab/brand.tsx` is new, and it is a deduplication, not an
addition.** The lockup was pasted into `app-shell.tsx` and `login-page.tsx`,
differing only in tile size and in dark-on-white versus white-on-navy. The
landing page would have been the third copy — the point at which somebody
adjusts the mark in two places and ships a product with two logos. Both callers
now render the same markup they rendered before — same tile geometry, same two
type steps, same tracking, same ink tokens — checked by regenerating
`design-review/out/01-orders.html` and reading the lockup back out of it. The
only structural change is one extra wrapper `<span>`, which was already a flex
row.

**ATHENATEC keeps the product's spelling**, without the trailing H, because that
is what `claudeai_athena/components/cockpit/cockpit-nav.tsx:73` ships. It reads
as a typo and it is not this demo's to correct: a demo whose wordmark disagrees
with the product's own nav is a demo that gets asked about its wordmark instead
of about production orders.

**The orders screen gained a one-line orientation strip** at the same time —
*this is where you review production orders, search or scan one below* — which
**was replaced on 2026-08-18 by the review panel** (see "Reviewing an order
without an analysis" below). The strip was a misreading: asked for "a little
thing at the top which says do this to review orders", it described the
capability instead of offering it. The panel says the same thing by being the
control.

**What is deliberately not on it:** no metrics, no feature grid, no
screenshots, no animation beyond the CTA's existing 1px hover lift. A landing
page carrying statistics would be the only screen in this app rendering numbers
that resolve to no MES record — a strange thing to put at the entrance of a
product whose whole argument is that they always do.

⚠ **The single CTA was replaced by three doors on 2026-08-19** — see "The front
door has three doors" above. The rest of this entry still describes the screen;
"no feature grid" still holds and is about invented content, which entry
explains at the line where the two nearly touch.

**It is the first screen here that ships no JavaScript.** No session, no fetch,
no client component, so it prerenders as static (`○ /` in the build output,
against `ƒ /login`, which stays dynamic because it reads `DEMO_PREFILL_EMAIL` at
request time). That is also the right behaviour for a public front door: it has
to render for somebody who has never signed in, on a cold cache, before any
bundle arrives.

**`design-review/out/00-landing.html` renders it**, and `render.tsx` now writes
that file **before** the API calls, so the harness produces it with no bearer
token at all. Item 3 below is unchanged and this does not touch it — the
harness proves the markup and the compiled CSS, never what a human sees.

### Reviewing an order without an analysis (2026-08-18)

**The complaint:** "the option to report comes on only after we have asked the AI
for the analysis." It was exactly right, and it was the third time the same
underlying thing had been reported as *nothing has changed*.

`DecisionSection` rendered `visible={analysisState === "ready" && analysis != null}`.
So a supervisor opened an order, looked at the top of the page and saw no way to
review it — because the controls only existed after a ten-second model call had
been requested, waited for, and answered. Docking the card at the top made no
visible difference for the same reason: on arrival there was nothing to dock.

**Two changes, one principle.**

1. **`/orders` gained a review panel, above the list** — pick a production order,
   add a note, Approve / Reject / Escalate. Always present, never conditional.
   It is the first thing on the page you reach through the landing page's CTA,
   which is where the reviewer asked for it, and it replaced the orientation
   strip that had described the capability instead of offering it.
2. **The order screen's decision card no longer waits for an analysis.** It is
   there the moment the order opens.

**The principle: record what actually happened.** A decision taken without an
analysis has no recommendation behind it, so `Decision.recommendedAction` is now
`string | null` and `analysisSource` gained `"none"`. The alternative was to
write a placeholder recommendation so the row looked complete — a log saying the
model advised something it never said, which is the single thing this product
exists to argue against. `"none"` is required explicitly rather than inferred
from an absent recommendation, so a client that merely *forgot* the field is
rejected instead of silently recording "decided without asking the model"; and
sending a recommendation alongside `"none"` is a 400, because a client doing
both is confused about which it did and guessing for it puts the wrong story in
the log.

Said in three places, all agreeing: the panel ("decisions recorded here are
logged as taken without an AI analysis"), the order screen's card ("no AI
analysis has been run on this order yet"), and every row rendering that decision
afterwards in `/activity` and `/decisions` ("Decided without an AI analysis").

**What this costs, stated plainly.** F-03 and the reverted `lg:sticky` both said
a decision must not be available before the evidence. That is now fully
withdrawn: Approve is reachable on an order nobody has analysed, from a screen
that never showed the evidence at all. The defence is no longer structural, it
is documentary — nobody is stopped, and nobody can later claim the model advised
it. **If that trade is wrong, the fix is a confirmation step on Approve, not
re-hiding the controls**, which has now been reported as a defect three times.

**One write path still.** The panel posts to `POST
/api/orders/[orderId]/decision` — the same route the order screen and
`/decisions` use. A second endpoint would be a second place to keep the
session-derived author, the order existence check and the supersession rules
correct.

**An override of a no-analysis decision inherits `null`/`"none"`** from the
record it supersedes, like any other override. Tested, because inheriting a
recommendation from nowhere is the placeholder problem arriving by the back
door. `npm run test:decisions` is 21 tests, up from 16.

**The panel picks from the orders currently listed**, and re-selects the first
row if a filter or search removes the selection — a decision posted against a
stale selection is the worst outcome this panel has. It pins on the same terms
as the decision dock: wide screen, mouse. On a phone it sits at the top of the
page in flow, which is where it is rendered anyway.

### The decision moved to the top of the order page (2026-08-18)

**⚠ Superseded — the docked section was removed entirely on 2026-08-19. See
"The order screen stops asking for a decision".**

Requested by the reviewer relaying Jothi: the controls for reviewing and
approving an order belong at the top and should stay there. `DecisionSection`
now renders directly under the order header, above the two-column grid, and
**pins** there on a wide screen driven by a mouse.

**This reverses two decisions in this file, and their reasons have not stopped
being true.** F-03 moved the decision last so the screen could not ask for one
before showing the evidence. Round 5's `lg:sticky lg:bottom-4` was reverted on
sight because a control that follows you down a page is one you can press
without having read what is above it. Both objections say the same thing — a
decision must not be *available too early* — and moving it to the top is that
move. Recorded rather than quietly overwritten, because the next person to read
F-03 will otherwise think it still describes the screen.

**What held the line was `visible` — and it was withdrawn the same week.** For
about a day the dock still returned null until an analysis existed, so nothing in
it could be pressed before Explain had answered. That gate is exactly what made
the review option look absent, and it was removed on 2026-08-18; see "Reviewing
an order without an analysis" below. The structural answer to the reviewer's
objection is gone and has been replaced by an honest one — the card says no
analysis has been run, and the row it writes says so too.

**Under the header, not above it.** A decision has to say which order it is
about, and the order number is in the header.

**Pinned on a mouse-driven wide screen only** — `.fab-decision-dock` in
`app/globals.css`, gated on `(min-width: 1024px) and (hover: hover) and
(pointer: fine)`. Width alone would be wrong: an iPad in landscape is 1024px and
is a touch device, where the in-card button row is hidden and F-11's fixed
bottom bar owns the controls — pinning there would dock a card whose buttons are
somewhere else. Excluding touch keeps F-11's invariant that **exactly one set of
decision controls exists at any width**, and keeps a phone from spending a third
of its viewport on a card for the whole read.

Three details in that rule are load-bearing rather than taste: `top: 55px` is
the shell header's exact height (`py-[10px]` around a 34px control row, plus its
1px border), so the card's top edge meets the nav's bottom edge with no gap for
content to show through; `background: var(--page-surface)` exists because the
section's "Your decision" label sits on the page surface rather than on the
card, and without it the text scrolling underneath shows through beside the
label; and `max-height: calc(100vh - 55px)` with `overflow-y: auto` is the cap
F-09 learned the hard way — a sticky element taller than the viewport pins its
top and carries its own bottom off-screen where page scrolling cannot reach it.
The card is short today and an order with a long decision history is not.

Section order on the screen is now: order → decision → problems → analysis →
records. The evidence still reads problems → analysis → records when the columns
stack, which is the half of F-03 that survives, along with the part that always
mattered more — the decision is a **sibling** of the AI panel in the document
outline, never a descendant, so a screen reader cannot announce the human's
decision as belonging to the model.

### Layout round — F-08, F-09, F-11 (2026-08-12)

The three design findings held back from the first pass, implemented after the
reviewer asked for them by name. All three are on order detail.

- **F-08 — the order header is on the page surface, not in a card.** Every
  section was a white box, so identity competed with the problem for the eye and
  won, being first and largest. It is a `<header>` now, with the facts grid
  keeping a hairline top rule instead of a card edge. The only white surfaces
  above the fold carry detected problems.
- **F-09 — two columns from `lg`,** `grid-cols-[1fr_1.1fr]`. **Split by
  provenance**, which is the distinction this whole product rests on: left is
  the argument (what the rules found, what the model says about it), right is
  what the MES recorded. (The decision was in that right column until
  2026-08-18 — see "The decision moved to the top" below.) `--page-width` stays
  1180px and the surplus buys a second column rather than line length.
  **DOM order is deliberately unchanged**, so stacking below `lg` still reads
  problems → analysis → records → decision — the grid moves things without
  undoing F-03.

  The right column is `lg:sticky` **and capped** at
  `lg:max-h-[calc(100vh-104px)]` with internal scroll. Not decoration: a sticky
  element taller than the viewport pins its top and carries its own bottom
  off-screen where page scrolling cannot reach it. On an order with six downtime
  events that strands the decision buttons. The cap is what makes sticky safe on
  data of unknown size.
- **F-11 — a fixed action bar on `(pointer: coarse), (hover: none)`.**
  **⚠ Withdrawn 2026-08-19 — see "The decision buttons come off the bottom bar".
  The bar no longer exists; the buttons are in the card at every width.** The
  entry is kept because the reasoning below is still the best record of what the
  bar was for and what removing it costs. Approve /
  Reject / Escalate began about four screenfuls down, most of it AI output.

  **Fixed, not sticky as the handoff worded it.** Sticky resolves against its
  scroll container, so a bar inside the decision card would pin only while that
  card is on screen — the bottom of the page, precisely where the problem is
  not. A spacer reserves the bar's height in flow so the last card is not
  permanently underneath it.

  **The in-card row is hidden on touch and the bar does not exist on desktop**,
  so exactly one set of decision buttons is present at any width. The CSS
  ordering matters and is commented in `app/globals.css`: the default
  `display: none` must stay **above** the coarse-pointer block, because equal
  specificity means the later rule wins and the bar would silently never appear.

  **The reviewer's objection is answered structurally, not waived.** They wrote
  that a persistent bar "puts an always-available Approve in front of someone
  who may not have read the evidence yet". The bar renders from inside
  `DecisionSection`, which returns null unless an analysis exists — so it cannot
  appear before Explain has run and answered. It shortens the distance to a
  decision already available; it does not make one available earlier. If that is
  judged insufficient the next step is a confirm on Approve, which nobody has
  asked for.

**F-05 (structural) remains the only open finding** — moving the model's
per-problem paragraphs into the rule cards. F-09 now separates rule-derived from
model-derived content *by column*, which may have made it moot; that is the
reviewer's call.

**Verification note.** `curl` on `/orders/PO-10382` shows none of this: the page
is a client component that renders `PageSkeleton` until the session and fetch
resolve, so server HTML is the skeleton. The `design-review/` harness renders
`OrderDetailScreen` directly with real data and is the only way to check this
structure without a browser.

### Rule-layer corrections (2026-08-12)

Found by the reviewer asking why `PO-10344` said **COMPLETED** while carrying a
HIGH problem the AI offered to explain. It did, and the app was wrong.

**The defect.** `productionDelay` computes
`expected = plannedRatePerHour × hoursElapsed(operation.startedAt, asOf)` and
never asked whether the order had *finished*. The contract carries no
"operation completed" fact, so **the clock never stopped**. `PO-10344` made all
750 of its 750 planned units and reported *"750 units complete against 4000
expected by now — 81.3% behind"* at HIGH, worsening every hour. `PO-10402`
failed from the other end: RELEASED fifteen minutes earlier, 0 units made,
*"100.0% behind"* at HIGH.

**Why it survived.** `PO-10382` is IN_PROGRESS six hours in, so the demo path
never touched it — and **grounding validation cannot catch this class of bug at
all.** Every citation resolved exactly: `completedQty 750`,
`plannedRatePerHour 125`, that start time. The analysis wore *"Grounded in MES
data"* honestly while being nonsense. **True records, true numbers, false
inference.** That is precisely the limit this file already records for the
badge, demonstrated. Only the rule layer can prevent it, which is why the
regression tests are in `__tests__/mes/` and not in the AI suite.

**Fixed:**

1. **`RULE_CONFIG.productionDelay.assessedStatuses`** — `IN_PROGRESS` only.
   RELEASED has not started; COMPLETED and CANCELLED are finished and the
   arithmetic is unbounded. **ON_HOLD is excluded deliberately and is the
   arguable one**: a held order genuinely does slip against its due date, but
   "behind the planned *rate*" is the wrong way to say it when the machine is
   stopped on purpose — the ratio just counts how long the hold has lasted. That
   belongs to a due-date rule this demo does not have, so it was left out rather
   than half-answered.
2. **`expected` is capped at `plannedQty`.** Independent of status: you can
   never be expected to have produced more than the order asks for.
3. **`machineDowntime` now filters to `event.machineId === order.machineId`.**
   The headline interpolates `order.machineId` while the minutes come from the
   events, so a foreign event was reportable as *"ASM-04 was down 75 min"* when
   ASM-04 was never down — and every citation would have resolved. Unreachable
   with the mock adapter; a real Tier 4 MES is far more likely to return a
   machine-level event stream for a cell than a pre-filtered list per order.
4. **`POST /explain` returns 422 when no rule fired.** Handed an empty issue
   list the model still answers — it volunteers a problem the rules did not
   detect, which breaks rule 1 from the inside. The screen already hides the
   button at zero issues; this is the route's own guard, and it became reachable
   the moment fix 1 left two orders with no issues at all.
5. **`machineDowntime`'s doc comment was overclaiming.** It said downtime "on
   the order's current operation" and called it "unplanned". It does neither and
   **the contract cannot support either claim** — `DowntimeEvent` carries no
   operation number and no planned flag. A routine label-stock reload weighs the
   same as a feeder jam. Defensible for a demo; it was being described as more
   precise than it is. Either distinction is a contract change first, so it is a
   Tier 4 question against a real MES.

`PO-10382` is unaffected — all three rules still fire with the same severities
and the same 17.3%. `PO-10344` and `PO-10402` now correctly report no issues.
`PO-10365` (ON_HOLD) keeps its MACHINE_DOWNTIME HIGH, because 75 minutes down
is still 75 minutes down.

**Deliberately not changed, and worth a decision:**

- **MACHINE_DOWNTIME and QUALITY_PROBLEM still fire on COMPLETED orders.**
  Unlike delay these are observed historical facts with bounded arithmetic, and
  a finished order that ran at 5× its defect baseline is a real finding for a
  yield review. But there is no action a supervisor can take on a finished
  order, so whether they belong in a screen built around *decide what to do* is
  a product call, not a correctness one.
- **The model can still cite a record the rules excluded.** `citableRecords`
  derives from `recordIndex(order)`, which carries every event on the order —
  so if an adapter ever attaches a foreign machine's event, the rule now ignores
  it but the model could still cite it, grounded. Narrowing this in the AI layer
  would violate the invariant `context.ts` states in its own header: the
  definition of "citable" belongs to the MES contract, and the AI layer is
  exactly the code that must not widen it. **The fix belongs in the adapter**,
  at Tier 4.

**Things standing on thin ice, in the order they will hurt:**

1. **`lib/auth.ts` is not the product's authentication.** One credential pair
   from the environment, stateless HMAC tokens, so logout cannot revoke and a
   stolen token is valid until expiry. No user table.

   **Half of this was paid down on 2026-08-23** — sign-in is rate limited
   (`lib/rate-limit.ts`), because the route now forwards to a real
   FabOrchestrator and is deployed behind a public URL. Per-process and per-IP,
   so it stops a script against one address and not a distributed attempt. The
   rest of the item stands unchanged. It
   keeps the *shape* (bearer token, `requireAuth` on every route) so swapping
   in the real thing is a two-file replacement. It must not ship as is.
2. **URL state.** Filters and search belong in the URL so a link pasted into a
   ticket lands where the operator was. They are in component state instead;
   `useSearchParams` needs a Suspense boundary that was not worth the Tier 0
   build risk. **Partly answered twice.** `/login` reads `?next=` on the
   server (2026-08-19), and `/orders` now reads `?order=` the same way
   (2026-08-20) — a thin server `page.tsx` handing the value down as a prop,
   which is the move that avoids the hook. `/orders` paid for it by dropping
   from `○` to `ƒ`, which was cheap because its prerendered HTML was only
   `PageSkeleton`. **The item still stands**: the filters and the search on
   `/orders` are component state, and putting *those* in the URL means reading
   them as the user types, which is the client-side case a server `page.tsx`
   cannot cover.
3. **Nobody has visually reviewed any screen.** Build, types, lint, 162 tests
   and server-side renders of every state all pass, but the Chrome extension
   would not connect on 2026-08-10, 2026-08-11, 2026-08-12, 2026-08-18,
   2026-08-19 or 2026-08-20 — `list_connected_browsers` returns empty every
   time — so no human has looked at them. This is comfortably the oldest
   unresolved item in this file, and `/diagnostics` does not touch it: that page
   reports what a browser *supports*, never what a screen *looks like*. **The
   landing page is the newest thing nobody has seen**, and it is the screen
   where that matters most per hour of work — it is the first thing a stranger
   opening the link looks at, its whole job is to look right, and it has now
   been rebuilt three times unobserved (the front door on 2026-08-18, its three
   doors on 2026-08-19, the featured-order card on 2026-08-20).

   **2026-08-20 raised the cost of this item rather than paying it.** The
   landing redesign went through a proper design process for the first time —
   a researched brief, four directions in Claude Design, one chosen — and
   *none of it was ever rendered to a screenshot*, because Claude Design's own
   verify loop needs the same browser tooling this item is about. A design
   review nobody can see is the same defect as a screen nobody can see, one
   step earlier in the process.
4. ~~**The live model call has never run.**~~ **Resolved 2026-08-11.** Four
   live calls across two orders and two models, all `source: live`,
   `grounded: true`, `attempts: 1`, zero citation problems — 64 citations
   checked in total. `PO-10344`, which used to 503 for want of a cached
   analysis, now analyses live.

   The corrective-retry loop is also no longer untested, but note **how** it was
   proved: `analyzeOrder` now takes an injected client and
   `__tests__/ai/retry.test.ts` drives it with scripted responses. You cannot
   ask a model to please miscite a record, so the branch is unreachable from a
   real call on demand. Eight tests cover it and they found no bug — the loop
   was correct as written. What has still never happened is a *live* model
   producing a bad citation and being corrected; that is now a matter of waiting
   for one rather than a gap in coverage.

   **Grounding validates citations, not prose.** Haiku's first live answer said
   waiting "risks 400 more bad parts before end of shift" — an extrapolation
   from no record. It is not a citation, so nothing checks it. The badge claims
   that every *record and number cited* came from the MES, and that is all it
   should ever be read as claiming.
5. **The scanner has never seen a camera.** `extractOrderNumber` is tested
   against the payload shapes real labels carry, and the wasm is confirmed to
   load from `/zxing/zxing_reader.wasm`, but no frame has been decoded on any
   device. The secure-context trap — scanning works on `localhost` and over
   HTTPS and **silently offers nothing** over plain HTTP on a LAN address, which
   is exactly how a demo gets shown from a laptop to a tablet — is now written
   down in the README and reported on `/diagnostics` rather than being folklore
   in this file. **Neither is a fix.** The first real camera frame is still
   ahead, and `/diagnostics` exists to make that attempt diagnosable rather than
   to substitute for it.
6. ~~**`lib/decisions.ts` is in-memory.**~~ **Addressed 2026-08-19** — see
   "Tier 3: the decision log persists". Postgres behind a contract when
   `DATABASE_URL` is set, the Map when it is not, and `durable` reports which.
   **Not closed:** the Postgres store has never run against a real database, so
   what is proven is the contract and the memory implementation, not the SQL.
   Point it at any managed Postgres and exercise one override to close this.
7. **`public/sw.js` caches the offline page and two icons, and nothing else.**
   Not order data, not analyses, nothing under `/api/`. It intercepts *only*
   navigations, and only when they throw — a 404 or a 500 is an answer and the
   server's own page shows through. Offline **data** is still Tier 5 and needs a
   staleness story before it needs code. Note also that `public/zxing/` is
   gitignored and written by `postinstall` — a deployment that skips lifecycle
   scripts ships without a decoder, and the scanner falls back to manual entry.
8. **The responsive work is structural, not observed.** Every container is a
   `max-width`, both grids are `auto-fit`/`auto-fill` with minima under a phone
   viewport, and touch targets now clear 44px on coarse pointers — but nobody
   has looked at these screens at 390px, or at any width. See item 3.

## What NOT to build

No generic chatbot, no drag-and-drop agent builder, no giant dashboard, no
replacement MES, no autonomous factory control, no pile of unrelated AI
features. Specific manufacturing value > impressive-looking generic AI.

**"No generic chatbot" and `/fabinsight` are not in conflict, and the line
between them is the one to hold.** The prohibition is against *this demo*
growing an assistant of its own — a second AI, beside the deterministic rule
layer, answering manufacturing questions from a prompt somebody wrote here.
`/fabinsight` is the opposite: it is **FabOrchestrator's** agent, reached from
the place the product puts it, and this app contributes no prompt, no model
call, no tool and no manufacturing logic to it.

The test to apply to anything added under `lib/faborch/` or
`components/fab/screens/fabinsight.tsx`: **could this change what the answer
says?** Forwarding, rendering, error states and the tool-activity line cannot.
A system prompt, a retry that re-asks differently, a post-processing step, a
"helpful" fallback answer when FO is down — all can, and all are the forbidden
thing wearing this integration as a costume.
