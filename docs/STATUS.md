# Where this project stands

**As of 2 September 2026.** Working tree clean, all commits pushed to `KingCorsair/faborchestrator-pwa` (private).

This file is the running answer to "where are we and what is left". It records
what has been *proved*, not what has been written — anything claimed here has a
test, a probe report, or a browser run behind it. When the two disagree, this
file is wrong and should be corrected.

---

## Update in plain English — 2 September 2026

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
- **174 automated tests pass.** They run without a network.

**Pending**

- Next: asking from the front page, with the system picking the right agent —
  the behaviour Jothi confirmed he wanted. **Waiting on a decision first**: if
  the Master Data Load Agent does not belong in the phone app, every remaining
  agent is the same service and there is nothing to route between.
- After that: installing on a phone, and answering from real plant data.
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
| Scope correction | The production-order workflow and its mock MES are removed; the nav mirrors FabOrchestrator's own cockpit |

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

### Phase 2 — WP5 done; the other two wait on a product answer

| WP | What | Days | State |
|---|---|---|---|
| WP5 | Conversation handling — follow-ups in one thread, stop mid-answer | 0.5 | **Done** |
| WP7 | Agent menu with the Master Data Load Agent's availability check | 1.0 | Gated |
| WP13 | **Ask-first routing** — type on the landing page, the system picks the agent | 2.0 | Gated |

Closes **M2 / B2** when all three land. WP7 is smaller than planned now that no
non-agent screens remain.

**Both remaining packages are gated on Yogita's answer**, not on engineering.
PRD §18.2: three of the four cockpit cards are the same service, so routing is
in practice *"is this a master-data request or not?"* If the Master Data Load
Agent is excluded from the PWA, every exposed agent shares one service and there
is nothing left to route between — WP13's 2 days would buy nothing, and WP7's
availability check would have no gated agent to check. Building either before
the answer risks building the wrong thing.

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

### Phases 3–5 — unchanged

Phase 3 (install + live plant data, M3/B3) is **blocked** — see below. Phase 4
(dashboards, progress, failure handling) and Phase 5 (tests, device validation,
security review, handover) follow.

---

## Blocked on someone else

| # | Blocker | Blocks | Who clears it |
|---|---|---|---|
| 1 | **The probe account has zero data connections.** Probe P4: `0 connected of 0 visible`. Plant questions are answered from the model's general knowledge, which reads as a wrong answer rather than a missing permission | **Phase 3 entirely** — the phase the business case rests on | A FabOrchestrator administrator, assigning MCP connections to that account's role |
| 2 | The Fly deployment is stale — it carries none of this work | Anything demonstrated from a URL rather than localhost | Us, on your word |

Blocker 1 is the one worth chasing. Everything through Phase 2 proceeds without
it; nothing in Phase 3 does.

---

## Known debt

**The planning documents are current as of 1 September 2026.** Both decisions
they asked the review for are now recorded as taken — the production-order
workflow is removed, and the demo runs against the live deployment — along with
the manifest-`id` call. **No estimate changed**: the plan always assumed the
workflow went, so the 3 days quoted were the cost of keeping it.

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
