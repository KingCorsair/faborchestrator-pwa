# How to run this review in Claude Design

## 1. Upload

Upload the whole folder. **Keep `app.css` beside the HTML files** — each page
links it relatively (`./app.css`), so the screens render unstyled without it.

## 2. Open with this prompt

Paste something like this, so the review happens inside the constraints rather
than around them:

> Attached are four screens from a manufacturing PWA, exported from the running
> app — real components and the real stylesheet, not mockups. `BRIEF.md` has the
> product context, the design language and its provenance, and a list of hard
> constraints in §4.
>
> **Read BRIEF.md first.** In particular §4: this app must remain recognisably
> FabOrchestrator V2, so please work within the existing tokens rather than
> proposing a new palette, type pairing, or a flatter/squarer direction. §5 lists
> what was already fixed today — no need to re-report those.
>
> Start with `02-order-detail.html`, the richest screen. Then answer the ranked
> questions in §7, highest first. For each suggestion, tell me which token or
> class you would change and why, so it can be implemented directly.

## 3. What to bring back

The more specific the better. Most useful, in order:

1. **A screenshot with the problem marked**, or a precise description ("the gap
   between the status pill and the order number is too tight at line X").
2. **The token or class to change**, not just the effect. "`--r-card` from 22px
   to 16px" is implementable; "make it feel crisper" is not.
3. **Which constraint it trades against**, if any. Some good ideas will conflict
   with §4 — that's worth knowing rather than hiding, and a few constraints are
   reviewable if the reason is strong enough.

Anything at that level of specificity can be implemented directly and verified.

## 4. Regenerating this export

From the project root, with the dev server running on port 3002:

```bash
npm run build                       # the export uses the compiled stylesheet
node design-review/seed.mjs <token> # seeds the in-memory decision log
npx tsx --tsconfig design-review/tsconfig.json design-review/render.tsx <token>
```

`<token>` is a bearer token from `POST /api/auth/login`. Output lands in
`design-review/out/`.

The renderer imports the **real** screen components and inlines the **real**
compiled CSS. That is deliberate: a hand-written mock would show a prettier app
than the one that exists, which is exactly what a design review must not do.
