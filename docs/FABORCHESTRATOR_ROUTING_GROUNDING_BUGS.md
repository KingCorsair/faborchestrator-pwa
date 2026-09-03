# FabOrchestrator `/api/chat` — routing and data-grounding defects

**Investigated 3 September 2026** against upstream
`LLM-AT-SCALE/FabOrchestrator_product_code` at commit **`e5a5abd`**
("feat: discrepancy alert system + MCP rename propagation fix"), branch `main`.

This document records four defects and one factual correction found while
investigating why the FabOrchestrator PWA's landing-page questions sometimes
returned real plant data and sometimes did not.

## Status of this document

- **Nothing has been pushed to the FabOrchestrator repository.** No branch, no
  PR, no commit on any remote.
- A local fix branch exists **on this machine only** and is described here for
  review. It is not proposed as merged work.
- **No PWA behaviour was changed** as part of writing this document.

Line references are to the **unmodified** source at `e5a5abd`, so they can be
checked against a clean clone.

---

## 1. Routing architecture of `/api/chat`

`claudeai_athena/app/api/chat/route.ts` (1,714 lines) is not a passthrough to a
model. Before `streamText` is called it **inspects the last user message and
dispatches three ways**. This routing is deterministic — regular expressions and
a scoring function, not a model call.

Behind it sits `claudeai_athena/lib/fabinsight/` — **5,033 lines across 18
files**: `catalog.ts`, `metrics.ts`, `dashboards.ts` (837 lines), `render.ts`
(1,179 lines), `render-kit.ts`, `alerts.ts`, `sql-guard.ts`, `scheduler-runner.ts`
and others.

```
POST /api/chat
  │
  ├─ lastUserText  ← the last user message, flattened to a string   (route.ts:685)
  ├─ canCreateDashboards = await isDashboardAdmin(user.id)          (route.ts:700)
  │
  ├─ (1) metricAsk = detectMetricAsk(lastUserText)                  (route.ts:704)
  │        └─ if set → buildMetricBrief() → fixed SQL, appended to
  │                    the user message                             (route.ts:825-837)
  │
  ├─ (2) curatedMeta = matchDashboard(lastUserText)                 (route.ts:706-709)
  │        └─ if set → buildCuratedTurn() → fixed SQL + a
  │                    pre-rendered <antArtifact>                   (route.ts:1160-1205)
  │
  └─ (3) otherwise → MCP tools from the caller's activeMcpIds,
                     model writes its own T-SQL, up to 20 steps
                     (stopWhen: stepCountIs(20))
```

### 1.1 Metric path

`detectMetricAsk(text)` in `lib/fabinsight/metrics.ts:28-46`. Pure regex.
Returns `'yield' | 'oee' | 'scrap' | null`.

The metric must be the **object of a request**: an ask verb within 40 characters
before the metric word, or the message must lead with the metric.

```
ASK = (?:give|show|get|what(?:'s|s| is| are)?|tell|pull|display|breakdown of|break down)
metric(word) = (?:\bASK\b[^.?!]{0,40}?\bword\b)|(?:^\s*word\b)
```

Precedence: a metric ask **suppresses** dashboard matching (`route.ts:706-707`,
`!metricAsk`).

On a hit, `buildMetricBrief(kind)` (`metrics.ts:327`) runs pre-written SQL and
appends a `<yield-by-product>` / `<oee-request>` / `<scrap-rate>` block to the
user's message. The block instructs the model to answer in prose and explicitly
**not** to build an artifact.

**This path is not gated on any permission.**

### 1.2 Curated dashboard path

`matchDashboard(text)` → `matchCurated(text)` in `lib/fabinsight/catalog.ts:212-273`.

Seven curated dashboards, each defined by a verbatim prompt from the Athena
FabOrchestrator deck: `factory-operations`, `lot-history`, `process-analytics`,
`maintenance-prediction`, `bottleneck-prediction`, `analytics-dashboard`,
`executive-overview`.

Matching is vocabulary scoring, not exact match, because the composer bubbles
fill the textbox rather than sending — so what arrives is usually an edited
prompt:

```
coverage  = hits / words(dashboardPrompt)      how much of the prompt survived
precision = hits / words(userText)             how much of what was said points here
score     = max(coverage, precision)
accept if score >= 0.55 and hits >= 2          (catalog.ts:266)
```

Entity ids (a lot number, a product code) are stripped before scoring and handed
back separately as overrides (`catalog.ts:182-209`).

On a hit, `buildCuratedTurn()` (`lib/fabinsight/inject.ts`) runs the dashboard's
fixed SQL, **pre-renders the artifact**, and appends the rows to the model's
context. The model writes the narrative; it never authors the visual.

### 1.3 Fallback path

Everything else. MCP tools are loaded from the caller's `activeMcpIds`
(`route.ts:548`, `loadActiveMcpToolsWithDescriptions`), re-filtered server-side
against the authorised set. The model chooses tools and writes its own T-SQL.

Two additional tools are registered **only for dashboard admins**:
`create_dashboard` (`route.ts:723`) and `run_mes_query` (`route.ts:801`). Both
reach the manufacturing database directly.

---

## 2. Correction: the metric and dashboard paths do not use MCP

**This is a factual correction to earlier project documentation, not a defect in
FabOrchestrator.**

`lib/fabinsight/mcp.ts` is named misleadingly. Its own header records the
history: it *replaced* an MCP/JSON-RPC client. It now connects **directly to
SQL Server** using the `mssql` driver:

| Setting | Env var | Default |
|---|---|---|
| Server | `SEMI_SQL_SERVER` | `10.10.1.109` |
| Database | `SEMI_SQL_DB` | `SemiDemoOLTP2504` |
| User | `SEMI_SQL_USER` | `SemiOLTPUser` |
| Password | `SEMI_SQL_PASS` | *(required, no default)* |

Consequence: **the metric path and the curated dashboard path work on an account
with zero MCP data connections.** They do not consult `activeMcpIds` at all.

### Evidence

Probe P4 (1 September) recorded `0 connected of 0 visible` MCP connections on the
demonstration account. On that same account, 3 September:

| Question asked | Tools invoked | Result |
|---|---|---|
| `Give me the yield by product.` | **none** | A real table: product, lots, started, remaining, yield % — real product names from the MES |
| `How many lots are currently in WIP?` | code_execution | *"there's no live production data connected to this session"* |

**Recommended action:** correct any statement that "the demonstration account has
no data connections, therefore no plant question can be answered". Yield, scrap
and OEE are answerable today. WIP, lots, equipment, throughput and downtime are
not.

---

## 3. Bug 1 — a dashboard request without permission fabricates a dashboard

### Observed bug

A user **without** the dashboard permission types one of the seven curated deck
prompts. Instead of being told they lack the permission, they receive a fully
rendered dashboard containing **invented figures**.

Observed output (3 September, live deployment, demonstration account):

> "I'll create a Factory Status & Current Production dashboard with the panels
> you specified. Since this is a fresh build, I've populated it with
> **illustrative sample values** so you can see the full layout — you can swap in
> live figures."

followed by a complete `<antArtifact>` dashboard.

### Root cause

`route.ts:706-709` folds the permission check **into the match condition**:

```ts
const curatedMeta =
  lastUserText && canCreateDashboards && !metricAsk
    ? matchDashboard(lastUserText)
    : undefined;
```

For a non-admin, `curatedMeta` is `undefined` — **indistinguishable from "this
was not a dashboard request"**. The turn therefore proceeds down the ordinary
chat path. The code comment at `route.ts:696-699` states this is intentional and
harmless:

> "They still get a normal chat answer; only the pre-built dashboard is
> withheld."

It is not harmless, because of a second fact. `lib/system-prompts.ts:71-104`
contains an `<artifacts>` block: roughly 30 lines of emphatic instruction
(`IMPORTANT`, `CRITICAL`, `REQUIRED FIRST STEP`, `STRICT`) telling the model to
build an artifact when one is explicitly requested, covering closing tags, light
mode, fonts and colour themes. **It says nothing about data provenance.**

The prompt does contain an anti-fabrication rule — `lib/system-prompts.ts:134`:

> "1. NEVER fabricate data. If you do not have grounded data to answer a
> question, say so plainly. Do not estimate, guess, or invent rows, IDs, dates,
> or values to fill a gap."

**That rule already existed and lost.** It is general; the artifacts block is
specific, longer and more emphatic. Asked to build a dashboard with no data
available, the model satisfied the specific instruction and filled the gap.

Note that `create_dashboard` is *correctly* withheld from non-admins
(`route.ts:722`). The failure is not a missing tool gate — it is that the model's
general artifact-authoring ability substitutes for the withheld tool.

### Local fix (not pushed)

Separate matching from permission. Match unconditionally; if a dashboard matched
and the user cannot create dashboards, return **HTTP 403 before the model is
called**, with a message naming the permission:

> "Dashboards are available to administrators only. Your role does not have the
> dashboard permission… Ask an administrator to enable it for your account — or
> ask the same question as a plain question and it will be answered from the data
> you do have access to."

Chosen because it removes the model from the failure entirely. Any prompt-level
mitigation competes with the artifacts block, which is exactly the contest the
existing rule 1 already lost. The 403 mirrors the Modeling Agent's existing gate,
so the product has one shape for "your role cannot do this".

### Evidence

- Reproduced live before the change (output quoted above).
- 5 unit tests covering: all seven deck prompts match independently of
  permission; an edited prompt still matches; ordinary questions do not match;
  the refusal names the permission and does not read as an outage.

### Remaining limitation

A turn that mixes a dashboard request with an unrelated question is refused
whole. Judged acceptable and honest; recorded rather than handled.

### Recommended owner / action

**FabOrchestrator team.** Decide whether refusal or a text-only answer is the
desired product behaviour, then apply. If a text answer is preferred, the
artifacts block still needs an explicit data-provenance clause, or this recurs.

---

## 4. Bug 2 — plant questions fall back to general knowledge

Two distinct sub-cases with the same user-visible symptom: an answer that reads
as grounded but is not.

### 4a. A metric ask whose data source is unavailable

**Observed bug.** If the manufacturing database is unreachable, a question like
"what is the yield" is answered from the model's general knowledge, in the same
confident register used for real rows. No indication is given that the figures
are not from the plant.

**Root cause.** `lib/fabinsight/metrics.ts:327-335`:

```ts
export async function buildMetricBrief(kind: MetricKind): Promise<string | null> {
  try {
    if (kind === 'yield') return await yieldBrief();
    if (kind === 'scrap') return await scrapBrief();
    return await oeeBrief();
  } catch {
    return null;
  }
}
```

The caller (`route.ts:826-827`) does `const brief = await buildMetricBrief(...);
if (brief) { …attach… }`. **`null` means both "the query failed" and "no metric
was asked for".** A failed brief therefore produces a turn byte-identical to an
ordinary one, and the model answers the metric question unaided.

**Local fix (not pushed).** Return a discriminated result
(`{ ok: true; brief } | { ok: false; reason: 'unavailable'; detail? }`), and have
the route return **HTTP 503** with a clear message rather than proceeding. An
empty brief is also treated as failure, for the same reason.

Chosen because the question was explicitly about plant figures; if the plant data
cannot be read, saying so is the only honest answer available.

**Evidence.** One unit test stubbing `mssql` to reject the connection, asserting
`{ ok: false, reason: 'unavailable' }`.

**Remaining limitation.** Not reproduced against a genuinely unreachable
production database — the failure is induced at the driver in test.

### 4b. An ordinary question with no live data route at all

**Observed bug.** On an account with no MCP connections, whether a plant question
gets an honest "I cannot see live data" or a confident general-knowledge answer
is **not determined by anything in the system**. Measured on the same account,
same session:

| Question | Outcome |
|---|---|
| `How many lots are currently in WIP?` | Honest: *"no live production data connected to this session"* |
| Factory Operations deck prompt | Fabricated dashboard with sample values |

**Root cause.** Nothing detects the state. `mcpToolDescriptions` is empty, no
metric brief is attached and no curated dashboard matched — but the turn is
assembled and sent exactly as if data were available. The outcome depends on
whether the model happens to apply rule 1 or the artifacts block.

**Local fix (not pushed).** When a turn reaches the model with no live data route
— no MCP tools, no `run_mes_query` / `create_dashboard`, no metric brief, no
curated dashboard — append a `[DATA AVAILABILITY — SYSTEM NOTICE]` block to the
user's message stating that no live plant data source is attached, and:

- say plainly that live plant data is unavailable and an administrator must
  enable a data connection;
- do not answer from general knowledge as though grounded;
- **do not** build a dashboard, chart, table or artifact containing
  *illustrative, sample, placeholder, example or representative* figures;
- but **answer normally** if the question needs no plant data (a definition, an
  explanation).

Chosen for three reasons: it uses the mechanism the codebase already uses for the
alias glossary and the metric brief (append to the last user message, not the
system prompt, so the cached prefix is untouched); it states the absence at the
point of use rather than as another general rule that can lose to a specific one;
and the final clause prevents over-blocking, which a keyword-based "does this
need plant data?" classifier would have caused.

**Evidence.** Unit tests assert the notice names every fabrication word observed
in the live failure, tells the user what would fix it, and preserves ordinary
answers. `hasLiveDataRoute()` is tested across MCP tools present, direct tools
present, and neither.

**Remaining limitation.** This is an instruction to a model, not an enforcement.
It reduces the probability of fabrication; it cannot make it impossible. Bug 1's
403 is the enforcement; this is defence in depth for the cases a 403 cannot
cover.

### Recommended owner / action

**FabOrchestrator team.** Consider also adding a data-provenance clause to the
`<artifacts>` block itself, since that is the instruction that overrode rule 1.

---

## 5. Bug 3 — curated dashboard matcher false positives

### Observed bug

Ordinary questions returned an entire curated dashboard.

| Asked | Matched | Should have |
|---|---|---|
| `What is the cycle time for step 40?` | `factory-operations` | gone to the tool path |
| `Give me cycle time by step.` | `factory-operations` | gone to the tool path |
| `Which equipment is running?` | `factory-operations` | gone to the tool path |

An admin asking about one step received a factory-wide dashboard instead of an
answer.

### Root cause

`catalog.ts:254` scores `max(coverage, precision)`. The **precision** half is
unqualified, so a short question built from common fab vocabulary scores highly
against a long deck prompt that happens to contain those words.

Measured (content words after stop-word removal and entity stripping):

| Text | Words said | Dashboard | Hits | Coverage | Precision | Score |
|---|---|---|---|---|---|---|
| `Give me cycle time by step.` | 3 | factory-operations | 3/15 | 0.20 | **1.00** | 1.00 |
| " | 3 | analytics-dashboard | 3/21 | 0.14 | **1.00** | 1.00 |
| " | 3 | executive-overview | 3/16 | 0.19 | **1.00** | 1.00 |
| `Which equipment is running?` | 3 | factory-operations | 2/15 | 0.13 | **0.67** | 0.67 |
| `Show me the lot history for "…".` | 2 | lot-history | 2/8 | 0.25 | **1.00** | 1.00 |
| Factory Operations deck prompt | 15 | factory-operations | 15/15 | 1.00 | 1.00 | 1.00 |
| …the same, heavily edited | 8 | factory-operations | 8/15 | 0.53 | 1.00 | 1.00 |

The last row is why precision cannot simply be removed: an edited deck prompt
falls to 0.53 coverage, just below the 0.55 threshold, and relies on precision to
match.

Note the "lot history" row scores identically to the hijack rows. Coverage does
not separate them (0.25 vs 0.20). What separates them is that *"lot history"* is
the dashboard's **name**, while *"cycle time"* and *"running equipment"* are
incidental components of a longer prompt.

### Severity interaction with Bug 1

Before Bug 1's fix, a non-admin's false-positive match was silently discarded, so
the fault was visible only to admins. **After the fix, a matched dashboard is
refused** — so a non-admin asking "What is the cycle time for step 40?" would
have received a permission error for an ordinary question. The two defects had to
be fixed together.

### Local fix (not pushed)

Precision counts only when **either**:

- every content word of the dashboard's **label** was said ("lot history" →
  *Lot History*); or
- the message carries **≥ 6 content words**, i.e. it is long enough to be an edit
  of a deck prompt rather than a question.

The floor of 6 is set from the measurements above: 15 words for a full prompt, 8
for a heavily edited one, 3 for each false positive.

### Evidence

- All seven deck prompts still route to their own dashboard.
- The heavily edited prompt still routes.
- `lot history` still routes (the case precision exists for).
- All three false positives no longer match.
- Unit tests for each of the above.

### Remaining limitation

Thresholds (0.55, 2 hits, 6 words) are empirical. They are now covered by tests,
so a future change to any of them fails loudly rather than silently.

### Recommended owner / action

**FabOrchestrator team.** Independently of the fix, the matcher would benefit
from a scored fixture set of real questions, so accuracy is a tracked number
rather than an anecdote.

---

## 6. Bug 4 — metric routing is sensitive to phrasing

### Observed bug

The same metric, asked by the same user in the same session, is answered from
real plant data or not at all, depending on wording.

Measured before any change:

| Asked | Routed to |
|---|---|
| `What is the OEE?` | **metric** → real figures |
| `How are we doing on OEE?` | fallback → no data on this account |
| `What is our yield this week?` | **metric** → real figures |
| `How is yield trending on line 4?` | fallback → no data |
| `Show me the scrap rate.` | **metric** → real figures |
| `Which products are scrapping the most?` | fallback → no data |

### Root cause

Two properties of `detectMetricAsk` (`metrics.ts:34-36`):

1. The ask-verb list omits `how is` / `how are` / `how's`.
2. The metric word is matched with `\bword\b`, so inflections
   (`scrapping`, `scrapped`, `yields`) do not match.

A third, latent issue: `\b${word}\b` where `word` is an alternation
(`oee|overall equipment effectiveness`) binds as
`\boee | overall equipment effectiveness\b` — the anchors apply to the first and
last branches only. It happens to work for the current values.

### Local fix (not pushed)

- Add `how(?:'s|s| is| are)?` to the ask verbs.
- Match `\b(?:${word})\w*` — a non-capturing group so the alternation binds
  correctly, and `\w*` to admit inflections.

### Deliberately **not** fixed

`Which products are scrapping the most?` is still missed. Adding `which` to the
verb list was tried and rejected: it then fires on
*"I'm not sure which column the yield is in"*, which would answer a question
about a spreadsheet with a factory-wide yield table. The verb list is a blunt
instrument and widening it past this point trades one wrong answer for another.
**This limit is recorded in a test** so it is a known boundary rather than a
future surprise.

### Evidence

- 21-phrasing coverage measurement before and after.
- Tests asserting each previously-failing phrasing now routes, and that passing
  mentions (*"the yield column is blank on the report"*, *"Our scrap bin is
  overflowing in bay 3"*, *"I filed a ticket about the OEE report being slow"*)
  still do **not** route.

### Recommended owner / action

**FabOrchestrator product.** The underlying question is whether intent detection
should stay regex-based at all. A regex that must distinguish "give me the yield"
from "the yield column is blank" is doing semantic work with syntactic tools.

---

## 7. Route observability (added locally, not pushed)

There was no way, after the fact, to tell which path served a turn. A grounded
yield table and a general-knowledge one read the same in the transcript.

Added: an `X-FabOrch-Route` response header and a log line, one of:

| Value | Meaning |
|---|---|
| `metric` | Deterministic metric brief — fixed SQL, real rows |
| `dashboard` | Curated dashboard — fixed SQL, pre-rendered artifact |
| `dashboard-denied` | Curated prompt refused: caller lacks the dashboard permission |
| `metric-unavailable` | Metric ask refused: the data source could not be read |
| `mcp` | Ordinary tool-using chat **with** at least one live data route |
| `no-data` | Ordinary chat with **no** live data route at all |

The `no-data` value is the important one: it marks every turn where an answer
could not have been grounded, whatever the prose claims.

The PWA proxy forwards the header when present, and does not invent one when
absent (so an older FabOrchestrator deployment is handled correctly). That
forwarding is the **only** change made on the PWA side, and it is already
committed there.

---

## 8. What was and was not verified

### Verified

| Check | Result |
|---|---|
| New unit tests (`__tests__/fabinsight/grounding.test.ts`) | 21 pass |
| Full TypeScript check, unmodified tree | **0 errors** |
| Full TypeScript check, with changes | **0 errors** |
| ESLint on all changed files | clean |
| Existing `__tests__/errors/faborch-errors.test.ts` | 35 pass |
| Existing `__tests__/validation/cross-sheet.test.ts` | 17 pass |
| The **broken** behaviour, live | Reproduced against the deployed platform |

### Not verified

- **The fixed behaviour has not been observed on a running FabOrchestrator.**
  The deployed instance runs `e5a5abd`; the fixes exist only on a local branch.
  They are supported by tests and by source reading, not by observation.
- The 503 path was induced at the driver, not by a genuinely unreachable
  production database.
- No load, latency or cost measurement was taken. The 403 and 503 paths **save**
  a model call, so the expected effect is a reduction, but this is inferred.

---

## 9. Remaining limitation — intents with no deterministic route

Deterministic routing covers **three metrics** (yield, scrap, OEE) and **seven
curated dashboards**. Everything else depends on the caller's MCP connections.

Measured across 21 realistic phrasings, these intents have **no** deterministic
path and no fixed SQL behind them:

- WIP / work in progress
- lots (on hold, by status, counts)
- equipment status, tools down
- throughput
- downtime
- cycle time as a general question (as opposed to the curated dashboard)

On an account without MCP connections, every one of these is unanswerable. On an
account with them, the model writes its own T-SQL.

Adding any of these to the deterministic layer means writing and validating new
SQL per intent — product work, not a routing adjustment. **None was attempted.**

---

## 10. Risk assessment

### Demonstration risk — high

A fabricated dashboard is the worst available failure in a customer setting. It
is visually complete, styled to the product's own standard, and its only tell is
a phrase inside the prose ("illustrative sample values") that a viewer looking at
the chart will not read. Nobody in the room can distinguish it from a real one.

The trigger is not exotic: it is the deck's own prompt, typed by a user without
the dashboard permission — i.e. exactly what happens when a demonstration is run
on a non-admin account.

### Product-integrity risk — high

FabOrchestrator's stated value is grounded answers from plant systems under a
user's own permissions. An answer that reads as grounded and is not damages that
claim more than a visible failure would. The system prompt's rule 1 shows the
intent was already there; the defect is that a general rule lost to a specific
one.

### Security risk — low

No unauthorised data access is involved. In both bugs the user sees *less* real
data than they should, not more. The dashboard permission is still enforced for
`create_dashboard` and `run_mes_query`. The issue is integrity and honesty of
output, not confidentiality.

One adjacent observation, not a defect found here: the metric and curated paths
read the manufacturing database with **server-side credentials that are not
scoped to the requesting user**. Any user who can trip `detectMetricAsk` receives
factory-wide yield, scrap or OEE figures regardless of their MCP connections or
role. If plant metrics are ever considered role-restricted data, that is worth a
separate review.

### Operational risk — medium

Phrasing sensitivity means users learn "magic phrasing" by trial and error, and
two people asking the same question in different words get different answers with
no explanation. This erodes trust more slowly than a fabricated dashboard, but in
the same direction.

---

## 11. Summary of recommended actions

| # | Action | Owner |
|---|---|---|
| 1 | Decide the product behaviour for a dashboard request without permission — refuse, or answer in text only | FabOrchestrator product |
| 2 | Add a data-provenance clause to the `<artifacts>` block in `lib/system-prompts.ts`, whichever way (1) is decided | FabOrchestrator team |
| 3 | Make a failed metric brief distinguishable from "no metric asked" | FabOrchestrator team |
| 4 | Qualify the precision half of the dashboard matcher | FabOrchestrator team |
| 5 | Introduce a scored fixture set for matcher accuracy | FabOrchestrator team |
| 6 | Add route observability so grounding is auditable after the fact | FabOrchestrator team |
| 7 | Decide whether plant metrics are role-restricted, given the shared server-side credential | FabOrchestrator product / security |
| 8 | Correct project documentation asserting that zero MCP connections blocks all plant answers | PWA project *(done)* |
| 9 | Decide whether the demonstration account should hold the dashboard permission | PWA project / Jothi |

---

## 12. Local branch contents, for reference

Branch `fix/grounded-routing`, one commit, **local only — not pushed, no PR**.

| File | Change |
|---|---|
| `app/api/chat/route.ts` | Match before permission; 403 on denial; 503 on metric-brief failure; grounding notice on ungrounded turns; `X-FabOrch-Route` header and log line |
| `lib/fabinsight/grounding.ts` | **New.** Route type, the two refusal messages, the grounding notice, `hasLiveDataRoute()`. No imports |
| `lib/fabinsight/metric-intent.ts` | **New.** `detectMetricAsk` split out of `metrics.ts` so intent detection does not require loading a SQL driver — the same split `catalog.ts` already has from `dashboards.ts`. Widened ask verbs, inflection matching |
| `lib/fabinsight/metrics.ts` | `buildMetricBrief` returns a discriminated result; re-exports the detector from its new home |
| `lib/fabinsight/catalog.ts` | Precision qualified by label match or message length |
| `__tests__/fabinsight/grounding.test.ts` | **New.** 21 tests |
| `package.json` | `test:grounding` script |

To review it locally:

```bash
cd FabOrchestrator_product_code_upstream
git log --oneline main..fix/grounded-routing     # one commit
git diff main..fix/grounded-routing
cd claudeai_athena && npm run test:grounding     # 21 tests
```

To discard it entirely:

```bash
git branch -D fix/grounded-routing
```
