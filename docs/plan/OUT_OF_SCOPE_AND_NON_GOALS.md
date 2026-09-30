# Out of scope and non-goals

The things this plan must not turn into, each with the reason it is here.

---

## Do not build fake specialised agents

The PWA must never present an agent FabOrchestrator does not have. AI Support
Engineer is a label on `/api/chat` — verified in `agent-cards.tsx` — and the
registry says so. A descriptor may relabel an endpoint; it may not imply a
capability the platform lacks.

## Do not duplicate FO business logic in the PWA

No prompts, no model selection, no tool choice, no manufacturing definitions.
The test from `CLAUDE.md` is *could this change what the answer says?* A request
profile that picks which fields an endpoint accepts is plumbing. A profile that
sets a system prompt is not.

## Do not hardcode MES definitions

Not WIP, not "running equipment", not a `WHERE` clause. FabOrchestrator answers
the same question differently on different runs
(`docs/FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md`), and pinning a
query here would make the PWA disagree with the product it demonstrates. That is
FO's to fix.

## Do not create a second conversation database

FabOrchestrator owns conversation history: one store, ownership checks,
soft deletes, pinning. A local copy would be a second source of truth that
silently disagrees. The PWA holds a **selection** — `?c=<uuid>` — and nothing
else. Caching for offline reading, if ever built, must be visibly dated and must
never be written back.

## Do not weaken conversation ownership checks

`lib/faborch/owns.ts` stands in front of a real upstream gap: FO's `/api/chat`
accepts a `conversationId` and never verifies it belongs to the caller. Every
other conversation route there checks. The PWA refuses to be the vehicle. No
refactor in this plan may remove, cache-around, or make optional that check —
and no request may supply a history bucket directly.

## Do not send raw credentials into iframe code

No password, and no FO bearer token, into a frame by `postMessage` or any other
channel. Today the credential is entered once on a PWA screen and the FO token
lives in an httpOnly cookie the browser never exposes to JavaScript. Any
embedding design must preserve that or it is a security regression, not a
feature. Same-origin hosting is the only embedding approach that keeps it.

## Do not promise offline AI or MES answers

The app shell can be cached. Previously read conversations and pinned reports
can be cached. **A new question cannot be answered offline** — the model, the
MCP servers and the MES are all server-side. Offline shows what you have already
seen; it can never answer something new. An iframe of FO is *less* offline-
capable than what ships today.

## Do not rewrite working FabInsight for architectural purity

The FabInsight path is accepted and demonstrated. The migration is
add-beside → migrate → validate → prove → remove, and Milestone 1's gate is
that **every existing check passes unchanged**. If the generic host cannot run
FabInsight identically, the host is wrong, not the checks.

## Do not expose Master Data as a product feature

Out of scope by decision. It appears in this plan only as the engineering proof
that a second, genuinely different FO contract costs configuration. Whether the
card ships to users is Jothi's call and is not implied by WP6.

## Do not build Option C on speculation

There is no `/api/orchestrate` and no `/api/agents` — both 404 in production.
Do not write a PWA client for an endpoint that does not exist, and do not
describe one to Jothi as though it does. The deliverable is a change request for
the FO team.

## Do not optimise the architecture around latency

Measured: the PWA hop costs ~1.9 s before the stream starts, against 12–39 s of
FO model and tool time. Worth fixing cheaply (WP8). Not worth a worse
architecture. If a design is chosen mainly because it saves a second, it is
being chosen for the wrong reason.

## Do not modify FabOrchestrator product code

Everything through WP7 is PWA-only and works against FO exactly as deployed.
FO changes are proposed in writing, to the team that owns them, and are labelled
as such.

## Do not commit the audit screenshots

`wp1-360x640.png` and `wp1-390x844.png` are rewritten by every mobile-audit run.
`git checkout --` them before committing.
