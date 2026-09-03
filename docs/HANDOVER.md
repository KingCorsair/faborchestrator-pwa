# Handover

**FabOrchestrator PWA — 3 September 2026.** Live at
**https://faborch-demo.fly.dev**.

This is the operating note: what the thing is, how to run it, what to do when
it misbehaves, and what is not finished. `docs/STATUS.md` is the record of what
was built and proved; this is the record of how to keep it running.

---

## 1. What this app is, in one paragraph

A mobile front door to FabOrchestrator, and **nothing else**. A person signs in
with their own FabOrchestrator account, asks a question, and the answer streams
back from the platform. It reads dashboards an administrator pinned in
FabOrchestrator. It holds **no** MES credential, **no** model API key, **no**
database and **no** manufacturing logic — every answer is FabOrchestrator's.
That boundary is the design, and `scripts/security-review.mjs` asserts it.

**What it is not:** it does not calculate yield, query the MES, pick a model,
or create dashboards. If you find yourself adding any of those, the boundary
has been crossed and the plan's own rule broken — see "What NOT to build" in
`CLAUDE.md`.

---

## 2. Running it

```bash
npm install                 # playwright is a devDependency, for the checks
npx playwright install chromium   # once, for the browser-driven checks
cp .env.example .env        # then fill in the values below
npm run dev                 # http://localhost:3002
npm test                    # 272 tests, no network needed
npm run build && npm start  # production build, same port
```

### Environment

| Variable | What it is | Required |
|---|---|---|
| `FABORCH_BASE_URL` | The FabOrchestrator deployment. **Must be https** for anything but localhost — the app refuses to start a request otherwise | yes |
| `SESSION_SIGNING_SECRET` | Signs this app's own session token. Any long random string; changing it signs everyone out | yes |
| `FABORCH_PROBE_EMAIL` / `FABORCH_PROBE_PASSWORD` | A FabOrchestrator account the check scripts sign in as. **Not used by the app itself** | checks only |

There is deliberately no `DATABASE_URL` and no model API key. If you are about
to add either, read §5 of `docs/STATUS.md` first.

### Deploying

```bash
flyctl deploy --ha=false --app faborch-demo
```

`--ha=false` matters: `fly.toml` declares one machine, and without it Fly
provisions a second that has no reason to exist.

**After every deploy, run the checks against the deployed URL, not localhost.**
This is not ceremony. The sign-in defect found on 3 September existed *only*
where hydration is slow enough to race, so a suite that ran locally kept
passing while the deployed app could not be signed into at all.

```bash
export APP_URL=https://faborch-demo.fly.dev
node scripts/security-review.mjs        # 24 checks
node scripts/journeys-check.mjs         # 5 journeys, 13 steps
node scripts/reports-live-check.mjs     # 9
node scripts/progress-states-check.mjs  # 6
node scripts/artifact-live-check.mjs    # 8
node scripts/mobile-audit.mjs           # 16, two viewports
node scripts/hydration-typing-check.mjs # sign-in under slow hydration
```

---

## 3. When something is wrong

**Start by asking which side is broken.** Almost every failure is either
FabOrchestrator or the network between, and the app is written to say which.

| What the operator sees | What it means | What to do |
|---|---|---|
| "Not connected to a FabOrchestrator" | `FABORCH_BASE_URL` is unset, or is `http:` to a non-loopback host | A deployment setting. `flyctl secrets list`, and check `fly.toml` |
| "Your FabOrchestrator session has expired" | FO evicted the token — 30-day expiry, or 30 minutes idle | Nothing to fix. Sign in again |
| "Daily limit reached" | FO's own quota | Wait. Retrying spends another request against a limit that has not moved |
| "Your role does not have that permission" | FO refused this account | An administrator grants it in FabOrchestrator, not here |
| "Could not reach FabOrchestrator at …" | The platform is down or unreachable | Check FO itself. The address tried is in the message |
| "No data connections are enabled for your account" | The account has no MCP connections | An administrator assigns them in FO. **Yield, scrap and OEE still answer** — they use FO's metric path, which never touches MCP |
| "Nothing has arrived for 45 seconds" | Three missed keep-alives | Usually a long tool call. It may still complete; the turn is not cancelled |
| The answer stops mid-sentence with a warning | The connection dropped | What arrived is kept and marked incomplete. Ask again |

**Every failure carries a code** (`docs/STATUS.md` has the table, the source is
`lib/faborch/errors.ts`). If an error ever appears without one, that is a bug in
this app.

**If FabOrchestrator sent an error id**, the screen shows it as a chip to copy.
That id is the only handle into FO's `error_audit_logs` — get it from the
operator before anything else.

### Logs

```bash
flyctl logs --app faborch-demo
flyctl status --app faborch-demo
```

---

## 4. The decisions worth knowing before you change anything

Four choices look odd until you know why. Each is load-bearing.

**The iframe sandbox is `allow-scripts` with no `allow-same-origin`.** Those two
together *cancel* the sandbox: the frame takes the embedder's origin and can
read its cookies and DOM. FabOrchestrator's own pages use both, which is
survivable there because frame and page share an origin anyway. It is not
survivable here — this app holds an httpOnly FO token, and the document in the
frame was written by a model. Two test files assert the pair never appears.

**The credential fields are uncontrolled.** As controlled inputs they were bound
to state that does not exist until React hydrates, so hydration erased whatever
was typed before it — and because the fields are `required`, the next press was
then blocked by native validation with no event and no message. Sign-in silently
did nothing. Do not "tidy" them back into `value`/`onChange`; a test fails if you
do.

**There is no Refresh on `/reports`.** FabOrchestrator's refresh route is *not*
admin-gated, and it re-queries the MES and overwrites the snapshot every other
reader sees. A control that rewrites other people's data does not belong on a
read-only screen. Readers get the timestamp instead.

**The landing-page counters are hardcoded.** 142 workflows, 8,394 automated, and
so on, copied from FabOrchestrator's own cockpit — which has no data source for
them either. Retained deliberately for visual fidelity (decision, 3 September).
They are **not real**, and nobody should quote them.

---

## 5. Who owns what

| Thing | Owner | Notes |
|---|---|---|
| This repo | `KingCorsair/faborchestrator-pwa`, private | |
| The Fly app | `faborch-demo`, org `amayanand03@gmail.com` | one machine, region `sin` |
| FabOrchestrator | Another team | This app has **no** write access and needs none |
| MCP data connections | A FabOrchestrator administrator | Assigned per role, inside FO |
| Pinned dashboards | A FabOrchestrator administrator | Created and pinned in FO; read-only here |

---

## 6. Open items

These are listed in full, with owners, in **`docs/OPEN_ISSUES.md`**. The two
that need action soonest:

1. **Rotate the shared FabOrchestrator demo password.** It reached the Fly
   request logs on 3 September. Details and reasoning in `OPEN_ISSUES.md` §1.
2. **The FabOrchestrator grounding fix is written but unshipped**, and it is
   about dashboards full of invented figures — which this app now renders
   convincingly. `OPEN_ISSUES.md` §2.

Neither is a defect in this app, and neither blocks its use.
