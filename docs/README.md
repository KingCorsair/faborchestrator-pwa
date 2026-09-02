# Documentation

This folder is the version-controlled home of the project's plans and, as the
work completes, its operational documentation. The code and the plans live in
one repository on purpose: a plan that cannot drift silently away from the
commit history it describes.

## PRD.md

**What we are building, and how it should behave.** Product requirements, kept
separate from the engineering roadmap so product decisions and open questions do
not get settled by accident inside implementation work. Every statement is
labelled CONFIRMED, PROPOSED, OPEN QUESTION or OUT OF SCOPE.

Read it before changing what the app *does*; read the planning documents before
changing *how* it is built.

`PRD.html` is the same document laid out for reading and sharing, published as an
artifact. As with the planning documents, the markdown here is canonical: when a
product decision changes, it changes in `PRD.md` first.

## STATUS.md

**Start here.** Where the project stands, what is proved and how, what is left,
and what is blocked on somebody outside the team. Updated as work lands.

## planning/

The four current planning documents, in order of altitude:

| File | Audience | What it holds |
|---|---|---|
| `business-phases.html` | Management | The six business-value phases: what becomes usable, and the week each is reached |
| `management-delivery-plan.html` | Management | The full delivery plan: objective, architecture, components, milestones, timeline, effort, risks |
| `work-packages.html` | Both | Every work package in build order, with technical and business milestones side by side |
| `detailed-engineering-plan.html` | Engineering | The 21-section implementation plan with file-level evidence and source citations |

They are plain HTML — open them in any browser. `planning/archive/` keeps
superseded versions.

These files are the canonical copies. Published copies exist as claude.ai
artifacts for easy sharing, but this repository is the source of truth; when
the plans change, the change lands here as a commit.

## Arriving later (Phase 5 / WP12)

- `DEMO.md` — the one-page demo runbook
- `SECURITY-REVIEW.md` — the security review record

Setup and running instructions live in the repository root `README.md`; the
design record lives in `CLAUDE.md`.
