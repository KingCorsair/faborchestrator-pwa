# Where this project stands

**As of 1 October 2026.** Code on branch `pwa/amay-embed-fo-production-hardening` of `KingCorsair/faborchestrator-pwa` (**public** on GitHub as of 30 September; see "Open" below). The embedding baseline and the 29–30 September production-hardening commits are described in their commit messages; the section directly below records the corrections made on top of them on 30 September.

This file is the running answer to "where are we and what is left". It records
what has been *proved*, not what has been written — anything claimed here has a
test, a probe report, or a browser run behind it. When the two disagree, this
file is wrong and should be corrected.

---

## One account, several devices: each device's conversations are its own — 1 October 2026

**On this branch, local only: not deployed, not pushed.** The hardening app
still runs release v3 (`06acee8`, tagged locally `deployed-hardening-v3`).

**Asked for (Amay, 1 October):** several people may sign in with the same
FabOrchestrator account; inside this app each device is its own private session
and sees and uses only the conversations it started. **FabOrchestrator is not
changed**: logins, plant data and the model stay the existing real ones. The
full description, limits and deployment steps are in
`docs/CONVERSATION_SEATS.md`.

| Area | Change | Where | Tests |
|---|---|---|---|
| Device and seat | A browser's first sign-in mints a device key in the httpOnly cookie `__Host-faborch_seat`; its hash, the seat, is signed into the session (`sid`). Sign-out and expiry leave the cookie, so the same browser returns to the same seat. Nothing is sent to FabOrchestrator | `lib/faborch/device.ts`, `lib/auth.ts`, `app/api/pwa/auth/login/route.ts` | `device-seat.test.ts` (20) |
| Ownership store | One append-only file of validated, checksummed records; writes serialised and flushed before they are believed; a corrupt or conflicting record grants nothing; no in-memory fallback | `lib/gateway/seat-store.ts` | `seat-store.test.ts` (23) |
| The seat rule | The conversation list is cut down to the seat's rows; a new conversation is recorded before the phone hears of it; any request naming a conversation that is not the seat's is refused before FabOrchestrator is asked; everything else is forwarded unchanged | `lib/gateway/seats.ts`, `app/fo-gateway/[...path]/route.ts` | `seat-isolation.test.ts` (39) |
| Artifacts | `/api/artifacts` is denied (404): an artifact id cannot be tied to a device and FabOrchestrator's client never calls it | `lib/gateway/registry.ts` | `seat-isolation.test.ts` |
| Deployment | The store lives on a volume; the container starts as root only to hand the store's directory to `nextjs`, then runs the server as `nextjs` | `Dockerfile`, `fly.hardening.toml`, `.env.example` | not built locally (no Docker here) |

**Verified, locally.** 879 tests (797 before), `tsc`, `eslint`, `next build`.
`scripts/two-seat-check.mjs`, two cookie jars on one account through this app's
production build against an **unmodified** local FabOrchestrator: **72 of 72**,
including the check that FabOrchestrator itself still lists both conversations
for the account. After a hard kill and restart on the same store file each
device still had exactly its own (6 of 6). Two separate browsers on
FabOrchestrator's real screens: 11 of 11. The local FabOrchestrator used a local
test database and a model stand-in (no working model key was available).

**Not verified.** Anything against the real FabOrchestrator or the deployed
app; the container image (the start command was syntax-checked, not run); real
phones.

**Departs from the plan.** RP2 records "no PWA session store" and "shared
accounts are not a PWA requirement" (24 September). This implements the opposite
on the owner's instruction; the plan document was not edited and needs a
revision and its review.

**Open.** Deploying needs a 1 GB Fly volume and recreates the machine. Everybody
is signed out once and every device starts with an empty history; existing
conversations stay in FabOrchestrator and at its own site. Isolation is inside
this app only. Memory, usage limits, settings and MCP connections stay shared.

---

## Corrections on the hardening branch — 30 September 2026 (Chetan)

**Asked for:** (1) FabOrchestrator's frontend and backend both from the real
FabOrchestrator; (2) proper error handling and session management.
**Decided with Chetan the same day:** real FabOrchestrator screens only (no
separate UI build unless a preview switches it on deliberately); the frozen RP2
session design in full, plus only the clear-cut error fixes; and a stopgap for
answers lost when the phone disconnects.

**Against the plan's process** (`CLAUDE.md`, "the RP process"): RP1 and RP2 are
frozen, and this implements RP1 part 3 (body policy) and part 6 (the preview
split), and RP2 stages 3–7, with the RP2 design approved for implementation by
Chetan on 30 September (CP2). CP2's other items are unchanged and still open:
the revoke deadline value (5 s today; 3 s proposed) and the FO-owner questions.
RP5 and RP6 are **not** frozen; only these pieces of them were built, on
Chetan's instruction: coded JSON 404s for API paths and no FabOrchestrator
address in error bodies (RP5); the per-conversation proof with refusal instead
of stripping (RP6 parts 2–3). The keep-reading stopgap **departs from RP4**,
whose rule is that the phone's disconnect aborts the upstream call; it is
recorded here and is to be deleted once FabOrchestrator saves an answer on
disconnect (§9 question 47). The plan document itself was not edited.

### What changed

| Area | Change | Plan | Where | Tests |
|---|---|---|---|---|
| Real FO screens | `FO_UI_BASE_URL` is honoured only beside `FO_UI_SPLIT_ALLOWED=1`; without it every FO page fails closed (`503 not_configured`, detail in the log only). `fly.preview.toml` no longer sets it. A `Location` naming either FO origin is kept on this app | RP1 part 6, G17, G18 | `lib/gateway/upstream.ts`, `headers.ts`, the gateway route | `upstream.test.ts`, `headers.test.ts` |
| Signing keys | Every token names its key (`kid`) and carries `iat`, `iss`, `aud`; previous keys verify-only; secret at least 32 characters; tokens minted before this change (no `kid`) still verify with the current secret, so the deploy signs nobody out | RP2 part 5, m2 | `lib/auth.ts` | `session-keys.test.ts` |
| One session check | `requireAuth` and the gateway bridge share `checkSession`; every refusal is the same `401 session_invalid` | RP2 | `lib/auth/verify-session.ts`, `auth-middleware.ts`, `auth-bridge.ts` | `injection.test.ts`, `route-gate.test.ts` |
| A refused session is ended | An expired bearer, or one beside a cookie that is not its own: 401 at once, cookie cleared, FabOrchestrator's token revoked after the response (once, however many calls were refused together); a malformed bearer changes nothing | RP2 G5 | the gateway route, `lib/faborch/end-session.ts` | `session-end.test.ts` |
| Ending a session | Server: clear the cookie and answer, revoke after, log `session_end` with the reason. Browser: tell the server, forget both keys, whole-document navigation to sign-in. Every expiry path now revokes: `/me` 401, a missing bearer, the sign-in page's own check, sign-out, and `fo-shell.js` (which now also returns the operator to the page they were on) | RP2 m3 | `end-session.ts`, `lib/end-client-session.ts`, `use-session.ts`, `login-page.tsx`, `sign-out-link.tsx`, `app-shell.tsx`, `public/fo-shell.js` | `session-storage-guards.test.ts`, `fo-native-parity.test.ts` |
| Sign-out only from this app | A request whose headers say cross-site is refused `403 cross_site_request`, cookie kept; no header, allowed | RP2 G26 | the logout route, `lib/same-origin.ts` | `login.test.ts`, `same-origin.test.ts` |
| Sign-in | Only from this app's pages and only JSON (`403 cross_site_request`, `415 unsupported_media_type`); this app's session settings checked **before** FabOrchestrator is asked anything, and a failure after FabOrchestrator issued a token revokes it; a new sign-in revokes the session it replaces; `next=/force-password-change` for a forced change, where this origin serves that page; FabOrchestrator's own user fields in the answer and **FabOrchestrator's session-blob shape** in localStorage (its sidebar showed "User" instead of the name); the FO cookie lives the session plus 5 minutes (`SESSION_COOKIE_GRACE_S`), not FabOrchestrator's 30 days; coded errors, never FabOrchestrator's address; FabOrchestrator still demanding a change after the same user made one on this browser gives an explained `403 password_change_required` (the gateway marks the browser, for that user only, on a successful change) | RP2 steps 1–6, G20, G30; RP3 part 5 (gate only); RP5 m4 | the login route, `lib/faborch/session.ts`, `lib/faborch/password-mark.ts`, `lib/stored-session.ts`, `login-page.tsx` | `login.test.ts`, `login-me.test.ts`, `session.test.ts`, `stored-session.test.ts` |
| Request size | Policy 20 MiB with a coded 413; Next hands the app 25 MiB (it cut every body at 10 MB, so long chats reached FabOrchestrator truncated); every body is read, measured and forwarded exactly, with its own length; the phone's `content-length` is never forwarded | RP1 part 3, G2, B5 | `lib/gateway/body-limit.ts`, `next.config.ts`, `headers.ts`, the route | `body-limit.test.ts` |
| Conversation ownership | Proved per conversation (`GET /api/conversations/{id}`, FabOrchestrator's own check), so it also works past FabOrchestrator's 1,000-row list cap; an unproved id is **refused**, never stripped into a turn that is silently not saved: 403 `conversation_forbidden`, 503 `ownership_unavailable` with `Retry-After`, 400 `invalid_request`, 401 `faborch_session_expired`; a change FabOrchestrator refuses (a 403 `PATCH`) is forgotten like a delete | RP6 parts 1–3 (not frozen) | `lib/gateway/ownership.ts`, `lib/faborch/client.ts` | `ownership.test.ts`, `route-ownership.test.ts` |
| Not found, and pages that cannot load | An unknown `/api` path is a coded JSON 404 (front door and gateway); one of FabOrchestrator's pages the gateway cannot deliver (not configured, unreachable, too slow) gets a small HTML page with the same status and code instead of raw JSON in the app's window | RP5 G8, part 3b (not frozen) | `proxy.ts`, the route, `lib/gateway/error-page.ts`, `lib/gateway/destinations.ts` | `route-gate.test.ts`, `native-routes.test.ts`, `document-errors.test.ts` |
| Lost answers (stopgap) | A chat answer is split: the phone gets its half as before, the gateway reads the other to the end, so FabOrchestrator saves it even when the phone is minimised mid-answer; **a new question in the same conversation stops that read**, so an old answer is never saved after a newer question; a turn whose phone has already left is not forwarded; the stream deadlines still apply; at most `KEEP_READING_MAX_STREAMS` (50) at once | departs from RP4 | `lib/gateway/keep-reading.ts`, `deadline.ts`, the route | `deadline.test.ts`, `keep-reading.test.ts` |
| Sign-in page | No longer describes the retired production-order workflow | — | `login-page.tsx` | — |

### Verified

* `npm run typecheck` clean; `npm run lint` clean; `npm test` **774 tests, 0
  failing** (platform 207, faborch 303, gateway 264; 674 before); `npm run
  build` exit 0, reporting `proxyClientMaxBodySize: 26214400`.
* **End to end against the built server** (`next start`) and a stand-in
  FabOrchestrator that, like the real one, saves an answer only when its stream
  is read to the end: **18/18** — the sign-in page; sign-in with the cookie at
  the session plus 5 minutes (`Max-Age` 43500) and FabOrchestrator's user
  fields; a JSON 404 for an unknown API path; **a chat whose phone disconnected
  after two frames was read to the end and saved**; **Stop followed at once by
  the next question left the thread in order** (question, question, answer —
  the stopped answer dropped, as on FabOrchestrator's own site); somebody
  else's conversation refused 403; a 12 MB chat reaching FabOrchestrator whole
  (12,582,978 bytes; Next used to cut at 10 MB) and a 21 MB one refused 413; an
  expired session answered 401 with the cookie cleared and FabOrchestrator's
  token revoked; a cross-site sign-out refused; sign-out and re-sign-in both
  revoking. The server log carried only fingerprint and id prefixes.

### What a deploy now needs

* **`SESSION_SIGNING_KEY_ID`** — `fly.toml`, `fly.preview.toml` and
  `fly.hardening.toml` set `2026-09`; any other app must set it, or sign-in
  and every gateway call fail loudly.
* **The hardening test app keeps the UI split, on purpose**
  (`fly.hardening.toml`, `faborch-pwa-amay-hardening`): `FO_UI_BASE_URL` with
  `FO_UI_SPLIT_ALLOWED=1`, so FabOrchestrator's pages come from the
  `mobile-nav-preview` build and the phone has its sidebar opener and Back
  button, while every API call goes to FabOrchestrator production through the
  gateway. A deploy of that app without the two lines (release v2, 30
  September) removed the phone navigation; nothing in this app changed.
  Temporary, until FabOrchestrator production has the fix.
* **`SESSION_SIGNING_SECRET` of at least 32 characters** (the old minimum was 16).
* To show FabOrchestrator's real screens, **remove `FO_UI_BASE_URL`** from the
  app's settings; left alone without `FO_UI_SPLIT_ALLOWED=1`, every
  FabOrchestrator page answers 503.
* Nothing else: existing sessions survive (their tokens verify with the same
  secret), and no database or store is added.

### Independent review

A separate review agent read the whole change adversarially (a general-purpose
subagent given the plan and the diff; not the plan's charter review). Found:
0 blocking, 3 should-fix, 6 minor. Fixed: the password-change mark was per
browser, not per user (now an HMAC of the user id); unusable session settings
were found only after FabOrchestrator had issued a token (now checked first,
reported when the routes load, answered 503 `not_configured` rather than 500,
and anything failing after `foLogin` revokes its token); Stop and the next
question (above); `next` naming a page this origin does not serve; a late
answer on the sign-in page or the screens ending a newer sign-in; a test that
did not prove "revoked before the answer"; tokens without a key id tried only
against the current key; no JSON-only or cross-site rule on sign-in; a 403
`PATCH` not forgetting its conversation; JSON errors on FabOrchestrator's pages;
one revoke per refused call; an unguarded navigation in `fo-shell.js`. Left as
they are, with the reason: secrets are used exactly as set (`.env.example` says
they must not start or end with spaces); `PUBLIC_ORIGIN` is not set in the Fly
configs, because an app deployed under another name from the same file would
get a wrong value, and `Sec-Fetch-Site`, which every supported browser sends,
decides first; an unknown `/api/pwa/*` path, and any path in `off` mode, still
gets Next's own HTML 404.

### Open, and why

* **FabOrchestrator's chat shows a gateway refusal's body as text** (a 403 or
  413 on a chat turn appears as a JSON line). The plan's interim rule, §9
  question 57; the fix is FabOrchestrator rendering `error`.
* **Below 768 px FabOrchestrator's sidebar has no opener** until FabOrchestrator
  merges its phone-navigation fix; with the preview now on the real screens,
  the preview shows that too.
* **The stopgap only saves the answer**: the phone sees it after reopening the
  conversation. Remove it once FabOrchestrator saves on disconnect (§9 q47).
* **Stop means something slightly different here**: the gateway cannot tell
  FabOrchestrator's Stop button from the phone being minimised, so a stopped
  answer is read to the end and saved whole — unless the operator asks the
  next question in that conversation first, which drops it, as FabOrchestrator's
  own site always does. The screen shows what was streamed before Stop.
* Not in this change: RP1 per-route methods and `clientIdentity`; RP3's
  limiter; RP4's stream slots, shutdown and the abandoned-login revoke (site v);
  RP5's envelope and `requestId` everywhere; RP7's security headers; RP10.
* **The GitHub repository is public.** It holds the production FabOrchestrator
  address, detailed write-ups of FabOrchestrator's security gaps and probe
  screenshots of production data. It should be made private (owner:
  KingCorsair).

---

## Mobile navigation — FabOrchestrator's own, responsive: implemented, on the preview

**11 September 2026.** Approved by Amay: FabOrchestrator hiding its navigation
below 768px with no usable replacement is **FabOrchestrator's responsive
defect**, to be fixed in FabOrchestrator — reusing its own components and
destinations, collapsing into a menu or drawer on a phone rather than forcing
the desktop row onto one — after which this app's workaround goes. **Production
untouched**: neither FabOrchestrator production nor `faborch-demo`. Nothing is
committed.

### The diagnosis this corrects

* **The installed app never removed FabOrchestrator's navigation.** Measured on
  every route: at the same width, FabOrchestrator opened directly, through the
  gateway, and at the installed app's viewport render identical navigation. The
  gateway's document is byte-for-byte FabOrchestrator's apart from the injected
  tags; FabOrchestrator has no `display-mode`/standalone CSS, no
  `viewport-fit`, no server-side user-agent logic.
* **FabOrchestrator hid it itself below 768px**, two ways: the cockpit header's
  row is `hidden md:flex` with nothing in its place (`/home`, `/reports`), and
  the chat and modeling sidebar is a drawer whose only trigger was inside it.
* **A real iPhone in landscape is 750px wide, not 844.** Safari insets a
  landscape page on a notched iPhone by its safe areas. That is below the
  breakpoint, so a turned phone gets the phone layout — earlier checks and
  `OPEN_ISSUES.md` 0a said it got the rail, and are corrected.

### The responsive pattern, per surface

| Surface | 768px and up | Below 768px |
|---|---|---|
| `/home`, `/reports`, an opened report | the cockpit header's link row, **unchanged** | the same header; a **menu button** at its left opens FabOrchestrator's own `DropdownMenu` — Cockpit and Reports, and Chat **shown disabled**; the current page marked. Every phone view, browser or installed (v5, below). The row stays hidden: five labelled items are ~500px |
| `/chat`, `/modeling-agent`, `/modeling-agent/loader`, `/modeling-agent/loader/[id]` | the sidebar rail, **unchanged** | FabOrchestrator's own drawer, opened from a **slim bar in normal flow** at the top of the content holding its own `SidebarTrigger` and wordmark — the two things its sidebar header shows |
| an opened report | "All reports", unchanged | the same; opening now scrolls to the top so it is on screen |

Exactly one navigation system in every case. On the agent pages the trigger
bar is `md:hidden` and the drawer-versus-rail switch is FabOrchestrator's own
`MOBILE_BREAKPOINT`, the same 768px. On the cockpit and Reports the header
menu is `md:hidden` and the row `hidden md:flex` — exact complements, in every
context (v5, below).

### Installed-app scoping: a regression, the rollback, and the fix (FO UI v2 → v3 → v4)

**11 September, later.** Amay asked for the new phone navigation to apply only
to the installed phone app.

**v2 — the regression.** The first attempt gated everything new — the header
menu *and* the agent pages' trigger bar — on a CSS `display-mode` media query.
On Amay's iPhone the navigation vanished in the installed app **and** in
Safari, Reports menu included. One cause per context:

* **In a phone browser it was by construction.** A browser got FabOrchestrator
  production's own phone behaviour — measured identical in Chromium and WebKit
  (23/23 each) — and that behaviour *is* a closed drawer with no trigger and a
  header whose links are hidden below 768px. "Browser unchanged" and "sidebars
  reachable on a phone" cannot both hold; asked, Amay chose **keep sidebars
  reachable**.
* **In the installed app, detection failed on the device** while passing in
  Chromium. It relied on `display-mode` alone, which iOS reports for a
  home-screen app only when it honours the manifest's `display` — and then as
  `fullscreen` (WebKit bug 264218). iOS's dependable signal,
  `navigator.standalone`, was not used.

Desktop was never affected (23/23 identical to production).

**v3 — the rollback.** v1's exact image
(`deployment-01M276JM15R9E0G3422Z68WNPD`) redeployed to
`faborch-fo-ui-preview` with no rebuild, and the branch source restored to v1
(5 files, +120/−15, line for line). Verified in plain browser mode, 57/57, and
by eye: desktop sidebars and header row, the phone Reports menu,
FabOrchestrator's drawer opened by its own trigger, an opened dashboard's
"All reports".

**v4 — the fix, from v1.**

| | Desktop | Phone browser | Installed app, phone |
|---|---|---|---|
| `/chat`, `/modeling-agent*` | FO's rail, unchanged | FO's drawer + the trigger bar | the same |
| `/home`, `/reports` | FO's header row, unchanged | FO's website header, unchanged — no menu | header menu: Cockpit, **Chat disabled**, Reports |
| An opened report | unchanged | unchanged | opens scrolled to the top |

* **Detection** (`lib/installed-app.ts`): an inline script in `<head>`
  (`app/layout.tsx`) sets `data-installed-app` on `<html>` **before first
  paint** when `display-mode` is `standalone`, `fullscreen` or `minimal-ui`,
  **or** `navigator.standalone` is true, and follows display-mode changes. A
  browser tab is `browser` with `navigator.standalone` false or absent, so it
  is never marked. `<html>` already carries `suppressHydrationWarning`.
* **Gating:** the `installed-phone:` Tailwind variant — that attribute and
  `max-width: 767px` — shows the header menu and its phone padding;
  `isInstalledPhone()` gates the report scroll. Everything visible is decided
  by CSS, so nothing renders late.
* **Chat:** FabOrchestrator's own `DropdownMenuItem disabled` —
  `aria-disabled`, `data-disabled`, skipped by the keyboard, never
  highlighted, half opacity, no pointer events, no click handler.
* **How the installed app is tested:** Chromium here cannot install a PWA over
  DevTools and ignores display-mode emulation, but the Fullscreen API makes it
  report `display-mode: fullscreen` — iOS's value — and FabOrchestrator's own
  detection then marks the page. Closest reproduction available; the iPhone
  remains the final check.

### v5 — never zero navigation on /home and /reports

**11 September, later still.** On the iPhone the header menu never appeared.
The device's own diagnostic report settled why: its home-screen icon opened the
preview as an ordinary **Chrome for iOS tab** (`CriOS/145`, `display-mode:
browser`, `navigator.standalone` false) — not an installed app. And in every
browser below 768px v4 left `/home` and `/reports` with **no Home or Reports
control at all**:

| | Classes | Shows when |
|---|---|---|
| Header link row | `hidden md:flex` | ≥ 768px |
| v4 menu button | `hidden installed-phone:flex` | ≤ 767px **and** installed |

They are not complements. Below 768px in a browser neither matched; at
fractional widths between 767 and 768 — seen on a desktop at Windows scaling,
`innerWidth` 767 while `max-width: 767px` was false — neither matched even in
the installed app. Agent pages never had the problem: their bar was already
`md:hidden`. The checks passed it because they asserted elements one at a time
and treated "a phone browser shows no phone menu" as correct; none asserted
that *some* navigation is visible.

**Amay's call:** Home and Reports must be available in every version —
desktop, phone browser, installed app. **The fix**, in FabOrchestrator's
`components/cockpit/cockpit-nav.tsx`:

* menu button `hidden installed-phone:flex` → **`flex md:hidden`**, the exact
  complement of the row; nothing about the installed app decides whether
  navigation exists;
* header padding and brand margin → `px-4 md:px-[26px]` and
  `mr-1 md:mr-[22px]`, desktop values unchanged;
* the `installed-phone` variant and its `max-width: 767px` removed from
  `app/globals.css`; `isInstalledPhone()`, still used for the installed app's
  report scroll, now tests "not `md`";
* desktop row: Cockpit and Reports go to `/home` and `/reports`. They were
  placeholders that both led to `/home`, so desktop `/home` had no way to
  Reports. Agents, Workflows and Sites unchanged; the row looks the same.

**The invariant**, `scripts/fo-nav-invariant-check.mjs`: on every route, in
every context, at every width — 390, 750, 767, a real 767.5, 768, desktop —
exactly one visible, tappable navigation system that reaches Home and Reports,
proved by tapping.

### v6 — a Back button in the agent pages' phone bar

**11 September.** On `/chat` and `/modeling-agent*` below 768px the phone bar
now carries, at its top-right, the sidebar header's own **Back to overview**:
the same label, title, arrow glyph and destination — `router.push("/home")`,
which both agent apps' sidebars already use (and the chat sidebar's
"FO Overview" too). Nothing new was invented.

* It lives in `components/mobile-sidebar-bar.tsx`, a sibling of the trigger,
  so it shows and hides with the bar — `md:hidden`, the same breakpoint as the
  bar and the drawer. No installed-app condition, no script, no polling.
* The sidebar trigger is untouched and stays at the left, `8,4,40×40` as
  before; the Back sits at the right (`ml-auto`), so they cannot overlap.
* At 768px and up the bar is `display: none`; the rail carries its own Back.
  `/home` and `/reports` do not render the bar at all.
* Rendered with the bar on the server, so it cannot appear late or shift the
  layout.

### Verified on the preview — FO UI v6: 991 checks, 0 failures

| Check | Result |
|---|---|
| `fo-nav-invariant-check` — 15 contexts: desktop 1280, 768, **767.2 and 767.5** (real fractional viewports: device scales 1.25 and 1.6 in Chromium's new headless mode), 767, 750, 390; phone browser and WebKit at 390 and 750; installed app at 390, 750, 767, 768 | 527/527 |
| `fo-installed-nav-check` — desktop identical to FabOrchestrator production; phone views; installed app with 5 open/close cycles sampled every frame (trigger never moved, no frame without a control) | 223/223 |
| `fo-mobile-nav-check` matrix / taps / parity | 130 / 34 / 20 |
| `embed-mobile-hardening-check` / `fo-navigation-check` | 35 / 22 |

The invariant holds at every width tested, including the fractional ones:
`/home` and `/reports` always show exactly one tappable Home/Reports control,
and tapping takes them to `/reports` and `/home`. Agent pages always show
exactly one sidebar control. Below 768px the bar's Back is visible, tappable,
top-right, covers nothing and opens `/home`, and the trigger stays at
`8,4,40×40`. At 768px and up there is no external Back. `/home` and `/reports`
never show one.

The temporary diagnostics (`app/api/pwa/diag`, and a reporting block in
`public/fo-shell.js`) were removed once this was verified.

### The old flicker — reproduced, and why it cannot recur

v20's external ☰ was rebuilt verbatim and run on a real page, sampling every
animation frame across five open/close cycles:

| | v20 ☰ (script show/hide) | FabOrchestrator's trigger bar |
|---|---|---|
| Missing after the close tap | 402–702 ms | never — `display` never `none` |
| Still missing after the drawer was gone | 67–350 ms | 0 ms — tappable the same frame |
| Left showing over the opening drawer | 117–400 ms | — |

**Cause:** v20 decided visibility in script from the drawer element's
presence, re-checked on a 400 ms poll, while Radix keeps the drawer mounted
~350 ms through its exit animation — so the button stayed hidden through the
animation and then up to one more poll. **Fix:** the external control is
FabOrchestrator's own `SidebarTrigger`, always mounted in normal flow, its
visibility decided by CSS alone; opening and closing never touch it — the
drawer simply covers it.

### The FabOrchestrator change

Branch `mobile-nav-preview` off `origin/main` `1b9b117`, in the worktree
`AthenaTech/fo-mobile-nav` — **uncommitted**, 7 files, +203 / −19:

| File | Change |
|---|---|
| `components/mobile-sidebar-bar.tsx` (new) | the phone bar: `SidebarTrigger` + wordmark + the sidebar's own Back to overview (v6), in flow, `md:hidden` — every phone view |
| `components/full-chat-app.tsx` | renders the bar; the chat below it in a `min-h-0 flex-1` wrapper so the composer is not pushed off screen |
| `components/agent-chat/modeling-chat-app.tsx` | the bar above both views; the chat view `h-full` → `flex-1`, as the loader view already was |
| `components/cockpit/cockpit-nav.tsx` | the phone menu, `md:hidden` (`MOBILE_NAV`: Cockpit `/home`, Chat `/chat` **disabled**, Reports `/reports`); phone padding `px-4` / `mr-1` with the desktop values under `md:`; the desktop row's Cockpit and Reports go to their pages |
| `app/reports/page.tsx` | in the installed app, a report opens scrolled to the top of the page's scroll container |
| `lib/installed-app.ts` (new) | the detection script (`display-mode` or `navigator.standalone`), the attribute, `isInstalledPhone()` |
| `app/layout.tsx` | runs that script inline in `<head>`, before first paint |

**Deliberately not changed:** the desktop row's items still all lead to `/home`
(OPEN_ISSUES 0c, fact two), and Agents, Workflows and Sites — which have no
pages — are not offered on the phone.

`c8ffc43` was the starting point for the chat trigger but is not used as is: it
floats the trigger over the content, where it would sit on the first message
and, on the modeling agent, on its CMF status strip.

### Previewing it without touching FabOrchestrator production

* **`faborch-fo-ui-preview`** (`fly.fo-ui-preview.toml`): the branch built with
  FabOrchestrator's own Dockerfile. **No secrets, no public IP**, reachable only
  as `faborch-fo-ui-preview.internal:3000` on Fly's private network. Its boot
  log shows the report scheduler and the CMF connection store failing with
  `ECONNREFUSED` — no database is configured, so neither can reach anything.
* **`FO_UI_BASE_URL`** (`fly.preview.toml`, `lib/gateway/upstream.ts`): the
  gateway sends FabOrchestrator **documents and static assets** there and
  **every API call** to `FABORCH_BASE_URL` as before. Split by class, never by
  path, because a page and its chunks must come from the same build. Plain
  http is accepted only for `*.internal` and loopback. 3 new unit tests.
* **Rollback:** delete the `FO_UI_BASE_URL` line and redeploy. Note that with
  the workaround below removed, that returns the preview to production
  FabOrchestrator's phone behaviour — no navigation below 768px — so a
  rollback that must keep phone navigation also restores `public/fo-shell.js`
  from v20.

### This app's workaround, removed

* **`public/fo-shell.js`, 525 → 143 lines.** Gone: the Back arrow, the
  hamburger, the `Ctrl/Cmd+B` keyboard-shortcut driver, `clickRealTrigger`,
  `sidebarIsOpen`, the corner-measuring `rightEdgeObstruction`, the 400 ms poll
  and the resize/orientation listeners. Kept: the single-sign-out watcher and
  the service-worker registration, verbatim. This app keeps no navigation.
* `scripts/fo-back-nav-check.mjs` deleted, replaced by
  `scripts/fo-mobile-nav-check.mjs`; `embed-mobile-hardening-check.mjs` and
  `fo-navigation-check.mjs` re-targeted at FabOrchestrator's own controls (and
  the latter's 844-is-landscape claim corrected); comments in the gateway route
  and `html-inject.ts` no longer describe the shell as navigation.

### Verified before the workaround was removed (v21)

`scripts/fo-mobile-nav-check.mjs`, with the old shell still injected so
FabOrchestrator's navigation was proven before anything was taken away:

* **matrix** — 6 routes × 5 widths (390×664, 390×797 installed, 750×342
  real iPhone landscape, 844×390, 1280×900): every FabOrchestrator navigation
  assertion passed — one system, control covers nothing and is not covered, no
  sideways scrolling. The only failures were the 30 expected "navigation
  injected by this app", i.e. the shell being removed.
* **taps** — 32/32 at 390 and 750: the cockpit menu reaches Reports and Chat
  with the current page marked; the chat drawer holds Back to overview, New
  chat, Dashboard and the account menu, and reaches `/reports` and `/home`;
  tapping outside closes it; the modeling drawer reaches Master data loader; a
  report opened from the bottom of the list shows "All reports" at y=103 on
  both screens, and it returns to the list.
* **parity** — 20/20: at 1280 the header, link row, sidebar rail, content area
  and triggers are geometrically identical (to within 1px) to FabOrchestrator
  production on `/home`, `/reports`, `/chat` and `/modeling-agent`.

### Verified after the workaround was removed (v22)

Every check against the preview, **292 checks, 0 failures**:

| Check | Result |
|---|---|
| `fo-mobile-nav-check` matrix | 130/130 — now including "no navigation injected by this app" on every route at every width |
| `fo-mobile-nav-check` taps | 32/32 |
| `fo-mobile-nav-check` parity | 20/20 |
| `embed-mobile-hardening-check` | 31/31 — FabOrchestrator's trigger at 390; still the phone layout at 750; the rail at 844; standalone; composer on screen and no sideways scrolling at 390 and 360 |
| `fo-navigation-check` | 22/22 — FabOrchestrator's Back reached through its drawer at 390 and 750, on its rail at 844, and lands on `/home` |
| `fo-auth-loop-check` | 16/16 — the single-sign-out watcher, kept in the shell, still breaks the `/home` ↔ `/` loop |
| `pwa-install-check` | 26/26 — manifest and service worker on FabOrchestrator's pages |
| `embed-routing-check` | 15/15 |

Unit tests 568/568 (144 platform · 253 faborch · 171 gateway); typecheck
clean. FabOrchestrator's typecheck reports nothing in the five files changed.

### Still needs a phone

* The installed app on a real iPhone, portrait and landscape. Chromium cannot
  emulate `display-mode: standalone` or safe-area insets, and 750px is
  Playwright's Safari-measured iPhone 13 landscape profile, not a measurement
  taken on the device.

### Found, not changed

* **FabOrchestrator's drawer stays open after an in-page pick on a phone** —
  measured for New chat and Master data loader; nothing in either app calls
  `setOpenMobile(false)`, so a conversation pick behaves the same. Picks that
  change the route (Dashboard, Back to overview) unmount it. A small
  FabOrchestrator follow-up; not in the approved change.
* The Reports list's timezone select is clipped at 390px — identical on
  FabOrchestrator production, not navigation.

## WP10 — whole-application embedding: implemented, deployed to preview (v16)

**10 September 2026.** The corrected direction Amay approved after the audit: the
PWA is an installable delivery of the real FabOrchestrator, not a separate
cockpit linking to a few of its pages. Deployed to the preview at **v16**,
`sjc`. **Production untouched.** Nothing is committed.

### Both mobile controls: Back arrow and hamburger — v20

**10 September.** The Back arrow stays; the hamburger is restored beside it,
using the v18 mechanism verbatim. On agent conversation pages below 768px:

| Control | Position | Action |
|---|---|---|
| Back arrow | top-right | FabOrchestrator's own `/home` |
| Hamburger | bottom-left | FabOrchestrator's own mobile sidebar |

Above 768px neither is rendered and FabOrchestrator's persistent sidebar is
untouched. **No `/home` fallback anywhere** — the hamburger navigates nowhere;
`location.assign` appears exactly once in the file, in the arrow's handler.

The two answer different needs, which is why both belong: the arrow is the way
*out* of a conversation, the hamburger the way *into* everything the sidebar
holds.

#### The mechanism, reused not reinvented

`fo-shell.js` was untracked, so the v18 code was not in git — it was recovered
from the patch that produced it and restored verbatim: `clickRealTrigger()` →
`pressFabOrchestratorShortcut()`, with `sidebarIsOpen()` for visibility.

FabOrchestrator's `SidebarProvider` registers its `Ctrl/Cmd+B` shortcut as a
plain `window.addEventListener("keydown", …)` inside a `useEffect`, and
`handleKeyDown` calls its own `toggleSidebar()` — below 768px,
`setOpenMobile(open => !open)`. React's untrusted-event filtering applies to its
own synthetic handlers, not to native listeners, which is why dispatching that
event works and why the WP6 note claiming otherwise was wrong.

Both controls hide while the sheet is open — a floating control on top of the
navigation it exists to reach has nothing left to do — and both return when it
closes. The poll watches path, sheet state and the late-rendering header on one
400 ms tick, because none of those has an event of ours to hang on.

#### Verified on the deployment (v20, `sjc`)

`scripts/fo-back-nav-check.mjs` — **60 checks, all passing**, across `/chat`,
`/modeling-agent` and `/modeling-agent/loader`:

* one arrow top-right and one hamburger, per route; neither on `/home` or
  `/reports`; neither at 768, 844 or 1280px
* arrow → `/home`, FabOrchestrator-rendered, no 404, no second login; browser
  Back returns to the conversation
* hamburger → FabOrchestrator's real sheet, **path unchanged** (`/chat → /chat`,
  `/modeling-agent → /modeling-agent`)
* New chat, and the conversation history — 6 date groups / 228 rows on `/chat`,
  2 groups / 40 rows on the modeling routes
* the account button in the footer, and **opening it reveals "Settings · Log
  out"** on every route
* tapping outside closes the sheet and both controls come back

#### The two sidebars are not the same sidebar

Worth recording, because a check asserting `/chat`'s contents everywhere failed
and the failure was the check's, not the product's. FabOrchestrator ships:

```
/chat            New chat · Projects · WORKSPACE (FO Overview, Agents,
                 Workflows, Dashboard) · ENTERPRISE (Sites, Integrations,
                 Compliance) · Settings · history
/modeling-agent  New chat · Projects · Master data loader · history
```

**`Dashboard` exists only in `full-chat-app.tsx`** — grepping
`modeling-chat-app.tsx` for "Dashboard" or "/reports" returns nothing. So the
check now asserts Dashboard on `/chat`, its absence plus the loader entry on the
modeling routes, and Settings/Sign out behind the footer dropdown on all three.

The close assertion also moved from Escape to **tapping outside**, which is what
a phone actually does — and Escape was being swallowed by the account dropdown
the check had just opened. Escape remains as a fallback.

#### Regression

pwa-install, auth-loop, fo-navigation, mobile-hardening all passed; security
24/24, gate 33/33, embed-live 67/67, routing 15/15; 565 tests. Production
untouched.


### Mobile navigation: the hamburger is gone, a Back arrow replaces it — v19

**10 September, Amay's call.** The bottom-left hamburger is removed. On agent
conversation pages below 768px there is now one **Back arrow, top-right**,
going to FabOrchestrator's `/home`. Above 768px nothing of ours is on screen and
FabOrchestrator's own persistent sidebar is untouched.

#### Why the change

The hamburger existed to open FabOrchestrator's sidebar, which below 768px
FabOrchestrator does not render. It went through three behaviours in two days —
navigating to the cockpit when it could not find a trigger, then dispatching
FabOrchestrator's own `Ctrl/Cmd+B` to open the real sheet. The second worked.
It was still a floating control whose job was to open a drawer, and the
judgement was that a phone does not need the drawer; it needs a way *out* of the
conversation.

#### It is FabOrchestrator's own control, borrowed

Not a new pattern. FabOrchestrator's chat sidebar already carries exactly this:
`aria-label="Back to FabOrchestrator overview"`, `title="Back to overview"`,
`router.push("/home")`, a ghost icon button in `text-muted-foreground` with an
arrow-left glyph (`M19 12H5` plus a polyline). The label, title, glyph and
destination are all taken from it, so an operator who has used FabOrchestrator
on a desktop meets the same control in the same words. Its Reports page uses the
same idea inline ("Back to chat", chevron, `--brand-indigo`).

The translucent-with-blur treatment is also FabOrchestrator's own choice for a
floating trigger, from its `c8ffc43`.

Two deliberate differences:

* **Position.** FabOrchestrator's sits top-left inside the sidebar; this is
  top-right, which is where it was asked for and is free of FabOrchestrator's
  own controls on a phone.
* **Transition.** FabOrchestrator uses `router.push` for a soft navigation,
  which cannot be called from outside its React tree. This is
  `location.assign("/home")` — the gateway serves `/home` as a real
  FabOrchestrator document either way, so the destination is identical and only
  the transition differs.

#### Routes changed

Every agent conversation route FabOrchestrator exposes, read from its own `app/`
tree at `origin/main`:

| Route | Renders | Arrow |
|---|---|---|
| `/chat` | `FullChatApp` | yes |
| `/modeling-agent` | `ModelingChatApp` | yes |
| `/modeling-agent/loader` | `ModelingChatApp` | yes |
| `/modeling-agent/loader/[id]` | `ModelingChatApp` | yes (prefix match) |
| `/home`, `/reports` | — | **no** — `/home` is the destination; Reports has its own way back |
| `/settings` | — | n/a: FabOrchestrator redirects it to `/chat`, where the arrow belongs |

#### The one non-obvious piece: where "top-right" actually is

Nothing in FabOrchestrator's top band is `position: fixed` — it is all in-flow
content — but what sits there differs by route. Measured at 390px: `/chat` has a
clear corner; `/modeling-agent` puts a "CMF connectivity" pill at the right edge
ending at y≈39.

Rather than hard-code an offset per route, which would rot the moment
FabOrchestrator changes that header, the shell **measures it**: the lowest edge
of any interactive element near the right edge in the top 100px, and sits 8px
below it (clamped, so a pathological page cannot push the arrow off screen).
Observed on the deployment:

| route | arrow position |
|---|---|
| `/chat` | (340, 10) 40×40 |
| `/modeling-agent` | (340, **47**) — below the CMF pill |
| `/modeling-agent/loader` | (340, 10) |

#### Verified on the deployment (v19, `sjc`)

`scripts/fo-back-nav-check.mjs` — **new, 34 checks, all passing**: exactly one
arrow per conversation route at 390×844, top-right, labelled as FabOrchestrator
labels its own, **not overlapping any FabOrchestrator control**, no horizontal
overflow, and **no hamburger anywhere**. Tapping it lands on `/home`,
FabOrchestrator-rendered, no 404, no second login; browser Back returns to the
conversation. At 768, 844 and 1280px: FabOrchestrator's own sidebar and its own
back button are present and nothing of ours is.

Regression sweep: pwa-install-check, fo-auth-loop-check, fo-navigation-check,
embed-mobile-hardening-check all passed; security 24/24, gate 33/33, embed-live
67/67, routing 15/15; 565 tests pass. Production untouched.

**Three checks were corrected, and one of the corrections is worth recording.**
The Back arrow deliberately reuses FabOrchestrator's own `aria-label`, which
makes a bare label selector ambiguous — `fo-navigation-check.mjs` was asserting
that *FabOrchestrator's* control is absent at 390px and started matching ours
instead. Every assertion about FabOrchestrator's own control now excludes ours
by id (`:not(#pwa-fo-back)`). `embed-mobile-hardening-check.mjs` still pointed
at the removed element's id; `fo-sidebar-check.mjs` was retired, superseded.

#### What the FO-side fix means for this

`c8ffc43` is now **optional rather than needed** for phone navigation: the arrow
is not a workaround for the missing trigger, it is a different and simpler
answer to the same need. Shipping `c8ffc43` would additionally give a phone the
conversation list, Dashboard, Settings and Sign out — everything in the drawer —
so it is still worth doing, but nothing here waits on it. `OPEN_ISSUES` 0a
stands as recorded.


### The mobile hamburger now opens FabOrchestrator's real sidebar — v18

**10 September.** Reported: on iPhone portrait, tapping the bottom-left
hamburger did not open the sidebar; it navigated to `/home`. Confirmed on the
deployed preview, then fixed — **and the fix is that a WP6 conclusion was
wrong.**

#### The WP6 finding, corrected

WP6 recorded, in `public/fo-shell.js` and in this file:

> **Synthetic Ctrl+B.** FabOrchestrator does listen for it, and a real keypress
> opens the sheet. A dispatched `KeyboardEvent` does not: React ignores events
> with `isTrusted: false`.

**That is not true here.** React's untrusted-event filtering applies to *its own
synthetic event system* — `onClick`, `onKeyDown` props — and FabOrchestrator's
shortcut is not registered that way. `SidebarProvider` registers it inside a
`useEffect` as a plain native listener (`ui/sidebar.tsx`, current `main`):

```js
window.addEventListener("keydown", handleKeyDown)
```

with `handleKeyDown` calling FabOrchestrator's own `toggleSidebar()` when it
sees `event.key === "b"` and `metaKey || ctrlKey` (`SIDEBAR_KEYBOARD_SHORTCUT
= "b"`). A native listener receives a dispatched event like any other. Below
768px `toggleSidebar()` is `setOpenMobile(open => !open)` — FabOrchestrator's
own React state setter.

Measured on the deployed preview at 390×844 on `/chat`, sheet shut. **All four
dispatch targets opened it**, and a genuine `Control+B` behaved identically:

```
window.dispatchEvent(       new KeyboardEvent("keydown",{key:"b",ctrlKey:true,bubbles:true}))  → opened
window.dispatchEvent(       … metaKey:true …)                                                  → opened
document.dispatchEvent(     … ctrlKey:true …)                                                  → opened
document.body.dispatchEvent(… ctrlKey:true …)                                                  → opened
```

The earlier attempt most likely fired before FabOrchestrator's `useEffect` had
registered the listener. The lesson is narrower and more useful than "React
ignores synthetic events": **it ignores them for handlers it owns, and
FabOrchestrator's shortcut is not one of those.**

#### What the button does now

`toggleFabOrchestratorSidebar()`, two routes, most faithful first:

1. **Click a real `SidebarTrigger`** if one is laid out (zero-box ones are
   skipped). Above 768px there always is; below it there will be once
   FabOrchestrator ships its own `md:hidden` trigger — at which point this
   route starts being taken and route 2 stops being needed, with no change
   here.
2. **Dispatch the shortcut**, with `ctrlKey` and `metaKey` both set so the
   handler is satisfied on any platform without knowing which the device uses.

**The `/home` fallback is gone.** `fallbackToCockpit()` is deleted. If neither
route works the button does nothing, which is better than teleporting an
operator somewhere they did not ask to go — and it stops the button from hiding
a real defect.

The button also **hides itself while the sheet is open**: once open, it is a
floating control sitting on top of the navigation it exists to reach, and
closing is FabOrchestrator's own business (its overlay, Escape). The poll that
watches width and path now watches the sheet too, at 400 ms, because the state
belongs to FabOrchestrator and there is no event of ours to hang it on.

#### Verified on the deployment (v18, 390×844)

`scripts/fo-sidebar-check.mjs` — **new, 21 checks, all passing**:

| | |
|---|---|
| FabOrchestrator renders no sidebar of its own at 390px | confirmed (OPEN_ISSUES 0a) |
| tapping the hamburger opens its **real** mobile sheet | `[data-sidebar="sidebar"][data-mobile="true"]` = 1 |
| no navigation | still on `/chat` |
| New chat | reachable |
| Dashboard | reachable |
| Back to FabOrchestrator overview | reachable |
| conversation history | **5 date groups, 228 rows** |
| Settings / Sign out | reachable |
| horizontal overflow | 0 px |
| the hamburger steps out of the way | hidden while open |
| Escape closes it | sheet = 0, hamburger returns |
| tapping again re-opens | yes |
| 844×390 and 1280×900 | FabOrchestrator's own sidebar present, hamburger **not** shown |

The opened sheet's own text, read back: *"New chat · Projects · WORKSPACE · FO
Overview · Agents · Workflows · Dashboard · ENTERPRISE · Sites · Integrations ·
Compliance · Settings · YESTERDAY … PREVIOUS 7 DAYS … OLDER"* — 11,470
characters of FabOrchestrator's own UI, none of it ours.

#### What this does not change

Nothing was reimplemented: no sidebar UI, no `/api/conversations` fetch and
redraw, no React internals, no fiber walking. The button presses a shortcut the
application publishes and handles itself. If FabOrchestrator changes that
shortcut the button stops working and nothing else breaks.

**Regression sweep after the change:** pwa-install-check, fo-auth-loop-check,
fo-navigation-check, embed-mobile-hardening-check all passed; security 24/24,
gate 33/33, embed-live 67/67; 565 tests pass. One assertion in
`fo-navigation-check.mjs` was **inverted** rather than relaxed — it had required
the toggle to "fall back to the cockpit", which is exactly the behaviour removed.

#### The FO-side fix is still worth shipping

`c8ffc43` remains the right change. This makes the sidebar reachable through a
shortcut, which is a keyboard affordance being driven by a button; FabOrchestrator's
own `md:hidden` trigger is a button being a button, works without this app, and
helps every mobile FabOrchestrator user rather than only ours. When it ships,
route 1 above takes over automatically.


### Installability regression — found by Amay, fixed on v17

**10 September.** Chrome stopped offering to install the preview. Not the app's
own Install button — **Chrome's own affordance, absent.** Reported as a failed
core requirement, and it was one.

**Root cause.** A direct consequence of whole-application embedding, and
entirely this app's doing. The manifest is declared in `app/layout.tsx`
(`metadata.manifest`), so Next emits `<link rel="manifest">` into **this app's
own documents**. Before the correction the landing page was one of those. After
it, `/` leads to FabOrchestrator's `/home`, and `/chat` and `/reports` are
FabOrchestrator's too — so every page an operator stands on became a
FabOrchestrator document, and **not one of them carried a manifest link.**

Measured with Chrome's own parser (`Page.getAppManifest`) against v16:

| page | rendered by | `<link rel=manifest>` | Chrome parsed a manifest |
|---|---|---|---|
| `/home` (the landing page) | FabOrchestrator | **absent** | **no** — `hasData: false` |
| `/chat` | FabOrchestrator | **absent** | **no** |
| `/reports` | FabOrchestrator | **absent** | **no** |
| `/login` | this app | present | yes |

No manifest on the current document means no install affordance, whatever else
is true.

**The service worker was never the problem** — worth stating, because it was the
first thing to suspect. It registers from `/login` during sign-in with scope `/`,
and on v16 it was already measured **active and controlling** `/home`, `/chat`
and `/reports`. Installability needs both halves; only the manifest half had
gone missing. `/manifest.webmanifest` and `/sw.js` both served `200` throughout.

**The fix, at the document-injection layer.** `lib/gateway/html-inject.ts`
already inserted the WP6 mobile shell before `</head>` as FabOrchestrator's
documents stream past. It now inserts the PWA bootstrap alongside it:

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="FabOrch">
```

One constant and one default argument — no new mechanism, and no FabOrchestrator
change. Installability, the manifest, the icons and the service worker are this
app's job; that is the division of labour the corrected architecture rests on.

**What is deliberately not injected: `theme-color`.** FabOrchestrator already
sets two, media-scoped to light and dark (`#FAF9F5` / `#262624`, verified on the
deployment). A third, unscoped, would override its theming with ours in one of
the two schemes — and the point of the whole exercise is that the product looks
like FabOrchestrator. Its `viewport` and `favicon` are left alone for the same
reason. Pinned by a test that asserts the injected block contains no
`theme-color`, no `viewport` and no `rel="icon"`.

**Also added:** `public/fo-shell.js` now registers `/sw.js` as well. The normal
path never needed it — the session gate sends every signed-out visitor through
`/login`, which registers — but an operator already signed in who opens `/home`
directly, from a shared link or a restored tab with cleared site data, would
never touch `/login`. `register()` on an already-registered scope is a no-op, so
the normal path costs nothing.

**Verified on the deployment (v17, `sjc`), with Chrome's own parser:**

| | `/home` | `/chat` | `/reports` |
|---|---|---|---|
| Chrome parsed a manifest | **yes**, 0 errors | **yes**, 0 errors | **yes**, 0 errors |
| service worker controlling | yes | yes | yes |
| iOS standalone tag | yes | yes | yes |
| still FabOrchestrator's own page | yes | yes | yes |

Manifest as Chrome reads it: name `FabOrchestrator`, `display: standalone`,
`start_url: "/"` (resolves `200`), 3 icons including 192, 512 and a maskable.
`start_url` lands on FabOrchestrator's cockpit with the session intact.

`scripts/pwa-install-check.mjs` — **new, 25 checks** — asserts all of it against
Chrome's parser rather than against the HTML, because a `<link>` that is present
but unparseable would pass a grep and fail a user.

**One thing this check cannot prove, and does not claim.** A genuine standalone
launch needs a real installed app record, and Playwright cannot produce one:
launched with `--app=`, both headless *and* headed Chromium still report
`display-mode: browser` (measured both ways). So the display mode is reported as
a NOTE, not asserted. Everything that decides whether the launch *works* is
asserted; whether the installed window opens without browser chrome is on the
manual checklist, on a device.

**Two smaller findings, not fixed:**

* The manifest's `"id"` is `"/orders"` — a leftover from the production-order
  app that was removed on 1 September. Harmless today (`id` only establishes
  app identity) but stale, and **changing it later makes Chrome treat the app as
  a new one**, so it is worth deciding before anyone installs this widely.
* `start_url` is `"/"`, which now 307s to `/home`. Chrome follows it and the
  launch works. Pointing it straight at `/home` would save a hop but would tie
  the manifest to the whole-embedding mode, and `"/"` is correct in every mode —
  left as is deliberately.

**Nothing else regressed:** security 24/24, gate 33/33, embed-live 67/67,
auth-loop, fo-navigation and mobile-hardening all passed against v17.


### The exact route-ownership policy

One principle changed: **the document default inverted.** A path used to be
denied unless listed; it now goes to FabOrchestrator unless this app reserves it
or it is explicitly denied. `classify()` applies these in order, and the order
*is* the policy — it does not vary by mode:

| # | Test | Result |
|---|---|---|
| 1 | **This app's reserved paths** | `pwa` — always, in every mode |
| 2 | **Denied** | `denied` — 404, before anything can forward it |
| 3 | **FabOrchestrator API allow-list** | `fo-api` |
| 4 | anything else under `/api/` | `unknown` → 404 |
| 5 | FabOrchestrator static (`/_next`, `/logos`, its `public/` files) | `fo-static` |
| 6 | a listed surface, or **any document in `whole` mode** | `fo-document` |
| 7 | a path both apps claim that FabOrchestrator did not win | `pwa` |
| 8 | otherwise | `unknown` → 404 |

**This app reserves, permanently** — the infrastructure it exists to provide:
`/login`, `/offline`, `/diagnostics`, `/api/pwa/*`, `/api/faborch/*`,
`/pwa-assets/*`, `/sw.js`, `/manifest.webmanifest`, the four icons,
`/fo-shell.js`, and `/fabinsight` + `/backend-agent` (this app's own agent
screens — FabOrchestrator has no page at either path, so forwarding them would
proxy a 404; they redirect to `/chat`).

**Contested:** `/reports` alone. Both applications have a page there.
FabOrchestrator wins in `whole` mode or when the surface is listed; this app
answers otherwise. That is WP7's collision, still resolved by configuration.

**The front door:** `/` is this app's, and redirects a signed-in operator to
FabOrchestrator's `/home` — the real cockpit, with its own composer, its own
chips, its own agent cards and its "ALL AGENTS ONLINE" badge. A signed-out
visitor still meets `/login` with its `?next=`.

**Mode, and the rollback:**

```
FO_EMBED_MODE = off       no FabOrchestrator here. The app of 7 September.
              | surfaces  WP1–WP9 behaviour, driven by FO_EMBED_SURFACES.
              | whole     FabOrchestrator owns the documents. ← the preview
```

Unset falls back to `FO_EMBED_SURFACES`, so a deployment carrying only the old
variable behaves exactly as before. **An unrecognised value never opens more** —
`all`, `everything`, `true`, `1` and a mistyped `whol e` are each asserted to
resolve to `off`, because a typo in a deployment variable must not be readable
as "serve the whole application".

### The exact API security policy

**The API deliberately did not invert.** Amay's constraint, and the right one: a
*page* their team deploys should appear by itself; an *endpoint* they add should
be looked at by a person. All 52 of FabOrchestrator's API routes were classified
by reading their guards.

| Class | Routes | Policy |
|---|---|---|
| **Credential / registration / recovery** | `/api/auth/login`, `/api/auth/register`, `/api/auth/password-reset` (+`/confirm`), and the documents `/forgot-password`, `/reset-password` | **denied** — unauthenticated by design upstream; forwarding them would let somebody obtain a FabOrchestrator session *around* this app's form |
| **Scheduled / machine** | `/api/fabinsight/cron/tick` | **denied** — gated upstream by `CRON_SECRET` + `x-cron`, not by a session, and it re-queries the MES |
| **Development-only introspection** | `/api/fabinsight/schema` | **denied — newly, see below** |
| **Public / pre-auth** | `/api/platform-theme`, `/api/health` | forwarded; the theme is read by the pre-auth page by design |
| **Session-scoped user data** | the other 45: chat, conversations, artifacts, files, memory, feedback, mcp, user, fabinsight pinned/render/access/warm, modeling-agent, cmf | forwarded, with the WP2 token injected |
| **Anything not on the list** | e.g. a future `/api/scheduling` | **404**, in every mode |

**One endpoint moved from forward to deny, and it is worth stating plainly.**
`/api/fabinsight/schema` was on the forward list since WP1. FabOrchestrator's own
header describes it: *"Disabled outside production — it would otherwise be an
unauthenticated arbitrary-SELECT endpoint."* It answers 404 today **only because
FabOrchestrator checks `NODE_ENV`**. Relying on another application's
environment variable as a security boundary is not a boundary. Denied here now,
so a FabOrchestrator deploy that ever came up outside production mode could not
turn this app into the vehicle for an unauthenticated SELECT against the plant
database.

FabOrchestrator has **no admin API** on this origin — administration lives in
`admin_athena`, a separate application — so there is no admin surface to deny.

### Does expanding page coverage weaken the boundary? No — and here is why

Every WP1–WP8 protection is untouched and still enforced on every forwarded
request: the session gate in front of documents; the WP2 bridge refusing a bearer
it cannot verify and injecting the real token only for verified sessions; the
WP4 conversation-ownership check on chat turns; the WP5 body ceiling; both
header allow-lists; path hygiene. What changed is **which documents are
forwarded**, and documents are the half with no credentials in them.

Asserted, not asserted-by-assumption — the deny set is tested in `whole` mode
*and* `surfaces` mode, and `security-review.mjs` reads **24/24** against the
deployment.

**What is knowingly traded, and it should be said to Danish's team:** a page
they add appears here without review. That is the requirement. A page is not a
credential, and the API's explicit list is what keeps the boundary; but if they
add a *page* that should not be public, it will be public here. Registering new
administrative or scheduled endpoints in `FO_DENIED_PREFIXES` is now a shared
responsibility.

### The authentication loop, driven rather than reasoned about

FabOrchestrator's guards navigate to `/` meaning **"go to our login page"** — on
its own site `/` *is* that page. Here `/` leads to `/home`. So an expired session
with this app's cookie alive would go: guard → `/` → `/home` → guard → for ever.

`expiredUpstream()` covers every case where FabOrchestrator is *asked* something.
It cannot cover the one that matters: **its idle timer clears its own storage at
30 minutes without making a request**, so no 401 is ever produced.

So `public/fo-shell.js` — already injected into every FabOrchestrator document —
now closes it at the only place both facts are visible. If FabOrchestrator's
token is gone from localStorage, this app's session is over too: it posts
`/api/pwa/auth/logout` and goes to `/login`. **This is single sign-*out*, the
half WP2 never built.** It waits 4 s before its first read so a booting page is
never signed out mid-start, treats unreadable storage as "present" so a private
window is never signed out on a guess, and also listens for `storage` and
`visibilitychange` so another tab and a returning one are caught immediately.

`scripts/fo-auth-loop-check.mjs` reproduces the state exactly — deleting the keys
FabOrchestrator's own timer deletes — and measures the escape:

```
trail: /home → /home → /home → /login → /login     settles, cookie cleared
```

**No `/home ↔ /` loop, and no second login.** Signing back in reaches `/home`
with zero password fields.

### What is now reachable that was not

| Path | Before | Now |
|---|---|---|
| `/home` | 404, then translated to this app's cockpit | **FabOrchestrator's own cockpit, and the landing page** |
| `/settings` | 404 | 200 |
| `/modeling-agent`, `/modeling-agent/loader` | 404 | 200 |
| `/force-password-change` | 404 | 200 |
| a page FabOrchestrator ships tomorrow | 404 | **appears, no edit here** |
| `/workflows`, `/sites` | 404 (ours) | 404 **forwarded from FabOrchestrator, byte-identical** — they do not exist upstream yet, and will appear when they do |

**Note on the modeling surfaces.** Jothi excluded the Master Data Load agent on
2 September; Amay's corrected direction names "modeling surfaces" explicitly, so
they are served. Worth confirming between them — this is a product decision that
changed, not an oversight.

### Checks — deployed preview v16, `sjc`

| | |
|---|---|
| `npm test` | **560 pass, 0 fail** (144 platform · 253 faborch · 163 gateway) |
| `npm run typecheck`, `lint`, `build` | clean |
| `scripts/fo-auth-loop-check.mjs` | **new — 17/17**, the loop driven and escaped |
| `scripts/security-review.mjs` | **24/24** |
| `scripts/gate-live-check.mjs` | 33/33 |
| `scripts/embed-live-check.mjs` | 67/67 |
| `scripts/embed-routing-check.mjs` | 15/15 |
| `scripts/embed-chat-check.mjs` | all passed, forged id refused |
| `scripts/embed-dashboard-check.mjs` | all passed |
| `scripts/embed-mobile-hardening-check.mjs` | all passed |
| `scripts/fo-navigation-check.mjs` | all passed |

**Eight live assertions were corrected, not relaxed** — each had encoded the old
architecture as a fact: that `/` is this app's cockpit, that `/settings` is
denied, that FabOrchestrator's Back lands on this app's screen. Every one now
asserts the property it was protecting rather than the old destination.

**Two selector facts about FabOrchestrator worth keeping:** its agent cards are
clickable `<article>` elements and its Reports "Open" is a bare `<div>` — neither
is a button or a link, so role-based selectors report zero on pages that visibly
have four and fourteen.

### Still open

* **`OPEN_ISSUES` 0a** — no chat sidebar below 768px. Now the *most* important
  FabOrchestrator-side fix: it is what makes Reports unreachable on a portrait
  phone.
* **`OPEN_ISSUES` 0c** — corrected during this work. The cockpit nav is hidden
  below 768px **and every one of its items, Reports included, is
  `router.push("/home")`** — all five are decorative on FabOrchestrator's own
  site. The real route to Reports is the chat sidebar's Dashboard item, so 0c
  reduces to 0a. I filed 0c inaccurately first and corrected it after reading
  the source.
* **`OPEN_ISSUES` 0, 0b, 1** — unchanged.
* **The PWA's own screens are still in the tree** and still served in
  `surfaces`/`off` mode. Retiring them is the remaining cleanup, and it is
  deliberately not done yet: while they exist, the rollback is a variable.

---

## Architecture audit — selected-surface embedding was too narrow (9 September)

**Requested by Amay after WP9 was rejected. No code was changed for this audit.**
The question: should the *whole* user-facing FabOrchestrator website reach the
phone through the PWA, rather than FabInsight Chat and Reports only?

**The answer is yes, and the finding that matters is this: the gateway is
already general. Only its document allow-list is narrow.** Two of FabOrchestrator's
ten pages are served. Forty-eight of its fifty-two API routes already are.

---

### 1. What FabOrchestrator actually is

Ten user-facing pages, every one of them `200` in production (verified against
`d7y8a8whrch88.cloudfront.net`, unauthenticated):

| FO page | What it is |
|---|---|
| `/` | FabOrchestrator's **own login page** |
| `/home` | **the real cockpit** — nav, hero, ask composer, agent cards, footer stats |
| `/chat` | FabInsight chat |
| `/reports` | pinned dashboards |
| `/settings` | settings route (redirects to `/chat`; FO's real settings is a modal) |
| `/modeling-agent` | Master Data Load agent |
| `/modeling-agent/loader`, `/loader/[id]` | its staged-load screens |
| `/forgot-password`, `/reset-password` | credential recovery |
| `/force-password-change` | forced rotation |

`/share/<id>` is referenced by a URL builder in `full-chat-app.tsx` but **has no
route** — `404` in production too. A dead feature, not a gap.

Plus 52 API routes and a small static surface (`/_next`, `/logos`, `favicon.ico`
and six files from FO's `public/`).

### 2. What the PWA gateway covers today

| Layer | Covered | Not covered |
|---|---|---|
| **Documents** | **2 of 10** — `/chat`, `/reports` | `/settings`, `/modeling-agent` (+loader ×2), `/force-password-change` → **404**. `/home` → translated to `/`. `/`, `/forgot-password`, `/reset-password` → deliberately withheld |
| **APIs** | **48 of 52**, byte-faithful | 4 deliberately denied: `/api/auth/login`, `/api/auth/register`, `/api/auth/password-reset`, `/api/fabinsight/cron` |
| **Static** | **complete** | — |

The two API endpoints that answer non-`200` through the gateway
(`/api/artifacts` → 400, `/api/fabinsight/schema` → 404) return **exactly the
same** codes direct from FabOrchestrator. Zero gateway-caused API failures.

So the narrowness lives in one place: `FO_DOCUMENT_CATALOGUE` ∩
`FO_EMBED_SURFACES`, both allow-lists, in `lib/gateway/registry.ts`.

### 3. Can the gateway be generalised? **Proven, empirically.**

The production build was run locally with every catalogue entry enabled —
`FO_EMBED_SURFACES="/chat,/reports,/settings,/home,/modeling-agent,/force-password-change"`
— **and no code change at all**:

| Path | Result |
|---|---|
| `/chat`, `/reports`, `/settings`, `/modeling-agent`, `/modeling-agent/loader`, `/force-password-change` | **200, FabOrchestrator's own document**, its own `/_next` chunks, zero `pwa-assets` |
| `/home` | 307 → `/` — intercepted by the WP9-defect fix, see the risk in §6 |

And they *work*, not merely render (Chromium, iPhone 13, signed in once through
the PWA): `/settings`, `/modeling-agent` and `/reports` all authenticated with no
signed-out state, **no failed requests**, and 0px horizontal overflow.
`/modeling-agent` even reported its live CMF connection.

`/modeling-agent/loader` was never catalogued and worked anyway, because
`classify()` matches surfaces by **prefix**. So sub-routes of an enabled page are
already free.

**Conclusion: nothing in the gateway needs redesigning.** The cookie→bearer
bridge, the header allow-lists, the asset prefix split, the cache policy, the
stream piping and the mobile shell are all path-agnostic. They were built general
and then pointed at two paths.

### 4. The question asked directly: what appears automatically if Danish's team deploys?

**Appears automatically today — no PWA change:**

* Any change *inside* `/chat` or `/reports` — copy, layout, components, client
  logic, styling, new chunks, new dependencies. The document and all of
  FabOrchestrator's `/_next` output are forwarded verbatim.
* Any change to the **48 forwarded API routes**, including brand-new endpoints
  under an already-forwarded prefix (`/api/conversations/…/anything-new`,
  `/api/user/…`, `/api/cmf/…`, `/api/modeling-agent/…`).
* New static assets under `/_next` or `/logos`.
* FabOrchestrator's theme, via `/api/platform-theme`.
* **Sub-routes of an enabled page** (`/reports/whatever`).

**Does NOT appear — each needs a PWA edit and a redeploy:**

* **A new user-facing page.** `/workflows`, `/sites`, anything → `404`. Needs a
  `FO_DOCUMENT_CATALOGUE` entry *and* a `FO_EMBED_SURFACES` entry.
* **A new top-level API prefix.** `/api/scheduling` → `404`. Needs
  `FO_API_PREFIXES`.
* **A new root-level static file.** `/robots.txt`, a new `.wasm` → `404`. Needs
  `FO_STATIC_EXACT`.
* **Any navigation into a page that is not enabled** → `404`. This is not
  hypothetical: it is exactly the in-app Back defect, where FabOrchestrator's own
  sidebar pointed at `/home` and the origin denied it.
* Changes to FabOrchestrator's login and password-recovery flow — withheld on
  purpose, and should stay withheld.
* Its own cockpit `/home` — currently translated away.

**In one sentence: today the PWA tracks FabOrchestrator automatically *inside*
two pages and not *between* them.** Any change to FabOrchestrator's site
structure requires an edit here, which is the opposite of the requirement.

### 5. What of WP1–WP9 survives

**Reusable unchanged — the substance of the work:**

| | |
|---|---|
| WP1 | the gateway route, path hygiene, header allow-lists both directions, `redirect: "manual"`, stream piping |
| WP2 | the cookie→bearer bridge and fingerprint binding — **this is what makes whole-FO embedding possible at all** |
| WP3 | `assetPrefix` split, two builds on one origin, cross-build navigation, the cache policy and its 19 pinning tests |
| WP4 | the conversation-ownership check (still required; `/api/chat` still unguarded upstream) |
| WP5 | body limits, upload streaming, history and download handling |
| WP6 | the injected mobile shell — **worth more** with more FO pages, not less |
| WP7 | the *mechanism*: a surface added by configuration alone |
| WP8 | the `sjc` region decision, the ownership-cache warming, all the measurement scripts |
| WP9 | `lib/gateway/destinations.ts` as the single place navigation is decided; `fo-navigation-check.mjs` |

**To be reversed or retired:**

* The PWA's custom cockpit as the *product* front door (`components/fab/screens/landing.tsx`, `landing-ask.tsx`, the Nucleus, Live ops, Recent activity).
* The PWA's own chat and reports screens — `/fabinsight`, `/backend-agent`, `components/fab/screens/reports.tsx`.
* `app/api/faborch/*` — this app's own FO proxy routes, superseded by the gateway.
* WP7's *framing*. Treating each FO page as a work package is what made "one surface at a time" feel like progress.
* The WP9 ask-box door, if `/home` becomes the landing — FabOrchestrator's own composer returns with it, and it works.

**Nothing security-related is discarded.**

### 6. The smallest corrected architecture

**One change of principle: invert the document default.** Today `classify()`
denies a path unless it is listed. It should *forward* to FabOrchestrator unless
the path is **reserved by the PWA** or **explicitly denied**.

```
today     PWA owns everything, FO owns a 2-item allow-list
proposed  FO owns everything, PWA owns a short reserved list, with a deny-list on top
```

**The PWA's permanent reserved list** — the infrastructure it exists to provide:

```
/login  /offline  /diagnostics        this app's own screens
/api/pwa/*                            this app's session
/pwa-assets/*                         this app's build output
/sw.js  /manifest.webmanifest  icons  installability
/fo-shell.js                          the WP6 mobile shell
```

**The deny-list stays and is checked first** — this is the security boundary and
it does not move:

```
/api/auth/login  /api/auth/register  /api/auth/password-reset
/forgot-password  /reset-password     (no signing in around the PWA's form)
/api/fabinsight/cron                  (scheduler)
```

**Everything else goes to FabOrchestrator**, through the gateway that already
exists, with every WP1–WP8 protection still in force: the session gate in front
of documents, the bridge refusing a bearer it cannot verify, the ownership check
on chat turns, the body ceiling, both header allow-lists, path hygiene.

**Three phases, smallest first.**

* **Phase A — invert the default.** `classify()` returns `fo-document` for an
  unreserved, undenied document instead of `unknown`. Immediately unlocks
  `/settings`, `/modeling-agent` and its loader, `/force-password-change`, **and
  every page FabOrchestrator ships from now on**. Config and one function; the
  gateway is untouched. This alone answers the requirement for everything except
  the landing page.
* **Phase B — make FabOrchestrator's cockpit the landing.** `/home` served by
  FabOrchestrator, and `/` resolving to it for a signed-in operator. This is
  where the real design risk is (below), and it is what closes the landing-drift
  defect: the composer, the chips and the "ALL AGENTS ONLINE" badge come back
  because FabOrchestrator renders them.
* **Phase C — retire the duplicates**, reversibly, exactly as WP9 retired
  `/fabinsight`.

**Rollback becomes one variable with three values** rather than a list:

```
FO_EMBED_MODE = off        today's app, no FO on this origin
              | surfaces   the current allow-list behaviour (WP1–WP9)
              | whole      FO owns the origin except the reserved list
```

Three states, each one deploy apart, and `off` is still exactly today's app.

**The risk in Phase B, stated plainly, because it is the one that could bite.**
FabOrchestrator's client-side auth guards do `router.replace("/")`, meaning "go
to our login page". On this origin `/` is not a login page. If `/` resolves to
`/home`, a token FabOrchestrator has just rejected produces: guard → `/` →
`/home` → guard → **loop**. WP2's `expiredUpstream()` already clears the cookie
on an upstream 401, which should break it by sending the next `/` to the gate —
but the ordering is subtle, it is untested, and a redirect loop on the front door
is the worst possible failure. **Phase B must not ship without a test that
drives an expired FabOrchestrator session through it.** There is also a second
mapping to decide: FabOrchestrator's `/` (its login) should map to the PWA's
`/login`, not be forwarded.

**What is knowingly traded.** Forward-by-default means a future FabOrchestrator
endpoint that should *not* be public would be exposed automatically rather than
denied by default. That is the direct cost of the requirement, and the mitigation
is the deny-list plus a standing review: when FabOrchestrator adds an
administrative or scheduled endpoint, it must be added there. Worth stating to
Danish's team explicitly, because it makes the PWA's exposure a shared concern
rather than only ours.

### 7. Retrospective — why we built only two surfaces

Not a coding mistake; six framing ones, in the order they compounded.

1. **The assumption was in the variable's name, before anyone questioned it.**
   WP1 introduced `FO_EMBED_SURFACES` — a *list of surfaces*. Naming the
   mechanism after the narrow reading made the narrow reading invisible, and
   every later package inherited it without re-deciding.
2. **Deny-by-default was applied as a product rule, not just a security rule.**
   Right for paths nobody navigates to; wrong for pages FabOrchestrator actually
   ships. That single conflation is what made `/home` a 404 and what makes every
   future FO page a 404.
3. **The catalogue was drawn from what the PWA already had screens for.**
   `/chat` and `/reports` mirrored the PWA's `/fabinsight` and `/reports`. The
   other four were catalogued and never enabled — the enabled set described this
   app's screens, not FabOrchestrator's site.
4. **WP7 measured the wrong thing and celebrated it.** "A second FO surface
   reached the phone by configuration alone" is a true and good result. But
   treating one page as a work package made incrementalism feel like progress,
   when needing a work package per page was the symptom.
5. **Every check reached FabOrchestrator by typing a URL.** So gaps *between*
   pages were structurally invisible — and `embed-routing-check.mjs` went further
   and accepted `status === 404` as "resolves" for FabOrchestrator's own sidebar
   targets. The defect was measured, named and recorded as correct.
6. **The cockpit existed before the embedding did.** The PWA had a hand-built
   cockpit, so the work was shaped to *preserve* it. WP9 then spent a package
   protecting it and removing FabOrchestrator's composer to avoid duplicating a
   screen we should have been deleting.

**The check that would have caught all six:** *if FabOrchestrator's team ships a
new page tomorrow, does it appear?* That question was never asked of the
architecture until now. It belongs in the acceptance criteria of every future
package.

### Status

**Audit only. No code changed.** The `/home` fix from the previous turn stands
(v15). WP9 remains **not accepted**. Awaiting approval of the corrected plan
before Phase A.

---

## Embedding work — WP9: **NOT ACCEPTED.** Defects found by manual testing

**9 September 2026.** Amay tested the real flow on a device and found three
problems the automated suite passed. One is fixed and verified (v15); one could
not be reproduced and is still open as a question; one is a real requirement
drift that needs a decision. **WP9 is not accepted and no further feature work
has begun.**

The general lesson, before the particulars: **every embedding check reached
FabOrchestrator by typing a URL and then asserted about the page it landed on.**
None of them used FabOrchestrator's own controls. Embedding an application
brings its *navigation* with it, and that navigation has opinions about where it
is going.

---

### Defect A — FabOrchestrator's in-app Back produced a 404. **FIXED (v15).**

**What happens.** Inside the embedded chat, FabOrchestrator's sidebar carries an
explicit Back control (`aria-label="Back to FabOrchestrator overview"`) and,
below it, an "FO Overview" item. Both are `router.push("/home")`
(`full-chat-app.tsx:455` and `:496`). `/home` is FabOrchestrator's own cockpit.

**Root cause.** `/home` is in `FO_DOCUMENT_CATALOGUE` but **not** in
`FO_EMBED_SURFACES`, which is `"/chat,/reports"`. So `classify()` fell through
every branch — not a listed surface, not PWA-reserved, not denied, not FO API,
not FO static — and returned `unknown`, which the middleware answers `404`. That
is deny-by-default doing exactly what it was built to do. The rule was right and
the outcome was an operator on a dead page.

**Why the suite missed it, precisely.** `scripts/embed-routing-check.mjs` had
already enumerated FabOrchestrator's sidebar targets, `/home` among them, and
asserted:

```js
record(`FabOrchestrator's link to ${p} resolves (${owner})`,
       res.status() === 200 || res.status() === 404, ...)
```

**A 404 counted as "resolves."** The defect was inside the check's accepted
range, and the label even called `/home` "not an approved surface" — the
behaviour was seen, named and mislabelled as correct. Deny-by-default is for
paths nobody navigates to; it is not for a button in the embedded UI.

**The fix — `/home` is translated, not served.** `foNavigationRedirect()` in
`lib/gateway/destinations.ts`, applied in `proxy.ts` beside the WP9 retired-
screen redirect: `/home` → `/`, gated first so a signed-out request still meets
sign-in with its `?next=`, `307` with `no-store` so the flag stays the rollback.

**Why not embed `/home` as well.** Because there is one cockpit here and it is
this app's. Serving FabOrchestrator's own cockpit at `/home` would put two
cockpits on one origin and undo what WP9 exists to establish. FabOrchestrator
says "back to the overview"; on this origin the overview is `/`. The operator
gets what the button promises. No FabOrchestrator change; nothing about the
same-origin architecture moves.

**The breakpoint, which explains how this was met.** Measured on the preview:

| width | FO sidebar | FO Back control |
|---|---|---|
| 390px (portrait phone) | not rendered | **absent** |
| 768px | rendered | visible |
| 844px (**the same phone in landscape**) | rendered | visible |

An iPhone 13 held sideways is 844px and crosses FabOrchestrator's 768px
breakpoint, so the Back control appears on a phone that is merely turned. Below
768px the control does not exist at all and WP6's injected toggle falls back to
the cockpit — that is `OPEN_ISSUES` 0a, still open, still FabOrchestrator's.
Both sides are now pinned by `scripts/fo-navigation-check.mjs`.

**Verified on the deployed preview (v15), by clicking FabOrchestrator's own
controls:** Back → `/` (PWA cockpit, no 404, `/home` → 307); FO Overview → the
same; the round trip cockpit → chat → in-app Back → cockpit → chat again; and
the browser's own Back still works.

---

### Defect B — a second login on opening FabInsight. **NOT REPRODUCED.**

I could not make this happen, and I am not claiming it is fixed.

**What was tested**, from a fresh browser context with no cookies and empty
`localStorage`, against v15, front door only:

* Chromium at iPhone 13 emulation: sign in → cockpit → tap Ask FabInsight →
  FabOrchestrator's chat. **Zero password fields at every step.** FO greeted the
  session ("Good afternoon, User"), and its own calls — `/api/auth/me`,
  `/api/fabinsight/access`, `/api/user/models`, `/api/conversations`,
  `/api/mcp/connections` — all answered `200`.
* WebKit at iPhone 13 emulation: same, no password field, cookie present.

**One WebKit finding, which is mine and not the product's.** On the first
`click()` the navigation appeared not to happen; the console showed the expected
cross-build fallback (`Failed to fetch RSC payload … Falling back to browser
navigation`) and my probe only waited 4 seconds. On a second interaction it
navigated to `/chat` correctly. So that was my harness being impatient — but it
does show the cockpit → chat hop costs a **full page load** under WebKit, slow
enough to feel unresponsive and invite a second tap.

**Hypotheses still worth eliminating, in order:**

1. **FabOrchestrator's 30-minute idle eviction.** Its `providers.tsx` treats
   *any* authed 401 as session expiry, clears `llmatscale_*` and shows a modal
   that navigates to `/`. On an idle session that would read exactly as "it made
   me log in again".
2. **The installed (standalone) app.** A Home-Screen app on iOS has
   historically had a cookie store separate from Safari's. The bridge depends on
   the httpOnly `faborch_token` cookie, so a standalone launch with no cookie
   would land on `/login`. Emulation cannot test this; a handset can.
3. **A stale service worker** serving a document from before the cutover.

**What would settle it:** on the device where it happened — was the app opened
from the Home Screen or from Safari? How long since the last use? And does it
recur immediately after a fresh sign-in?

---

### Defect C — the cockpit has drifted from FabOrchestrator's landing. **CONFIRMED. Needs a decision.**

Both pages rendered and compared at 1280px, signed in
(`docs/probes/wp9-landing/`):

| | FabOrchestrator `/home` | this app `/` |
|---|---|---|
| heading | "Your orchestration cockpit." | **same** |
| strapline | "Unify systems. Automate workflows. Transform the enterprise." | **same** |
| nav | Cockpit · Agents · Workflows · Sites · Reports | **same** |
| **ask composer** | **input, placeholder "Ask anything, or describe a task to orchestrate…"** | **absent** |
| **suggestion chips** | **Yield variance · Line 4 · Compliance · Fab West · Monthly OEE trend** | **absent** |
| in their place | — | a single "Ask FabInsight" door |
| Nucleus | "The Nucleus · 4 AGENTS · Manage agents" | "The Nucleus · 4 AGENTS · Answered by FabOrchestrator…" |
| status badge | "ALL AGENTS ONLINE" | absent |
| agent cards | AGENT · 01–04 | **same four** |

**The structure is a close reproduction. The one thing missing is the thing
FabOrchestrator's landing is built around — and WP9 is what removed it.**

That was a deliberate decision, made on 9 September for a stated reason: the
PWA's ask box was a *reimplementation* of FabOrchestrator's composer, and
FabOrchestrator's chat accepts no prefill (`?q=`, `?message=`, `?prompt=` all
verified against production), so a box on the cockpit could only discard what
was typed into it. Removing the duplicate was right. **But it also moved the
cockpit further from the requirement to preserve FabOrchestrator's landing
experience, and that trade was not weighed against that requirement at the
time.**

**The option that satisfies both, for a decision rather than for now.** Serve
FabOrchestrator's own `/home` as the cockpit through the same gateway. The
landing would then *be* FabOrchestrator's — composer, chips, badge and all —
with a composer that works, because FabOrchestrator renders it. `/home` is
already in the catalogue. This app would keep the front door it must keep:
`/login`, the manifest and install, the offline page, the service worker and the
WP6 mobile shell. It is one registry change plus a decision about what `/`
serves, and it is a change of product shape, not of architecture — so it is
being reported, not made.

---

### Other FabOrchestrator routes: what is supported and what is not

Complete inventory of client-side navigation reachable from the two surfaces
this origin serves (`full-chat-app.tsx`, `app/reports/page.tsx`, upstream
`e5a5abd`):

| Target | Count | Status |
|---|---|---|
| `/home` | 2 | **fixed** — translated to `/` |
| `/reports` | 1 | served by the gateway |
| `/chat` | 1 | served by the gateway |
| `/` | 3 | this app's cockpit, behind the gate — correct for FO's logout and for its Reports auth guards alike |

Still unsupported, and why each is not currently a defect:

* **`/settings`** — 404. In the catalogue, not embedded. **Nothing navigates to
  it:** FabOrchestrator opens settings as a modal (`SettingsModal`,
  `onOpenSettings`), not a route. Deny-by-default working as intended.
* **`/modeling-agent`** and `/modeling-agent/loader/<cmfId>` — 404. The Master
  Data Load agent, which Jothi excluded on 2 September. Linked only from
  FabOrchestrator's own cockpit and modeling pages, neither of which this origin
  serves.
* **`/force-password-change`** — 404. In the catalogue; **no client-side
  navigation to it exists anywhere in FabOrchestrator's source**, so it is
  presumably reached from its own login flow, which this app replaces. Untested,
  and the one that would bite: an account FabOrchestrator wants to force through
  a password change has nowhere to go here. Worth confirming before production.

---

### Checks after the fix (deployed preview v15, `sjc`)

| | |
|---|---|
| `npm test` | **553 pass, 0 fail** (144 platform · 253 faborch · 156 gateway — 4 new) |
| `npm run typecheck`, `npm run lint`, `npm run build` | clean |
| `scripts/fo-navigation-check.mjs` | **new — 15/15**, clicks FabOrchestrator's own controls |
| `scripts/embed-cutover-check.mjs` | all passed |
| `scripts/security-review.mjs` | 24/24 |
| `scripts/gate-live-check.mjs` | 32/32 |
| `scripts/embed-live-check.mjs` | 65/65 |
| `scripts/embed-routing-check.mjs` | 15/15 — assertion corrected, see Defect A |
| `scripts/embed-chat-check.mjs` | all passed, forged id refused |
| `scripts/embed-dashboard-check.mjs` | all passed |
| `scripts/embed-mobile-hardening-check.mjs` | all passed |

Two live assertions were corrected rather than relaxed: `embed-routing-check`
now requires every FabOrchestrator sidebar target to land on a page that answers
`200` (following one redirect), and `/home` came out of `embed-live-check`'s
deny-by-default list because it is no longer denied.

### Rollback

Unchanged and still one variable. The `/home` translation is gated on the
registry, so with `FO_EMBED_SURFACES` unset `/home` is a path this app has never
had and 404s exactly as it did before the embedding work began.

---

## Embedding work — current package: WP9 (migration and cutover)

**9 September 2026.** The embedded surfaces stop being a thing you reach by
typing a URL and become the thing the app opens. Deployed to the preview at
**v14**, `sjc`. Production untouched. Nothing is committed.

### What WP9 was for

WP1–WP8 made FabOrchestrator's real `/chat` and `/reports` work on this origin,
behind one session, on a phone, fast. **None of them made anybody arrive
there.** Every chat link on the cockpit still pointed at `/fabinsight` — this
app's own conversation screen — so the embedded work was reachable only by
typing the address.

That was not a tidiness problem. WP5's manual pass found it the hard way: a
tester followed the cockpit, landed on the old screen, and reported a
downloadable file that would not download. The file was fine. The screen was the
wrong one, and the cockpit had sent them there.

### What changed, exactly

Five links and one component:

| On the cockpit | Before | After |
|---|---|---|
| the ask box and its three chips | this app's own chat, inline | **a door: "Ask FabInsight" → `/chat`** |
| Agents pill | `/fabinsight` | `/chat` |
| FabInsight™ card | `/fabinsight` | `/chat` |
| AI Support Engineer card | `/fabinsight` | `/chat` |
| Back-end Agent card | `/backend-agent` | `/chat` |
| Reports pill | `/reports` | `/reports` — unchanged |

Measured on the deployment: the cockpit carries **5 links to `/chat`, 1 to
`/reports`, and 0 to any retired screen.**

All three agent cards go to the same place because **in FabOrchestrator they are
the same place**: AGENT · 01, 02 and 04 every one route to `/chat` there
(verified against upstream `e5a5abd`), and `lib/faborch/agents.ts` has recorded
since the demo that every agent this app exposes already shares `/api/chat`.
This app drew three doors onto one room. WP9 is partly the admission of that.

Their framing stays — a card still says what that agent is for, because that is
how somebody decides what to ask. What changed is where walking through it
lands.

### The ask box, and what it cost

The cockpit's ask bar **was FabOrchestrator's composer, reimplemented**. Same
780px card, same gradient Ask, and — confirmed against production during WP9 —
the same placeholder text down to the ellipsis: *"Ask anything, or describe a
task to orchestrate…"*.

It could not be pointed at the real chat, because **FabOrchestrator's chat
accepts no prefill**. `?q=`, `?message=` and `?prompt=` were all tried against
the production deployment; the composer stays empty in every case. So a box on
the cockpit could only have thrown away what was typed into it, and an input
that discards your sentence is worse than no input at all.

Three options were put to Amay, who chose the first:

1. **Make it a door.** One control opening FabOrchestrator's chat. Chosen.
2. Keep ask-first, cut over only the pills and cards — which would leave two
   composers on one origin wired to two different chats.
3. Have this app's injected script type the question into FabOrchestrator's
   composer after it hydrates — the same fragile class as the three failed WP6
   sidebar attempts, rejected for the same reason.

**The cost, stated plainly: the cockpit is no longer ask-first.** A question now
begins one tap further in, in FabOrchestrator's own composer. The three
suggestion chips went with the box, because each carried a question in its URL
and a question cannot be handed over — a chip could only have opened the same
empty screen three times while implying it would ask something.

### Retired, not deleted

`/fabinsight` and `/backend-agent` stay in the tree, built and tested. While the
gateway is serving FabOrchestrator's chat, arriving at either **redirects to
`/chat`** — so a bookmark, a shared link or a home-screen shortcut made before
the cutover still works.

A redirect rather than a rewrite, deliberately: the operator ends up *at*
`/chat`, with `/chat` in the address bar, so reloading or re-sharing from there
does the same thing next time. `307` and `no-store`, so that turning the flag
off takes effect on the next navigation rather than whenever a cached redirect
expires.

An old `/fabinsight?q=…` link lands on the chat with the question dropped. That
is the honest outcome: carrying `?q=` would put a parameter in the address bar
that nothing reads.

### The trap this nearly walked into

`/` prerendered as `○`. The cockpit now reads `FO_EMBED_SURFACES` to decide
where its doors point — and **a statically prerendered page reads that variable
once, during `next build`**, inside a Docker build where it is not set.
`/fabinsight` would have been baked into the HTML for the life of the image: the
cutover would have worked perfectly on a laptop and done nothing on the
deployment.

Worse, it would have taken the rollback with it. Every package since WP1 rests
on **one build, with the flag deciding at runtime**; a build-time answer in the
front door would have made changing it a rebuild.

So `app/page.tsx` is `export const dynamic = "force-dynamic"` and `/` is `ƒ`.
The cost is a server render instead of a static file — measured at 12–20 ms for
this app's own documents from inside the machine (WP8), with nothing fetched —
and it is still finished HTML on arrival. `__tests__/platform/route-gate.test.ts`
pins the export, because a missing one produces no error, no warning and no
failing request. The front door would just quietly stop moving.

This was caught by reading the build output, not by a test. It is the second
time in this work that a silent build-time regression hid behind a green suite
(WP3's `assetPrefix` cache header was the first), and the lesson is the same
one: **when behaviour depends on the environment, check what the build actually
produced.**

### The route ownership map, after the cutover

With `FO_EMBED_SURFACES = "/chat,/reports"`:

| Path | Served by | Note |
|---|---|---|
| `/` | **this app** | the cockpit, and the front door. Never handed over. |
| `/login` | **this app** | the one sign-in, for both applications |
| `/offline`, `/diagnostics` | **this app** | reachable signed-out, by design |
| `/chat` | **FabOrchestrator** | its own document, its own chunks |
| `/reports` | **FabOrchestrator** | the surface both sides claim; the flag decides |
| `/fabinsight` | *redirect → `/chat`* | retired, still in the tree |
| `/backend-agent` | *redirect → `/chat`* | retired, still in the tree |
| `/api/pwa/auth/*` | **this app** | this app's own session |
| `/api/*` (the rest) | **FabOrchestrator** | through the gateway, token injected |
| `/_next/*` | **FabOrchestrator** | its build output |
| `/pwa-assets/_next/*` | **this app** | this app's build output |
| everything else | — | 404, deny by default |

With the flag unset, every row above collapses to "this app", `/fabinsight` and
`/backend-agent` render their own screens, and the cockpit's ask box and chips
come back. That is the rollback, and it is one variable.

### Rollback

Unchanged from WP1, and re-proved on the WP9 build from **one build, two flag
states**:

| | flag set to `/chat,/reports` | flag unset |
|---|---|---|
| cockpit links | 5 × `/chat`, 1 × `/reports` | 4 × `/fabinsight`, 3 × `/fabinsight?q=…`, 1 × `/reports` |
| this app's ask box | absent | present (`id="cockpit-ask"`) |
| `/fabinsight` | `307 → /chat` | `200`, its own screen |
| `/backend-agent` | `307 → /chat` | `200`, its own screen |
| `/reports` | FabOrchestrator's page | this app's own screen |

To roll back: remove `/chat` (and `/reports`) from `FO_EMBED_SURFACES` in
`fly.preview.toml` and redeploy, or unset the variable entirely. No code
changes, no rebuild of anything else, and nothing to migrate back — the screens
never left.

### Checks

Against the **deployed preview at v14**, `sjc`:

| | |
|---|---|
| `npm test` | **549 pass, 0 fail** (144 platform · 253 faborch · 152 gateway — 19 new) |
| `npm run typecheck`, `npm run lint`, `npm run build` | clean |
| `scripts/embed-cutover-check.mjs` | **new — 29/29**, the whole path walked from the cockpit |
| `scripts/security-review.mjs` | 24/24 |
| `scripts/gate-live-check.mjs` | 32/32 |
| `scripts/embed-live-check.mjs` | 66/66 |
| `scripts/embed-routing-check.mjs` | 15/15 |
| `scripts/embed-chat-check.mjs` | all passed — streaming, tools, history, forged id refused |
| `scripts/embed-dashboard-check.mjs` | all passed |
| `scripts/embed-mobile-hardening-check.mjs` | all passed |
| `scripts/embed-load-profile.mjs` | first load 830 ms, warm 243 ms, 17 KB — unchanged by the cutover |

**Four live checks asserted the old navigation and were updated, not relaxed.**
They asserted `/fabinsight` and `/backend-agent` answer `200` — which is what
WP9 deliberately changed. Each now asserts the property it was actually
protecting: the session gate still lets a signed-in operator through
(`gate-live-check`), the embedding still has not stolen this app's own screens
(`embed-live-check`, now pinning the redirect destination and its `no-store`),
and the shell is still injected only into FabOrchestrator's documents
(`embed-mobile-hardening-check`, now using `/` and `/diagnostics`). Failing was
correct behaviour on their part; asserting `200` had quietly encoded the old
navigation as a side effect.

### Known remaining issues

Nothing new. Carried forward unchanged:

- **The FabOrchestrator mobile sidebar** (`OPEN_ISSUES` 0a) — FabOrchestrator
  renders no sidebar below 768px, so on a handset its conversation list,
  Settings and Log out are reachable only through the shell WP6 injects. **This
  matters more after WP9, not less**, because the cockpit is now the way in and
  FabOrchestrator's own chat is where operators land. Recorded as an external
  blocker with the smallest FO-side fix; no further PWA-side workaround was
  attempted, as instructed.
- **FabOrchestrator's file download has no ownership check** (`OPEN_ISSUES` 0).
- **CloudFront caches nothing** (`OPEN_ISSUES` 0b).
- **The Refresh control on FabOrchestrator's Reports page** re-queries the MES
  and overwrites the snapshot every other reader sees. Still an open product
  decision; still never called by any check.
- **The demo password rotation** (`OPEN_ISSUES` 1).

### Manual acceptance, end to end

On a real phone, at `https://faborch-embed-preview.fly.dev`, **without typing
any path but the front door** — that is the whole point of this package:

1. Open the app. You should meet sign-in, then the cockpit.
2. **Tap "Ask FabInsight."** You should land in FabOrchestrator's own chat, and
   it should not ask you to sign in again.
3. Type a real question and send it. The answer should stream.
4. Go back to the cockpit. **Tap the FabInsight™ card.** Same chat.
5. Go back. **Tap the Agents pill.** Same chat.
6. Go back. **Tap Reports.** FabOrchestrator's own Reports page, with the
   pinned dashboards. Open one; it should render. **Do not press Refresh** — it
   rewrites what every other reader sees.
7. In the chat, open an existing conversation and send a message; it should
   start answering as fast as a new one (the WP8 warmed cache).
8. Confirm the ask box is **gone** from the cockpit and there is one door in its
   place. If you can find a way to reach this app's old chat screen by tapping,
   that is a defect — report the path you took.
9. Sign out, then reopen from the Home Screen. You should meet sign-in, not a
   cockpit.

### Acceptance

**WP9 is NOT accepted.** The manual pass found three defects the automated
evidence above missed; they are recorded in the section at the top of this file.
One is fixed and verified on v15, one could not be reproduced, and one is a
confirmed requirement drift awaiting a decision. No further feature work has
been started.

---

## Embedding work — WP8 (deployment and latency): COMPLETE and ACCEPTED

**9 September 2026. COMPLETE and ACCEPTED.** The measurements are done, the fix
they justified is deployed and verified, and the region question was settled by
measurement and then acted on: the preview now runs in `sjc` at **v13**, where a
first load of the embedded FabOrchestrator chat takes **0.78 s instead of 3.9**.
Every regression and security check is green against that deployment. Production
is untouched. Nothing is committed.

### The question, and the short answer

WP0 promised the embedded path would be compared against the direct one here.
The comparison is done, and it does not say what a reading of the numbers from
a laptop would suggest:

> **The gateway costs 3–9 ms. The region it runs in costs about 300 ms, on
> every single FabOrchestrator request.** Those are different problems by a
> factor of forty, and only the second one is worth anyone's attention.

Measured from a laptop, the embedded path looks five to ten times slower than
FabOrchestrator's own site — 518 ms against 60 ms for the chat document. Almost
none of that is the architecture. It is one machine in Singapore talking to an
origin that is not in Singapore, and a laptop that happens to sit next to that
origin.

### How the confound was removed

Two legs cannot be compared from a laptop: "through the gateway" is *laptop →
Fly edge → Singapore → CloudFront*, and "direct" is *laptop → the CloudFront
edge next door*. So the same probe was run **from inside the Fly machine**,
where both legs start in the same place (`flyctl ssh console`, 7 runs, medians):

| From inside the machine | Through the gateway | Direct to FabOrchestrator | The gateway costs |
|---|---|---|---|
| FabOrchestrator's `/chat` document | 302 ms | 299 ms | **+3 ms** |
| FabOrchestrator's `/reports` document | 304 ms | 296 ms | **+8 ms** |
| one FabOrchestrator chunk | 316 ms | 307 ms | **+9 ms** |
| this app's own `/login` | 20 ms | — | — |

That is the honest overhead of everything WP1–WP7 built: the path hygiene, the
registry lookup, the header allow-lists, the HMAC verification, the cookie
read, the token injection, the shell injection and the stream piping, all
together, **under ten milliseconds**.

### Where the time actually goes

The same probe, from the machine, timed the connection rather than the request:

```
Fly machine (sin) → CloudFront:  TCP connect 142 ms · request 294 ms · X-Cache: Miss
laptop            → CloudFront:  TCP connect  16 ms · request  52 ms · X-Cache: Miss
laptop            → Fly edge:    TCP connect  16 ms
```

Two facts fall out of that, and neither is about the embedding:

1. **The Fly machine is a long way from FabOrchestrator.** 142 ms of round trip
   before a byte is asked for. The laptop is 16 ms from the same content. So
   `primary_region = "sin"` puts the gateway about as far from FabOrchestrator
   as it is possible to be while still being on the same planet as its users.

2. **CloudFront never caches anything.** Every response carries
   `X-Cache: Miss from cloudfront` — five consecutive requests for the same
   chunk, a chunk FabOrchestrator itself labels
   `public, max-age=31536000, immutable`. The CDN in front of FabOrchestrator
   is currently a hop rather than a cache, and every request reaches the origin
   nginx. **This is FabOrchestrator's own deployment, not this app's**, and it
   makes FabOrchestrator's own site slower too. Recorded in
   `docs/OPEN_ISSUES.md`.

The document arithmetic then closes exactly: 185 ms (laptop → Fly edge →
Singapore) + 294 ms (machine → CloudFront) + 10 ms ≈ the 518 ms measured
end-to-end. Nothing is unaccounted for.

### What a phone actually experiences

`scripts/embed-load-profile.mjs` — a real browser at iPhone 13 size, loading
the embedded chat with an empty cache and then again with the cache it filled:

| | First load (empty cache) | Second load (warm) |
|---|---|---|
| time to first byte | 799 ms | 637 ms |
| interactive | 3,269 ms | **864 ms** |
| finished loading | 3,892 ms | **864 ms** |
| requests | 46 | 40 |
| …from the browser's own cache | 1 | **32** |
| bytes over the wire | 1,406 KB | **17 KB** |

The caching policy WP3 argued for is doing its job: 32 of 40 requests never
leave the phone on a return visit, and 1.3 MB becomes 17 KB. **Conditional
requests work through the gateway too** — `/chat` sent with FabOrchestrator's
ETag answers `304` with a zero-byte body, so even the deliberately uncached
document costs one round trip and no payload.

So the number an operator lives with is **864 ms**, not 3.9 seconds, and the
larger of the two remaining costs inside it is the round trip to Singapore —
which is what the region measurement further down goes after.

### The one thing the gateway did that cost a round trip — and no longer does

WP4's conversation-ownership check reads the caller's conversation list to prove
an id belongs to them. That read is real work, and it showed:

| A chat turn, on the preview | TTFB |
|---|---|
| no conversation id | 708 ms |
| carrying an id, ownership cache cold | **1,276 ms** |
| carrying an id, cache warm | 891 ms |

The list is **208 rows, 55 KB** for this account, and it grows with history.

The fix is that FabOrchestrator's own client **has already fetched that list**
before anybody can pick a thread to type into — observed, not assumed, in the
load profile above, which recorded `GET /api/conversations → 200` among the
seven calls FabOrchestrator's client makes on the way in. So the gateway now
reads the ids out of that answer as it streams past and remembers them, and the
turn that follows finds them waiting. The positive TTL moved from 60 seconds to
FabOrchestrator's own 30-minute idle window, because 60 seconds is shorter than
the gap between opening a thread and finishing a sentence — a cache that has
gone cold before it is read is not a cache.

Verified against the real FabOrchestrator on a local production build, twice
each, with a fresh session for the cold case so the warm run could not leak
into it:

| | list read | chat turn TTFB |
|---|---|---|
| cold | 155 ms | **322 ms** |
| warm | 134 ms | **140 ms** |
| cold | 133 ms | **262 ms** |
| warm | 71 ms | **110 ms** |

The saving is the list read, exactly — which is what a correct fix looks like.

**And on the deployed preview, where that read crosses the Pacific twice, it is
worth more than twice that.** Measured against v12, with a separate sign-in for
the cold row so that session's token had never had a list read:

| A chat turn, on the deployed preview | TTFB | |
|---|---|---|
| no conversation id | 701 ms | the baseline |
| carrying an id, on a session that has read no list | **1,625 ms** | what every first turn used to cost |
| carrying an id, after the client's own list read | **567 ms** | what a real page now pays |
| direct to FabOrchestrator | 143 ms | |

**The first turn in a thread is ~1,060 ms faster**, and carrying a conversation
id now costs nothing at all — the 567 ms row sits below the 701 ms no-id row,
which is run-to-run variance on the FabOrchestrator leg rather than a saving.

The middle row is worth reading twice: it is not a hypothetical. It is the same
request the same script sent before this fix, and it is the reason the fix
exists. The third row is the one an operator experiences, because
FabOrchestrator's own client always fetches the conversation list on the way in.

The first run of this check after deploying reported the "cold" row at 753 ms
and I nearly recorded that as the before-and-after. It was wrong: the script
fetches the conversation list itself, to find a thread to write into, and since
WP8 **that fetch is the warming** — so the row labelled cold had already been
warmed by the script's own behaviour. The check now signs in a second time for
that row, and the label says what it measures.

**Nothing about the security property moved.** Every entry is still keyed by the
whole token, is still only written after FabOrchestrator itself listed that id
for that token, and "no" is still never cached — so an id that is not the
caller's costs a fresh read every single time.
`scripts/embed-chat-check.mjs` passes against the new build including its
forged-id case: the turn is answered, and FabOrchestrator neither creates nor
writes that conversation.

### Cold start versus warm start

`auto_stop_machines = false` and `min_machines_running = 1`, so **the preview
never stops** and a cold start happens on deploy and on nothing else. Measured
on the production build:

* process spawn → first answered request: **2,285 ms**; Next reports "Ready" in
  95 ms once the files are in the page cache.
* **no per-route compile penalty** — `/login` answers in 12 ms on the first
  request and 14 ms on the sixth. A production build has nothing left to build.
* the first FabOrchestrator request after a boot pays TCP and TLS to CloudFront:
  1,035 ms against ~310 ms once the connection is pooled. `undici` keeps it
  alive afterwards, so this is paid once per deploy rather than once per
  operator.

### What would actually make this faster — now measured, not argued

The recommendation in the first draft of this section was to move the app next
to FabOrchestrator. It has since been tested rather than reasoned about: a
second machine was cloned into `sjc`, measured, and destroyed. The preview is
back to one machine in `sin`.

**From inside a machine in `sjc`, against the same FabOrchestrator:**

| From the machine | `sin` (today) | `sjc` | |
|---|---|---|---|
| FO `/chat`, direct | 299 ms | **30 ms** | |
| FO `/chat`, via the gateway | 302 ms | **40 ms** | gateway costs +10 ms |
| FO `/reports`, via the gateway | 304 ms | **36 ms** | gateway costs +6 ms |
| one FO chunk, via the gateway | 316 ms | **66 ms** | |
| this app's own `/login` | 20 ms | 18 ms | |

The FabOrchestrator leg falls from ~294 ms to ~30 ms. **FabOrchestrator's origin
is in US-West**, which is the fact the whole latency picture turns on.

**End to end, from a laptop in US-West, with the `sjc` machine serving:**

| | served from `sin` | served from `sjc` |
|---|---|---|
| this app's `/login` | 224 ms | **45 ms** |
| FO `/chat` via the gateway | 676 ms | **81 ms** |
| FO `/reports` via the gateway | 520 ms | **69 ms** |
| 27 assets, in parallel | 2,191 ms | **635 ms** |
| **first page load** (browser, phone size) | 3,714 ms | **747 ms** |
| **warm page load** | 854 ms | **256 ms** |
| bytes on a first load | 1,408 KB | 1,309 KB |

A first load of the embedded FabOrchestrator chat goes from **3.7 seconds to
0.75** — and the gateway's cost against FabOrchestrator direct shrinks from a
625 ms gap to a 23 ms one.

**The counterintuitive part, stated plainly.** A gateway is normally placed near
its users. This one should be placed near *FabOrchestrator*, because
FabOrchestrator is the fixed far end: every request has to reach it wherever the
operator stands, and a machine beside it turns 27 long round trips into 27 short
ones plus a single long leg the browser amortises over one connection.
For the same reason, **running machines in both regions would not help** — an
operator routed to the near machine still pays the far leg 27 times.

**What this does not measure, and I will not claim it does.** The client-side
numbers above are from a laptop in US-West, so they show the improvement for a
US-West operator. For an operator in Asia the arithmetic points the same way but
the margin is smaller, and it rests on a component measured in the other
direction: the Fly backhaul between a US-West edge and the Singapore machine is
about 195 ms (`/login` 224 ms served from `sin` against 45 ms served from
`sjc`). Applying that symmetrically, an Asian operator would see roughly
25 + 195 + 40 ≈ **260 ms** for a FabOrchestrator document against
25 + 300 ≈ **325 ms** today — better, but by 65 ms rather than by 600. The
fan-out would still improve substantially, because that is where the 10×
shortening of the FabOrchestrator leg compounds.

I tried to measure the Asian case directly, by having the Singapore machine
request the `sjc` machine over Fly's private network. It was refused twice
(`fetch failed` on both the 6PN address and the `.internal` DNS name), and I
stopped rather than keep pushing at it.

**The recommendation was: yes, move the region — with one question first.**
Where are the operators? Amay answered it — the demo and its expected users are
in the US — and the preview was moved. What that bought is measured in the next
section. `primary_region` is one line in each config; nothing else about the
architecture changes, and the rollback is the same line back.

Ranked below that, unchanged:

* **Ask FabOrchestrator's team why CloudFront caches nothing** (`OPEN_ISSUES`
  item 0b). Every response is `X-Cache: Miss`, including year-`immutable`
  chunks. Worth ~150 ms per asset to FabOrchestrator's own users as well as
  these.
* **Nothing else is worth doing.** The gateway's own cost is 3–10 ms in both
  regions. The compression difference — Fly's edge re-compresses
  FabOrchestrator's chunks with brotli at 11.5 KB where CloudFront's gzip is
  8.6 KB — is one first load's worth of bytes against headers that hold for a
  year.

### The region was moved — `sin` → `sjc`, 9 September

Amay's call, on the measurement above and on the fact that the demo and its
expected users are in the US. `fly.preview.toml` now reads
`primary_region = "sjc"`; the Singapore machine was retired and the preview runs
one machine in `sjc` at **v13**.

**Production was not touched.** `fly.toml` still reads `primary_region = "sin"`,
`faborch-demo` still runs v44 in `sin`, and `/reports` there still answers `307`.
Moving production is a separate decision and is not part of WP8.

What the move actually bought, measured from a US-West client against the
deployed preview before and after:

| | `sin` (v12) | `sjc` (v13) | |
|---|---|---|---|
| this app's own `/login` | 224 ms | **44 ms** | |
| FO `/chat` via the gateway | 676 ms | **70 ms** | direct: 51 ms |
| FO `/reports` via the gateway | 520 ms | **65 ms** | direct: 50 ms |
| one FO chunk via the gateway | 516 ms | **81 ms** | direct: 54 ms |
| 27 assets, in parallel | 2,191 ms | **699 ms** | direct: 224 ms |
| **first page load** (browser, phone size) | 3,892 ms | **782 ms** | |
| **warm page load** | 864 ms | **269 ms** | |
| chat turn, TTFB | 567 ms | **121 ms** | direct: 183 ms |

A first load of the embedded FabOrchestrator chat went from **3.9 seconds to
0.78**, and a warm load from 864 ms to 269 ms. The gap between the embedded path
and FabOrchestrator's own site closed from 625 ms to 19 ms on a document.

The chat row is worth a second look: **the embedded turn now answers its first
byte in 121 ms against 183 ms straight to FabOrchestrator.** That is inside the
noise and not a claim that proxying is faster than not proxying — it is the
plainest possible statement that the gateway has stopped being a tax.

#### What this did to WP8's own optimisation, honestly

The cache-warming fix was worth **~1,060 ms** on the first turn of a thread when
the machine was in Singapore. In `sjc` the same three rows read:

| A chat turn, in `sjc` | TTFB |
|---|---|
| no conversation id | 132 ms |
| carrying an id, on a session that has read no list | 150 ms |
| carrying an id, after the client's own list read | 121 ms |

So the round trip it removes now costs about **30 ms, not 1,060**. The region
change subsumed most of the win, and it would be dishonest to add the two
numbers together and claim both.

The fix stays, for three reasons that survive the move: it is strictly less work
than not having it, it is the difference between one upstream read per thread
and none, and its value scales with the conversation list — 211 rows and 55 KB
today for this account, and growing. It is simply no longer the headline. The
headline is that the gateway was in the wrong hemisphere.

#### One deployment wrinkle, recorded rather than hidden

The v13 deploy finished successfully — the machine passed its checks and is
serving — but the final call that marks the *release record* complete failed on a
dropped connection:

```
WARN failed to set final release status after successful deployment:
Patch "https://api.fly.io/api/v1/releases/rel_...": ... An existing connection
was forcibly closed by the remote host.
```

So `flyctl releases` shows v13 as `running` and will keep showing that. The
machine is `started` in `sjc` at v13 and every check below passed against it.
Nothing needs fixing; it is noted here so nobody reads that row as a stuck
deployment later.


### One thing that went wrong, and what it cost

The deploy failed twice before it succeeded, and neither failure was Fly's. This
machine's clock was **7 hours 42 minutes behind real time**, so every freshly
minted TLS certificate looked "not yet valid" and every time-bounded token
looked forged. It presented as `unauthorized`, which is what sent me looking at
credentials rather than at the clock — and it is almost certainly what the
earlier "flyctl lost its authority" wall really was, too. The tell was in the
error text all along: `current time 2026-09-09T04:44:12-07:00 is before
2026-09-09T19:11:30Z`. Two seconds of `curl -sI https://api.fly.io/ | grep date`
would have found it immediately, and that check is now the first thing to reach
for when a deployment tool starts claiming an authenticated session is not
authenticated.

The measured durations in this section are unaffected — they come from a
monotonic clock, not the wall clock — but the probe reports written before the
resync carry timestamps 7h42m early. They have been regenerated.

### The rollback still holds

Proved again on the WP8 build, one build, two flag states:

* `FO_EMBED_SURFACES` **listing** `/chat` → FabOrchestrator's own document
  (`LLMatscale.ai - AI Chat Application`, 88 bare `/_next/static/` references).
* `FO_EMBED_SURFACES` **unset** → `/reports` is this app's own screen again
  (`Reports — FabOrchestrator`, 42 `/pwa-assets/_next/` references) and `/chat`
  is this app's own 404, because this app has never had a `/chat` screen —
  its own chat lives at `/fabinsight`, which is untouched.

Warming the ownership cache changed nothing about that: it runs inside the
gateway, and with the flag off the gateway is never reached.

### Checks

Every check below was run twice: once against the WP8 build in `sin` (v12) and
again against the same build in `sjc` (**v13**, the current preview). Both runs
were green, which is the evidence that the region move is a **relocation and not
a change in behaviour**. The results shown are v13's:

| | |
|---|---|
| `npm test` | **530 pass, 0 fail** (136 platform · 253 faborch · 141 gateway — 7 new) |
| `npm run typecheck`, `npm run lint`, `npm run build` | clean |
| `scripts/security-review.mjs` | **24/24** — `flyctl secrets list` is readable again, so the boundary check reports a pass it can actually see |
| `scripts/gate-live-check.mjs` | 32/32 |
| `scripts/embed-live-check.mjs` | 63/63 |
| `scripts/embed-routing-check.mjs` | 15/15 |
| `scripts/embed-chat-check.mjs` | all passed, forged id included |
| `scripts/embed-dashboard-check.mjs` | all passed |
| `scripts/embed-mobile-hardening-check.mjs` | all passed |
| `scripts/embed-latency-check.mjs` | new — `docs/probes/2026-09-09-wp8-latency.md` |
| `scripts/embed-load-profile.mjs` | new — `docs/probes/2026-09-09-wp8-load-profile.md` |

The preview is **one machine in `sjc`, v13**. Production is untouched — v44, in
`sin`, `primary_region = "sin"` in `fly.toml`, and `/reports` there still answers
`307`. FabOrchestrator is untouched: `git status` in the read-only reference
checkout (`FabOrchestrator_product_code_upstream`, `main` at `e5a5abd`) reports
0 changes.

### Manual verification owed

One thing, on a real phone, because a browser at phone size is not a phone:

1. **Open the chat and notice how long it takes.** This is the one to do first:
   the page should now appear in well under a second where it used to take
   close to four. That is the region move, and it is the change an operator
   will actually notice.
2. Open an **existing** conversation and send a message. It should start
   answering as quickly as the first message in a brand-new thread does — that
   is the warmed ownership cache.
3. Reload the chat twice. The second load should be immediate (17 KB against
   1.3 MB).

Everything else in this package was measured rather than felt, and the
measurements are above.

### Acceptance

**WP8 is COMPLETE and ACCEPTED.** Accepted by Amay on 9 September — including
the preview relocation to `sjc`, the deployed measurements, the ownership-cache
optimisation, the regression and security results and the rollback verification
— on this
evidence:

* the ownership-cache optimisation is **deployed and verified** on the preview,
  and removed a measured 1,060 ms from the first turn of a thread in `sin`;
* the gateway's own overhead is **quantified at 3–10 ms** — measured from inside
  the machine in two regions, so it is the architecture's cost and not the
  geography's;
* the region question was **measured, decided and acted on**: the preview runs
  in `sjc`, and a first load of the embedded FabOrchestrator chat fell from
  **3.9 s to 0.78 s**, a warm load from 864 ms to 269 ms;
* **every regression and security check passed in both regions** — 24/24
  security, 32/32 gate, 63/63 live, 15/15 routing, and the chat, dashboard and
  mobile-hardening suites — so the move is a relocation, not a behaviour change;
* the rollback is unchanged and still one flag, and **production was not
  touched**.

What is deliberately left open, and is not WP8's to close: whether *production*
should move to `sjc` as well (a separate decision, and a separate deploy), and
FabOrchestrator's CloudFront distribution caching nothing (`OPEN_ISSUES` 0b),
which is worth more than anything this app can do for itself and belongs to
FabOrchestrator's team.

---


## Embedding work — WP7 (second FO surface: the Dashboard): COMPLETE and ACCEPTED

**9 September 2026. Accepted by Amay.** The FabOrchestrator Dashboard reached
the phone by adding one word to one variable.

**WP8 — deployment and latency — followed; see its own section above.**

### The claim WP7 exists to prove

Not "a dashboard renders" but **a second FabOrchestrator capability reached the
phone by configuration alone**. It did. The entire change is one entry in one
variable:

```diff
-  FO_EMBED_SURFACES = "/chat"
+  FO_EMBED_SURFACES = "/chat,/reports"
```

No page, no proxy route, no parser, no screen, no component. Everything the
Dashboard needs was already there: `/reports` was already in the gateway's
document catalogue, `/api/fabinsight/pinned`, `/api/fabinsight/render` and its
`/_next` chunks were already forwarded, the WP2 bridge already injected the
token they need, and the cockpit's Reports link already pointed at `/reports`.
The only other files added are a check script and this note.

### What the Dashboard surface actually is

| | |
|---|---|
| Route | **`/reports`** — FabOrchestrator's `app/reports/page.tsx`, "Recent Reports" |
| How FabOrchestrator reaches it | the **"Dashboard"** item in its chat sidebar |
| How this app reaches it | the cockpit's existing **Reports** nav link |
| Contents | the account's pinned dashboards — **14** on the demo account |
| APIs | `/api/fabinsight/pinned`, `/pinned/{id}`, `/pinned/{id}/refresh`, `/render`, `/api/auth/me` |

**FabOrchestrator's cockpit nav is not the way in**: all five of its nav labels
call `router.push("/home")`. Its chat sidebar is the only route on its own site.

### Verified on the preview

| | Result |
|---|---|
| `/reports` document | 200 HTML, title `LLMatscale.ai…` — **FabOrchestrator's**, not this app's |
| Its assets | **79** refs to bare `/_next`, **0** to `/pwa-assets` |
| Cache policy | `no-cache, must-revalidate`, so a phone cannot hold a stale document |
| Mobile shell (WP6) | present on the page |
| Pinned dashboards | **14**, with `canManage: false` — FabOrchestrator's own permission answer |
| Opening one | **23,567 bytes** of FabOrchestrator-rendered HTML, stamped `refreshedAt` |
| From the cockpit at 390×844 and 360×640 | Reports link → lands on `/reports` → **14 cards, 14 Open controls** |
| Opening a dashboard on a phone | renders its snapshot in an iframe, no error text |
| Sideways scrolling | **0 px**, before and after opening |
| Console errors | none |
| `/`, `/fabinsight`, `/login` | still this app's own screens |

### The rollback, proven rather than asserted

One build, two flag states, measured:

| `FO_EMBED_SURFACES` | What `/reports` serves |
|---|---|
| `"/chat,/reports"` | FabOrchestrator's page: 200, 14 dashboards, no `pwa-assets` chunks |
| `"/chat"` | **this app's own screen**: title `Reports — FabOrchestrator`, 42 `pwa-assets` refs, no injected shell |

So removing one word from one variable hands the URL back, with no deploy of
different code. This app's own Reports screen is untouched and stays in the
tree until WP9.

### The Refresh control — an open product decision, unchanged

FabOrchestrator's page carries a **Refresh** control that this app's own screen
deliberately never offered. `POST /api/fabinsight/pinned/{id}/refresh`
re-queries the MES and **overwrites the shared snapshot every other reader
sees**, and it is not admin-gated. Embedding restores that control because it
is FabOrchestrator's own page and WP7's instruction was to treat it as-is.

**Never called by any check here.** Reading is safe; refreshing is somebody
else's data. Whether it belongs on a phone is yours to decide — the options are
to leave it (it is FabOrchestrator's behaviour on its own website), or to ask
Danish's team to gate it.

**Measured**

| Check | Result |
|---|---|
| `npm test` | 523 pass, 0 fail |
| `npm run typecheck` / `npm run lint` / `npm run build` | clean |
| `scripts/embed-dashboard-check.mjs`, preview | **28/28** |
| `scripts/embed-live-check.mjs`, preview | 63/63 |
| `scripts/gate-live-check.mjs`, preview | 32/32 |
| `scripts/security-review.mjs`, preview | 24/24 |
| `scripts/embed-routing-check.mjs`, preview | 15/15 |
| `scripts/embed-mobile-hardening-check.mjs`, preview | all passed |

**Three faults in my own check script, found and fixed**

1. It counted **any** console error as a failure, including Next's "failed to
   fetch RSC payload… falling back to browser navigation". That message *is*
   the cross-build mechanism WP3 verified — it is why the page loads correctly
   a moment later. Now recognised rather than silenced.
2. It looked for the Open control as `button, a`. **FabOrchestrator's "Open" is
   a plain `<div>` with no button or anchor ancestor**, so it reported zero on a
   page that visibly has fourteen, and the open-a-dashboard assertion silently
   never ran.
3. A first attempt to fix that matched on trimmed text, which still missed it
   because the label sits beside a chevron. Verified against the real DOM the
   third time.

**Open / needs manual verification**

- The Refresh decision above.
- A handset pass: tap Reports on the cockpit, confirm FabOrchestrator's Recent
  Reports page with its 14 cards, open one, and confirm the dashboard renders.
  Portrait works for this surface — unlike the chat, Reports needs no sidebar.
- The WP6 sidebar blocker is unchanged and still with Danish's team.

---

## Embedding work — WP6 (mobile and iPhone hardening): COMPLETE and ACCEPTED

**9 September 2026. Accepted by Amay with the FabOrchestrator mobile-sidebar
issue recorded as an external blocker.** Standing instruction from that
acceptance: **no further PWA-side workarounds for it.** The three that were
tried and measured are recorded below so nobody repeats them, and the smallest
FO-side fix is preserved here and in `docs/OPEN_ISSUES.md` §0a for Danish's
team.

**WP7 — the Dashboard/Reports surface — followed; see its own section above.**

### ⛔ The sidebar: a demonstrated FO-side blocker

**Reported:** in the embedded chat on a phone the sidebar is unreliable,
sometimes appearing only after a reload, and in the installed app effectively
never. **Root cause found, and it is worse than "unreliable":**

**Below 768px FabOrchestrator renders no sidebar at all.** Measured on the
deployment at 390px — after twelve seconds on `/chat`, `[data-slot="sidebar"]`
is absent, `[data-sidebar="trigger"]` is absent, and both stay absent. In
landscape (844px) both appear immediately. The cause is in
`components/ui/sidebar.tsx`: on mobile `Sidebar` returns a Radix `Sheet`, and
that sheet's content only exists in the DOM while `openMobile` is true.
`openMobile` is React state inside `SidebarProvider`, settable only by
`toggleSidebar()`. So there is nothing on the page to click and no handle to
call. The "after a reload" symptom is the related first-render race:
`useIsMobile()` returns `!!undefined` = false initially, so the desktop rail
paints briefly and then vanishes.

**Three PWA-side routes were tried, deployed, and measured. All failed:**

| Attempt | Why it failed |
|---|---|
| Dispatch a synthetic Ctrl+B (FabOrchestrator does listen for it, and a *real* keypress opens the sheet) | React ignores untrusted events. A native spy saw all three dispatches with `isTrusted: false`; the sheet stayed shut |
| Click FabOrchestrator's own `[data-sidebar="trigger"]` | Not rendered at this width. Nothing to click |
| Widen the document past the breakpoint so `useIsMobile()` re-evaluates | `min-width` on the root does not change `window.innerWidth`, which is what the hook reads. A page cannot make `innerWidth` lie |

**The smallest FO-side fix, for Danish's team — one line.** Add a `md:hidden`
trigger beside the chat content in `claudeai_athena/components/full-chat-app.tsx`:

```tsx
<SidebarTrigger className="bg-background/90 absolute left-2 top-2 z-20 rounded-md shadow-sm backdrop-blur-sm md:hidden" />
```

**FabOrchestrator's own local copy already carries exactly this line** (at
`full-chat-app.tsx:2427`, with a comment recording the same diagnosis);
upstream `main` and production do not. So it is a fix already written on their
side and not shipped, not something this project is inventing. `md:hidden`
rather than a JS check because Tailwind's `md` is 768px and
`MOBILE_BREAKPOINT` is 768, so the two agree exactly and it renders on the
first paint rather than a frame late.

**What was built instead, and what it honestly does.** `public/fo-shell.js`,
injected into FabOrchestrator's documents by `lib/gateway/html-inject.ts`, adds
one 48×48 button at the bottom-left, below 768px, on `/chat` only. It clicks
FabOrchestrator's own trigger when one exists (desktop width), and **when one
does not, it returns the operator to this app's cockpit** rather than appearing
to do nothing. It is not a second sidebar and reimplements none of
FabOrchestrator's navigation. When the one-line FO fix ships, the button starts
opening the real sidebar and the fallback stops being reached.

**Until then, the honest statement: a phone user cannot reach FabOrchestrator's
conversation list, Dashboard link, Settings or Log out from the embedded chat in
portrait.** Landscape works. That is FabOrchestrator's behaviour on its own
website too.

### The rest of WP6, which did pass

`scripts/embed-mobile-hardening-check.mjs` (new, 22 checks, all passing against
the preview):

| | 390×844 | 360×640 |
|---|---|---|
| Sideways scrolling, `/chat` and `/reports` | **0 px** | **0 px** |
| Composer on screen | bottom 551 of 844 | bottom 486 of 640 |
| …still on screen once focused (the keyboard case) | yes | yes |
| The shell button is tappable, nothing over it | 12 px from the left, 14 px above the safe-area inset | same |

- **Rotation across the breakpoint** behaves correctly both ways: in landscape
  FabOrchestrator's own rail returns and this app's button steps aside, so
  there is one control and never two; back in portrait the button returns.
- **Standalone** (an installed app reporting `display-mode: standalone`) gets
  the button and it behaves the same way.
- **Safe areas:** the button uses `env(safe-area-inset-left)` and
  `env(safe-area-inset-bottom)`, so it clears the home indicator.
- **This app's own screens are untouched:** `/` and `/fabinsight` carry no
  injected shell at all, verified.
- The injection is stream-based and covered by 13 unit tests, including a
  `</head>` split across chunk boundaries, a document with no head, and
  multi-byte characters split mid-sequence.

**Measured**

| Check | Result |
|---|---|
| `npm test` | **523 pass, 0 fail** (136 + 253 + 134 gateway, incl. 13 new injection tests) |
| `npm run typecheck` / `npm run lint` / `npm run build` | clean |
| `scripts/embed-mobile-hardening-check.mjs`, preview | **22/22** |
| `scripts/embed-live-check.mjs`, preview | 63/63 |
| `scripts/gate-live-check.mjs`, preview | 32/32 |
| `scripts/security-review.mjs`, preview | 24/24 |
| `scripts/embed-routing-check.mjs`, preview | 15/15 |

**Two things I got wrong on the way, recorded because they cost real attempts**

1. An early probe concluded FabOrchestrator's trigger *was* present at 390px.
   It was reading a page that still had a thread open from a landscape run.
   Measuring from a clean load showed the truth.
2. I twice built a fix on an untested assumption — first that a synthetic
   keyboard event would reach a React handler, then that a CSS width change
   would move `window.innerWidth` — and deployed both before measuring. The
   measurement should have come first.

**Open / needs a decision**

- **The one-line FabOrchestrator change above.** Until it ships, portrait users
  have no sidebar in the embedded chat. This is the item for Danish's team, and
  it is already written in their own local copy.
- Not exercised by hand on a phone: the button's placement, the rotation
  behaviour, and whether returning to the cockpit is the right fallback or
  whether you would rather it did nothing visible.

---

## Embedding work — WP5 (history, uploads and downloads): COMPLETE and ACCEPTED

**9 September 2026. Accepted by Amay** after a manual phone check on the real
embedded `/chat` route: the downloadable artifact worked correctly.

**8 September 2026. WP5 is complete on the evidence below. WP6 — mobile and
iPhone hardening — is next and has NOT been started.** Nothing is committed;
the working tree holds WP0 through WP5 for review.

**What WP5 covers.** Everything the embedded chat needs besides the turn
itself: reading and writing conversation history, pulling a file back down,
pushing one up, and the smaller endpoints its interface calls. All of it
FabOrchestrator's own, reached through the gateway with the injected token. No
PWA screen or business logic was written for any of it.

**Verified on the preview deployment**

| | Result |
|---|---|
| Conversation list | 200, **207 rows** — FabOrchestrator's own store |
| One conversation with its messages | 200, **34 messages** |
| Its `/messages` endpoint | 200 |
| A **write** (pinned, then unpinned) | 200 then 200 |
| Artifacts for a conversation | 200 |
| Artifacts for a conversation that is **not** the caller's | **403 from FabOrchestrator** — its own check, not papered over |
| A **real file download** | 200, **10,089 bytes** |
| …byte-for-byte against FabOrchestrator direct | **identical**, same SHA-256 |
| …filename and type | `attachment; filename="Bottleneck_Timeout_Recommendation.docx"`, correct MIME type |
| A 5 MB upload | streamed through; FabOrchestrator returned its own verdict |
| A 52 MB upload | **413 from this app**, before anything reached FabOrchestrator |
| Memory, user settings | 200 |
| Feedback with a forged message id | **400 from FabOrchestrator** — its own ownership check |

Registry coverage was checked exhaustively rather than by eye: **all 17** of the
API paths these features use classify as forwarded FabOrchestrator endpoints.

### What was added

`lib/gateway/body-limit.ts` — a ceiling on what the gateway will carry
upstream, at **50 MB**, matching `client_max_body_size` in FabOrchestrator's own
nginx configuration. Two checks, because one is not enough: a declared
`Content-Length` over the ceiling is refused before a byte leaves, and a
chunked body with no declared length is counted as it streams and errored the
moment it passes the limit. Without the second, the first is only a suggestion.
Uploads still stream — nothing is buffered here — apart from chat turns, which
are buffered on purpose so their `conversationId` can be proved (WP4).

### A FabOrchestrator finding, recorded rather than fixed

**`GET /api/files/{id}/download` authenticates but performs no ownership
check.** Read in full on upstream `main`: it calls `requireAuth`, validates the
id's shape, then fetches the bytes straight from the Files API and returns
them. There is no comparison against the caller at all. Any signed-in
FabOrchestrator user who knows a file id can download that file.

Three things about it, stated carefully:

- **Embedding does not widen it.** The gateway injects a token only for a
  caller holding a live session of this app bound to the matching
  FabOrchestrator cookie, so the population that can reach it here is exactly
  the population that can reach it on FabOrchestrator's own website.
- **It is not the same as the `/api/chat` case.** There, this app's own proxy
  had already closed the hole, so embedding would have been a regression
  against this app's behaviour, and WP4 closed it at the gateway. Here this app
  never exposed downloads at all, so there is nothing to regress.
- **It was not blocked, and FabOrchestrator was not modified.** Proving
  ownership would mean scanning the caller's conversations for the id on every
  download — expensive, fragile, and it would break legitimate downloads whose
  provenance this app does not model. Blocking downloads outright would break
  the feature. This is FabOrchestrator's to fix, and it belongs in the same
  write-up already prepared for that team.

Every neighbouring route **does** check properly, which is what makes this one
stand out: `/api/artifacts`, `/api/artifacts/[id]`, `/api/messages/feedback`,
`/api/conversations/[id]`, `/api/conversations/[id]/messages` and
`/api/conversations/[id]/title` all compare against the caller.

**Measured**

| Check | Result |
|---|---|
| `npm test` | **510 pass, 0 fail** (136 platform + 253 faborch + 121 gateway, incl. 10 new body-limit tests) |
| `npm run typecheck` / `npm run lint` / `npm run build` | clean |
| `scripts/embed-live-check.mjs`, preview | **63/63** |
| `scripts/gate-live-check.mjs`, preview | 32/32 |
| `scripts/security-review.mjs`, preview | 24/24 |
| `scripts/embed-routing-check.mjs`, preview | 15/15 |

**Two defects in my own checks, found and fixed**

1. **A test asserted what the code did not promise.** `declaredLength` returned
   `0` for an empty `Content-Length`, because `Number("")` is `0` rather than
   `NaN`, while its own comment promised "absent". The implementation now
   matches the promise, which is the safer reading: absent defers to the
   counting stream.
2. **The oversized-upload check could not be written the obvious way.** Sending
   a faked `Content-Length` with a tiny body is impossible from Node — undici
   refuses a body that does not match the header it declared. The check now
   sends a genuinely oversized body, which is the real test anyway.

### The reported download failure, investigated 9 September

**Reported:** during the manual phone pass, "downloadable file/artifact links
did not appear to work". Investigated on the deployed preview, separating the
two flows as asked. **The embedded `/chat` flow works. The old `/fabinsight`
screen has no download links at all.**

**On the real embedded `/chat`** — traced by tapping the control in a browser at
phone width, not by calling the API:

| | |
|---|---|
| What the frontend calls | `GET /api/files/{fileId}/download`, FabOrchestrator's own `FileCard` |
| Through the gateway? | **yes** — same origin, `Authorization` header present |
| Status / redirects | **200**, no redirect chain |
| Authentication | preserved: the gateway swapped this app's bearer for the FabOrchestrator token |
| Headers survived | `content-type: …wordprocessingml.document`, `content-disposition: attachment; filename="Bottleneck_Timeout_Recommendation.docx"` |
| Link target | this app's origin, an approved forwarded path — never FabOrchestrator's origin, never an unforwarded one |
| Result | **a real browser download fired**, `Bottleneck_Timeout_Recommendation.docx`, from a `blob:` URL |
| Console errors | none |

So there is **no gateway defect**, and nothing was changed. Which also answers
why the byte-level test passes: it exercises the same request the UI makes, and
the UI's request is fine. The difference between the automated test and a
handset is not the request — it is the last step, below.

**How FabOrchestrator delivers the bytes.** `components/prompt-kit/file-card.tsx`
does `await fetch(...)` with the auth header, turns the response into a `blob`,
calls `URL.createObjectURL`, creates an anchor, sets `download`, and calls
`a.click()`. **That click happens after an `await`**, so it is outside the
user-activation window, and it targets a `blob:` URL. Chromium honours it;
Safari is stricter about programmatic clicks that have lost user activation,
and downloads in an installed iOS web app have their own history of doing
nothing visible. That is the remaining candidate for what was seen on the
phone, and **it is FabOrchestrator's own client code, byte-identical on
FabOrchestrator's own website** — so it is not an embedding regression and not
something to fix by rebuilding the download UI here.

Not reproducible from this machine: there is no iOS Safari here, and Chromium
completes the download.

### Separately: the old `/fabinsight` screen shows no downloads at all

Recorded apart from WP5, as asked, because it is not an embedding failure.

Opened the **same** conversation on `/fabinsight?c=…`: 32,246 characters of the
thread render, the filename appears in the prose, and there is **not one
download control** — only "tap to open" tiles for the HTML dashboards. That is
deliberate and documented: `lib/faborch/history.ts` drops `file-download` parts
when mapping FabOrchestrator's stored messages, because they carried presigned
URLs that had since expired.

**This is the more likely explanation for what was reported**, because **every
chat link on the cockpit still points at `/fabinsight`** — the Agents pill, all
three ask chips, and the FabInsight and AI Support Engineer cards. The embedded
chat is reachable only by typing `/chat`. So a manual pass that started from the
cockpit landed on the old screen, where the links genuinely do not exist.

**Consequence for the plan.** The embedded surfaces are proven but effectively
unreachable by normal navigation: no cockpit link points at them, and
FabOrchestrator's own sidebar cannot be opened in portrait (the WP0 finding).
That is now blocking manual verification rather than merely being untidy, and it
argues for bringing the cockpit rewiring forward from WP9. Not done — it is
WP9's content and needs a decision.

**Open / unverified**

- The iOS download behaviour above, which needs a handset and a statement of
  what was actually seen (nothing at all, a blank tab, an error).
- Everything else above is over the wire or in Chromium at phone width.
- No upload path is reachable from the embedded chat as configured: uploads
  belong to the Master Data Load agent, which Jothi excluded on 2 September, so
  the 5 MB case was driven by script against FabOrchestrator's own endpoint.
- The WP0 sidebar finding still stands, and the Dashboard note below still
  awaits a decision.

---

## Embedding work — WP4 (embedded /chat acceptance): COMPLETE and ACCEPTED

**8 September 2026. Accepted by Amay after a manual check on a phone.** The
automated evidence below was already green; the handset pass is what confirmed
a real streamed answer arriving in the embedded chat rather than only on the
wire.

**WP5 — history, uploads and downloads — followed; see its own section above.**
Nothing is committed; the working tree holds WP0 through WP5 for review.

**What WP4 proves.** The embedded chat is the real FabInsight, not a shell of
it. Asked through the gateway on the preview deployment:

| | Result |
|---|---|
| "Give me the yield by product." | 176 text frames over **180 separate network arrivals**, first text at 3.1 s of 13.8 s — streamed, not buffered |
| …and the content | a real material-yield table, not a refusal |
| "How many lots are currently in WIP?" | answered in 52.5 s after **10 tool calls** — FabOrchestrator's own tools ran through the gateway |
| A conversation created and written through the gateway | HTTP 201, then 2 messages stored |
| The same thread read from FabOrchestrator directly | 2 messages — one history, both surfaces |

**The security work, which was the substance of WP4.** FabOrchestrator's
`/api/chat` writes into whatever `conversationId` it is handed and **never
checks whose it is** — re-verified on upstream `main` for this package: that
route has no `getConversation` and no `userId` comparison at all, while
`/api/artifacts` and every `/api/conversations/[id]` method do check properly.
This app's own proxy route has refused to be the vehicle for that since the
demo, and **embedding had reopened it**: FabOrchestrator's client posts its own
body through the gateway, and until WP4 the gateway forwarded it untouched.

`lib/gateway/ownership.ts` now proves the id first, for `POST /api/chat` and
`POST /api/modeling-agent/chat` only. An unproved id is **stripped and the turn
forwarded anyway**, so the operator still gets their answer and it simply is not
written down — the same choice `app/api/faborch/[agent]/chat/route.ts` already
made, because refusing outright punishes somebody for a stale tab. Measured
over the wire with a forged id: the turn was answered (200) and the forged
conversation was still 404 afterwards, exactly as before the request.

Only those two paths are buffered to be inspected. Everything else — uploads
above all — keeps streaming, and a body over 20 MB is refused rather than
forwarded unchecked.

**Why the ownership cache only remembers "yes".** Proving ownership costs a
list read, which a chat turn cannot pay serially every message. But a cache
that could answer "no" from memory would break the ordinary flow:
FabOrchestrator's client creates a conversation and immediately posts the first
turn into it, and a list cached a moment earlier would not contain it — the
turn would go unpersisted and the thread would stay empty forever. So positives
are cached for 60 s per token and id, negatives never are, and a miss always
costs a fresh read. Held by a test that creates a conversation between two
turns.

**Measured**

| Check | Result |
|---|---|
| `npm test` | **500 pass, 0 fail** (136 platform + 253 faborch + 111 gateway, incl. 14 new ownership tests) |
| `npm run typecheck` / `npm run lint` / `npm run build` | clean |
| `scripts/embed-chat-check.mjs`, preview | **11/11** (≈4 real model turns) |
| `scripts/embed-live-check.mjs`, preview | 49/49 |
| `scripts/gate-live-check.mjs`, preview | 32/32 |
| `scripts/security-review.mjs`, preview | 24/24 |
| `scripts/embed-routing-check.mjs`, preview | 15/15 |

**Deviation from the WP4 plan, deliberately.** The plan folded the streaming
and history assertions into `embed-live-check.mjs`. They are in their own
`scripts/embed-chat-check.mjs` instead, because they cost real model turns and
minutes, and burying that in the script that is run constantly would make the
fast loop slow and expensive.

**One transient worth recording.** The first run of the chat check died with
`ECONNRESET` while writing its request body, seconds after a deploy. The
gateway was fine — the same request through curl streamed a complete answer —
and the machine was still being replaced. A deploy race, not a defect; the
re-run passed 11/11.

**Open / unverified**

- Not opened by hand on a phone under WP4. The streamed answer is verified over
  the wire, not watched arriving on a handset.
- Uploads and downloads through the gateway are **WP5**, not exercised here.
- The WP0 sidebar finding still stands and now matters more; see the Dashboard
  note below.

---

## Additional required surface: the Dashboard tab → **belongs to WP7**

**Asked for on 8 September: the existing Dashboard tab, where the available
dashboards are listed and viewed.** Inspected rather than assumed; **no code
written**, because it belongs to a later package and WP4 was the authorised
one.

**What the surface actually is**

| | |
|---|---|
| Route | **`/reports`** — FabOrchestrator's `app/reports/page.tsx`, titled "Recent Reports" |
| How a user reaches it | the **"Dashboard"** item in FabOrchestrator's chat sidebar (`router.push("/reports")`, `full-chat-app.tsx:514`) |
| What it shows | the pinned dashboards, 14 on the demo account, each opening its stored snapshot |
| APIs it calls | `/api/auth/me`, `/api/fabinsight/pinned`, `/api/fabinsight/pinned/{id}`, `/api/fabinsight/pinned/{id}/refresh`, `/api/fabinsight/render` |
| Auth | every one behind FabOrchestrator's `requireAuth`; `pinned` also returns `canManage` from `isDashboardAdmin` |
| Assets | its own `/_next` chunks — 19 JS, 4 CSS measured in WP0; the same mechanism `/chat` already uses |

**FabOrchestrator's cockpit nav is not the way in.** Its five nav labels
(Cockpit, Agents, Workflows, Sites, Reports) all call `router.push("/home")`
— every one of them. The chat sidebar's "Dashboard" item is the only real
route to the page.

**It needs no new code.** `/reports` is already in the gateway's document
catalogue, every API above is already in `FO_API_PREFIXES`, and the WP2 bridge
already injects the token they need. Verified read-only through the gateway on
the preview today, with the flag still set to `/chat` alone:

- `GET /api/fabinsight/pinned` → **200, 14 dashboards, `canManage: false`**
- `GET /api/fabinsight/pinned/{id}` → **200**

So the data path the Dashboard needs is already proven. The implementation is
**one entry in `FO_EMBED_SURFACES`** — which is exactly WP7's stated goal
("prove a further FabOrchestrator capability reaches the phone by decision and
configuration, not by building another frontend"). Recording it there rather
than disturbing WP4.

`render` and `refresh` were deliberately **not** called: `refresh` re-queries
the MES and overwrites the shared snapshot every other reader sees.

**Three things needing a decision before WP7 runs**

1. **The Refresh control comes back.** This app's own Reports screen
   deliberately never offered it, for the reason above. FabOrchestrator's page
   does offer it, so embedding restores a control that rewrites what every
   other reader sees. It is FabOrchestrator's own behaviour on its own website;
   whether it belongs on a phone is a product call.
2. **`/reports` is the one document both sides claim.** The flag decides which
   one the URL serves; this app's own screen is only retired at **WP9**, after
   acceptance. A test already holds the flip.
3. **On a phone, the Dashboard has no entry point.** Its only route is
   FabOrchestrator's chat sidebar, and the WP0 finding stands: that sidebar
   cannot be opened at phone width in production FabOrchestrator. So WP7 must
   also point this app's own cockpit at `/reports`, or the page is reachable
   only by typing the URL.

---

## Embedding work — WP3 (asset and routing compatibility): COMPLETE and ACCEPTED

**8 September 2026. Accepted by Amay after a manual check on a phone:**
navigation between this app and the embedded FabOrchestrator works, both sides
render normally, and the session stays intact across the round trip.

**WP4 — embedded `/chat` acceptance — followed; see its own section above.**
Nothing is committed; the working tree holds WP0 through WP4 for review.

**What WP3 was for.** Two Next.js builds now answer on one origin. WP3 is the
package that checks they do not confuse each other's assets, navigations,
caches, service worker or manifest. It found one real defect, which WP1
introduced and nothing else would have caught.

### The defect: this app's own chunks stopped being cached

`assetPrefix` moved this app's content-hashed output to
`/pwa-assets/_next/static/…`, and the `headers()` rule in `next.config.ts`
excluded only the bare `_next/static`. So from WP1 until now, **every
content-hashed file this app owns was served `no-cache, must-revalidate`** —
revalidated on every navigation, on a phone, for files whose names change
whenever their contents do.

Nothing failed. The build passed, the type check passed, 467 tests passed and
every live check passed. It was found by comparing one chunk's `cache-control`
on the preview against the same chunk on production, which was built before the
prefix existed and still answered `immutable`.

Fixed, and pinned so it cannot drift again: the prefix and the immutable-path
list now live in `lib/gateway/registry.ts`, `next.config.ts` builds its pattern
from them, and `__tests__/gateway/cache-policy.test.ts` (19 tests) holds the
rule against the paths both builds really serve.

Measured on the preview afterwards:

| | Cache-Control |
|---|---|
| this app's chunk | `public, max-age=31536000, immutable` |
| FabOrchestrator's chunk | `public, max-age=31536000, immutable` |
| a document, either build | `no-cache, must-revalidate` |
| an unversioned file in `public/` | `no-cache, must-revalidate` |

### What else WP3 verified, in a real browser

`scripts/embed-routing-check.mjs` (new, 15 checks, all passing):

- **The service worker** is this app's, controls the whole origin, and caches
  only the offline page and its two icons — nothing of either build, so neither
  can serve the other's stale output.
- **Cross-build navigation works.** The two builds have different build ids,
  which is what makes Next fall back to a full page load rather than feeding
  one router the other's payload. A link from this app's page lands on
  FabOrchestrator's `/chat` and FabOrchestrator's own page renders, signed in.
- **Coming back works.** This app's cockpit opens afterwards and the session
  survives the round trip.
- **No console errors** anywhere in the run.
- **Stale chunks 404 on both sides**, and documents are `no-cache`, so a phone
  holding an old document always revalidates before it can name a dead chunk —
  the 2026-08-19 defect stays fixed for both builds.
- **The chunk-recovery script still matches.** It looks for `/_next/static/` in
  a failed script's `src`, and the prefixed path still contains that substring.

### One routing gap, recorded rather than decided

FabOrchestrator's own sidebar links to `/home`, which is **not** an approved
surface, so it answers 404 on this origin. Its other targets are fine: `/` and
`/reports` are this app's screens. It does not bite today, because the WP0
finding still stands — that sidebar cannot be opened at phone width in
production FabOrchestrator at all. Adding `/home` to `FO_EMBED_SURFACES` is one
line if it is ever wanted, but it is the desktop cockpit and the plan
deliberately keeps it off phones, so this is a product decision and not mine.

**Measured**

| Check | Result |
|---|---|
| `npm test` | **486 pass, 0 fail** (136 platform + 253 faborch + 97 gateway) |
| `npm run typecheck` / `npm run lint` | clean |
| `scripts/embed-live-check.mjs`, preview | 49/49 |
| `scripts/gate-live-check.mjs`, preview | 32/32 |
| `scripts/security-review.mjs`, preview | 24/24 |
| `scripts/embed-routing-check.mjs`, preview | **15/15** |

**Open / unverified**

- Not opened by hand on a phone under WP3. The routing check drives a real
  browser at 390×844, but installed-app and Safari behaviour is still only
  covered by WP1's and WP2's manual passes.
- Asking a real question and getting a streamed answer is **WP4's** acceptance,
  not WP3's, and has still not been exercised end to end.
- The WP0 sidebar finding is unchanged and still needs an answer from the
  FabOrchestrator team.

---

## Embedding work — WP2 (single-login session bridge): COMPLETE and ACCEPTED

**8 September 2026. Accepted by Amay after a manual check on a phone**, opened
through the preview QR code: the real FabOrchestrator chat opened and **stayed
signed in**, with none of the signed-out state WP1 ended on. That is the whole
of what WP2 set out to change, and it is the one part no automation here could
stand in for.

**WP3 — asset and routing compatibility — followed; see its own section above.**
Nothing is committed; the working tree holds WP0 through WP3 for review.

**What WP2 proves.** One sign-in, on this app's own form, now carries into
FabOrchestrator's embedded pages. The measurement that says so is the same
phone-width run that made WP1's boundary visible, with every value reversed:

| At phone width, embedded `/chat` | WP1 | WP2 |
|---|---|---|
| FabOrchestrator's data calls | **401** × 5 | **200** × 6 |
| FO's "You've been signed out" modal | shown | **not shown** |
| This app's session left in `localStorage` | **cleared** by FO | intact |
| Console errors | 401s | none |

The real FabOrchestrator chat now renders signed in, with its composer, its
prompt chips and its model selector (`docs/probes/wp2-shots/chat-390x844.png`).

**How it works.** `lib/gateway/auth-bridge.ts` decides, per forwarded `/api/*`
request, what FabOrchestrator should be told:

- **inject** — the bearer verifies as a live session of this app *and* the
  FabOrchestrator cookie on the same request fingerprints to the one that
  session was minted beside. The gateway replaces the header with the real
  token, read from the httpOnly cookie on the server and never sent downstream.
- **refuse (401)** — a bearer that does not verify, or verifies without its
  cookie. Never forwarded: a claim this app can see is false is not
  FabOrchestrator's to adjudicate.
- **forward anonymously** — no bearer at all, because some FabOrchestrator
  endpoints are public (`/api/platform-theme` is fetched by its root layout
  before anyone signs in).

Injection is for `fo-api` only. A document or a static asset is public on
FabOrchestrator and is fetched with no credential, which is also what stops an
operator's token being attached to a font.

**The route move, and why.** This app's session endpoints moved from
`/api/auth/*` to **`/api/pwa/auth/*`**, so `/api/auth/*` can mean on this origin
what it means on FabOrchestrator. The embedded page now asks FabOrchestrator who
the operator is and gets FabOrchestrator's own answer — verified by the fields
in it (`preferences`, `emailVerified`, `createdAt`, `role`) that this app never
had. It also preserves a property `lib/auth.ts` argued for and refused to give
up: this app still never calls FO's `/api/auth/me` on its own account, so it
cannot bump FO's idle clock; when FO's *own* client makes that call, the bump is
FabOrchestrator's own behaviour, exactly as on its website.

**Sign-out works from either side, and revocation is real.** Signing out through
FabOrchestrator's own endpoint returns 200, the gateway drops the cookie on the
way back, and the same session is refused immediately afterwards — measured, not
argued. An upstream 401 on an injected request drops the cookie too, so FO's
30-minute idle eviction ends the session here rather than leaving an operator
holding one that passes the gate and cannot answer a question.

**Measured**

| Check | Result |
|---|---|
| `npm test` | **467 pass, 0 fail** (136 platform + 253 faborch + 78 gateway, including 15 new injection tests) |
| `npm run typecheck` / `npm run lint` | clean |
| `scripts/embed-live-check.mjs`, preview | **49/49** |
| `scripts/gate-live-check.mjs`, preview | 32/32 |
| `scripts/security-review.mjs`, preview | 24/24 |
| `scripts/embed-mobile-check.mjs`, preview | signed in at both widths, no console errors |

**Two things worth recording**

1. **A stale build briefly looked like a source failure.** After the route move,
   `typecheck` failed against `.next/types/validator.ts`, which still named the
   old paths. It is generated output; a rebuild cleared it. Reading it as a
   source error would have sent the next person editing the wrong thing.
2. **The WP1 screenshots were overwritten** by the WP2 run, before the output
   folder was split per package. The WP1 *measurements* survive in
   `docs/probes/2026-09-08-wp1-embed-mobile.md`; the script now takes
   `SHOTS_DIR` so it cannot recur.

**Open / unverified**

- Not yet opened by hand on a phone under WP2; the above is headless Chromium.
  A real-device pass is the natural gate before WP3 is accepted.
- Streaming a real answer through the embedded chat has not been exercised end
  to end — asking a question is WP4's acceptance, not WP2's.
- The WP0 finding still stands: production FO's `/chat` has no way to open its
  sidebar at phone width, so history, Reports, Settings and Log out are
  unreachable there.

---

## Embedding work — WP1 (gateway proof of concept): COMPLETE and ACCEPTED

**8 September 2026. Accepted by Amay after a manual check on a phone**, which
is the one thing no automation here could stand in for: the real
FabOrchestrator chat rendered through the preview PWA, followed by the expected
signed-out state. Everything else was already green locally and on the
`faborch-embed-preview` deployment.

**WP2 — single-login session bridge — followed; see its own section below.**
Nothing is committed; the working tree holds both packages for review.

**What WP1 proves.** With `FO_EMBED_SURFACES=/chat` set, the real
FabOrchestrator `/chat` document and **all 28 of its assets** are served from
this origin. With the variable unset — the default, and what production has —
every FabOrchestrator path is unreachable and the app is exactly what it was.

**How it is built**

- `lib/gateway/registry.ts` — the ownership decision. Which paths are this
  app's, which are FO's, which are refused. Unset flag ⇒ everything is this
  app's; that is the rollback.
- `lib/gateway/path.ts` — path hygiene. A path that could change *where* a
  request goes (`//host`, `..`, `%2e`, `%2f`, `%5c`, backslash, a scheme in the
  first segment) is refused, never normalised.
- `lib/gateway/headers.ts` — allow-lists both ways. Cookies and `authorization`
  never go up; FO's `AWSALB` cookies and its `content-encoding` never come
  down; FO's year-long HTML cache header is re-served as `no-cache`.
- `app/fo-gateway/[...path]/route.ts` — the forwarder. Streams both bodies,
  never follows redirects, rewrites a `Location` back onto this origin.
- `proxy.ts` — now the ownership decision as well as the 2026-09-04 session
  gate, with the matcher widened to every path.
- `next.config.ts` — `assetPrefix: "/pwa-assets"`, so bare `/_next/*` is
  unambiguously FabOrchestrator's.

**Measured**

| Check | Result |
|---|---|
| `npm test` | **452 pass, 0 fail** (136 platform + 253 faborch + **63 new gateway**) |
| `npm run typecheck` / `npm run lint` | clean |
| `scripts/embed-live-check.mjs`, flag on | **44/44** |
| `scripts/gate-live-check.mjs`, flag off | 32/32, same as the WP0 baseline |
| FO `/chat` + every referenced asset, through this origin | 200, **28/28** |

**Three things the build and the wire caught that reasoning had not**

1. **`/__fo` was never routed.** Next's App Router treats a folder starting
   with `_` as private and opts it out of routing, so the middleware's rewrite
   had no destination and every forwarded request would have 404ed. The route
   is `/fo-gateway/[...path]`. Only the build manifest showed this.
2. **The gate regressed on malformed paths.** Moving the old matcher's
   exclusions into `isDocument()` made `//evil.example` read as a static file,
   because it ends in something shaped like an extension, so the gate waved it
   through instead of bouncing it. The existing `route-gate.test.ts` caught it;
   malformed paths now meet the gate explicitly.
3. **The flag is read at runtime, not inlined at build time.** The build ran
   without the variable and a later `next start` *with* it enabled the gateway,
   so flipping the switch needs no rebuild. The rollback story in the plan
   holds.

**What WP1 deliberately does not do.** It does not authenticate. `authorization`
is dropped on the way up, so FO answers its own 401 to the embedded page's data
calls and FO's client shows its signed-out state. Injecting the FO token from
the httpOnly cookie, after verifying this app's session, **is WP2**.

**Deployed and verified on a preview app (8 September, later the same day)**

`https://faborch-embed-preview.fly.dev` — a **separate** Fly app with its own
session secret and `FO_EMBED_SURFACES = "/chat"`, configured by
`fly.preview.toml`. Production (`faborch-demo`) was not redeployed and not
reconfigured: its last deploy is still 6 September, its `/chat` still answers
307 from its own gate and `/favicon.ico` still 404s, so FabOrchestrator remains
unreachable there.

| Check, against the deployment | Result |
|---|---|
| `scripts/embed-live-check.mjs` | **44/44** |
| `scripts/gate-live-check.mjs` | 32/32 |
| `scripts/security-review.mjs` | 24/24 |
| FO `/chat` + every referenced asset | 200, **28/28** |

This also closes the one thing the Windows build could not exercise: the
standalone artefact runs correctly on Linux. Two deployment notes — Fly's first
deploy failed to allocate IPs and they were added by hand (`fly ips
allocate-v4 --shared`, then `allocate-v6`), and the "app is not listening"
warning during that deploy was a race; the machine was already serving.

**What a phone actually sees, measured** (`scripts/embed-mobile-check.mjs`,
390×844 and 360×640, screenshots in `docs/probes/wp2-shots/` (the WP1 run’s images were overwritten by the WP2 run before the folder was split; the WP1 measurements survive in `2026-09-08-wp1-embed-mobile.md`))

**FabOrchestrator's real chat renders on this origin.** Its own greeting is in
the DOM — *"Good afternoon, User / What would you like to orchestrate today? /
FabOrchestrator 2.0"* — with a composer, no sideways overflow at either width,
and no failed asset.

Then, exactly as WP1 predicts, FO's client calls its own APIs, the gateway
forwards them without a token, FabOrchestrator answers 401 to all five
(`/api/user/models`, `/api/fabinsight/access`, `/api/mcp/connections`,
`/api/fabinsight/warm`, `/api/conversations`), and FO's fetch wrapper reads an
authed 401 as expiry and shows its **"You've been signed out"** modal, which
counts down and redirects. **That is the WP1 boundary on screen, not a defect.**

Two consequences worth knowing before anyone opens it by hand:

1. **Opening embedded `/chat` signs you out of this app.** FO's expiry handler
   clears `llmatscale_auth_token` and `llmatscale_auth_session` — the very
   localStorage keys this app keeps its own session under, because this app
   deliberately adopted FabOrchestrator's convention. Measured: the token is
   gone after the visit. The httpOnly cookie survives, so the gate still passes,
   but `useSession` finds nothing and sends you to `/login`. **WP2 removes this
   by injecting the FO token, so those calls succeed and expiry never fires.**
2. **This app's `/api/auth/me` answers FO's client.** It is PWA-reserved, so
   FO's page asks *this app* who the user is, gets 200, and boots as though
   signed in. That is why the chat renders at all before the data calls fail.

**Also observed, pre-existing and not caused by WP1:** at 360×640 the iOS
install hint (`fixed … bottom-0`) sits over the Sign in button and intercepts a
tap on it; at 390×844 it does not. Recorded because it will be met during any
manual sign-in on a small phone. Not fixed here — it is outside WP1.

**Open / unverified**

- Not yet opened on physical hardware or as an installed home-screen app; the
  above is headless Chromium with a phone viewport and touch.
- The preview app should be destroyed once the embedding work is accepted:
  `flyctl apps destroy faborch-embed-preview`.
- The WP0 finding stands and still needs an answer: production FO's `/chat` has
  no way to open its sidebar at phone width, so history, Reports, Settings and
  Log out are unreachable there.

---

## Embedding work — previous package: WP0 (baseline and probes)

**8 September 2026.** The observation package that preceded WP1. The embedding plan (open the real FabOrchestrator
surfaces inside this app after one sign-in) has started with its observation
package. **No embedding code exists yet. WP1 is next and has not been
started.** Full evidence: `docs/probes/2026-09-08-wp0-embedding-baseline.md`.

**Completed**

- Baseline recorded: HEAD `585aa00`; `npm test` **389/389** (136 platform +
  253 faborch; the "272" in README and HANDOVER is stale); typecheck clean;
  `gate-live-check` 32/32 and `security-review` 24/24 against the deployment.
- Node.js restored on the build machine (it had vanished; reinstalled via
  winget, 24.19.0) — the one environment change, documented in the baseline.
- FabOrchestrator `/chat`, `/reports`, `/settings`, `/home` probed read-only:
  headers, cache policy, asset references, CORS, error envelope, signed-in
  account facts. Three new repeatable scripts: `scripts/fo-surface-probe.mjs`,
  `scripts/fo-mobile-probe.mjs`, `scripts/latency-baseline.mjs`.
- Phone-width run of the real FO pages at 390×844 and 360×640 with screenshots
  (`docs/probes/wp0-shots/`).
- Latency baseline: two questions through this app's proxy and direct to FO.
- `scripts/probe-faborch.ts` P4 corrected: it read a `{connections}` wrapper
  that FO never sends, so it reported "no data connections" on an account that
  has two connected servers.

**What WP1 must take into account** (details in the baseline §6–§7)

- Production FO's `/chat` has **no way to open the sidebar at phone width** —
  history, the Reports and Home links, Settings and Log out are unreachable on
  a phone. The local reference copy has a mobile trigger; upstream and
  production do not.
- `/settings` is a redirect to `/chat`; Settings is a modal inside chat.
- FO HTML is served with `s-maxage=31536000`; chunks are immutable; no
  manifest, service worker or icons in production; no CORS; no frame headers.
- The PWA hop costs about 1.4 s before a stream starts; first text and total
  time otherwise match the direct path. The WIP question varies by FO's own
  tool loop (6 vs 11 steps), not by path.

**Unresolved / manual**

- Hardware checks: iOS keyboard over FO's composer, standalone mode, Safari,
  rotation, any touch gesture for the sidebar; the 4 September sign-out fix on
  an installed iPhone.
- Which FO commit is deployed (production matches upstream `main` on every
  probed point; unconfirmed by the FO team). Shared demo password rotation.

**WP0 acceptance: met** on the evidence above; the hardware items are recorded
as manual checks, as the package allows. **Next: WP1 — not started.**

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
