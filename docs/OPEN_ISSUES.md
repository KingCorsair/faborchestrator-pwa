# Open issues

**As of 11 September 2026.** Everything here is **external to this app**: none is
a defect in the PWA, none blocks its use, and none can be closed by changing
this repository alone. Each names who can actually close it.

Defects *in* the app are not listed here — there are none outstanding. What was
found and fixed is recorded in `docs/STATUS.md`.

---

## 0a. FabOrchestrator hid its sidebar below 768px — **fixed on FabOrchestrator's branch `mobile-nav-preview` for every phone view (11 September); open until production ships it**

> **Every phone view, after a regression (11 September).** A first attempt
> limited this fix to the installed app. In Safari that left
> FabOrchestrator's website behaviour — no way into the sidebar — and in the
> installed iPhone app its `display-mode`-only detection failed, so the
> navigation vanished in both. Rolled back; Amay's call is that
> FabOrchestrator's sidebar trigger bar applies on **every phone view**,
> browser and installed. Only the cockpit header's menu (0c) is
> installed-app-only, detected from `display-mode` **or**
> `navigator.standalone` (`lib/installed-app.ts`).
>
> **Fixed 11 September, in FabOrchestrator.** Below 768px its sidebar is still a
> drawer — the right phone pattern — but the drawer now has a trigger outside
> it: a slim bar at the top of the content (`components/mobile-sidebar-bar.tsx`,
> `md:hidden`) holding FabOrchestrator's own `SidebarTrigger` and wordmark,
> rendered by both `full-chat-app.tsx` and `modeling-chat-app.tsx`, so `/chat`,
> `/modeling-agent` and both loader routes are covered. It sits in normal flow
> rather than floating (as `c8ffc43` did), so it covers neither the first
> message nor the modeling agent's CMF status strip. The preview serves the
> branch through `FO_UI_BASE_URL` (`fly.preview.toml`, `lib/gateway/upstream.ts`);
> `scripts/fo-mobile-nav-check.mjs` proves it at 390, 390×797, 750, 844 and 1280.
>
> **The PWA's workaround is gone.** The injected Back arrow and hamburger, and
> the keyboard-shortcut driver behind the hamburger, were removed from
> `public/fo-shell.js` the same day. This app keeps no navigation of its own.
>
> **Correction to the text below.** "At 844px both appear immediately" is true,
> but 844px is not what an iPhone in landscape produces: Safari insets a
> landscape page on a notched iPhone by its safe areas, so an iPhone 13 is
> **750px** wide in landscape — still below the breakpoint, still the phone
> layout. A turned phone never got the rail.
>
> **Still open** until FabOrchestrator's team merges the branch and deploys
> production. Everything below describes production as it is today.

**What it is.** On a screen narrower than 768px, FabOrchestrator's chat renders
**no sidebar and no sidebar trigger at all**. Measured on production through the
preview at 390px: after twelve seconds on `/chat`, `[data-slot="sidebar"]` and
`[data-sidebar="trigger"]` are both absent and stay absent. At 844px both
appear immediately.

`components/ui/sidebar.tsx` returns a Radix `Sheet` on mobile whose content
exists only while `openMobile` is true; `openMobile` is React state settable
only by `toggleSidebar()`; and the chat's only `SidebarTrigger` sits inside
that unmounted sheet's header. A related first-render race — `useIsMobile()`
returns false initially, so the desktop rail paints and then disappears — is
what makes it look intermittent rather than absent.

**What it costs.** The sidebar holds the conversation list, the Dashboard link,
FO Overview, Settings and **Log out**. On a phone in portrait, none of it can be
opened. This is FabOrchestrator's behaviour on its own website; embedding
inherits it.

**Why the PWA cannot fix it.** Three routes were tried and measured: a
synthetic Ctrl+B (React ignores untrusted events, verified), clicking its own
trigger (not rendered), and widening the document so `useIsMobile()`
re-evaluates (`min-width` does not change `window.innerWidth`). A page cannot
set another app's React state.

**The fix — one line**, in `claudeai_athena/components/full-chat-app.tsx`,
beside the chat content:

```tsx
<SidebarTrigger className="bg-background/90 absolute left-2 top-2 z-20 rounded-md shadow-sm backdrop-blur-sm md:hidden" />
```

**This line already exists in FabOrchestrator's own local working copy** (at
`full-chat-app.tsx:2427`, with a comment recording the same diagnosis). It is
absent from upstream `main` and from production. So the fix has been written on
their side and not shipped.

**Owner:** the FabOrchestrator team.
**Severity:** high for any phone use of the embedded chat, and for
FabOrchestrator's own mobile users.

---

## 0b. FabOrchestrator's CloudFront distribution caches nothing — **found 9 September, WP8**

Every response from `https://d7y8a8whrch88.cloudfront.net` carries
`X-Cache: Miss from cloudfront`. Not sometimes — every time, including five
consecutive requests for the *same* JavaScript chunk, a chunk FabOrchestrator's
own build labels `public, max-age=31536000, immutable`:

```
$ for i in 1 2 3 4 5; do curl -sI .../_next/static/chunks/17450d5f1f92fe1e.js | grep X-Cache; done
X-Cache: Miss from cloudfront
X-Cache: Miss from cloudfront
X-Cache: Miss from cloudfront
X-Cache: Miss from cloudfront
X-Cache: Miss from cloudfront
```

The documents behave the same way, and they are sent with
`Cache-Control: s-maxage=31536000` — a header that exists for no reason other
than to tell a CDN to hold them for a year.

**What it costs.** Every request reaches the origin nginx, so the CDN is a hop
rather than a cache. Measured from a Fly machine in Singapore: 142 ms of round
trip to the edge, and 294 ms for a request that ought to be answered from the
edge's own disk. Roughly 150 ms of that is the origin fetch that a hit would
have avoided — on **every asset, for every user**, including FabOrchestrator's
own.

**It is not a distance artefact.** The same probe was run again from a Fly
machine in `sjc`, roughly 30 ms from FabOrchestrator's origin instead of 300.
Every response there is `X-Cache: Miss from cloudfront` too. The distribution
misses everywhere, for everyone — being close to it only makes the miss cheaper.

**Whose it is.** FabOrchestrator's deployment. Nothing in this app can change
it, and the PWA's gateway forwards the caching headers unaltered, so a phone
that has visited once already avoids the whole thing on the next visit. It is
listed because it is the largest single latency item WP8 found anywhere, and
because it costs FabOrchestrator's own users more than it costs this app's.

**Likely cause, for whoever picks it up.** A distribution whose cache policy is
`CachingDisabled`, or one forwarding all headers or cookies to the origin — the
origin does set ALB stickiness cookies on every response, and a distribution
configured to forward cookies will refuse to cache anything that carries one.
Worth checking before anything else.

**Who can close it:** the FabOrchestrator infrastructure owner.

---

## 0c. On a phone, FabOrchestrator's Reports page had no entry point — **fixed on the same branch for every context (11 September, FO UI v5); open until production ships it**

> **Fixed 11 September, in FabOrchestrator.** Below 768px — in a browser and in
> the installed app alike — the cockpit header on `/home` and `/reports` keeps
> its place and gains a menu button at its left, opening FabOrchestrator's own
> dropdown with **Cockpit, Chat and Reports** (Chat shown but disabled), the
> current page marked. The button is `md:hidden`, the exact complement of the
> link row's `hidden md:flex`, so exactly one of the two shows at every width,
> fractional ones included. Nothing about the installed app decides whether it
> exists. (An earlier version gated it on the installed app too; in every
> browser below 768px that left `/home` and `/reports` with no navigation at
> all — `docs/STATUS.md`.) The chat drawer's Dashboard link (0a) is a second
> way in. In the installed app a report also opens scrolled to the top, so its
> "All reports" link is on screen.
>
> **Desktop:** the row's Cockpit and Reports now go to `/home` and `/reports`
> (fact two below: both used to lead to `/home`). Agents, Workflows and Sites
> have no pages and still lead to the cockpit; the row's look is unchanged.

Now that FabOrchestrator's own `/home` is the landing page, this is the one
thing an operator cannot get to from it on a handset. Two separate facts about
FabOrchestrator combine to produce it, and the first is easy to mistake for the
whole story.

**Fact one: the cockpit nav is hidden below 768px.**
`components/cockpit/cockpit-nav.tsx:78` —

```jsx
<nav className="hidden items-center gap-1.5 md:flex">
```

Measured on the deployed preview, signed in, on FabOrchestrator's own cockpit:

| viewport | Cockpit / Agents / Workflows / Sites / Reports |
|---|---|
| 390px (portrait phone) | in the DOM, **0 × 0**, parent `display: none` |
| 768px and 1280px | 104 / 97 / 121 / 84 / 103 px, visible |

**Fact two, and the one that actually matters: that nav does not navigate.**
Every item in it — Reports included — is the same handler:

```jsx
onClick={() => router.push("/home")}
```

All five are decorative. Clicking Reports at 844px was measured on the preview:
the page stays on `/home`. So showing the nav on a phone would not reach
Reports either; **the cockpit has never been a route to it**, on FabOrchestrator's
own site or here.

**The real entry point is the chat sidebar.** `full-chat-app.tsx:514` —
`SidebarMenuButton tooltip="Dashboard" onClick={() => router.push("/reports")}`
— which works, and is the path an operator takes on a desktop. On a phone that
sidebar is not rendered at all, which is **0a**. So Reports is unreachable on a
portrait handset because of 0a, and the cockpit nav is a red herring.

**What a phone does get on the cockpit**, verified: FabOrchestrator's ask
composer renders and works, and all four agent cards render and open. The main
path — ask a question, reach an agent — is intact. It is Reports specifically
that has no door.

**The smallest FabOrchestrator-side fixes**, in the order they are worth doing:

1. **Fix 0a** (the chat sidebar below 768px). That alone restores Reports on a
   phone, through the path the product already uses, and fixes the conversation
   list and Log out at the same time.
2. Optionally, make the cockpit nav real — give its items their routes and let
   the strip scroll on a narrow screen:
   ```diff
   - <nav className="hidden items-center gap-1.5 md:flex">
   + <nav className="flex items-center gap-1.5 overflow-x-auto md:overflow-visible">
   ```
   Five entries measure about 509px against a 390px screen, so it has to scroll
   inside itself rather than widen the page.

**Why this app is not working around it.** Reproducing FabOrchestrator's nav
here would be rebuilding one of its screens, which the corrected architecture
exists to stop — and the equivalent workaround was tried three times for 0a and
failed each time.

**Who can close it:** Danish's team.

**Until then:** `/reports` works perfectly by URL, by any link, and from the
chat sidebar at 768px and above. (This once added "which includes the same
handset in landscape". It does not: an iPhone in landscape is 750px wide — 0a.)

---

## 0. FabOrchestrator's file download has no ownership check — **found 8 September**

**What it is.** `GET /api/files/{fileId}/download` calls `requireAuth`,
validates the id's shape, then fetches the bytes from the Files API and returns
them. Read in full on upstream `main`: there is **no comparison against the
caller**. Any signed-in FabOrchestrator user who knows a file id can download
that file, including one uploaded by somebody else.

**How it was found.** Inspecting the routes the embedded chat needs, during
WP5 of the embedding work.

**What is not true about it.** Embedding does not widen the exposure. The
gateway injects a FabOrchestrator token only for a caller holding a live
session of this app bound to the matching cookie, so the population that can
reach this endpoint through the PWA is exactly the population that can reach it
on FabOrchestrator's own website. It is also **not** the same as the
`/api/chat` conversation-id gap: there this app's own proxy had already closed
the hole and the gateway closed it again (WP4), whereas this app never exposed
downloads at all before embedding.

**Why the PWA did not close it.** Proving ownership would mean scanning the
caller's conversations for the id on every download — expensive, fragile, and
it would refuse legitimate downloads whose provenance this app does not model.
Blocking downloads outright would break the feature the embedded chat needs.

**What makes it stand out.** Every neighbouring route checks properly:
`/api/artifacts`, `/api/artifacts/[id]`, `/api/messages/feedback`,
`/api/conversations/[id]` and its `/messages` and `/title` children all compare
the conversation or artifact against `user.id`. This one does not.

**What to do.** Add the check in FabOrchestrator — the file record's owner
against the caller — and send it alongside the `/api/chat` conversation-id gap
already written up in `docs/FABORCHESTRATOR_ROUTING_GROUNDING_BUGS.md`.

**Owner:** the FabOrchestrator team.
**Severity:** moderate. It needs a known file id, and file ids are opaque, but
an id appears in the conversation history of whoever was shown the file.

---

## 1. Rotate the shared FabOrchestrator demo password — **action needed**

**What happened.** During the sign-in investigation on 3 September, the login
form briefly performed a native `GET` submission, which put the credentials in
the URL:

```
https://faborch-demo.fly.dev/login?email=…&password=…
```

That URL reached **Fly's request logs**. It also passes through browser history
and, in general, referrer headers.

**Why it happened.** A partial fix gave the form fields `name` attributes so
they could be read at submit. That also made the form natively submittable, and
a press landing before React hydrated was handled by the browser rather than the
page — and a form defaults to GET. It was caught on the next deploy and fixed
within the hour.

**Is the bug still present?** No. Two guards now stand: the submit button is
disabled until React has attached, and the form is `method="post"` so any
submission that escapes carries the credential in a body rather than a URL.
Both are asserted in `__tests__/platform/credentials.test.ts`.

**So why does this still need action?** Because the exposure already happened.
The password is in log storage regardless of the code being correct now.

**The account.** `FABORCH_PROBE_EMAIL` — the **shared FabOrchestrator demo
account**, role Supervisor. It is not a personal account and not an
administrator, which bounds the exposure: it can read plant data and pinned
dashboards, and cannot create, pin or delete anything. It is used by the check
scripts in `scripts/` and for demonstrations.

**What to do.**

1. Change the password in FabOrchestrator (an FO administrator).
2. Update `.env` locally for whoever runs the checks.
3. Nothing to update on Fly — the app does not hold this credential; only the
   check scripts use it.
4. Optionally, ask whoever administers the Fly account to purge or age out the
   affected request logs.

**Owner:** a FabOrchestrator administrator, plus whoever holds `.env`.
**Severity:** moderate — a shared, non-admin demo credential in a private log
store. Not urgent, not ignorable.

---

## 2. The FabOrchestrator grounding fix is written but unshipped

**What it is.** FabOrchestrator, asked for a dashboard by a user *without*
dashboard permission, would build one and fill it with invented figures labelled
"illustrative sample values". Two further defects sat alongside it: a metric ask
whose data source was down fell back to general knowledge, and an ordinary
question on an account with no connected tools was answered ungrounded.

**Where the fix is.** Written, tested (21 tests) and committed on a **local,
unpushed** branch `fix/grounded-routing` in the FabOrchestrator clone. It has
deliberately never been pushed. The full write-up for whoever takes it is
`docs/FABORCHESTRATOR_ROUTING_GROUNDING_BUGS.md`.

**Why it matters more now than it did.** This app renders artifacts properly as
of WP9. Until then a fabricated dashboard arrived as raw markup that nobody
would mistake for a real report. It now arrives as a clean, full-screen
dashboard. **The better this app got, the more convincing a fabricated dashboard
became.**

**What to do.** Send `docs/FABORCHESTRATOR_ROUTING_GROUNDING_BUGS.md` to whoever
owns FabOrchestrator. Nobody has been asked yet.

**Owner:** the FabOrchestrator team, on Jothi's word.
**Severity:** high for any demonstration — it is the one thing that can put
invented plant figures in front of a customer.

---

## 3. Two of ten MCP servers were failing upstream

**What it is.** The Genealogy and Scrap Pareto MCP servers returned HTTP 500 on
2026-07-24, per the engineering plan's own risk note. Whether they still do has
not been re-checked.

**Effect here.** A question needing one of those tools gets a degraded answer
from FabOrchestrator. This app relays FO's message; it cannot fix or work around
it.

**What to do.** Verify current state with a FabOrchestrator administrator before
any demonstration that depends on genealogy or scrap-Pareto questions.

**Owner:** whoever operates the MCP servers.
**Severity:** low unless a demonstration depends on those two.

---

## 4. The planning documents describe an app that no longer exists

**What it is.** The four planning HTML documents in `docs/planning/` still
describe four agents, a production-order workflow and budget work that were
removed by scope decisions on 1 and 3 September. `docs/STATUS.md`,
`docs/PRD.html` and `docs/HANDOVER.md` are current; the plans are not.

**Effect.** A reader who starts from the plans gets a wrong picture. Anyone
reading `STATUS.md` first does not.

**What to do.** Either bring them into line or mark them superseded. This is
documentation debt, not a defect.

**Owner:** this project.
**Severity:** low, but it will mislead somebody eventually.

---

## 5. `/reports` shows FabOrchestrator's snapshot, which may be stale

**What it is.** Pinned dashboards are read from FabOrchestrator's **cached
snapshot**, and this app deliberately offers no Refresh — FO's refresh route is
not admin-gated and overwrites what every other reader sees.

**Effect.** A dashboard can be hours old. The screen says exactly when it was
last refreshed, so this is disclosed rather than hidden.

**What to do.** Nothing here. If a fresher snapshot is wanted, an administrator
refreshes it in FabOrchestrator.

**Owner:** a FabOrchestrator administrator.
**Severity:** none, given the timestamp is shown. Listed so nobody reports it as
a bug.

---

## 6. FabOrchestrator answers some MES questions differently each time

**What it is.** Questions with no fixed query behind them — "how many lots are
currently in WIP?", "which equipment is running right now?" — are answered by
the model choosing a database view and writing SQL on the spot. It does not
choose the same one twice.

**Proved on production, same account, same prompt, runs seconds apart.** One
unchanged request body sent five times returned **424 · 237 · 237 · 427 · 427**;
an earlier pass with the same body also returned **10,904**. The 237/427 split is
a single missing `WHERE` predicate — whether 185 lots in `Queued` / `Suspended`
count as WIP. Nobody has decided that, so the model decides it per request.

**This is not a PWA defect.** The proxy was recorded on the wire and forwards the
question correctly; the FabOrchestrator website disagrees with **itself** by more
than it disagrees with the PWA. Yield is stable on both, because FabOrchestrator
answers it from a fixed metric path that never reaches the tool loop — which is
also the shape of the fix.

**Full write-up, with the SQL, the returned rows and the reproduction:**
`docs/FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md`. That file is what
to send to the FabOrchestrator team.

**What to do here.** Nothing, and specifically **not** pin a query in this app:
that would put a manufacturing definition into a forwarding layer and make the
PWA answer differently from the product it demonstrates.

**For a demonstration.** The WIP figure may not survive being asked twice. Lead
with "give me the yield by product", which is deterministic and returns a real
table.

**Owner:** the FabOrchestrator team, plus whoever owns the fab data and can rule
on what WIP means.
**Severity:** medium. Nothing is broken, but a supervisor could be shown two
different numbers for the same question in one meeting.
