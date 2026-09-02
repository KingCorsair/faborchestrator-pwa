# FabOrchestrator PWA — Product Requirements

**Version 1.0 · 1 September 2026**

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

**PROPOSED — It names the platform's wider capabilities without pretending to
offer them.** Master-data loading, generated dashboards, roles and access
control, usage and cost tracking, the audit trail. These are stated as facts
about FabOrchestrator and are **not links** — the app does not open them.

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

**OPEN QUESTION — What should the user see while routing happens?** Nothing, a
generic "working", or the choice as it is made? This is the first impression of
the product's intelligence and has not been decided.

> ⚠ **Conflict — see §18.1.** The ask box exists today but always sends to
> FabInsight. The routing behaviour is confirmed but not built.

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

**OPEN QUESTION — Which FO agents should the PWA actually expose, and therefore
which agents may the landing-page router choose from?**

*Raised by Yogita.* Not every FabOrchestrator agent necessarily belongs in a
mobile app — in particular the **Master Data Load Agent**, depending on the
intended user and data workflow. A supervisor on a fab floor is not obviously the
person who loads MES master data, and that agent's real workflow involves file
upload and staged review.

**This is the most consequential open question in this document.** It decides
what the landing page shows, what manual selection offers, and — because of the
conflict in §18.2 — whether routing has anything to choose between at all.

What is known today, verified against the platform's source (upstream
`e5a5abd`):

| Cockpit card | Platform route | Distinct service? | In the PWA today |
|---|---|---|---|
| AGENT · 01 FabInsight™ | `/chat` | Shared | Exposed |
| AGENT · 02 AI Support Engineer | `/chat` | Shared | Card points at FabInsight's screen |
| AGENT · 03 Master Data Load Agent | `/modeling-agent` | **Yes — its own service and its own permission** | Exposed |
| AGENT · 04 Back-end Agent | `/chat` | Shared | Exposed, own screen and prompts |

**CONFIRMED — Three of the four cards are framings of one conversation
service.** Only the Master Data Load Agent is a separate service with its own
permission gate, which FabOrchestrator enforces itself.

**OPEN QUESTION — Should the app present four cards when three are the same
service?** It is faithful to how the product presents itself, and honest about
nothing else. If a customer asks "what is the difference between these three?",
today's answer is "the suggested prompts and the label."

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
kept.**

**PROPOSED — Tool activity is visible in plain language** — the app says the
platform is looking something up, without exposing internals.

**OPEN QUESTION — Should conversations persist between visits?** Today a thread
lives only as long as the screen is open; closing the app loses it. The platform
has its own conversation history the app does not currently use. Persisting
raises questions about where history lives and who can see it.

**OPEN QUESTION — What happens to a very long conversation?** The app sends the
whole thread each turn, with a cap. Beyond it, the beginning is silently lost.
Silent truncation, an explicit warning, or a fresh thread?

**OUT OF SCOPE — Editing or deleting past messages, branching, sharing a
transcript.**

---

## 10. Real MES / MCP data behaviour

**CONFIRMED — The app performs no plant queries of its own.** It has no MES
logic, no SQL and no model call. It passes the question to FabOrchestrator with
the data connections that person is entitled to, and renders what comes back.

**CONFIRMED — The platform only queries the data connections explicitly enabled
for that user.** With none enabled it still answers, from general knowledge.

**PROPOSED — The app must detect that state and say so.** An answer from general
knowledge presented as a plant answer is worse than no answer: it looks like a
wrong number rather than a missing permission. *Not yet built.*

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

**CONFIRMED — not yet met**

7. A question asked from the landing page **with nothing selected** is routed to
   the right agent and answered, labelled with which agent served it.

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

**BLOCKER — The demonstration account has no data connections.** Verified 1
September: zero connected, zero visible. Plant questions are answered from
general knowledge. **Blocks acceptance criteria 10 and 13 entirely** — the
criteria the business case rests on. Cleared by a FabOrchestrator administrator
assigning MCP connections to that account's role. *Nothing in engineering can
work around this.*

**DEPENDENCY — Physical devices.** One iPhone and one Android handset are needed
to accept criterion 9. iOS install behaviour cannot be verified any other way.

**DEPENDENCY — A reachable deployment** for anything demonstrated from a URL
rather than a laptop.

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

---

## 18. Conflicts between current plans/code and product decisions

Recorded rather than resolved. **Each needs a product decision.**

### 18.1 The ask box implies routing that does not exist

The landing page already carries an ask box reading *"Ask anything, or describe
a task to orchestrate…"*, but it sends every question to FabInsight regardless of
content. Confirmed decision 1 is therefore **stated in the interface and not yet
true**. Anyone demonstrating the app today would be showing behaviour the product
does not have. Either the routing is built, or the box should not promise it.

### 18.2 The open agent question may remove the need for routing entirely

**This is the important one.** Three of the four cockpit cards are the same
conversation service; only the Master Data Load Agent is separate. So the
routing decision confirmed in §5 is, in practice, *"is this a master-data request
or not?"*

If Yogita's question (§7) resolves to **excluding** the Master Data Load Agent
from the PWA, then every exposed agent shares one service and **there is nothing
left to route between**. The confirmed requirement would be satisfied by sending
every question to the one service — no routing logic at all.

The engineering plan currently budgets 2 days for a routing package. **That
estimate depends entirely on an unanswered product question.** It should not be
scheduled until §7 is answered.

### 18.3 The plans still assume four agents

The engineering plans describe exposing FabInsight, the Master Data Load Agent
and the Back-end Agent, with an open item about the AI Support Engineer card.
They were written before Yogita's question and do not treat agent exposure as
undecided. They need updating once §7 is answered — not before.

### 18.4 Placeholder metrics presented as real

The landing page shows counters from the product's own cockpit as though they
were live figures. This is a factual claim the app cannot support. It conflicts
with the honesty principle applied elsewhere — greyed navigation, explicit
unavailability. See the open question in §4.

### 18.5 An installed-app identifier points at a removed screen

The app's install identifier still refers to the removed order workflow. It is
invisible to users and changing it would orphan every installed copy, so it was
deliberately left. Recorded so it is not mistaken for an oversight.

---

## 19. Open product questions

**For Yogita**

1. **Which FabOrchestrator agents should the PWA expose** — and therefore which
   agents may the landing-page router choose from? In particular, does the
   **Master Data Load Agent** belong in a mobile app, given the intended user and
   data workflow? *(§7 — and note §18.2: the answer may remove the need for
   routing entirely.)*

**For Jothi**

2. Should the app present **four agent cards when three are the same service**?
   *(§7)*
3. Should the landing page's **activity counters** be made live, labelled as
   illustrative, or removed? *(§4, §18.4)*
4. Should **conversations persist** between visits? *(§9)*
5. What should happen to a **very long conversation** — silent truncation, a
   warning, or a fresh thread? *(§9)*
6. What should the user **see while a question is being routed**? *(§5)*
7. Should the app **stay signed in between launches**, and for how long? *(§8)*
8. What should happen when a **data connection is down** — name it and continue,
   or refuse? *(§10)*
9. Should transient failures **retry automatically**? *(§12)*
10. Is the **first audience a supervisor or a demonstration**? Several choices
    above depend on it. *(§2)*
11. Which **devices** must be supported? *(§11)*

---

## Related documents

| Document | Answers |
|---|---|
| `docs/planning/` | How we build it, in what order, and what it costs |
| `docs/STATUS.md` | Where we have got to, and what is proven |
| `CLAUDE.md` | Why the code is the way it is |
| This file | What we are building and how it should behave |
