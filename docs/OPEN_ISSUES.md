# Open issues

**As of 5 September 2026.** Everything here is **external to this app**: none is
a defect in the PWA, none blocks its use, and none can be closed by changing
this repository alone. Each names who can actually close it.

Defects *in* the app are not listed here — there are none outstanding. What was
found and fixed is recorded in `docs/STATUS.md`.

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
