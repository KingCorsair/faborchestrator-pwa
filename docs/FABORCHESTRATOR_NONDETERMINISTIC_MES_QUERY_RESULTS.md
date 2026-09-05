# FabOrchestrator returns different answers to the same manufacturing question

**Found 5 September 2026, while testing this PWA against production
FabOrchestrator.** This is an **upstream FabOrchestrator issue**, not a defect in
this app. It is written up here because it was found here, because it makes the
PWA appear to disagree with the FabOrchestrator website, and because the write-up
is what the FabOrchestrator team needs in order to act on it.

Nothing in this repository can fix it, and this document argues that nothing in
this repository should try.

---

## The short version

Some manufacturing questions have no fixed query behind them. The model writes
one on the spot, and it does not write the same one twice.

```
PWA
  → forwards the question to FabOrchestrator correctly
  → FabOrchestrator /api/chat
  → the LLM chooses an MCP tool, a database view and a query
  → different choices produce different answers
```

The first meaningful divergence is **inside FabOrchestrator**, at the point the
model decides which view to read and what to put in the `WHERE` clause. Every
step before that — the browser, this app's proxy, HTTPS transport, the session,
the MCP connections — is identical and was verified to be identical.

---

## What was proved, and how

Same production environment, same FabOrchestrator account, same exact prompt,
fresh single-turn conversation each time, runs seconds apart.

### "How many lots are currently in WIP?"

The **same request body, sent five times unchanged**, using the body the
FabOrchestrator website sends:

| Run | Answer |
|---|---|
| 1 | **424** |
| 2 | **237** |
| 3 | **237** |
| 4 | **427** |
| 5 | **427** |

An earlier three-run pass with the same body also returned **10,904**.

Views selected across runs:

- `vw_Materials`
- `vw_Container`
- `vw_MaterialLifecycleStatus`
- `vw_ResourceWIP_Snapshot`

**The 237 / 427 split is one SQL predicate.** Both come from the same view,
through the same tool, in the same tool loop:

```sql
-- answers 237
SELECT COUNT(*) FROM Bottleneck_MCP.vw_MaterialLifecycleStatus
WHERE SystemStateLabel = 'Active' AND IsTerminated = 0 AND IsProductionComplete = 0

-- answers 427
SELECT COUNT(*) FROM Bottleneck_MCP.vw_MaterialLifecycleStatus
WHERE                                IsTerminated = 0 AND IsProductionComplete = 0
```

And the rows FabOrchestrator itself returned show what the missing predicate is
worth:

```
CurrentStatus   SystemStateLabel   LotCount
In Process      Active                  228
Queued          Suspended               185   ← counted by 427, not by 237
Terminated      Terminated               32
Dispatchable    Active                    6
On Hold         …
```

228 + 6 + a few = **237**. Add the 185 suspended lots = **427**.

**Both answers are defensible.** Nobody has decided whether a lot sitting
suspended in a queue is "in WIP". The model is being asked to make that business
decision on every request, and it does not make the same one twice.

`424` versus `427` is the same definition a few minutes apart — real data
movement, and a useful calibration for how much of the gap is *not* drift.

`10,904` is not a lot count on any reading of the question.

### "Which equipment is running right now?"

Repeated identical requests selected different views:

- `vw_ResourceWIP_Snapshot`
- `vw_TimeSliceEvents`
- `vw_OperationalEventsLog`

and returned different equipment counts across runs (5 and 7 were both observed
from the same unchanged request). "Running" has the same problem as "WIP": the
live state of a tool is reconstructed from an event log, and which log, and how
"latest state" is derived, is decided per run.

---

## The control case: "Give me the yield by product."

Yield is stable, and **the reason it is stable is the whole finding.**

On both the PWA path and the FabOrchestrator website path, the yield prompt
produced a stream containing **zero `tool-input-start` frames**. No MCP tool was
called at all. The frame sequence was:

```
start → start-step → text-start → text-delta … → text-end → finish
```

FabOrchestrator detects the question *before* the model gets a chance to explore.
`detectMetricAsk()` matches it and `buildMetricBrief()` runs hand-verified SQL
(`claudeai_athena/lib/fabinsight/metrics.ts`, reached from
`app/api/chat/route.ts`). The model never chooses anything.

```
Yield
  → fixed FabOrchestrator metric logic
  → fixed query
  → stable answer

WIP / running equipment
  → LLM tool exploration
  → different views and queries possible
  → unstable answer
```

That is the difference in one picture. It is also the shape of the fix.

---

## The one request difference between the two clients, and why it is not the cause

There is a real difference in what the two clients send:

| Field | FabOrchestrator `/chat` page | This PWA |
|---|---|---|
| `enableReasoning` | `false` | `true` |

It has a visible effect — the PWA's stream carries `reasoning-start` /
`reasoning-delta` / `reasoning-end` frames and the website's does not.

**It was not proved to be the root cause, and the evidence is against it.**
Five unchanged runs of each body produced overlapping results:

```
FO website body (enableReasoning: false)   424 · 237 · 237 · 427 · 427
PWA body        (enableReasoning: true)    237 · 238 · 427 · 427 · 237
```

Both bodies produced both answers. The FabOrchestrator body disagrees with
**itself** by more than it disagrees with the PWA. Aligning `enableReasoning`
would remove an unexplained difference between two clients, which is worth doing
for its own sake, but it would not make either side reproducible.

Everything else in the request matched exactly: `model` (`claude-opus-4-8` on
both), `webSearch` (`false` on both), and `activeMcpIds` — same two connection
ids, same order, derived by byte-identical logic on both sides. `conversationId`
is sent by the website and omitted by the PWA, and is inert here: `/api/chat`
uses it only to collect S3 file references and to persist messages, never to
build the model's history.

### The PWA does not forward the body — it rebuilds it

Worth stating precisely, because "forwarding" is the natural assumption and it is
not what happens. `FabInsightRequestSchema` accepts **only `messages`**. The
proxy discards everything else and constructs the outbound body server-side.

Verified by recording the proxy's outbound traffic. A request was posted to the
PWA carrying `model: claude-sonnet-4-6`, `webSearch: true`,
`enableReasoning: false`, a `conversationId` and a **bogus** `activeMcpIds`. What
left the PWA was:

```json
{
  "messages": [ { "role": "user", "parts": [ { "type": "text",
                  "text": "How many lots are currently in WIP?" } ] } ],
  "model": "claude-opus-4-8",
  "activeMcpIds": ["49f9d2ad-…", "e4d04e4f-…"],
  "webSearch": false,
  "enableReasoning": true
}
```

Every client-supplied value was dropped; the MCP ids were replaced with the real
ones the server resolved from FabOrchestrator. Headers reaching FO were
`content-type` and `authorization` — no cookie is forwarded.

This is deliberate: a browser cannot choose the model or inject tool connections.
It also means the difference cannot originate in this app's client.

---

## Impact on the PWA

- **The PWA can appear to disagree with the FabOrchestrator website.** It does
  not. Both are drawing from the same unstable process; two samples from one
  distribution are not two behaviours.
- **The PWA is forwarding the question correctly.** Proved by capture, above.
  The proxy adds a model name, the caller's real MCP connections and two boolean
  flags, and nothing that could change what an answer says.
- **The PWA must not implement its own WIP or equipment SQL, or its own
  definitions of them.** Doing so would put manufacturing business logic into a
  forwarding layer that `CLAUDE.md` forbids from holding any, and — worse — it
  would make this app answer differently from the product it exists to
  demonstrate. The test in "What NOT to build" is *could this change what the
  answer says?*, and a pinned `WHERE` clause plainly could.
- **Fixing this belongs in FabOrchestrator.** One fix there corrects both
  clients, because both go through the same route.

### For anyone running a demonstration

"How many lots are currently in WIP?" can legitimately answer 237 or 427, and has
answered 10,904. Ask it knowing the number may not survive being asked twice, and
do not put it on a slide. "Give me the yield by product" is deterministic today
and returns a real table.

---

## Suggested upstream fix

The pattern already exists in the product — this is asking for two more entries
in a mechanism that has three.

1. **Agree the canonical definition of WIP.** Specifically: does it include lots
   in `Queued` / `Suspended`? That single question is the whole 237-versus-427
   gap. It is a business decision and needs an owner of the fab data, not an
   engineer.
2. **Agree the canonical definition of running equipment.** Which event log is
   authoritative for current tool state, and how "latest state" is derived.
3. **Choose the verified views and queries** for both, the way the yield,
   OEE and scrap briefs already have hand-verified SQL.
4. **Add deterministic routing**, alongside the existing metric path — extend
   `detectMetricAsk()` and `buildMetricBrief()` in
   `claudeai_athena/lib/fabinsight/metrics.ts` with `wip_lots` and
   `running_equipment`. Both questions then bypass the tool loop entirely, as
   yield does today.
5. **Add repeatability tests.** Ask each question **N times** and assert the
   same figure *and* zero `tool-input-start` frames. This is the check that was
   missing: a single run proves nothing here, and every check we had — including
   this repo's own end-to-end journey walk — passed against a number drawn from
   the distribution without anybody noticing.

Point 5 is the one that must not be skipped. Without it, the next question with
no fixed query behind it will do exactly the same thing, and again nobody will
see it until two people compare notes.

---

## Reproducing it

No special tooling. Sign in against production FabOrchestrator, then post the
same body to `/api/chat` five times and read the answers:

```json
{ "messages": [ { "role": "user",
                  "parts": [ { "type": "text",
                               "text": "How many lots are currently in WIP?" } ] } ],
  "model": "claude-opus-4-8", "webSearch": false,
  "enableReasoning": false, "conversationId": null,
  "activeMcpIds": [ "…the ids from GET /api/mcp/connections…" ] }
```

Read the `tool-input-available` frames to see the generated SQL and the
`tool-output-available` frames to see the rows. The divergence is visible in the
`WHERE` clause before it is visible in the prose.
