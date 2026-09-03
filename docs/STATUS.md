# Where this project stands

**As of 3 September 2026.** Working tree clean, all commits pushed to `KingCorsair/faborchestrator-pwa` (private).

This file is the running answer to "where are we and what is left". It records
what has been *proved*, not what has been written — anything claimed here has a
test, a probe report, or a browser run behind it. When the two disagree, this
file is wrong and should be corrected.

---

## Update in plain English — 3 September 2026

For sending to Jothi or anyone else who wants the short version. Everything here
is expanded, with evidence, further down.

**Done today**

- **Sign-in and live conversation work, end to end.** You sign in with your own
  FabOrchestrator account, ask a question in the app, and the answer comes back
  word by word. Tested against the live system, not a copy.
- **Answers stream properly.** This was the biggest worry in the plan — that an
  answer would arrive in one lump after a long silence. It doesn't. First words
  in under half a second.
- **The app is now only a door to FabOrchestrator.** We deleted the fake
  production-order screens and the demo login. They made the app look like it
  was working when it could not reach the platform at all.
- **The menu now matches FabOrchestrator's own.** Sections the platform has but
  this app doesn't open yet are greyed out, not invented.
- **Two things the plan assumed were wrong.** We checked the platform's source
  and corrected them rather than building on them.
- **Signing out now really signs you out.** It ends the session on
  FabOrchestrator itself, not just on the phone. Checked against the live
  system: the same credential works before, and is refused after.
- **Conversations are finished work.** You can ask, read, ask a follow-up,
  stop an answer half-way and carry on. Stopping keeps what had already
  arrived. Checked in a real browser against the live system.
- **A long conversation no longer breaks in a way nobody could read.** It used
  to fail with a programmer's error message and stay broken. It now says it is
  full and offers a fresh one.
- **The Master Data Load Agent is out, on Jothi's decision.** It is still shown
  on the front page, greyed, because FabOrchestrator really does have it — the
  app just does not open it.
- **Asking from the front page now works.** Type a question with nothing
  selected and it is answered. This was the behaviour Jothi asked for, and it
  needed no new code: once the master-data agent was out, every remaining agent
  was the same service, so there was nothing left to choose between.
- **The platform already answers plant questions, and we had this wrong.**
  Asking "give me the yield by product" returns a real table of real
  products from the factory database — today, on the demo account, with no
  administrator action. We had been reporting plant data as blocked. It is
  blocked for *some* questions, not all.
- **We found FabOrchestrator inventing data, and fixed it.** Asked for a
  dashboard by someone without dashboard permission, it built one and filled
  it with made-up numbers, labelled "illustrative sample values". In front of
  a customer that is the worst thing the product can do. It now says the
  permission is missing instead.
- **174 automated tests pass** here, and 21 new ones on the platform side.
  They run without a network.

**Pending**

- Next: installing on a phone, and answering from real plant data. **The second
  half is blocked on an administrator** — see below.
- The four planning documents still describe four agents and budget work that no
  longer exists. They need a pass to match the decision.
- Nothing security-related is outstanding: sign-out now genuinely cancels the
  app's session, and it turned out no database was needed for it.

**Waiting on someone else**

- **The demo account has no data connections.** Plant questions are answered
  from general knowledge, which looks like a wrong answer rather than a missing
  permission. An administrator has to switch them on. This is the only thing
  blocking the phone-with-real-data demonstration.

**Not claimed:** nobody has clicked through the app by hand yet. Tests, scripted
checks and an automated browser — but not a person.

---

## In one paragraph

The app is a mobile front door to FabOrchestrator and nothing else. A person
signs in with their own FabOrchestrator account, holds a live streaming
conversation with its agents through a server-side connector that holds the
credential, and sees only what the platform actually offers. Phase 0 and the
architecture gate of Phase 1 are proved against the live deployment. The next
build step is Phase 2 (ask-first routing). The one thing standing between this
and the business demonstration is **not code**: the probe account has no data
connections, so plant questions cannot be answered from plant data.

---

## Done, and how it was proved

| Work | Proof |
|---|---|
| **WP0** Baseline & environment probes | `docs/probes/2026-09-01-probe-report.md`. P1 sign-in, P2 modeling API, P3 streaming, P5 permission all pass; P4 fails (see blockers) |
| **WP6** Streaming parser | 37 tests, including the transcript split at **every byte offset**, a multi-byte character cut in half, and 13 frame types that must be ignored |
| **WP3** Platform client | One error normaliser for both of FabOrchestrator's error shapes; 21 tests, 14 of them hostile bodies that must never render `[object Object]` |
| **WP2** Sign-in & session security | **Complete.** 20 cookie/revocation tests + 15 identity and sign-out tests. FabOrchestrator is the only identity, the two expiry clocks are reconciled, and sign-out revokes on both sides |
| **WP4** Secure connector | 15 tests against a stubbed FabOrchestrator, so the suite runs with no network |
| **M1 / B1** Architecture proven end to end | `docs/probes/2026-09-01-e1-report.md` — 5/5 against the live CloudFront deployment: sign-in, token httpOnly and absent from the body, a real answer through the proxy, **13 network arrivals over 2.6 s** (progressive, not buffered), sign-out dropping the cookie |
| **WP5** Conversation handling | **Complete.** 23 tests on the conversation rules, plus a live browser run of the acceptance line — ask, read, follow up, stop, ask again — 10/10 against the live platform |
| **WP7** Agent selection | **Complete**, and smaller than planned. The registry and endpoint routing were already built; the availability query has nothing left to check (see the decision below) |
| **WP13** Ask-first entry point | **Complete without routing logic.** A question typed on the landing page with nothing selected is carried into a conversation and answered — 10/10 in a browser against the live platform |
| Scope correction | The production-order workflow and its mock MES are removed; the nav mirrors FabOrchestrator's own cockpit; the Master Data Load Agent is shown greyed rather than opened |

**174 tests, all passing.** Typecheck and lint clean. Production build compiles.

### What "proved" bought us

Two plan assumptions were wrong and were corrected against source rather than
carried forward:

- **The Back-end Agent is not a separate service.** Verified against a fresh
  clone of upstream (`e5a5abd`, 1 September): the cockpit's AGENT · 04 card
  routes to `/chat`, and `/api/backend-agent/chat` exists in **no** upstream
  branch. The earlier local build of one was superseded when the product folded
  custom dashboards into `/api/chat`. The deployed platform's 404 was correct
  behaviour, not deployment drift.
- **Only one agent is permission-gated** — the Master Data Load Agent
  (`modeling_agent`), and FabOrchestrator enforces it itself with a 403. The
  app's pre-check is presentation, never authorisation.

---

## Remaining

### WP2 — complete. No database was needed after all

The last item was "sign-out revokes", which the plan expected to need a
`pwa_sessions` table and therefore a `DATABASE_URL`. It does not. The session
token now carries a fingerprint of the FabOrchestrator token it was minted
beside, and `requireAuth` refuses any request whose FO cookie does not match, so
deleting that cookie — which is all sign-out can do — leaves the bearer token
authenticating nothing.

Verified in a browser: sign in, keep the token, sign out, then reuse the token
still sitting in `localStorage` → **401 on both `/api/auth/me` and the agent
route.**

The approach that was rejected, and why: validating each request against FO's
own `/api/auth/me`. Every authenticated FabOrchestrator call sets
`last_activity_at = NOW()`, so that would have been a keep-alive — silently
defeating FO's 30-minute idle eviction and corrupting the idle figures in its
session audit.

**Sign-out now ends the FabOrchestrator session too**, not just this app's copy
of it. FO's `/api/auth/logout` deletes the session record and closes its audit
row, so its logs record a sign-out rather than a session that went quiet.
Verified against the live platform: a token that answered `200` before sign-out
answers `401` after. If FO is unreachable the cookie is still dropped, and the
response says honestly whether the platform was told.

The scope of that call was checked before relying on it, because the original
code refused to make it on the grounds that it would sign the operator out of a
FabOrchestrator tab open elsewhere. **It cannot.** FO's logout deletes one row
by token (`deleteSession`), and every login mints a fresh token with no reuse,
so other sessions belong to other tokens. The old objection was wrong about the
mechanics, not merely outweighed.

**An administrator has full central revocation, and this app inherits it.** FO's
admin console can force-logout a user (deleting every session row), suspend an
account, or force a password change. The PWA holds no independent access — only
a token FO validates on every call — so an admin action lands on the next
request as a 401, which the proxy already handles by clearing the cookie and
asking for a fresh sign-in.

### Phase 2 — complete

| WP | What | Days | State |
|---|---|---|---|
| WP5 | Conversation handling — follow-ups in one thread, stop mid-answer | 0.5 | **Done** |
| WP7 | Agent menu with the Master Data Load Agent's availability check | 1.0 | **Done**, reduced |
| WP13 | **Ask-first routing** — type on the landing page, the system picks the agent | 2.0 | **Done**, no logic needed |

**M2 / B2 are closed.** The last two packages were budgeted at 3.0 days and cost
close to none of it, because a product decision removed the work rather than
engineering completing it.

#### The decision that closed them

**Jothi confirmed on 2 September that the Master Data Load Agent is not part of
the PWA.** Loading MES master data is not what a supervisor does one-handed on a
fab floor; that agent's real workflow is file upload, staged review and a load
step, none of which this app carries.

PRD §18.2 had predicted exactly what this would do, which is why the 2 days were
held rather than spent:

- **Nothing left to route between.** Three of the four cockpit cards were already
  the same service (`/api/chat`). With the fourth gone, every exposed agent is
  that one service, so ask-first needs no classifier — the question goes
  straight there. **WP13's 2 days buy nothing.**
- **Nothing left to check availability for.** `modeling_agent` was the only
  permission gate, and `/api/chat` does not answer 403 itself. **WP7 reduces to
  the registry and routing that already existed.**

What was actually built for this: the agent removed from the registry, its screen
deleted, its card greyed on the landing page with the reason on it, and the proxy
now 404s that agent before touching FabOrchestrator.

#### And half the requirement was already the platform's

Worth recording, because it was nearly built twice. FO's own `/api/chat` is a
tool-using agent: it loads the caller's authorised MCP tools and lets the model
choose among them over up to twenty steps (`stopWhen: stepCountIs(20)`, upstream
`e5a5abd`). *"The system determines the appropriate tool and data path and
performs the routing automatically"* was therefore already true, in the platform,
before this app did anything. Only agent-level selection was ever missing — and
that is now moot.

**Verified in a browser against the live platform**, 10/10: all four cockpit
agents still shown, the Master Data Load Agent shown but not openable and marked
`aria-disabled`, no link anywhere to the removed screen, `/modeling-agent` 404,
the proxy refusing that agent before calling FO, and a question typed on the
landing page carried into a thread and answered without anything being
selected.

### WP5, as built

**The conversation's rules moved out of React.** `lib/faborch/conversation.ts`
holds every transition — what a stop keeps, what an empty answer leaves behind,
when a thread is full — as a reducer. The screen renders what it produces and
owns the network call. That is what made the layer testable without rendering
React, which is why it had no tests before.

- **Stop keeps what arrived.** One rule covers three endings that looked
  different: a stop, a stream that ended with nothing in it, and a failure
  part-way through. An assistant turn that received no characters is dropped; one
  that received something is kept, whatever ended it.
- **The closure hazard is gone.** `send` no longer closes over `turns`, so it is
  no longer rebuilt on every token, and the ref the seeding effect needed to work
  around it went with it. A second guard was added that the old code did not
  have: two Enters in the same frame both read a `busy` React has not re-rendered
  yet, so the in-flight check is a ref set before the request rather than state.
- **A full thread now says so.** See below — the previous behaviour was worse
  than the plan recorded.

**Verified in a real browser against the live platform**, not only in tests:
ask, read, follow up *understood in context*, stop mid-answer keeping the partial
text, ask again afterwards, and no empty bubbles left anywhere. 10/10.

#### One plan assumption was wrong, and the truth was worse

The plan said a long conversation is **silently truncated**, losing the
beginning. **It is not, and never was.** Nothing in this app truncates anything.
The client posts the whole thread; `FabInsightRequestSchema` caps it at **100
messages of 20,000 characters** (not 64 — the 64 is the parts-per-message cap),
and over that the route returns a 400 carrying zod's own words:

> Too big: expected array to have <=100 items

That reached the screen verbatim, and it failed identically on every retry, so
the thread was dead with no explanation and no way out. A schema library's
sentence, in a conversation, to a supervisor.

Fixed as a defect, not as a product decision: the limits are now checked before
the request is made, and the screen says the conversation is full and offers a
new one. **It still does not truncate** — whether it should is PRD §9, an open
question, and quietly dropping the start of somebody's thread is not a choice to
make by accident inside a work package.

### Phase 3 — next, and no longer fully blocked

| WP | What | Days | State |
|---|---|---|---|
| WP1 | Mobile app foundation — install to home screen, one-handed layouts | 1.5 | **Built; device acceptance outstanding** |
| WP8 | Live plant data answers — connection resolution, readable tables | 1.5 | **Partly unblocked** |

**WP1 is built and measured.** `docs/probes/2026-09-03-wp1-mobile-audit.md`:
16/16 at 360×640 and 390×844, with touch emulation so the app's own
coarse-pointer rules actually apply. Two real defects were found and fixed —
the section nav scrolled the whole page sideways (five pills, 561px wide, at a
360px viewport), and the composer sat 916px down a 640px screen because the
shell was `min-h-full` rather than a definite height.

A third finding was an artefact of the measurement, not a defect: six
"undersized" tap targets were correctly sized all along, because the app's 44px
minimum sits behind `@media (pointer: coarse)` and a headless context reports a
*fine* pointer. The first run had been measuring a desktop that will never
exist. Two of the seven were real and are fixed.

Only its **final acceptance needs a physical handset** — iOS install behaviour
cannot be verified any other way.

WP8 was recorded as blocked outright, which was wrong: the metric path
returns real yield, scrap and OEE figures on this account today, so the table
rendering and the no-data guard can both be built and demonstrated now. What
stays blocked is the MCP half — WIP, lots, equipment, throughput, downtime.

Phase 4 (dashboards, progress, failure handling) and Phase 5 (tests, device
validation, security review, handover) follow.

---

## Blocked on someone else

| # | Blocker | Blocks | Who clears it |
|---|---|---|---|
| 1 | **The probe account has zero MCP data connections.** Probe P4: `0 connected of 0 visible`. **Narrower than we reported** — see below: metric questions already answer from real plant data without them | The MCP tool path only. Not the metric path | A FabOrchestrator administrator, assigning MCP connections to that account's role |
| 2 | ~~The Fly deployment is stale~~ **Cleared 3 September.** Live at `https://faborch-demo.fly.dev`, TLS 1.3, carrying everything through WP1 | — | Done |
| 3 | **The FabOrchestrator fixes are not deployed.** Written and tested on an unpushed branch in another team's repository | A demonstration can still produce an invented dashboard | Whoever owns FabOrchestrator, on your word |

Blocker 1 is still worth chasing, but it blocks less than this file claimed
until 3 September. **Correction:** we had been reporting that plant questions
cannot be answered at all. They can. FabOrchestrator answers yield, scrap and
OEE questions from a direct database connection that has nothing to do with MCP
connections, and it does so on this account today. What the missing connections
block is every *other* plant question — WIP, lots on hold, equipment status,
throughput, downtime — which do go through the MCP tool path.

Blocker 2 is cleared: the app is deployed, over HTTPS, and a real sign-in works
from it. Blocker 3 is the one that matters for a customer demonstration — until
the platform carries the grounding fixes, asking it for a dashboard without the
dashboard permission still produces one filled with invented figures.

---

## FabOrchestrator's own routing, and two defects in it

**Jothi was right.** The platform does substantial request routing inside
`/api/chat`, before the model is called, and this project had not looked at it.
There is a 5,033-line `lib/fabinsight/` subsystem nobody here had opened.

### The three paths, verified in source at upstream `e5a5abd`

| Path | How a turn gets there | What runs |
|---|---|---|
| **Metric** | `detectMetricAsk()` — an ask verb within 40 characters of yield / scrap / OEE | Fixed server-side SQL. **Not MCP** |
| **Dashboard** | `matchDashboard()` — scored vocabulary match against seven curated deck prompts | Fixed SQL plus a pre-rendered artifact |
| **Fallback** | everything else | The MCP tool loop; the model writes its own SQL |

`lib/fabinsight/mcp.ts` is named misleadingly: it connects **directly to SQL
Server** with server-side credentials. That is why the metric path works on an
account with no data connections at all.

**Measured live, before any change:**

| Asked | Tools used | Result |
|---|---|---|
| "Give me the yield by product." | none | **A real table of real products** |
| The Factory Operations deck prompt | code_execution | **An invented dashboard, "illustrative sample values"** |
| "How many lots are currently in WIP?" | code_execution | "no live production data connected to this session" |

### Two defects, root causes, and the fixes

**1. A dashboard request from a user without the permission fabricated one.**
`canCreateDashboards` sat *inside* the match condition, so a denied dashboard
came back `undefined` — indistinguishable from "not a dashboard request" — and
the turn fell through to ordinary chat. The system prompt's `<artifacts>` block
is a long, emphatic instruction to build the thing when asked and says nothing
about data, so the model built one and invented the figures. The prompt's
"NEVER fabricate data" rule already existed; it lost to the more specific
instruction. **Fixed:** match first, check permission second, refuse with 403
before the model is called.

**2. A metric ask whose data source was down answered from general knowledge.**
`buildMetricBrief` ended in a bare `catch { return null }`, and `null` also
meant "no metric was asked for". **Fixed:** a discriminated result; the route
refuses the turn rather than guessing.

**And a third case that is neither:** an ordinary question on an account with no
connected tools. Nothing detected it. **Fixed** by stating the absence on the
user's message — the same mechanism the glossary and the metric brief already
use — naming the artifact case explicitly, while still permitting ordinary
answers to questions that need no plant data.

### The matcher had two false positives, found by measuring it

`"Give me cycle time by step."` and `"Which equipment is running?"` each
returned the **whole Factory Operations dashboard**. Both won on precision
alone: three common fab words that happen to appear in a long deck prompt,
covering 20% and 13% of it. This mattered more after fix 1 — a matched
dashboard is now *refused* rather than quietly ignored, so an ordinary question
about cycle time would have been answered with a permission error.

**Fixed:** precision counts only when the user named the dashboard ("lot
history") or said enough to be editing a deck prompt. Measured: a full prompt
carries 15 content words, a heavily edited one 8, these two 3. The floor is 6.
All seven deck prompts and an edited one still route.

### Coverage: where wording still decides the answer

Measured across 21 realistic phrasings. Deterministic routing covers **three
metrics and seven dashboards**; everything else needs MCP tools.

Fixed: the ask verbs missed "how is" / "how are", so *"What is the OEE?"*
returned real figures while *"How are we doing on OEE?"* returned nothing.
Inflections ("scrapped") now match too.

**Not fixed, deliberately:** *"Which products are scrapping the most?"* is still
missed. Adding "which" to the verb list fires on *"I'm not sure which column the
yield is in"*, which would answer a spreadsheet question with a factory-wide
yield table. The limit is recorded in a test rather than left to be
rediscovered.

**Uncovered intents** — WIP, lots on hold, equipment status, throughput,
downtime, cycle time — have no deterministic path and no fixed SQL behind them.
Adding one is real product work, not a routing tweak, and is **not** done here.

### Observability

`X-FabOrch-Route` on every response, one of `metric` | `dashboard` |
`dashboard-denied` | `metric-unavailable` | `mcp` | `no-data`, plus a log line.
The prose never said whether an answer was grounded; this does. The PWA proxy
forwards it — one line, and the only PWA change in this work.

### Where this sits, and what is *not* verified

The platform changes are committed to **`fix/grounded-routing` in the
FabOrchestrator clone** (`LLM-AT-SCALE/FabOrchestrator_product_code`), **not
pushed and not deployed** — that repository is not ours to push to
unilaterally.

- **Verified:** 21 new tests, full typecheck clean (0 errors before and after),
  lint clean, and the existing errors/validation suites still at 35 and 17.
- **Verified live:** the *current* broken behaviour, before the change.
- **Not verified live:** the fixed behaviour. It needs an FabOrchestrator
  deployment carrying the branch. Until then the fixes are proven by test and by
  source, not by observation.

The PWA's own change — forwarding the header — is verified live: answers still
stream (first byte 1.2 s) and the header is correctly absent against today's
platform.

---

## Known debt

**The planning documents are stale as of 2 September 2026, and this is the one
piece of documentation work outstanding.** They describe exposing the Master Data
Load Agent, budget WP7's availability check, and budget 2 days for WP13's
routing. All three are now wrong — PRD §18.3. They said they needed updating
once the agent question was answered, and not before; it is answered.

Earlier decisions they asked for *are* recorded as taken — the production-order
workflow removed, the demo running against the live deployment, the manifest-`id`
call.

One earlier entry here was wrong and is corrected: WP8 and component C7 were
never stale. They describe FabOrchestrator's own MES data reached over MCP, not
the removed mock workflow, and needed no change.

Still not reflected in the plans, because they are plans rather than status:
progress against each work package lives in this file, not in them.

**Not verified by a person.** Everything above was checked by tests, probe
scripts and a headless browser. The app has not yet been confirmed working in a
human's browser on this machine.

---

## How to run it

```bash
npm install
cp .env.example .env      # set FABORCH_BASE_URL, SESSION_SIGNING_SECRET
npm run build && npm start        # http://localhost:3002
```

Sign in with a **FabOrchestrator account**. There is no demo credential any
more; a session that could not use the platform was worse than no session.

```bash
npm test                          # 174 tests, no network needed
npx tsx scripts/probe-faborch.ts  # the five live environment probes
npx tsx scripts/e1-live-check.ts  # the M1 gate, against a running app
```

---

## Where things live

| Path | What |
|---|---|
| `lib/faborch/` | The only code that knows FabOrchestrator's HTTP contract |
| `app/api/faborch/[agent]/chat/` | The connector — holds the credential, streams the answer back |
| `app/api/auth/` | Sign-in, sign-out, session |
| `docs/planning/` | The four planning documents (see debt above) |
| `docs/probes/` | Evidence: the environment probes and the E1 report |
| `CLAUDE.md` | The design record — why things are the way they are |
