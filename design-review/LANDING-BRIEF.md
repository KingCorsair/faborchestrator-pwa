# Design brief — the landing page

**For:** Claude Design (or any designer with no access to this repo).
**Question to answer:** what should `/` look like, given that people arrive here
for several different reasons?
**Written:** 2026-08-20. Everything below is self-contained — you do not need the
codebase.

---

## 1. What the product is

**FabOrchestrator — Production Order Assistant.** A progressive web app for a
shop-floor supervisor in a factory.

One story, end to end:

> A production order has a problem → the system detects it from MES
> (Manufacturing Execution System) data → an AI explains it, citing the exact
> records → a human approves, rejects or escalates → the decision is recorded.

The architectural promise the whole product rests on, and the thing the design
must never undercut:

- MES data provides **facts**. Deterministic rules detect problems and assign
  severity. The **LLM only explains and recommends**. A **human always decides**.
- **Every claim the AI makes is cited by record ID** — `EVT-2231`, `DEF-0417` —
  and each citation is validated against the source data before it is shown.
  Analyses that pass wear a **"Grounded in MES data"** badge. Ones that fail are
  shown anyway, without the badge, with the bad citations struck through.
- **No AI confidence scores anywhere.** Severity comes from the rules.

It has four working sections: **Orders** (search or scan an order, see detected
problems, ask for an analysis), **Decisions** (what decision stands on each
order, with override), **Activity** (the audit trail), and a hidden
`/diagnostics` page.

**Current status: it is a demo**, running on mock data, shared with colleagues
and stakeholders by QR code and by link. It is not yet in a factory.

---

## 2. Who arrives, and why — the actual brief

The prompt for this work was: *"there could be many different reasons why someone
might want to visit this site and we should be able to cater to all of that."*
That is correct. But the segmentation that matters here is **not job title** —
see §3 — it is **arrival context**. Five of them:

| # | Who | How they got here | What they need in the first 5 seconds | What they must not be made to do |
|---|---|---|---|---|
| 1 | **The evaluator** — a colleague or stakeholder sent a QR code or a link, has never seen this before | Phone, cold, no session, possibly standing in a corridor | *What is this? Is it real? Show me the good bit.* | Read a pitch and then guess which of four sections proves the point |
| 2 | **The demo driver** — the person who built it, opening it to show someone | Laptop, signed in, has seen this screen 200 times | One tap to the scenario order | Re-read the value proposition |
| 3 | **The supervisor** — the actual intended user, chasing a live problem | Shop floor, phone or tablet, possibly gloved, glare | Straight to the order list and the scanner | Anything at all before the work |
| 4 | **The reviewer** — checking what was decided on an order an hour ago, or auditing the trail | Desk, signed in | The Decisions or Activity section, named in words they would use | Hunt through Orders to find a decision record |
| 5 | **The installer** — arrived on iOS via QR and should add it to the home screen | Safari on iPhone | A hint that this installs, at the bottom of the screen where the Share button is | Find "Add to Home Screen" unaided, two taps into a sheet of twenty options |

Note that **1 and 2 are the dominant traffic today** and 3 is hypothetical — this
is a demo. A landing page optimised only for the supervisor would be optimised
for the visitor who does not yet exist.

---

## 3. ⚠ The research finding that constrains the answer

The obvious way to "cater to different reasons for visiting" is an audience
switcher — *I'm a supervisor / I'm a manager / I'm an auditor*. **Do not do
that.** Nielsen Norman Group gives five reasons against audience-based
navigation, and four of them apply directly here:

1. **People cannot quickly self-identify.** A shift lead who also signs off
   overrides is two of your three categories.
2. **Users are task-oriented, not identity-oriented.** Forcing self-selection
   "takes people out of their task mindset."
3. **Information anxiety** — people wonder what the other groups get that they
   do not, and click around to check.
4. **Content duplication** — every section here is reachable by every role, so
   the categories would overlap almost completely.

NN/g's recommendation is explicit: **prioritise topics and tasks over audience
categories**; audience segmentation belongs in *secondary* navigation if
anywhere. Audience-based navigation only earns its place when the content is
genuinely unique per group — which here it is not, because there is one
credential and no roles at all.

**So: doors labelled by task, not by person.** "Read the audit trail", never
"For auditors."

---

## 4. Research findings that should shape the page

Sources listed at the end.

- **The five-second test.** A visitor should understand *what this does, who it
  is for, and what to do next* within five seconds. Applies doubly to arrival
  context 1, who is standing up holding a phone.
- **Proof must come early, not after six feature blocks.** For a demo, the
  strongest proof is not a testimonial or a metric — it is *the thing itself*.
  "A demo is closer to firsthand evidence; it reduces the imagination burden."
- **Outcome-driven over feature-driven.** Say what changes for the person, not
  what modules exist.
- **A single clear primary action**, with secondary paths visibly secondary.
  Competing equal-weight CTAs is the most common failure mode.
- **Progressive disclosure**: orient the newcomer *without* taxing the expert.
  The published benchmark is that an experienced user should still reach what
  they came for in **≤3 interactions from the home screen** — ideally one.
- **Shop-floor UI reality** (for contexts 3 and 5): industrial guidance is
  **60px+ touch targets** for gloved hands with generous spacing, **no
  hover-dependent interactions**, and high contrast validated under real plant
  lighting and glare. This app currently uses a 44px minimum on touch devices —
  fine for a phone in an office, arguably light for a glove.

---

## 5. Hard constraints — these are not negotiable

**a. Nothing on this page may state a fact about the factory that does not
resolve to a real MES record.** No metric tiles, no "40% less downtime", no
"trusted by", no invented statistics. This is the entrance to a product whose
entire argument is that every number traces to a record ID; a landing page
carrying invented numbers would be the only screen in the app that lies.
*Controls* are fine — a link to a section that exists, with one line about what
you would do there, asserts nothing. That distinction is the line to design
against.

**b. It must render for someone who has never signed in, on a cold cache.**
Today `/` ships zero JavaScript and prerenders as static. Any design that
branches on "are you signed in?" gives that up. That may well be worth it — but
it is a trade to make deliberately, not by accident. Say so in your rationale if
your design requires it.

**c. Design language: FabOrchestrator V2 / "Fab Blue".** Rounded, lifted, airy.
White cards with soft shadows — **never** hairline-bordered square boxes.

```
Typeface   Plus Jakarta Sans (headings 800 weight, tight, -0.015em)
Indigo     --brand-indigo    #5b54e8      (primary gradient start)
           --cockpit-indigo  #4842d4      (gradient end, 135deg)
           --brand-indigo-bg #edecfd      (icon tiles, soft fills)
Navy       --navy-3          #10153a
Surface    --page-surface    #f6f7fc      (the page)
           --pure-white      #fff         (cards)
           --border-light    #e7e9f4
Ink        --text-ink        #161c34
           --text-muted-cool #5d6680
           --text-subtle     #667090
Status     green #1fa971 · amber #d6841f · red #dc2626
Radius     card 22px · panel 16px · control 12px · chip 9px
Shadow     card    0 2px 8px rgba(16,21,58,.05), 0 1px 2px rgba(16,21,58,.04)
           lifted  0 8px 24px rgba(16,21,58,.09)
           hero    0 24px 60px rgba(16,21,58,.16)
           brand   0 8px 20px rgba(91,84,232,.34)
```

**d. The type scale is seven steps and there is no eighth.**
`10px` (uppercase eyebrows, .14em tracking) · `12px` (meta, record IDs, pills) ·
`14px` (body) · `16px` (card titles) · `20px` (section headings) · `26px` (the
page h1) · `30px` (the one number a screen is about). A previous version of this
app used nineteen sizes, eight of them half a pixel apart. Do not reintroduce
that.

**e. Weight is for contrast, not for everything.** Meta lines and running text
are 400. Headings, pills, buttons and eyebrows carry weight. A screen where
everything is semibold reads as a cramped internal dashboard.

**f. Status is never carried by colour alone** — every status dot renders its
word beside it. A supervisor reading through safety glasses is exactly who a
colour-only signal fails.

**g. No chatbot interface, no decorative AI styling, no gradients used as an
"AI" signal.** The AI is secondary to the manufacturing workflow. Specific
manufacturing value beats impressive-looking generic AI.

**h. Accessibility is held to AA on real measured ratios**, including text on the
indigo gradient. Pure white on `--brand-indigo` is 5.4:1; a tinted white at 85%
would read as hierarchy while failing AA. Carry hierarchy with size and case
instead.

---

## 6. What is there today

A 560px centred column on the page surface:

1. **Identity card** — white, radius 22, the big `0 24px 60px` lift. Contains the
   brand lockup (indigo rounded-square mark + "FabOrchestrator" over "ATHENATEC"
   in 10px tracked caps), an `h1` at 26px reading **"Production Order
   Assistant"**, and one 16px sentence: *"Review production orders, investigate
   detected issues, and make supervisor decisions using MES evidence and
   AI-assisted analysis."*
2. **Three "doors"** — full-width rows, stacked, each an icon tile + title + one
   line + a right chevron:
   - **Review production orders** (primary: indigo gradient, white text, a
     `START HERE` eyebrow) → the order list
   - **Check what stands on an order** (white card) → decisions
   - **Read the audit trail** (white card) → activity

   Order, icons and destinations deliberately match the app's top nav, so
   somebody who entered by the second door recognises the pill that returns them.
3. **A footer line** — "Demo environment · mock MES data", plus a sign-out link
   that renders only when there is a session.

**What it gets right:** the doors are task-labelled, not audience-labelled (§3).
It invents nothing (§5a). It is on-language.

**What is arguably missing — this is the actual design question:**

- Arrival context **1** (the stranger with a QR code) gets one abstract sentence
  and then three doors that all assume they already know what a production order
  exception is. There is **no proof, no picture, no "show me"** — the strongest
  asset this demo has is that it genuinely works on a real-looking order, and the
  front door does not use it.
- Nothing distinguishes "I have never seen this" from "I open this daily." Both
  get the identical screen.
- The three doors are the **app's own sections**, an information architecture
  inherited from the nav — not necessarily the set of *reasons a person came*.
- Nothing on the page mentions that it installs to a home screen, which for a PWA
  demo is a substantial part of the point.

---

## 7. What we would like from you

Not a single answer — **two or three distinct directions**, with the reasoning
visible, so we can choose between them. For each:

1. A full-page layout at **390px (phone)** and **1180px (desktop)**. The phone is
   the primary case: this demo is handed over by QR code and opened on a phone
   more often than on a laptop.
2. Where the **"show me it working"** proof goes, if you include one, and what
   form it takes given constraint **5a** — remembering that the single most
   compelling real artifact available is order **`PO-10382`**: 620 units made of
   1000 against 750 expected, 42 minutes of downtime on machine ASM-04, a 9%
   defect rate against a 2% baseline, three rules fired, one grounded AI
   analysis. All of that is real data in the demo, citable by record ID.
3. How the newcomer is oriented **without** slowing the returning user to more
   than one tap (§4, progressive disclosure).
4. Whether the doors stay three, and whether they stay the app's four sections or
   become something closer to the reasons in §2.
5. Whether anything on the page should mention installing it.

**Specific questions we are stuck on:**

- Should the page **change** depending on whether you are signed in? It costs the
  static render (§5b). Is orientation for strangers worth that?
- Is a **screenshot or an inline preview** of a real analysis appropriate here, or
  does showing the product's output on the front door read as marketing?
- Is **three doors the right number**, or does a single strong primary path with
  the other two demoted (a small text row, say) test better against the "single
  clear CTA" finding in §4?
- Does the identity card earn its space on a 390px screen, or is it ceremony that
  pushes the first door below the fold?

---

## 8. Sources

- Nielsen Norman Group — *Audience-Based Navigation: 5 Reasons to Avoid It*
  https://www.nngroup.com/articles/audience-based-navigation/
- Nielsen Norman Group — *113 Design Guidelines for Homepage Usability*
  https://www.nngroup.com/articles/113-design-guidelines-homepage-usability/
- Genesys Growth — *Best Practices for Designing B2B SaaS Landing Pages (2026)*
  https://genesysgrowth.com/blog/designing-b2b-saas-landing-pages
- Genesys Growth — *Designing Persona-Based Landing Pages*
  https://genesysgrowth.com/blog/designing-persona-based-landing-pages
- Mightybytes — *Designing for Multiple Audiences*
  https://www.mightybytes.com/insights/how-to-design-site-for-multiple-audiences/
- UXPin — *What Is Progressive Disclosure in UX?*
  https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/
- Aufait UX — *Manufacturing UX Design*
  https://www.aufaitux.com/blog/manufacturing-ux-design/
- Aufait UX — *HMI Design Best Practices*
  https://www.aufaitux.com/blog/hmi-design-best-practices/
- Fuselab Creative — *Manufacturing Dashboard Design Guide for Industrial UX Teams*
  https://fuselabcreative.com/manufacturing-dashboard-ux-design/
- Webflow — *Landing page design: 8 essential elements*
  https://webflow.com/blog/landing-page-design
