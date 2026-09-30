# Implementation checklist

Ordered. Each **GATE** must pass before the next section starts. Written so a
different engineer — or Claude Code in a later session — can follow it without
rediscovering the architecture. Read `MASTER_PLAN.md` and `ARCHITECTURE_MAP.md`
first.

**Do not start any of this until after the Monday 8:30 PM PST demo.**

---

## Section 0 — baseline (WP0)

- [ ] `npm test` — record the number (expected 389)
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` clean
- [ ] `APP_URL=https://faborch-demo.fly.dev node scripts/nav-drawer-check.mjs` → 59/59
- [ ] …`answer-render-check.mjs` → 21/21
- [ ] …`landing-ask-check.mjs` → 24/24
- [ ] …`mobile-audit.mjs` → 16/16
- [ ] …`journeys-check.mjs` → 13/13
- [ ] …`gate-live-check.mjs` → 32/32
- [ ] …`cold-launch-check.mjs` → 11/11
- [ ] …`security-review.mjs` → 24/24
- [ ] Re-probe the FO endpoint table in `ARCHITECTURE_MAP.md` §1 and update the date
- [ ] Write `docs/plan/BASELINE.md`

**GATE 0** — [ ] every number above recorded and green.

---

## Section 1 — descriptors (WP1)

- [ ] Extend `FoAgent` in `lib/faborch/agents.ts`: `label`, `historyAgent`, `requestProfile`, `accessPath`, `capabilities`, `enabled`
- [ ] Keep `sendMcpIds` / `keepsHistory` as derived getters
- [ ] Add the `modeling` descriptor with `enabled: false`
- [ ] `__tests__/faborch/agents.test.ts`: completeness; `foAgent()` refuses a disabled id

**GATE 1** — [ ] full suite green · [ ] no runtime behaviour changed.

---

## Section 2 — request profiles (WP2)

- [ ] `lib/faborch/request-profiles.ts` with `chat` and `minimal`
- [ ] `foChat()` takes a prepared body; stops building one
- [ ] Route selects the profile from the descriptor
- [ ] Snapshot test: `chat` matches the recorded capture byte for byte
- [ ] Snapshot test: `minimal` has no `model`/`activeMcpIds`/`webSearch`/`enableReasoning`

**GATE 2** — [ ] outbound FabInsight body byte-identical · [ ] suite green.

---

## Section 3 — history bucket and access (WP3)

- [ ] History bucket resolved from the descriptor via a **slug**, never a client-supplied bucket
- [ ] `lib/faborch/access.ts` — probe, cached ~60 s, **fails closed**
- [ ] `ownsConversation` takes the bucket from the descriptor
- [ ] Test: unknown slug rejected before any FO call
- [ ] Test: `checkAccess` returns not-enabled on network failure

**GATE 3 — security** — [ ] ownership tests pass unchanged · [ ] a foreign `conversationId` is still refused · [ ] no bucket name is accepted from a request body.

---

## Section 4 — capability-driven screen (WP4)

- [ ] `app/agent/[slug]/page.tsx`; unknown slug → 404 before any FO call
- [ ] `agent-chat.tsx` reads `capabilities.artifacts` / `.history`
- [ ] Drawer takes history from the descriptor
- [ ] `app/fabinsight/page.tsx` and `app/backend-agent/page.tsx` become thin re-exports
- [ ] Guard test: no agent id string appears in `agent-chat.tsx`
- [ ] `?q=` and `?c=` still work on the old URLs

**GATE 4 — the big one**
- [ ] current FabInsight baseline still passes, **unchanged**
- [ ] generic host works with FabInsight
- [ ] no auth regression
- [ ] no conversation-history regression
- [ ] no ownership-security regression
- [ ] mobile checks pass at 360×640 and 390×844
- [ ] deployment checks pass against Fly

*Milestone 1 is complete here. Stop, deploy, confirm, and only then continue.*

---

## Section 5 — second agent (WP6)

- [ ] Flip the `modeling` descriptor to `enabled: true`
- [ ] Read-only first: list + load history, sending disabled
- [ ] Verify the drawer lists **modeling** threads, never chat threads
- [ ] Enable sending behind the access probe
- [ ] Verify an account without `modeling_agent` sees an honest closed state
- [ ] `scripts/second-agent-check.mjs`
- [ ] Guard test: no new agent-specific branch in the proxy

**GATE 5** — [ ] second real agent proves reuse · [ ] FabInsight unchanged · [ ] the two agents' histories never mix.

*Milestone 2 is complete here — the demo that answers Jothi.*

---

## Section 6 — optional, in this order

- [ ] WP8 latency: cache MCP ids, keep-alive, region; measure before/after
- [ ] WP5 adapters — **only if** the Modeling Agent's uploads are actually wanted
- [ ] WP7 embedding findings, including a real-iPhone force-quit test
- [ ] WP9 cleanup: drop the derived getters, update `CLAUDE.md` and `docs/STATUS.md`

**GATE 6** — [ ] full suite green · [ ] all live checks green · [ ] docs match the code.

---

## Standing rules for every commit

- [ ] No `Co-Authored-By` trailer
- [ ] Never commit `wp1-*.png` — the mobile audit rewrites them; `git checkout --` them
- [ ] One work package per commit, so every rollback is one `git revert`
- [ ] Never weaken `lib/faborch/owns.ts`
- [ ] The FO token never reaches client JavaScript
- [ ] No FO product code is modified
- [ ] Deploy only with a clean tree and `HEAD == origin/main`

---

## If something goes wrong

| Symptom | Move |
|---|---|
| FabInsight behaves differently after a gate | `git revert` that package's single commit; gates exist so this is always one commit |
| Modeling Agent misbehaves | flip `enabled: false` — no revert |
| Ownership test fails | **stop.** Do not proceed. That test is the security boundary |
| A live check fails once | re-run before acting — FO's answers are nondeterministic (`docs/FABORCHESTRATOR_NONDETERMINISTIC_MES_QUERY_RESULTS.md`) |
