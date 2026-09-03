# FabOrchestrator PWA — Product Requirements

**Version 1.4 · 3 September 2026**

This document says **what the product is and how it should behave**. It does not
say how to build it — that is the engineering plan in `docs/planning/`, and
progress against it is in `docs/STATUS.md`.

It exists so that product decisions and open questions stop being settled by
accident inside implementation work.

## How to read the labels

Every statement carries exactly one:

| Label | Meaning |
|---|---|
| **CONFIRMED** | Explicitly agreed, or already built and proven. Do not change without a product decision. |
| **PROPOSED** | A reasonable current design. Implemented or planned, but nobody outside the engineering work has agreed it. |
| **OPEN QUESTION** | Needs an answer from Jothi or Yogita. **Not guessed at in this document.** |
| **OUT OF SCOPE** | Deliberately excluded. |

A **PROPOSED** item that has been built is still PROPOSED. Building something is
not the same as agreeing it, and this document does not use one to imply the
other.

---

## 1. Product goal

**CONFIRMED — Give operations staff access to FabOrchestrator from a phone,
without building a second version of the product.**

The app is a front door and a secure connector. It contains no manufacturing
intelligence of its own. Every answer it shows is produced by FabOrchestrator:
the reasoning, the MES and quality data, the dashboards, the permissions, the
usage limits and the audit trail all stay where they are.

**CONFIRMED — The app must never become a second product.** A production-order
workflow running on mock data was removed on 1 September 2026 for exactly this
reason. If a screen can answer a question without asking FabOrchestrator, it
does not belong here.

**PROPOSED — Success is one sentence.** A supervisor scans a code on the floor,
installs the app, asks what yield looked like this week, and reads
FabOrchestrator's answer — computed by FabOrchestrator, from its data, under
that supervisor's own permissions — on their phone.

---

## 2. Target users

**PROPOSED — Primary: a production supervisor on the fab floor.** Holding a
phone, one-handed, possibly gloved, in a noisy place. Wants an answer about a
line, an order, a metric. Does not know — and should not need to know — how
FabOrchestrator is organised internally.

**PROPOSED — Secondary: managers and engineers who already use
FabOrchestrator** on a desktop and want the same answers away from it.

**OPEN QUESTION — Is the supervisor the real first user, or is the first
audience actually a demonstration audience?** The two want different things: a
supervisor needs speed and reliability on one narrow task; a demonstration needs
breadth and visible capability. Several design choices below depend on this.

**OUT OF SCOPE — Administrators.** Role assignment, MCP configuration, user
management and quota setting stay in the FabOrchestrator admin console. The PWA
never administers anything.

---

## 3. Main user journeys

**CONFIRMED — J1. Ask and read.** Open the app, sign in with a FabOrchestrator
account, ask a question, read the answer as it is written. *Proven end to end
against the live platform.*

**CONFIRMED — J2. Follow up.** Ask a second question in the same thread and have
it understood in the context of the first.

**PROPOSED — J3. Install and return.** Scan a QR code, install the app to the
home screen, reopen it later straight into a signed-in session.

**PROPOSED — J4. Ask about live plant data.** Ask a metric question and get an
answer drawn from MES and quality systems, rendered readably on a phone.
*Blocked — see §16.*

**PROPOSED — J5. See a dashboard.** Ask for a chart and get one, full-screen and
tappable.

**OUT OF SCOPE — Acting on what you learn.** Approving, rejecting, escalating,
recording a decision. The app answers questions; it does not change anything in
any system.

---

## 4. Landing-page experience

**CONFIRMED — The landing page is the front door and mirrors FabOrchestrator's
own cockpit.** It is not a menu invented for this app.

**CONFIRMED — It offers a single ask box first.** A person can type a question
without choosing anything (see §5).

**PROPOSED — It also lists the platform's agents as cards**, in the product's own
numbering and wording, as a direct path for anyone who prefers to choose.

**CONFIRMED — The landing page does not list the platform's wider capabilities.**
*Decided 3 September 2026.*

An "In this PWA" section named five things FabOrchestrator does — master-data
loading, generated dashboards, roles and access control, usage and cost tracking,
the audit trail — as facts about the platform, deliberately not as links.

The reasoning was honesty: say what the product does without implying this app
opens it. In practice it read as a feature list, on a phone, for five things the
visitor cannot reach from the screen they are looking at. The Nucleus already
says where answers come from. Removed, along with the strapline beneath it, which
still described the production-order workflow's mock MES two days after that
workflow was deleted.

**PROPOSED — The navigation mirrors the product's cockpit nav** — Cockpit,
Agents, Workflows, Sites, Reports — with sections this app cannot open shown
greyed and non-clickable, carrying the reason. Two of them are placeholders in
FabOrchestrator itself.

**OPEN QUESTION — Should the landing page show activity figures?** It currently
shows counters ("1,284 queries today", "6 connectors deployed") carried over
from the product's own cockpit. They are **placeholders, not live data**. In a
demonstration they read as real. Options: make them live, label them clearly as
illustrative, or remove them.

---

## 5. Agentic entry-point behaviour

**CONFIRMED — A user should be able to ask from the landing page without
manually choosing an agent first; the system determines the appropriate
FabOrchestrator route/agent and returns the result.**

*Confirmed by Jothi, 1 September 2026. This is the defining interaction of the
product.* The user's mental model is "I ask FabOrchestrator a question", not "I
select a subsystem and then ask it a question".

**CONFIRMED — The intelligence stays in FabOrchestrator.** Choosing which tools
and which data answer a question is already the platform's own work. The app
must not add reasoning of its own; where a routing judgement is genuinely needed,
it is asked of the platform.

**PROPOSED — Anything unclear resolves to the general-purpose agent.** An
ambiguous, unanswerable or not-permitted request goes to the agent that can
answer the widest range of questions, rather than failing.

**PROPOSED — The route is visible and reversible.** The answer says which agent
produced it, and can be re-asked elsewhere in one tap. A route the user cannot
see is a route they cannot correct.

**PROPOSED — Routing never blocks a normal answer.** Any decision step is capped
in time; if it is slow or fails, the question proceeds to the default agent.

**CLOSED — What should the user see while routing happens?** Nothing, because
there is no routing step: the question goes straight to the one service. What a
person sees while the *platform* works — a tool being named as it runs — is
§12, and is built. This reopens if a second agent is ever exposed.

**CONFIRMED — the requirement is met, and needed no routing logic.** Jothi's
decision of 2 September (§7) removed the only agent that was a separate
service. Every agent this app exposes is now FabOrchestrator's `/api/chat`, so
there is nothing to choose between: the ask box carries the question into a
conversation and the platform's own agent decides which tools and which data
answer it, over up to twenty steps.

*Verified in a browser against the live platform, 2 September: a question typed
on the landing page with nothing selected is carried into the thread and
answered.*

**CONFIRMED — the tool and data half was always the platform's.** FO's
`/api/chat` loads the caller's authorised MCP tools and lets the model choose
among them (`stopWhen: stepCountIs(20)`, verified against upstream `e5a5abd`).
The app has never needed to reproduce that, and must not.

*The three PROPOSED items above — a visible and reversible route, an
unclear request falling back to the general-purpose agent, and routing never
blocking an answer — are moot with a single destination. They are kept
because they become live again the moment a second service is exposed.*

---

## 6. Manual agent-selection behaviour

**CONFIRMED — Manual selection stays.** Ask-first is the default door, not the
only one. Choosing an agent by name remains a first-class path.

Three reasons, all still true: some flows are entered deliberately rather than
inferred from a sentence; a misrouted request needs a one-tap correction; and an
agent a person is not permitted to use must explain itself on a card rather than
fail inside a conversation.

**PROPOSED — An unavailable agent shows as a disabled card with the reason on
it**, never as a door that opens onto a refusal.

**CONFIRMED — The platform decides permissions, not the app.** Any availability
check the app performs is presentation only. FabOrchestrator's own refusal is
authoritative and its message is shown as sent.

---

## 7. Which FabOrchestrator agents are exposed

**CONFIRMED — The Master Data Load Agent is not part of the PWA.**

*Raised by Yogita; decided by Jothi, 2 September 2026.* Loading MES master data
is not what a supervisor does one-handed on a fab floor. That agent's real
workflow is file upload, staged review and a load step, none of which this app
carries.

**CONFIRMED — It is shown, greyed, not deleted.** FabOrchestrator has the
agent, so the cockpit still lists it, marked as something this app does not
open — the same treatment Workflows, Sites and Reports get. Removing the card
would misrepresent the product as surely as inventing one would.

**This was the most consequential question in this document, and answering it
resolved three of the five recorded conflicts.** With it gone, every exposed
agent shares one service: there is nothing to route between (§5), no
permission-gated agent to check availability for, and no second endpoint for a
classifier to choose.

What is known today, verified against the platform's source (upstream
`e5a5abd`):

| Cockpit card | Platform route | Distinct service? | In the PWA today |
|---|---|---|---|
| AGENT · 01 FabInsight™ | `/chat` | Shared | Exposed |
| AGENT · 02 AI Support Engineer | `/chat` | Shared | Card points at FabInsight's screen |
| AGENT · 03 Master Data Load Agent | `/modeling-agent` | **Yes — its own service and its own permission** | **Shown, greyed, not opened** |
| AGENT · 04 Back-end Agent | `/chat` | Shared | Exposed, own screen and prompts |

**CONFIRMED — Every agent the PWA now opens is one conversation service.**
The Master Data Load Agent was the only separate service, and the only one with a
permission gate. **No agent this app exposes is permission-gated any more**, and
`/api/chat` does not answer 403 itself — so the availability check the plan
budgeted for has nothing left to check. The proxy still relays a 403 verbatim if
FabOrchestrator ever starts sending one.

**OPEN QUESTION — Should the app present three openable cards when all three
are the same service?** It is faithful to how the product presents itself, and
honest about nothing else. If a customer asks "what is the difference between
these three?", today's answer is "the suggested prompts and the label."
Unchanged by Jothi's decision, which was about the fourth card.

**OUT OF SCOPE — Agents that do not exist in FabOrchestrator.** The app never
invents one.

---

## 8. Authentication and logout behaviour

**CONFIRMED — FabOrchestrator is the only identity.** Every person signs in with
their own FabOrchestrator account, which the platform verifies. There is no demo
credential, no shared account and no service account.

*Rationale, agreed: a shared identity would make every prompt in the platform's
audit trail attributable to a machine rather than a person, and hand whoever
holds the link somebody else's data access.*

**CONFIRMED — The platform credential never reaches the phone.** It is held
server-side and is not readable by any script in the browser. *Proven.*

**CONFIRMED — Signing out ends the session on FabOrchestrator itself**, not just
locally, so the platform's own logs record a sign-out. *Proven against the live
platform.* It affects only the session the app was given; other sessions that
person holds are untouched.

**CONFIRMED — Signing out works even when the platform is unreachable.** The
local session always ends; the app reports honestly whether the platform was
told.

**CONFIRMED — An expired or evicted session asks for a fresh sign-in and says
why.** The platform ends sessions after 30 minutes of inactivity — a pocketed
phone reaches that easily — and the app must recover cleanly rather than fail
the same way on every retry.

**PROPOSED — Sign-in returns the user to where they were headed.**

**OPEN QUESTION — Should the app stay signed in between launches, and for how
long?** It currently holds a session for up to 12 hours, capped by the
platform's own expiry. On a shared shop-floor handset that may be too long; for
a single named user it may be too short.

**OUT OF SCOPE — Password reset, registration, SSO.** All belong to
FabOrchestrator.

---

## 9. Conversation behaviour

**CONFIRMED — Answers appear progressively, as they are written.** A question
involving plant data can take one to three minutes; silence followed by a wall of
text reads as a broken app. *Proven through the live hosting chain.*

**CONFIRMED — Follow-up questions keep their context.**

**PROPOSED — A turn can be stopped mid-answer, and what already arrived is
kept.** *Built and proven in a browser against the live platform, 2 September.
Still proposed: nobody outside the engineering work has agreed it.*

**PROPOSED — Tool activity is visible in plain language** — the app says the
platform is looking something up, without exposing internals.

**OPEN QUESTION — Should conversations persist between visits?** Today a thread
lives only as long as the screen is open; closing the app loses it. The platform
has its own conversation history the app does not currently use. Persisting
raises questions about where history lives and who can see it.

**OPEN QUESTION — What should happen to a very long conversation?** The app
sends the whole thread each turn, and FabOrchestrator's route accepts at most
**100 messages of 20,000 characters**.

*Correction, 2 September: version 1.0 of this document said the beginning was
silently lost beyond the cap. That was wrong. Nothing in the app truncates
anything — the thread simply exceeded what the route accepts, and the request
failed with the validation library's own wording, identically on every retry.*

As of 2 September the app stops at the limit, says the conversation is full and
offers a new one, which is a fix to a defect rather than an answer to this
question. **Still undecided:** whether a long conversation should instead drop
its oldest turns, warn before it reaches the limit, or continue to require a
fresh thread. Silently dropping the start of somebody's conversation is a
product decision, not an implementation detail.

**OUT OF SCOPE — Editing or deleting past messages, branching, sharing a
transcript.**

---

## 10. Real MES / MCP data behaviour

**CONFIRMED — The app performs no plant queries of its own.** It has no MES
logic, no SQL and no model call. It passes the question to FabOrchestrator with
the data connections that person is entitled to, and renders what comes back.

**CONFIRMED — The platform routes a question three ways before the model is
called, and only one of them uses the user's data connections.** Verified in
source at upstream `e5a5abd` and measured against the live deployment,
3 September:

| Path | Reached when | Data source |
|---|---|---|
| Metric brief | the question asks for yield, scrap or OEE | **A direct database connection, server-side.** Not MCP |
| Curated dashboard | the question matches one of seven deck prompts | The same direct connection |
| Tool loop | everything else | The caller's MCP connections |

*Correction, 3 September: version 1.2 of this document said the platform only
queries the connections enabled for that user, and that with none enabled it
answers from general knowledge. That is true of the third path only. On the
first two the platform reads the factory database directly, which is why "give
me the yield by product" returns real figures on an account with zero data
connections.*

**CONFIRMED — The app must never present an ungrounded answer as a plant
answer.** An answer from general knowledge shown as a plant answer is worse than
no answer: it looks like a wrong number rather than a missing permission.

*This was PROPOSED and unbuilt. It is now confirmed by a defect: asked for a
dashboard by a user without the dashboard permission, the platform built one and
filled it with figures it labelled "illustrative sample values". Fixed in the
platform — written and tested, not yet deployed — by refusing the request
instead of falling through to the model, and by stating the absence of a data
source on the turn.*

**OPEN QUESTION — Should the PWA lean on the metric path deliberately?** It is
the only route that answers plant questions today without an administrator, so
it is the shortest path to a real demonstration. Doing so means shaping the
demo around the phrasings it recognises, which is a product choice about what
the app promises.

**PROPOSED — Tables must be readable on a phone**, scrolling inside their own
container rather than making the page scroll sideways.

**OPEN QUESTION — What should the app do when a data connection is down?** Two
of the platform's ten connectors were failing at the last recorded check. Say
which one and continue, or refuse the question?

---

## 11. Mobile / PWA requirements

**PROPOSED — Reached by scanning a QR code.** No app store, no IT deployment.

**PROPOSED — Installable to the home screen** on iPhone and Android, opening in
its own window. On iOS this needs an explicit prompt, because Safari offers no
automatic one.

**PROPOSED — Usable one-handed at 360 px**, respecting notch and safe-area
insets.

**PROPOSED — Honest offline behaviour.** The app never claims to be offline when
it is not, and never shows a stale answer as a fresh one.

**OPEN QUESTION — Which devices must be supported?** iPhone and Android are
assumed. Nothing has been said about tablets, ruggedised shop-floor devices, or
minimum OS versions.

**OUT OF SCOPE — A native app, an app-store release, push notifications, camera
or barcode features, offline answering.**

---

## 12. Loading, progress, empty and error states

**CONFIRMED — Every failure produces a distinct, plain-language message with a
next step.** The app fronts a live production platform, so failures are normal
operating conditions, not edge cases. "Something went wrong" sends the user to
find whoever set the demo up.

**CONFIRMED — Every failure carries a reference support can trace.** The
platform issues an error id; it is kept and shown, because it is the only handle
support has.

**CONFIRMED — Platform messages are relayed as sent** where they are actionable
— a permission refusal names the permission an administrator must grant.

**PROPOSED — Distinct states for waiting, working and answering**, so a long
tool call does not look like a hang.

**PROPOSED — Empty states say what to do**, not merely that there is nothing.

**OPEN QUESTION — Should the app retry automatically on a transient failure, or
always ask?**

---

## 13. Security and product constraints

**CONFIRMED — Every question is attributable to a real person**, carrying that
person's permissions, data access, usage limits and audit record.

**CONFIRMED — No permission decision can be influenced by anything the phone
sends.** Which data connections and which model are used are decided
server-side; the platform then checks again independently.

**CONFIRMED — The platform credential is never in client JavaScript, local
storage, a readable cookie, a log line or a cached file.**

**CONFIRMED — Generated dashboards are isolated** from the app and its
credentials.

**CONFIRMED — No changes to FabOrchestrator are required** for the app to work.

**PROPOSED — The app holds no plant data at rest.** It renders answers and
forgets them.

---

## 14. Out of scope

- **OUT OF SCOPE — The production-order review workflow** and its mock MES data.
  *Removed 1 September 2026; decision recorded in the delivery plan.*
- **OUT OF SCOPE — Any AI, prompt, model or manufacturing logic in the app.**
- **OUT OF SCOPE — Administration of any kind.**
- **OUT OF SCOPE — Writing to MES, ERP or quality systems.**
- **OUT OF SCOPE — Barcode scanning, offline answering, push notifications,
  native apps.**
- **OUT OF SCOPE — Opening FabOrchestrator screens the app does not implement**
  (Workflows, Sites, Reports). They are shown greyed, not linked.

---

## 15. Acceptance criteria

The product is right when all of these are true and demonstrable.

**CONFIRMED — already met**

1. A person signs in with their own FabOrchestrator account and reaches the
   landing page.
2. A question is answered, and the answer appears progressively rather than all
   at once.
3. Follow-up questions keep their context.
4. The platform credential is provably absent from the phone.
5. Signing out ends the session on the platform as well as locally.
6. The app contains no plant logic, data queries or AI reasoning of its own.
7. A question asked from the landing page **with nothing selected** is answered.
   *Met 2 September, and without routing logic: after §7 there is a single
   destination. The "labelled with which agent served it" clause is moot while
   that remains true, and returns with a second agent.*
8. Every agent the app opens is reachable by name and opens a conversation; an
   agent the app does not open says so on its card.

**PROPOSED — not yet met**

8. Every agent is reachable by name, and either opens a conversation or explains
   on its card why it cannot.
9. The app installs to a home screen on iPhone and Android from a QR code.
10. A metric question returns figures drawn from live plant data, readable on a
    phone.
11. A dashboard request renders full-screen and is proven isolated.
12. Every identified failure produces its own message, next step and reference.
13. A user with no data connections is told so explicitly, rather than given a
    general-knowledge answer.

---

## 16. Dependencies and blockers

**BLOCKER — The demonstration account has no MCP data connections.** Verified 1
September: zero connected, zero visible.

*Narrowed 3 September.* This blocks the **tool path only**. Metric questions —
yield, scrap, OEE — are answered from real plant data today on this account,
through a direct database connection that does not use MCP at all. What stays
blocked is every other plant question: WIP, lots on hold, equipment status,
throughput, downtime. Cleared by a FabOrchestrator administrator assigning MCP
connections to that account's role.

**DEPENDENCY — Physical devices.** One iPhone and one Android handset are needed
to accept criterion 9. iOS install behaviour cannot be verified any other way.

**DEPENDENCY — A reachable deployment** for anything demonstrated from a URL
rather than a laptop.

**BLOCKER — The platform fixes are not deployed.** The two data-integrity
defects found on 3 September are fixed on a branch in the FabOrchestrator
repository, with 21 tests, a clean typecheck and a clean lint — but that
repository belongs to another team and the branch is neither pushed nor
released. Until it is, a demonstration can still produce an invented
dashboard.

**NOT A BLOCKER — A database.** Previously believed necessary for revocable
sessions; resolved without one.

---

## 17. Confirmed decisions

Recorded so they are not silently reopened.

| # | Decision | When |
|---|---|---|
| 1 | A user can ask from the landing page without choosing an agent; the system routes it | 1 Sep 2026, Jothi |
| 2 | Manual agent selection remains, alongside ask-first | 1 Sep 2026 |
| 3 | FabOrchestrator is the only identity; the demo credential is removed | 1 Sep 2026 |
| 4 | The production-order workflow is removed; the app is only a front door | 1 Sep 2026 |
| 5 | The navigation mirrors the platform's cockpit; unopenable sections are greyed, not invented | 1 Sep 2026 |
| 6 | Sign-out ends the platform session, not just the local one | 1 Sep 2026 |
| 7 | The demonstration runs against the live deployment | 1 Sep 2026 |
| 8 | The app makes no changes to FabOrchestrator | Throughout |
| 9 | **The Master Data Load Agent is not part of the PWA**; its card is shown greyed | 2 Sep 2026, Jothi |

---

## 18. Conflicts between current plans/code and product decisions

Recorded rather than resolved. **Each needs a product decision.**

**Three of the five closed on 2 September**, when Jothi answered the agent
question in §7. They are kept, struck through in effect, because the reasoning
that closed them is the reasoning anyone reopening the question will need.

### 18.1 The ask box implies routing that does not exist — RESOLVED

*Stood 1 September; resolved 2 September.*

The landing page carries an ask box reading *"Ask anything, or describe a task to
orchestrate…"*, and it sends every question to FabInsight. That was recorded as
a promise the interface made and the product did not keep.

**It was too strong.** Two things called "routing" were being conflated. FO's
own `/api/chat` is a tool-using agent that decides, per question, which of the
caller's authorised MCP tools and data sources to call, over up to twenty steps.
The box always delivered *that* — which is most of what confirmed decision 1
asks for. What it could not do was reach a *different agent*.

After §7 there is no different agent. The box does everything the requirement
states, with no routing logic, and §5 records it as met.

### 18.2 The open agent question may remove the need for routing entirely — RESOLVED

*Stood 1 September; resolved 2 September, exactly as this entry predicted.*

The reasoning was: three of the four cockpit cards are the same conversation
service, so the routing decision is in practice *"is this a master-data request
or not?"*, and excluding the Master Data Load Agent would leave nothing to route
between.

**Jothi excluded it.** Every exposed agent now shares one service. The
engineering plan's 2 days for a routing package buys nothing and should not be
scheduled. This entry is the reason that estimate was held rather than spent.

### 18.3 The plans still assume four agents — OPEN, AND NOW ACTIONABLE

*Stood 1 September; became actionable 2 September.*

The four planning documents in `docs/planning/` describe exposing FabInsight, the
Master Data Load Agent and the Back-end Agent, and budget WP7's availability
check and WP13's routing package. All three assumptions are now wrong:

- the Master Data Load Agent is not exposed;
- **no exposed agent is permission-gated**, so WP7's availability query has
  nothing to check;
- WP13's routing has nothing to choose between.

They said they needed updating once §7 was answered, and not before. It is
answered. **This is the one conflict here that is a live piece of work**, and it
is documentation, not code.

### 18.4 Placeholder metrics presented as real — OPEN

The landing page shows counters from the product's own cockpit as though they
were live figures. This is a factual claim the app cannot support. It conflicts
with the honesty principle applied elsewhere — greyed navigation, and now a
greyed agent card. See the open question in §4.

Note that the greyed Master Data Load Agent card still carries its placeholder
metric ("Sites 12"), which is the product's own number for an agent this app does
not open. That is the same question, in its sharpest form.

### 18.5 An installed-app identifier points at a removed screen — OPEN, DELIBERATE

The app's install identifier still refers to the removed order workflow. It is
invisible to users and changing it would orphan every installed copy, so it was
deliberately left. Recorded so it is not mistaken for an oversight.

---

## 19. Open product questions

**Answered**

- ~~Which FabOrchestrator agents should the PWA expose?~~ **Answered by Jothi,
  2 September: not the Master Data Load Agent.** See §7 and decision 9.
- ~~What should the user see while a question is being routed?~~ **Closed:**
  there is no routing step. See §5.

**For Jothi**

1. Should the app present **three openable agent cards when all three are the
   same service**? *(§7)*
2. Should the landing page's **activity counters** be made live, labelled as
   illustrative, or removed — including the metric on the greyed Master Data
   Load Agent card? *(§4, §18.4)*
3. Should **conversations persist** between visits? *(§9)*
4. What should happen to a **very long conversation** — drop the oldest turns,
   warn before the limit, or continue to require a fresh thread? *(§9)*
5. Should the app **stay signed in between launches**, and for how long? *(§8)*
6. What should happen when a **data connection is down** — name it and continue,
   or refuse? *(§10)*
7. Should transient failures **retry automatically**? *(§12)*
8. Is the **first audience a supervisor or a demonstration**? Several choices
   above depend on it. *(§2)*
9. Which **devices** must be supported? *(§11)*

5. Should the **metric path be leaned on deliberately** for the demonstration?
   It is the only route that answers plant questions without an administrator.
   *(§10)*
6. Should the demonstration account be made a **dashboard administrator**, or
   should dashboards stay out of the PWA's demo? Without the permission a
   dashboard request is now refused — correct, but it is a visible "no".
   *(§10)*
7. **Who ships the FabOrchestrator fix?** It is written and tested but sits in
   another team's repository. *(§16)*

**For an administrator, not a product question**

- The demonstration account has **no data connections**, so plant questions are
  answered from general knowledge. This blocks acceptance criteria 10 and 13 and
  the whole of the business demonstration. *(§16)*

---

## Related documents

| Document | Answers |
|---|---|
| `docs/planning/` | How we build it, in what order, and what it costs |
| `docs/STATUS.md` | Where we have got to, and what is proven |
| `CLAUDE.md` | Why the code is the way it is |
| This file | What we are building and how it should behave |
