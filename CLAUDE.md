# CLAUDE.md — FabOrchestrator PWA

A mobile front door to **FabOrchestrator**, and nothing else.

A supervisor signs in with their own FabOrchestrator account, asks a question
on a phone, and the answer streams back from the platform — grounded in real
MES data, under that operator's own role and permissions. They can also read
the dashboards an administrator pinned in FabOrchestrator.

**This file is the current guide**: what the app is, how it is built, and the
rules that keep it that way. It replaced, on 28 September 2026, the design
record of the August production-order demo — tiers, MES rules, an AI analysis
layer, a decision log, a barcode scanner — none of which exists any more. That
record, like everything removed that day, is in git history if its reasoning is
ever needed: `git show 585aa00:CLAUDE.md`.

---

## The boundary, and the one question that guards it

This app holds **no** MES credential, **no** model API key, **no** database and
**no** manufacturing logic. Every answer is FabOrchestrator's.
`scripts/security-review.mjs` asserts the boundary against the running
deployment, and fails if a model key or a model SDK appears.

The test for anything added under `lib/faborch/` or the agent screens:
**could this change what the answer says?**

- Forwarding, rendering, error states, time limits and the tool-activity line
  cannot. They belong here.
- A system prompt, a retry that re-asks differently, a post-processing step, a
  "helpful" fallback answer when FabOrchestrator is down — all can. They are
  forbidden, whatever they are called.

What NOT to build: no generic chatbot of this app's own, no yield calculation
or MES query, no dashboard editor, no replacement for anything FabOrchestrator
does.
`/reports` is read-only and offers no Refresh on purpose: FabOrchestrator's
refresh route is not admin-gated and overwrites the snapshot every other reader
sees.

**The landing-page counters are not real** (142 workflows, 8,394 automated…).
They are copied from FabOrchestrator's own cockpit, which has no data source
for them either, and kept for visual fidelity (decision, 3 September). They are
the one number on screen that resolves to no record. Nobody should quote them.

---

## Screens

| Route | What it is |
|---|---|
| `/` | FabOrchestrator's cockpit, reproduced. Its ask bar answers inline |
| `/fabinsight` | A conversation with FabInsight, with the operator's real FabOrchestrator history in a drawer |
| `/backend-agent` | A conversation with the Back-end Agent (no history — the product keeps none) |
| `/reports` | Dashboards an administrator pinned. Read-only |
| `/login` | Sign in with a FabOrchestrator account |
| `/diagnostics` | Unauthenticated. The only console there is on an iPhone |
| `/offline` | Served by the service worker when the network is genuinely gone |

Every document route except `/login`, `/offline` and `/diagnostics` is behind
the session gate in `proxy.ts` (deny by default).

---

## How a question travels

```
phone ── POST /api/faborch/<agent>/chat ─────────────────────────────────────┐
  requireAuth         the app's pass, and the FabOrchestrator cookie it is bound to
  readJsonBody        size ceiling first (CHAT_BODY_LIMIT), then the schema
  connectedMcpIds     the operator's data tools — remembered 5 min per session
  ownsConversation    the chat is theirs? — a proof remembered 5 min, never a refusal
  foChat              FabOrchestrator POST /api/chat — 60 s to begin, then unlimited
◄── the stream, piped back untouched; parsed on the phone by lib/faborch/stream.ts
```

The browser never talks to FabOrchestrator directly — it cannot (FO sends no
CORS headers) and should not (the FO token would have to be in the page).
FabOrchestrator builds the model's context from the request body, so every
question carries the whole conversation; `conversationId` only decides whether
FO writes the turn down.

---

## Where things are

| Path | What lives there |
|---|---|
| `lib/faborch/client.ts` | **The only file that knows FabOrchestrator's HTTP contract**, and the time limit on every call (`fetchFo`) |
| `lib/faborch/stream.ts` | Reads FO's streamed reply (AI SDK UI-message frames); the 45 s stall watchdog |
| `lib/faborch/conversation.ts` | The chat reducer, and the capacity checks the screen makes before sending |
| `lib/faborch/history.ts` | Reduces a stored thread server-side (1.3 MB of tool output → the text) |
| `lib/faborch/errors.ts` | Every failure code, and the next step the screen shows for each |
| `lib/faborch/agents.ts` | The agent registry: FabInsight and the Back-end Agent |
| `lib/faborch/owns.ts`, `tools.ts` | The two lookups a question needs, remembered briefly |
| `lib/faborch/session.ts` | The FabOrchestrator token's httpOnly cookie |
| `lib/faborch/artifacts.ts` | The artifact parser, ported from FabOrchestrator |
| `lib/auth.ts`, `lib/auth-middleware.ts` | This app's signed pass, and `requireAuth` |
| `lib/rate-limit.ts` | The sign-in lockout: Upstash when configured, this process otherwise |
| `lib/request-body.ts`, `lib/validation.ts` | Body size ceilings, and every request schema |
| `lib/report-error.ts` | Where unexpected failures go: a JSON log line, and optional alerts |
| `lib/fo-activity.ts` | FabOrchestrator's 30-minute idle clock, kept on the device |
| `lib/client-error.ts` | Crash reports from the browser |
| `lib/ttl-cache.ts` | A small, bounded, time-limited memory |
| `lib/return-path.ts`, `lib/credentials.ts`, `lib/platform.ts` | `?next=` validation, reading the sign-in form, iOS detection |
| `proxy.ts` | The session gate for documents (Next 16's middleware) |
| `app/api/` | Route handlers. Every one opens with `requireAuth`, except sign-in, sign-out and crash reports |
| `components/fab/` | The whole presentation layer, in FabOrchestrator's V2 design language |
| `public/sw.js` | The service worker |
| `__tests__/` | Unit tests and source guards — no network needed |
| `scripts/` | Live checks, run against a deployed URL |

---

## Sessions

FabOrchestrator is the only identity. Sign-in sends the password to FO's
`/api/auth/login`; FO checks it and returns its own session token.

- **FO's token** goes into an httpOnly cookie. Page scripts cannot read it.
- **This app's pass** — `base64url(JSON) + "." + HMAC-SHA256` over
  `SESSION_SIGNING_SECRET` — goes to `localStorage`. It carries the user's id,
  email, name, role, expiry and `fp`, a fingerprint of FO's token.
- **`requireAuth` accepts a request only when both agree**: a valid signature,
  an unexpired pass, and a cookie whose fingerprint matches `fp`. A pass copied
  off a device opens nothing on its own.
- The pass expires at the earlier of 12 hours and FO's own expiry. Every
  sign-in gets a new FO token, so two devices on one account are two separate
  sessions (but share the account's saved chats).
- **Sign-out clears the device first**, then asks FO to end the session, and
  gives it five seconds. The cookie is dropped either way.
- **The role** is read from FO's `/api/auth/me` at sign-in; if that fails, the
  label says "Signed in" rather than guessing, and sign-in still succeeds.
- **FO signs a session out after 30 idle minutes.** The top bar warns in the
  last five and offers *Stay signed in* — one call to FO, **only when pressed**.
  Never keep a session alive on a timer: FO's session audit measures idleness,
  and a keep-alive nobody asked for would defeat its eviction and falsify it.

---

## Failures, time limits and crashes

| What | Limit |
|---|---|
| Any FabOrchestrator lookup, sign-in, reports, pinning | 15 s, body included |
| A question's answer | 60 s to begin (CloudFront's own cut-off), then as long as it takes |
| Sign-out | 5 s on the server, 8 s on the phone |
| The screen, before the first word | Warns at 45 s; the operator can Stop |
| Upstash, the alert webhook | 2 s, 3 s |

- **Every failure the screen can show has a code** (`lib/faborch/errors.ts`),
  a message written for a person, and a next step. Routes answer
  `{ code, error, errorId? }`. FabOrchestrator's own `errorId` is kept and shown
  as something to copy — it is support's only handle into FO's error log.
- **Unexpected failures go through `reportError`**, never a bare
  `console.error` (a source guard enforces it): one JSON line with an incident
  id, plus an alert to `ERROR_ALERT_WEBHOOK_URL` when set, at most once per kind
  every five minutes. Never put a token, password, question or answer in either.
- **Crashes land on the crash screen** (`app/error.tsx`, `app/global-error.tsx`)
  with Try again, Go to the cockpit, and Reset and reload. It reports itself to
  `/api/client-error`; the reference on screen is the one in the log.
- **Request bodies have ceilings** (`lib/validation.ts`), derived from the
  schemas so nothing the screens can send is ever refused.
- **Storage can throw** (site data blocked, some private modes). Every
  `localStorage` access is guarded.

---

## Scaling

The app keeps almost nothing between requests, so any copy of it can serve any
user. What lives in memory: the sign-in lockout count (shared through Upstash
when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set) and two
short-lived caches keyed by session, which are safe to lose. It runs on one
Fly machine today; that is a deployment choice, not a requirement of the code —
see the comments in `fly.toml`.

---

## Conventions

- **Reuse before adding.** Before a dependency or a pattern, check what
  FabOrchestrator (`claudeai_athena`) already does and follow it. The
  dependency list is short on purpose: no query library, no ORM, no database,
  no model SDK. Shared code is copied from the product, not imported.
- **A route handler's shape:** `requireAuth` → `readJsonBody(req, LIMIT)` → a
  schema from `lib/validation.ts` → FabOrchestrator only through
  `lib/faborch/client.ts` → failures as `{ code, error }` → the unexpected
  through `reportError`.
- **A value from a request selects; it never becomes the destination.** The
  agent segment picks from `FO_AGENTS`, `?next=` passes `safeReturnPath`, a
  conversation id must be proved the caller's (`owns.ts`) — FabOrchestrator's
  own `/api/chat` does not check.
- **Comments say why, with the evidence and the date.** When a decision is
  reversed, say so where it was made, so the next reader does not rediscover it.
- **Never cache anything under `/api/`** in the service worker. A cached figure
  is a wrong figure.

---

## Visual rules

The UI must look like FabOrchestrator: the **V2 / Fab Blue** design language in
`app/faborch-theme.css`, scoped to `.fab`, with every value copied from
`claudeai_athena/app/globals.css` rather than re-picked. The screens that define
it are the product's login page, `components/cockpit/cockpit-nav.tsx` and
`agent-cards.tsx` (on the product's `main` branch).

- **Rounded, lifted, airy.** White cards at `--r-card` (22px) with soft shadows;
  controls at `--r-control` (12px); pills at `--r-chip` (9px). Plus Jakarta
  Sans; indigo `#5b54e8` → `#4842d4`; navy `#10153a`; page surface `#f6f7fc`.
  Hairline boxes and square corners are the drift to watch for.
- **Seven type steps**, `--fs-label` 10 to `--fs-hero` 30, plus `--fs-display`
  42 for the cockpit headline only. A size between steps is noise, not
  hierarchy.
- **Weight is for contrast.** Running text and meta lines are 400; headings,
  pills, buttons and eyebrows keep their weight.
- **The column is `--page-width` (1180px);** running prose is capped at
  `--measure`. Tables scroll inside their own box rather than widening the page.
- **Status is never colour alone**: every pill has its word beside its dot.
- **Numerals are tabular, not monospace.**
- **Touch targets reach 44px under `pointer: coarse` only**, and inputs are 16px
  on touch so iOS does not zoom. Desktop density is what reads as the product.
- In a `flex-wrap` row, push right with `ml-auto`, never a `flex-1` spacer.

---

## The PWA shell

- **The manifest's `id` is `/orders` and must never change.** It is the app's
  identity; changing it orphans every installed copy. `start_url` is `/`.
- **Documents are revalidated on every load** (`next.config.ts`), because each
  deploy deletes the previous build's chunks and a phone holding old HTML would
  paint and never start. `app/layout.tsx`'s inline `CHUNK_RECOVERY` reloads once
  if it happens anyway.
- **The service worker precaches the offline page and two icons, nothing
  else.** It serves `/offline` only when a navigation fails after two retries
  *and* the browser reports no network; otherwise it answers with generated
  HTML offering Reset and reload. Bump `CACHE` when changing it.
- **iOS:** `apple-touch-icon`, `statusBarStyle: default`, `viewportFit: cover`,
  and safe-area insets on anything `position: fixed`. An installed iOS app has
  its own storage, so it needs its own sign-in. Add to Home Screen pins the URL
  on screen, not `start_url`.
- **Windows cannot remote-debug iOS Safari.** `/diagnostics` is the console:
  check *Secure context* first.

---

## Testing

```bash
npm test           # 509 tests, no network
npm run typecheck
npm run lint
npm run build
```

- **Source guards** (`reliability-guards`, `nav-drawer`, `credentials` tests)
  assert properties no unit test can reach — an error boundary exists, sign-out
  clears the device first, a form stays uncontrolled. Change one only when the
  property itself changes, and say why.
- **Run the unit suite before committing.** A stale guard once reached `main`
  on a green browser run.
- **After every deploy, run `scripts/*.mjs` against the deployed URL**, not
  localhost (the list is in `README.md`). A sign-in defect once existed only
  where hydration was slow enough to race.

---

## Documents

| File | For |
|---|---|
| `README.md` | Running and deploying it |
| `docs/HANDOVER.md` | Operating it: every failure message, and what to do |
| `docs/STATUS.md` | What was built, and how each part was proved |
| `docs/OPEN_ISSUES.md` | What is still open, and who can close it |
| `docs/PRD.md` | What the app should do, and why |
| `docs/FABORCHESTRATOR_*.md` | Defects found in FabOrchestrator itself |
| `docs/probes/` | Dated evidence from the first investigations, cited by `STATUS.md` |

Comments, tests and `STATUS.md` cite **"the plan"** and its work packages
(WP1–WP13). Those are the four delivery plans, deleted on 28 September because
they described the removed app. The rules they are cited for are stated where
they are cited; the plans themselves are at commit `585aa00`, under
`docs/planning/` (`git show 585aa00:docs/planning/work-packages.html`).
