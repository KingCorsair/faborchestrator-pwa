# FabOrchestrator — Production Order Exception Assistant

A progressive web app for shop-floor supervisors. One story:

**A production order has a problem → deterministic rules detect it → AI explains
it → the supervisor decides.**

`CLAUDE.md` in this directory is the design document and the record of every
decision. This file is only how to run it.

---

## Requirements

| | |
|---|---|
| Node | **20.11 or newer** (built and tested on 24.18) |
| npm | 10 or newer |
| Anthropic API key | Optional — see "Running without a key" |

Nothing else. No database, no Docker, no cloud account.

---

## Setup

```bash
git clone <your-remote>/faborchestrator-pwa.git
cd faborchestrator-pwa
npm install
cp .env.example .env
```

> **Cloning on Windows:** this app lives in a monorepo whose *other* directories
> contain paths longer than Windows' default 260-character limit, so a clone
> into a deep folder fails with `Filename too long` and a broken checkout. Clone
> somewhere short (`C:\work`), or enable long paths once:
>
> ```bash
> git config --global core.longpaths true
> ```
>
> Nothing in this demo has long paths — it is the neighbouring product code.

`npm install` also runs `postinstall`, which copies the barcode decoder's
WebAssembly binary into `public/zxing/`. If you skip lifecycle scripts
(`npm ci --ignore-scripts`), camera scanning falls back to manual entry.

Now open `.env` and set three values:

```dotenv
# Any long random string. Signs the session token.
SESSION_SIGNING_SECRET=...

# The password you will log in with.
DEMO_USER_PASSWORD=...

# Optional. Without it, see "Running without a key" below.
ANTHROPIC_API_KEY=sk-ant-...
```

Generate a signing secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> `.env` is gitignored and must never be committed. Put the API key in the file
> directly — not into a terminal command, a chat, or anything that keeps a
> transcript.

---

## Run it

**For a demo, always use production mode.** The dev server compiles each route
on first request, which stalls for a second the first time you open a screen.

```bash
npm run build
npm start          # http://localhost:3002
```

For development, with hot reload:

```bash
npm run dev        # http://localhost:3002
```

Log in with `supervisor@athenatech.example` and the password you set.

---

## The demo path

1. Open `http://localhost:3002` in Chrome. That is **FabOrchestrator's
   cockpit** — the product's own front door, reproduced: the ask bar, *The
   Nucleus* with its four agents, Live ops and Recent activity. **FabInsight™
   (AGENT · 01) is the only one of the four that opens here**, and it opens onto
   the real FabOrchestrator (see *FabInsight* below). Below the cockpit,
   **Review and approve production orders** goes to the orders screen, signing
   you in on the way if you are not already; the five cards beside it are other
   platform capabilities, listed so this demo is not mistaken for all of
   FabOrchestrator, and deliberately not links. The FabOrchestrator mark in the
   top nav returns here from any screen
2. **Install it**: click the install icon in the address bar. It opens in its
   own window with no address bar, and gets its own taskbar icon. An installed
   copy starts at the landing page too — `start_url` is `/`, while `id` stays
   `/orders` so existing installs are not orphaned
3. The top of the orders page is the **review panel** — pick any order and
   record Approve / Reject / Escalate there and then, without opening it
4. Search for **`PO-10382`** — the scenario order
5. Three problems are listed. Severity comes from `lib/mes/rules-config.ts`,
   not from a model
6. Press **Call agent to get analysis** (~10 s — a real API round trip). You can
   also decide without it: the decision controls are present from the moment the
   order opens, and anything recorded that way is logged as *decided without an
   AI analysis* rather than against an invented recommendation
7. Read the explanation. Every claim cites a `{record_id, field, value}` triple
8. The green **"Grounded in MES data"** badge means every citation was resolved
   against the MES. If any failed, the badge turns red and the bad value is
   struck through with the real one beside it
9. **Approve / Reject / Escalate**, then open **Activity**

To demonstrate scanning, open `/labels` on one screen and scan a barcode with
another device's camera.

---

## FabInsight

**FabInsight is not built here.** It is FabOrchestrator's own agent — AGENT · 01
on the product's cockpit — and this PWA is a client for it:

```
you type a prompt in the PWA
  → POST /api/faborch/chat            (this app, thin: auth + the FO token)
  → POST {FABORCH_BASE_URL}/api/chat  (the real FabOrchestrator)
  → FabInsight and its approved MCP tools answer
  → streamed back through the PWA and rendered
```

Nothing about yield, downtime, OEE or compliance is computed in this app for
that screen. If FabOrchestrator cannot answer, the PWA says so rather than
answering in its place.

### Turning it on

```dotenv
# The FabOrchestrator to forward prompts to. No default — see .env.example.
FABORCH_BASE_URL=http://localhost:3000
```

Locally that is `claudeai_athena`:

```bash
cd ../FabOrchestrator_product_code/claudeai_athena
npm run dev          # :3000 — needs its own DATABASE_URL and ANTHROPIC_API_KEY
```

Unset, `/fabinsight` says it is not connected to a FabOrchestrator and
everything else in this app works exactly as before.

### Signing in

The sign-in page takes **either** credential, and which one you use decides what
opens:

| Credential | Production orders | FabInsight |
|---|---|---|
| `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` | ✅ | ❌ — the screen says why and offers sign-in |
| A **FabOrchestrator** account | ✅ | ✅ — answered with that operator's tools, role, quota and audit trail |

There is no service account and no shared FabOrchestrator identity. A demo is
not a reason to hand whoever holds the URL somebody else's MES access, or to
attribute every prompt in FO's audit log to a machine.

The FO session token is held in an **httpOnly cookie** and never reaches client
JavaScript. Signing out drops it.

### The demo

1. On the landing page, type into the ask bar — *Give me the yield for the last
   two days* — or press one of the three chips. Both open `/fabinsight` with the
   question already asked. `/fabinsight?q=<question>` is a linkable demo
2. The answer streams in. While FabOrchestrator is calling one of its tools the
   screen names it: *FabOrchestrator is running query_yield_by_day…*
3. **Ask a follow-up.** The whole conversation travels with each turn, so
   FabOrchestrator has the context — there is no server state on either side

### If the answer is thin

Two things decide whether FabInsight can reach real data, and neither is in this
app:

- **the MCP connections on that FabOrchestrator account.** `/api/chat` loads its
  tools from them and nothing else, so an operator with none gets a model that
  cannot look anything up. The PWA enables every connection FO reports as
  `connected`, which is what the product's own chat does. Check them in
  FabOrchestrator under its MCP settings
- **that FabOrchestrator's `ANTHROPIC_API_KEY`.** An invalid key surfaces as
  *"A backend service is temporarily unavailable"* in the conversation, and as
  `API key is invalid` in FO's own server log

---

## On an iPhone

### The one thing that matters: HTTPS

`getUserMedia` and `serviceWorker.register` both require a **secure context**.
`localhost` is exempt; a phone reaching this laptop at `http://192.168.x.x:3002`
is not. Over plain HTTP on a LAN address you get an app that looks fine and
whose **camera scanner is silently dead** — `scanningIsSupported()` returns
false and the scan sheet offers manual entry as though the device had no camera
— and which cannot register a service worker, so there is no offline page.

iOS will still let you Add to Home Screen over HTTP. It just will not be the app
you built. **Serve it over HTTPS.**

### Recommended: a Cloudflare quick tunnel

Real TLS in about ten seconds, no account, no code changes.

```bash
winget install --id Cloudflare.cloudflared     # once
npm run build && npm start                     # terminal 1
cloudflared tunnel --url http://localhost:3002 # terminal 2
```

The second command prints a `https://<random-words>.trycloudflare.com` URL. Open
that on the iPhone.

> **That URL is public.** `lib/auth.ts` has one credential pair and no rate
> limiting, and a successful login spends your `ANTHROPIC_API_KEY`. Fine for a
> demo you tear down; do not leave it running, and stop the tunnel with `Ctrl-C`
> when you are done.

**Alternatives.** *Vercel* is the obvious host and currently **breaks the
demo**: `lib/decisions.ts` is a module-level `Map`, so on serverless each
invocation may be a fresh instance — you approve an order and Activity shows
nothing. That waits for Tier 3 persistence. *A local certificate* (mkcert, then
trusting the CA on the phone under Settings → General → VPN & Device Management
→ Certificate Trust Settings) is the option that works with no internet at all,
at the cost of a manual trust step on every device.

### Then, on the phone

1. **Open `/diagnostics` first.** Windows cannot remote-debug iOS Safari, so
   this page is the only console you have. Check *Secure context* reads **Yes**
   before anything else — it explains most iPhone failures on its own. Then tap
   **Test camera** and **Test decoder**.
2. **Install it.** Safari never fires `beforeinstallprompt`, so the app shows
   its own hint at the bottom of the screen: Share → **Add to Home Screen**. It
   appears only on iOS, only when not already installed, and only until
   dismissed.
3. Open it from the home screen. No address bar, its own icon, its own app
   switcher card.
4. Print or display `/labels` on the laptop and scan one with the phone.

### iOS behaviour worth knowing before you are in front of an audience

- **An installed iOS web app has its own storage jar**, separate from Safari's.
  Signing in in the browser does not carry into the installed app — you log in
  once more after installing. Expected, not a bug.
- **Camera access inside a standalone home-screen web app needs iOS 16.4+.**
  Below that, scanning works in Safari but not from the installed icon.
- **Nothing under `/api/` is cached**, deliberately. On weak site wifi that
  means honest error states, not stale figures.
- **Turn the phone sideways at least once** while testing. A notched iPhone in
  landscape puts a 44px inset on one edge, which is where the scan sheet's close
  button lives.
- **Add to Home Screen pins the icon to the URL that is on screen**, not to the
  manifest's `start_url`. Install from `/orders` — install from an error screen
  and the icon reopens that error screen forever. If an icon is behaving oddly,
  delete it and re-add it rather than debugging it.
- **If the installed app opens on "No connection" while the phone is online**,
  it is carrying a service worker from before 2026-08-18. Force-quit and reopen
  once: the new worker installs in the background and takes over, and the
  offline page now leaves by itself the moment a network probe answers.

---

## Sending the demo to someone else

The tunnel above is for a phone on your desk while you watch. If someone should
be able to open the app **whenever they like, without you starting anything**,
it has to be hosted.

### Why Fly, and not the two obvious alternatives

**Vercel breaks it.** `lib/decisions.ts` is a module-level `Map`. On serverless
each invocation may be a fresh instance, so you approve an order and Activity
shows nothing. That waits for Tier 3 persistence.

**Render's free tier sleeps** after ~15 minutes idle. A ~50-second cold start on
a link somebody opened unprompted reads as broken, and the restart empties the
decision store on its way past.

Fly runs one long-lived machine, which is what both problems need. `flyctl`
deploys **from this directory**, so no host is granted read access to the parent
repo — which also tracks the FabOrchestrator product source.

### Deploy

```bash
flyctl auth login
flyctl apps create <your-unique-name>     # then set `app` in fly.toml to match
flyctl deploy
```

Set the runtime configuration as secrets — never in the image, and never in
`fly.toml`, which is committed:

```bash
flyctl secrets set \
  SESSION_SIGNING_SECRET="$(openssl rand -hex 32)" \
  DEMO_USER_EMAIL="supervisor@athenatech.example" \
  DEMO_USER_PASSWORD="<a real password>" \
  DEMO_USER_NAME="A. Supervisor" \
  DEMO_USER_ROLE="Supervisor" \
  DEMO_PREFILL_EMAIL="true" \
  ANTHROPIC_API_KEY="<a key with a spend cap>"
```

> **Two of those are not boilerplate.** The login has **no rate limiting and no
> lockout**, and a successful login spends your Anthropic key — on a permanently
> public URL, with no upper bound. Use a password you would defend, and a
> *separate* API key with a spend limit set on it. `lib/auth.ts` says of itself
> that it must not ship as is; this is the deployment that makes that concrete.

`flyctl deploy` builds on Fly's remote Linux builder by default, so Docker
Desktop does not need to be running. To check the image locally first:
`docker build -t faborch-demo . && docker run -p 3000:3000 --env-file .env faborch-demo`.

> **`npm run build` on Windows prints a page of `EINVAL: copyfile` warnings.**
> Expected, and harmless. Turbopack names externals chunks after the module
> they wrap — `[externals]_node:path_….js` — and a colon is illegal in an NTFS
> filename, so only the copy into `.next/standalone/` fails. The build exits 0,
> `npm start` is unaffected (it serves `.next/`), and the deploy builds on Linux
> where the name is ordinary.

Check `.dockerignore` before the first deploy. `flyctl` uploads this directory
as the build context, and the parent folder holds `passwords.txt`,
`login details.txt` and a notes file with a live API key in it — all outside
this directory and all untracked, but worth knowing exactly where the boundary
is.

### Then make the QR code

```bash
npm run qr -- https://<your-app>.fly.dev/orders
```

Writes a PNG to `qr/` (gitignored — it encodes one deployment's URL). It refuses
anything that is not `https`, and refuses tunnel hostnames, because a QR outlives
a tunnel by days and a code that resolves to nothing reads as a broken demo.

**Send three things, not one:**

| | Why |
|---|---|
| The PNG | To scan off a laptop screen — nobody can scan their own phone |
| The URL as text | In case they open your message *on* the phone and just tap it |
| The sign-in details | Separately. Never in the URL: a QR is not a secret, and neither is a query string |

Point them at **`PO-10382`** first. It is the scenario order, and it is the only
one with a cached analysis if the key is ever unset or out of credit.

### What they should expect

- **Android** gets a native install prompt. **iOS** gets the app's own hint at
  the bottom of the screen, because Safari never fires `beforeinstallprompt`.
- **`/diagnostics`** is unauthenticated and is the first thing to open if
  anything looks wrong — it is the only console available on a phone.
- **Decisions are still in memory.** They survive as long as the machine does,
  and a redeploy or a restart clears them. The Activity screen says
  `durable: false` on its face, so this is honest rather than hidden — but it
  will surprise someone who approves an order and comes back a week later.

---

## Running without a key

The app works. Every **Explain** falls back to a saved analysis and the card
says so — a cached answer is never presented as a live one.

Only **`PO-10382`** has a saved analysis. Every other order returns an honest
`503` rather than an invented explanation. With a key, all six work live.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on 3002 |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | 95 tests — rules, AI contract, grounding, retry, scanning, decisions, platform |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run icons` | Regenerate the PWA icons |
| `npm run labels` | Regenerate the demo barcodes |
| `npm run qr -- <https url>` | QR code for a deployed URL, written to `qr/` |

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ANALYSIS_MODEL` | `claude-haiku-4-5-20251001` | Set to `claude-opus-5` for higher quality at ~2× the latency |
| `ANALYSIS_TIMEOUT_MS` | `40000` | **Per attempt.** A corrective retry can spend it twice |
| `SESSION_TTL_HOURS` | `12` | How long a login lasts |
| `DEMO_PREFILL_EMAIL` | `false` | Prefills the sign-in email. Convenient on a phone; leaves only the password on a public URL |
| `FABORCH_BASE_URL` | *(none)* | The FabOrchestrator FabInsight forwards prompts to. Unset, `/fabinsight` says it is not connected and nothing else changes. Set on the hosted demo in `fly.toml` under `[env]` |
| `FABORCH_MODEL` | `claude-opus-4-8` | FabOrchestrator's own default, which it presents as "FabOrchestrator 2.0". FO validates the id against its model registry and the operator's role |

---

## Layout

```
lib/mes/          The manufacturing layer — adapter contract, rule thresholds,
                  deterministic detection, mock data. The only place that knows
                  what an order is.
lib/ai/           The model call, the forced-tool-use schema, the prompt, and
                  grounding validation.
lib/scan/         Barcode decoding. BarcodeDetector, or zxing-wasm where that
                  does not exist.
lib/decisions/    The decision log. A contract, one file per backing store, and
                  an index that is the only place which picks between them.
lib/faborch/      The connection to the real FabOrchestrator: its HTTP contract
                  in one file, where the FO session token lives, and the reader
                  for its streamed reply. No manufacturing logic — see below.
app/api/          Authenticated routes. Zod on every input.
                  `faborch/chat` is the whole FabInsight integration: it
                  forwards a prompt to FabOrchestrator and streams the answer
                  back untouched.
app/              The landing page at / — FabOrchestrator's cockpit — plus
                  login, fabinsight, orders, order detail, decisions and
                  activity, and /labels, /offline and /diagnostics, which are
                  tools rather than sections of the product and are not in the
                  nav.
components/fab/   The whole presentation layer, in FabOrchestrator's V2
                  design language.
```

---

## What this is not

Read before showing it to anyone who might deploy it.

- **Decisions are only durable if you configure a database.** Set
  `DATABASE_URL` and the log goes to Postgres, insert-only, creating its table
  on first use. Leave it unset and decisions live in memory: they vanish on
  restart, on every redeploy, and on every hot reload. Both screens say which
  one you are on rather than leaving you to find out. See `.env.example`.
- **The authentication is a demo.** One credential pair from the environment,
  stateless HMAC tokens — logout cannot revoke, and a stolen token is valid
  until it expires. No user table. **It must not ship.**

  Sign-in is now **rate limited** — eight failed attempts from one address buys
  a ten-minute wait (`lib/rate-limit.ts`). That was added when this route
  learned to forward to a real FabOrchestrator, because on a public URL an
  unthrottled login that proxies to a production identity store is a
  credential-testing endpoint. It is a **mitigation, not a fix**: per-process
  and per-IP, so it stops a script against one address and does nothing about a
  distributed attempt. A correct password is never throttled — success clears
  the counter.
- **The MES data is mock JSON.** Six orders in `lib/mes/mock-data/`. Swapping in
  a real MES means implementing one interface (`lib/mes/types.ts`).
- **Decisions are held in memory.** They are lost on restart and are not shared
  between instances. The Activity screen says so on screen.
- **There is no offline data.** The app installs and runs standalone, and shows
  a proper offline screen when the network drops, but order data is read live
  and never cached — a cached downtime figure is a wrong downtime figure.
- **FabInsight is somebody else's product, and its answers are not this app's.**
  This PWA forwards the prompt and renders the reply. It does not check the
  answer, ground it against a record, or hold it to a schema — none of which
  would be meaningful, because the data it is about lives in FabOrchestrator and
  not here. **The `{record_id, field, value}` citations and the "Grounded in MES
  data" badge belong to the production order workflow only**, and the two must
  not be read as one guarantee: an order analysis is checked claim by claim, a
  FabInsight answer is whatever FabOrchestrator said.
- **The stats on the landing page are the product's placeholders.** *1,284
  queries today*, *142 workflows*, *8,394 automated* and the Recent activity
  list are hardcoded strings on FabOrchestrator's own cockpit, reproduced here
  on request for visual fidelity. They are the one place in this app where a
  number resolves to no record. Every figure on `/orders`, `/decisions` and
  `/activity` still comes from the adapter and the rules.
