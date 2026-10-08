# FabOrchestrator PWA

A mobile front door to **FabOrchestrator**, and nothing else.

A supervisor signs in with their own FabOrchestrator account and uses
FabOrchestrator's own pages on a phone, installed like an app, under that
operator's own role and permissions. This app adds only the sign-in, the
install files and the error pages; every page after sign-in is FabOrchestrator's,
served through this app's gateway. Approved devices are FabOrchestrator's too
(its Admin → Devices); this app passes a phone's device proof on at sign-in.

> **Branch `chetan-lean`:** the PWA's own chat, cockpit and reports screens
> and the embedding on/off switch were removed. The gateway keeps its
> protections: body-size limit, deadlines, conversation ownership, answer
> keep-reading and seats. See the note at the top of `CLAUDE.md`.

This app holds **no** MES credential, **no** model API key, **no** database and
**no** manufacturing logic. Every answer is FabOrchestrator's. That boundary is
the design.

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
npm test                    # 600 tests, no network needed
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

| Path | What it does |
|---|---|
| `/` | The front door: on to FabOrchestrator's cockpit (`/home`), or to `/login` |
| `/login` | Sign in with a FabOrchestrator account |
| `/diagnostics` | Unauthenticated. The only console you have on a phone |
| `/offline` | Shown by the service worker when the network is genuinely gone |
| `/device-enroll` | FabOrchestrator's page for a device QR code, made in its Admin → Devices |
| everything else | FabOrchestrator's own pages, through the gateway |

The old addresses `/fabinsight` and `/backend-agent` go to FabOrchestrator's
`/chat`, so a bookmark or Home Screen shortcut made earlier still works.

---

## How it reaches FabOrchestrator

```
the phone asks for a FabOrchestrator page or API call
  → proxy.ts                           (sign-in gate, which owner)
  → /fo-gateway/<path>                 (this app: adds the FO token, nothing else)
  → {FABORCH_BASE_URL}/<path>          (the real FabOrchestrator)
  → piped back; pages get the install tags and the sign-out watcher
```

The FO session token lives in an **httpOnly cookie** and never reaches client
JavaScript. FabOrchestrator's API is an explicit allow-list
(`lib/gateway/registry.ts`); its own sign-in and password-reset endpoints are
refused here, so the only way in on this origin is this app's `/login`.

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
node scripts/hydration-typing-check.mjs # sign-in under slow hydration
```

More checks drive the embedded FabOrchestrator. They sign in as the probe
account and sign out again:

```bash
node scripts/two-seat-check.mjs         # two devices on ONE account keep private conversations; writes and makes model calls, so it takes its own account (SEAT_CHECK_EMAIL/PASSWORD)
node scripts/embed-mobile-check.mjs     # the embedded FO chat at 390×844 and 360×640 → docs/probes/wp2-shots/
node scripts/embed-routing-check.mjs    # two builds on one origin: service worker, cross-build navigation, chunk caching
node scripts/embed-mobile-hardening-check.mjs # sidebar, keyboard, safe areas, rotation, standalone at phone width
node scripts/embed-chat-check.mjs       # ⚠ costs ~4 real model turns: streaming, tools, history, conversation ownership
node scripts/fo-surface-probe.mjs       # FO /chat /reports /settings: headers, assets, CORS, account facts
node scripts/fo-mobile-probe.mjs        # FO pages at 390×844 and 360×640, screenshots → docs/probes/wp0-shots/
node scripts/fo-navigation-check.mjs    # WP9: clicks FabOrchestrator OWN controls (its Back button, FO Overview)
node scripts/fo-auth-loop-check.mjs     # WP10: expired FO session → no /home ↔ / loop, no second login
node scripts/pwa-install-check.mjs      # WP10: manifest + service worker on FO pages, via Chrome own parser
node scripts/fo-mobile-nav-check.mjs    # FO's own responsive nav: one system per width, taps, desktop parity (PART=matrix|taps|parity)
node scripts/fo-installed-nav-check.mjs # desktop matches FO production; phone views get FO's phone nav; Chat disabled (CASE=1..5)
node scripts/fo-nav-invariant-check.mjs # INVARIANT: every route, context and width (incl. 767.5) keeps a tappable Home/Reports control
node scripts/embed-load-profile.mjs     # WP8: one phone visit, cold cache then warm — requests, bytes, timings
node scripts/embed-latency-check.mjs    # WP8: ⚠ costs 6 model turns; embedded vs direct, and the ownership-check cost
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
| `npm test` | **600 tests**: sign-in and sessions, the proxy, the embedding gateway and its protections, and the platform |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run icons` | Regenerate the PWA icons |
| `npm run qr -- <https url>` | QR code for a deployed URL, written to `qr/` |

The `scripts/*.mjs` checks above are separate: they drive a real browser against
a running app, so they need `npx playwright install chromium` once.

---

## Layout

```
lib/faborch/      This app's own calls to FabOrchestrator (sign-in, /me,
                  sign-out) and where the FO token lives.
lib/gateway/      Which paths are FabOrchestrator's, and how they are forwarded.
lib/              Session signing, auth middleware, rate limiting, validation.
app/fo-gateway/   The gateway route every FabOrchestrator request goes through.
app/api/pwa/      This app's own routes: sign-in and sign-out.
app/              Login, /diagnostics and /offline.
components/       Those pages, in FabOrchestrator's V2 design language.
scripts/          Browser-driven checks that run against a deployed URL.
```

---

## What this is not

Read before changing anything.

- **It computes nothing about manufacturing.** No yield calculation, no MES
  query, no metric detection, no SQL, no system prompt, no model call. If you
  are adding one, the boundary has been crossed — see "What NOT to build" in
  `CLAUDE.md`.
- **It does not check FabOrchestrator's answers.** The app forwards requests
  and pipes the replies back. The data an answer is about lives in
  FabOrchestrator and not here.
- **Sign-in is rate limited, and that is a mitigation rather than a fix.** Eight
  failed attempts from one address buys a ten-minute wait
  (`lib/rate-limit.ts`). It is per-process and per-IP, so it stops a script
  against one address and does nothing about a distributed attempt. A correct
  password is never throttled.
