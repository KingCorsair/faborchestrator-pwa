# Documentation

This folder is the version-controlled home of the project's product and
operational documentation. It lives beside the code on purpose: a document that
cannot drift silently away from the commit history it describes.

The delivery plans this project started from, and the August design record of
the production-order demo, were removed on 28 September 2026: they described an
app that no longer exists. The last copies are at commit `585aa00` — for
example `git show 585aa00:docs/planning/work-packages.html`, or
`git show 585aa00:CLAUDE.md` for the design record.

## STATUS.md

**Start here.** Where the project stands, what is proved and how, what is left,
and what is blocked on somebody outside the team. Updated as work lands.

## HANDOVER.md and OPEN_ISSUES.md

**Operating it, and what is still open.** `HANDOVER.md` explains every failure
message and what to do about it; `OPEN_ISSUES.md` lists what remains and who can
close it. The security review is a script, not a document:
`scripts/security-review.mjs`, run against the deployed URL.

## PRD.md

**What we are building, and how it should behave.** Product requirements, kept
separate from the engineering so product decisions and open questions do not
get settled by accident inside implementation work. Every statement is labelled
CONFIRMED, PROPOSED, OPEN QUESTION or OUT OF SCOPE.

Read it before changing what the app *does*; read `CLAUDE.md` in the repository
root before changing *how* it is built.

`PRD.html` is the same document laid out for reading and sharing. The markdown
is canonical: when a product decision changes, it changes in `PRD.md` first.

## FABORCHESTRATOR_ROUTING_GROUNDING_BUGS.md and FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md

**Defects found in FabOrchestrator itself**, written up for the team that owns
it. The first covers the routing `/api/chat` performs before the model is
called: a dashboard request without permission that fabricated a dashboard,
plant questions falling back to general knowledge, matcher false positives, and
phrasing sensitivity. The second covers MES questions answered differently each
time they are asked.

Fixes for the first exist on a local branch in the FabOrchestrator clone.
**Nothing is pushed** — that repository belongs to another team.

## probes/

Dated evidence from the first investigations — the environment probes, the
end-to-end report and the first mobile audit. `STATUS.md` cites them as the
proof behind its early milestones.

Setup and running instructions live in the repository root `README.md`; the
guide to how the app is built, and the rules it follows, is `CLAUDE.md`.
