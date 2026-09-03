# FabOrchestrator PWA

A mobile front door to **FabOrchestrator**, and nothing else.

A supervisor signs in with their own FabOrchestrator account, asks a question on
a phone, and the answer streams back from the platform — grounded in real MES
data, under that operator's own role and permissions. They can also read the
dashboards an administrator pinned in FabOrchestrator.

**Live at https://faborch-demo.fly.dev**

This app holds **no** MES credential, **no** model API key, **no** database and
**no** manufacturing logic. Every answer is FabOrchestrator's. That boundary is
the design, and `scripts/security-review.mjs` asserts it on every run.

| Read this | For |
|---|---|
| **`docs/HANDOVER.md`** | Operating it — every failure message, what to do, who owns what |
| **`docs/OPEN_ISSUES.md`** | What is still open. All of it external to this app |
| **`docs/STATUS.md`** | What was built and how each part was proved |
| **`CLAUDE.md`** | The design document and the record of every decision |

This file is how to run it.

---

## Requirements

| | |
|---|---|
| Node | **20.11 or newer** (built and tested on 24.18) |
| npm | 10 or newer |
| A FabOrchestrator to talk to | Required — there is no other way to sign in |

No database, no Docker for development, no model API key.

---

## Setup

```bash
git clone https://github.com/KingCorsair/faborchestrator-pwa.git
cd faborchestrator-pwa
npm install
npx playwright install chromium   # once, only for the browser-driven checks
cp .env.example .env
```

> **Cloning on Windows:** if you clone this beside the FabOrchestrator product
> source, *that* repo has paths longer than Windows' 260-character limit and the
> checkout breaks with `Filename too long`. Clone somewhere short (`C:\work`), or
> enable long paths once with `git config --global core.longpaths true`. Nothing
> in this repo has long paths.

### Environment

Two variables are required. There is no credential in `.env` — FabOrchestrator
is the only identity.

```dotenv
# Any long random string. Signs this app's own session token.
SESSION_SIGNING_SECRET=...

# The FabOrchestrator to forward questions to.
# MUST be https for any host but localhost — see below.
FABORCH_BASE_URL=http://localhost:3000
```

Generate a signing secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**`FABORCH_BASE_URL` must be https, and this is enforced rather than advised.**
Sign-in sends the operator's FabOrchestrator *password* over that connection,
and every call after it carries their session token. `foBaseUrl()` accepts
`https://` anywhere and `http://` only for loopback, with no override:

```
https://anything        accepted
http://localhost:3000   accepted — a FabOrchestrator on this machine
http://127.0.0.1:3000   accepted
http://anything-else    REFUSED, with a message saying why
```

The exception is keyed on the *host*, not on `NODE_ENV`: `npm start` runs a
production build locally, and a loopback address is unreachable from elsewhere
by construction, which is the stronger guarantee.

Two more are used **only by the check scripts in `scripts/`**, never by the app:

```dotenv
FABORCH_PROBE_EMAIL=...
FABORCH_PROBE_PASSWORD=...
```

> `.env` is gitignored and must never be committed.

---

## Run it

```bash
npm run dev                 # http://localhost:3002, hot reload
npm run build && npm start  # production build, same port
npm test                    # 272 tests, no network needed
```

Sign in with a FabOrchestrator account. There is no demo credential — a local
`DEMO_USER_*` pair used to be accepted and was removed on 2026-09-01, because it
minted a session with no FabOrchestrator token: one that opened an agent and
then could not ask it anything.

To run against a local FabOrchestrator:

```bash
cd ../FabOrchestrator_product_code/claudeai_athena
npm run dev    # :3000 — needs its own DATABASE_URL and ANTHROPIC_API_KEY
```

---

## What is in it

| Screen | What it does |
|---|---|
| `/` | FabOrchestrator's cockpit, reproduced. Ask a question here without choosing an agent |
| `/fabinsight` | A conversation with FabInsight |
| `/backend-agent` | A conversation with the Back-end Agent |
| `/reports` | Dashboards an administrator pinned in FabOrchestrator. **Read-only** |
| `/login` | Sign in with a FabOrchestrator account |
| `/diagnostics` | Unauthenticated. The only console you have on a phone |
| `/offline` | Shown by the service worker when the network is genuinely gone |

Workflows and Sites appear in the nav, greyed. FabOrchestrator has those
sections and this app does not open them — and neither does the product, where
every cockpit nav item except Reports goes to `/home`. Greying them states both
facts at once, rather than inventing screens or pretending the product is
smaller than it is.

---

## How it reaches FabOrchestrator

```
you type a question in the PWA
  → POST /api/faborch/<agent>/chat     (this app: auth + the FO token, nothing else)
  → POST {FABORCH_BASE_URL}/api/chat   (the real FabOrchestrator)
  → FO routes it: a metric brief, a curated dashboard, or its MCP tool loop
  → streamed back through the PWA and rendered
```

The FO session token lives in an **httpOnly cookie** and never reaches client
JavaScript. The browser never talks to FabOrchestrator directly — it cannot, as
FO sets no CORS headers, and it should not, because that is where the credential
would have to go.

**Answers stream.** While FabOrchestrator is calling one of its tools the screen
names it — *FabOrchestrator is running `mcp_query`…* — so a fifteen-second
lookup does not look like a hang.

**If an answer arrives thin**, it is one of two things and neither is in this
app: the MCP data connections on that FabOrchestrator account, or that FO
deployment's own model key. The app says which where it can — an account with no
connections is told so explicitly, and told that yield, scrap and OEE still
answer, because those go through FO's metric path and never touch MCP.

---

## On a phone

**Use the deployed URL: https://faborch-demo.fly.dev.** It has real TLS, which
a phone reaching your laptop at `http://192.168.x.x:3002` does not — and
`serviceWorker.register` requires a secure context, so over plain HTTP you get
an app with no offline page and no installability. iOS will still let you Add to
Home Screen; it just will not be the app you built.

To put a *local* build on a phone, tunnel it rather than serving plain HTTP:

```bash
npm run build && npm start                     # terminal 1
cloudflared tunnel --url http://localhost:3002 # terminal 2
```

### Installing it

Safari never fires `beforeinstallprompt`, so the app shows its own hint: Share →
**Add to Home Screen**. Android gets a native prompt.

### iOS behaviour worth knowing before you are in front of an audience

- **An installed iOS web app has its own storage jar**, separate from Safari's.
  Signing in in the browser does not carry into the installed app — you sign in
  once more after installing. Expected, not a bug.
- **Add to Home Screen pins the icon to the URL on screen**, not to the
  manifest's `start_url`. Install from `/`. If an icon behaves oddly, delete and
  re-add it rather than debugging it.
- **Nothing under `/api/` is cached**, deliberately. On weak site wifi that means
  honest error states, never a stale figure.
- **Open `/diagnostics` first if anything looks wrong.** Windows cannot
  remote-debug iOS Safari, so it is the only console available. Check *Secure
  context* reads **Yes** before anything else.

---

## Deploying

```bash
flyctl deploy --ha=false --app faborch-demo
```

`--ha=false` matters: `fly.toml` declares one machine, and without it Fly
provisions a second that has no reason to exist.

`FABORCH_BASE_URL` is in `fly.toml` under `[env]` rather than in secrets,
because it is not one — it is the public CloudFront distribution. Keeping it in
the repo means the deployed configuration is readable here rather than only in
the Fly dashboard. `SESSION_SIGNING_SECRET` is the only secret.

**After every deploy, run the checks against the deployed URL, not localhost.**
This is not ceremony. The sign-in defect found on 3 September existed only where
hydration is slow enough to race, so a locally-run suite kept passing while the
deployed app could not be signed into at all.

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

> **`npm run build` on Windows prints a page of `EINVAL: copyfile` warnings.**
> Expected and harmless. Turbopack names externals chunks after the module they
> wrap — `[externals]_node:path_….js` — and a colon is illegal in an NTFS
> filename, so only the copy into `.next/standalone/` fails. The build exits 0,
> `npm start` is unaffected, and the deploy builds on Linux where the name is
> ordinary.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on 3002 |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | **272 tests** — auth, proxy, streaming, conversation, errors, artifacts, reports, platform |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run icons` | Regenerate the PWA icons |
| `npm run qr -- <https url>` | QR code for a deployed URL, written to `qr/` |

The `scripts/*.mjs` checks above are separate: they drive a real browser against
a running app, so they need `npx playwright install chromium` once.

---

## Layout

```
lib/faborch/      The whole integration. Its HTTP contract in one file, where
                  the FO token lives, the reader for its streamed reply, the
                  conversation reducer, the error table, and the artifact
                  parser ported from FabOrchestrator. No manufacturing logic.
lib/              Session signing, auth middleware, rate limiting, validation.
app/api/          Authenticated routes, Zod on every input. `faborch/[agent]/chat`
                  forwards a question and streams the answer back untouched;
                  `faborch/reports` reads pinned dashboards, GET only.
app/              The cockpit at /, the two agent screens, reports, login, and
                  /diagnostics and /offline, which are tools rather than
                  sections of the product and are not in the nav.
components/fab/   The whole presentation layer, in FabOrchestrator's V2
                  design language.
scripts/          Browser-driven checks that run against a deployed URL.
```

---

## What this is not

Read before changing anything.

- **It computes nothing about manufacturing.** No yield calculation, no MES
  query, no metric detection, no SQL, no system prompt, no model call. If you
  are adding one, the boundary has been crossed — see "What NOT to build" in
  `CLAUDE.md`.
- **It is not a dashboard editor.** Creating, pinning and deleting dashboards is
  admin-only *in FabOrchestrator*, and `/reports` deliberately offers no Refresh
  either: FO's refresh route is not admin-gated and overwrites the snapshot
  every other reader sees.
- **It does not check FabOrchestrator's answers.** The app forwards a question
  and renders the reply. It does not ground it against a record, because the
  data the answer is about lives in FabOrchestrator and not here.
- **The landing-page counters are not real.** *142 workflows*, *8,394
  automated*, *1,284 queries* and the Recent activity list are hardcoded, copied
  from FabOrchestrator's own cockpit — which has no data source for them either.
  Retained deliberately for visual fidelity (decision, 2026-09-03). They are the
  one place in this app where a number resolves to no record. **Nobody should
  quote them.**
- **Sign-in is rate limited, and that is a mitigation rather than a fix.** Eight
  failed attempts from one address buys a ten-minute wait
  (`lib/rate-limit.ts`). It is per-process and per-IP, so it stops a script
  against one address and does nothing about a distributed attempt. A correct
  password is never throttled.
