# Where this project stands

**As of 1 September 2026.** Working tree clean, all commits pushed to `KingCorsair/faborchestrator-pwa` (private).

This file is the running answer to "where are we and what is left". It records
what has been *proved*, not what has been written — anything claimed here has a
test, a probe report, or a browser run behind it. When the two disagree, this
file is wrong and should be corrected.

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
| **WP2** Sign-in & session security | 17 cookie tests + 11 identity tests. FabOrchestrator is the only identity; the two expiry clocks are reconciled. **One item outstanding — see below** |
| **WP4** Secure connector | 15 tests against a stubbed FabOrchestrator, so the suite runs with no network |
| **M1 / B1** Architecture proven end to end | `docs/probes/2026-09-01-e1-report.md` — 5/5 against the live CloudFront deployment: sign-in, token httpOnly and absent from the body, a real answer through the proxy, **13 network arrivals over 2.6 s** (progressive, not buffered), sign-out dropping the cookie |
| Scope correction | The production-order workflow and its mock MES are removed; the nav mirrors FabOrchestrator's own cockpit |

**143 tests, all passing.** Typecheck and lint clean. Production build compiles.

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

### WP2 — one item, blocked on infrastructure

Replace the stateless HMAC session with a **revocable server-side session**
(`pwa_sessions` table, opaque id in a second httpOnly cookie). Today sign-out
drops the FabOrchestrator cookie — which does end this app's platform access —
but the app's own token stays valid until it expires, because nothing
server-side records it.

Needs `DATABASE_URL`. Its practical impact is smaller than when the plan was
written: with FabOrchestrator as the only identity, a stolen app token alone
reaches `/api/auth/me` and nothing in FabOrchestrator, because every platform
call needs the httpOnly cookie that sign-out removes.

### Phase 2 — the next build step, nothing blocking it

| WP | What | Days |
|---|---|---|
| WP5 | Conversation handling — follow-ups in one thread, stop mid-answer | 0.5 |
| WP7 | Agent menu with the Master Data Load Agent's availability check | 1.0 |
| WP13 | **Ask-first routing** — type on the landing page, the system picks the agent | 2.0 |

Closes **M2 / B2**. WP7 is smaller than planned now that no non-agent screens
remain. WP13's routing decision is binary (chat or modeling), because three of
the four cockpit cards share `/api/chat`.

### The next work package, in detail — WP5

**Why it is next.** Its dependencies (WP2, WP4, WP6) are done, and it blocks the
other two: WP7's menu opens conversations, and WP13 carries a typed question
*into* a conversation thread. Building either first means building against a
conversation layer that is not finished.

**What already exists** — checked in the code, not assumed.
`components/fab/screens/agent-chat.tsx` already holds the turn list, sends the
full history on every turn, and has an `AbortController` behind Stop.
`lib/validation.ts` already caps the payload at 64 messages of 20,000
characters.

**What is actually left:**

- **No test coverage at all.** The conversation layer is the one part of the
  FabOrchestrator path with nothing behind it in the suite.
- **Stop must keep what already arrived.** The acceptance line is explicit:
  survive interruption *without losing what arrived*. Aborting mid-stream is
  exactly where partial text gets dropped.
- **A hazard the code already records.** A comment in `agent-chat.tsx` warns
  that `send` closes over `turns`, so it is a new function on every token, and
  calls the seeding effect "delicate". That is the shape of a bug that works in
  testing and drops a follow-up in a demo.
- **The 64-message cap needs a decision.** Today a longer conversation is
  silently truncated rather than refused, so the model quietly loses the
  beginning of the thread.

**Done when:** ask, read, follow up, stop, ask again — on each agent, with
tests.

### Phases 3–5 — unchanged

Phase 3 (install + live plant data, M3/B3) is **blocked** — see below. Phase 4
(dashboards, progress, failure handling) and Phase 5 (tests, device validation,
security review, handover) follow.

---

## Blocked on someone else

| # | Blocker | Blocks | Who clears it |
|---|---|---|---|
| 1 | **The probe account has zero data connections.** Probe P4: `0 connected of 0 visible`. Plant questions are answered from the model's general knowledge, which reads as a wrong answer rather than a missing permission | **Phase 3 entirely** — the phase the business case rests on | A FabOrchestrator administrator, assigning MCP connections to that account's role |
| 2 | `DATABASE_URL` | The last WP2 item | Infrastructure |
| 3 | The Fly deployment is stale — it carries none of these nine commits | Anything demonstrated from a URL rather than localhost | Us, on your word |

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
npm test                          # 143 tests, no network needed
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
