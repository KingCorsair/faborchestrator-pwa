# Work packages

Companion to `MASTER_PLAN.md`. Every package names real files, states its
rollback point, and is labelled **PWA-only**, **FO-only**, **both**, or
**deployment**. Everything through WP7 is PWA-only and works against
FabOrchestrator exactly as deployed.

Difficulty: ● easy · ●● moderate · ●●● hard.

---

## WP0 — Baseline and contracts · PWA-only · ● · 0.5 day

**Goal.** Freeze what "working" means before anything moves, so every later
package has an unarguable gate.

**Files.** `docs/plan/BASELINE.md` (new); no source changes.

**Tasks.**
1. Record current suite: 389 unit tests; drawer 59/59, answer-render 21/21, landing-ask 24/24, mobile audit 16/16, journeys 13/13, gate 32/32, cold-launch 11/11, reports 9/9, security 24/24.
2. Record the FO contract per agent as a table (from `ARCHITECTURE_MAP.md` §1) with the probe date.
3. Record the two properties that must never regress: ownership validation, and the FO token never reaching client JS.

**Acceptance.** A reviewer can run one command per check and match the numbers.

**Rollback.** Documentation only.

---

## WP1 — Agent descriptors · PWA-only · ● · 0.5 day

**Goal.** Widen the registry so an agent is described, not coded.

**Files.** `lib/faborch/agents.ts`, `__tests__/faborch/agents.test.ts` (new).

**Tasks.**
1. Extend `FoAgent`:
   ```ts
   label: string;
   historyAgent: "chat" | "modeling" | null;   // null = no history
   requestProfile: "chat" | "minimal";
   accessPath: string | null;                   // e.g. /api/modeling-agent/access
   capabilities: { history: boolean; mcp: boolean; artifacts: boolean;
                   uploads: boolean; downloads: boolean };
   ```
2. Keep `sendMcpIds` and `keepsHistory` as derived getters for one release so nothing breaks mid-migration.
3. Add `modeling` as a **declared but disabled** descriptor (`enabled: false`) so the shape is exercised without exposing it.

**Dependencies.** WP0.

**Acceptance.** `FO_AGENTS` describes insight, backend and modeling. No runtime behaviour changes. Full suite green.

**Tests.** Descriptor completeness; every enabled descriptor has a `foPath` that exists in the probe table; a disabled descriptor cannot be resolved by `foAgent()`.

**Demo.** None — plumbing.

**Rollback.** Revert one commit; the derived getters mean callers are untouched.

---

## WP2 — Server request profiles · PWA-only · ●● · 1 day

**Goal.** Take body construction out of `foChat` so a new agent's contract is a
profile, not a branch.

**Files.** `lib/faborch/request-profiles.ts` (new), `lib/faborch/client.ts`,
`app/api/faborch/[agent]/chat/route.ts`, `__tests__/faborch/request-profiles.test.ts` (new).

**Tasks.**
1. `buildRequestBody(profile, { messages, conversationId, activeMcpIds, model })`:
   - `chat` → `{messages, model, activeMcpIds, webSearch:false, enableReasoning:true, conversationId?}`
   - `minimal` → `{messages, conversationId?}` (the modeling contract, verified in `app/api/modeling-agent/chat/route.ts`)
2. `foChat()` accepts a prepared body and no longer builds one.
3. The route picks the profile from the descriptor.

**Dependencies.** WP1.

**Acceptance.** Byte-identical outbound body for FabInsight — assert against the recorded capture in `docs/FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md`.

**Tests.** Both profiles snapshotted; `minimal` must not contain `model`, `activeMcpIds`, `webSearch` or `enableReasoning`.

**Demo.** None.

**Rollback.** One commit; `foChat` regains its inline body.

---

## WP3 — History bucket and permission probe · PWA-only · ●● · 1 day

**Goal.** Remove the last two constants that assume FabInsight.

**Files.** `app/api/faborch/conversations/route.ts` (the `const AGENT = "chat"`),
`app/api/faborch/conversations/[id]/route.ts`, `lib/faborch/owns.ts`,
`lib/faborch/access.ts` (new).

**Tasks.**
1. Take the history bucket from the descriptor, resolved server-side from an `?agent=` **slug** — never a raw bucket name from the client.
2. `checkAccess(token, descriptor)` → `{enabled}`; call `accessPath` when present, cache per token for ~60 s.
3. `ownsConversation` takes the bucket from the descriptor.

**Dependencies.** WP1, WP2.

**Acceptance.** FabInsight history unchanged. A descriptor with `historyAgent:"modeling"` lists modeling threads. An `accessPath` returning `{enabled:false}` yields a clean 403 the screen can render.

**Tests.** Slug→bucket mapping rejects unknown slugs; `checkAccess` fails closed on network error; ownership still refuses a foreign id.

**Security gate.** Ownership validation must still pass its existing tests — this is the package most likely to weaken it.

**Rollback.** One commit.

---

## WP4 — Capability-driven screen · PWA-only · ●● · 1.5 days

**Goal.** One screen for every agent, behaviour from capabilities.

**Files.** `components/fab/screens/agent-chat.tsx`, `components/fab/app-shell.tsx`,
`components/fab/nav-drawer.tsx`, `app/agent/[slug]/page.tsx` (new),
`app/fabinsight/agent-chat-client.tsx`.

**Tasks.**
1. `app/agent/[slug]/page.tsx` resolves the descriptor and renders the client; unknown slug → 404 before any FO call.
2. `agent-chat.tsx` reads `capabilities.artifacts` (skip the parser when false) and `capabilities.history`.
3. Drawer takes history from the descriptor rather than `keepsHistory`.
4. **Keep `app/fabinsight/page.tsx` and `app/backend-agent/page.tsx`** as thin re-exports so existing URLs, `?q=` and `?c=` keep working.

**Dependencies.** WP1–WP3.

**Acceptance.** `/fabinsight` and `/backend-agent` behave identically; `/agent/insight` is equivalent. Every existing check passes **unchanged** — that is the gate.

**Tests.** Guard test: no agent id appears in `agent-chat.tsx`. Live: both URL forms answer.

**Demo.** "Same screen, two doors, no per-agent code."

**Rollback.** One commit; the old pages contain the old client.

---

## WP5 — Capability adapters · PWA-only · ●●● · 2 days · *only if WP6 needs them*

**Goal.** A place for uploads/downloads to live without touching the core.

**Files.** `components/fab/capabilities/uploads.tsx` (new),
`app/api/faborch/[agent]/upload/route.ts` (new), `lib/faborch/agents.ts`.

**Tasks.** Multipart passthrough to `parse-upload`; download proxy for
`download/[id]`; composer renders an attach control only when
`capabilities.uploads`.

**Dependencies.** WP4. **Do not start before WP6 proves it is needed.**

**Acceptance.** FabInsight is byte-identical with uploads off.

**Rollback.** One commit; adapters are additive.

---

## WP6 — Second real agent · PWA-only · ●● · 1 day

**Goal.** Prove reuse with the Modeling Agent — **read-only first**.

**Files.** `lib/faborch/agents.ts` (flip `enabled`), `components/fab/screens/landing.tsx`
(card becomes a live link), `scripts/second-agent-check.mjs` (new).

**Tasks.**
1. Enable the descriptor: `foPath:"/api/modeling-agent/chat"`, `historyAgent:"modeling"`, `requestProfile:"minimal"`, `accessPath:"/api/modeling-agent/access"`, `capabilities.mcp:false`, `artifacts:false`.
2. Read-only first: history list and thread loading, no sending.
3. Then enable sending behind the access probe.
4. **Scope note.** `MASTER_PLAN.md` excludes Master Data from the product scope. This package uses it as an *engineering* proof of the second contract. Whether the card ships to users is Jothi's call and is **not** implied by this work.

**Dependencies.** WP1–WP4.

**Acceptance.** Modeling history lists and loads through the same proxy and screen. An account without the role sees an honest closed state, not a dead door. FabInsight untouched.

**Tests.** Guard: no new agent-specific branch in the proxy. Live: both agents' drawers list their own buckets and never each other's.

**Demo.** **The milestone that answers Jothi.** Two genuinely different FO agents, one host, and the diff is a config block.

**Rollback.** Flip `enabled` back to false — no code revert needed.

---

## WP7 — Auth/session bridge investigation · PWA-only (investigation) · ●● · 1 day

**Goal.** Answer the embedding question with evidence, not opinion, before anyone builds it.

**Files.** `docs/plan/AUTH_BRIDGE_FINDINGS.md` (new); a throwaway branch, never merged.

**Tasks.**
1. Prototype the same-origin reverse proxy (`/fo/*`) on a preview app; measure asset breakage.
2. Test on a **real iPhone**, installed to the Home Screen: does the framed session survive a force-quit?
3. Write down what FO would need for a token-exchange endpoint.

**Dependencies.** none. Can run in parallel.

**Acceptance.** A written recommendation with device evidence.

**Rollback.** Nothing merged.

---

## WP8 — Latency and deployment · deployment + PWA-only · ● · 0.5 day

**Goal.** The cheap wins, kept away from the architecture.

**Files.** `lib/faborch/client.ts`, `lib/faborch/access.ts`, `fly.toml`,
`scripts/latency-check.mjs` (new).

**Tasks.** Cache `activeMcpIds` per token (~60 s TTL, refresh on failure);
reuse the connection to FO; evaluate a Fly region nearer FO's origin;
record before/after.

**Expected.** ~1.0–1.5 s of the measured ~1.9 s pre-stream overhead.

**Acceptance.** Measured improvement; no behaviour change. Stale-tool risk documented.

**Rollback.** One commit.

---

## WP9 — Migration and cleanup · PWA-only · ● · 0.5 day

**Goal.** Remove the old path once two agents run on the new one.

**Files.** `app/fabinsight/agent-chat-client.tsx`, `app/backend-agent/page.tsx`,
`lib/faborch/agents.ts` (drop the derived getters), `CLAUDE.md`, `docs/STATUS.md`.

**Dependencies.** WP6 green for at least one full check cycle.

**Acceptance.** One screen, one proxy, one registry. Suite green. Docs updated.

**Rollback.** One commit — but only attempt after WP6 has been stable.

---

## Dependency graph

```
WP0 ─ WP1 ─ WP2 ─ WP3 ─ WP4 ─ WP6 ─ WP9
                          └─ WP5 (only if WP6 needs it)
WP7 ────────── parallel, investigation only
WP8 ────────── parallel, independent
```

## Totals

| Path | Days |
|---|---|
| WP0–WP4 (host, FabInsight on it) | **4.5** |
| + WP6 (second agent proof) | **5.5** |
| + WP8 | **6** |
| + WP5, WP7, WP9 | **9.5** |
