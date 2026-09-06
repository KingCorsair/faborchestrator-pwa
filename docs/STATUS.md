# Where this project stands

**As of 5 September 2026.** Working tree clean, all commits pushed to `KingCorsair/faborchestrator-pwa` (private).

This file is the running answer to "where are we and what is left". It records
what has been *proved*, not what has been written — anything claimed here has a
test, a probe report, or a browser run behind it. When the two disagree, this
file is wrong and should be corrected.

---

## Where this stands

**Phases 0 to 5 are complete.** Every build package is done, and the handover
pass is finished: the whole suite re-run against the deployed app, a security
review of the running deployment, the five user journeys walked end to end, and
the operating documentation written.

**Nothing is outstanding in this app.** What remains is external and listed in
`docs/OPEN_ISSUES.md` — most urgently, a **shared demo password that must be
rotated** because it reached the Fly request logs during the 3 September sign-in
investigation.

**The cockpit answers where it is asked, since 5 September.** The ask bar used
to navigate to `/fabinsight?q=…`; it now expands into the conversation on the
landing page, the way FabOrchestrator's own cockpit does. It is the same
`AgentChat` component the conversation screen uses, in an `inline` variant that
changes layout only — no second chat implementation, no new prompt, model or
routing logic, and the same `/api/faborch/insight/chat` → FO `/api/chat` path
underneath. The GET form is still there as the no-JavaScript fallback. Verified
by `scripts/landing-ask-check.mjs`, 24/24 on the deployment.

**The agent screens have a conversation sidebar, since 5 September**, and it
lists the operator's **real FabOrchestrator conversations** — the same threads
the FabOrchestrator website shows, because they are the same rows. A thread
started on a phone appears on the website, and one started there opens here.
This app stores none of it: no database, no cache, no copy. Below 768px the
product renders its own sidebar as a slide-over, and this is that, at the same
288px. Full write-up below: "The agent screens got a conversation sidebar".

**One defect was reported and fixed on 4 September**, from the installed iPhone
app: after signing out and force-quitting, reopening from the Home Screen showed
the cockpit as though the session were still live. It was a presentation defect
with no residual access — `/` was simply the one screen that read no session,
and `start_url` points at it. Fixed with a server-side session gate in
`proxy.ts`, deployed and verified on the URL. Full write-up below: "The cockpit
opened for somebody who had signed out". **The one thing left on it is a check
on a physical iPhone**, which no automation can stand in for.

**Where to start reading:** `docs/HANDOVER.md` is the operating note — how to
run it, what every failure message means, and the four decisions that look odd
until you know why. `docs/OPEN_ISSUES.md` is everything still open, all of it
external to this app.

**The one job that needs a person:** rotate the shared FabOrchestrator demo
password. `OPEN_ISSUES.md` §1.

**The deployment is current**, and deploying found a defect that every local
check had missed — see "Sign-in could silently do nothing" below. WP10 is live
and verified on the URL itself.

**Two things are waiting on someone else, and neither is a defect in this app:**

- **The FabOrchestrator grounding fix is written, tested and unpushed.** Until
  it ships, a demonstration can still produce a dashboard full of invented
  figures. `docs/FABORCHESTRATOR_ROUTING_GROUNDING_BUGS.md` is the write-up to
  send. Nobody has been asked yet.

  This one bears directly on WP9. That package renders artifacts, and the defect
  is an artifact full of made-up numbers — so the better WP9 gets, the more
  convincing a fabricated dashboard becomes.

- **FabOrchestrator answers some MES questions differently each time.** "How
  many lots are currently in WIP?" returned 424, 237, 237, 427 and 427 from five
  *unchanged* requests, and 10,904 on an earlier pass. The model picks a database
  view and writes SQL per request; the 237/427 split is one missing `WHERE`
  predicate, over whether suspended lots count as WIP. **The PWA forwards
  correctly — verified by recording its outbound traffic — and FabOrchestrator's
  own website disagrees with itself by more than it disagrees with the PWA.**
  Yield is stable on both because FO answers it from a fixed metric path that
  never reaches the tool loop.

  `docs/FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md` is the write-up to
  send, and `OPEN_ISSUES.md` §6 is the summary. **Nothing to fix here**, and
  specifically not by pinning a query in this app. It matters for a
  demonstration: lead with the yield question, which is deterministic.

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
- **Real plant data now answers, both ways.** An administrator switched on the
  data connections. "How many lots are in WIP?" comes back **237**; "which
  equipment is running?" comes back **7**; "give me the yield by product" comes
  back as a real table. This was the thing we had been calling blocked.
- **The app is live on a real URL and works on a phone.** Installed to an
  iPhone home screen, confirmed by hand — not only by tests. Everything above
  was then re-checked against that URL rather than a laptop.
- **Reports work.** A supervisor can read the dashboards an administrator
  pinned in FabOrchestrator. Ten of them, on the phone, read-only.
- **The app fits a phone properly.** Two real layout faults found by measuring
  it: the menu dragged the whole page sideways, and the typing box sat below
  the bottom of a small screen.
- **Dashboards work.** Asking for a chart used to fill the answer with raw
  HTML. It now arrives as a tile you tap to open full screen, in a frame that
  cannot reach anything else in the app.
- **The app says what it is doing, and what to do when it cannot.** It now
  distinguishes "sent", "looking something up — and here is what", and
  "answering", instead of one spinner that means all three. Every failure says
  what to do next, and offers to try again only where trying again can work.
  If nothing arrives for 45 seconds it says so rather than spinning silently.
- **308 automated tests pass** here, and 21 more on the platform side. They run
  without a network. (272 on 3 September; 23 more on 4 September with the
  cold-launch session gate; 13 more on 5 September with the inline cockpit ask.)
- **The whole suite was re-run against the live URL, not a laptop**, plus a
  security review of the running app (24 checks) and the five user journeys
  walked end to end (13 steps). All pass.

**Pending**

- Nothing. The build and the handover pass are both finished.
- The four planning documents still describe four agents and budget work that
  no longer exists.

**Waiting on someone else** — the full list is `docs/OPEN_ISSUES.md`

- **A shared demo password must be rotated.** During the sign-in investigation
  the login form briefly put credentials in a URL, which reached Fly's request
  logs. The bug is fixed and cannot recur; the exposure already happened. It is
  the shared demo account, not a personal one, and not an administrator.
- **The FabOrchestrator fix has not been shipped.** We found the platform
  inventing plant figures when someone without dashboard permission asks for a
  dashboard. The fix is written and tested but sits in another team's
  repository. Until it ships, a demonstration can still show made-up numbers.

**Now claimed:** the app has been used by hand, on an iPhone, on 3 September.

---

## In one paragraph

The app is a mobile front door to FabOrchestrator and nothing else. A person
signs in with their own FabOrchestrator account, holds a live streaming
conversation with its agents through a server-side connector that holds the
credential, reads the dashboards an administrator pinned, and sees only what the
platform actually offers. **Every build package is complete and proved against
the live deployment**, including the one the business case rests on: a real
plant question, answered from real MES data, on an installed phone. What remains
is Phase 5, which builds nothing. Nothing in the app is blocked. What is outstanding
sits with other people: a deploy of the platform's grounding fix, and the plans
catching up with two decisions.

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
| **WP1** Mobile app foundation | **Accepted.** `docs/probes/2026-09-03-wp1-mobile-audit.md` — 16/16 at 360×640 and 390×844 with touch emulation, two real faults found and fixed. **Physical-device acceptance confirmed 3 September**: installed to an iPhone home screen, and the airplane-mode offline page answered. Those were the two remaining criteria |
| **WP10** Progress & failure handling | 29 tests + `scripts/progress-states-check.mjs`, 6/6 live. Three progress states observed in sequence in a browser against the live platform, naming FO's own tools; one error table with a next step per code; `errorId` copyable; a 45s stall watchdog that warns without ending the turn |
| **WP8** Live plant data answers | Both paths verified through the app against the live platform: 237 lots in WIP and 7 tools running via MCP, a real yield table via the metric path. Sticky first column for wide tables; the missing-connection state named honestly rather than refused |
| **Reports** Read-only pinned dashboards | 14 tests + `scripts/reports-live-check.mjs`, 9/9 live: 10 real dashboards read on a non-admin account, every management verb refused, and reading provably does not overwrite the shared snapshot |
| Scope correction | The production-order workflow and its mock MES are removed; the nav mirrors FabOrchestrator's own cockpit; the Master Data Load Agent is shown greyed rather than opened; the platform capability list is gone |

**308 tests, all passing.** Typecheck and lint clean. Production build compiles. The mobile audit is 16/16 at both viewports.

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

### Phase 3 — complete

| WP | What | Days | State |
|---|---|---|---|
| WP1 | Mobile app foundation — install to home screen, one-handed layouts | 1.5 | **Accepted.** Install and offline both confirmed on an iPhone |
| WP8 | Live plant data answers — connection resolution, readable tables | 1.5 | **Done.** Both paths answer from real MES data |

**Phase 3 is closed.** Both packages are done, and the capability the business
case rests on — a real plant question answered from real MES data on an
installed phone — works end to end.

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

**WP8 is done, and its plan line was wrong.** The plan said "refuse to send a
turn with an empty tool list". Measured against the live platform, that would
have withheld a working answer: with `activeMcpIds` explicitly empty,
FabOrchestrator still returns a real yield table, because its metric path reads
the warehouse directly and never touches MCP. So the count is reported rather
than acted on, and the screen names the half that is missing instead of blocking
the half that works. Wide tables now pin their first column, because a
seven-column yield table at 360px put the figures off-screen and scrolling to
reach them lost the product name.

---

### Phase 4 — complete

| WP | What | Days | State |
|---|---|---|---|
| WP10 | Progress, loading & error handling | 2.0 | **Done.** 29 tests; three states seen in sequence in a browser |
| WP9 | Dashboards & artifacts — parse `<antArtifact>`, render sandboxed | 3.0 | **Done.** 23 tests; 8/8 live on the deployment |

**WP10 is done.** Three progress states, one error table with a next step per
code, `errorId` copyable, and a 45-second stall watchdog that warns without
ending the turn. Evidence is in the table above and in
`scripts/progress-states-check.mjs`.

**WP9 is done, and it was the last build package in the plan.** An artifact
answer used to render its raw `<antArtifact>` markup as markdown — a wall of
HTML mid-sentence. It now arrives as a tile in the answer and opens full screen.

The parser is a **port, not an import**: FO's `lib/artifact-parser.ts` at
upstream `e5a5abd`, with both tag regexes and the attribute regex verified
byte-identical against the real file, and a test that fails if they drift. The
two apps are separate deployments with no shared package, so a copy was the only
option; making it a *diffable* copy was the choice.

**The sandbox** is `allow-scripts` with no `allow-same-origin`. Together they
cancel the sandbox — the frame takes the embedder's origin and can reach its
cookies, storage and DOM. FO's own pages use both, survivable there because
frame and page share an origin anyway; not here, where this app holds an
httpOnly FO token and the document was written by a model. Asserted in two test
files.

**Accepted and stated rather than silent:** artifacts pull Tailwind and Google
Fonts from CDNs, so the frame needs the network. Blocking it would leave the
dashboard unstyled, which is worse. It sends no referrer.

**Verified live**, on the deployment: a real *Yield by Product Dashboard*
arrives as a tile, opens in an `allow-scripts` frame at 390×779, offers its
source, and the page overflow stays 0. `scripts/artifact-live-check.mjs`.

**It sharpens a dependency nobody owns.** WP9 renders artifacts; the unshipped
FabOrchestrator fix is about artifacts *full of invented figures*. Until this
package the raw markup was ugly enough that nobody would mistake one for a real
report. It no longer is. See "Blocked on someone else".

### Phase 5 — complete

Tests, device validation, security review, handover. No build work; it was the
evidence pass over what Phases 0–4 produced, and it is done — see "Phase 5 — the
handover pass" above for the results.

---

## Sign-in could silently do nothing, and only the deployment showed it

Deploying WP10 broke sign-in on the deployed URL while every local check
passed. Worth recording in full, because the shape of it matters more than the
fix.

**The defect.** The credential fields were controlled inputs bound to React
state that does not exist until hydration. The page is server-rendered, so it
paints and accepts typing before that — and on hydration React reconciles each
field to its empty state and **erases what was typed**. The fields are also
`required`, so the next press is blocked by native validation, which fires no
submit event and shows nothing the page can report. Sign-in did nothing at all:
no request, no error, no change on screen.

**Why local testing could never find it.** The window is the gap between paint
and hydration. On localhost it is too narrow to hit. On Fly, across the public
internet to Singapore, it is wide enough to hit by hand — and a phone on
fab-floor signal is wider still, which is this app's entire target.

**Three attempts, because the first two fixed symptoms.**

| Attempt | What it addressed | Why it was not enough |
|---|---|---|
| Read `FormData` at submit | State was empty while the field showed text | React had already wiped the DOM too |
| Adopt the value in an effect | Keep what was typed | Effects run *after* React commits the reset |
| **Uncontrolled fields** | React never touches the value | — |

The second attempt also **introduced a worse bug than the one it fixed**: naming
the fields made the form natively submittable, and a pre-hydration press did a
native GET, putting `?email=…&password=…` in the address bar. Caught on the next
deploy by the same check. Two guards remain from it and are still right — the
submit button waits for hydration, and the form is `method="post"` so anything
that escapes carries the credential in a body rather than a URL.

**Verified on the deployment:** typing immediately on `domcontentloaded`
survives hydration, and sign-in completes. `scripts/hydration-typing-check.mjs`.

**Note for whoever owns the demo account:** the probe credential appeared in a
URL during these checks, so it is in the Fly request logs. It is the shared demo
account rather than a personal one, but it should be rotated.

---

## The cockpit opened for somebody who had signed out

**Reported 4 September 2026**, on the installed iPhone app: sign in, sign out,
force-quit from the app switcher, reopen from the Home Screen — and the app
opened on the cockpit as though the operator could carry on. Pressing an agent
card was the first thing that said otherwise.

### It was never an access-control failure

Worth stating first, because the symptom reads like one and it was not. Nothing
behind `/api/` was reachable. Sign-out worked perfectly: the FabOrchestrator
cookie was deleted, FO's own session row was deleted (`faborchRevoked: true`),
and `localStorage` was cleared. What leaked was the *appearance* of a session —
four agent cards, a Live ops panel and a Recent activity feed shown to somebody
with no right to see them. For a product whose whole argument is that you do not
show a supervisor a number you cannot stand behind, that is its own kind of
wrong, but it is not a breach.

### The root cause

`/` was the one screen in the app that read no session, and
`manifest.webmanifest` sets `start_url: "/"` — **so every cold launch of the
installed app landed on the only page that never asked who you were.** Every
session check lived in `useSession`, which runs on the screens behind the
cockpit.

The landing page read nothing deliberately, so the front door would paint before
any bundle arrived. That was right while `/` was a public front door. It stopped
being right the moment the front door became the app's start URL.

Nothing was broken. The check simply was not there.

**Reproduced on the pre-fix build** before anything was changed — Chromium with
an iPhone profile, a persistent profile directory, and the service worker
installed and controlling:

```
1. signed in, at: /          service worker: controlled
2. signed out, at: /login    cookies left: (none)
3. COLD LAUNCH lands at: /   shows cockpit: true   shows sign-in form: false
```

`cookies left: (none)` is the line that matters: sign-out had done its whole job.
`GET /` with no cookie returned `200` carrying the full cockpit markup.

### Three suspects that were cleared, and how

| Suspect | Verdict |
|---|---|
| Service worker replaying a cached app shell | **No.** It caches `/offline` and two icons, intercepts navigations only, and answers every one from the network. Now pinned by tests that assert what it *asks the cache for* |
| Stale client session being restored | **No.** `clearAuthStorage()` removes both keys, and the landing page never read them |
| Cookies not actually cleared | **No.** `Max-Age=0` on sign-out, verified in the `Set-Cookie` line and in the browser's jar afterwards |

### The fix

**`proxy.ts`** — a deny-by-default session gate in Next middleware, which
answers before the document exists. A client-side check could not have fixed
this: it cannot run before the HTML it is meant to suppress has painted, and a
cold standalone launch is where that gap is widest.

It reads the `faborch_token` httpOnly cookie — the only half of the session a
server can see on a navigation, the credential `requireAuth` cannot proceed
without, and the thing sign-out deletes. `PUBLIC` is an allowlist (`/login`,
`/offline`, `/diagnostics`), so a screen added later is gated on the day it is
created rather than the day somebody remembers.

Named `proxy.ts` because Next 16.1 deprecates the `middleware.ts` convention.

**`sign-out-link.tsx`** redirects instead of rendering nothing when it finds no
token — a backstop for the one state the server cannot see (FO cookie present,
`localStorage` empty), not the gate.

**The consequence to know:** `/` is no longer public. A visitor with no session
meets `/login` first and gets the cockpit after signing in.

### The bug inside the fix, which is why there is a live check

The `matcher` was first written `"/((?!api/|_next/|.*\.[^/]+$).*)"`. That is a
regular expression inside a string literal, so `\.` parses as a bare `.`, the
lookahead then matches almost every path, and the gate is excluded from the
routes it exists to protect.

**It built, typechecked and passed all 295 tests**, because those tests call
`proxy()` directly and never see the matcher. It would have deployed as a fix
that did nothing at all. Caught by reading the file, and now caught by
`scripts/gate-live-check.mjs`, which requests `/sw.js` and the manifest over the
wire — the assets a broken matcher redirects.

### Verified on the deployment

Not on a laptop, for the reason the section above this one records.

| Check | Result | Script |
|---|---|---|
| Unit and integration | **295 / 295** | `npm test` |
| The gate, over the wire | **32 / 32** | `scripts/gate-live-check.mjs` |
| Cold launch, real browser, worker-controlled | **11 / 11** | `scripts/cold-launch-check.mjs` |
| The five journeys, unbroken | **13 / 13** | `scripts/journeys-check.mjs` |

The cold-launch check performs the reported sequence exactly: `context.close()`
is the force-quit, a second `launchPersistentContext` on the same profile is the
Home Screen tap, and the profile carries the cookie jar, `localStorage` and the
registered worker across it. Three consecutive relaunches, because a gate that
lets the second one through would pass in the demo. The document trail on the
relaunch is `307 / → 200 /login`, so no cockpit is painted on the way.

### Still to do, by a person

**Check it on a physical iPhone.** The automation is Chromium with an iPhone
viewport and user agent — not WebKit, not iOS, and not a home-screen app in a
standalone window, so it cannot speak for Safari's cookie handling or for the
separate storage an installed iOS app may be given.

1. Sign in → sign out → force-quit → reopen. Expect sign-in, never a cockpit.
2. **The more important one:** sign in → force-quit *while signed in* → reopen.
   Expect the cockpit directly, with no bounce through sign-in. If this bounces,
   the cookie is not surviving Safari's standalone storage and the gate needs to
   read something else.
3. Airplane mode still reaches the offline page — it is on the public allowlist.

The installed copy does not need reinstalling: `id` and `start_url` are
unchanged.

### One limit, recorded rather than fixed

`/api/auth/me` answers `200` to a *replayed* pair — the bearer token plus a copy
of the FO cookie taken before sign-out. It returns only the id, email and role
already inside the token the caller is holding, and opens nothing: every route
that reaches FabOrchestrator refuses the same pair with `faborch_session_expired`
and drops the cookie on the way out, which makes a replay self-healing.

Making it ask FO would fix a leak of nothing at the cost of a real one.
`useSession` calls that route on every screen mount, and every authenticated call
to FabOrchestrator sets `last_activity_at = NOW()` — so the check would be a
keep-alive silently defeating FO's 30-minute idle eviction and corrupting its
session audit, which is somebody else's compliance record. `lib/auth.ts` recorded
and refused that trade before this change; nothing here alters it.

---

## Phase 5 — the handover pass

No build work. Everything below was run **against
`https://faborch-demo.fly.dev`**, not a laptop — a distinction this project
learned the hard way, because the sign-in defect found earlier the same day
existed only where hydration is slow enough to race, and a locally-run suite
kept passing while the deployed app could not be signed into at all.

| Suite | Result | Script |
|---|---|---|
| Unit and integration | **308 / 308**, no network | `npm test` |
| Security review | **24 / 24** | `scripts/security-review.mjs` |
| Session gate, over the wire | **32 / 32** | `scripts/gate-live-check.mjs` |
| Cold launch, real browser | **11 / 11** | `scripts/cold-launch-check.mjs` |
| Inline cockpit ask, real browser | **24 / 24** | `scripts/landing-ask-check.mjs` |
| User journeys, end to end | **13 / 13** across 5 journeys | `scripts/journeys-check.mjs` |
| Reports, read-only | **9 / 9** | `scripts/reports-live-check.mjs` |
| Artifacts | **8 / 8** | `scripts/artifact-live-check.mjs` |
| Progress states | **6 / 6** | `scripts/progress-states-check.mjs` |
| Mobile audit | **16 / 16**, two viewports | `scripts/mobile-audit.mjs` |
| Sign-in under slow hydration | pass | `scripts/hydration-typing-check.mjs` |

### The security review, and what it covers

`scripts/security-review.mjs` asks the running deployment what it does rather
than reading the source, and every check states what a failure would *mean* —
a red line with no consequence attached does not get acted on.

| Area | Checked |
|---|---|
| Transport | https serves the app; plain http 301s to https |
| Session | the FabOrchestrator token is `HttpOnly`, `Secure`, `SameSite=lax`, and never appears in a response body |
| Authentication | five guarded routes refuse an anonymous caller; a stolen bearer token without its cookie is refused; a forged unsigned token is refused |
| Authorisation | `POST`/`DELETE`/`refresh` on reports do not exist — absent, not merely hidden |
| Secrets | the FO host, the probe password and the signing secret appear nowhere in the served page |
| Sandbox | neither iframe pairs `allow-scripts` with `allow-same-origin` |
| Boundary | no model API key on the deployment, no model SDK imported anywhere |

**Both faults it found on its first run were in itself**, which is worth
recording because it is the failure mode of a checker nobody reads:

- a **false FAIL** on `reports.tsx`, matched inside a comment explaining that
  FabOrchestrator uses both sandbox flags and that this app deliberately does
  not. Documenting a hazard was being read as committing it. A checker that
  cries wolf over its own documentation is worse than none, because the next
  real finding gets waved through.
- a **false PASS**, which is worse: the model-SDK grep embedded a path
  containing a space into a shell string, git failed to parse it, the error was
  swallowed, and empty output was read as "no matches". It now distinguishes
  *found nothing* from *did not run*.

### The journeys

Five paths a person actually takes, walked in one session on a 390×844 touch
viewport. A set of green mechanisms can still add up to an app nobody can use.

| Journey | Proved |
|---|---|
| Sign in | reaches the cockpit, four agents listed |
| Ask a plant question from the front door | *"How many lots are currently in WIP?"* → **237 lots**, real figures |
| Ask a follow-up | both turns held in one thread |
| Read a pinned dashboard | 11 listed, opens `sandbox="allow-scripts"`, **no pin/unpin/refresh control offered** |
| Sign out | returns to sign-in, and the kept token then authenticates nothing (401) |

Journey 3 failed twice before I looked properly, and the fault was the walk:
the composer is deliberately disabled while a turn is in flight, and the check
was typing the follow-up as soon as the first tokens appeared. It now waits for
the turn to settle, which is what a person does.

### Handover documentation

- **`docs/HANDOVER.md`** — what the app is and is not, how to run and deploy it,
  every failure message and what to do about it, the four load-bearing decisions
  that look odd out of context, and who owns what.
- **`docs/OPEN_ISSUES.md`** — five open items, all external, each with an owner
  and a severity.

`playwright` also became a devDependency: the check scripts were committed but
imported a package the repo did not have, so they could not run from a clean
checkout. A committed script that cannot run is a handover trap.

---

## The live deployment

**`https://faborch-demo.fly.dev`** — commit `67043fd`, deployed 3 September,
one machine in `sin`, `started`. Carries every work package through WP10.

Verified against the deployed URL after shipping, not against a local server:

| Check | Result |
|---|---|
| TLS | 1.3, `TLS_AES_256_GCM_SHA384`, Let's Encrypt, chain authorized |
| `http://` | 301 to `https://` |
| Installability | manifest, service worker, offline page, icons all served |
| Sign-in | a real FabOrchestrator account, 200, token in a `Secure; HttpOnly` cookie |
| Reports | 9/9 — 10 pinned dashboards read on a **non-admin** account; POST/DELETE/PUT 405, refresh 404; `refreshedAt` unchanged after reading |
| Plant data, tool path | *"How many lots are currently in WIP?"* → **238 lots**, 8 MCP calls |
| Plant data, tool path | *"Which equipment is running right now?"* → **5 running of 39 tracked**, as a table |
| Plant data, metric path | *"Give me the yield by product."* → a real product table, no tools |
| **WP10 progress states** | 6/6. Observed in order on the deployed URL: *Sent to FabOrchestrator…* → four *is running `mcp_…`* lines → *Answering…* |
| **Sign-in under a slow hydration** | Typing on `domcontentloaded` survives; sign-in completes |
| **WP9 artifacts** | 8/8. A real *Yield by Product Dashboard* arrives as a tile, opens `sandbox="allow-scripts"` at 390×779, source offered, page overflow 0 |

The two figures moved between the localhost run an hour earlier (237 lots, 7
tools) and this one (238, 5). That is not a discrepancy — it is what live plant
data looks like, and it is the clearest evidence that nothing here is a fixture.

Reproduce with:

```bash
node scripts/reports-live-check.mjs        # point APP at the deployed URL
```

---

## Blocked on someone else

**The maintained list is `docs/OPEN_ISSUES.md`**, which carries an owner and a
severity for each. The table below is the history of how they moved.

| # | Blocker | Blocks | Who clears it |
|---|---|---|---|
| 1 | ~~The probe account has zero MCP data connections~~ **Cleared, found 3 September.** The account now carries 2 connected: `CMF_Assembly_DB_Test3` and `CM MES - Assembly (Use Cases)` | — | An administrator did it |
| 2 | ~~The Fly deployment is stale~~ **Cleared 3 September.** Live at `https://faborch-demo.fly.dev`, TLS 1.3, carrying everything through WP1 | — | Done |
| 3 | **The FabOrchestrator fixes are not deployed.** Written and tested on an unpushed branch in another team's repository | A demonstration can still produce an invented dashboard | Whoever owns FabOrchestrator, on your word |
| 4 | ~~Stale secrets on the Fly deployment~~ **Cleared 3 September.** The five unused ones are gone, including the live `ANTHROPIC_API_KEY`; only `SESSION_SIGNING_SECRET` remains, which the app requires | — | Done |

**Blocker 1 is cleared.** An administrator assigned connections at some point
between 1 and 3 September. Verified through the PWA, against the live platform:

| Asked | Tools used | Answer |
|---|---|---|
| "How many lots are currently in WIP?" | 6 MCP calls | **237 lots currently in WIP** |
| "Which equipment is running right now?" | 8 MCP calls | **7 pieces of equipment running** |
| "Give me the yield by product." | none — metric path | A real table of real products |

Both halves of plant data now answer. That is **M3's core capability working end
to end**: a real question, real MES data, through this app.

The earlier correction still stands and is worth keeping: those two paths are
different. Yield, scrap and OEE go through FabOrchestrator's own metric path,
which reads the warehouse directly and never consults MCP — which is why they
answered even when the connection count was zero.

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

**Proposed, on the unpushed branch — not something FabOrchestrator does today.**
An `X-FabOrch-Route` response header, one of `metric` | `dashboard` |
`dashboard-denied` | `metric-unavailable` | `mcp` | `no-data`, plus a log line.
The prose never says whether an answer was grounded; that header would.

**Corrected 5 September.** This paragraph used to end "The PWA proxy forwards it
— one line, and the only PWA change in this work", and the proxy did carry that
line. It was inert: the header exists in no shipped FabOrchestrator, so nothing
was ever forwarded, while the code and a test that fabricated the header in a
stub both implied a working integration. Both are removed. If the grounding fix
ships, the relay goes back — against the real header, with a check that reads
the platform rather than a mock.

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

## The agent screens got a conversation sidebar

Reported on 5 September: FabInsight and the Back-end Agent had no sidebar, and
somebody arriving from FabOrchestrator found a screen missing navigation they
had used minutes earlier. Shipped in two commits — the drawer, then the
conversations inside it.

### The drawer is FabOrchestrator's own mobile branch

The product does **not** render its 16rem rail below 768px. It renders a left
slide-over Sheet at 18rem, dismissed by backdrop, Escape or the trigger, and
every agent chat there mounts that same component
(`claudeai_athena/components/ui/sidebar.tsx:170-191`). So the desktop rail was
never the thing to copy, and this is not an invention: 288px of slide-over is
what FabOrchestrator itself shows on a phone.

Backdrop, Escape and a close button all dismiss it; focus enters on open and
returns to the trigger on close; a path change closes it. Closed, the panel is
`visibility: hidden` rather than merely translated off-screen — otherwise a
hundred conversation links stay in the tab order, one Tab away from the composer.

### Pinned and Recents are real, or they are absent

Every row is a conversation FabOrchestrator has, read live over the operator's
own bearer token. **This app owns none of it and stores none of it** — no
database, no cache, no `localStorage`. Four calls into what the product already
keeps:

| Purpose | FabOrchestrator endpoint |
|---|---|
| List | `GET /api/conversations?agent=chat` |
| Load one | `GET /api/conversations/{id}` |
| Create | `POST /api/conversations` |
| Pin / unpin | `PATCH /api/conversations/{id}` `{ isPinned }` |

Persisting a turn is not a fifth call. `/api/chat` writes both messages itself
when the request carries a `conversationId`, gated on one line —
`if (!conversationId) return` (`app/api/chat/route.ts:882`). That single line is
why this app had no history for its whole life until now.

FabInsight writes to the `agent = "chat"` bucket, **which is the bucket the
FabOrchestrator website reads**. That is the whole point of the feature.

Not proxied, deliberately: no delete (destructive, one tap from a thread list on
a phone), no rename, no search, no projects, and no `isShared` — that flag's only
consumer is `/share/<id>`, a page that exists in no upstream branch.

Conversations are created **lazily, on the first send**, exactly as
`full-chat-app.tsx:1425` does it. Creating one per New chat press would fill the
website's own sidebar with identical empty "New Chat" rows.

### A thread is stripped before it reaches the phone

Measured against production: ten sampled threads carried
`text ×274 · step-start ×211 · tool-* ×332 · file-download ×8`, and the largest
single thread was **1,306 KB of JSON for 18 messages** — nearly all of it
generated SQL and returned rows, none of which this app renders.

`lib/faborch/history.ts` reduces a thread to its text, and it runs in the
**proxy**, not the browser. Unknown part types are dropped by default, because
FO's `toUIMessage` passes unrecognised parts through verbatim: a part type added
to FabOrchestrator tomorrow must not reach a screen that has never heard of it.

One limit is reported rather than hidden. `FabInsightRequestSchema` caps a
message at 20,000 characters, so a stored answer longer than that can be read
here but not continued — the composer is replaced by a line saying so and
offering a new chat. Truncating what FabOrchestrator said to make a request fit
would misrepresent the product.

### An id from a browser is proved, never trusted

**FabOrchestrator's `/api/chat` accepts a `conversationId` and never checks whose
it is.** There is no `getConversation` and no `userId` comparison in that route;
the value goes straight to `addMessage` (`:338`, `:947`) and to the S3-reference
lookup (`:571`). Every *other* conversation route there checks ownership and
refuses with 403. That one does not.

So this app matches the id against the caller's own conversation list before
forwarding (`lib/faborch/owns.ts`), and an id that fails becomes `null` — the
question is still answered, it is simply not written down. Refusing outright
would punish an operator for a stale tab.

**The upstream gap is still open** and is FabOrchestrator's to close. This app
declines to be a vehicle for it; anyone calling FO directly is unaffected by
that. **It has not yet been written up for the FabOrchestrator team** — unlike
the routing and nondeterminism findings, there is no document to send them yet,
and there should be.

### The drawer stopped being a second copy of the navigation

It first shipped carrying Cockpit, Agents, Workflows, Sites and Reports — the
top bar again, in a panel. Those came out the same day the conversations went
in.

FabOrchestrator's own sidebar is the argument. It lists twelve nav entries and
**exactly one navigates**: Dashboard, to `/home`. The rest have no handler, and
FO's source labels them itself — "Static workspace nav — non-functional links"
(`full-chat-app.tsx:452`) and "Static enterprise nav — non-functional links"
(`:484`). Strip the decoration and the product's real structure is *New chat ·
one link home · Pinned · Recents · account*, which is now this drawer. This app
cannot ship the decoration anyway: a control that looks pressable and does
nothing is the defect it has been reported for once already.

**Two changes had to happen in this order, and the order was the risk.** The
cockpit's own nav was `hidden md:flex`, so at 360px it offered the agent cards
and **no path to `/reports` at all** — measured before the change. The agent
screens' pill strip was the only way there on a phone. So the cockpit's nav
became visible at every width *first*, and only then did the strip come off the
agent screens, where FabOrchestrator has none either. Reversed, there would have
been a commit in which Reports was unreachable on a phone.

### Verified

- **361 tests** — `__tests__/faborch/history.test.ts` (17, the mapper) and
  `__tests__/platform/nav-drawer.test.ts` (36 guards: no invented history, no
  local store, no unproved id, the nav gone, 44px targets).
- **`scripts/nav-drawer-check.mjs`, 59/59 on the deployment** at 360×640 and
  390×844: opens and closes three ways, lists real threads, a question asked
  here gets an id and survives a reload and appears in Recents, an existing
  thread opens with no SQL in the transcript, Back to Cockpit reaches Reports,
  no pill strip on the agent screens, no sideways scroll.
- Regression on Fly: gate 32/32, landing ask 24/24, mobile audit 16/16,
  journeys 13/13.

Two things worth recording honestly:

**A bug was introduced and the live check caught it.** Asking the first question
tore down its own answer: the new id went into `?c=`, the loader saw a selection
it had not loaded, swapped in a skeleton, and unmounting aborted the stream that
was still arriving. The URL was right and the answer was gone. Fixed by
recording locally-created ids and keying a new thread by a counter rather than by
an id it does not have yet. No unit test would have found it; it needed a real
answer arriving on a real screen.

**The journeys check failed once on Fly and passed on re-run**, with
FabOrchestrator answering "the materials search is coming back empty" and then
"238 lots". That is the nondeterminism in
`docs/FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md`, not a change here —
the second time it has cost a green check.

**The live drawer check writes one conversation per run** into the demo account,
titled `PWA drawer check <timestamp>`. That is how it proves persistence, and it
is the only test in this repo that leaves anything behind.

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
npm test                          # 361 tests, no network needed
npx tsx scripts/probe-faborch.ts  # the five live environment probes
npx tsx scripts/e1-live-check.ts  # the M1 gate, against a running app

# The session gate. Run both against the deployment, not a laptop — the
# matcher that decides whether the gate runs at all is invisible to `npm test`.
APP_URL=https://faborch-demo.fly.dev node scripts/gate-live-check.mjs
APP_URL=https://faborch-demo.fly.dev node scripts/cold-launch-check.mjs

# The conversation drawer. Also deployment-only: it reads real
# FabOrchestrator history, and it leaves one thread behind per run
# (titled "PWA drawer check <timestamp>") because that is what proves
# a question asked here is written down there.
APP_URL=https://faborch-demo.fly.dev node scripts/nav-drawer-check.mjs
```

---

## Where things live

| Document | What it is for |
|---|---|
| `docs/HANDOVER.md` | **Start here to operate it.** Running, deploying, every failure message, the decisions that look odd |
| `docs/OPEN_ISSUES.md` | Everything still open, all external, with owners |
| `docs/STATUS.md` | This file. What was built and how it was proved |
| `docs/PRD.html` | The requirements, as a published page |
| `docs/FABORCHESTRATOR_ROUTING_GROUNDING_BUGS.md` | The write-up to send to the FabOrchestrator team |
| `docs/FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md` | Also for the FabOrchestrator team: why the same MES question can return a different number each time, with the SQL and the rows |
| `docs/probes/` | Dated evidence from individual investigations |
| `docs/planning/` | The original plans. **Superseded in places** — see `OPEN_ISSUES.md` §4 |


| Path | What |
|---|---|
| `lib/faborch/` | The only code that knows FabOrchestrator's HTTP contract |
| `lib/faborch/history.ts` | Reduces a stored FO thread to what a phone can show. 1.3 MB in, a few KB out |
| `lib/faborch/owns.ts` | Proves a conversation id belongs to the caller, because FO's own `/api/chat` does not |
| `app/api/faborch/[agent]/chat/` | The connector — holds the credential, streams the answer back |
| `app/api/faborch/conversations/` | The history proxy. List, create, load, pin. No delete, rename, share or search |
| `components/fab/nav-drawer.tsx` | The conversation sidebar — FO's own mobile Sheet, in this app's vocabulary |
| `app/api/auth/` | Sign-in, sign-out, session |
| `proxy.ts` | The session gate. Decides, before any document is rendered, whether this visitor gets a screen or `/login` |
| `docs/planning/` | The four planning documents (see debt above) |
| `docs/probes/` | Evidence: the environment probes and the E1 report |
| `CLAUDE.md` | The design record — why things are the way they are |
