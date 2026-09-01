# FabOrchestrator PWA — design review brief

**Read this before looking at the screens.** The four HTML files in this folder
are the real application rendered to static pages — real components, the real
compiled stylesheet, real data. They are not mockups. But they carry no context,
and without the context below a reviewer will reasonably propose a new visual
direction, which is the one thing this project must not do. See "Constraints".

---

## 1. What the app is

A shop-floor supervisor searches or scans a production order, sees its status and
any problems detected against it, asks the AI to explain, gets a recommended
action with citable evidence, and approves / rejects / escalates. The decision is
recorded and can later be overruled.

One story: **a production order has a problem → the system detects it → AI
explains it → a human decides.**

It is a demo for an existing product (FabOrchestrator, by AthenaTech). Its job is
to look and feel like that product, so a stakeholder recognises it immediately.

## 2. Who uses it, and where

- A **production supervisor** on a factory floor. Often gloved, sometimes in
  safety glasses, under bright and uneven lighting.
- Primary device is a **handheld or tablet**, held one-handed, but the demo is
  also shown on a **laptop** to stakeholders in a room.
- Sessions are short and interruptive: check an order, decide, move on. This is
  not a screen anyone sits in front of for an hour.
- Consequences are physical. A wrong call stops a line or ships bad parts.

## 3. The design language, and where it comes from

The look is **FabOrchestrator "V2" / Fab Blue**, taken from the shipped product,
not invented here. Every value below was copied from
`claudeai_athena/app/globals.css` lines 194–244 rather than re-picked:

| Token | Value | Used for |
|---|---|---|
| `--brand-indigo` / `--cockpit-indigo` | `#5b54e8` / `#4842d4` | primary actions, record IDs, gradients |
| `--navy-3` / `--nav-active` | `#10153a` / `#1a2150` | active nav pill, dark fills |
| `--page-surface` | `#f6f7fc` | page background |
| `--pure-white` | `#ffffff` | card surfaces |
| `--border-light` | `#e7e9f4` | hairlines |
| `--text-ink` / `--text-muted-cool` / `--text-subtle` | `#161c34` / `#5d6680` / `#8b93b0` | the three text tones |
| `--status-green` / `-amber` / `-red` | `#1fa971` / `#d6841f` / `#dc2626` | status only, never decoration |
| `--r-card` / `--r-panel` / `--r-control` / `--r-chip` | 22 / 16 / 12 / 9 px | the radius family |
| type | Plus Jakarta Sans, 400–800 | the product has **no** monospace face |

Shape language: **rounded, lifted, airy.** White cards with soft shadows, not
square-cornered line drawings with hairline borders.

## 4. Constraints — a suggestion that breaks one of these is not usable

These are not preferences. They come from the product, from accessibility, or
from the factory floor.

1. **It must remain recognisably FabOrchestrator V2.** Do not propose a new
   palette, a new type pairing, or a flatter/squarer direction. This project has
   already been styled wrongly twice — once against a theme meant only for
   generated dashboards, once against an unmerged redesign proposal — and both
   times the reviewer's objection was "this doesn't look like our product."
   Suggestions should work *within* the tokens in §3.
2. **Status is never carried by colour alone.** Every status pill renders its
   word beside its dot, and the dot is `aria-hidden`. A colour-only signal fails
   exactly the person this app is for: someone reading through safety glasses
   under factory lighting, possibly colour-blind.
3. **Numerals are tabular, not monospace.** V2 has no mono face. IDs and figures
   use `font-variant-numeric: tabular-nums` in Plus Jakarta Sans so columns line
   up without introducing a second typeface.
4. **No chatbot interface, and no decorative "AI" styling.** No glow, no
   gradient mesh, no assistant avatar, no chat bubbles. The AI is secondary to
   the manufacturing workflow and must look it. The one sparkle icon marking
   AI-authored content is deliberate and minimal.
5. **The AI never appears to act.** It explains and recommends; a human decides.
   Nothing may be styled as though the system takes action on the machine.
6. **Evidence stays next to the claim.** Every figure the AI states is rendered
   beside the record ID it came from, on the same screen. Do not propose moving
   citations behind a tooltip, a drawer, or a "details" affordance — being able
   to check the AI's work without leaving the screen is the product's core idea.
7. **Touch targets ≥ 44px on touch devices.** Desktop density stays tighter on
   purpose, because that density is what makes it read as FabOrchestrator.
8. **No new dependencies** — no icon set beyond lucide, no UI kit, no CSS
   framework beyond the Tailwind already present.

## 5. What was already changed (2026-08-12) — please don't re-report these

**Two rounds have already landed. The screens in this folder are the state
after both.**

### Round 1 — an internal pass, earlier that day

- **Content column 860px → 1180px**, to match the product's own cockpit. It had
  been rendering a narrower ribbon than the screen it copies.
- **Type scale 19 sizes → 7** (10 / 12 / 14 / 16 / 20 / 26 / 30). Eight of the
  old sizes sat half a pixel from a neighbour, which is invisible — noise, not
  hierarchy.
- **Weight**: there was *no* regular-weight text anywhere (34 semibold, 26 bold,
  15 extrabold, 0 normal). Meta lines and running text are now 400; headings,
  pills, buttons and eyebrow labels kept their weight.
- **A `flex-1` spacer inside a wrapping row** replaced with `ml-auto`, which was
  dropping timestamps onto their own line when the row wrapped.
- **Touch targets** now trigger on `(pointer: coarse), (hover: none)`, so a
  touchscreen laptop gets them too.

### Round 2 — your own findings, implemented

Eleven of the fourteen came back and went in. **Please treat all of these as
closed:**

- **F-01 — one instant, three renderings.** Six raw ISO strings were on the
  order screen (`2026-08-10T08:00:00.000Z`) beside formatted record rows. Now
  zero. Note the fix differs from what was suggested: formatting was applied at
  **render**, via a new `lib/format.ts`, not in the payload sent to the model.
  Formatting the model's input would have made grounding validation
  timezone-dependent — citations are compared byte-for-byte against the MES
  record, so the same analysis would validate in one timezone and fail in
  another. The model was instead instructed to write natural times in prose
  while copying values exactly into evidence.
- **F-02 — pill contrast.** Four ink tokens added
  (`--status-green/amber/red/idle-ink`); `--text-subtle` darkened to `#667090`.
  Text was measuring as low as 2.68:1. **Dots keep the original hue**, so
  nothing on screen changed colour — only the word darkened.
- **F-03 — decision asked for before the proof.** Section order is now Detected
  problems → AI analysis → MES records → Your decision, as siblings.
- **F-04 — reading measure.** 72ch → **52ch**. `ch` is the advance of "0",
  which in Plus Jakarta is well above the face's average character width, so
  72ch was rendering ~100 characters.
- **F-05 (cheap half)** — evidence lists are now one wrapping strip. No citation
  was removed.
- **F-06 / F-10** — recommendation set in ink rather than indigo; on both audit
  screens the human's note is now the card body at 16px, above the AI's advice.
- **F-07** — section gap 16 → 28px; eyebrows 12px `--text-muted-cool`.
- **F-12 / F-13 / F-14** — name and role hidden below `sm`; Scrap leads the meta
  grid; card radius 18px below `sm`.

**One correction to the handoff itself:** it directed edits to
`claudeai_athena/app/globals.css`. That is the *product* repository, which its
own contributor guide forbids modifying. Everything went into this demo's
`app/faborch-theme.css` instead. The brief's §3 cites globals.css as where the
tokens were *copied from*, which is probably what caused the confusion — it is
a source, not an edit target.

### Round 3 — the three layout findings, also implemented

These were held back from round 2 and have since gone in. **The order-detail
screen in this folder is the new layout**, so please review it as it stands
rather than re-proposing these:

- **F-08 — order header on the page surface.** The identity block is a
  `<header>` on `--page-surface` with the section-eyebrow treatment; the facts
  grid keeps a hairline top rule instead of a card edge. The only white
  surfaces above the fold now carry detected problems.
- **F-09 — two columns at `lg`,** `grid-cols-[1fr_1.1fr]`. **The split is by
  provenance**, which is the distinction the product is built on: left is the
  argument (rules found it, model explains it), right is what the MES actually
  recorded plus the decision that answers it. `--page-width` stays 1180px and
  the surplus goes to the second column, not to line length, as you asked.
  DOM order is unchanged, so stacking below `lg` still reads problems →
  analysis → records → decision and F-03 is not undone by the grid.
  - One deviation worth flagging: the sticky right column is capped with
    `lg:max-h-[calc(100vh-104px)]` and scrolls internally. A sticky element
    taller than the viewport pins its top and carries its own bottom off-screen
    where page scrolling cannot reach it — on an order with six downtime events
    that would strand the decision buttons. The cap is what makes sticky safe
    on data of unknown size.
- **F-11 — the action bar,** on `(pointer: coarse), (hover: none)` only.
  Fixed rather than sticky, because sticky resolves against its scroll
  container and a bar inside the decision card would only pin while that card
  is on screen — the bottom of the page, which is exactly where the problem
  is not. The in-card row is hidden on touch, so exactly one set of decision
  buttons exists at any width.
  - **Your objection to F-11 was taken seriously rather than waived.** You
    wrote that it *"puts an always-available Approve in front of someone who
    may not have read the evidence yet."* The bar renders from inside
    `DecisionSection`, which returns null unless an analysis exists — so it
    cannot appear before Explain has been run and answered. It shortens the
    distance to a decision that is already available; it does not make one
    available earlier. **If that is not sufficient, say so** — the alternative
    is a confirm step on Approve, which nobody has asked for yet.

### Round 4 — a density pass (not from your findings)

Measured on the order-detail screen and acted on before this export:

| | before | after |
|---|---|---|
| uppercase wide-tracked eyebrows | 26 | 9 |
| bold-or-heavier spans | 59 | 42 |
| `extrabold` spans | 13 | 5 |
| copies of the rule-severity disclaimer | 3 | 1 |

- **`Label` now has two treatments, and only headings shout.** `as="h2"|"h3"`
  keeps uppercase at 0.14em tracking — three or four per screen, and they are
  what you scan to navigate. The default inline variant is **sentence case,
  12px, regular weight**: it names the value beneath it and gets out of the way.
  Those labels were also `font-bold`, so "everything is uppercase" and
  "everything is emphasised" turned out to be one defect wearing two hats — 26
  of the 59 bolds went with the same edit.
- **The rule-severity disclaimer moved to the section heading.** It was on all
  three issue cards, so the scenario order said it verbatim three times. Each
  card still carries its own threshold ("Downtime above 60 min is HIGH"), which
  is the part that differs.
- Fact values and issue titles dropped `extrabold` → `bold`; with captions now
  regular weight the value no longer has to shout to win the pair.

**Word count is deliberately not in that table.** It reads 864 → 867, which
means nothing: most of the text on this screen is the model's live analysis and
it varies between renders. The static-copy reduction is real and is visible in
the disclaimer row.

### Round 5 — your two required fixes and all five polish items

**Both required fixes are in, and all five optional items were cheap enough to
take.** Nothing was skipped and no constraint was hit.

- **FIX 1 — dead space in the `lg` two-column layout. Taken in part.** The
  whole right column was sticky and capped with internal scroll; it now flows
  normally, the internal scrollbar is gone, and the columns, contents and DOM
  order are untouched. Your diagnosis of the cause was right.

  **But nothing is sticky now, including the decision card.** It was
  `lg:sticky lg:bottom-4` as you specified, and the product owner reverted it on
  sight: a card floating over the page while you read is a distraction on a
  screen whose whole job is careful reading of evidence — and your own objection
  to F-11 applies to it, since a decision control that follows you is one you
  can take without having read what is above it.

  **This knowingly fails your acceptance criterion (2)** on desktop, "decision
  reachable at every scroll position". On desktop you now scroll to the
  decision, as with any form. Touch is unaffected — F-11's fixed action bar
  still owns that case, which is where reachability actually mattered.
  Flagging rather than quietly dropping it: if you think the desktop case still
  needs solving, it needs a different mechanism than a floating card.
- **FIX 2 — evidence de-duplicated.** Problem cards keep the title, the
  threshold line and the **record-ID chips only**; the key/value rows are gone.
  Chips are deduplicated by record id, because MACHINE_DOWNTIME cites
  `durationMinutes` and `reason` on the same event and two identical chips read
  as two events. `durationMinutes` now appears **twice** on the screen (AI claim
  + MES record) rather than three times. **The AI section's citations were not
  touched**, per §4.6.

Polish: **(3)** the duplicate H3 card header is gone, section eyebrow kept;
**(4)** evidence values get `min-w-0` + `overflow-wrap:anywhere` while the id
chip and field keep `whitespace-nowrap`, so a pair can never be orphaned from
its record; **(5)** filter chips `whitespace-nowrap`; **(6)** values in evidence
pairs and record rows raised to 14px, keys held at 12px; **(7)** status-pill
text 12px → 14px inside the existing coarse-pointer block only.

Acceptance re-run on this export: sticky classes moved as specified, DOM order
still ascending (Production order → Detected problems → AI → MES records → Your
decision), one "Your decision" heading, and every AI figure still carries its
record ID.

### Round 6 — mostly a re-report of round 5

⚠ **The round 6 review was written against a pre-round-5 export.** Seven of its
nine findings were already shipped before it arrived. If you are reviewing this
folder, you are looking at a **newer** app than that review describes — please
check §5 before reporting anything as new.

Already done when round 6 arrived: whole-column sticky removed and the internal
scrollbar with it (1); problem cards slimmed to record-ID chips (2); evidence
values wrap instead of overflowing at 390px (3); duplicate "Your decision"
header removed (4); filter chips `whitespace-nowrap` (5); evidence and record
**values** at 14px with keys at 12px (6); status-pill text 14px on touch (7).

**Genuinely new, and now done:**

- **8 — the back link.** It already existed, already in the content area above
  the order label, already a quiet muted-grey ghost link with a left arrow. What
  made it read as misplaced was **width**: its wrapper was still
  `max-w-[860px]`, the page width from before the column widened to 1180px, so
  it sat indented against the "Production order" label beneath it. The stale
  width was on the missing- and error-state wrappers too. All three now use
  `--page-width`.
- **9 — columns starting at different heights.** Both section headings now have
  the same shape: heading plus one 12px caption. "MES records" gained *"The
  records cited above, exactly as the MES returned them"*, which earns its place
  by naming what the column is — raw records, not an interpretation — rather
  than padding a height.

  **Not done as a shared heading row**, which was your "e.g.": putting both
  headings in their own grid row groups them together when the page stacks below
  `lg`, giving heading / heading / cards / cards and breaking the reading order
  F-03 established and round 5 criterion (4) protects. Equalising by content
  keeps DOM order untouched. The severity caption is now unconditional, which is
  what holds the alignment on an order with no problems.

**1 was deliberately not re-applied, and this is a product decision, not an
oversight.** Round 5 did pin the decision card with `lg:sticky lg:bottom-4`
exactly as specified. The product owner saw it and reverted it within the hour:
a card that floats over the page while you read is a distraction on a screen
whose whole job is careful reading of evidence — and **your own objection to
F-11 applies to it**, since a decision control that follows the reader is one
they can act on without having read what is above it. Desktop therefore fails
round 5's criterion (2) on purpose; touch is unaffected, because F-11's fixed
action bar still owns the case where reachability actually mattered. If you
still think the desktop case needs solving, it needs a mechanism other than a
floating card.

### Deliberately still open

- **F-05 (structural)** — moving the AI's per-problem paragraphs into the
  problem cards. Held because it mixes rule-derived and model-derived content in
  one card, and the provenance split is load-bearing here (see §4). Note that
  F-09 now separates the same two things by column instead, which may make this
  finding moot — worth your view.

## 6. What to ignore

- **The amber "held in memory only" banner** is deliberate honesty about a demo
  limitation, not a design accident. Comment on its *visual weight* if it is
  shouting louder than the work — that is fair — but it is not going away.
- **The data is seeded.** Order numbers, notes and timestamps are demo content.
- **Everything is one screen state.** Loading, empty, error and degraded states
  exist in the app but are not in this export. Ask if you want them.
- **Interactions do not work.** These are static renders; buttons don't click,
  the override form and the scan sheet are not shown open.

## 7. Questions I would most like answered

Ranked. Answers to 1–3 are worth more than a long list of small things.

1. **Does this read as a professional product screen, or as an internal
   dashboard?** If the latter, what is the single biggest cause?
2. **Is 1180px right for the content column**, given the primary device is a
   handheld and the secondary is a laptop in a demo room? Would a narrower
   reading column with a wider *list* column be better?
3. **Is the visual hierarchy on the order detail screen correct?** The intended
   reading order is: what is this order → what is wrong with it → what the AI
   says → the records that prove it → the decision. Does the eye actually go
   that way?
4. **Card density.** Cards are `p-5` (20px) with 12px gaps between them, on a
   `#f6f7fc` surface. Too tight, too loose, or right for a scan-and-go screen?
5. **The status pill set** (green/amber/red/indigo/grey, dot + word). Legible at
   a glance from arm's length? Distinguishable without colour?
6. **The AI panel.** Does it sit as a *secondary* element under the detected
   problems, or does it dominate the screen? It should not dominate.
7. **Anything that would fail at 390px width**, which is the phone case nobody
   has yet checked.

## 8. The files

| File | Screen |
|---|---|
| `01-orders.html` | Order search — list, filters, search + scan |
| `02-order-detail.html` | One order: status, detected problems, **AI analysis with grounding badge and citations**, MES records |
| `03-decisions.html` | Decision review — standing decision per order, with override and a superseded trail |
| `04-activity.html` | Activity feed — every decision, newest first |
| `app.css` | The application's compiled stylesheet. Keep it beside the HTML. |

`02-order-detail.html` is the richest and most important screen. If time is
short, review that one.
