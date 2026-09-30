# Milestones and timeline

Companion to `WORK_PACKAGES.md`. Every milestone produces something that can be
shown on a phone. Estimates assume one engineer, part-time alongside demo
support, and they assume **no FabOrchestrator change**.

---

## Milestone 1 — the host runs FabInsight unchanged
**WP0 → WP4 · about 1 week**

**Demonstrable:** open `/agent/insight` on a phone. It is FabInsight, exactly as
today — same answers, same drawer, same history, same artifacts. `/fabinsight`
still works because the old URL is a thin re-export.

**The gate, and it is strict:** every existing check passes **unchanged** —
389 unit tests, drawer 59/59, landing-ask 24/24, mobile audit 16/16,
journeys 13/13, gate 32/32, cold-launch 11/11.

**What Jothi sees:** nothing. That is the point — the architecture moved and the
product did not.

**Rollback:** revert WP4; the old client is still in the old page.

---

## Milestone 2 — a second real FO agent through the same host
**WP6 · about 2 days after M1 · cumulative ~1.5 weeks**

**Demonstrable:** the Modeling Agent's conversation history lists and opens in
the PWA, through the same proxy and the same screen as FabInsight — with a
**different endpoint, a different request body, a different history bucket and a
role gate.** Side by side on one phone.

**What Jothi sees:** the answer to his question. The diff that added the second
agent is a configuration block, not a project. If his role lacks
`modeling_agent`, he sees an honest closed state rather than a dead door.

**Note:** this is an engineering proof. Whether Master Data ships to users is a
separate product decision — see `OUT_OF_SCOPE_AND_NON_GOALS.md`.

**Rollback:** flip `enabled: false`. No code revert.

---

## Milestone 3 — shared behaviour proven across both
**WP3 + WP6 checks · about 2 days · cumulative ~2 weeks**

**Demonstrable:** for both agents — conversation history shared with the FO
website, ownership validation refusing a foreign id, artifacts rendering,
errors giving a next step, offline page, 360×640 and 390×844.

**What Jothi sees:** the shared machinery is genuinely shared, not copy-pasted.

---

## Milestone 4 — proven for five-agent expansion
**a rehearsal, half a day · cumulative ~2.5 weeks**

**Demonstrable:** add a **hypothetical** third conversational agent as a
descriptor pointing at `/api/chat` with a different label and chips, in front of
an audience. Under an hour, no new page, no new proxy, no new tests beyond a
descriptor assertion. Then remove it.

**What Jothi sees:** the cost of agent number five, measured rather than
promised.

---

## Timeline

| Horizon | Realistic |
|---|---|
| **1 week** | Milestone 1. Host built, FabInsight migrated, every check green. |
| **2 weeks** | Milestones 2 and 3. Second real agent proven; shared behaviour verified. Optionally WP8 latency. |
| **1 month** | Milestone 4, plus WP5 if the Modeling Agent's uploads are wanted, plus WP7's embedding findings with real-iPhone evidence, plus WP9 cleanup. A written FO change request for Option C. |
| **Later / optional** | Option C itself — FO's `/api/orchestrate` and `/api/agents`. **Gated on the FO team, not on us.** Same-origin reverse proxy, if WP7 recommends it. Offline history caching. |

---

## What is deliberately not on this timeline

- **Option C implementation.** It needs FO product work that has not been scoped or agreed. The deliverable here is the change request, not the change.
- **Embedding.** WP7 produces findings. Building it is a separate decision after those findings.
- **Master Data as a user-facing feature.** Out of scope; used only as the engineering proof in M2.
- **Offline conversation history.** Understood, costed in `MASTER_PLAN.md`, not scheduled.

---

## Risks

| Risk | Mitigation |
|---|---|
| Refactor destabilises the demo before Monday | Nothing starts until after the demo; M1's gate is "every existing check unchanged" |
| Ownership validation weakened during WP3 | Its tests are a hard gate; WP3 is the package flagged for it |
| Modeling Agent's role gate blocks the demo account | Probed: `{"enabled":true}` today. WP6 handles false honestly |
| FO deploys `/api/backend-agent/chat` mid-flight | Good news — it becomes descriptor number three |
| Five agents never arrive | M1 still pays: one screen, one proxy, less code than today |
