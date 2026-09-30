# Master plan — the PWA as a reusable FabOrchestrator shell

**Written 6 September 2026. Planning only; nothing in this directory has been
implemented.** Every claim about FabOrchestrator below was checked against the
running production host, not against `CLAUDE.md` and not against memory. Where
this document contradicts an older note in this repository, this document is the
one with a probe behind it, and the probe is quoted.

---

## 1. The problem

Adding a FabOrchestrator agent to the PWA currently means building an
integration for it. Jothi's concern, in his shape:

```
PWA → custom FabInsight integration
    → custom Agent 2 integration
    → custom Agent 3 integration
    → custom Agent 4 integration
```

What he wants instead:

```
PWA → one reusable FO integration/runtime → many FO agents and functions
```

The question this plan answers is not "how do we make the PWA faster". It is
**"what does Amay have to build the next time FabOrchestrator grows an
agent?"** — and the honest answer today is "a page, a proxy contract, a screen
and a test suite".

---

## 2. What is actually deployed — measured, not assumed

Probed against `https://d7y8a8whrch88.cloudfront.net` on 6 September with the
demo account. `POST {messages:[]}` distinguishes an endpoint that exists (it
validates, and answers 400/500) from one that does not (404 HTML).

| Endpoint | Result | Meaning |
|---|---|---|
| `POST /api/chat` | **500** `LAMBDA_MCP_CRASH` | exists; rejected the empty body downstream |
| `POST /api/modeling-agent/chat` | **200**, streamed `{"type":"error","errorText":"Invalid prompt…"}` | **exists, and streams** |
| `POST /api/backend-agent/chat` | **404** | **not deployed** |
| `POST /api/agent` | **404** | no unified agent endpoint |
| `POST /api/orchestrate` | **404** | **no orchestrator exists** |
| `POST /api/admin/chat` | **404** | admin is not on this host |
| `GET /api/conversations?agent=chat` | 200 | shared history |
| `GET /api/conversations?agent=modeling` | 200 | history partitioned by agent |
| `GET /api/mcp/connections` | 200 | tool list per user |
| `GET /api/fabinsight/pinned` | 200 | pinned dashboards |
| `GET /api/modeling-agent/access` | 200 `{"enabled":true}` | capability probe exists |
| `GET /api/artifacts` | 400 `conversationId is required` | exists |
| `GET /admin`, `/api/admin/*` | 404 | separate host |

### The four cockpit cards are two deployed agents

`claudeai_athena/components/cockpit/agent-cards.tsx`:

| Card | Routes to | Deployed API | Distinct implementation? |
|---|---|---|---|
| FabInsight™ | `/chat` | `/api/chat` | the agent |
| AI Support Engineer | `/chat` | `/api/chat` | **no** — same agent, different label |
| Modeling Agent | `/modeling-agent` | `/api/modeling-agent/chat` | **yes** — own prompt, tools, role gate, uploads |
| Back-end Agent | `/backend-agent` | *(page exists; its API is 404 in prod)* | **source yes, deployed no** |

**I must correct an earlier note in this repository.** `lib/faborch/agents.ts`
says a separate `/api/backend-agent/chat` "exists in NO upstream branch". In the
snapshot at `work_projects` it exists, is committed, and is a genuinely distinct
agent — its own `lib/ui-agent/system-prompt.ts`, its own `buildUiAgentTools`,
its own `UI_AGENT_MODEL`. It is simply **not deployed to the host the PWA points
at**, which is why the PWA's Back-end Agent screen works: it forwards to
`/api/chat` and always has.

That single fact is the strongest argument in this plan. The Back-end Agent is
exactly the "five new agents next month" case, already half-arrived: the product
has written one, and the PWA would need work the day it ships.

### What the two deployed agents share, and where they differ

| | `/api/chat` | `/api/modeling-agent/chat` |
|---|---|---|
| Auth | `requireAuth`, Bearer | **same** |
| Response | `createUIMessageStreamResponse` | **same** |
| History | `/api/conversations`, `agent="chat"` | **same store**, `agent="modeling"` |
| Request body | `messages, model, activeMcpIds, webSearch, enableReasoning, conversationId` | **`messages, conversationId` only** |
| Permission | none | role `modeling_agent`, admins bypass → 403 |
| Capability probe | none | `GET /api/modeling-agent/access` |
| Extras | — | `parse-upload` (multipart), `download/[id]`, `parent-options/[targetType]` |

**Roughly 80% of the integration surface is already common**: authentication,
stream format, conversation store, error envelope. What varies is a request-body
builder, a permission probe, and optional capability adapters. That is the
finding that makes a configuration-driven host viable rather than wishful.

---

## 3. Current PWA architecture

```
phone
 └─ PWA frontend            components/fab/screens/agent-chat.tsx  (1,238 lines)
     └─ PWA server          app/api/faborch/[agent]/chat/route.ts
         └─ FO client       lib/faborch/client.ts                  (602 lines)
             └─ FO          /api/chat  →  model · MCP · MES
         ←── SSE ────────── lib/faborch/stream.ts
     ←── turns ──────────── lib/faborch/conversation.ts (reducer)
```

### Already generic

| Piece | File | Why it generalises |
|---|---|---|
| Agent registry | `lib/faborch/agents.ts` | already keyed by id, already carries `foPath`, `sendMcpIds`, `keepsHistory` |
| Chat proxy | `app/api/faborch/[agent]/chat/route.ts` | one route serves every agent; `[agent]` selects from the registry |
| SSE parser | `lib/faborch/stream.ts` | frame-typed, agent-agnostic |
| Conversation state | `lib/faborch/conversation.ts` | a pure reducer, no FabInsight in it |
| Error normalisation | `lib/faborch/errors.ts` | status → code → next step, agent-agnostic |
| History mapper | `lib/faborch/history.ts` | operates on FO's stored shape, not on one agent |
| Ownership check | `lib/faborch/owns.ts` | per-user, per-agent-bucket |
| Session | `lib/faborch/session.ts`, `lib/auth.ts` | httpOnly FO cookie + HMAC session |
| Shell / drawer | `components/fab/app-shell.tsx`, `nav-drawer.tsx` | driven by `NAV` and by `keepsHistory` |

**The registry pattern already exists and already works for two doors.** This
plan is mostly about finishing it, not inventing it.

### Still agent-specific

| Problem | Where | Cost when a new agent arrives |
|---|---|---|
| Request body is hard-coded | `client.ts` `foChat()` builds `model/activeMcpIds/webSearch/enableReasoning` inline | any agent with a different body needs a branch |
| Capabilities are implied, not declared | `sendMcpIds`, `keepsHistory` are the only flags | uploads, downloads, permission probes have nowhere to live |
| No permission model | nothing calls `/api/modeling-agent/access` | a role-gated agent shows a dead door |
| `agent` bucket is a constant | `app/api/faborch/conversations/route.ts` `const AGENT = "chat"` | modeling history is unreachable |
| One screen per door | `app/fabinsight/page.tsx`, `app/backend-agent/page.tsx` | a page per agent, by hand |
| Empty-state copy inline | `agent-chat.tsx` `Opening` | per-agent chips live in the registry but the shape is fixed |

---

## 4. Options considered

Full comparison in `ARCHITECTURE_MAP.md`. Summary:

| | A · per-agent | B · Generic Host | C · FO orchestrator | D · Embed FO |
|---|---|---|---|---|
| Works with FO as deployed | yes | **yes** | **no** | partly |
| FO changes needed | none | **none** | substantial | some |
| New agent costs | page + proxy + tests | **config (+ adapter)** | ideally nothing | nothing |
| PWA keeps mobile control | yes | **yes** | yes | **no** |
| Single login | yes | **yes** | yes | **unsolved** |
| Offline shell | yes | yes | yes | **no** |
| Risk to working demo | — | **low** | high | high |

### Why not D (embedding) on its own

Measured 5 September: FO sets **no `X-Frame-Options` and no CSP**, so it frames.
But a cross-origin frame gets its own partitioned `localStorage`, and FO's
session is a Bearer token in `localStorage` (`app/chat/page.tsx`). Framed from
another origin, `/chat` **redirected to the marketing page** — signed out. The
PWA's `faborch_token` is httpOnly by design and cannot be handed across. So
embedding costs a **second login**, and on iOS that second session lives in
storage ITP evicts. Embedding also surrenders the mobile shell, the offline
page, and the conversation drawer.

Embedding answers "how do new FO screens appear without PWA work". It does not
answer "how does the PWA stay a good phone app". Section 4 of
`ARCHITECTURE_MAP.md` covers the single-login designs that would be needed
first.

### Why not C alone, yet

There is no orchestrator. `/api/agent` and `/api/orchestrate` are 404. Building
one is FO product work — agent selection, permission composition, a stable
public contract — and it is the right long-term target, not something to wait
for.

---

## 5. Recommendation

**Short term — Generic PWA Agent Host (Option B). PWA-only. No FO change.**

Widen `lib/faborch/agents.ts` from a 2-entry registry into a capability
descriptor, move request construction behind a server-side adapter keyed by that
descriptor, and drive one screen and one route from it. FabInsight moves onto
the host unchanged in behaviour; the Modeling Agent becomes the proof that a
second, genuinely different agent costs configuration rather than a project.

**Long term — Unified FO agent API (Option C). FO-only, plus a thin PWA client.**

When FO is allowed to evolve, the clean shape is one endpoint that owns agent
selection, permissions, tools, history and streaming, with a discovery endpoint
so clients can render what exists without being redeployed. The Generic Host is
not thrown away by this: it becomes the client, and its capability descriptors
come from FO instead of from a file.

The two are the same architecture at different times. Every hour spent on the
short-term host is an hour spent on the long-term client.

---

## 6. The five-agents test

| Architecture | What Amay builds per new agent |
|---|---|
| **A, today** | a page under `app/<agent>/`, an entry in `FO_AGENTS`, a body branch in `foChat`, history-bucket handling, empty-state copy, a live check, guard tests. **Half a day to two days each.** |
| **B, Generic Host** | one descriptor in the registry. If it needs uploads or a permission probe, one adapter implementing a declared capability. **Under an hour for a conversational agent; half a day with a new capability.** |
| **C, orchestrator** | nothing, if FO exposes it through discovery. The PWA renders what the endpoint reports. |

---

## 7. Migration strategy

The working FabInsight path is not to be dismantled. The order is
add-beside → migrate → validate → prove → remove.

1. **Add beside.** The host lands as new modules; nothing existing is edited.
2. **Migrate FabInsight** onto it behind a build-time switch.
3. **Validate** — the whole existing check suite must pass unchanged. This is the gate.
4. **Prove reuse** with the Modeling Agent, read-only first.
5. **Remove** the old path only after two agents run on the new one.

Rollback points are listed per work package in `WORK_PACKAGES.md`. Every one is
a `git revert` of a single commit; no database, no migration, no FO change.

---

## 8. Definition of done

- Two genuinely different deployed FO agents run through one host, one proxy and one screen.
- Adding a third conversational agent is a registry entry, demonstrated in front of Jothi.
- The Modeling Agent's role gate is honoured — no dead door for an operator who lacks it.
- Conversation history, ownership validation, artifacts, errors and offline behave exactly as they do today; the existing checks prove it.
- No FO change was required to get here.
- A written statement of what FO would have to add for Option C, ready to hand to that team.

---

## 9. What this plan does not claim

- That embedding is wrong — only that it is unsolved on the single-login and iOS-storage questions, and that it costs the mobile shell.
- That latency is the problem. Measured: the PWA hop adds ~1.9 s before the stream starts, against 12–39 s of FO model and tool time. Real, worth fixing, and **not** an architecture driver. `WORK_PACKAGES.md` WP8 keeps it separate.
- That the Back-end Agent works today. Its API is 404 in production; the PWA's screen reaches `/api/chat`.
- That new live MES answers can ever work offline.
