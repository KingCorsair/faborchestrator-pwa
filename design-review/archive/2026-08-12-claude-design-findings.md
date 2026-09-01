# Handoff: FabOrchestrator V2 — design review implementation

## Overview

This is not a new feature. It is a list of **14 corrections** to the four existing
FabOrchestrator PWA screens (order search, order detail, decisions, activity),
produced from a design review of the static export in `reference/`.

The single most important screen is **order detail**. Nine of the fourteen
findings are on it, and two of those are blocking.

## About the design files

The HTML in `reference/` is **the app's own static export** — real components, the
real compiled stylesheet, real seeded data — not a mockup and not a target. It is
included so you can see the *current* state and locate the markup each finding
refers to. **Do not copy anything out of it into the app.** Every change below is
made in the real source (`claudeai_athena/`), in the existing React components and
in `app/globals.css`.

There is nothing to recreate here. This is a patch list.

## Fidelity

**High-fidelity, and constrained.** Every change names an existing token, an
existing Tailwind class, or a specific DOM move. Colour values given below are
final and were computed, not eyeballed.

## Hard constraints — a change that breaks one of these is wrong

From the product brief, reproduced because they bound every task below:

1. The app must remain recognisably **FabOrchestrator V2 / Fab Blue**. No new
   palette, no new type pairing, no flatter or squarer direction. Work within the
   tokens in `app/globals.css` (the V2 block, around lines 194–244).
2. **Status is never carried by colour alone** — every pill renders its word beside
   its dot, and the dot stays `aria-hidden`.
3. **Numerals are tabular, not monospace.** There is no mono face in V2.
   `font-variant-numeric: tabular-nums` in Plus Jakarta only.
4. **No chatbot styling.** No glow, no gradient mesh, no avatar, no bubbles. The
   single sparkle icon marking AI-authored content stays, and stays minimal.
5. **The AI never appears to act.** It explains and recommends; the human decides.
6. **Evidence stays next to the claim.** No citation may move behind a tooltip, a
   drawer or a "details" affordance. Several tasks below reduce the *space* the
   citations take; none removes a citation from the screen.
7. **Touch targets ≥ 44px** on `(pointer: coarse), (hover: none)`. Desktop density
   stays tighter deliberately.
8. **No new dependencies.** Lucide and Tailwind only.

---

## Task list

Ordered by effect per unit of change. Ids match the review document, so
"F-05 is done" is unambiguous.

### F-01 — Blocking. The same instant prints three different ways

**Where:** the citation renderer (the component that draws `id · field · value`
rows), the MES record rows, and the prompt builder that hands MES data to the model.

**Problem.** On order detail, the same event is shown as:

| Source | Rendering |
|---|---|
| AI prose | "the feeder jam occurred at **09:12**" |
| Its citation | `2026-08-10T09:12:00.000Z` |
| MES record row below | `EVT-2231 startedAt` **10 Aug, 02:12** |

The due date likewise reads `Due 10 Aug, 13:00` in the header card, "the 20:00 due
date" in the AI text, and `2026-08-10T20:00:00.000Z` in the citation. Record rows
are formatted local, citation values are raw ISO, and the model was given UTC.

This is the worst defect on the screen: the product's core promise (constraint 6)
is that a supervisor can check the AI against the record beneath it. Today those
two numbers disagree.

**Change.**
1. Detect ISO-8601 values in the citation renderer and pass them through the same
   formatter the MES record rows use, so a citation reads `10 Aug, 09:12`.
   Keep `tabular-nums`.
2. Give the model site-local times, not UTC, in the prompt payload.
3. Print the site timezone once, in the header card meta row, next to
   `MockMESAdapter · as of 10 Aug, 07:00`.

**Acceptance.** On order detail, every rendering of EVT-2231's start reads the same
string. No `T` or `Z` appears anywhere on the screen.

**Bonus.** This also removes the only monospace-looking text on a screen whose type
system has no mono face (constraint 3).

---

### F-02 — Blocking. Pill text fails the constraint that put the pills there

**Where:** `app/globals.css` V2 token block; the status pill component; anywhere
`--text-subtle` is used as text.

**Problem.** The dot-plus-word structure is correct and answers the colour-blindness
half of constraint 2. But the word is set in the status hue on the status tint, and
at 12px those pairs fail WCAG AA — the glare-and-safety-glasses half of the same
constraint. Measured:

| Pair | Now | Needs |
|---|---|---|
| `--status-amber` on `--status-amber-bg` (MEDIUM, and the in-memory banner) | 2.68:1 | 4.5 |
| `--status-green` on `--status-green-bg` (Completed, Approved) | 2.72:1 | 4.5 |
| `--status-idle` on `--status-idle-bg` (On hold) | 2.75:1 | 4.5 |
| `--status-red` on `--status-red-bg` (HIGH) | 4.41:1 | 4.5 |
| `--cockpit-indigo` on `--brand-indigo-bg` (In progress) | 5.99:1 | passes |
| `--text-subtle` on `--pure-white` | 3.04:1 | 4.5 |
| `--text-subtle` on `--page-surface` | 2.85:1 | 4.5 |

`--text-subtle` is not incidental: it carries every EVIDENCE eyebrow, every field
name beside every citation, and every meta line in the app.

**Change.** Add four ink steps and darken one existing token
(`patches/tokens.css` has the block ready to paste):

```css
--status-green-ink: #0f7a52;  /* 4.83:1 on --status-green-bg */
--status-amber-ink: #97600f;  /* 4.82:1 on --status-amber-bg */
--status-red-ink:   #b91c1c;  /* 5.91:1 on --status-red-bg   */
--status-idle-ink:  #616b8b;  /* 4.77:1 on --status-idle-bg  */
--text-subtle:      #667090;  /* was #8b93b0 — 4.90 on white, 4.58 on surface */
```

Use the ink token for pill **text only**. The dot keeps `--status-green`,
`--status-amber`, `--status-red`, `--status-idle`, so the colour on screen is
unchanged — only the word darkens. Apply the same amber ink to the in-memory
banner's text; leave its band alone.

Then: severity pills (`HIGH` / `MEDIUM`) to 13px inside the existing
`(pointer: coarse), (hover: none)` block only. Desktop stays 12px.

**Acceptance.** Every pill and every `--text-subtle` string measures ≥ 4.5:1
against its own background. No dot colour changed. No pill lost its word.

---

### F-03 — The decision is asked for before the proof

**Where:** the order detail screen component.

**Problem.** Intended reading order is order → problem → AI → **records** →
decision. The DOM order is order → problems → AI → **decision** → records: the
decision card sits 16px above the section holding the evidence it rests on.

Worse, the decision card is the third child of the `<section>` headed *AI analysis*.
In the document outline the human's decision is nested inside the AI's panel — the
wrong relationship under constraint 5, and a screen reader announces it.

**Change.** Lift the decision card out into its own `<section>` with a
*Your decision* eyebrow matching the other three, and place the MES records section
above it.

**Acceptance.** Four sibling sections in this order: detected problems, AI analysis,
MES records, your decision. The decision card is not a descendant of the AI section.

---

### F-07 — One spacing level for three relationships

**Where:** order detail page wrapper and section headings.

**Problem.** Inside a card, between cards, and between sections are all 12–16px, so
the three sections read as one undifferentiated stack. Four points of difference is
invisible. The padding itself (`p-5`, 20px) is right for a scan-and-go screen and
should not change.

**Change.**

| Relationship | Now | Target |
|---|---|---|
| Inside a card | 12px | 12px (unchanged) |
| Card to card | 12px | 12px (unchanged) |
| Section to section | 16px | **28px** |

Also take the section eyebrows (*Detected problems*, *AI analysis*, *MES records*)
from 10px `--text-subtle` to 12px `--text-muted-cool`, so they read as the chapters
of the screen rather than as card captions.

**Acceptance.** The page wrapper gap is 28px; the gap inside each section is
unchanged. Cheapest change in this document and the largest single improvement to
"does this read as a product".

---

### F-04 — The reading cap is on one paragraph of six

**Where:** `--measure` in the V2 token block; the prose containers on order detail.

**Problem.** Measured at a 1210px viewport:

- 1 of 6 running-text paragraphs carries `max-w-[var(--measure)]` — the AI summary
- that capped paragraph is 843px ≈ 100 characters
- the other five run 1103px ≈ 130 characters

`--measure: 72ch` resolves to 843px because `ch` is the advance of "0", which is
11.7px in Plus Jakarta at 16px — well above the face's average character width. So
even the capped paragraph is not at 72 characters.

**Change.** `--measure: 72ch → 52ch` (≈600px, ≈72 characters in this face), and set
`max-width: var(--measure)` on the prose **container** inside each card rather than
on individual paragraphs, so new copy inherits it. Applies to the three problem-card
descriptions and the three AI per-problem paragraphs.

**Acceptance.** No running-text line on order detail exceeds ~75 characters at any
viewport ≥ 1024px.

---

### F-05 — The AI panel is half the screen

**Where:** the AI analysis card and the citation list component.

**Problem.** Measured at 1210px, on a 3105px page:

| | |
|---|---|
| AI section | 1513px — **49% of the page** |
| Explanation card alone | 1248px — 1.5× the whole detected-problems section, 5.4× the decision card |
| Citation rows on the screen | 23, of which 8 distinct triples repeat |
| `PO-10382 completedQty 620` | appears 4 times |

It is not styled loudly — no glow, no avatar, no chat. It dominates because it is
enormous and because it retells the screen: three sub-sections in the same order as
the three problem cards, each with its own evidence list.

**Change, cheap (do this first).** Render each evidence list as one wrapping strip
instead of one row per citation: make the `<ul>` the wrapping flex row
(`flex flex-wrap gap-x-4 gap-y-[5px]`) and each `<li>` an inline group holding
`chip · field · value`. Four stacked rows become one or two lines — roughly a third
of the card's height. Nothing is removed, so constraint 6 is untouched. Add
`whitespace-nowrap` to the id chip and to each group so a record id never breaks
mid-token at narrow widths.

**Change, structural (worth scheduling).** Move each AI per-problem paragraph into
the problem card it explains, beneath that card's evidence, marked with the existing
sparkle and an *AI* label. The AI card then holds only the summary and the
recommended action — roughly 450px instead of 1248.

**Trade to be aware of:** the structural version puts rule-derived and model-derived
content in one card, so the sparkle and the label have to stay unambiguous
(constraints 4 and 5). If that can't be made clear, ship the cheap version only.

**Acceptance.** The AI section is under a third of the page height. Every citation
still appears on the screen, next to its claim.

---

### F-06 / F-10 — The AI is emphasised where the human should be

**Where:** the recommended-action block on order detail; the decision card on
`03-decisions` and `04-activity`.

**Problem.** *Recommended next action* is the only tinted panel on the detail screen
and its sentence is 16px extrabold in `--cockpit-indigo` — three levels of emphasis
stacked on the one paragraph that must not look like the system acting.

On the audit screens the same imbalance: the AI recommendation sits in a filled
panel at 16px, while the human's note is a 14px quoted line and the human's name is
10px `--text-subtle` at the bottom. On an audit trail *of human decisions*, the AI
outweighs the human.

**Change.**
- Detail: keep the tint and the indigo eyebrow; set the recommendation sentence in
  `--text-ink` at 16px/600. Still the most prominent thing in the card, no longer
  the most prominent thing on the page.
- Decisions and activity: swap the emphasis. The human's note becomes the card body
  at 16px `--text-ink`; the recommendation becomes an unfilled 14px line beneath it,
  keeping its sparkle and its `RECOMMENDED` label.

**Acceptance.** On 03 and 04, the largest and darkest text in each card is what the
human wrote or decided.

---

### F-11 — Four screenfuls between the order and the decision

**Where:** the decision card on order detail.

**Problem.** The decision row begins at **2479px** of a 3105px page at desktop
width, and the page is taller on a phone. That is roughly four screenfuls, most of
it AI, before a gloved supervisor can approve anything. Nothing at 390px overflows
or is unreadable — what fails is the distance to the action.

**Change.** On `(pointer: coarse), (hover: none)`, pin Approve / Reject / Escalate
to the bottom of the viewport as a sticky bar (`sticky bottom-0`, white surface,
`--border-light` top hairline, existing `--r-panel` corners on the top edge only,
`env(safe-area-inset-bottom)` padding). The note field expands above it on focus.
Buttons keep their 44px coarse-pointer minimum.

**Trade:** a persistent action bar is a product decision, not only a style one — it
puts an always-available Approve in front of someone who may not have read the
evidence yet. Worth a conversation before building. F-05's structural change removes
roughly 800px of the distance on its own.

**Acceptance.** On a 390 × 844 viewport the three buttons are reachable without
scrolling, at any scroll position, and never cover the last line of content.

---

### Consider — F-08, F-09, F-12, F-13, F-14

Worth doing; none urgent.

| Id | Finding | Change |
|---|---|---|
| F-08 | The order header is a card like every other card, so the eye lands on identity rather than on the problem | Set it on the page surface with the section-eyebrow treatment instead of in a `fab-card`. One fewer white box; no token changes |
| F-09 | 1180px spent on a single column of full-width cards | Two columns at `lg`: narrative left, evidence and decision right (sticky). The compiled stylesheet already carries `lg:grid-cols-[1fr_1.1fr]`, so the pattern exists in the product. Keep `--page-width: 1180px` — spend the surplus on a second column, not on line length |
| F-12 | At 390px the header wraps to three rows, ~135px before any content | `hidden sm:flex` on the user's name and role; keep the avatar. The nav then takes the second row alone |
| F-13 | The five-across meta grid leaves a hole in its last row at 390px | Span the last cell across both columns, or reorder so *Scrap* leads — on a phone it is the number that matters |
| F-14 | `--r-card: 22px` against 20px padding crowds the corner content on a handheld | 18px below `sm` only. The desktop shape, which is the recognisable one, is untouched |

---

## Design tokens

Unchanged tokens are listed so you can confirm nothing else moved. Only the
**Added** and **Changed** rows are edits.

| Token | Value | Status |
|---|---|---|
| `--brand-indigo` / `--cockpit-indigo` | `#5b54e8` / `#4842d4` | unchanged |
| `--brand-indigo-bg` | `#edecfd` | unchanged |
| `--navy-3` / `--nav-active` | `#10153a` / `#1a2150` | unchanged |
| `--page-surface` / `--pure-white` | `#f6f7fc` / `#ffffff` | unchanged |
| `--border-light` | `#e7e9f4` | unchanged |
| `--text-ink` / `--text-muted-cool` | `#161c34` / `#5d6680` | unchanged |
| `--text-subtle` | `#8b93b0` → **`#667090`** | **changed (F-02)** |
| `--status-green` / `-amber` / `-red` / `-idle` | `#1fa971` / `#d6841f` / `#dc2626` / `#8b93b0` | unchanged — dots only |
| `--status-green-bg` / `-amber-bg` / `-red-bg` / `-idle-bg` | `#e7f7ef` / `#fdf4e7` / `#fef2f2` / `#f2f3fb` | unchanged |
| `--status-green-ink` | `#0f7a52` | **added (F-02)** |
| `--status-amber-ink` | `#97600f` | **added (F-02)** |
| `--status-red-ink` | `#b91c1c` | **added (F-02)** |
| `--status-idle-ink` | `#616b8b` | **added (F-02)** |
| `--r-card` / `--r-panel` / `--r-control` / `--r-chip` | 22 / 16 / 12 / 9px | unchanged (F-14 proposes 18px for `--r-card` below `sm` only) |
| `--measure` | `72ch` → **`52ch`** | **changed (F-04)** |
| `--page-width` | `1180px` | unchanged |
| Type scale | 10 / 12 / 14 / 16 / 20 / 26 / 30 | unchanged |
| Type face | Plus Jakarta Sans 400–800, `tabular-nums` for figures | unchanged |

Spacing edits are Tailwind classes, not tokens: section-to-section 16 → 28px (F-07).

## Assets

None. No new icons, no images. Lucide stays the only icon set and no new glyph is
introduced — F-05's structural version reuses the existing sparkle.

## Files

```
reference/01-orders.html        Order search — list, filters, search + scan
reference/02-order-detail.html  The important one. 9 of 14 findings
reference/03-decisions.html     Standing decision per order, override, superseded trail
reference/04-activity.html      Decision feed, newest first
reference/app.css               The app's compiled stylesheet. Keep it beside the HTML
patches/tokens.css              The F-02 and F-04 token edits, ready to paste
```

Real source to edit: `claudeai_athena/app/globals.css` (V2 token block, ~lines
194–244) plus the order-detail, decisions and activity screen components.

## How this was measured, so you can re-check it

Geometry figures come from the live DOM of `reference/02-order-detail.html` at a
1210px viewport (`getBoundingClientRect`), not from screenshots. Contrast figures
are WCAG 2.1 relative-luminance ratios computed on the exported token values.

Two caveats worth carrying: nothing here was tested on a real handheld under real
factory lighting, and interactive states (hover, focus, the override form, the scan
sheet) are absent from the export, so no finding judges them.
