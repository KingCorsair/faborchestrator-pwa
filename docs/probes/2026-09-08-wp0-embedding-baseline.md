# WP0 — Embedding baseline

**8 September 2026.** The starting point for the FabOrchestrator embedding work,
recorded before any embedding code exists. Everything below is labelled
**Verified** (measured or read directly), **Observed** (seen once, not yet
confirmed as stable), or **Needs manual / runtime verification**.

Generated evidence sits beside this file:

| File | Produced by |
|---|---|
| `2026-09-08-probe-report.md` | `npx tsx scripts/probe-faborch.ts` (P1–P5) |
| `2026-09-08-wp0-fo-surfaces.md` | `node scripts/fo-surface-probe.mjs` |
| `2026-09-08-wp0-fo-mobile.md`, `wp0-shots/` | `node scripts/fo-mobile-probe.mjs` |
| `2026-09-08-wp0-latency.md` | `node scripts/latency-baseline.mjs` |

Nothing in FabOrchestrator was modified. Every FO request made here is a GET, an
OPTIONS, a sign-in/sign-out pair for the probe account, or a chat turn on that
account (four turns, for the latency table).

---

## 1. Repository and environment

**Verified.**

| Item | Value |
|---|---|
| Repository | `KingCorsair/faborchestrator-pwa`, branch `main`, HEAD `585aa00`, in sync with `origin/main` |
| Working tree before WP0 | clean except an untracked `docs/plan/` (planning notes from 6 September, not part of WP0) |
| Deployment tested | PWA `https://faborch-demo.fly.dev` (Fly.io); FabOrchestrator `https://d7y8a8whrch88.cloudfront.net` |
| Node | 24.19.0, npm 11.17.0 |
| Playwright | Chromium 1234 installed (`ms-playwright`) |

**Environment repair, documented as the plan requires.** On 7 and 8 September
`node.exe` was missing from `C:\Program Files\nodejs` while the npm shims and
the winget registration (Node.js LTS 24.18.0) remained. The minimum change was
`winget install --id OpenJS.NodeJS.LTS --exact --force`, which reinstalled Node
24.19.0. No other machine change was made.

## 2. Test suite and static checks

**Verified**, run on 8 September against HEAD `585aa00`:

| Check | Result |
|---|---|
| `npm test` — platform suite | 136 tests, 136 pass, 0 fail |
| `npm test` — faborch suite | 253 tests, 253 pass, 0 fail |
| `npm run typecheck` | clean |
| `scripts/gate-live-check.mjs` vs deployment | 32/32 |
| `scripts/security-review.mjs` vs deployment | 24/24 |
| `scripts/probe-faborch.ts` P1, P2, P3, P5 | pass (P4 see §7) |

**Discrepancy.** `README.md` and `docs/HANDOVER.md` say "272 tests". The suite
is 389. The number in those files is stale; the files are not edited by WP0.

## 3. FabOrchestrator surfaces (`/chat`, `/reports`, `/settings`)

**Verified**, unauthenticated, from `2026-09-08-wp0-fo-surfaces.md`:

| Path | Status | Content | Cache-Control | Frame / CSP | Assets referenced |
|---|---|---|---|---|---|
| `/chat` | 200 | HTML | `s-maxage=31536000` + ETag | no X-Frame-Options, no CSP | 22 js, 4 css, 2 fonts; 28 `/_next/` refs |
| `/reports` | 200 | HTML | same | same | 19 js, 4 css, 2 fonts |
| `/settings` | 200 | HTML | same | same | 16 js, 3 css, 2 fonts |
| `/home` | 200 | HTML | same | same | 19 js, 4 css |
| `/modeling-agent` | 200 | HTML | same | same | 22 js, 4 css |
| `/manifest.webmanifest`, `/sw.js` | 404 | — | `no-store` | — | FO ships neither in production |
| `/favicon.ico` | 200 | icon | `max-age=0, must-revalidate` | — | — |
| unknown path | 404 | HTML | `no-store` | — | — |

Every HTML surface: **no absolute asset URLs**, **no manifest link**, **no
apple-mobile-web-app meta**, viewport `width=device-width, initial-scale=1,
maximum-scale=5, user-scalable=yes`. All asset references are root-relative
`/_next/static/...`. ALB stickiness cookies `AWSALB` and `AWSALBCORS` are set on
every response.

Other verified runtime facts:

- One JS chunk: `public, max-age=31536000, immutable`, served gzip.
- `OPTIONS /api/chat` from a foreign origin: 204, **no**
  `Access-Control-Allow-Origin`; `Allow: GET, HEAD, OPTIONS, POST`.
- `GET /api/auth/me` without a token: 401, envelope
  `{ error: { type: "SESSION_TIMEOUT", … } }`.
- Plain `http://…/chat` → 301 to https.

**Verified, signed in as the probe account** (role `Business User`, session
expiry 30 days): 3 MCP connections, 2 connected (`CMF_Assembly_DB_Test3`,
11 tools; `CM MES - Assembly (Use Cases)`, 9 tools; `Jira_Tickets`
disconnected); 13 pinned reports, `canManage false`; `canCreateDashboards
false`; modeling access `enabled true`; models `claude-opus-4-7` (default),
`claude-sonnet-5`, `claude-opus-4-8`.

**`/settings` is not a page.** Verified in upstream `app/settings/page.tsx`
(`router.replace("/chat")`) and in the phone probe (both viewports land on
`/chat`). Settings is a modal inside `/chat`, opened from the sidebar's user
menu (`components/full-chat-app.tsx`, `SettingsModal`). Any plan that lists
"Settings" as a separate surface must be read as "the Settings modal within
chat".

## 4. FabOrchestrator at phone width

**Verified in headless Chromium** (iPhone 13 descriptor, touch, 390×844 and
360×640), from `2026-09-08-wp0-fo-mobile.md` and `wp0-shots/`:

| Surface | 390×844 | 360×640 |
|---|---|---|
| `/chat` | no sideways overflow; composer on screen; 10 tap targets under 44px; 22 JS files; settled 4.3 s cold | no sideways overflow; composer on screen; **footer text overlaps the composer's model row** (`fo_chat-360x640.png`) |
| `/reports` | renders: header, "Back to chat", 13 pinned cards, timezone selector; 4 small targets | same |
| `/home` | renders the desktop cockpit hero and ask bar | same |
| `/settings` | redirects to `/chat` | same |

**Verified: FO's `/chat` has no visible way to open the sidebar at phone
width.** The only `SidebarTrigger` in upstream `full-chat-app.tsx` (line 468)
is inside `SidebarHeader`, which on screens under 768px renders as a closed
sheet, so the trigger is not in the DOM. The probe found no
`[data-sidebar="trigger"]` on any surface at either viewport, and the
screenshots show no menu button. The sidebar carries the conversation list, the
links to `/home` and `/reports`, the Settings menu item and **Log out**. At
phone width in production all of those are unreachable except by the keyboard
shortcut Ctrl/Cmd+B, which a phone does not have.

**Discrepancy with the reference copy.** The local reference source
(`work_projects/FabOrchestrator_product_code/claudeai_athena`) has a second,
`md:hidden` trigger at `full-chat-app.tsx:2427` that fixes exactly this. It is
absent from upstream `main` and from production. Design for production.

Not testable headless, **needs manual verification on hardware**: the iOS
keyboard over the composer, standalone-mode behaviour, Safari-specific
rendering, rotation, and whether the sidebar sheet can be opened by any touch
gesture.

## 5. Latency baseline

**Verified**, single client in India, from `2026-09-08-wp0-latency.md`:

| Static request | TTFB (median of 3) | Bytes |
|---|---|---|
| FO `/chat` HTML, direct | 56 ms | 38,500 |
| FO JS chunk, direct, gzip | 40 ms | 29,760 |
| PWA `/login` HTML (Fly, sin) | 216 ms | 14,013 |

| Question | Path | TTFB | First text | Total | Steps | Tool calls |
|---|---|---|---|---|---|---|
| Give me the yield by product. | via PWA proxy | 1.9 s | 3.8 s | 14.4 s | 1 | 0 |
| Give me the yield by product. | direct to FO | 0.5 s | 4.1 s | 15.3 s | 1 | 0 |
| How many lots are currently in WIP? | via PWA proxy | 1.9 s | 57.8 s | 65.8 s | 11 | 10 |
| How many lots are currently in WIP? | direct to FO | 0.2 s | 32.7 s | 34.8 s | 6 | 7 |

Reading: the PWA hop costs about 1.4 s before the stream starts (the proxy's
serial calls for the tool list and ownership check, plus the Fly round trip),
and nothing after. First text and total time for the yield question are the
same on both paths within noise. The WIP question's 31-second difference is
**Observed**, not attributable to the path: FO ran 11 steps one way and 6 the
other, which is FO's own tool-loop variance (already documented in
`FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md`).

## 6. What WP1 can rely on

**Verified**

- FO can be fetched server-to-server from any origin; nothing blocks framing or
  proxying (no XFO, no CSP), and nothing allows browser cross-origin calls (no
  CORS).
- FO's pages are public HTML shells; authentication is client-side, bearer-only,
  via `/api/auth/me`; the unauthenticated error envelope is `SESSION_TIMEOUT`.
- All FO asset references are root-relative under `/_next/`; there is no
  `basePath` or `assetPrefix`; chunks are immutable and gzip-served; HTML is
  cached for a year by header and must be overridden when re-served.
- FO ships no manifest, no service worker and no icons in production, so the
  PWA's own will not collide with anything.
- The probe account has live data connections and 13 pinned reports, so both
  `/chat` and `/reports` can be demonstrated with real content.

**Observed**

- The MCP connection set changed between 7 September (one connection, 28 tool
  names) and 8 September (three connections, 20 tools on the two connected). It
  is administered on the FO side and may change again.

**Needs manual / runtime verification**

- Everything in §4's last paragraph (iOS keyboard, standalone, Safari,
  rotation, touch gesture for the sidebar).
- Whether FO's Reports "Open" re-runs the report or shows the shared snapshot
  on a phone; the page's own copy says it shows the latest shared snapshot with
  a Refresh inside the report.
- Which FO revision is deployed. Production matches upstream `main` on every
  point probed (no manifest, no `/backend-agent`, no mobile sidebar trigger,
  `/reports` present); the exact commit has not been confirmed by the FO team.

## 7. Discrepancies between the old plan and the current code or runtime

| Plan or note said | Found | Consequence |
|---|---|---|
| `scripts/probe-faborch.ts` P4 reads `{ connections: [...] }` | FO returns a bare array; P4 reported "0 connected of 0 visible" on an account with two connected servers | Fixed in the probe (accepts both shapes). Every earlier "no data connections" statement in `docs/` that came from P4 is unreliable |
| "272 tests" (README, HANDOVER) | 389 tests, all passing | Docs stale; noted, not edited |
| Node.js unavailable on the build machine (7 Sep) | Reinstalled via winget on 8 Sep | Automated probes now run |
| "Settings" as a third FO surface | `/settings` redirects to `/chat`; Settings is a modal in chat | Business Case D means the modal, reachable only through the sidebar |
| FO chat "adapts below tablet width with a sheet sidebar and a trigger" | Sheet exists; **trigger does not exist in production** | Sidebar functions (history, logout, settings, reports link) are unreachable on phones in production FO. Either an FO-side fix (the reference copy already has one) or PWA-side navigation must cover them before Phase 3 acceptance |
| Reports "re-runs live when opened" | FO's own page text: opens the latest shared snapshot; Refresh inside a report re-runs | Correct the wording in the business plan |
| Demo account "no MCP connections" (PRD §16, 1 Sep) | Two connected servers today | Plant questions beyond yield are answerable; the WIP run in §5 used them |

## 8. Manual checks still required

1. On a physical iPhone (installed PWA, standalone): open the current PWA, sign
   out, force-quit, reopen — the 4 September fix has not been confirmed on
   hardware.
2. On a physical iPhone and one Android at 360 px, in Safari/Chrome (not via
   the PWA): open FO `/chat` and `/reports` directly, signed in, and record the
   keyboard-over-composer behaviour and whether the sidebar can be opened at
   all.
3. Ask the FO team which commit is deployed on the CloudFront address.
4. Rotate the shared demo password (open since 3 September).

## 9. WP0 acceptance

| Criterion | Result |
|---|---|
| Current PWA baseline recorded | Pass (§1, §2) |
| FO behaviour inspected without modification | Pass (§3–§5; read-only) |
| `/chat`, `/reports`, `/settings` understood for WP1 | Pass, with the `/settings` and sidebar findings recorded |
| Mobile-width behaviour checked as far as automation allows | Pass (§4); hardware items in §8 |
| Latency baseline exists | Pass (§5) |
| Actual test-suite result recorded | Pass (§2) |
| Unknowns and manual checks documented | Pass (§6, §8) |
| No embedding changes made | Pass (scripts and docs only) |
| FabOrchestrator not modified | Pass |
| STATUS updated | Pass (`docs/STATUS.md`) |
| WP1 not started | Pass |
