# PWA Architectural Remediation Plan

**Status:** planning only. No application code has been changed by this document.
**Revision:** 3.12, 28 September 2026. Revisions 2–2.2 were corrections after review passes; 3.0 began replacing each package's design language with its proposed corrected architecture (RP1); 3.1 added the two-tier body-limit design with runtime evidence; 3.2 added the RP2 session-lifecycle architecture; 3.3 applied the adversarial review of RP1 and RP2; 3.4 is the final clarification pass before RP1 and RP2 are frozen; 3.5 adds the RP3 login-protection architecture (awaiting decisions and review) and three consistency corrections; 3.6 applies the RP2 delta review and adds the whole-architecture first pass for RP4 to RP10-B; 3.7 is the design-review draft: the second RP2 delta round, document-integrity cleanup, RP3 to RP10-B at design-review depth, every §9 question classified, and the Design Review Summary; 3.8 applies the first independent review round of RP3, RP4, RP5, RP6, RP8, RP9 and RP10-B; 3.9 applies RP7's first round (with the new G33), the two RP1/RP2 delta rounds and two further wording deltas; 3.10 applies the second review rounds of RP3, RP5, RP7, RP10-A and RP10-B and their four handed-over RP1/RP2 sentences; 3.11 applies the RP4, RP6, RP8 and RP9 second rounds and the third delta batch; 3.12 applies the WHOLE review and is the design-review draft; see "Revision history" at the end.
**Repository state it describes:** `faborchestrator-pwa`, branch `main` at `585aa00` (2026-09-06) **plus the uncommitted working tree**: the FO gateway (`app/fo-gateway/`, `lib/gateway/`, `public/fo-shell.js`), the auth routes moved to `app/api/pwa/auth/*`, and `docs/STATUS.md` WP1–WP10. 568 tests passing at the time of writing.

**Sources:**
- `PWA_Code_Review.pdf` (15 Sept): the baseline defects. 5 Blocking, 18 Major, 19 Minor, 8 Nits. It reviewed the committed `main` branch; its line anchors match this repository's HEAD exactly.
- `PWA_Fixes_Before_After.pdf` (15 Sept): Chetan's remediation, made in a **different clone** (baseline `c35bbf0`, which does not exist in this repository). None of it is present here. It is used as a design reference and as a record of what went wrong, not as a target.
- The current repository, which is the source of truth for present behaviour.
- The recorded team decision on embedding (see [team-record] below).

---

## Design Review Summary (revision 3.12, 28 September 2026)

**What this document is.** A **design-review draft**: the proposed production architecture for the FabOrchestrator PWA, package by package (RP1 to RP10-B), with every finding from the code review and the later verification mapped to a fix and a behavioural test. **RP1 and RP2 are frozen** designs, with delta-reviewed text corrections. **RP3 to RP10-B** have each been through two independent review rounds with every correction applied, and the whole plan has been through one independent WHOLE review; they are at design-review depth and **not frozen**. Nothing is implemented; no application code has changed. Every decision that needs Jothi, the FO owners or deployment is listed in §9 with a recommendation and is not presented as final.

**Target architecture.** An installed phone PWA that hosts the **real FabOrchestrator** (FO) on the PWA's own origin through a same-origin gateway, in `whole` mode: FO's pages, assets and APIs are served from the PWA's hostname, with one login. The PWA-native chat, cockpit and reports retire after a soak. The PWA owns the installed shell, routing and the request boundary, the authentication bridge, request policy (limits, timeouts, errors, abuse control), browser security and the service-worker lifecycle. FO keeps every business rule.

**Why same-origin embedding.** Jothi's requirement of 6 September 2026: the real FO, one login, no FO feature rebuilt. An iframe would need FO changes for framing and session hand-off; a `/fo/` sub-path would need FO to be relocatable. The gateway needs no FO change, but **FO's scripts and the PWA's scripts share one browser origin**, the central security fact the design manages (RP2's accepted risk G10, RP7).

**Main components.** A thin Node entry in front of Next (pre-buffer body refusals); `proxy.ts` (path ownership, document gate, internal rewrite, request id, redirects); the gateway route and `lib/gateway/*` (registry of routes with methods, auth mode, body and timeout class; forwarding; one writer of response headers per kind; body policy; ownership proof; shell injection); the auth bridge and session code; the login route with `lib/login-protection/*`; `lib/faborch/` with the deadline helper, call classes, stream slots and shutdown registry; the error contract; the service worker and `fo-shell.js`; the observability layer; the deployment configuration.

**End-to-end request flow.** Phone → CloudFront → ALB (reachable only from the edge) → a PWA task. The thin Node entry refuses oversize or over-capacity bodies by their declared length before Next buffers them. `proxy.ts` mints the request id and classifies the path. A **document** is gated on the FO cookie's presence and forwarded to FO anonymously with the PWA's manifest and shell injected. An **API row** goes through the bridge: the PWA bearer must verify and its fingerprint must match the httpOnly FO cookie; only then is FO's token injected; a bearer-less request is refused on `required` rows and forwarded anonymously, capped, on the two public rows. A chat turn with a `conversationId` is refused unless FO's own per-conversation endpoint proves ownership. Every forward has a class deadline; streams have headers, idle and lifetime deadlines, a per-task stream slot, and are **errored, never closed cleanly**, when a deadline fires. FO's responses pass through with the PWA's security headers, `private, no-store` on API responses, and FO's error bodies untouched.

**Authentication and session.** Two credentials: the FO token (httpOnly cookie) and the PWA bearer (localStorage, because FO's embedded client needs it). A cookie alone never authenticates a request to FO; nor does a bearer alone. The PWA is stateless; FO is the revocation authority. Absolute limit 12 hours; idle is FO's API-activity rule. The cookie outlives the bearer by a short grace so the first call after expiry revokes the FO session. Logout clears local state and answers first, then revokes under a bounded deadline; five revoke sites are defined (logout, gateway refusal, re-login, the login probe's 403 or 401, an abandoned login). Keys rotate with explicit `kid`s in two deployments. Redirects are built on the request's own origin and emitted origin-relative. On Fly and on AWS the request scheme is `https` by configuration. Forced password change is detected at login (an FO go-live dependency).

**Rate limiting (login protection).** Two independent dimensions: an **account** bucket (failures per HMAC of the normalised email, from any source, with progressive delay) and a **source** bucket (a token-bucket rate per trusted client IP, never a lock). Counting is reserved before the FO call and settled after, atomically, with per-reservation ids and deadlines; success clears only its own account; indeterminate outcomes never count. FO's pre-password 403 counts and looks exactly like a wrong password. An optional **account-bound device-trust budget** lets a known browser keep signing into its own account during an attack (§9 question 53). A request that bypassed the edge is refused (`untrusted_ingress`). Several instances share a Redis counter store; if it fails, login fails closed while the anonymous and CSP-report caps fall back to per-task memory. Every threshold is a parameter.

**Timeouts and errors.** Every wait on FO belongs to a class with an owner, a start, a reset rule and an abort target; values are CP3's and sit inside the edge's own timeouts, with ordering and per-route sum assertions at startup. One error envelope `{code, error, requestId, errorId?, details?}` and one status table for everything the PWA originates, presented as JSON on API routes and as HTML error pages on navigations; FO's own errors pass through. **Open, §9 question 57:** FO's chat client shows a PWA JSON refusal as raw text; recommended fix is a small FO change, with raw JSON accepted as the interim.

**Authorisation.** FO's chat routes do not check who owns a `conversationId`. The gateway proves ownership with FO's own per-conversation endpoint, caches positive answers under the token fingerprint, invalidates on deletes it sees (with a tombstone against re-warming), refuses non-owned or deleted conversations with 403, and fails closed with 503 when FO cannot be asked. FO stays the authority; asking FO to check ownership itself retires this compensation (§9 question 18).

**Browser security.** Exactly **one writer per response kind** (G33): Next applies middleware and config headers before the route and drops a route's same-named header, so `proxy.ts` writes PWA responses, the gateway writes gateway responses, and the config writes only immutable-asset headers. Every response carries `nosniff`, a referrer policy, HSTS and framing controls; API responses are `private, no-store`. The CSRF invariant is a release-blocker test. PWA pages get a nonce-based CSP; FO's pages cannot forbid inline script without an FO change (§9 question 50), so their CSP restricts external origins only, and CP4 hears that plainly. FO's reports page frames generated HTML with `allow-same-origin allow-scripts` (G32); FO fixes it (question 51) and the PWA denies FO's `/reports` document until then (question 49).

**Service worker.** The worker caches exactly one thing: `/offline`, a fixed-string route handler with no chunks and a system font. Every document and API request is network only; nothing authenticated is ever cached. Navigations have a deadline strictly longer than the gateway's, then an honest offline page after a reachability probe, or a recovery page. New workers wait until the user accepts an update; the reload never races sign-out; a kill switch served from a route unregisters a bad worker.

**AWS proposal (CP5 to confirm).** CloudFront (caching disabled on dynamic paths, all headers, cookies and methods forwarded, compression off) → ALB (reachable only from CloudFront) → ECS Fargate, two or more tasks, behind a thin Node entry; ElastiCache Redis; Secrets Manager; CloudWatch. Startup assertions refuse a misconfigured task; liveness alone gates traffic; dependency status is for operators only. Draining errors open streams before the stop timeout. Rollback levers: the embedding flag (soak period only, minutes on ECS), the worker kill switch, an image rollback, and last, key rotation. A disposable pilot origin, then the flip. Load tests L1 to L5 before any capacity claim. No API Gateway or Lambda.

**Major open decisions** (full list, classes and recommendations in §9). **Jothi:** cutover date and soak (questions 2, 61); chat-refusal presentation (57); the report-frame interim (49); login policy values and the device-trust budget (53); the manifest identity (58); flag rollback speed (59). **FO owners:** production facts from the clone (19, 21, 22, 65); ownership check in `/api/chat` (18); clearing the forced-password flag (44, blocks production); the report sandbox fix (51, blocks production); CSP nonce support (50); FO's own login throttle (45). **Deployment:** the edge and its timeouts (48, the one item that bounds every deadline), topology, store and WAF (54, 67), rollout (55), platforms and repository home (33, 60). None blocks the architecture review.

---

## 0. How to use this document

The loop for every package is:

**study → understand → design → review with Jothi/Chetan → implement → test → demonstrate → next package**

The design-review checkpoints (§6) are hard stops. Implementation of a package does not start until its checkpoint has happened.

### Naming: why "RP" and not "WP"

This repository already uses **two different "WP" numbering schemes**:
- `docs/plan/WORK_PACKAGES.md`: WP0–WP9 of the Option B "generic agent host" plan.
- `docs/STATUS.md` and the gateway code comments: WP1–WP10 of the embedding work. For example, "WP2" means the auth bridge and "WP4" means the ownership check.

To avoid a third collision, the packages in this plan are **Remediation Packages**: RP0–RP9, plus RP10-A and RP10-B. When this document says "WP2", it means the embedding WP2 cited in the code.

### Evidence tags

| Tag | Meaning |
|---|---|
| **[code]** | Read directly in the current working tree |
| **[test]** | Asserted by an existing test in `__tests__/` |
| **[runtime]** | Observed by running code on 23 September 2026 (Appendix B) |
| **[PDF-R]** / **[PDF-C]** | Stated in the original review / in Chetan's follow-up |
| **[FO-clone]** | Read in the local FabOrchestrator clone `fo-mobile-nav` (branch `mobile-nav-preview`, `1b9b117`, 2026-09-10). **This is a fork branch, not production FO.** |
| **[Next-src]** | Read in `node_modules/next` 16.1.4. Read, not executed |
| **[team-record]** | A team decision or production probe recorded in earlier working sessions (7 September) and not stored in this repository. It needs written confirmation at CP0 |
| **[inferred]** | Reasoning from the above |
| **[uncertain]** | Needs reproduction, or an answer from the team |

### Scope labels

- **PROD**: affects the current production deployment, where embedding is **off**. That is per the repository's `fly.toml`, which has no `FO_EMBED_*` settings, and `docs/STATUS.md:325` ("Production untouched"). **The live machine's environment and secrets were not checked** [uncertain].
- **PREV**: affects only the embedding preview (`fly.preview.toml:95`, `FO_EMBED_MODE="whole"`) and the future embedded architecture. **This is not a production incident today.**
- **BOTH**: affects both.

**Fate under whole embedding** records what happens to the defective code if whole-application embedding ships to production:
- **Retires**: the code is listed for removal in `docs/STATUS.md:1036-1044`. That list is a **proposal from the embedding audit, not yet an agreed team decision** (RP0).
- **Survives**
- **Partly**

---

## 1. The situation in one page

1. **The direction is given.** On 2026-09-06 Jothi set a fixed requirement [team-record]: **the PWA must host the real FabOrchestrator, with one login, and no FO feature rebuilt.** The same-origin gateway in this repository is the design chosen to meet it [team-record]: no iframe, no `/fo/` sub-path, no FO change.
   - `docs/plan/MASTER_PLAN.md` (6 Sept, untracked) recommends a different architecture (Option B, a PWA-native agent host) and argues against embedding (`:142-200`). It predates or ignores that requirement.
   - What remains **open** is not *whether* to embed but *how and when*: the production cutover criteria and date; `whole` versus `surfaces` mode in production; what happens to the PWA's own screens in the meantime; and several scope conflicts (CP0).
2. **Production and preview are different applications today.**
   - **Production** is the PWA-native app. It has its own cockpit (`/`), its own chat (`/fabinsight`, `/backend-agent`), its own reports screen, and its own FO proxy routes (`app/api/faborch/*`), all built on `lib/faborch/client.ts` `fetchFo()`.
   - **Preview** is whole-application embedding. FabOrchestrator's own pages, assets and API are served on the PWA origin through `proxy.ts`, then `app/fo-gateway/[...path]/route.ts`, then FO. There is one login, and the FO token is injected on the server side.
   - **Preview talks to production FO with real user sessions** (`fly.preview.toml:50`; that CloudFront host is production FO [team-record]), so it is already a production-data system (G19).
3. **The review did not cover the gateway.** It read the committed `main` branch. The gateway (files dated 9–10 Sept) is uncommitted, so none of the 50 findings concern it. The gateway's own defects, and the readiness gaps found since, are recorded here as **G1–G31** (§8.2), from the 23–24 September verification and design-review audits.
4. **About 20 of the 50 findings live in code that the embedding direction proposes to retire** (`docs/STATUS.md:1036-1044`): the PWA's own chat and reports screens, its cockpit, and `app/api/faborch/*`. That code is **production-live until a cutover happens**. Each such finding can be:
   - contained now, because it is a production risk;
   - fixed properly, if the screen survives;
   - closed by retirement.

   **Choosing between those depends on the cutover date and on which screens survive, which is a team decision (RP0, checkpoint CP0).** Package RP8 collects all of these findings in one place.
5. Some defects cross both modes and are production-live regardless of the cutover:
   - **Login protection (B2/B3).** `/api/pwa/auth/login` is the only way in, in both modes; FO's own login is denied at the gateway (`lib/gateway/registry.ts:162`), and the FO clone has no login throttle of its own.
   - **`fetchFo` timeouts (B4)**, including sign-out, which waits on FO with no deadline (G21).
   - **Session cleanup (m3) and signing-key management (m2).**
   - **Security headers (M12).**
   - **The service worker (M14–M16).**
   - **Observability (M18).**

---

## 2. Roadmap summary

| RP | Architectural area | Findings owned (primary) | Depends on | Review required? | Scope |
|---|---|---|---|---|---|
| **RP0** | Embedding delivery decisions and scope (decision gate, no code) | G11, G19 | — | **CP0** (mandatory, first) | BOTH |
| **RP1** | FO embedding: gateway and routing boundary contract | B5, G2, G4, G12, G13, G14, G15, G16, G17, G18, G31 | RP0 | **CP1** | PREV (B5, G2 and G13 touch BOTH/PROD) |
| **RP2** | Authentication and session lifecycle (incl. idle) | m2, m3, G5, G10, G20, G30 | RP0, RP1 (embedded half only) | **CP2** | BOTH |
| **RP3** | Login protection and abuse control | B2, B3, m1, m5 | RP0, RP1 (client identity) | CP0 answer (shared accounts: decided 24 Sept) | BOTH |
| **RP4** | FO request lifecycle: timeout, cancellation, upstream contract | B4, G1, G21, G22, M4, M5, M7 | RP1 (gateway half), RP10-A | **CP3** | BOTH |
| **RP5** | Error contracts and error presentation | M2, M6, m4, m11, G8, G23 | RP2, RP4, RP10-A | CP3 | BOTH |
| **RP6** | Conversation authorisation at the gateway | M3, G3, G7 | RP0, RP1, RP10-A | CP1 (and the FO decision at CP0) | PREV (M3 also PROD) |
| **RP7** | Browser security policy for a shared origin | M12, G9, G24, G25, G26, G32, G33 | RP1 | **CP4** | BOTH |
| **RP8** | PWA-native chat, cockpit and reports (retirement candidate) | B1, M1, M8, M9, M10, M11, M13, m6, m7, m8, m9, m10, m12, m13, m19, N4, N5, N6 | **RP0 (blocked)**, RP10-A; retirement after RP10-B and the cutover | CP0 | PROD |
| **RP9** | Installable-app lifecycle: service worker, caching, offline, updates, manifest | M14, M15, M16, m14, m15, N2 | RP1 | CP4 (manifest id is a decision) | BOTH |
| **RP10-A** | Engineering enablers: observability, behavioural test harness, build guards, dependency hygiene | M17, M18, m16, m17, m18, N1, N7, G28 | — | — | BOTH |
| **RP10-B** | Deployment, capacity, rollback and documentation readiness | N3, N8, G6, G27, G29 | RP2, RP3, RP4, RP5, RP6, RP7, RP9 | **CP5** | BOTH |

**Totals:** 50 review findings plus 33 verification findings (G1–G33). Every one has exactly one owning package (§8).

---

## 3. Jothi's priorities, and where to study each one

The table is ordered by Jothi's priority, which is also the recommended **study** order. The **implementation** order in §5 differs where dependencies or production risk require it; each difference is explained there.

| # | Jothi's topic | Primary package | Also appears in | Why it sits there |
|---|---|---|---|---|
| 1 | **Application embedding** | **RP1** (after the RP0 decisions) | RP2 (the cookie→bearer bridge, `fo-shell.js`), RP4 (gateway timeouts), RP6 (conversation authorisation), RP7 (headers and CSRF on a shared origin), RP9 (the service worker and manifest injected into FO pages) | The gateway *is* the embedding. Every other package has an "embedded" half that depends on understanding it |
| 2 | **Enterprise PWA characteristics** | **RP9** (install, update, offline, identity) | RP7 (security headers, CSP), RP2 (session security), RP5 (error UX), RP10-A and RP10-B (observability, deployment, capacity). See Appendix A | "Enterprise PWA" is a checklist that cuts across boundaries; Appendix A maps each characteristic to a package |
| 3 | **Session management** | **RP2** | RP3 (login protection), RP1 (the bridge), RP5 (session-expired errors) | One lifecycle spanning two credentials: the PWA HMAC and the FO token |
| 4 | **Error handling** | **RP5** | RP4 (timeouts create a new error class), RP10-A (logging) | One envelope and one presentation for every PWA-originated failure |
| 5 | **Response timeout** | **RP4** | RP1 (gateway), RP9 (service-worker navigation deadlines, M14) | Every place the PWA waits on FO |
| 6 | **Session idle time** | **RP2**, stage 6 | RP1 (`fo-shell.js` idle watcher) | Idle is a state in the session lifecycle, not a separate subsystem. **The two modes behave differently**; see the per-mode table in RP2 |

---

## 4. Architectural fault lines

A fault line is a boundary where one kind of decision is made, in one set of files, with one family of failure modes. Each fault line **Fn** corresponds to package **RPn**.

| F | Boundary | Where it lives | Why it is one coherent unit of work |
|---|---|---|---|
| F0 | **Delivery decisions for the embedding direction** | `docs/plan/*`, `docs/STATUS.md`, `fly*.toml` | The direction is given; the cutover, the scope, and which code has a future are not. Every other package's scope depends on these answers |
| F1 | **Embedding / routing contract** | `proxy.ts`, `app/fo-gateway/[...path]/route.ts`, `lib/gateway/{registry,path,headers,upstream,destinations,html-inject,body-limit}.ts`, `public/fo-shell.js`, `next.config.ts` (`assetPrefix`); the one trusted client identity used by the gateway, `fetchFo` and the limiter | One question: *who owns this path, which methods and bodies may cross, and who is the caller?* The decisions are made in `proxy.ts` (ownership), the route (forwarding) and `lib/gateway` (policy) |
| F2 | **Session lifecycle** | `lib/auth.ts`, `lib/auth-middleware.ts`, `lib/faborch/session.ts`, `lib/gateway/auth-bridge.ts`, `app/api/pwa/auth/{login,logout,me}`, `components/fab/use-session.ts`, `components/login-page.tsx`, `public/fo-shell.js` | Two credentials (the PWA HMAC in localStorage and the FO token in an httpOnly cookie) bound by a fingerprint, with one lifecycle: create, use, idle, expire, log out, revoke |
| F3 | **Login abuse** | `app/api/pwa/auth/login/route.ts`, `lib/rate-limit.ts` | The single public endpoint in front of production FO's identity store. Its concern is adversarial (guessing, lockout, CSRF), not lifecycle |
| F4 | **The PWA→FO request lifecycle** | `lib/faborch/client.ts` (`fetchFo`, 10 callers), the gateway's `fetch` (`route.ts:169`), `lib/faborch/stream.ts` | Every place the PWA waits on FO: deadlines, cancellation, lifetime caps, response shape |
| F5 | **Error contract** | `lib/faborch/errors.ts`, every surviving route's error branches, `auth-middleware.ts` `unauthorized()`, gateway error returns, the client error rendering | What a failure *means* on the wire, before and after a stream has started, and what the user is told to do |
| F6 | **Conversation authorisation at the gateway** | `lib/gateway/ownership.ts`, `lib/faborch/owns.ts` | FabOrchestrator's `/api/chat` and `/api/modeling-agent/chat` do not check who owns a `conversationId` ([FO-clone]). The gateway compensates. The PWA-native half of this check retires with RP8 |
| F7 | **Browser security policy for a shared origin** | `next.config.ts` `headers()`, `lib/gateway/headers.ts` (response side), `proxy.ts` redirect responses, `lib/gateway/auth-bridge.ts` (the CSRF invariant) | FO's scripts and the PWA's scripts run on one origin. What the browser is told about framing, transport, caching and scripts, and what stops cross-site requests, is one policy |
| F8 | **PWA-native chat, cockpit and reports** | `components/fab/screens/{agent-chat,landing,landing-ask,reports}.tsx`, `nav-drawer.tsx`, `artifact-sheet.tsx`, `app/fabinsight/*`, `app/api/faborch/*`, `lib/faborch/{conversation,history}.ts`, `components/fab/use-session.ts` (per-screen fetch) | Everything that disappears together if the proposed retirement happens: UI state, context and persistence policy, generated-content framing |
| F9 | **Installable-app lifecycle** | `public/sw.js`, `components/register-sw.tsx`, `app/layout.tsx` chunk guard, `app/offline/page.tsx`, `public/manifest.webmanifest`, the manifest and SW injected by `lib/gateway/html-inject.ts` and `fo-shell.js` | Install, update, offline and recovery: what a PWA is beyond a website |
| F10-A | **Engineering enablers** | Logging (11 `console.error`/`warn` calls in 8 files), `__tests__/`, `eslint.config.mjs`, `package.json`, the server/client module boundary | Tools every other package needs *before* it can prove anything: logs, behavioural tests, build guards |
| F10-B | **Deployment and capacity readiness** | `fly*.toml`, `README.md`, `CLAUDE.md`, topology and load tests | Whether the system can be run at the target scale by someone other than its author. It validates everything else, so it comes last |

---

## 5. Dependency order

### 5.1 Graph

```
                ┌───────────────────────────────────────────┐
                │ RP0  Delivery decisions & scope ── CP0 ──  │ direction given (team-record);
                │ (no code)                                  │ decides cutover, whole vs surfaces,
                └──┬─────┬──────┬────────┬─────────┬────────┘ shared accounts, MDL scope, FO asks
                   │     │      │        │         │
                   │     │      │        │         └──────► RP8 Native chat (blocked until CP0)
                   │     │      │        └────────────────► RP3 Login protection
                   │     │      └──(idle, shared accounts)─► RP2 Session lifecycle CP2
                   │     └──(FO ownership ask)──┐
                   ▼                            ▼
   ┌────────────────────────────┐        ┌───────────────┐
   │ RP1 Embedding contract CP1 │──────► │ RP6 Gateway   │
   └──┬─────────┬───────┬───┬───┘        │ authorisation │
      │         │       │   │            └───────────────┘
      │         │       │   └──────────► RP9 App lifecycle (SW)
      │         │       └──────────────► RP7 Browser security policy CP4
      │         │                             ┆ CSRF invariant constrains
      │         │  (embedded half)            ▼ RP2's token-storage decision
      │         └──────────────────────► RP2 Session lifecycle CP2
      │  (gateway half)                       │
      ▼                                       │
   RP4 Request lifecycle CP3                  │
   (fetchFo half starts after CP3)            │
      │                                       │
      └────────► RP5 Error contracts ◄────────┘

   RP10-A Enablers (logging, harness, build guards) ┄┄► RP4, RP5, RP6, RP8   (starts now)
   RP7 stage 1 (the CSRF invariant test) also starts now

   RP2, RP3, RP4, RP5, RP6, RP7, RP9 ──► RP10-B Deployment & capacity CP5 ──► production cutover
                                                                              └─► RP8 retirement (if agreed)
```

**Why each dependency edge exists:**

| Edge | Reason |
|---|---|
| RP0 → RP1 | The gateway contract (supported routes, `whole` vs `surfaces`, the MDL routes) is fixed by the production scope decided at CP0 |
| RP0 → RP2 | Idle ownership, shared-account semantics and attribution requirements are team decisions |
| RP0 → RP3 | Account-keyed lockout means something different if several people share one account |
| RP1 → RP3 | The limiter's source bucket is keyed by RP1's `clientIdentity` and nothing else (added in revision 3.5; implied by both sections and by the m1 row but missing here). **Not** a dependency in the other direction: RP1 ships its own in-process G31 bucket first, and RP3's stage 9 later replaces it with the shared store, with RP1's G31 test as the acceptance (delta review RP1/RP3-D2) |
| RP0 → RP6 | The long-term fix (FO checks ownership) conflicts with the "no FO change" constraint; CP0 decides whether to ask FO |
| RP0 → RP8 | Fix or retire, and the cutover date, decide how much work each native-chat finding deserves |
| RP1 → RP2 | **Only the embedded half** (the bridge, G5, `fo-shell.js`) needs the gateway understood. m2 and m3 need only CP2 |
| RP1 → RP4 | **Only the gateway half**: timeout classes come from the owner-class table. The `fetchFo` half is independent and starts after CP3 |
| RP1 → RP6 | The gateway ownership check is part of the gateway's contract for `fo-api` chat paths |
| RP1 → RP7 | Headers must cover gateway responses, and the CSP must be designed around FO's scripts |
| RP1 → RP9 | The service worker controls FO's documents once `fo-shell.js` registers it |
| RP7 ⇢ RP2 | A constraint, not an ordering: the CSRF invariant (G26) forbids any token-storage design that would let a cookie alone authenticate a request to FO |
| RP2 → RP5 | Session error codes (`session_invalid`, `faborch_session_expired`) take their meaning from the lifecycle |
| RP4 → RP5 | The timeout, cancellation and lifetime-cap work creates error classes the contract must include |
| RP10-A ⇢ RP4, RP5, RP6, RP8 | Budgets need timing logs; behavioural tests need the harness; B1 needs a reproduction harness |
| RP2, RP3, RP4, RP5, RP6, RP7, RP9 → RP10-B | Readiness validates the finished packages under the target topology |
| RP10-B → cutover → RP8 retirement | Retired code is deleted only after the cutover it depends on |

The graph is acyclic. The RP1 → RP3 edge is not drawn in the picture above; the table is authoritative.

### 5.2 What can start, what must wait

- **Must come first:** RP0 (decisions, no code), then RP1 stages 1–3 (study, trace, contract table; no application change).
- **Can start now, independent of every decision:** RP10-A stages 1–2 (request-ID logging, route-level behavioural test harness); RP7 stage 1 (write down and pin the CSRF invariant, G26: it needs no decision, and it protects a property a later decision could otherwise remove).
- **Can start as soon as its decision exists:**
  - RP3, now that the shared-account question is answered (24 Sept: not a PWA requirement) and once RP1's `clientIdentity` contract exists (CP1);
  - the `fetchFo` half of RP4, once CP3 has set budgets;
  - **RP8 stage 1 (B1 containment)**, once CP0 confirms the cutover is far enough away to justify it. B1 writes a turn into the wrong conversation in production today.
- **Blocked by team decisions** (status as of revision 3.7; struck items were decided on 24 September):
  - RP1 stages 4+: ~~MDL routes, the G2 body policy~~ decided; still needs CP1's row-by-row approval of the route policy table;
  - RP2: ~~idle policy, revocation, token storage~~ all decided; RP2 stages 3+ wait for CP2's approval of the design as written, with the collapse default for the pre-password 403 (§9 question 52);
  - RP4's budgets;
  - RP6 (the FO request);
  - RP7 (CSP strictness with FO's scripts on the origin);
  - RP9 (changing the manifest `id`);
  - RP10-B (topology, capacity targets).
- **Postponed until the architecture is settled:** RP8 beyond stage 1.
- **Not planned any more (revision 2):** a streaming idle wrapper on the native chat route, and error-contract migration of native routes that retire. Both would be deleted at cutover.

### 5.3 Recommended sequence, and why it isn't severity order

> **Build-order correction (revision 3.12, WHOLE-R9).** The §2/§5 edges are *design* dependencies. Several sections also consume *contracts* other RPs define (RP5's status table, RP4's deadline helper and call classes, RP1's `clientIdentity` and body classes). To avoid each consumer inventing its own, those contracts are **phase-1 deliverables**: `lib/errors/contract.ts` (RP5 status table), `lib/faborch/deadline.ts` and `call-classes.ts` (RP4), `lib/gateway/client-identity.ts` and the body classes (RP1 stage 4). With them in phase 1 the RP4 ↔ RP5 mutual reference is not a build cycle, and RP3 can be built in phase 2 as ordered. `check_plan.py` compares §2 with §5 only; comparing each section's Dependencies line with §2 is an RP10-A implementation task.

| Phase | Packages | Reason |
|---|---|---|
| 1. Understand and decide | RP0 → **CP0**; RP1 stages 1–3 → **CP1**; RP10-A stages 1–2; RP7 stage 1 (the CSRF invariant test) | Jothi's #1 priority. Every later scope depends on it. Changes no application code except test and logging infrastructure |
| 2. Contain production-live risk (both modes) | RP3; **CP3**, then the `fetchFo` half of RP4 (bounded calls, sign-out deadline, total lifetime cap); RP8 stage 1 (B1) if CP0 justifies it | Login, sign-out and `fetchFo` are live in production **and** survive the cutover. Timeout work comes before session work here because it needs no embedding decision, only budgets |
| 3. The embedded boundary and the session | RP1 stages 4+; the gateway half of RP4; RP6; **CP2**, then RP2 | Jothi's #1, #3 and #6. Idle sits inside RP2 |
| 4. Errors and browser policy | RP5; **CP4**, then RP7; RP9 | Errors come after timeouts and session because both create error classes. Headers and the service worker now apply to FO's pages too |
| 5. Production readiness | RP10-B → **CP5** → cutover → RP8 retirement (or RP8 keep-path, if CP0 decided some screens survive) | Validates everything under the target topology before any cutover |

---

## 6. Design-review checkpoints

**Rule:** no implementation listed under "Do not begin" may start before the checkpoint has happened and its decisions are written down.

**Checkpoint numbers are identifiers, not a sequence.** They follow the package numbers. In time, CP3 (timeout budgets) comes before CP2 (session semantics), as the phases in §5.3 show.

### CP0 — Delivery decisions and scope (after RP0)

- **You should understand:**
  - the given direction (Jothi, 2026-09-06 [team-record]) and why the same-origin gateway was chosen over an iframe or a `/fo/` sub-path;
  - what production runs today and what preview runs;
  - which findings sit in code proposed for retirement;
  - the scope conflicts listed below.
- **Bring:**
  - (1) the written requirement, for Jothi to confirm;
  - (2) a one-page comparison of production and preview;
  - (3) the §8 matrix filtered by "Fate";
  - (4) a draft decision record (ADR) with options for each open question.
- **Decisions needed (Jothi):**
  - The production cutover criteria and date.
  - ~~`whole` or `surfaces` mode in production.~~ **Decided 24 Sept: `whole` mode.** `surfaces` stays only as the rollback step.
  - Which PWA-native screens survive the cutover (chat, reports, cockpit), and for each retire-candidate finding: contain now, or leave to retirement.
  - ~~Are shared FO accounts (several people, one login) allowed, and is per-person attribution required?~~ **Decided 24 Sept (recorded in RP2 and §9 question 5): not a PWA requirement; one account per person; attribution and sharing prevention are FO account-management matters.**
  - ~~**The Master Data Load agent is excluded** (`STATUS.md:3286`). Should its routes be denied at the gateway (G16)?~~ **Decided 24 Sept: keep Master Data Load available through the PWA for now**; Jothi may remove it later.
  - **"No FO change"** versus asking FO to add an ownership check to `/api/chat` (RP6).
  - **Preview governance:** preview uses production FO with real sessions (G19).
  - Should the uncommitted embedding work be committed or branched to protect it?
- **Do not begin:** RP8 (any stage, including B1 containment, until the cutover date is known); RP6 stages 3+; any deletion of PWA-native code.

### CP1 — Embedding boundary contract (after RP1 stages 1–3)

- **You should understand:**
  - the full `/chat` trace (document, `/_next` asset, `/api/chat`, `/api/auth/logout`);
  - the split of responsibility between `proxy.ts`, the route and `lib/gateway`;
  - how Next handles bodies before middleware (G2, verified);
  - the CSRF invariant (G26).
- **Bring:**
  - (1) the request-trace diagram;
  - (2) the boundary contract table: owner class → methods → auth mode → body policy → timeout class → request headers → response headers and cache → cookie effects;
  - (3) the list of FO API subtrees forwarded today, marked safe, admin-only, expensive or unknown (G15);
  - (4) the G2 evidence (Appendix B) and the upload options.
- **Decided on 24 September 2026** (recorded in RP1, Design decisions): the API is an explicit allow-list with per-row methods (G14, G15); Master Data Load routes stay available (G16); the body limit is 20 MB as one shared constant (G2); the trusted client identity is forwarded to FO (G4, G13); two-origin redirects and the preview-only `FO_UI_SPLIT_ALLOWED` flag (G17, G18) are derived, not decided.
- **Decisions still needed at CP1:**
  - approval of the route policy table (RP1 part 5) row by row;
  - FO owners: production nginx ceiling (50 MB per both clones), and whether `fabinsight/warm` and `fabinsight/render` need PWA-side rate limiting;
  - Jothi: the phone-path consequence of 20 MB (attachments above ~14 MB refused from the PWA).
- **Do not begin:** RP1 stages 4+; the gateway half of RP4; RP6; the gateway parts of RP7; the embedded half of RP9.

### CP2 — Session semantics (before RP2 implementation)

- **You should understand:**
  - the two-credential model and its fingerprint binding;
  - every place expiry is detected;
  - **idle behaviour in each mode** (the table in RP2);
  - the three-phones analysis;
  - OWASP session-management guidance.
- **Bring:**
  - (1) a session state diagram (login → active → idle → expired / logged-out → revoked) across the PWA and FO;
  - (2) an inventory of expiry-detection sites;
  - (3) the accepted-risk statement for G10 (RP2 part 1), for the reviewers to see and keep visible;
  - (4) the CSRF invariant (G26) as a constraint on token storage.
- **Decided on 24 September 2026** (recorded in RP2, Design decisions): the absolute PWA limit stays 12 hours; FO's idle semantics stay (API activity); no PWA session store, FO is the revocation authority; shared accounts are not a PWA requirement; the forced-change login probe (G20); key rotation with explicit non-secret key ids (m2); the two-credential model with the bearer in localStorage is accepted and G10 recorded as an architectural risk mitigated by RP7.
- **Decisions still needed at CP2:**
  - approval of the RP2 design as written (the state table, the two end-of-session paths, the login probe);
  - the revoke deadline value (proposed 3 s; set with the other budgets at CP3);
  - the presentation of FO's pre-password 403 at login (RP2 step 2a, delta review RP2-D1): collapse into "incorrect email or password" is the default unless CP2 or CP3 decides to disclose as FO does (§9 question 52);
  - FO owners: whether a password change should revoke other sessions, production idle and expiry values, and a forced-change test account for the live check.
- **Do not begin:** RP2 stages 3+.

### CP3 — Timeout budgets and error contract (before RP4 stage 3 / RP5)

- **You should understand:**
  - the two phases of `fetch` (headers, then body);
  - total versus idle deadlines;
  - that `maxDuration` is **not** enforced by `next start` [Next-src], so nothing caps a request's lifetime today;
  - the difference between cancellation and timeout;
  - why Chetan's B4 fix was partial.
- **Bring:**
  - (1) latency percentiles from a **new measurement run**: the existing scripts (`scripts/latency-baseline.mjs`, `embed-latency-check.mjs`) record medians of a few runs from one machine, so they must be extended to many runs and a p95/p99 before any budget is set;
  - (2) a table of proposed budgets per call class, each labelled measured / inherited / chosen;
  - (3) the error contract draft: status and code table, the rule for failures after a stream has started, and the code → screen → action table.
- **Decisions needed:**
  - the budgets, including the sign-out deadline and the total lifetime cap;
  - a retry policy;
  - whether to add a circuit breaker;
  - whether uploads get a total deadline;
  - user-facing wording;
  - whether gateway-originated errors must use FO's error envelope so FO's client can render them;
  - how a suspended or deleted FO account is presented. Constraint from delta review RP2-D1: FO's login 403 is answered **before the password is checked**, so RP3 counts it as a failed attempt and RP5 presents it exactly as a wrong password unless the team decides to disclose as FO does; only the post-password `/me` probe 403 may carry a distinct code (RP2 part 3, step 2).
- **Do not begin:** RP4 stages 3+; RP5 stages 2+.

### CP4 — Browser security and app identity (before RP7 stage 3 / RP9 stage 7)

- **You should understand:**
  - CSP (nonces, report-only mode);
  - what the gateway's allow-lists do to FO's headers;
  - the CSRF invariant;
  - what the manifest `id` means for installed apps.
- **Bring:**
  - (1) a CSP report-only trial log from preview, naming the pages and the period;
  - (2) the proposed response-header policy for FO API responses (`private, no-store`; `Retry-After` pass-through);
  - (3) the consequences of changing the manifest id;
  - (4) a security-verification checklist in OWASP ASVS terms, covering only the PWA's own controls (authentication and session, RP2 and RP3; access control, RP6; input and body limits, RP1; API and headers, RP7; configuration and secrets, RP10-B), each line pointing at the test in this plan that proves it. FabOrchestrator's controls are not on it;
  - (5) the current browser and device floor: the installed iOS shell needs iOS 16.4+ (`CLAUDE.md:566`), and the RP9 tests run on Chromium and WebKit;
  - (6) the G10 residual (RP2 part 1 row): with the FO-document policy carrying `'unsafe-inline'` (RP7 part 4), inline-script XSS in FO's pages can still read the bearer until §9 question 50 is answered.
- **Decisions needed:**
  - how strict the CSP should be, given FO's scripts;
  - whether the PWA may ever be framed;
  - HSTS preload;
  - whether to change the manifest `id` (changing it creates a **new** app identity, so existing installs are orphaned);
  - the ASVS level the PWA's controls are verified against, and who signs the checklist;
  - the supported browser and device matrix (minimum iOS and Safari, Android and Chrome, desktop), which RP9's behavioural tests then run on. FabOrchestrator's embedded pages must render on the same matrix; that is FabOrchestrator's to confirm (§9).
- **Do not begin:** an enforcing CSP; changing the manifest id.

### CP5 — Production readiness (before any production cutover)

- **You should understand:**
  - which state is per-process (the rate limiter, the ownership cache) and what multiple instances do to it;
  - `SESSION_SIGNING_SECRET` distribution;
  - Fly's effective concurrency limits for long-lived streams, and that Fly is only the present preview/development deployment: the production target is AWS;
  - observability coverage.
- **Bring:**
  - (1) a topology proposal (instance count, regions, concurrency settings);
  - (2) results of the load-test matrix in RP10-B;
  - (3) the list of SLOs and alerts;
  - (4) a **rehearsed** rollback plan: the flag goes off and `classify()` returns `pwa` for everything, with the RP10-B rehearsal record showing what an installed phone did and how long restoration took;
  - (5) the response runbook draft: the PWA-side levers and their owners (RP10-B);
  - (6) the **external FO go-live dependencies**, each confirmed or still open: production's change-password clears `forcePasswordChange` (RP2, G20; without it the forced-change flow is not accepted for production), the nginx body ceiling (RP1), production idle and expiry values (RP2), and the route inventory (RP1).
- **Decisions needed:**
  - target registered, active and concurrent users;
  - multi-instance or not;
  - a shared store for the rate limiter;
  - the log and metrics platform;
  - the AWS topology: instance memory, and which components front the PWA (ALB, API Gateway, Lambda, CloudFront), because they set the real body and timeout ceilings (RP1 part 3 is validated against them here);
  - the deployment strategy and the staged cutover: preview, then a named pilot group, then everyone;
  - the dependency-audit severity threshold and the update cadence (RP10-A, G28);
  - who owns incident response and vulnerability intake for the PWA, and how a report reaches them (organisational; the plan records the answer, not the process);
  - the date of the cutover.
- **Do not begin:** production `FO_EMBED_MODE`; `--ha` deployment; removing PWA-native code.

---

## 7. Work packages

### First-pass architecture overview (revision 3.6, 27 September 2026; historical)

> **Historical.** This overview records the first pass. Where it differs from the detailed sections or the Design Review Summary (for example "close" versus "error" for streams, "icons" in the worker cache, RP9 activating immediately), the detailed sections are authoritative.

RP1 and RP2 are frozen designs. RP3 is a detailed design awaiting decisions and its review. RP4 to RP10-B below are a **whole-architecture first pass**: each section now states a proposed architecture (components, flows, failure behaviour, trust boundary, finding map, dependencies, open decisions, acceptance criteria) at the depth needed to see the whole system and its interactions, not yet at the depth of RP1 to RP3. None of RP3 to RP10-B is frozen. The point of writing them together was to find the seams first.

**The system, end to end.** A phone installs the PWA (RP9) and opens it on one origin. Every navigation and every request meets `proxy.ts`, which classifies the path (RP1): the PWA's own routes, a denied FO path, an FO API row, FO static, or an FO document. Documents are gated by the FO cookie's presence and forwarded anonymously with the PWA's shell injected; API rows go through the bridge (RP2), which injects the real FO token only when the PWA bearer and the httpOnly cookie agree, refuses a bad bearer, refuses a bearer-less request on a `required` row, and forwards the two public rows anonymously under a small cap (G31). Sign-in is the PWA's own route (RP3): same-origin and JSON-only before the body, a two-dimension limiter (account failures, source rate) reserved before FO is called and settled after, then RP2's login steps. Every wait on FO has a class-appropriate deadline and a lifetime the PWA enforces (RP4); every failure the PWA originates has one envelope and one status table, and FO's own failures pass through untouched (RP5). Chat turns carrying a `conversationId` are refused unless the caller owns it, proven with one small FO call and cached under a hashed key (RP6). Every response carries the same security headers and cache rules, FO API responses are `private, no-store`, and the CSRF invariant (a cookie alone never authenticates a request to FO) is a release-blocker test (RP7). The service worker controls PWA and FO documents alike, caches only the offline page and its icons, never a document or an API response, and has a kill switch (RP9). The PWA-native chat, cockpit and reports are redirected at cutover and deleted after a soak (RP8). Logs carry one request id from phone to FO, tests exercise behaviour on a stub FO and a real Next server, and CI gates every change (RP10-A). Production runs on AWS behind CloudFront and an ALB with 2+ instances and a shared counter store, load-tested and with a rehearsed rollback (RP10-B).

**How RP3 to RP10-B fit together** (the seams that were checked while writing them):

| Seam | What has to agree |
|---|---|
| RP3 ↔ RP1 ↔ RP2 | The source key is RP1's `clientIdentity` and nothing else; a `null` identity disables the source dimension loudly; the same-origin helper RP2's logout uses is RP3's, with `self` from a configured `PUBLIC_ORIGIN`; RP3's stage 9 later hosts RP1's anonymous cap under its own namespace |
| RP4 ↔ RP2 ↔ gateway streaming | RP2's revokes (four sites) run under RP4's `revoke` class, caller signal never combined; streams get headers, idle and lifetime deadlines in the gateway and are **errored, never closed**, without writing into FO's stream; FO does not stop work on abort ([FO-clone], §9 question 47) |
| RP5 ↔ RP4 ↔ FO | One status table: 503 unreachable, 504 timed out, 502 unusable answer; FO-originated errors pass through untouched; the envelope keeps `error` so FO's client renders it; the pre-password login 403 stays byte-identical to a wrong password (RP2-D1) |
| RP6 ↔ RP1 ↔ FO ownership | RP1 has already buffered the chat body; proof is FO's own `GET /api/conversations/{id}` (which checks ownership in the clone); the gateway refuses rather than strips once the native client retires; keys are fingerprints |
| RP7 ↔ RP1 ↔ RP2 | Headers are set on four response kinds including gateway responses and middleware redirects; the CSRF invariant test has the two G31 outcomes (`required` → 401 unforwarded, `optional` → anonymous); FO's documents get a report-only CSP whose strictness `'unsafe-inline'` limits, stated plainly for CP4; the CSP report endpoint uses RP3's anonymous-cap namespace |
| RP9 ↔ RP2 ↔ RP7 ↔ RP1 | The worker never caches a document, an API response or anything `no-store`, so logout is never defeated by a cache; navigation deadlines follow RP4's `document` class; the worker controls FO documents because RP1 injects its registration; the kill switch is a rollback lever |
| RP8 ↔ RP0 ↔ RP10-B | Cutover is a flag flip with the native code still deployed; deletion follows a soak; B1 is the one containment before cutover |
| RP10-B ↔ RP1, RP3, RP4, RP7 | The AWS edge sets body ceilings (none below 25 MiB on option A), trusted hops, and the timeouts every RP4 deadline must sit inside; the shared store is where RP3's multi-instance story lands; HSTS has one owner |

**Cross-RP contradictions found in this pass, and their status:**
1. **RP7's CSRF invariant test vs frozen RP1's G31.** RP7 (revision 3.4 text) said the test is "a request carrying only the cookie is forwarded without `authorization`" for every `fo-api` path; RP1 (frozen) refuses cookie-only requests on `required` rows with 401. RP7 is corrected in this revision (part 3). **Frozen RP2's G10 finding-map row** still describes the old outcome and cites `injection.test.ts:53` as "kept" where RP1 says it is narrowed to the `optional` rows. Both RP2 cells (the G10 test cell and the combined RP1/RP2 test bullet) were corrected in revision 3.7 under the second delta review (`DELTA SAFE`); RP7 part 3 states the corrected test.
2. **RP6's strip-versus-refuse.** The current gateway strips a non-owned id and forwards the turn unpersisted, which was right for the PWA-native client's own bug (B1) and wrong for FO's client, where it silently writes into another thread. First pass proposes refusing once the native client retires; the native route keeps stripping until RP8. Not a frozen-RP conflict; recorded so CP1 sees it.
3. **RP9's immediate activation vs RP8's rollback.** `skipWaiting` plus `clients.claim` means a bad worker takes over every open FO page at once; RP10-B's rollback therefore needs RP9's kill switch as a lever, and RP9 now designs it as a route rather than a static file.
4. **RP4's edge dependency.** No deadline value can be chosen until the production edge is known: CloudFront's origin response timeout and the ALB idle timeout bound RP4's stream idle deadline from above, and FO's 15 s keep-alive is what keeps a turn alive through both. CP3 cannot close before CP5's topology answer, or must decide with an explicit assumption. Recorded in RP4 and RP10-B; §9 question 48.

**As of revision 3.8** every section from RP3 to RP10-B is at design-review depth; seven have had their first independent review round with corrections applied (see each section's review record), RP7 and RP10-A await theirs; none is frozen. The earlier readiness note, kept for the record: RP1, RP2 (frozen) and RP3 (after its decisions and review) are at design-review depth. RP4, RP5, RP6 and RP7 are close: each needs its CP values, one more pass on tests, and the independent review. RP9 needs its deadline values and the CP4 decisions before its review. RP8 is a decision record whose depth is correct for what it is. RP10-A and RP10-B need CP5's answers (topology, platforms, targets) before they can be more than proposals.

---

### RP0 — Embedding delivery decisions and scope (decision gate, no code)

**Purpose.** Turn the given embedding direction into written delivery decisions (cutover, scope, retirement) before any repair work starts.

**Why these findings belong together.** RP0 owns G11 (contradictory plans) and G19 (preview governance). Both are decisions about the programme, not code. Its real output is the **fate** of every other finding.

**Included findings.** G11, G19.

**Current architecture.**
- **The direction:** Jothi's fixed requirement of 2026-09-06 [team-record]: host the real FabOrchestrator, one login, no FO feature rebuilt. The chosen design is a same-origin gateway with FO at its own paths and cookie→bearer injection [team-record].
- Production runs the PWA-native app (`fly.toml` has no embed flag; live environment not checked).
- Preview runs whole-application embedding (`fly.preview.toml:95`). Pages come from a UI-preview build (`:60`); API calls go to **production FO** via CloudFront (`:50`; that host is production FO [team-record]).
- The embedding work (WP1–WP10) is uncommitted.
- `docs/plan/*` (6 Sept, untracked) recommends Option B, which would rebuild FO features in the PWA; that conflicts with the requirement.

**Known defects / failure modes.**
- Fixing code that is about to be deleted.
- Deleting production-live code before a cutover has been agreed.
- Two plans pointing new contributors in opposite directions (G11).
- Weeks of uncommitted work sitting on one laptop (G11).
- A preview environment handling production data without production controls (G19).

**Desired architecture.** A single approved decision record stating:
- the requirement, confirmed in writing;
- the production cutover criteria and date, and `whole` or `surfaces` mode;
- which PWA-native surfaces survive, and for each retire-candidate finding: *contain now*, *fix*, or *close by retirement*;
- the shared-account policy;
- the MDL scope, the "no FO change" position, and preview governance.

`docs/plan/*` is marked superseded (or not), explicitly.

**Relevant code/docs.** `docs/plan/MASTER_PLAN.md:142-200`, `docs/STATUS.md:320-335`, `:1022-1044` and `:3286`, `fly.toml`, `fly.preview.toml`, `lib/gateway/registry.ts:306-322` (the rollback: flag off means everything is the PWA's).

**Design decisions.**
- *Derivable from engineering principles:*
  - retire-candidates that are production-live and cause **data integrity** problems (B1) get containment unless the cutover is imminent;
  - cosmetic or performance findings in retiring code get none;
  - B5's memory bound comes from Next (G2), so it needs no separate containment.
- *Needs Jothi:* everything in CP0.

**Implementation stages** (all documentation):
1. Write down the requirement for confirmation.
2. Production-versus-preview comparison page.
3. A "Fate" column for every finding (§8 of this document is the draft).
4. Draft the decision record.
5. CP0.
6. Record the outcome; mark `docs/plan/*` superseded or current; record preview governance.

**Tests.** None; this package produces documents only.

**Acceptance criteria.**
- The decision record is signed off and dated, and names who decided each item.
- Every finding has an agreed fate.
- `docs/plan` and `docs/STATUS.md` no longer contradict each other on direction.
- The embedding work is committed or on a named branch.

**Regression risks.** None in code. The risk is organisational: retiring screens that users still rely on.

**Demo / verification.** Walk Jothi through production and preview side by side:
- production `/fabinsight` is the PWA chat;
- preview `/fabinsight` redirects with a 307 to FO's `/chat` (`proxy.ts:146-164`).

**Concepts to learn.** Architecture decision records; the strangler-fig migration pattern; feature flags as rollback; reverse proxy versus redirect versus iframe (see `docs/plan/MASTER_PLAN.md:156-170` for why the iframe was rejected).

**Design-review questions.**
- What must be true before production embeds FO?
- What is the rollback?
- Who maintains FO's mobile UI once the PWA no longer draws its own screens?
- Why is preview allowed to use production data?

---

### RP1 — FO embedding: gateway and routing boundary contract  *(Jothi #1)*

**Purpose.** Make the boundary where FabOrchestrator's pages, assets and API are served on the PWA's origin an explicit, tested contract: which paths and methods cross, what bodies may cross and how large, who the caller is, which upstream answers, and how redirects behave. This section is the **proposed corrected architecture**, written against the fixed target (installed PWA → same-origin gateway → the real FabOrchestrator UI and APIs, in `whole` mode). Decisions taken on 24 September 2026 are marked **[decided]**.

**Why these findings belong together.** They all concern how a request is classified and forwarded across the application boundary, and they are decided in the same three places (`proxy.ts`, the gateway route, `lib/gateway`). B5 belongs here because its real bound is the same Next body-buffering mechanism as G2. G4 and G13 are one decision: the trusted client identity, also used by RP3's limiter (m1) and RP4's `fetchFo`.

**Included findings.**
- **B5**: the native chat route parses an unbounded body before any check. Its real bound is Next's body limit (G2); the route retires with RP8.
- **G2 (verified)**: Next truncates every body that passes `proxy.ts` at `proxyClientMaxBodySize` (10 MB by default), so the gateway's 50 MB ceiling can never take effect; a declared-length upload above it becomes a misleading 502, a chunked one reaches FO truncated.
- **G4**: the audit client IP forwarded by the gateway comes from the first `x-forwarded-for` entry.
- **G12**: `whole` mode forwards any unreserved FO document by default. **[decided]** intended for documents; the API stays an allow-list.
- **G13**: `fetchFo` forwards no client identity, so FO's audit attributes every production PWA session to the PWA server. **[decided]** forward the trusted identity.
- **G14**: no method allow-list.
- **G15**: whole FO API subtrees are forwarded without a per-route review. Resolved by the route policy table below, built from FabOrchestrator's actual route files.
- **G16**: the Master Data Load agent's routes are forwarded although the agent is excluded from the PWA product. **[decided]** keep them available through the PWA for now; the size policy below is sized for them; Jothi may remove them later.
- **G17**: `Location` rewriting assumes a single upstream origin.
- **G18**: the `FO_UI_BASE_URL` page/API split is a preview device.
- **G31 (24 Sept):** the gateway forwards a request with no bearer to **every** allow-listed FO API path and lets FO answer 401, so the PWA origin is a relay to all of FO's API for unauthenticated callers, although only two endpoints need to be public.

**Current architecture** ([code]). For `GET /chat` on preview:
1. `proxy.ts` `proxy()` (`:112`) calls `classify()` (`lib/gateway/registry.ts:332-367`), which returns `fo-document`.
2. `gate()` (`:214-243`) checks only that the `faborch_token` cookie is **present and non-empty**; it does not validate it.
3. `toGateway()` (`:250-260`) performs an internal rewrite to `/fo-gateway/chat` and adds `x-pwa-gateway: 1`.
4. `route.ts` `handle()`:
   - checks the marker (`:72`);
   - re-checks path and owner (`:74-78`);
   - calls `bridgeAuthorization()`, but only for `fo-api` (`:85`). Documents and static assets are forwarded **anonymously**;
   - picks the origin with `upstreamOrigin()` (`upstream.ts:63-69`): documents and static assets go to `FO_UI_BASE_URL` if set, API calls to `FABORCH_BASE_URL`;
   - builds headers with `upstreamRequestHeaders()`, an allow-list (`headers.ts:48-62, 77-88`): it drops `cookie`, `authorization`, `host` and the marker, and adds `x-forwarded-for` and `x-forwarded-proto`;
   - calls `fetch` with `redirect: "manual"` and `signal: req.signal` (`:119-125, 169`);
   - applies `downstreamResponseHeaders()` (`headers.ts:109-125`), an allow-list that drops `set-cookie`, forces HTML to `no-cache`, rewrites `Location`, and adds `no-transform` plus `x-accel-buffering` for SSE;
   - calls `injectShellScript()` (`html-inject.ts`) to add the manifest, the Apple meta tags and `/fo-shell.js` before `</head>`, **streaming**.
5. `/_next/*` is `fo-static`, not gated, and served from the same UI build. The PWA's own chunks live under `/pwa-assets/_next/*` (`proxy.ts:122-126`, `next.config.ts` `assetPrefix`).
6. FO's API calls are `fo-api` and get the bridge (see RP2).
7. FO's `/api/auth/login` is **denied** (`registry.ts:162`).
8. **Every owner class accepts all seven methods** (`route.ts:238-244`). The registry and `proxy.ts` never look at the method (G14).
9. The API allow-list (`registry.ts:173`) forwards whole subtrees (G15). `underPrefix` (`:263-265`) respects path-segment boundaries.
10. Body handling: chat paths are read whole (`route.ts:138`, up to 20 MB, `ownership.ts:94`); everything else streams through `limitBody` with a 50 MB ceiling (`body-limit.ts:33`). Neither ceiling is reachable, because Next has already cut the body at 10 MB (G2).

**Known defects / failure modes.**
- **G2** ([runtime], verified 23 Sept). Next 16.1.4 reads the whole body of every body-carrying request that passes `proxy.ts` before the route runs, and keeps only the first 10 MB (log: "Request body exceeded 10MB … Only the first 10MB will be available"). Through the gateway: (a) a declared-length upload over 10 MB fails with `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`, because the gateway forwards the original `content-length` (`headers.ts:52`), reported as a **misleading 502 "Could not reach FabOrchestrator"** (`route.ts:170-173`); (b) a chunked upload over 10 MB **reaches FO truncated, as if complete**. The comments at `route.ts:23-25` and `body-limit.ts:70-72` ("not held in memory") are false at runtime. Each half was verified separately; the full browser→gateway→FO path is stage 2.
- **B5.** The native chat route calls `req.json()` before any size check (`chat/route.ts:95`). Its real bound is Next's limit. The route retires.
- **G4.** `clientIp()` (`route.ts:228-232`) prefers the first XFF entry, which the client may control. `lib/rate-limit.ts:70-76` already prefers the unforgeable `fly-client-ip`. FO's session audit records this value ([FO-clone] `lib/auth-middleware.ts:91-92`) and itself trusts the first XFF entry, so what the PWA forwards is what FO's audit shows.
- **G13.** `fetchFo` sends no `x-forwarded-for` or `user-agent` (`client.ts:527-529`). FO's audit therefore attributes every production login to the PWA server's IP and Node's user agent, and any future per-IP throttle at FO would put every PWA user in one bucket.
- **G12.** In `whole` mode, step 5 of `classify()` forwards any document path nobody reserved. That is the intended behaviour for pages (a new FO page needs no PWA change). New `/api/*` paths are `unknown` and get a 404, which is also intended (**[decided]**: explicit API allow-list).
- **G14.** A `DELETE /_next/...` or `PUT /chat` is forwarded to FO. FO decides, so the risk is low, but it is no defence in depth.
- **G15.** The forwarded subtrees were never reviewed route by route. The inventory below closes that.
- **G16.** The excluded agent's routes are forwarded. **[decided]** they stay, so the body policy must serve `.xlsx` uploads.
- **G17.** `rewriteLocation` rewrites only the origin *that request went to* (`route.ts:175`, `headers.ts:101-106`). With pages from `FO_UI_BASE_URL` and the API from `FABORCH_BASE_URL`, a redirect naming the other origin would send the phone off the PWA [inferred].
- **G18.** The `FO_UI_BASE_URL` split (a separate UI build over plain HTTP on Fly's `.internal` network) exists only to preview an unshipped FO UI change (`upstream.ts:9-16`). Nothing stops it being set in production by mistake.
- **G31.** `bridgeAuthorization` returns `forward-anonymous` for any `fo-api` request without a bearer (`auth-bridge.ts:56-57`), by design, because FO's root layout fetches `/api/platform-theme` before sign-in. The effect is wider than intended: an unauthenticated caller can make the PWA server open a connection to FO for any of the ~20 allow-listed API prefixes, which is a relay and an amplification path against FO, and it means FO, not the PWA, does the refusing.

**Desired architecture.** The corrected design, in six parts.

#### 1. Component responsibilities

| Component | Responsibility after RP1 | Change |
|---|---|---|
| `proxy.ts` | Decides **who owns a path** (`classify`), applies the **document gate** (cookie present), performs the **internal rewrite** to `/fo-gateway/<path>` with the marker header, issues the front-door, retired-screen and sign-in 307s with `NextResponse.redirect(req.nextUrl.clone() with the new pathname)`: the redirect URL's origin is the **request's own**, never a configured `PUBLIC_ORIGIN`, and Next's proxy adapter then emits the `Location` **origin-relative** because the redirect host equals the request host ([Next-src] `web/adapter.js:353-357`, `relativize-url.js`), so no host, inbound or configured, is trusted; `skipProxyUrlNormalize` must stay unset (an RP10-B startup or config assertion). Tests: at the unit level, the redirect URL's origin equals the request's origin and never `PUBLIC_ORIGIN`; through the real-server harness, with `Host: evil.example` the `Location` starts with `/` and carries no host; one runtime probe (`curl -i` against a built server with no cookie shows `location: /login`) settles the [Next-src] reading. (Revision 3.8, delta review rounds 1 and 2; a hand-built relative `Location` was considered and rejected because the adapter parses every `Location` with `new NextURL(location)` and no base, which throws on a relative reference.) Answers 404 for `denied` and `unknown`. **Admits no bodies**: a refusal from `proxy.ts` is sent only after Next has buffered the whole upload (WHOLE-R1), so body admission and the declared-length pre-check live in RP10-B's thin Node entry in front of Next (revision 3.12 delta; supersedes the 3.10 and 3.11 admission-registry sentences) | Loses body admission (revision 3.12; moved to RP10-B's Node entry) |
| `lib/gateway/registry.ts` | The **single policy table**: rows of `{ prefix, owner, methods, auth, body, timeout }`. `classify(pathname)` returns the matching row. In `whole` mode documents default to a `fo-document` row; the API never defaults | Grows from path lists to policy rows |
| `app/fo-gateway/[...path]/route.ts` | Decides **how to forward**: re-checks marker, path and owner; **refuses methods not in the row (405, coded)**; runs the auth bridge (RP2); applies the row's body class; builds the upstream URL and headers; forwards with the row's timeout class (RP4); applies the response policy; injects the shell (RP9); drops the cookie on session end (RP2) | Gains the method check, the coded body refusals, the two-origin redirect rule |
| `lib/gateway/client-identity.ts` (**new**, ~30 lines) | `clientIdentity(headers)` returns `ip` (string or null), `userAgent` (string or null) and `proto`, with one trust rule (part 4). Used by the gateway, by `fetchFo` (RP4 wires it) and by `lib/rate-limit.ts` (RP3 wires it) | Replaces `route.ts:228-232` and `rate-limit.ts:70-76` |
| `lib/gateway/body-limit.ts` | The body policy (part 3): one constant `MAX_REQUEST_BODY_BYTES` that `next.config.ts` also imports for `proxyClientMaxBodySize`, so the two cannot drift; coded 413 refusals; a "reached the limit" branch | Ceiling changes from nginx's 50 MB to the shared constant; comments rewritten |
| `lib/gateway/headers.ts` | Request and response allow-lists; `rewriteLocation(location, origins[])` accepts **both** upstream origins; the inbound `content-length` is **dropped** from the request allow-list (part 3) | Two-origin rewrite; one header removed from the allow-list. Response-policy additions (`Retry-After`, `no-store`) stay in RP7 |
| `lib/gateway/upstream.ts` | `FABORCH_BASE_URL` for everything; `FO_UI_BASE_URL` for documents and static **only when `FO_UI_SPLIT_ALLOWED=1`**; set without the flag → `FabOrchNotConfiguredError` at startup | Explicit opt-in (part 5) |
| `lib/gateway/ownership.ts`, `auth-bridge.ts`, `html-inject.ts`, `destinations.ts` | Unchanged by RP1 (owned by RP6, RP2, RP9, RP0). `MAX_INSPECTABLE_BODY_BYTES` is replaced by the shared constant | Constant only |

#### 2. Request flows

**A. Document: `GET /chat` from the installed app**
1. `proxy.ts`: `classify("/chat")` → the `fo-document` row. Gate: `faborch_token` present? No → 307 `/login?next=/chat` (`no-store`). Yes → rewrite to `/fo-gateway/chat` + `x-pwa-gateway: 1`.
2. Route: marker, `safeGatewayPath`, owner. **Method ∈ {GET, HEAD}**, else `405 {code:"method_not_allowed"}`.
3. Auth: `forward-anonymous`. No credential is ever attached to a page or asset.
4. Origin: `FO_UI_BASE_URL` when the split is allowed, else `FABORCH_BASE_URL`.
5. Headers out: the allow-list (accept, language, RSC headers, user agent, range, conditional) plus `x-forwarded-for` and `x-forwarded-proto` from `clientIdentity` and `x-request-id` from RP10-A. `cookie`, `authorization`, `host`, `content-length`, the marker: dropped.
6. `fetch` with `redirect: "manual"`, `cache: "no-store"`, `signal: req.signal`, timeout class **document** (RP4).
7. Response: allow-list; HTML forced `no-cache, must-revalidate`; a `Location` on *either* FO origin rewritten to a PWA path; `set-cookie` dropped; shell injected before `</head>` as the body streams.

**B. Static: `GET /_next/static/chunks/<hash>.js`.** As A without the gate; owner `fo-static`; methods {GET, HEAD}; the immutable cache header passes through; same build as the document (`upstream.ts:17-20`).

**C. API: `POST /api/chat` from FO's own page script**
1. `proxy.ts`: the `/api/chat` row (`fo-api`) → rewrite; no gate (APIs authenticate themselves).
2. Route: marker, path, owner; **method ∈ the row's set** ({GET, POST} for `/api/chat`), else 405.
3. Auth bridge (RP2): bearer + cookie fingerprint → inject the FO token; bearer absent → anonymous; bearer bad → 401 coded.
4. Body (part 3): declared length above the limit → `413 {code:"body_too_large", limit}` before a byte is read. Chat paths are read whole for the ownership check (RP6) up to the limit; a body that reaches the limit is refused as possibly truncated. Everything else streams through the counting limiter.
5. Forward with `authorization: Bearer <FO token>`, `x-request-id` (RP10-A), `x-forwarded-for` and `x-forwarded-proto` from `clientIdentity`; `content-length` set from the bytes actually sent; timeout class **stream** (RP4).
6. Response piped; SSE headers set; FO 401 on an injected request → cookie cleared (RP2); errors coded (RP5).

**D. Upload: `POST /api/modeling-agent/chat/parse-upload` (multipart .xlsx)**
As C, with body class `multipart`: never buffered by the gateway; streamed through the counting limiter; the same declared-length pre-check; the same limit.

#### 3. Body policy (B5, G2, G16): two tiers [decided 24 Sept; application limit provisional]

Root cause of G2: Next reads every body that passes `proxy.ts` and keeps only `proxyClientMaxBodySize`; the gateway then either forwards the original `content-length` with a shorter body (→ 502) or forwards a chunked body silently cut (→ truncation). Two separate limits close it:

| Tier | Name | Value | Who owns it | What it does |
|---|---|---|---|---|
| **A. Application policy limit** | `PWA_BODY_POLICY_BYTES` (`MAX_REQUEST_BODY_BYTES` in `lib/gateway/body-limit.ts`) | **20 MiB, provisional** | The PWA, from FO workflow evidence (table below); revisited at RP10-B / CP5 against the AWS topology | The largest request the PWA intentionally supports. Enforced by the gateway with a coded 413 |
| **B. Framework transport ceiling** | `PWA_BODY_CEILING_BYTES` → `experimental.proxyClientMaxBodySize` in `next.config.ts` | **policy + headroom; 25 MiB proposed** | Next's transport; a deploy-time value (`next start` reads it at startup, no rebuild) | How much of a request Next hands the gateway. It must exceed the policy so the gateway can *see* that a body is over the limit rather than receiving it already cut to exactly the limit |

**Why the ceiling must be above the policy** ([runtime], 24 Sept, Appendix B): with both at 20 MiB, a chunked 20 MiB + 1 body was cut by Next to exactly 20 MiB, passed the policy check, and reached the stub FO as a *complete* 20 MiB body: silent truncation. With the ceiling at 25 MiB the gateway measured 20 MiB + 1 and refused. The required headroom is logically one byte (the gateway must be able to receive policy + 1); the proposed 5 MiB keeps the two limits and their log lines unmistakably distinct. Next's buffer is dynamic (it holds only the bytes that actually arrive, up to the ceiling), so the headroom costs memory only for oversized requests, bounded at the ceiling per request. A **startup assertion** refuses to start if `ceiling ≤ policy`.

**Mechanics:**
1. `declaredLength > policy` → `413 {code:"body_too_large", limit}` before any byte is read. (Next has already received the whole upload by then, and a refusal from `proxy.ts` is sent only after that too, WHOLE-R1: `proxy.ts` refuses no body; the pre-buffer refusal on the declared length is RP10-B's Node entry, revision 3.12 delta.)
2. **Buffer, measure, then forward, for every body class.** Next has already buffered the body, so streaming through the gateway saves no memory and would let partial bodies reach FO on abort. The route reads the body (at most the ceiling), refuses `> policy` with the coded 413, and otherwise forwards with `content-length` set from the bytes actually read. **No partial or truncated body can reach FO.**
3. The inbound `content-length` header is dropped from the request allow-list; the gateway always sets its own from the buffered bytes, which removes the length-mismatch 502 class entirely.
4. Chat bodies use the same buffer for the ownership check (RP6); `MAX_INSPECTABLE_BODY_BYTES` is replaced by the policy constant.
5. Multipart: the policy applies to the **request body**, not the file; measured overhead is 203 bytes per part, so a file of `policy − 1 KiB` always fits. The user-facing wording says "files up to about 20 MB".
6. The comments at `route.ts:23-25` and `body-limit.ts:70-72` are rewritten to state Next's behaviour.
7. **The ceiling is global, so the policy must be too.** Raising `proxyClientMaxBodySize` raises what Next will buffer for *every* body-carrying route, including the PWA's own. Each surviving PWA route therefore declares a body class through the same helper: `/api/pwa/auth/login` is `small-json` (16 KiB), refused with the coded 413 above that; the native chat route, until it retires, gets the policy pre-check as a one-line containment (it currently calls `req.json()` unbounded).
8. B5's native route is then closed by retirement (RP8); item 7 is its containment until the cutover.

**Memory per body-carrying request**: up to the ceiling in Next's buffer plus up to the policy in the gateway's copy, released when the response ends. **Corrected in revision 3.12 (WHOLE review R1, verified in Next 16.1.4 `next-server.js:1226-1243`):** Next runs the proxy on a *cloned* body stream and awaits the end of the whole upload in a `finally` before it returns the proxy's response, so a refusal from `proxy.ts` (413, 503) is sent only after the full upload has arrived and been buffered, and the unread clone given to the proxy probably holds a second copy (to be confirmed by the L2 probe). Memory per in-flight body is therefore about ceiling × 2 until measured, and **no control inside Next can refuse a body before it is buffered**. The pre-buffer controls are RP10-B's: the edge (a rate rule on body-carrying methods) and a thin Node entry in front of Next (RP10-B part 1). The concurrent-body cap follows from the machine's memory and is a CP5 number.

**Other limits in the path** (each must be at or above the ceiling, or it becomes the real limit): FabOrchestrator's nginx `client_max_body_size 50m` ([FO-clone]; production [uncertain]); Fly's edge (no body limit known [uncertain]); **the AWS components chosen for the PWA** (an ALB imposes none; API Gateway caps at 10 MB and Lambda at 6 MB, either of which would override this design) — an RP10-B / CP5 check.

**Why 20 MiB, provisionally** (from the repository, 24 Sept):

| Evidence | Value |
|---|---|
| FabOrchestrator's outer limit | nginx `client_max_body_size 50m`, since 2026-07-24 (upstream `main` and the fork; production nginx [uncertain]). FO's local test rig records the history 1 MB → 25 MB, with a 30 MB fixture as the "should fail" case |
| Master Data Load workbooks (`parse-upload`, CMF `stage`) | fixtures 6 KB to 1.2 MB; FO's own code notes multi-MB workbooks once exhausted memory and now streams the parse; bytes go to S3. Designed-for range: single-digit MB. No app-level limit |
| Chat attachments (`/api/chat`) | inline **base64 data URLs** in the POST body (the UI uses `readAsDataURL`, the server uploads to S3). Picker allows several files. Inline types: JPEG/PNG/GIF/WebP, PDF, text; others go via container upload, also inline. The model API caps an image at 5 MB (≈ 6.7 MB encoded). No FO-side size check |
| Long threads | 1.3 MB for 104 turns (measured) |
| Present deployment (**Fly preview/development only, not the production target**) | `shared-cpu-1x`, 512 MB; the PWA will be hosted on AWS, whose instance sizes and transport limits are unknown until RP10-B |

Largest realistic single request: two full-size photos plus a long thread ≈ 15 MB encoded, or a large master-data workbook of a few MB. 10 MB would refuse those, so the PWA does need more than Next's default. 20 MiB covers every workbook FO can parse comfortably, any single image at the model's own maximum plus its thread, two typical photos, and PDFs up to ~14 MB; it sits below FO's ceiling, so the PWA always answers with its own coded 413 rather than nginx's. It is **provisional**: a product limit would need FO's own attachment policy and the AWS sizing, neither of which exists yet.

**Consequence for Jothi to confirm:** from the phone, chat attachments above ~14 MB (large PDFs) are refused with a clear message; FO's web UI is unchanged.

#### 4. Client identity (G4, G13) [decided: forward the trusted identity]

`clientIdentity(headers)` trusts **only the value written by the trusted edge**, never a position a client can influence:
- on Fly: `fly-client-ip`, which Fly's edge sets and a client cannot forge;
- on AWS (the production target): the entry the trusted hop *appended*; **a chain with fewer than N entries yields `null`** (never the first or last entry), which RP3 treats as an untrusted ingress (revision 3.10 delta, RP3-R17). The source is named by one knob, `CLIENT_IDENTITY_SOURCE = fly | xff | cloudfront-viewer`, read by `clientIdentity`, RP3 and RP10-B's startup assertion. An ALB and CloudFront **append** the connecting address to `x-forwarded-for`, so the client-controlled entries are at the **front** of the list and the trusted one is the **N-th from the end**, where N = `TRUSTED_PROXY_HOPS` (1 behind an ALB alone, 2 behind CloudFront plus an ALB). CloudFront's `CloudFront-Viewer-Address` is an alternative source **only when it is configured as the source at deploy time** (never auto-detected from the request: a request that bypassed the edge could carry it), and the edge must be the only path to the ALB (RP10-B part 1);
- with neither configured: `null`, and no `x-forwarded-for` is sent to FO.

**The first `x-forwarded-for` entry is never a trust rule** (revision 3.3 removed the earlier `TRUST_X_FORWARDED_FOR` option): behind any appending proxy the first entry is whatever the client sent, which would make the audit IP and RP3's source bucket forgeable. The user agent passes through unchanged. Rules:
- the gateway sets `x-forwarded-for` only when `ip` is non-null, and always sets `x-forwarded-proto`; it also sets `x-request-id` (RP10-A's id) on every forward;
- **the request scheme has a trusted source per identity source, defined beside the IP rule** (revision 3.8, delta review): on Fly, when `fly-client-ip` is the configured identity source, the scheme is **`https` by configuration**: both Fly deployments set `force_https = true`, so no plain-http request reaches the app, and RP10-B's documentation test asserts `force_https` is present; a per-request value, if ever wanted, is Fly's documented `Fly-Forwarded-Port === "443"` (Fly documents `Fly-Client-IP`, `Fly-Forwarded-Port`, `Fly-Region` and `Via`; it documents no `Fly-Forwarded-Proto`, [uncertain] until a one-request probe on the preview machine records the actual header set); on Fly the client-appendable `x-forwarded-proto` is never read and a missing Fly header never lowers the scheme; on AWS, **`https` by configuration** (`EDGE_SCHEME=https`, required whenever the identity source is `xff` or `cloudfront-viewer`, asserted at startup), because CloudFront writes no `x-forwarded-proto` and the ALB's describes only its own leg, so no trusted position exists in that header on the proposed topology and it is never read (revision 3.10 delta, RP10B-R16); with neither configured, `req.nextUrl.protocol` (plain-http development correctly yields a non-`Secure` cookie; `https://localhost` yields `Secure`). `clientIdentity().proto` and `session.ts`'s cookie `secure` decision both read this value, never from `x-forwarded-proto`, and RP10-B's startup assertion that the identity source is configured covers the proto source too. Tests: with `fly-client-ip` present, a client-forged `x-forwarded-proto: http, https` and no Fly proto header, the cookie is still `Secure`; with `CLIENT_IDENTITY_SOURCE=xff`, `TRUSTED_PROXY_HOPS=1`, `EDGE_SCHEME=https` and `x-forwarded-proto: https, http`, the cookie is `Secure` and the header is not consulted; with neither configured over plain http the cookie is not `Secure`;
- **`x-request-id` is set from the value `proxy.ts` minted**; an inbound `x-request-id` is replaced before **every return of `proxy()`**, not only the gateway rewrite (RP10-A, revision 3.9 delta), and never forwarded (test: a gateway request carrying `x-request-id: attacker` reaches the stub FO with the PWA's UUID);
- `fetchFo` (RP4) adds `x-forwarded-for` and `user-agent` on **user-initiated** calls (login, logout, and any surviving user-facing call), so FO's audit records the phone, not the PWA server;
- `lib/rate-limit.ts` (RP3) keys its source bucket by the same value;
- FO itself trusts the first XFF entry it receives ([FO-clone] `auth-middleware.ts:91`), so the value the PWA forwards is exactly what FO's audit shows. Whether Fly's edge appends or prepends to XFF is [uncertain] and irrelevant once `fly-client-ip` is preferred.

#### 5. Route policy table (the registry rows) [decided: explicit API allow-list; `whole` mode; Master Data Load kept]

Built from FabOrchestrator's route files (fork-branch clone `fo-mobile-nav@1b9b117`; production confirmed by the read-only live check). Methods are exactly those FO exports.

| FO path prefix | Methods | Body class | Timeout class (RP4) | Notes |
|---|---|---|---|---|
| `/api/auth/me` | GET | none | bounded | |
| `/api/auth/logout` | POST | none | bounded | ends the PWA session too (RP2) |
| `/api/auth/change-password` | POST | json | bounded | FO's forced-change flow (G20, RP2) |
| `/api/chat` | GET, POST | chat | stream (POST), bounded (GET) | GET returns the model list. **POST matches the exact path only** (`/api/chat/` and `/api/chat/x` are never forwarded at the non-exact path; the table-driven test asserts "not forwarded" rather than a status, because Next may first answer a trailing slash with a method-preserving 308 that replays the POST at the exact path, where RP6's check runs), so RP6's ownership check and the row agree by construction; the same for `POST /api/modeling-agent/chat` (revision 3.8, delta review) |
| `/api/conversations`, `/api/conversations/*` | GET, POST, PATCH, DELETE | json | bounded | FO checks ownership on these |
| `/api/messages/feedback` | POST | json | bounded | FO checks ownership |
| `/api/artifacts`, `/api/artifacts/*` | GET, POST, PATCH, DELETE | json | bounded | FO checks ownership |
| `/api/files/*` | GET | none | bounded | metadata and download only; **FO has no upload route here** |
| `/api/mcp/connections`, `/api/mcp/connections/*` | GET, POST, PATCH, DELETE | json | bounded | FO's own UI manages connections here |
| `/api/user/*` | GET, POST, PATCH | json | bounded | API-key status, settings, models (FO admin-gates `models`) |
| `/api/memory` | GET, DELETE | none | bounded | |
| `/api/fabinsight/pinned`, `/*`, `/*/refresh` | GET, POST, DELETE | json | bounded | FO admin-gates the writes; `refresh` rewrites the shared snapshot, as FO's own UI does |
| `/api/fabinsight/render` | POST | json | bounded | renders a dashboard; cost for FO owners to confirm |
| `/api/fabinsight/access` | GET | none | bounded | |
| `/api/fabinsight/warm` | GET | none | bounded | warms dashboard data; cost for FO owners to confirm |
| `/api/platform-theme`, `/api/health` | GET | none | bounded | public on FO: the only **`auth: optional`** rows, forwarded without a bearer and rate-capped per client identity (G31). Every other row is `auth: required` |
| `/api/modeling-agent/access`, `/chat/download/*`, `/chat/parent-options/*` | GET | none | bounded | Master Data Load, **kept** |
| `/api/modeling-agent/chat` | POST | chat | stream | Master Data Load, **kept**; ownership check applies (RP6) |
| `/api/modeling-agent/chat/parse-upload` | POST | multipart | upload | Master Data Load, **kept**; the one multipart upload |
| `/api/cmf/*` | GET, POST, PATCH | json; multipart on `packages/stage` | bounded; upload for `stage` | Master Data Load backend (loader wizard), **kept** |
| documents (`whole` mode) | GET, HEAD | none | document | any path not reserved, denied or `/api/*` |
| `/_next/*`, `/logos/*`, the listed static files | GET, HEAD | none | document | |
| **denied** (unchanged) | — | — | — | `/api/auth/login`, `/api/auth/register`, `/api/auth/password-reset`, `/api/fabinsight/cron`, `/api/fabinsight/schema`, `/forgot-password`, `/reset-password` |

Any `/api/*` path without a row → 404 (`unknown`), in every mode. Adding an FO API route therefore requires a registry row and a PWA deploy; the contract-drift test (part 6) reports when FO's routes and this table disagree.

**Document denial (G32 interim; revision 3.9 delta).** The registry gains a document-denial list evaluated **inside `classify` step 5, only where the path has resolved to `fo-document`** (named in `FO_EMBED_SURFACES`, or the `whole` default), returning `denied`; segment-bounded (`/reports` and `/reports/…`, never `/reportsx`); step 6 is unchanged, so in `surfaces` mode without `/reports` listed the PWA's own page still answers, and it stays intact until RP8 deletes it. `FO_DENIED_PREFIXES` is not used for this because it runs before the contested rule and by prefix. RP7 part 5 owns the tests (`surfaces` with `/chat` only → `/reports` is `pwa`; `surfaces` with `/chat,/reports` → `denied`; `whole` → `denied`; `destinations.test.ts`'s WHOLE/BOTH `/reports` cases invert to `denied`). **The list is emptied only after FO's fix is confirmed in production** (§9 question 51, recorded at CP5 with the FO owners as the control's real owner); the emptying commit inverts the `whole`-mode `GET /reports` test from 404 to forwarded and keeps the Playwright sandbox test as the release blocker.

**Anonymous access (G31).** Each row carries `auth: required` or `auth: optional`. A request with no bearer to a `required` row is answered `401 {code:"session_invalid"}` by the gateway and **never forwarded**; the only `optional` rows are the two FO's pages need before sign-in. Anonymous requests to those two are capped per client identity (a small in-process token bucket in `lib/gateway/`, sized generously above what one page load needs and sharing RP3's store interface once that exists), answering `429` with `Retry-After` above the cap. Authenticated traffic is not capped here; that is RP3's and FO's concern.

#### 6. Redirects, the preview split, and drift

- `rewriteLocation(location, [FABORCH_BASE_URL, FO_UI_BASE_URL])` rewrites a `Location` on either origin to a PWA path; anything else passes through untouched (G17).
- `FO_UI_BASE_URL` is honoured only when `FO_UI_SPLIT_ALLOWED=1`; `fly.preview.toml` sets both, `fly.toml` sets neither; the URL without the flag fails at startup (G18).
- A **contract-drift test** diffs FabOrchestrator's `app/api/**/route.ts` inventory (from the FO clone the team tracks) against the route policy table; a new, removed or method-changed FO route fails the test until the table is updated deliberately.

#### Finding map

| Finding | Problem | Root cause | Fix | Components | Test |
|---|---|---|---|---|---|
| G2 | Uploads > 10 MB → misleading 502 or silent truncation | Next buffers and cuts bodies at its ceiling before the route; with ceiling = limit the gateway cannot tell a cut body from a complete one; the original length is forwarded | Part 3: policy limit below a framework ceiling, buffer-measure-forward, the gateway's own `content-length`, a startup assertion | `body-limit.ts`, `route.ts`, `headers.ts`, `next.config.ts` | The matrix in Tests (probe evidence in Appendix B): byte-exact at and below the policy; coded 413 above it, declared and chunked, including above the ceiling; the ceiling = policy control reproduces the truncation and stays as the negative test behind the startup assertion |
| B5 | Native chat route parses an unbounded body | Same mechanism; the route retires | Part 3 item 7 as containment (the policy pre-check on the native route, `small-json` on login); closed by RP8 retirement | `chat/route.ts` (until retired), `login/route.ts` | Login with a 17 KiB body → coded 413; native chat with policy + 1 → coded 413; retirement test afterwards |
| G4 | Audit IP forgeable | First XFF entry trusted | Part 4: only the trusted edge's own value (`fly-client-ip`, or the N-th-from-last XFF entry on AWS) | `client-identity.ts`, `route.ts` | Forged XFF with `fly-client-ip` present → FO sees `fly-client-ip`; no trusted source → no XFF sent; AWS hop-count cases as in Tests |
| G13 | FO audit sees the PWA server for every login | `fetchFo` sends no identity | Part 4, wired in RP4 | `client.ts` | Login through the route → the stub FO receives the phone's XFF and UA |
| G14 | All seven methods forwarded | Registry ignores the method | Per-row `methods`; 405 coded | `registry.ts`, `route.ts` | `PUT /chat`, `DELETE /_next/x`, `PATCH /api/auth/me` → 405, not forwarded |
| G15 | Subtrees forwarded unreviewed | Prefix-only allow-list | Part 5, reviewed row by row | `registry.ts` | Table-driven: every row's methods forward; anything else 404 or 405 |
| G16 | Excluded agent's routes forwarded | Registry predates the 2 Sept decision | **Kept by decision**; the body policy sized for its uploads | `registry.ts` rows | Its rows are in the table-driven test; the 20 MB upload test uses an `.xlsx` |
| G12 | New FO pages appear unreviewed | Intended for documents; API allow-listed | Kept, made explicit | `registry.ts` | A new document path forwards; a new `/api/x` 404s |
| G17 | Redirects can leave the origin | Single-origin rewrite | Part 6 | `headers.ts` | `Location` on each origin → PWA path; other hosts untouched |
| G18 | Preview split could reach production | The env var alone enables it | Part 6 opt-in | `upstream.ts` | Set without the flag → startup error; with it → split |
| G31 | The PWA relays unauthenticated requests to all of FO's allow-listed API | The bridge forwards anonymously by default because two endpoints must be public | Per-row `auth: required` / `optional`; `required` rows refuse without forwarding; the two `optional` rows are rate-capped per identity | `registry.ts` rows, `auth-bridge.ts`, `route.ts` | Anonymous `POST /api/chat` and anonymous `GET /api/conversations` → 401 coded, the stub FO receives nothing; anonymous `GET /api/platform-theme` → forwarded; cap + 1 anonymous requests to it from one identity within the window → 429 with `Retry-After`, and the stub receives exactly cap requests; a request with a valid bearer and cookie to a `required` row → forwarded with the injected token (unchanged). `injection.test.ts:53` ("no bearer is forwarded anonymously") is narrowed to the `optional` rows |

**Relevant code.** `proxy.ts`; `app/fo-gateway/[...path]/route.ts`; `lib/gateway/{registry,path,headers,upstream,body-limit,destinations,html-inject}.ts`; new `lib/gateway/client-identity.ts`; `next.config.ts`; `lib/faborch/client.ts` (`authHeader`, for G13); `lib/rate-limit.ts` (`clientAddress`); `fly.toml`, `fly.preview.toml`.

**Design decisions.**
- *Derived technically:* the component split; per-row method allow-lists; per-row `auth: required` / `optional` with the anonymous cap on the two public rows (G31); the identity trust rule; the body-policy mechanics (items 1–8); recomputed `content-length`; two-origin redirects; the preview opt-in flag; the contract-drift test; all tests.
- *Decided 24 September 2026:* Master Data Load stays available (G16); the application body limit is a **provisional** 20 MiB with a framework ceiling above it (part 3), both to be revisited at RP10-B / CP5 against the AWS topology; the API is an explicit allow-list and documents default to FO in `whole` mode (G12, G15); production runs `whole` mode; the trusted client identity is forwarded to FO (G4, G13).
- *Still open, for others:*
  - **Jothi:** the phone-path consequence of 20 MB (attachments above ~14 MB refused from the PWA; FO's web UI unaffected), and whether Master Data Load should later be removed from the PWA.
  - **FO owners:** confirm production nginx is 50 MB; whether `GET /api/fabinsight/warm` and `POST /api/fabinsight/render` are expensive enough to need PWA-side rate limiting; confirm the route and method inventory against production (the read-only live check does the mechanical part).
  - **Deployment (RP10-B / CP5):** the AWS topology (instance memory; whether an ALB, API Gateway or Lambda fronts the PWA, since the latter two cap bodies at 10 MB and 6 MB), the resulting ceiling and concurrent-body cap (L2), and the trusted-hop count for client identity (`TRUSTED_PROXY_HOPS`) once the edge is AWS rather than Fly.

**Implementation stages.**
1. Write the trace document (`/chat`, a chunk, `GET /api/conversations`, `POST /api/chat`, `POST /api/auth/logout`, `parse-upload`) from this section (no code).
2. Reproduce G2 end to end on a fresh build with `FO_EMBED_MODE=whole` against a stub FO that records received bytes: 5, 9, 10, 12 MB, declared and chunked. Record in `docs/probes/`.
3. CP1 (this section is the input).
4. `client-identity.ts` (G4); wire the gateway. RP3 and RP4 wire the limiter and `fetchFo` in their own packages.
5. Registry rows with methods; the 405 path (G14, G15, G16 as kept).
6. Body policy: the two values with the startup assertion, the declared-length pre-check, buffer-measure-forward with the gateway's own `content-length`, the chat cap, the comments (G2, B5).
7. Two-origin redirects (G17); the `FO_UI_SPLIT_ALLOWED` flag (G18).
8. Contract-drift test; route-level contract tests; the real-server body suite; the read-only live check.

**Tests** (behavioural; route level with a stubbed `fetch` unless noted):
- A document is forwarded with no `authorization`, and `cookie` is never forwarded.
- `fo-api` with a valid bearer and cookie pair gets `authorization: Bearer <FO token>`; a mismatched pair gets 401 and is not forwarded.
- Anonymous requests: a `required` row is refused with a coded 401 and nothing reaches the stub; an `optional` row is forwarded; the anonymous cap on an `optional` row answers 429 with `Retry-After` above the limit (G31).
- `set-cookie` from upstream is dropped; HTML gets `no-cache`.
- A `Location` on either FO origin is rewritten to the PWA origin; another host passes through.
- A direct request to `/fo-gateway/x` gets 404; a request without the marker gets 404; a direct request that *forges* the marker header, and one that carries `x-middleware-subrequest` (the header behind Next's 2025 middleware-bypass advisory), both get 404, and the route's own path, owner and method checks are asserted independently of the marker so the marker is only belt and braces.
- Every route-policy row: each listed method forwards; each unlisted method gets 405 with `code`; an unlisted `/api/*` path gets 404.
- The audit IP comes from `fly-client-ip` even when XFF is forged; with no trusted source configured, no XFF is sent; with `TRUSTED_PROXY_HOPS=1` and an XFF of `forged, real`, the identity is `real`; with `TRUSTED_PROXY_HOPS=2` and `forged, real, cloudfront`, it is `real`; a list shorter than the hop count yields `null`.
- `FO_UI_BASE_URL` without `FO_UI_SPLIT_ALLOWED` → startup error.
- **Real server** (RP10-A harness; Next's buffering happens outside the route), against a stub FO that records bytes and completeness, for both `parse-upload` (multipart) and `/api/chat` (JSON), each in declared-length and chunked form, with policy 20 MiB and ceiling 25 MiB:
  - 5 MiB and policy − 1 → 200, forwarded byte-exact, the stub sees a complete body of the same size;
  - exactly the policy → 200 (the limit is inclusive);
  - policy + 1 and 22 MiB (above the policy, below the ceiling) → coded 413; declared bodies refused at the "declared" stage, chunked at the "measured" stage with the true size; the stub receives nothing;
  - ceiling + 1 and 30 MiB, **declared** → coded 413 from RP10-B's Node entry before Next reads the body; Next and the stub receive nothing; **chunked** → coded 413 from the gateway at the "measured" stage, the gateway seeing exactly the ceiling, which is above the policy; the stub receives nothing; both answers carry the canonical body (revision 3.12 delta, RP1-D16);
  - a multipart body carrying a 19.9 MiB file → 200 (overhead 203 bytes per part);
  - **negative control**: with ceiling = policy, the chunked policy + 1 case must show the truncation (200, and the stub receives a complete body of exactly the policy size); the startup-assertion test proves the server refuses that configuration.
- **Contract drift:** the FO inventory equals the route policy table.
- **Live check (read-only) against preview:** `GET` requests only. A document and `/api/platform-theme`: the only upstream `set-cookie` headers are the ALB stickiness cookies, and none reaches the phone. For each API row, a side-effect-free `GET` answers with the expected status class. `/api/files` has no upload route. No `POST`, `PUT`, `PATCH` or `DELETE` is sent, because preview is connected to production FO.

**Acceptance criteria.**
- The stage 2 G2 record exists in `docs/probes/`.
- The route policy table (part 5) is approved at CP1, and every row has a passing table-driven test.
- The real-server matrix passes in full, for both body classes and both transfer forms; no case ever shows a partial body at the stub.
- The startup assertion refuses `ceiling ≤ policy`, and the negative control shows why.
- The policy and the ceiling are read from their two environment values with the documented defaults, and the gateway's 413 names the policy value.
- The contract-drift test passes against the tracked FO clone.
- The existing `scripts/embed-*-check.mjs` still pass against preview, and the read-only live check passes.

**Regression risks.**
- Blank FO pages if static-asset routing or build pairing breaks (`upstream.ts:17-20`).
- Client-side navigation failing if RSC headers are dropped.
- A method allow-list that is too tight, breaking an FO feature (the drift test and the table-driven test are the guard).
- Memory: up to the ceiling held per body-carrying request; the concurrent cap is L2's to measure on the target topology. A ceiling set at or below the policy silently reintroduces G2, which the startup assertion prevents.
- Redirect loops between the gate and FO's guards (`proxy.ts:176-182`).

**Demo / verification.** On preview with devtools open:
1. The document, a chunk and the API calls are all on the PWA origin; the server log shows auth injected for `fo-api` only.
2. `PUT /chat` → 405 with a code.
3. A 21 MB workbook upload → coded 413 (refused by RP10-B's pre-Next entry on the declared length before buffering; a `proxy.ts` refusal would arrive only after the upload, WHOLE-R1); a 5 MB one → FO parses it.
4. FO's session audit shows the phone's IP for a login made through the PWA.

**Concepts to learn.** Reverse proxy; the same-origin policy; rewrite versus redirect; Next middleware (`proxy.ts`) versus route handlers, and how Next clones bodies for middleware; hop-by-hop headers; `X-Forwarded-*` trust chains; `content-length` versus chunked transfer; base64 size inflation (×4/3); RSC request headers; `assetPrefix`; Web Streams and `duplex: "half"`.

**Design-review questions.**
- Why a route handler rather than a middleware rewrite to FO? (`route.ts:42-48`)
- What stops a client reaching `/fo-gateway` directly?
- Why are documents forwarded anonymously?
- What happens when FO adds a page? And an API route?
- Why 20 MiB, why is it provisional, and what does it cost per concurrent upload?
- Why must the framework ceiling sit above the application limit?
- Why is the inbound `content-length` dropped?
- How do you roll this back?

---

### RP2 — Authentication and session lifecycle  *(Jothi #3 and #6)*

**Purpose.** One explicit, tested lifecycle for the two credentials that make up a session, in the target architecture (installed PWA → same-origin gateway → the real FabOrchestrator): creation, use, idle, absolute expiry, logout, re-login, revocation, key rotation, and the forced-password-change hold. This section is the **proposed corrected architecture**; decisions taken on 24 September 2026 are marked **[decided]**.

**Why these findings belong together.** They are all states or transitions of the same session object, spread across the same files, and every one of them is closed by the same two changes: one end-of-session path on the server, one on the client.

**Included findings.**
- m2: hand-written token signed with a single key; rotation signs everyone out.
- m3: sessions are not cleaned up on expiry, and re-login does not revoke the replaced token.
- G5: the gateway's refusal path does not clear the cookie.
- G10: the PWA bearer is readable by every script on the shared origin. **[decided]** accepted and recorded as an architectural risk of same-origin embedding, mitigated in RP7.
- G20: the PWA ignores FabOrchestrator's forced-password-change state. **[decided]** detect at login and send the user to FO's real flow.
- **G30 (new, 24 Sept):** the PWA writes FO's `llmatscale_auth_session` key with `{expiresAt}` only, while FO's embedded pages read `user.name`, `user.email` and `user.canCreateDashboards` from it.

**Current architecture** ([code]; FO facts [FO-clone]).

There are **two credentials**, and a session is valid only when both are present together:
- **The FO token**: FabOrchestrator's real session (a random string backed by a `Session` row; 30-day expiry; 30-minute idle eviction enforced lazily on the next request). Kept in the **httpOnly cookie** `faborch_token`, unreadable by JavaScript (`session.ts:39-55`).
- **The PWA token**: minted at login as `b64url({id, email, name, roleName, exp, fp}).HMAC`, where `fp` is a fingerprint of the FO token (`auth.ts:147-166`). Stored in **localStorage under FO's own key** `llmatscale_auth_token` (`login-page.tsx:24, 194`), deliberately, so FO's embedded pages send it as their bearer.

Every server check (`requireAuth`, `auth-middleware.ts:24-53`; `bridgeAuthorization`, `auth-bridge.ts:55-75`) requires: bearer present → signature and `exp` valid → cookie present → `fp` matches. Only then is the FO token injected upstream.

| Step | Today | Where |
|---|---|---|
| Login | `foLogin` → FO returns `{user{id,email,name,avatarUrl,preferences,canCreateDashboards}, token, expiresAt}`; PWA `exp = min(now + 12 h, FO expiresAt)`; the body carries the PWA token, `Set-Cookie` the FO token (HttpOnly, Secure on HTTPS, SameSite=Lax, expires at FO's expiry) | `login/route.ts`, `session.ts` |
| Client storage | `llmatscale_auth_token` = PWA token; `llmatscale_auth_session` = `{expiresAt}` | `login-page.tsx:194-195` |
| Idle, embedded | FO's client timer: warning at 28 min, expiry at 30 min, **measured from the last successful authenticated API call**; on expiry it deletes the keys and `fo-shell.js` calls `/api/pwa/auth/logout` and goes to `/login`; any authed 401 does the same | FO `providers.tsx:120-145`, `hooks/use-idle-timeout.tsx`; `fo-shell.js:84-100` |
| Idle, PWA pages | Nothing client-side; noticed on the next FO call | — |
| PWA absolute expiry | `/me` → 401 → the client clears localStorage **without calling logout**; the login page's own check does the same | `use-session.ts:100-103`, `login-page.tsx:73-79` |
| Logout | FO logout awaited **first, with no deadline**, then the cookie cleared | `logout/route.ts:39-47` |
| Re-login | The cookie is overwritten; the old FO token is **not revoked** | `login/route.ts:128-131` |
| Revocation | None PWA-side. FO's (idle eviction; admin force-logout by user id) is noticed on the next FO call: 401 → cookie cleared → the bearer alone fails | `chat/route.ts:148-158`, `auth-bridge.ts:103` |
| Key rotation | One secret, 16-char minimum, no key id | `auth.ts:76-86` |
| Forced password change | FO's middleware answers **403 `{code:"FORCE_PASSWORD_CHANGE", redirectTo:"/force-password-change"}` on every authenticated call** except change-password and logout; login itself succeeds. Neither FO's own client nor the PWA handles the code | FO `auth-middleware.ts:192-206` |
| Password change | FO updates the hash and **revokes no session** | FO `change-password/route.ts:59-68` |
| Several devices, one user | One FO token and one PWA token per login; one conversation list; logout by token | FO `login/route.ts:54-60`, `storage.ts:100` |

**Known defects / failure modes.**
- **m3.** When the PWA token expires, both client sites clear storage and stop; the FO session row lives on for up to 30 days (FO's lazy idle eviction refuses the token if it is used again after 30 minutes, but nothing deletes an unused row). Re-login leaves the previous FO token valid.
- **Logout blocks on FO (G21, owned by RP4).** A slow FO makes Sign out hang, although dropping the cookie needs no FO at all.
- **G5.** An expired or mismatched bearer on an embedded API call gets 401 while the cookie stays; cleanup depends on `fo-shell.js` running.
- **m2.** Rotating `SESSION_SIGNING_SECRET` signs everyone out; no `iat`, `iss`, `aud`; 16-character minimum.
- **G20.** A user whose password must be changed logs in, then every FO call fails with a 403 nobody handles. From the phone there is no way to reach the change-password flow.
- **G30.** FO's sidebar shows "User" instead of the name, and dashboard creation is treated as unknown, because the PWA wrote FO's session blob without `user`.
- **G10.** Any script on the origin can read the PWA bearer and, with the cookie attached automatically, act as the user through the bridge for the life of the session.
- **Idle by API activity** (not a PWA defect; recorded): a supervisor reading for 31 minutes without triggering a request is signed out by FO's timer. **[decided]** FO's semantics stay; changing them is an FO/product decision.

**Desired architecture.** The corrected design, in seven parts.

#### 1. The credential model, kept and stated as rules [decided]

| Rule | Why |
|---|---|
| The FO token lives only in the httpOnly cookie and never reaches JavaScript, a response body or a log | It is a real FO session with the user's role, data and audit trail |
| The PWA bearer lives in localStorage under `llmatscale_auth_token` | FO's embedded client must find a bearer under that key; without it the target architecture does not work |
| **A cookie alone never authenticates a request to FO** | The bearer-plus-cookie pair is the CSRF defence (G26, RP7); a cookie-only design would expose every FO API |
| The PWA keeps **no server-side session store**; FabOrchestrator is the authority for the real session and its revocation | Stateless instances; FO already provides revocation (idle, absolute, admin force-logout), which the PWA notices on the next call |
| Each person uses their own FO account; the PWA adds no logic to tell people apart behind one account. Several devices for the same user work independently | Shared accounts are not a PWA requirement; preventing sharing, per-person identity and cross-device password-change behaviour are FO account-management decisions |
| **Accepted architectural risk (G10):** the PWA bearer is readable by any script on the shared origin (the PWA's, FO's, or an injected one), so an XSS on either application can act as the user for the life of the session. Mitigations: RP7's controls, **partially** (external-origin restriction, `private, no-store`, framing controls; inline-script XSS in FO's own pages remains possible until FO supports a CSP nonce, §9 question 50, and the residual is recorded at CP4; revision 3.9 delta), the 12-hour absolute limit, FO's 30-minute idle eviction, and the FO token never being exposed. This is the same exposure FO's own web UI carries today, where the real token sits in localStorage | Recorded here so it stays visible at every architecture and security review rather than being redesigned away or ignored |

#### 2. Session states and transitions

| State | Entered by | Left by |
|---|---|---|
| **Signed out** | first visit; any end-of-session path | login |
| **Active** | login: both credentials issued together, blob written in FO's shape | idle expiry (FO), absolute expiry (12 h PWA, or FO's), logout, FO revocation, or entering the forced-change hold |
| **Forced-change hold** | login when FO's `/me` answers `FORCE_PASSWORD_CHANGE` | a successful `POST /api/auth/change-password` (→ Active) or logout |
| **Ending** | expiry or revocation noticed anywhere (a `/me` 401, an FO 401 through the gateway, the bearer vanishing from storage, the PWA `exp` passing) | `endServerSession` and `endClientSession` have run (→ Signed out) |

Every exit from Active or Forced-change hold runs through exactly two functions:

- **Server: `endServerSession(req, res, reason)`** (`lib/faborch/session.ts`). Order fixed, and the order is the rule: **(1) clear local authentication state first**: the cleared cookie is written onto the response and the response is returned at once; **(2) then attempt FO revocation**, post-response (Next's `after()` hook), with `foLogout` under the **short bounded deadline** (RP4; proposed 3 s), so a slow or unreachable FO can never delay the local logout by even the deadline; **(3) record the outcome**: `session_end {reason, revoked}` with the token's fingerprint, never the token. The response therefore no longer reports `faborchRevoked`; the log does. It never means revoke → wait → clear. A failed revoke is a warning, not a retry. The fallback is FO's idle rule, stated precisely: FO evicts **lazily**, when the token is next used more than 30 minutes after its last activity, so an unrevoked token is *refused on any later use* but its row persists until the 30-day expiry. That is why every end-of-session path revokes while it still holds the token.
- **Client: `endClientSession(reason)`** (one module imported by `use-session.ts`, `login-page.tsx`, `sign-out-link.tsx`, and mirrored in `public/fo-shell.js`). Order fixed: (1) `POST /api/pwa/auth/logout` with `keepalive: true` and same-origin credentials; (2) remove `llmatscale_auth_token` and `llmatscale_auth_session`; (3) a full-document navigation to `/login` (`?next=` preserved where a return makes sense). Every `/me` 401, every detected expiry and every "token vanished" event calls it. This closes m3 at both of its sites.

#### 3. The corrected flows

**Login** (`POST /api/pwa/auth/login`):
1. Limiter and cross-site gate (RP3), then `foLogin`.
2. **One extra FO call, `GET /api/auth/me` with the new token.** Login has just set FO's activity clock, so this extends nothing. It yields the real role and, when FO answers **403 `FORCE_PASSWORD_CHANGE`**, the forced-change state. Two different 403s reach this flow, and they are **not** presented the same way (delta review RP2-D1, 27 Sept). **(a) A 403 from FO's login itself.** The clone refuses both `DELETED` and `SUSPENDED` with 403 **before it checks the password** ([FO-clone] `login/route.ts:28-42`, then `:44-51`; byte-identical upstream; REQUIRES FO/PRODUCTION CONFIRMATION), so this answer says nothing about whether the password was right. RP3 classifies it `account_inactive` and counts it as a failed attempt (RP3 part 4), and RP5 **presents it exactly as a wrong password**: same status, same code, same wording, no `/me` call, no cookie. Any distinct presentation would let an unauthenticated caller learn an account's status by posting any password: an oracle FO's own login has on its origin (§9 question 45) and the PWA must not add on its own. **[open, RP2-D1: collapse (recommended) or disclose as FO does]**. **(b) A 403 "account is no longer active" from this `/me` probe** is post-password: the caller proved the password and FO minted a token. It becomes a coded login failure (RP5), not "wrong password", **and the PWA revokes the token it was just given before answering**, so no session row is left behind. Under the clone this branch is defence in depth for a status change between login and the probe and for any production divergence; it stays, and its test stays. If the probe answers **401** (a status this step does not otherwise define), the outcome is RP5's `502 upstream_error`: no cookie, the just-minted token revoked pre-response under RP4's `revoke` class (revision 3.10 delta, RP5-R11). If the probe fails for any other reason (network, 5xx, timeout), login proceeds without the role and logs the probe failure; the forced-change state is entered only on the explicit code.
3. **If the request carries a cookie with a different FO token, revoke that token first** (re-login revokes what it replaces), under the same short deadline.
4. Mint the PWA token: `exp = min(now + 12 h, FO expiresAt)` **[decided: 12 h kept; revisit only on a product decision]**, with `iat`, `iss: "faborch-pwa"`, `aud: "faborch-pwa"` and the key id `kid` (part 5).
5. Respond `{token, expiresAt, user, next}`, with `next = "/force-password-change"` in the forced-change state; the cookie is set on the same response **with `Max-Age = (exp − now) + G`**, i.e. the PWA session's lifetime plus a short grace `G` (named input `SESSION_COOKIE_GRACE_S`, default 5 minutes, startup assertion `0 < G ≤ 15 min`; `Max-Age` rather than an absolute `expires` so phone clock skew does not matter; revision 3.12 delta, WHOLE-R2, RP2-D11), not FO's 30-day expiry: the document gate stays presence-only, and because the cookie outlives the bearer by `G`, the first FO API call after `exp` takes the G5 path (401, cookie cleared, FO token revoked), so absolute expiry revokes **when the device is used within `G` after `exp`**; if it is not (the common overnight case), the cookie drops, the token then exists nowhere on the device, and FO's idle rule refuses it, leaving only an FO session row until FO's 30-day expiry, recorded as m3's residual (RP2-D12); a phone is still not admitted to FO's pages for longer than `G` after its session ended. A browser-level test with real cookie expiry pins it.
6. The login page writes **FO's blob shape** to `llmatscale_auth_session`: `{user: {id, email, name, canCreateDashboards}, signedInAt, expiresAt}` (G30), then navigates to `next` or the return path. If writing to storage fails (private mode, quota), the page calls `endClientSession("storage_unavailable")` so the cookie just set does not outlive a bearer that was never stored.

**Normal request:** the four checks, unchanged, in **one shared implementation** (`lib/auth/verify-session.ts`) used by both `requireAuth` and `bridgeAuthorization`, so the two cannot drift. `/api/pwa/auth/me` still makes no FO call, so PWA screens never extend FO's idle clock (`lib/auth.ts:23-28` stays true).

**Gateway refusal (G5):** when the bearer *verifies* but is expired, or its `fp` does not match the cookie, the gateway runs **`endServerSession(req, res, "gateway_refusal")`** with the same order: the 401 goes back at once with the cookie cleared, and the FO token read from that cookie is revoked post-response under RP4's `revoke` class (wording corrected in revision 3.11, delta). Clearing alone would not do: the client's follow-up `POST /api/pwa/auth/logout` arrives with no cookie and cannot revoke, so the FO token would stay unrevoked until FO's 30-day expiry (refused on use after 30 idle minutes, but still a live row). The session is over either way, and a same-origin script can already trigger logout, so this grants no new capability. A malformed bearer changes nothing (it may be a stray header).

**Idle [decided: FO's semantics stay]:** the enforcer is FO's client timer plus `fo-shell.js` on FO's pages. The PWA adds no idle logic of its own: in the target architecture its only documents are `/login`, `/offline`, `/diagnostics` and the front door, none of which holds a session open, and the PWA cannot probe FO for liveness without extending the session (every authenticated FO call bumps `last_activity_at`). Detection on the next call is therefore the correct design, and it is recorded that idle is measured by API activity, not by touches.

**Absolute expiry:** PWA `exp` passing → `/me` 401 → `endClientSession("pwa_expired")`. FO's expiry → the next FO call is 401 → the server clears the cookie → `endClientSession("fo_expired")`.

**Logout:** `endServerSession(req, res, "user")`; the client path follows. `/api/pwa/auth/logout` stays bearer-less (`fo-shell.js` calls it after FO has already deleted the bearer) but gains the **same-origin gate** (`Sec-Fetch-Site` / `Origin`, RP3's helper): a request whose headers say it is cross-site is refused; a request with **neither header** is allowed. Why that is safe enough for logout specifically: every browser the app supports sends `Sec-Fetch-Site` (Safari from 16.4, the app's install floor; Chrome and Firefox for years), and browsers send `Origin` on cross-origin POSTs, so a request carrying neither is a non-browser client or a very old browser, not a forged form post; the only thing a forged logout can achieve is to sign the user out (a nuisance, not access), because FO data access is protected separately by the bearer-plus-cookie rule; and failing closed would risk trapping a user in a session they cannot end from a client that omits the headers. The route is idempotent (no cookie → 200, no FO call).

**Forced password change (G20) [decided]:** detected at login (step 2). After that, the gateway passes FO's 403 body through untouched, FO's `/force-password-change` document is forwarded (it is in the catalogue), `/api/auth/change-password` is allow-listed (RP1), and on success FO's page navigates on. Because FO's own client has no handler for the code, the login-time detection is what makes the flow reachable from the phone at all. **Dependency on FO** ([FO-clone] `change-password/route.ts:64`): FO's change-password route updates the hash but **does not clear `forcePasswordChange`**, so in the clone the user would still be refused after changing the password. The PWA cannot clear the flag. Until the FO owners confirm production behaviour (§9), the PWA's login probe treats a `FORCE_PASSWORD_CHANGE` answer on the login *following* a password change as a coded, explained failure ("your administrator must clear the password-change requirement") rather than sending the user round the loop again.

**Production go-live dependency (external, FO).** If production FO behaves as the clone does, **the PWA cannot complete the forced-password-change lifecycle by itself**: it can detect the state and deliver the user to FO's change page, but only FO can clear the flag that ends the state. RP2 is frozen with the PWA half designed and tested against a stub; the flow is **not accepted for production** until the FO owners confirm that production's change-password clears `forcePasswordChange` (or fix it). This is recorded as a go-live dependency in CP5 and as §9 question 44, not as an error-message matter.

**Revocation [decided: stateless; FO is the authority]:** idle eviction (by token) ends one device; an FO admin force-logout (by user id) ends all of that user's devices; each is noticed on that device's next FO call, which clears the cookie and ends the PWA session. No PWA-side store.

#### 4. Several devices, one legitimate user
Each login mints its own FO token and PWA token; the sessions are independent; logging out one device leaves the others working; the conversation list is shared because it belongs to the user. Password changes do not revoke other sessions (FO behaviour; an FO account-management matter, not a PWA one).

#### 5. Signing-key rotation (m2) [decided: explicit, non-secret key ids]

| Variable | Meaning |
|---|---|
| `SESSION_SIGNING_KEY_ID` | The current key's **public, non-secret identifier**, for example `2026-09`. It is written into every new token as `kid` |
| `SESSION_SIGNING_SECRET` | The current secret (signs and verifies); minimum 32 characters |
| `SESSION_SIGNING_PREVIOUS_KEYS` | Zero or more `id:secret` pairs, comma-separated, **verify-only**, kept for one transition period |

`verifyToken` reads `kid`, looks it up in the map of current plus previous keys, verifies with that secret, and refuses an unknown or missing `kid` (a short compatibility window in which a missing `kid` means "current" covers tokens minted before the ring ships, then is removed). The `kid` is never derived from the secret, so it reveals nothing. **Rotation procedure** (documented in `.env.example`): set a new id and secret as current, move the old pair to previous, wait one absolute TTL (12 h), remove it. Nobody is signed out unless a key is removed early. Startup refuses a secret shorter than 32 characters or an empty key id.

#### 6. Instances
Stateless: every instance carries the same current and previous keys. Nothing else in RP2 is per process.

#### 7. What RP2 does not do
No PWA idle timer; no session store; no logic for people sharing an account; no change to FO's semantics. The 12-hour absolute limit and FO's API-activity idle rule are recorded as the current policy, revisitable by product decision.

#### Finding map

| Finding | Problem | Root cause | Fix | Components | Test |
|---|---|---|---|---|---|
| m3 | PWA expiry leaves the FO session alive; re-login leaves the old token valid | Two client sites clear storage without revoking; login never revokes the replaced cookie | `endClientSession` everywhere; login step 3 | `use-session.ts`, `login-page.tsx`, `sign-out-link.tsx`, `login/route.ts`, `session.ts` | For each expiry site the stub FO receives `/api/auth/logout` with the old token and the response clears the cookie; login with an existing cookie revokes the old token before the new login is minted |
| G21 (RP4) as it affects sessions | Sign-out hangs on a slow FO | `await foLogout` before clearing | `endServerSession`: clear and respond first, revoke post-response under the deadline | `logout/route.ts`, `session.ts`, `client.ts` | Stub FO that never answers: the response arrives **promptly, well inside the deadline**, with the cookie already cleared; the stub then receives the revoke attempt; `session_end` is logged with `revoked:false` once the deadline fires |
| G5 | Expired or mismatched bearer refused, cookie kept | The bridge returns a verdict only | `endServerSession` on `expired` and `mismatch`: clear the cookie and respond first, then revoke at FO post-response under the bounded deadline (the revision 3.4 order; cell corrected in revision 3.8, delta review) | `fo-gateway route.ts:86-91`, `auth-bridge.ts`, `session.ts` | Expired bearer + valid cookie → 401, the stub FO receives `/api/auth/logout` with that token, `Set-Cookie` clears; malformed bearer → 401, no FO call, no cookie change |
| m2 | Rotation signs everyone out; weak minimum; no claims | Single key, no id | Key ring with explicit `kid`, 32-char minimum, `iat/iss/aud` | `auth.ts`, `.env.example` | A token signed under a previous id verifies; an unknown id fails; a 16-char secret fails startup; wrong `aud` fails; rotation test: sign under `2026-09`, rotate to `2026-10` with `2026-09` in previous, the old token still verifies, then fails once removed |
| G20 | Forced-change users are stuck behind 403s from the phone | FO signals the state only on post-login calls that no client handles | Login-time `/me` probe → `next: /force-password-change`; pass-through afterwards; explained failure if FO does not clear the flag | `login/route.ts`, `login-page.tsx`, RP1 rows | Stub FO `/me` → 403 `FORCE_PASSWORD_CHANGE`: login answers 200 with `next` set and the cookie; the page navigates there; the change-password call is forwarded with the injected token; stub FO `/me` → 403 "no longer active" → coded login failure, **the stub receives a revoke of the just-issued token**, no session minted; stub `/me` → 5xx → login succeeds without a role |
| G30 | FO's pages show "User" and treat dashboard rights as unknown | The PWA writes `{expiresAt}` where FO expects `{user, signedInAt, expiresAt}` | Write FO's shape from the login response | `login-page.tsx`, `login/route.ts` | Rendered test: after login the blob parses to FO's shape with the real name; read-only live check on preview: FO's sidebar shows the user's name |
| G10 | Bearer readable by any same-origin script | Inherent to hosting FO's client on the origin | Accepted risk (part 1), mitigated by RP7 | docs; RP7 | The login response never contains the FO token (`session.test.ts:162`, kept); a cookie-only request never yields an injected FO token on any `fo-api` row: a `required` row answers 401 coded and forwards nothing, an `optional` row is forwarded without `authorization` (`injection.test.ts:53`, narrowed to the `optional` rows by RP1's G31; the release-blocker form of this test is RP7 part 3); RP7's header tests |
| G26 constraint (RP7) | A cookie-only design would expose FO APIs to CSRF | — | Part 1 rule; the same-origin gate on logout | `logout/route.ts` | A cross-site `POST /api/pwa/auth/logout` gets 403 and the cookie survives |

**Relevant code.** `lib/auth.ts`, `lib/auth-middleware.ts`, `lib/faborch/session.ts`, `lib/gateway/auth-bridge.ts`, new `lib/auth/verify-session.ts`, `app/api/pwa/auth/{login,logout,me}/route.ts`, `components/fab/use-session.ts`, `components/login-page.tsx`, `components/fab/sign-out-link.tsx`, `public/fo-shell.js`, `.env.example`; FO references: `claudeai_athena/lib/auth-middleware.ts`, `components/providers.tsx`, `hooks/use-idle-timeout.tsx`.

**Design decisions.**
- *Derived technically:* the two-credential model with its three rules; one server and one client end-of-session path with a fixed order; a bounded FO revoke that never blocks the response; re-login revokes the replaced token; the gateway clears the cookie on expired or mismatched refusals; shared verification code; `iat`, `iss`, `aud`; FO's blob shape (G30); the login-time `/me` probe for forced change and suspension; the same-origin gate on logout; stateless instances with a shared key set.
- *Decided 24 September 2026 (Amay):* the absolute PWA limit stays **12 hours**; FO's **idle semantics stay** (API activity, not touches); **no PWA session store**, FO is the authority for revocation; **shared accounts are not a PWA requirement** (per-person identity and cross-device password-change behaviour are FO account-management matters); the **forced-change probe** design; **key rotation with explicit non-secret key ids**; **G10 accepted and recorded**, mitigated through RP7.
- *Still open, for others:*
  - **FO owners:** whether a password change should revoke a user's other sessions (an FO account-management question, raised for their information); **whether production's change-password clears `forcePasswordChange`** (the clone does not, which would leave a forced-change user refused even after changing the password); production values for idle and absolute expiry; a test account in the forced-change state for the live check.
  - **RP4 / CP3:** the exact revoke deadline (3 s proposed).
  - **Product, later:** the 12-hour limit and the API-activity idle rule are recorded as current policy, to be revisited only if Jothi or product asks.

**Implementation stages.**
1. Write the state table and the expiry-site inventory into `docs/` from this section (no code).
2. CP2: review of this design.
3. `endServerSession` and `endClientSession`; wire all four client sites and `fo-shell.js`; the same-origin gate on logout (m3, G21's session half).
4. Shared `verify-session.ts`; the G5 cookie clearing in the gateway refusal path.
5. Key ring with explicit ids, claims, 32-char minimum; `.env.example` procedure (m2).
6. Login: the `/me` probe, the replaced-token revoke, `next`, FO's blob shape (G20, G30).
7. Tests below; the read-only live checks.

**Tests** (behavioural; stubbed FO unless noted):
- Every expiry site (the `/me` 401 in `use-session.ts`, the login page's check, `sign-out-link`, `fo-shell.js` on a vanished key) reaches `/api/pwa/auth/logout` and leaves neither localStorage key behind.
- Logout against a hanging FO: the response arrives promptly (asserted well under the deadline, not merely within it) with the cookie already cleared; the stub receives the revoke attempt afterwards; `revoked:false` is logged when the deadline fires. Local session state is cleared regardless of the revoke outcome.
- Logout without a cookie: 200, no FO call. (a) Explicit cross-site logout (`Sec-Fetch-Site: cross-site`, or an `Origin` that is not this origin): 403, cookie kept, no FO call. (b) Logout with neither `Origin` nor `Sec-Fetch-Site`: 200, cookie cleared. (c) Logout with the stub FO hanging or answering 5xx: the cookie is cleared and the client's localStorage keys are removed regardless of the revoke outcome.
- The cookie is set with `Max-Age = (exp − now) + G` (never an absolute `expires`, so phone clock skew does not matter); during `G` an `fo-api` call with the expired bearer → 401, the stub receives the revoke and the cookie is cleared; after `G` the browser has dropped the cookie and the document gate redirects (replaces the revision 3.4 test that pinned equal expiry, and `session.test.ts:69`; revision 3.12 delta, RP2-D11).
- **Combined RP1/RP2 scenario:** a bearer past `exp` on an FO page makes an `fo-api` call → the gateway answers 401, the stub FO receives the revoke, the cookie is cleared; the client's follow-up logout is a 200 no-op; a later `fo-api` call carrying only the same cookie value is refused 401 by the gateway and not forwarded (RP1 G31; on an `optional` row it would be forwarded without `authorization`) (FO answers 401); the document gate now redirects to `/login`.
- Login with an existing different cookie: the stub sees a revoke of the old token, then the new login.
- `requireAuth` and `bridgeAuthorization` give identical verdicts across a table of inputs: no bearer, malformed, mis-signed, expired, no cookie, empty cookie, mismatched `fp`, wrong `aud`, unknown `kid`, valid.
- The gateway refusal clears the cookie for expired and mismatched bearers, not for malformed ones.
- Key rotation sequence as in the finding map.
- Login `/me` probe: forced-change → 200 with `next`; suspended → coded failure and no session; ordinary → the real role in the session.
- The blob written after login parses to FO's shape.
- **Several devices**: three logins for one user produce three distinct FO and PWA tokens; logging out one leaves the other two passing both `requireAuth` and the bridge (extends `session.test.ts:205`).
- `/api/pwa/auth/me` makes no FO call (pinned).
- **Live, dedicated test account, own sessions only:** after each expiry path, FO's `/api/auth/me` with the old token is 401; a second login yields a different token; FO's sidebar on preview shows the account's real name (read-only observation).

**Acceptance criteria.**
- No expiry path leaves the FO session unrevoked on the stub, and the live check confirms it for the test account.
- Sign-out returns promptly with the cookie cleared while FO is unreachable; the revoke attempt and its outcome appear in the log afterwards.
- Rotating the key in a test signs nobody out; removing a previous key does.
- A forced-change test account lands on `/force-password-change` from the phone (stub-tested). Completing the flow in production is a go-live dependency on FO clearing `forcePasswordChange` (CP5); until confirmed, the flow is marked not accepted for production.
- The G10 risk statement is present in the plan and referenced from CP2 and CP4.

**Regression risks.**
- Redirect loops between the sign-in gate, FO's guards and `fo-shell.js` (`proxy.ts:176-182`).
- Breaking the WP2 bridge or the cookie-alone-never-authenticates rule.
- Accidentally extending FO's idle clock from a PWA route.
- The `kid` compatibility window: tokens without a `kid` must keep verifying until one TTL after the ring ships.
- iOS storage behaviour in installed apps.

**Demo / verification.**
1. Three browser profiles sign in with the same account; logging out one leaves the other two working.
2. With FO's logout stubbed to hang, Sign out returns immediately and the cookie is gone.
3. `SESSION_TTL_HOURS` set short: after expiry, FO's `/api/auth/me` with the old token returns 401.
4. A forced-change account logs in from the phone and lands on FO's change-password page.

**Concepts to learn.** Stateful versus stateless sessions; HMAC tokens and the claims `iat`, `exp`, `iss`, `aud`, `kid`; key rotation with verify-only keys; cookie attributes (HttpOnly, Secure, SameSite); what an XSS can do with localStorage and why a bearer header defeats CSRF; OWASP Session Management (idle versus absolute timeout); revocation by token versus by user; token exchange and bridging; forced credential rotation flows.

**Design-review questions.**
- Why can't a bearer copied from localStorage be used on its own?
- What happens to FO's session when the PWA's expires, and what closes it if the revoke fails?
- Why not validate against FO on every navigation?
- FO's idle timer counts API calls, not activity: who decided that stays, and where is it recorded?
- What would a cookie-only design do to CSRF protection?
- What can an XSS in FO's UI do now that it shares your origin, and where is that risk written down?
- Why is the `kid` not derived from the secret?
- How does a forced-password-change user get unstuck from the phone?

---

### RP3 — Login protection and abuse control

> **Status (revision 3.11).** Design-review depth. First independent review run (record at the end of the section): 0 BLOCKING, 7 FIX NOW, 5 DEFER; all FIX NOW corrections applied below; second round run and applied (two-round cap reached). Values `F`, `W`, `D_0`, `D_max`, `C_src`, `R_src` are **parameters** with provisional defaults, not decisions. **Not frozen.**

**Purpose.** Protect the only public door in front of production FabOrchestrator's identity store, `POST /api/pwa/auth/login`, against credential guessing, credential stuffing, deliberate lockout and cross-site misuse, without ever refusing a correct password because of somebody else's mistakes. In `whole` mode the PWA's own form is still the one login (RP1 denies FO's `/api/auth/login` and `/api/auth/register`), so this route is the only sign-in path on the origin and survives the cutover unchanged.

**Included findings.** **B2** (any success resets the throttle; a burst passes the check), **B3** (eight typos lock out a site), **m1** (process memory; forgeable source off Fly), **m5** (cross-site posts and any content type accepted).

**Obligations from the frozen RPs.** RP2's logout uses "RP3's helper" (cross-site → 403, neither header → allowed): part 5 defines it with exactly those semantics. RP1's G31 cap "shares RP3's store interface once that exists": part 6 defines the store, stage 9 moves the cap onto it under its own namespace. RP1's `clientIdentity` is the only source key (part 3). RP5 presents; RP3 counts and classifies (part 4).

**Current architecture** ([code]; FO facts [FO-clone]). `clientAddress` (`rate-limit.ts:70-76`): `fly-client-ip`, else the **first** XFF entry, else `"local"`. `checkLoginAllowed` before the body (`login/route.ts:57-64`): one Map per address, 8 failures per 10-minute fixed window. `req.json()` unbounded; `LoginSchema` without normalisation; no Content-Type, `Origin` or `Sec-Fetch-Site` check; `isFabOrchConfigured()` → 503 (`:81-87`). `foLogin` folds FO 401 and 403 into `null`; failures recorded **after** the await (`:105`); **any** success clears the **address** (`:128`); oldest-first eviction at 10,000 addresses. FO's login has no throttle, records only successes, matches `email` case-sensitively (`findUnique`), answers 401 for unknown email and wrong password with different messages, and answers 403 for `DELETED` and `SUSPENDED` **before verifying the password** (`login/route.ts:28-42`, then `:44-51`; the KDF is scrypt, `lib/encryption.ts:94-100`). The tests enshrine the defects (`rate-limit.test.ts:61, :68, :99, :103`). No RP3 code exists yet: `lib/login-protection/` and `lib/gateway/client-identity.ts` are designs.

**Threat model** (stage 1). T1 guessing at one account from many sources; T2 stuffing and spraying; T3 lockout as denial of service (residual exposure and the device-trust option in part 4); T4 shared-office collateral (B3); T5 login CSRF (m5); T6 reset by own account (B2); T7 burst race (B2); T8 dilution and amnesia across instances and restarts (m1); T9 source forgery (m1), including a request that reaches the ALB without passing the edge (part 3); T10 direct-to-FO bypass (FO owners, §9 question 45); T11 enumeration and account-status timing: FO runs its password KDF only for an account that exists **and is active**, so an unauthenticated caller can separate active from inactive-or-unknown by timing even when the PWA's messages are byte-identical; the channel is FO's (§9 question 45), the PWA adds no message-level oracle and does not pad responses; T12 store exhaustion (eviction direction in part 6).

#### 1. Components

| Component | Responsibility |
|---|---|
| `app/api/pwa/auth/login/route.ts` | Orders the checks: same-origin → content type → body class → schema → `not_configured` → **reserve** → `foLogin` → classify → **settle** → RP2 login steps 2–6 |
| `lib/login-protection/same-origin.ts` | `sameOriginVerdict(headers, self)` → `same-origin` / `cross-site` / `unknown`; `self` = `PUBLIC_ORIGIN`; shared with RP2's logout and RP7's CSP report endpoint |
| `lib/login-protection/account-key.ts` | `accountKey(email)` = `HMAC-SHA-256(k_login, normalise(email))[0:16]`, `normalise` = trim, NFKC, lower-case; `k_login` from a **dedicated** `LOGIN_PROTECTION_SECRET` (32+ chars), not from the session signing key, so a session-key rotation does not reset the counters and a rolling deployment cannot split an account's bucket across old and new tasks (review RP3-R12) |
| `lib/login-protection/limiter.ts` | `reserve(accountKey, source, now)` → `{allowed, retryAfterSeconds, reservation}`; `settle(reservation, outcome, now)`; the compensation order in part 4 |
| `lib/login-protection/store.ts` | `CounterStore` (part 6): `reserve`, `settle`, `clear`, `tokenBucketTake`, `refund`, `size`; `MemoryCounterStore`; `SharedCounterStore` (built only when CP5 chooses several instances) |
| `lib/login-protection/policy.ts` | `F`, `W`, `D_0`, `D_max`, `C_src`, `R_src`, per-namespace capacities, `LOGIN_PROTECTION_FALLBACK`; a startup assertion that `F ≥ 1`, `W > 0`, `D_0 ≤ D_max ≤ W`, `C_src > F` |
| `lib/gateway/client-identity.ts` (RP1) | The source key and `proto`; consumed unchanged. RP3 additionally reads the *configuration* (`TRUSTED_PROXY_HOPS` set, or `fly-client-ip` expected) to tell the two `null` cases apart (part 3) |
| `__tests__/platform/login-protection.test.ts`, `__tests__/faborch/login.test.ts` | The behavioural tests in part 9 |

#### 2. Request flow

```
POST /api/pwa/auth/login
 1. sameOriginVerdict(headers, PUBLIC_ORIGIN)   cross-site → 403 {code:"cross_site_request"}          body not read by the route
 2. Content-Type                                not application/json → 415 {code:"unsupported_media_type"}  body not read by the route
 3. body class small-json (16 KiB, RP1)         over → 413 {code:"body_too_large"}
 4. LoginSchema                                 invalid → 400 {code:"invalid_request"}
 5. isFabOrchConfigured()                       false → 503 {code:"not_configured"}; nothing reserved
 6. a = accountKey(email);  s = clientIdentity(headers).ip     (null handling: part 3)
 7. r = limiter.reserve(a, s, now)              refused → 429 {code:"login_rate_limited"} + Retry-After; FO never called
                                                store unavailable → 503 {code:"login_protection_unavailable"}; FO never called
 8. foLogin(email, password)                    typed email, unnormalised; RP4 class `bounded`
 9. classify: 200 → success | 401 → bad_credentials | 403 → account_inactive
             | 400, 5xx → upstream_error (indeterminate) | 429 → faborch_unavailable with FO's Retry-After passed through
             | network → faborch_unavailable | timeout → upstream_timeout
             | malformed → upstream_invalid   (all indeterminate)
10. limiter.settle(r, outcome)                  success → clear(a) only
                                                bad_credentials, account_inactive → r becomes a recorded failure on a
                                                indeterminate → r released; s's token refunded
                                                settle/refund failure → logged, never changes the outcome (part 6)
11. success → RP2 steps 2–6 (probe, replaced-token revoke, mint, cookie, blob)
    bad_credentials / account_inactive → one identical response (RP5 `invalid_credentials`, 401; RP2 step 2a)
    indeterminate → RP5's code for the cause, as RP5 part 3 maps it (502 `upstream_error` for FO 400/5xx, 503 `faborch_unavailable` for a connection failure or FO's 429 with its `Retry-After`, 504 `upstream_timeout`, 502 `upstream_invalid`)
```

"Body not read by the route" is exactly that: Next holds the whole upload, up to the framework ceiling, before the route **and before `proxy.ts` can answer** (RP1 part 3, corrected by WHOLE-R1), so steps 1–2 save the route's work, not the server's buffer. The pre-buffer refusal of a login body above 16 KiB is therefore done by **RP10-B's pre-Next entry** on the declared length, with the edge's body-method rate rule in front of it; `proxy.ts` refuses nothing earlier than the route could.

#### 3. Keys, and the two questions they answer

- **Why rotating IP addresses cannot bypass account protection.** The account bucket is keyed by `accountKey(email)` alone and counts every failure whatever the source. An attacker with a thousand addresses makes a thousand attempts at one account and sees the account bucket refuse after `F` regardless of where the attempts came from; the source bucket is a second, independent limit, not the only one (test 1).
- **Why one successful account cannot reset another.** `settle(success)` calls `clear(a)` for the authenticated account's key only; no code path clears a source bucket or any other account key (test 2).
- **Account key details.** Normalised for keying only; the credential FO receives is exactly what was typed, because FO matches `email` unnormalised. `k_login` keeps plaintext emails out of the store and logs; rotating `LOGIN_PROTECTION_SECRET` is a deliberate, rare reset of all counters and is documented as such in RP10-B's secrets row. The prefix `login-account:` is part of the key.
- **Source key, and the two meanings of `null`** (reviews RP3-R2, R17). `clientIdentity(headers).ip` verbatim, prefix `login-source:`. The identity source is named by one configuration knob, **`CLIENT_IDENTITY_SOURCE = fly | xff | cloudfront-viewer`** (with `TRUSTED_PROXY_HOPS` for `xff`), read by RP1's `clientIdentity`, by RP3 and by RP10-B's startup assertion. **RP3 requires `clientIdentity` to yield `ip = null` when an `xff` chain has fewer than `N` entries** (RP1 part 4 now states this; delta review). RP1 returns `null` in two situations that RP3 must treat differently, and RP3 can tell them apart from the configuration alone: (a) **no identity source configured** (no `TRUSTED_PROXY_HOPS`, no `fly-client-ip` expected): the source dimension is disabled, `login_source_identity_unavailable` is logged once per process at warn, and RP10-B's startup assertion refuses this in production; (b) **identity source configured but the trusted position is absent** (an XFF chain shorter than `TRUSTED_PROXY_HOPS`): the request did not come through the edge, so it is **refused** with `403 {code:"untrusted_ingress"}` (RP5) and logged `client_identity_untrusted`, before any reservation. Exempting case (b) would let anyone who reaches the ALB directly spray without a source limit; RP10-B part 1 therefore requires the ALB to accept only edge traffic, and the same rule applies to the `anon-cap` namespace in stage 9.

#### 4. The two dimensions and the reserve/settle protocol

**Account bucket** (`login-account:<hash>`; T1, T3, T6). Entry `{failed, inFlight, firstFailureAt, lastFailureAt}`; the entry **expires `W` after `lastFailureAt`** and `failed` resets with it (a sliding expiry, not a sliding count; this is what the 120-byte sizing in part 6 assumes; review RP3-R4). Policy: **progressive delay** (recommended, part 8): once `failed ≥ F`, `reserve` refuses with `Retry-After = min(D_max, D_0 · 2^(failed − F))` measured from `lastFailureAt`; one attempt is admitted when it lapses; there is no administrator-only release. When the refusal is caused by `inFlight` alone (`failed < F ≤ failed + inFlight`), `Retry-After` is the `bounded` class budget rounded up, minimum 1 s. Fixed rules: (1) every failure counts, from any source; (2) success clears **this** account only; (3) indeterminate never counts; (4) the two dimensions never read each other; (5) FO's pre-password 403 (`account_inactive`) counts exactly like a 401, so the limiter cannot reveal which accounts are inactive (RP2-D1).

**Residual T3 exposure and the device-trust option** (reviews RP3-R9, R13, R18). A persistent attacker who retries the moment each delay lapses takes the single admitted slot every time; `D_max` bounds each wait, not the lockout, so the account's owner is kept out for as long as the attack lasts, at one request per `D_max`. The mitigation offered for decision is a **device-trust cookie bound to the account**: on a successful login the PWA sets `faborch_device`, httpOnly, `Secure` per RP1's scheme rule, `SameSite=Lax`, `Path=/api/pwa/auth/login`, payload `{deviceId (≥ 128-bit random), accountKey, issuedAt}` signed with `HMAC(k_login, payload)`; one cookie per account a browser has signed into (a bounded set). A login whose `accountKey(typed email)` equals the cookie's `accountKey` gets a **larger per-(device, account) budget `F_dev`** (parameter; e.g. `4·F` per `W`) **instead of `F`**; it is never an unconditional bypass, so a shared device gets a bounded budget, not source-rate-only guessing. Failures from an exempt device **still settle into the account entry** (they throttle every other source and fire `login_throttled`). A cookie earned on account B exempts nothing at account A. An invalid, expired or non-matching cookie is ignored, never a refusal; the cookie survives `endServerSession` and logout (it relaxes a throttle, it authenticates nothing) and is re-issued on each success (sliding lifetime). A new phone's first login is not exempt. **[open, §9 question 53]**: accept the residual exposure, or adopt the bound exemption in the first release (recommended: adopt; it is small and it is the only thing that separates the owner from the attacker at the account level). Theft and forgery: httpOnly and `Secure` block script and network; a same-origin XSS already holds the bearer (G10) so gains nothing; the HMAC is keyed with a 32-character secret.

**Source bucket** (`login-source:<ip>`; T2, T4). A token bucket of capacity `C_src` refilled at `R_src` per second, sized for an office. It bounds guesses per source across all accounts; it never locks. A correct password from a source at zero tokens waits `Retry-After = ceil((1 − tokens)/R_src)`. **B3 under this design:** eight typos from one office fill eight account buckets by one each and take eight of `C_src` tokens; nobody is refused; the acceptance scenario (a correct password from a source with 40 foreign failures) succeeds because `40 < C_src` and the account has no failures.

**Reserve, then settle, with compensation** (T7; reviews RP3-R1, R14, R15, R16). The two dimensions live under different keys, so `reserve` is **two store operations in a fixed order**: (i) `tokenBucketTake(login-source, s)`; if refused, stop (no account write has happened) and answer 429 by `source`; (ii) `reserve(login-account, a)`, which atomically records a new reservation and refuses per the **admission predicate**: admit iff (`failed < F` and `failed + inFlight < F`) or (`failed ≥ F` and `now ≥ lastFailureAt + delay(failed)` and `inFlight = 0`), where `delay(failed) = min(D_max, D_0 · 2^(failed − F))` computed in floating point (an integer shift would wrap; test 14 pins `failed = F + 100 → D_max`). If (ii) refuses, `refund(login-source, s)` and answer 429 by `account`. **`Retry-After` for every refusal** = `max(1 s, max(remaining delay, earliest live reservation deadline − now))`. **Every reservation has its own deadline** = reserve time + `T_total_bounded` + margin; `inFlight` counts only live reservations and expired ones are dropped at the next operation; the entry expires at `max(lastFailureAt + W, latest reservation deadline)`, so an entry holding only leaked reservations self-heals and a defect can never hold an account for the life of the process (the shared store sets the key TTL on reserve as well as on failure). **`reservationId` is unique per reservation** (random, or entry generation plus sequence), stored as a field of the entry; `settle` and `refund` locate the reservation by id and are no-ops when the id is absent, **including when the key was cleared by a success and recreated by a newer reservation** (the ABA case); the memory store keeps a set of live ids, never a bare counter. `settle` moves a live reservation to `failed`, or drops it on success or indeterminate, plus `refund(login-source, s)` on indeterminate; **the route settles in a `finally`**, so any throw after reserve settles indeterminate and refunds the source token. No check-then-act spans an `await` within one store; the memory store runs each operation to completion on the event loop, and the shared store runs each as one server-side script on one key (part 6). Twenty parallel wrong guesses at one account: the first `F` reservations succeed, the twenty-first sees `inFlight = F` and is refused, and the stub FO receives exactly `F`; a concurrent success at that account clears the entry, and a further wrong guess that reserves before the old settles land ends with `failed = 1, inFlight = 0` because the old ids no longer exist (test 3). Because the source token is taken first, a source at zero tokens can never raise a victim account's `inFlight` (test 16).

**FO's inactive-account 403 without an oracle.** The response for `account_inactive` is byte-identical to `bad_credentials` (RP5 `invalid_credentials`, 401, same wording, no `/me` call, no cookie), and it is counted identically. The class is visible only in the server log. The post-password `/me` probe 403 may be distinct (RP2 step 2b). FO's timing channel (T11) remains FO's.

#### 5. The same-origin gate and JSON-only (m5)

`sameOriginVerdict`: `Sec-Fetch-Site: same-origin` → `same-origin`; `cross-site` or `same-site` → `cross-site`; `none` → `unknown`; else `Origin` present: equal to `PUBLIC_ORIGIN` → `same-origin`, anything else including `null` → `cross-site`; neither header → `unknown`. Login refuses `cross-site` and allows `unknown`, the rule RP2 fixed for logout: every supported browser (Safari ≥ 16.4, Chrome, Firefox) sends `Sec-Fetch-Site` on every request and `Origin` on every POST, so a header-less POST is a non-browser client, which cannot be a CSRF victim. **What m5's closure does and does not do:** a missing `Origin` *and* a missing `Sec-Fetch-Site` is allowed deliberately; a forged form post from any supported browser carries at least one and is refused. `PUBLIC_ORIGIN` is configured and validated at startup, never derived from `Host` (RP2/RP3-D3). `Content-Type` must be `application/json` (parameters allowed): a form can send only urlencoded, multipart or `text/plain`, so this alone defeats a forged form post. Both checks run before the route reads a byte of the body.

#### 6. The store: interface, namespaces, eviction, sharing with G31, unavailability

`CounterStore` (every operation is atomic on its own key; `reservationId` identifies the account entry's in-flight slot and lives inside that key's own hash so `settle` is single-key on Redis):
```
reserve(ns, key, limit, windowMs, now)  → {allowed, inFlight, failed, retryAfterSeconds, reservationId}
settle(ns, reservationId, outcome, now) → void   (no-op if the entry is gone)
clear(ns, key)
tokenBucketTake(ns, key, capacity, refillPerSecond, now) → {taken, tokens, retryAfterSeconds}
refund(ns, key)                          → void   (no-op if the bucket is gone or full)
size(ns)
```
Namespaces: `login-account`, `login-source`, `login-device` (only if §9 question 53 adopts device trust: keyed `HMAC(k_login, deviceId‖accountKey)`, the same reserve/settle protocol and reservation ids, its own capacity and TTL `W`; a trusted request is admitted while the device entry is below `F_dev` and the account entry's live `inFlight` bound still applies; failures settle into both; WHOLE-R10), `anon-cap` (RP1's G31 cap, stage 9), `csp-report` (RP7). **Capacity is accounted per namespace**, so a flood in one namespace can never evict entries in another. **Eviction within `login-account`** (review RP3-R6): at capacity, evict the entry with the **lowest `failed + inFlight`** first, **ties broken by most recently created first** (a flood always arrives after the target; review RP3-R19); a flood entry has `failed = 1` and a throttled target has `≥ F`, so a flood of distinct unknown emails evicts itself, never the account under attack, and an account at `F − 1` is not evicted by a flood raised to `F − 1` either. Within the token-bucket namespaces, evict the fullest (most idle) bucket first. Every eviction at capacity logs `limiter_store_full {ns, size}`. **How G31 shares the store without interfering:** different namespace, different prefix, separate capacity; `tokenBucketTake` on `anon-cap:<ip>` never touches `login-source:<ip>`.

`MemoryCounterStore`: a bounded map per namespace (about 120 bytes per entry; 100,000 entries per namespace is about 12 MB; the shared store's capacity is set by RP10-B L2 well above that). Atomicity is the event loop.

`SharedCounterStore` (only if CP5 chooses several instances): Redis (ElastiCache) with `reserve`, `settle`, `tokenBucketTake` and `refund` as **Lua scripts**, each touching one key (or one hash-tagged key group), so each is one atomic server-side operation on a cluster; keys carry the namespace prefix and a TTL of `W` (or the bucket's refill horizon); the script uses Redis server time, so skew between tasks does not widen a window. **How multiple instances remain consistent:** every task calls the same script on the same key; `inFlight`, `failed` and tokens are one number for the whole fleet; no per-task state matters to correctness. Every store call runs under RP4's `bounded` deadline.

**Per-namespace failure semantics** (WHOLE-R3): `login-account`, `login-source` and `login-device` fail closed as below; **`anon-cap` and `csp-report` fall back to a per-task memory bucket** on store error or timeout (a short store deadline, `T_store`), logged `limiter_store_unavailable {ns}`, so a Redis outage never breaks FO's pre-sign-in pages (`/api/platform-theme`) or the report endpoint. **When the shared store is unavailable for login** (review RP3-R5). Two moments: (a) **at `reserve`**: fail closed: `503 {code:"login_protection_unavailable"}` with `Retry-After`, FO not called, `limiter_store_unavailable` at error; failing open would turn a store outage into an unthrottled credential-testing endpoint against FO's identity store. (b) **at `settle` or `refund`, after `foLogin` has answered**: the login outcome is **never changed**: a correct password still yields RP2 steps 2–6 and the cookie (refusing here would orphan the FO session FO just minted), a wrong password still yields the identical 401; the failure is logged `limiter_settle_failed {outcome}` at error and the reservation is left to expire with `W` (bounded harm, already accounted for). A **configured degraded mode** (`LOGIN_PROTECTION_FALLBACK=memory`) may switch to the per-task memory store after `N` consecutive store failures, logging the switch and reverting when the store answers; it trades N-fold allowance for availability and is a **CP5 decision**, default off. A store outage degrades login only; nothing else in the PWA depends on the store (RP10-B).

#### 7. Observability
One `login_attempt` event per request: `{outcome, decidedBy: allowed|account|source|store|ingress, accountKeyPrefix (8 hex), source, accountFailed, sourceTokens, retryAfterSeconds, requestId}`; `login_throttled` at warn when the account bucket refuses; `limiter_store_unavailable`, `limiter_settle_failed` at error; `limiter_store_full` at warn; `login_source_identity_unavailable` once at warn; `client_identity_untrusted` at warn (RP10-A `security` event). Never the email, password or any token.

#### 8. Parameters, with provisional defaults for the design review

| Parameter | Meaning | Provisional default | Decides |
|---|---|---|---|
| `F` | Failures per account before delay begins | 5 | Security (§9 question 53) |
| `W` | Account window (entry expiry after the last failure) | 15 min | Security |
| `D_0`, `D_max` | First delay; delay ceiling | 30 s; 5 min | Security |
| `C_src`, `R_src` | Source bucket capacity; refill per second | 60; 1/s | Load test L3 and the largest office behind one address |
| Device-trust cookie lifetime | Larger per-(device, account) budget `F_dev`, bound to the account for a known browser | 90 days, if adopted | §9 question 53 |
| Store capacity per namespace | Memory bound | 100,000 (memory store) | RP10-B L2 |
| `LOGIN_PROTECTION_FALLBACK` | Degraded mode when the shared store is down | off | CP5 |
| `LOGIN_PROTECTION_SECRET` | Keys the account HMAC and the device cookie | required, 32+ chars | RP10-B secrets row |

#### 9. Behavioural tests (route level, stub FO, `node:test`)
1. **Rotating sources cannot bypass the account bucket:** `F` failures at A from `F` different sources → the next attempt at A from a fresh source is refused; FO received exactly `F`.
2. **Success clears only its own account:** `F − 1` failures at A from S, a success at B from S → the next failure at A from S is A's `F`-th and A is throttled; B and S unaffected.
3. **Race:** 20 concurrent wrong guesses at A against a stub answering after 200 ms → the stub receives exactly `F`; the rest are 429 with `Retry-After`; a concurrent success at A during the burst makes the remaining `settle`s no-ops without error; a further wrong guess that reserves after the success and before the old settles land leaves the new entry at `failed = 1, inFlight = 0`.
4. **B3:** 40 failures across 40 accounts from S → a correct password at a 41st account from S succeeds.
5. **Source rate:** `C_src + 1` attempts across distinct accounts from S within one second → the last is 429 by `source`; after `1/R_src` seconds one more is allowed.
6. **Indeterminate:** stub 503, stub timeout, stub 500, stub HTML body → no account increment; the source token is refunded; the response is the RP5 code for the cause.
7. **Pre-password 403:** stub login 403 → account increments; no `/me` call; no cookie; the response equals the stub-401 response modulo `requestId`.
8. **Identity unconfigured:** no `TRUSTED_PROXY_HOPS`, no `fly-client-ip` → 200 failures across accounts never produce a source refusal; the warning is logged once; account throttling still works.
9. **Forgery:** `TRUSTED_PROXY_HOPS=1`, 20 requests with 20 forged leading XFF entries and one trailing real address → one source, capped as one.
10. **Store unavailable at reserve:** a fake store whose `reserve` rejects → 503 `login_protection_unavailable`, FO not called, `limiter_store_unavailable` logged; with the fallback enabled and `N` consecutive failures → the memory store takes over and the switch is logged. **At settle:** a store whose `reserve` succeeds and `settle` rejects → a correct password still yields 200 with the cookie; a wrong password still yields 401; `limiter_settle_failed` logged; no revoke sent to FO.
11. **Same-origin:** `Sec-Fetch-Site: cross-site` → 403 and a body stream that throws when read is never read by the route; `Origin: https://evil.example` → 403; `Origin: null` → 403; urlencoded → 415; neither header with JSON → proceeds.
12. **Keys:** two case spellings of one email share a bucket and the stub receives each exactly as typed; no key or log line contains the email or password.
13. **Namespaces:** filling `anon-cap` to capacity evicts nothing in `login-account`; `tokenBucketTake` on `anon-cap:<ip>` leaves `login-source:<ip>` unchanged. **13b Eviction direction:** with `login-account` at capacity and A at `F` failures, `capacity` new single-failure accounts do not evict A; with A at `F − 1` failures, `capacity` new accounts each raised to `F − 1` do not evict A either.
14. **Progressive delay:** with `F` failures, refused at `lastFailure + D_0 − 1 ms`, accepted at `lastFailure + D_0`; after `F + 1` failures the delay doubles; with `failed = F + 100` the delay equals `D_max`; at the lapse instant with one attempt in flight the second is refused with `Retry-After ≥ 1 s`; the entry, including an unsettled reservation, is gone at `max(lastFailure + W, last reservation deadline)`. (If hard lockout is chosen at §9 question 53, the lapse cases become "refused until `W`".)
15. **Shared store contract** (real Redis in CI when available, else skipped loudly): two processes reserving concurrently see one shared `inFlight`; `settle` from either process lands on the same entry.
16. **Compensation:** from a source at zero tokens, `F` attempts at A leave A's `inFlight` at 0 and A accepts a correct password from another source.
17. **Untrusted ingress:** `TRUSTED_PROXY_HOPS=2` with a one-entry XFF → 403 `untrusted_ingress` before any reservation; the same request through two hops → normal flow.
18. **Device trust** (if adopted): after a success from browser P at account A, `F` failures at A from elsewhere → a login from P with the correct password succeeds; the same from a browser without the cookie is refused; a cookie earned at account B exempts nothing at A (A is refused at its `F`-th failure from P like any other source); `F_dev` wrong guesses from P at A are refused at `F_dev + 1`, and those failures raise A's `failed` count as seen by another source.
19. **Reservation deadlines and the `finally`:** `F` reservations whose `settle` never runs → after `T_total_bounded` + margin the account admits again; a stub that makes the route throw after reserve → the reservation is settled indeterminate and the source token refunded.

#### Finding map

| Finding | Problem | Root cause | Fix | Components | Behavioural test |
|---|---|---|---|---|---|
| B2 (reset) | Any success clears the address bucket, so an attacker with one valid account resets the count | Success keyed by address; one bucket conflates victim and attacker | Success clears the authenticated account's bucket only (part 4 rule 2) | `limiter.ts`, `route.ts` | 2 |
| B2 (race) | Failures recorded after `await foLogin`; a burst passes the check | Check-then-act across an await | Reserve before `foLogin`, `inFlight` counts toward the limit, compensation order (part 4) | `limiter.ts`, `store.ts`, `route.ts` | 3, 16 |
| B3 | One shared address is locked for everyone after 8 failures | The only key is the source, and it is a lockout | Two dimensions: account (failures, progressive delay) and source (rate, never a lock) (part 4) | `limiter.ts`, `policy.ts` | 4, 5 |
| m1 (memory) | Per-process state; N instances give N allowances | A module-level Map | `CounterStore`; bounded memory store with the eviction rule; shared Redis store when CP5 chooses several instances; fail-closed at reserve, outcome-preserving at settle (part 6) | `store.ts`, RP10-B | 10, 13, 13b, 15 |
| m1 (forgery) | Off Fly the first XFF entry keys the bucket | A client-writable position trusted | Source key from RP1's `clientIdentity` only; the two `null` cases (part 3) | `route.ts`, RP1's `client-identity.ts` | 8, 9, 17 |
| m5 | Cross-site form posts and any content type accepted | No origin or media-type check | Same-origin gate and JSON-only before the route reads the body (part 5); the header-less case is allowed deliberately | `same-origin.ts`, `route.ts` | 11 |

**Acceptance criteria.** Tests 1–17 and 19 pass (18 if adopted); every parameter lives in `policy.ts`, is read from the environment and documented in `.env.example`; `rate-limit.test.ts` is gone; RP1's G31 test passes unchanged against the shared store after stage 9.

**Implementation stages.** 1 threat model (this section); 2 tests first; 3 store and limiter with reserve/settle and compensation; 4 account and source keying with the two `null` cases; 5 same-origin and JSON-only, RP2's logout wired to the helper; 6 events; 7 `SharedCounterStore` after CP5; 8 comments rewritten, `lib/rate-limit.ts` deleted; 9 RP1's anonymous cap moved onto the store under `anon-cap` with the same `null` rules; 10 the device-trust cookie if §9 question 53 adopts it.

**Dependencies.** RP1 (`clientIdentity`, `small-json`, the `proxy.ts` content-length pre-check, G31 cap in stage 9); RP2 (login steps 2–6; the logout helper); RP4 (`bounded` for `foLogin`, the probe, the revoke and every store call); RP5 (`invalid_credentials`, `login_rate_limited`, `login_protection_unavailable`, `cross_site_request`, `unsupported_media_type`, `untrusted_ingress`, `upstream_error`); RP10-A (events); RP10-B (shared store, `PUBLIC_ORIGIN`, `LOGIN_PROTECTION_SECRET`, identity source assertion, edge-only ingress to the ALB, admission cap on PWA routes).

**Open decisions.** §9 question 53 (account policy, values, device-trust exemption: C with a B default); `C_src`/`R_src` (B, confirmed by L3); alerting (E, CP5); password reset (C, question 46); FO's own login (D, question 45); the degraded fallback (E, CP5).

**Review record.** Independent review round 1 (27 September 2026, `general-purpose` subagent with the charter): 0 BLOCKING, 7 FIX NOW (R1 compensation order and settle no-ops and the `not_configured` step; R2 the two `null` cases and untrusted ingress; R3 test 8 contradicted RP1's hop rule; R4 window semantics and test 14; R5 settle-failure semantics; R6 eviction direction; R7 finding map and the premature "reviewed" status statements), 5 DEFER (R8 "body unread" wording and the PWA-route admission cap, owner RP10-B; R9 residual T3 and the device-trust option, owner §9 question 53; R10 the indeterminate-status mapping, owner RP5 part 3; R11 "bcrypt" is scrypt, record; R12 `k_login` coupling, owner RP10-B secrets row). All FIX NOW applied above; all DEFER items carried to their owners in this revision. Verdict was `NOT SAFE TO FREEZE`. **Round 2 (28 September 2026):** 1 BLOCKING (R13: the device-trust cookie as first worded was not bound to an account, so any account holder's cookie would have exempted guesses at every account, reopening B2 inside the option the RP recommended; corrected by binding the cookie to `accountKey` and making it a larger budget `F_dev`, never a bypass), 6 FIX NOW (R14 the admission predicate and `Retry-After` for every refusal; R15 per-reservation deadlines and the `finally`; R16 unique reservation ids and the ABA case; R17 the short-chain `null` requirement on RP1 and the `CLIENT_IDENTITY_SOURCE` knob, an RP1 delta; R18 the exemption as a bounded budget with counting; R19 the eviction tie-break), 0 DEFER. All applied on the reviewer's wording. **The two-round cap is reached; the remaining items are shown to the human in the revision 3.10 report.** Verdict at round 2 was `NOT SAFE TO FREEZE` on R13, now corrected.

---

### RP4 — FO request lifecycle: timeout, cancellation, upstream contract  *(Jothi #5)*

> **Status (revision 3.11).** Design-review depth. First independent review: 0 BLOCKING, 9 FIX NOW, 2 DEFER; all FIX NOW applied below; second round run and applied (two-round cap reached). Every budget is a parameter (`T_*`) set at CP3; no production milliseconds here. **Not frozen.**

**Purpose.** Every wait on FabOrchestrator has an owner, a start, a reset rule, an abort target and a defined outcome; every phase of a request, including the phone's upload into the PWA, has a lifetime the PWA itself configures; a timeout, a cancellation, an outage and a malformed answer are four different things on the wire and in the log; FO's JSON is validated at the boundary.

**Included findings.** B4, G1, G21, G22, M5; M4 and M7 close by RP8 retirement.

**Current architecture** ([code]; [Next-src]; [FO-clone]). `fetchFo` (`client.ts:535-548`) has no signal (10 callers; only `foChat` passes one); body reads are unguarded; the gateway `fetch` (`route.ts:169`) has only `req.signal`; sign-out awaits FO before clearing (`logout/route.ts:42`); `readFoStream` warns at 45 s and never cancels; `maxDuration = 300` is unread under `next start`. Verified in Next 16.1.4 source by the reviewer: **`after()` is available under `next start`** (an internal `waitUntil` awaited at server close), and **`req.signal` aborts on a premature client close** and not after a normal finish; Next's own pipe controller also cancels an upstream body being piped when the client disconnects, independently of `req.signal`. Node 24 defaults: `server.requestTimeout` 300 s, `headersTimeout` 60 s, `keepAliveTimeout` 5 s; `next start` sets only `keepAliveTimeout` from `KEEP_ALIVE_TIMEOUT`. Undici 7.29 defaults: connect timeout 10 s, `headersTimeout` and `bodyTimeout` 300 s idle (documented, INFERRED). FO: keep-alives every 15 s (data) and 20 s (comment); **FO's chat route deliberately consumes the stream to completion when the client disconnects** (`consumeStream()`, "ensure backend completes even if client disconnects") and never reads `req.signal` (§9 question 47); FO's `maxDuration = 300` is likewise unenforced under `next start`, so **nothing the PWA can rely on caps an FO turn at 300 s**.

#### 1. Components

| Component | Responsibility |
|---|---|
| `lib/faborch/stream-slots.ts` (**new**; WHOLE-R5) | The per-task concurrent-stream cap `N_streams`: a slot is acquired after the auth bridge and RP6's ownership proof, just before the upstream fetch, on `stream`-class rows only; refused with `503 busy` + `Retry-After`; released in the lifecycle's single terminal callback, where its timers are cleared, for every termination (complete, idle, lifetime, errored, cancel through Next's pipe controller, shutdown); a leak test per termination reason; feeds `gauges.activeStreams` |
| `lib/faborch/shutdown.ts` (**new**) | A registry of open lifecycles and the application `SIGTERM` listener (RP10-B draining) that aborts each with reason `shutdown` at `stopTimeout − margin` |
| `lib/faborch/deadline.ts` (**new**) | `startLifecycle(cls, callerSignal?)` → `{signal, onHeaders(), onChunk(), onDone(), reason()}`: owns every timer for one upstream call; combines the caller's signal (when one is given) with its own by `AbortSignal.any`; classifies the abort reason as `cancelled`, `connect`, `headers`, `body`, `idle`, `lifetime` or `shutdown`; clears every timer on `onDone` or abort (leak-tested) |
| `lib/faborch/call-classes.ts` (**new**) | RP1's four class names, `bounded`, `stream`, `upload`, `document` (static assets use `document`, as RP1's table says; there is no `static` class), plus the `revoke` budget; values `T_*` from the environment with CP3 defaults; startup assertions in part 5 |
| `client.ts` `fetchFo(path, init, cls, ctx)` | Requires a class and RP10-A's request context (`ctx`, for the id on every event and the forwarded `x-request-id`); adds `x-forwarded-for` and `user-agent` from RP1's `clientIdentity` on user-initiated calls (G13); reads JSON under the same lifecycle; validates with Zod (M5); an explicit undici `Agent` dispatcher carries the connect timeout so the `connect` class is a real rejection class, not a phantom timer |
| Gateway `route.ts` | Class from the registry row's `timeout` column; for every **piped** body (stream, document, gateway `bounded` rows whose JSON is piped, upload responses) the body goes through one `idleWatch(lifecycle)` transform that calls `onChunk` per upstream chunk and **errors** the downstream stream on `idle`, `lifetime` or upstream error |
| `session.ts` `endServerSession` (RP2) and the two in-flow revokes | Four revoke sites under one `revoke` class (part 3) |
| RP3's login route | `foLogin` under `bounded` (timeout → `indeterminate`, source token refunded); RP2's `/me` probe under `bounded`; the probe-403 or probe-401 revoke and the re-login revoke of a replaced token under `revoke`, pre-response |
| Node's HTTP server (via `next start` environment) | The inbound phase: `server.requestTimeout`, `headersTimeout`, `keepAliveTimeout` set explicitly from `T_inbound_*` and `KEEP_ALIVE_TIMEOUT` (part 2, last row) |
| RP5 `respond` | Maps `reason()` to a code and status (part 3) |

#### 2. The lifecycle classes

Owner, start, reset, abort target, cancellation propagation, what happens if FO ignores the abort, RP5 result, and behaviour after the response has started.

| Class / phase | Owner | Starts | Reset by | Aborts | Cancellation | FO ignores abort | RP5 result | After the response started |
|---|---|---|---|---|---|---|---|---|
| **connect** (a rejection class, not a PWA timer; review RP4-R1) | undici's connect timeout via the explicit dispatcher (`T_connect`) | `fetch` called | — | the upstream `fetch` rejects (`UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, TLS errors) | caller's abort also aborts it | nothing started | 503 `faborch_unavailable`, reason `connect` | n/a |
| **response headers** (`T_headers_<cls>`) | `deadline.ts` | `fetch` called | headers arriving (`onHeaders`) | upstream `fetch` | caller's abort | FO may have started a turn nobody reads (§9 question 47) | 504 `upstream_timeout`, reason `headers` | n/a |
| **bounded total, read by the PWA** (`T_total_bounded`; login, `/me` probe, ownership lookup (its outcome per RP6 part 3), revoke's own read) | `deadline.ts` | `fetch` called | never: one budget for headers **and** the `res.json()` read | upstream `fetch` and the body read | caller's abort aborts both (except revokes: part 3) | FO completes the JSON nobody reads | 504 `upstream_timeout`, reason `body`; RP3 `indeterminate` | n/a (the route answers only after the read) |
| **piped bodies** (`document`, gateway `bounded` rows, `upload` responses; review RP4-R2) | `deadline.ts` headers timer, then `idleWatch` | `fetch` called; idle timer from `onHeaders` | headers by arrival; then **every upstream chunk** resets `T_idle_<cls>`; an optional generous `T_life_<cls>` | upstream `fetch` and the pipe | the phone's disconnect aborts the pipe (Next's pipe controller) and, through `req.signal`, the upstream fetch | FO finishes a download nobody reads | 504 before headers; after headers the downstream stream is **errored** (reason `idle`/`lifetime`), never closed cleanly, and logged | the errored pipe is the after-start case; a slow phone never triggers it, because idle measures **upstream** silence, not download speed |
| **upload request** (`T_total_upload`) | `deadline.ts` | after RP1 has buffered and measured the body | never | upstream `fetch`; response body handled as a piped body | caller's abort | FO may hold a partial store of a complete body: FO's concern; the PWA never sent a partial body (RP1) | 504 `upstream_timeout` | as piped bodies |
| **stream headers** (`T_headers_stream`) | `deadline.ts` | `fetch` called | headers | upstream `fetch` | caller's abort | FO starts a turn nobody reads | 504 `upstream_timeout` | n/a |
| **stream idle** (`T_idle_stream`; review RP4-R3) | gateway `idleWatch` + `deadline.ts` | **at `onHeaders`**, not at the first byte, so a silent-after-headers stream ends at `T_idle_stream`, not at the lifetime | every upstream chunk, keep-alive comments included | upstream `fetch`; then the downstream stream is **errored** (`controller.error(new UpstreamTimeout("idle"))`, which Next turns into a destroyed connection; review RP4-R4) | the phone's disconnect aborts upstream and the pipe; `req.signal` clears the timers | FO keeps generating (§9 question 47) | none on the wire (the 200 is gone); logged `stream_end {reason:"idle"}`; RP5 part 6 decides whether an in-band frame precedes the error (recommended: no) | this is the after-start case |
| **stream lifetime** (`T_life_stream`) | same | headers | never | as idle | as idle | as idle | as idle, `reason:"lifetime"` | this is the after-start case |
| **client cancellation** (`req.signal`, and Next's pipe controller for a body being piped; review RP4-R9) | Next | the phone disconnects before the response finishes | — | pre-response: the upstream `fetch` and any bounded read through `AbortSignal.any`; mid-pipe: the upstream body through the pipe controller, and the lifecycle's timers through `req.signal` | this **is** the propagation | FO keeps working (§9 question 47) | nothing sent; logged at info `cancelled` with `msSinceLastUpstreamByte` and `msSinceLastDownstreamWrite` (review RP4-R11) so an edge-caused close is distinguishable after the fact | downstream already gone; upstream aborted; timers cleared |
| **revoke** (`T_revoke`; review RP4-R5) | `deadline.ts`, **caller signal never combined** | four sites, part 3 | never | the `foLogout` fetch and its read | none: a revoke has no user waiting and must complete even if the phone left | FO's session row stays until its own expiry | never surfaced; `session_end {reason, revoked}` | the post-response sites run after the response by design (RP2) |
| **shutdown** (`SIGTERM` during a deploy, scale-in or rollback; reviews RP10B-R8, R18, RP4-R16; owner: **the application `SIGTERM` listener**, which calls every open lifecycle's abort with reason `shutdown` at `stopTimeout − margin`, so `idleWatch` errors the stream and `stream_end {reason:"shutdown"}` is logged; a `SIGKILL` cut is a defect the rehearsal records; RP10-B's SIGTERM test covers it; earlier wording follows for the record) | Next's graceful close, bounded by the platform's stop timeout | the task is told to stop | — | streams still open at the stop timeout are cut by the platform | — | FO keeps generating | none on the wire; logged `stream_end {reason:"shutdown"}` for each stream the process could not finish | the after-start case; RP10-B's draining row sets the stop timeout |
| **inbound receive** (phone → PWA; review RP4-R8) | Node's HTTP server: `server.requestTimeout` (`T_inbound_total`), `headersTimeout` (`T_inbound_headers`), `keepAliveTimeout` (`KEEP_ALIVE_TIMEOUT`) set explicitly at startup | connection accepted | — | Node closes the connection | — | n/a | Node's bare 408 (or a reset), which the PWA cannot code: documented in RP5's table as a non-envelope status; `T_inbound_total` sized for the largest permitted upload on the slowest supported link (CP3, CP5) | n/a |

#### 3. The four revoke sites (one class)

| Site | When | Caller signal | Outcome |
|---|---|---|---|
| (i) logout, `endServerSession(req, res, "user")` | post-response, `after()` | never combined | `session_end {reason:"user", revoked}` |
| (ii) gateway refusal of an expired or mismatched bearer (G5) | post-response, `after()` | never combined | `session_end {reason:"gateway_refusal", revoked}` |
| (iii) re-login with a different FO cookie (RP2 step 3) | **pre-response**, inside the login flow, before the new login is minted | never combined: a phone leaving mid-login must not orphan the replaced token | `session_end {reason:"replaced", revoked}`; the login proceeds whether or not the revoke succeeded |
| (v) **abandoned login** (WHOLE-R4): after a successful `foLogin`, the caller's signal aborted before the response was written (the phone left, or the edge timed out) | **post-abort**, never combined | never combined | `session_end {reason:"abandoned", revoked}`; test: abort the client while the stub holds `/me`, the stub then receives a logout for the minted token |
| (iv) probe-403 or probe-401 revoke of the just-issued token (RP2 step 2b and its probe-401 rule) | **pre-response** | never combined | `session_end {reason:"probe_inactive" \| "probe_unexpected", revoked}`; the coded failure is returned with no cookie (403 → the login failure; 401 → 502 `upstream_error`); a hanging-stub test covers each branch |

`T_revoke < stopTimeout − margin` (RP10-B's named input `STOP_TIMEOUT_MS`), or in-flight post-response revokes die with the task; the startup assertion checks it.

#### 4. Failure behaviour and the RP5 mapping
Connection-class rejection → 503 `faborch_unavailable`; headers or bounded total timeout → 504 `upstream_timeout`; malformed JSON or unexpected content type on a bounded call → 502 `upstream_invalid`; FO's own error status on a PWA-originated call → 502 `upstream_error` (RP5 part 3; FO's status in the log, never in the body; FO's 429 → 503 `faborch_unavailable` with FO's `Retry-After` passed through); FO's own status on a pass-through row → RP5's pass-through rule; caller cancellation → no response, info log; piped-body idle or lifetime after headers → the downstream stream is errored and the event logged. No automatic retry; a circuit breaker only if L1/L4 measurements justify one (CP3).

#### 5. Trust boundary, assertions and the edge dependency
The lifecycle changes no byte of the request body or of FO's response; the only headers RP4 adds are `x-forwarded-for`, `user-agent` and `x-request-id`, taken solely from RP1's `clientIdentity` and RP10-A (review RP4-R7). Timers are cleared on every exit. **Startup assertions** (`call-classes.ts`): `T_idle_stream > the keep-alive gap recorded at CP3`; every `T_*` that bounds a wait on FO, except `T_life_*`, `< E − margin` (the inbound values are Node's recorded defaults, not parameters, and are excluded: their edge outcome is RP10-B L2's measurement), where `E = min(CloudFront origin response timeout, ALB idle timeout)` recorded at CP5 (review RP10B-R7); `KEEP_ALIVE_TIMEOUT > ALB idle timeout`; `T_revoke < stop grace`; undici's own `headersTimeout`/`bodyTimeout` set explicitly on the dispatcher at or above the largest `T_*` so undici never fires first with an unclassified error. **Node's inbound timeouts are defaults, not settable, under the standalone server** (`headersTimeout` 60 s, `requestTimeout` 300 s; only `keepAliveTimeout` is configurable), so `T_inbound_headers = 60 s` and `T_inbound_total = 300 s` are known values unless a custom server is adopted, and RP10-B's L2 adds a throttled 20 MiB upload to record the phone-side outcome (Node 408 versus ALB idle) (review RP10B-R25). **`T_life_stream` is not derived from FO's `maxDuration`** (unenforced under `next start`, review RP4-R6): it is the p99 streamed-turn duration measured in stage 1 plus headroom, and §9 question 56 asks FO owners what, if anything, caps a turn in production.

#### 6. Finding map

| Finding | Problem | Root cause | Fix | Components | Behavioural test |
|---|---|---|---|---|---|
| B4 | No deadline on `fetchFo` | No signal | Mandatory class (a required parameter; the type check is the guard); lifecycle timers; explicit dispatcher | `deadline.ts`, `client.ts`, callers | Stub never answers → 504 within `T_total_bounded`; stub connect refused → 503 `connect` |
| G1 | Gateway has no deadline | Same | Class from the row; `idleWatch` on every piped body; idle from headers | `route.ts` | Headers then silence → errored at `T_idle_stream` (not at lifetime); a stream with a byte every `T_idle_stream/2` for five windows completes; a document with a slow **downstream** reader but steady upstream chunks completes |
| G21 | Sign-out hangs | `await foLogout` first | RP2's order; the `revoke` class, four sites, caller signal never combined | `session.ts`, login route | Hanging stub on each of the four sites → the user-visible response is unaffected; `revoked:false` logged; a client disconnect during site (iii) does not cancel the revoke |
| G22 | No lifetime cap | `maxDuration` unenforced | `T_life_stream`, `T_total_*`, measured not inherited; inbound phase bounded by Node's configured timeouts | `deadline.ts`, `route.ts`, startup env | A trickling stream is errored at `T_life_stream`; a stalled inbound upload is closed at `T_inbound_total` |
| M5 | Casts | No schemas | Zod on login, logout, `/me`, per-id ownership (the ownership lookup's failures map per RP6 part 3 to 503 `ownership_unavailable`, not to this RP's generic 502/504; RP4 owns its budget and abort semantics only) | `client.ts`, `lib/faborch/schemas.ts` | Renamed field → 502 `upstream_invalid` |
| M4, M7 | Native route | Retires | RP8 | — | Retirement test |

#### 7. Parameters (CP3 values; CP5 edge values)
`T_connect` (dispatcher), `T_headers_bounded`, `T_total_bounded`, `T_total_upload`, `T_headers_document`, `T_idle_document`, `T_headers_stream`, `T_idle_stream`, `T_life_stream`, `T_revoke`, `T_headers_upload` (upload headers; `T_total_upload` ends at headers, the response is then a piped body), `T_idle_bounded`, `T_idle_upload`, `T_life_document`, `T_life_bounded`, `T_life_upload` (generous lifetimes for piped bodies), `KEEP_ALIVE_TIMEOUT`, `E` (recorded edge minimum), `STOP_TIMEOUT_MS` (RP10-B). **`T_inbound_headers` and `T_inbound_total` are parameters set by RP10-B's Node entry** (revision 3.12; before it they were Node's non-settable defaults, 60 s and 300 s, review RP4-R13); they bound the phone's upload, not a wait on FO, so they are excluded from the `E` assertion and their edge outcome is L2's measurement. **Ordering and sums (reviews RP4-R14, R15), asserted at startup:** `T_connect < min(T_headers_*, T_total_bounded, T_total_upload, T_revoke)` so an outage is never reported as a timeout; login `3·T_store + 2·T_total_bounded + T_revoke < E − margin` (the three store calls have their own small class `T_store`, WHOLE-R4) (foLogin, the `/me` probe, a pre-response revoke); chat `T_total_bounded + T_headers_stream < E − margin` (RP6's lookup then the stream headers). `undici` becomes a pinned dependency on the same major as Node's bundled copy, for the explicit dispatcher (no product precedent; recorded under CLAUDE.md's reuse rule), with a test that a request through Next's patched fetch uses the dispatcher's connect timeout. Stage 1 extends the latency scripts to many runs and p95/p99 and records FO's observed keep-alive gap and the p99 turn duration. Provisional shapes for the review only: `T_idle_stream` at least three keep-alive gaps; `T_revoke` short (RP2 proposed 3 s); `T_life_stream` = p99 turn + headroom; `T_headers_document` a few seconds, with RP9's `T_nav` strictly larger (`T_nav = T_headers_document + T_connect + M`, review RP9-R4).

**Tests.** Every row of the class table as a stub scenario with injectable clocks; the five-window keep-alive stream; headers-then-silence; the trickle; the slow-downstream document; the four revoke sites against a hanging stub (site (iv) in both its 403 and 401 branches), including a client disconnect during site (iii); a black-holed FO (a stub that accepts TCP and never completes TLS) → 503 `connect` at `T_connect`, before any headers timer; every login step hanging just under its budget → the coded response arrives before `E`; a bounded-row file download stalls → errored at `T_idle_bounded`; the caller abort with no error log and `msSinceLastUpstreamByte` present; login against a hanging stub → 504 and no limiter increment; the **three-phase disconnect test** on the real server (review RP4-R9): (1) disconnect while the stub holds the ownership `GET` → the stub sees the abort and no `/api/chat` arrives; (2) disconnect while the stub holds the chat headers → upstream abort; (3) disconnect mid-stream → upstream abort and no timer outstanding; a 65-second streamed turn completes; the startup assertions refuse each violated relation; the errored-stream test asserts the client-side body read **rejects** rather than ends.

**Acceptance criteria.** No FO call path lacks a class; every class row has a passing test; budgets documented with source; timeouts logged with class, reason and elapsed time; the live check on preview records the keep-alive gap and the p99 turn beside `T_idle_stream` and `T_life_stream`.

**Dependencies.** RP1 (row `timeout` column; buffered bodies); RP2 (the four revoke sites); RP3 (indeterminate); RP5 (codes; the after-start rule; the non-envelope 408); RP6 (per-id lookup under `bounded`); RP9 (`T_nav` strictly above `T_headers_document`); RP10-A (events; the real-server harness); RP10-B (`E`, stop grace, `KEEP_ALIVE_TIMEOUT`, draining).

**Open decisions.** CP3: the `T_*` values; in-band frame or errored close (with RP5; recommended errored close only); circuit breaker (none until measured). FO owners: §9 question 47 (abort behaviour) and 56 (what caps a turn). Deployment: §9 question 48 (edge timeouts).

**Review record.** Round 1 (27 September 2026): 0 BLOCKING, 9 FIX NOW (R1 connect is a rejection class; R2 piped bodies need idle-not-total and RP1's class names; R3 idle timer starts at headers; R4 error, never close, the downstream stream; R5 four revoke sites, caller signal never combined; R6 lifetime not derived from `maxDuration`; R7 trust-boundary sentence; R8 the inbound phase; R9 the three-phase disconnect test), 2 DEFER (R10 RP2's G5 finding-map cell still reads revoke-then-clear: queued for the RP1/RP2 delta batch; R11 `msSinceLastUpstreamByte`, owner RP10-A, applied). All FIX NOW applied above. Verdict was `NOT SAFE TO FREEZE`. **Round 2 (28 September 2026, rerun after a session limit):** 0 BLOCKING, 7 FIX NOW (R12 site (iv) covers the probe-401 revoke with its own reason; R13 Node's inbound timeouts are recorded defaults, excluded from the `E` assertion; R14 the connect ordering assertion, a black-hole test, `undici` pinned; R15 per-route sum assertions for login and chat; R16 the shutdown owner is the application `SIGTERM` listener, `T_revoke < stopTimeout − margin`; R17 named piped-body parameters; R18 the seam row and RP2's G5 wording), 1 DEFER (R19 Next's E180 after an errored stream, owner RP10-A, applied). All applied; the RP6 round-2 carve-out for the ownership lookup's outcome is also applied here. **Two-round cap reached; shown to the human.**

---
### RP5 — Error contracts and error presentation  *(Jothi #4)*

> **Status (revision 3.11).** Design-review depth. First independent review: 1 BLOCKING, 7 FIX NOW, 1 DEFER; the BLOCKING finding is a human decision recorded as §9 question 57 with an interim rule; all FIX NOW applied below; second round run and applied (two-round cap reached). Wording is CP3's. **Not frozen.**

**Purpose.** Every failure the PWA originates has one body shape, one status table and one presentation rule per request kind, before and after a stream has started; FO's own failures pass through unchanged in status and body bytes; nothing internal leaves the server; the user is told the right next step.

**Included findings.** M2, M6 (retires), m4, m11, G8, G23.

**Current architecture** ([code]; [FO-clone]). `lib/faborch/errors.ts`: a code union, `NEXT_STEP`, `RETRYABLE`, `NEEDS_SIGN_IN`, `codeForStatus`, `statusForCode` (default 502). The gateway returns bare `{error}` for its 401, 413 (two sites), 502 and 503 (`route.ts:90, 98, 141, 159, 172`) and a **null-body 404**; `proxy.ts` rewrites every not-found, API paths included, to Next's **HTML** not-found page (`:262-272`); `auth-middleware.ts` answers 401 uncoded; the login route turns every `FabOrchRequestError` into 503 and relays the FO address, including an invalid configured value (`client.ts:119-137, 543-545`). Shell injection runs on every HTML response whatever its status (`route.ts:186-188`, `html-inject.ts:101-112`). No error boundaries. **How FO's embedded client renders a non-OK response, verified in the clone:** the `fetch` wrapper reads no body, only `status === 401` with a bearer (`providers.tsx:92-119`); the chat transport (`ai@6.0.97`, `HttpChatTransport`) throws `new Error(await response.text())` and FO's chat renders `error.message` inline (`full-chat-app.tsx:1038, :1744`), so a JSON body appears **as raw JSON text in the conversation**; settings, files, artifacts and the modeling chat read `data.error` as a string and would show the sentence; the CMF loader and execution hooks read `data.error?.title/description` and would show `HTTP <status>`. A stream that **ends cleanly** without a finish part is rendered as a completed answer (`status: "ready"`); only an **errored** stream produces FO's error state and its "disconnected" handling.

#### 1. Two kinds of error, one rule each
- **PWA-originated**: normalised into the canonical body (part 2) and presented by request kind (part 3b). Producers: RP1 (method, body, path, and the G31 anonymous refusal), RP2 (session), RP3 (login), RP4 (lifecycle), RP6 (ownership), RP7 (CSP report endpoint), RP10-B (`busy`), the PWA's own routes.
- **FO-originated**: FO's **status is preserved**; FO's **body bytes are preserved for every non-document response**; **document bodies receive the PWA's shell injection whatever the status** (an FO 404 or 500 page still gets the manifest and the worker registration, deliberately: the page a user sees when FO is unwell must still be installable and recoverable); **response headers are the PWA's** (RP7's allow-list and additions, RP2's cookie clearing on an injected 401). The only FO error the gateway acts on is a 401 on an injected request (RP2 clears the cookie; the body still passes through). (Review RP5-R6.)

#### 2. The canonical body
```json
{ "code": "upstream_timeout", "error": "FabOrchestrator did not answer in time.", "requestId": "…", "errorId": "…", "details": { "limit": 20971520 } }
```
`code` (stable, machine-read); `error` (the safe sentence from CP3's wording table, never built from an upstream body or address; kept under this name because the FO consumers that do read a field read `error`); `requestId` (RP10-A, always present, also the `x-request-id` header); `errorId` (only when FO supplied one or the PWA logged an exception with its own id); `details` (optional object, currently `{limit}` on `body_too_large`; review RP5-R4). **Internal log detail, never in the body**: upstream status, the first 200 bytes of the upstream body, the FO address, the stack, the abort reason, the limiter dimension.

#### 3. Status table (one source, `lib/errors/contract.ts`)

| Status | Meaning | Codes | Produced by |
|---|---|---|---|
| **400** | The PWA refused the request as malformed | `invalid_request` (schema failures; RP6's non-UUID `conversationId`) | PWA routes, RP6 |
| **401** | Authentication: who you are could not be established or has lapsed | `session_invalid` (bearer missing, malformed, mis-signed, expired, wrong `aud`/`kid`, cookie missing or mismatched: one code, one message); `invalid_credentials` (login: wrong password **or** FO's pre-password 403, byte-identical modulo `requestId`); `faborch_session_expired` (emitted **only** when the PWA learns of an FO 401 on a call the client did not itself make and after a session existed: RP6's ownership lookup, and any later PWA-made call with an injected token; a client's own FO call that FO answers 401 passes through as FO's 401) | RP1 (G31: a bearer-less `required` row and a bad bearer answer `session_invalid`), RP2, RP3, RP6 |
| **403** | The request was understood and refused for who or where it comes from | `cross_site_request` (RP3 gate, before identity exists), `untrusted_ingress` (RP3 part 3b), `conversation_forbidden` (RP6: not the caller's, or gone), `account_inactive_post_password` (RP2 step 2b), `password_change_required` (RP2's forced-change state when FO does not clear the flag) | RP3, RP6, RP2 |
| **404** | Unknown path or object on the PWA side | `not_found` | `proxy.ts`, gateway `unknown`/`denied` |
| **405** | Method not in the registry row | `method_not_allowed` | RP1 |
| **413** | Body over the policy | `body_too_large` with `details.limit`; the ownership check's inspectability refusal maps here with RP1's limit | RP1, RP6, RP7 (CSP report body) |
| **415** | Content type not accepted | `unsupported_media_type` | RP3, RP7 |
| **429** | Wait; `Retry-After` always present on PWA-originated 429s (FO's pass through with FO's own header once RP7 G24 allows it) | `login_rate_limited`, `anonymous_rate_limited`, `csp_report_rate_limited` | RP3, RP1, RP7 |
| **502** | The upstream answered unusably, or answered a PWA-originated call with a status that call's contract does not define | `upstream_invalid` (malformed JSON, unexpected content type, schema failure); `upstream_error` (FO answered 400, 5xx, or any status the PWA-originated call's contract does not define, to a call the PWA itself made; FO's status in the log only). **The login-time `/me` probe answered 401** (a status RP2 step 2 does not enumerate) is this case: `502 upstream_error`, no cookie, the just-minted token revoked pre-response under RP4's `revoke` class exactly as site (iv) does (review RP5-R11; RP2 step 2 names it, delta) | RP4, RP3, RP6, RP2 |
| **503** | The upstream is unreachable, or the PWA cannot serve this now | `faborch_unavailable` (connection-class failure; also FO's 429 to a PWA-originated call, with FO's `Retry-After` passed through), `not_configured`, `login_protection_unavailable`, `ownership_unavailable`, `busy` (RP10-B caps; `Retry-After` always) | RP4, RP3, RP6, RP10-B |
| **504** | The upstream did not answer in time | `upstream_timeout` | RP4 |
| **408 / reset** (non-envelope) | Node closed a slow inbound request | none: produced by the HTTP server before any route (RP4 inbound phase); documented so it is not mistaken for a gateway defect | Node |
| *(none)* | Client cancellation | no response written; logged at info | RP4 |
| *(no HTTP row)* | A PWA page's render exception | `client_render_error` (the boundary's code, part 7) | boundaries |

Rules: the login route's classification is RP3 step 9 **as mapped by this table** (FO's 429 → 503 `faborch_unavailable` with FO's `Retry-After`; FO's 400 and 5xx → 502 `upstream_error`), so the table remains the only oracle (review RP5-R13). **401**: the status and body never say which check failed; the presence of the cookie-clearing `Set-Cookie` on the verified-but-expired-or-mismatched branch (RP2 G5) is an accepted, documented difference, because whoever can observe it already holds a correctly signed bearer (review RP5-R7). **403** means understood and refused for origin or identity; `cross_site_request` is the origin case. 502, 503 and 504 are never interchangeable; the table is the oracle for the injection test.

#### 3b. Presentation by request kind (review RP5-R3)
- **API rows and PWA API routes**: the JSON envelope.
- **Document requests** (`fo-document` or `fo-static` owner, or a navigation with `Accept: text/html` to a PWA path): the PWA's **HTML error pages** with the **same status** and the same `code`, sentence and `requestId` rendered, with links to `/offline` and `/diagnostics`: `app/not-found.tsx` for 404 (and `proxy.ts`'s not-found rewrite becomes conditional: API kind → JSON 404, document kind → the HTML page), and a gateway error page for 405, 502, 503 and 504 on documents. A phone must never see raw JSON in a standalone window.
- **The PWA's own React pages**: the boundaries of part 7 (they cover PWA documents only; FO's documents are bytes the PWA serves, and FO has its own boundary).

#### 4. Distinguishing the nine cases the brief names
Invalid client request → 400; authentication failure → 401; authorisation failure → 403; rate limiting → 429; request too large → 413; upstream unreachable → 503; upstream timeout → 504; malformed upstream response → 502 `upstream_invalid`; FO-generated application error → pass-through (status and body bytes; on a PWA-originated call, 502 `upstream_error`).

#### 5. What FO's embedded client actually renders (review RP5-R1, BLOCKING; human decision §9 question 57)
Verified per consumer in the clone, production REQUIRES CONFIRMATION:

| FO consumer | What a PWA envelope renders as |
|---|---|
| The chat transport (`useChat`, `HttpChatTransport`) on `POST /api/chat` and the modeling chat | **The raw response text**: the JSON envelope appears verbatim in the conversation |
| The `fetch` wrapper | Only `401 + bearer` is acted on (session expired); bodies are never read |
| Settings, file cards, file content, artifact preview, the modeling chat's non-stream calls | `data.error` as a string: the sentence renders |
| CMF loader wizard, execution-run hooks | `data.error.title/description`: a string `error` yields `HTTP <status>` |
| FO's error boundary helper (`lib/errors/client.ts`) | Requires FO's nested envelope; otherwise a status-keyed default sentence |

Consequence: every PWA-originated refusal of a **chat turn** (400 `invalid_request` on a malformed `conversationId`, 413, 429, 403 `conversation_forbidden`, 503 `ownership_unavailable` or `busy`, 504 on stream headers, 502) would reach the phone as raw JSON in the conversation. This is a **human decision (§9 question 57)** with three options: **(a)** accept raw JSON in FO's chat for PWA-originated refusals (record as a known limit); **(b)** ask FO owners to make the chat's error rendering parse a JSON body and show `error` (a few lines in FO; §9 question 25 becomes **required**, not optional); **(c)** for the two chat rows only, answer pre-start refusals as a 200 UI-message stream carrying FO's own `{"type":"error","errorText":…}` part so `useChat` renders it, at the cost of the true status code and of the PWA composing FO-protocol bytes, which part 6 otherwise refuses. **Recommendation: (b), with (a) recorded as the interim.** Until it is decided, the acceptance criterion "renders correctly inside FO's pages" is **withdrawn**; the criterion is "renders correctly on every FO consumer that reads `error` as a string, and the chat case is decided at §9 question 57".

#### 5b. Code → screen → action for the PWA's own consumers (review RP5-R5; replaces `RETRYABLE` and `NEEDS_SIGN_IN`)

| Code | Consumer | Action offered | Retryable |
|---|---|---|---|
| `invalid_credentials` | login page | correct and retry | yes |
| `login_rate_limited`, `busy`, `login_protection_unavailable`, `faborch_unavailable`, `upstream_timeout`, `upstream_error` (including the probe-401 case), `upstream_invalid` | login page | wait `Retry-After` (when present) and retry | yes |
| `cross_site_request`, `unsupported_media_type`, `untrusted_ingress`, `not_configured`, `invalid_request` | login page (should not occur from the PWA's own form) | show the sentence; contact administrator with `requestId` | no |
| `account_inactive_post_password`, `password_change_required` | login page | contact administrator; for `password_change_required`, FO's change page if reachable | no |
| `session_invalid`, `faborch_session_expired` | PWA screens: `use-session.ts` → `endClientSession` → `/login` (never Retry). FO pages: FO's global fetch wrapper acts on any `401` that carried a bearer (it reads no code) → FO clears its storage → `fo-shell.js`'s storage watcher → `endClientSession`; a 401 without a bearer on FO's pages is not acted on by FO's client (G31's two `optional` rows are anonymous by design, so nothing is lost) | no |
| `not_found`, `method_not_allowed`, 502/503/504 on a document | HTML error page | retry; `/offline`; `/diagnostics`; `requestId` shown | as coded |
| `client_render_error` | boundary | reset; `/diagnostics` | yes |

#### 6. After a stream has started (review RP5-R2)
The 200 and the SSE headers have been sent; the status cannot change. Rule: on `idle`, `lifetime`, `upstream_error` or `shutdown`, the gateway **errors** the downstream stream (`controller.error(...)`, which Next turns into a destroyed connection with no terminating chunk) and logs `stream_end {reason, requestId}`; it **never closes cleanly**, because FO's client renders a clean close without a finish part as a completed answer. It does not write into FO's stream: an in-band frame would be the PWA composing bytes inside FO's protocol; FO's client renders an errored stream with its own message. **[open, CP3 with RP4]**: an explicit in-band error frame in FO's own shape before the error; recommendation: errored close only. **Edge behaviour to confirm (§9 question 48)**: that an origin-side abort mid-body reaches the phone as an abort through CloudFront and the ALB, not as a clean truncation; if it does not, the in-band frame becomes the only reliable signal and this rule flips.

#### 7. Error boundaries (m11)
`app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`: the canonical sentence for `client_render_error` or `not_found`, the `requestId` when known, reset, links to `/offline` and `/diagnostics`; never the exception text. They cover the PWA's own documents only.

#### 8. Finding map

| Finding | Problem | Root cause | Fix | Components | Behavioural test |
|---|---|---|---|---|---|
| G8 | Gateway errors uncoded; null 404; HTML 404 for APIs | Bare `{error}`; one not-found path for every kind | `respond(code)` for API kinds; HTML error pages for document kinds with the same status | `route.ts`, `proxy.ts`, `contract.ts`, `app/not-found.tsx`, the gateway error page | Every PWA-originated gateway failure carries `code`, `requestId` and a table status; an API 404 is JSON; a document 404/503/504 is the HTML page with that status |
| G23 | 502/503 disagreement; login folds all into 503; suspended account | Three mappings | One table; RP3's classification; `upstream_error` for FO's own error status on PWA calls; pre-password 403 collapsed | `contract.ts`, login route, `client.ts`, `route.ts` | Inject each upstream status, a network failure, a timeout, malformed JSON and an HTML body into the gateway and every surviving route; assert the table; login 403 and 401 responses are identical modulo `requestId` (compared with a fixed id from the harness) |
| M2 | 401 shown as "temporary" | Uncoded 401 | `session_invalid`; part 5b sends to sign-in | `auth-middleware.ts`, `presentation.ts` | `session_invalid` renders sign-in, not Retry |
| m4 | FO address leaks | Message built from the URL, including an invalid configured value | Server-only detail; `not_configured` message fixed | `client.ts`, `route.ts` | No response body contains the `FABORCH_BASE_URL` value verbatim, tested with a valid host, an invalid string and a plain-http value, including the gateway's `not_configured` path (review RP5-R8) |
| m11 | No boundaries | Missing files | Boundaries with reset | `app/*.tsx` | A throwing component renders the boundary; reset recovers; no exception text |
| M6 | Copy-pasted handling | Native routes | Closed by RP8 | — | Retirement test |

**Tests.** The table-driven injection test; the pass-through test (stub 403 JSON → identical bytes; stub 500 HTML → identical except the injected shell); the errored-stream test (a stub that dies mid-stream → the client-side body read **rejects**; `stream_end` logged; nothing appended); the presentation-by-kind tests (404, 503, 504 as navigation and as API); the leak test as in m4; the boundary test; `Retry-After` on every PWA-originated 429 and 503 `busy`.

**Acceptance criteria.** The injection test passes; FO-originated bodies are byte-identical through the gateway for non-document responses and identical except the shell for documents; the M2 scenario shows sign-in; no body contains the FO host or the raw configured value; the wording table is approved at CP3; §9 question 57 is decided and its option implemented.

**Dependencies.** RP1–RP4, RP6, RP7, RP10-B (producers); RP10-A (`requestId`; the `x-request-id` precedence rule: the PWA's header is always the one returned, FO's is logged as `foRequestId` and never passed through under the same name; review RP5-R9); FO's client (consumer); RP8 (native wording retires).

**Open decisions.** §9 question 57 (chat-row presentation: C with FO owners; recommended (b) with (a) interim). CP3: wording per code; support flow; in-band frame vs errored close (recommended errored close); presentation of `account_inactive_post_password`.

**Review record.** Round 1 (27 September 2026): 1 BLOCKING (R1: FO's chat client renders the raw response text; recorded as §9 question 57 with option (a) as the interim rule and the acceptance criterion withdrawn), 7 FIX NOW (R2 error the stream, never close; R3 presentation by request kind and HTML error pages; R4 table completeness and rules; R5 the code → screen → action table; R6 pass-through wording vs shell injection; R7 the 401 rule; R8 two weak tests), 1 DEFER (R9 request-id header precedence, owner RP10-A, applied). . **Two-round cap reached; shown to the human.** Round-2 verdict was `NOT SAFE TO FREEZE` on the three text items, now applied.

---

### RP6 — Conversation authorisation at the gateway

> **Status (revision 3.11).** Design-review depth. First independent review: 0 BLOCKING, 6 FIX NOW, 4 DEFER; all FIX NOW applied; second round run and applied (two-round cap reached). **Not frozen.**

**Purpose.** *Authentication* answers who the user is (RP2). *Authorisation* answers whether this user may act on this object. FO's `/api/chat` and `/api/modeling-agent/chat` accept a `conversationId` and never check whose it is ([FO-clone]), so the gateway must prove ownership before a turn reaches FO, without weakening anything, without storing a credential, and with FO kept as the long-term authority.

**Included findings.** M3, G3, G7.

**Current architecture** ([code]; [FO-clone]). `checkChatBody` caches positive answers keyed `${token} ${id}` for 30 minutes, warmed from `GET /api/conversations` passing through; a miss downloads the caller's whole list; a non-owned id is **stripped** and the turn forwarded unpersisted; a non-string `conversationId` is forwarded unchanged (`ownership.ts:201-202`); the "5,000 entries" bound is a sweep trigger that removes expired entries only. `foFingerprint` (`lib/auth.ts:72-74`) is an **unkeyed truncated SHA-256** of the FO token, and the same value sits in the PWA bearer's payload, readable by any same-origin script. FO's `GET /api/conversations/{id}` checks `conversation.userId !== user.id` and returns the **whole conversation with every message** (1.3 MB measured for a long thread, `owns.ts:26-30`); its statuses come from a **database-loaded error catalogue** (403 and 404 are code defaults, `error-catalog-loader.ts`). FO's `POST /api/conversations` creates the row (201) before the client sends the first turn with that id. **FO's `addMessage` appends to a soft-deleted conversation** (`lib/storage.ts:202-229`, no `deletedAt` check; §9 question 21 answered for the clone). FO's client keeps a deleted conversation selected after a delete in another tab and sends its id on the next turn (`full-chat-app.tsx:1171-1232`). Production REQUIRES CONFIRMATION for each FO fact.

#### 1. Components

| Component | Responsibility |
|---|---|
| `lib/gateway/ownership.ts` | `proveOwnership(fp, id, token)`: cache, then one `GET /api/conversations/{id}` under RP4 `bounded`; `remember`, `forget(id)`, `warmFromListStream`, and **`warmFromCreate`** on a 201 `POST /api/conversations` passing through (the create-then-send path never pays a lookup; review RP6-R4) |
| Cache | **Key** `own:<fp>:<id>`, `fp = foFingerprint(token)`, a 128-bit truncated **unkeyed** SHA-256, the same value RP2 binds the bearer to; one-way only because FO tokens are 256-bit random ([FO-clone] `generateToken`; the live check asserts a token of at least 64 hex characters); client-visible by RP2's design and harmless because the cache is server-side and positive-only (review RP6-R1). **Value**: expiry instant. **TTL** `T_own` (parameter). **Negative answers never cached.** Per task; **true bound**: LRU at a parameterised cap (RP10-B L5 sizes it; provisional 50,000 ≈ 5 MB), replacing the sweep trigger (review RP6-R8) |
| Route | Applies the outcome table (part 3); emits RP10-A's three events: `ownership_lookup {conversationIdPrefix, bytes, elapsedMs}`, `ownership_refused {conversationIdPrefix, outcome, foStatus, elapsedMs}` at warn, `ownership_unavailable` at error (reviews RP6-R10, R14) |
| Invalidation | Mechanism (review RP6-R13): an O(n) scan of the LRU on each gateway-seen delete (deletes are rare; cheap at 50,000 entries), plus a **tombstone** `deletedAt[id]` held for `T_own`: `remember` refuses any positive whose proof or list read began before the tombstone, so a lookup or a list stream in flight when the delete lands cannot re-warm the id (tests: lookup in flight, then DELETE, then the lookup resolves 200, then the next turn performs a fresh lookup; the same for a list stream that flushes after the DELETE). On a 2xx `DELETE /api/conversations/{id}` through the gateway, **`forget(id)` for every fingerprint** (the same user's other sessions on this task lose the positive too; review RP6-R3); likewise on a `PATCH` FO answers 403. Deletes on FO's own origin or seen by another task: residual window ≤ `T_own` (part 4) |
| `lib/faborch/owns.ts` | Retires with the native route (RP8) **after** `proveOwnership` replaces its gateway use |

#### 2. When the lookup happens, and input validation (review RP6-R6)
Only on `POST /api/chat` and `POST /api/modeling-agent/chat` (exact paths; RP1's rows for these two become `exact` for POST so a trailing slash or a sub-path is never forwarded unchecked; review RP6-R9, an RP1 delta). If the JSON body carries `conversationId`: absent or `null` → forward untouched (FO creates or continues its own); a string that passes the same Zod 4 `z.string().uuid()` as FO's `ChatRequestSchema` (RFC-strict version and variant; an RFC-invalid 8-4-4-4-12 string is 400) → the proof; **anything else** (a non-UUID string, a number, an array, an object) → `400 {code:"invalid_request"}` with no FO call, because the modeling route has no schema of its own and the gateway must not rely on FO's ORM to refuse it.

#### 3. The outcome table, total and positive-only (review RP6-R2)

| Proof result | Outcome |
|---|---|
| Cached positive | forward |
| FO **200** with a JSON body whose `id` equals the requested id | proven: remember, forward |
| FO **401** | RP2's expired path: cookie cleared, `401 faborch_session_expired` |
| FO **403 or 404** | **refuse** `403 {code:"conversation_forbidden"}`, logged at warn with `foStatus` (FO's statuses are its database configuration; the live check records production's actual values for a non-owned and a never-existing id and **fails unless both are in {403, 404}**; if production maps either elsewhere, the refuse row's status set is a CP1/CP3 input and the gateway does not ship with 403/404 hard-coded; stub scenario: a catalogue-configured 400 for a missing conversation yields 503, recorded as the known consequence; review RP6-R11) |
| **Any other** status, a non-JSON body, an `id` mismatch, 5xx, network, timeout | **refuse** `503 {code:"ownership_unavailable"}` with `Retry-After` (the `bounded` budget rounded up); logged at error; **fail closed** |

One condition proves; everything else refuses. Stub scenarios include 422 and 302.

**Why refuse rather than strip.** Stripping silently turns an unauthorised request into a different valid one: FO creates or continues another thread the user never chose. That was tolerable for the PWA-native client's own stale-selection bug (B1). For FO's client there is **one legitimate case**: a conversation deleted in another tab or device stays selected and its id is sent on the next turn; refusing is still right, because the thread is gone (review RP6-R5). RP5's sentence for `conversation_forbidden` therefore covers both: "This conversation is no longer available or is not yours to continue. Start a new conversation." One status collapses FO's 403 and 404 (no more disclosure than FO's own endpoint), `foStatus` in the log separates deleted-own from foreign attempts so RP10-A's `ownership_refused` metric is not read as pure attack traffic. **The native route keeps stripping until it retires** (RP8); the existing `ownership.test.ts` assertions that pin stripping for the gateway path are rewritten, not kept.

#### 4. Cost, stale window and fail semantics
- **Cost of a miss** (review RP6-R4): FO's per-id endpoint returns the whole thread; a long one is 1.3 MB and FO database work, more than the list the old design fetched. Mitigations: `warmFromCreate` removes the guaranteed miss on every new conversation; `warmFromListStream` covers the sidebar path; misses remain for `T_own` expiry, cold tasks and re-routing. `T_total_bounded` for this call must cover the largest thread in the account or the call gets its own class value (CP3 input); RP10-B L5 measures per-id size and time at p95 on a real long thread; §9 question 18 also asks FO for a light ownership endpoint.
- **Stale window (G7)**: after `forget(id)` on gateway-seen deletes, the residual window is deletes made on FO's own origin or seen by another task, up to `T_own`; in the clone a turn sent then **is appended to the soft-deleted conversation** (own data, integrity not confidentiality). **[open, CP1, §9 question 21]**: (a) accept; (b) shorten `T_own` for positives from list warming and per-id proof while keeping session-length positives for ids the gateway saw created (recommended until FO answers question 18); (c) ask FO for the ownership-and-deletion check in `/api/chat`.
- **Fail closed** when FO cannot be asked: forwarding an unproven id could write into someone else's thread; stripping would write into a different one. Availability cost: a refused turn with `Retry-After`.

#### 5. Security and trust boundary
A compensating control for an FO IDOR; FO remains the authority for who owns what. No raw token in memory keys or logs (G3); the key equals the bearer's `fp`, pinned by a test so RP2 and RP6 cannot drift. Multiple tasks: more lookups, never a wrong answer.

#### 6. Finding map

| Finding | Problem | Root cause | Fix | Components | Behavioural test |
|---|---|---|---|---|---|
| M3 | A miss downloads the whole list; failures silently unpersist | List-based proof; strip on failure | Per-id proof with a total outcome table; `warmFromCreate`; refuse on not-owned; fail closed | `ownership.ts`, `route.ts` | 201 create then POST with that id → no lookup; a miss → exactly one `GET /api/conversations/{id}`; stub 403 → 403 coded, FO receives no turn; stub 422, 302, timeout, non-JSON, id mismatch → 503 `ownership_unavailable`, FO receives nothing |
| G3 | Raw tokens as keys | `${token} ${id}` | `foFingerprint(token)`; key equals the bearer's `fp` | `ownership.ts` | No key or log line contains the token; the cache key equals the bearer's `fp`; the live check asserts FO's token length |
| G7 | Stale positive after delete | No invalidation | `forget(id)` across fingerprints on gateway-seen 2xx DELETE; CP1 decides the residual window with question 21's clone answer | `route.ts`, `ownership.ts` | Two sessions of one user prove X; A deletes X (200); B posts to X → one fresh lookup (stub 404) → 403 |

**Tests.** The rows above; input validation (42, `["…"]`, `{}`, `"not-a-uuid"` → 400 without an FO call; `null` and absent → forwarded untouched); `POST /api/chat/` and `/api/chat/x` → not forwarded; one user's proof never proves another's; LRU eviction at the cap; the native route still strips until RP8; the read-only live check (non-owned and never-existing ids, token length, production's actual statuses).

**Acceptance criteria.** No raw token in any key; a non-owned id never reaches FO through the gateway; indeterminate never forwards; every refusal logged with `foStatus`; the live check passes; the CP1 decision recorded and implemented.

**Dependencies.** RP1 (buffered body; rows for `/api/conversations*`; the exact-match POST rows for the two chat paths: delta); RP2 (injected token; `foFingerprint`; the 401 path); RP4 (`bounded`; the per-id class value); RP5 (`conversation_forbidden`, `ownership_unavailable`, `invalid_request`, `faborch_session_expired`); RP8 (ordering: `owns.ts` deleted only after `proveOwnership` lands); RP10-A (the event fields); RP10-B (L5 measures cache misses and per-id cost).

**Open decisions.** CP1 (§9 question 21 with the clone's answer): the residual window, recommended (b). FO owners: §9 question 18 (ownership check in `/api/chat`, and a light ownership endpoint).

**Review record.** Round 1 (27 September 2026): 0 BLOCKING, 6 FIX NOW (R1 the fingerprint is unkeyed and client-visible; R2 a total outcome table; R3 `forget(id)` across fingerprints; R4 per-id cost and `warmFromCreate`; R5 the legitimate deleted-elsewhere case and the sentence; R6 UUID validation), 4 DEFER (R7 the clone appends to soft-deleted conversations, owner CP1/§9 question 21, recorded; R8 the true cache bound, owner RP10-B L5, applied here as LRU; R9 exact-match chat rows, owner RP1 part 5: queued for the RP1/RP2 delta batch; R10 log fields, owner RP10-A, applied). All FIX NOW applied. Verdict was `NOT SAFE TO FREEZE`. **Round 2 (28 September 2026):** 0 BLOCKING, 3 FIX NOW (R11 the live check asserts both statuses are in {403, 404}; R12 RP4's generic mapping carved out for the ownership lookup; R13 the `forget` mechanism and a tombstone against re-warming after a delete), 2 DEFER (R14 the three events and the retargeted mutation check, applied; R15 the gateway uses FO's Zod `uuid()`, applied). All applied. **Two-round cap reached; shown to the human.**

---
### RP7 — Browser security policy for a shared origin  *(Enterprise PWA)*

> **Status (revision 3.11).** Design-review depth. First independent review: 1 BLOCKING, 7 FIX NOW, 3 DEFER; all BLOCKING and FIX NOW corrections applied below; second round run and applied (two-round cap reached). CSP strictness, framing and HSTS preload are CP4's. **Not frozen.**

**Purpose.** State what the browser is told about every response on the PWA origin, name **exactly one writer for each response kind** so a header is never silently lost, and protect the properties that keep a signed-in user's FO access from being used by another site (CSRF), by injected script (XSS) or by content the platform itself generated.

**Included findings.** M12, G9, G24, G25, G26, G32, and **G33 (new, this revision)**: on the standalone Next server a header set by `next.config.ts` `headers()` or by middleware is written onto the response before the route runs, and a route handler's same-named header is then discarded, so the gateway's cache-header overrides in `lib/gateway/headers.ts` never reach the wire today.

**The trust expansion, stated.** After embedding, **FO's scripts and the PWA's scripts share one origin**: any script on it can read `llmatscale_auth_token` (G10, accepted in RP2), call the gateway with it, and the browser attaches the httpOnly cookie. RP7's controls are the mitigation RP2 relies on, and on FO's own documents they are **partial** (part 4): external-origin restriction, `no-store`, framing controls, but not a ban on inline script until FO supports a nonce (§9 question 50). RP2's G10 row now says so (delta, revision 3.9).

**Current architecture** ([code]; [Next-src]; [FO-clone]). The only header rule is `Cache-Control: no-cache, must-revalidate` on every path except the immutable asset prefixes (`next.config.ts:125-135`). The gateway's response allow-list passes nine headers and drops all others; it *sets* `cache-control` for HTML and SSE (`headers.ts:118-123`). **Header precedence, verified in Next 16.1.4** (`router-server.js:337-339`, `send-response.js:34-51`): config `headers()` and middleware response headers are applied with `res.setHeader` before the route handler is invoked; the handler's headers are appended only when not already present (exceptions: `set-cookie`, `www-authenticate`, `proxy-authenticate`, `vary`). Consequence today: every gateway response carries the config's `no-cache, must-revalidate`; the SSE `no-transform` is lost; the M12 note that "headers() doesn't cover middleware redirects" is wrong (config headers are set on `res` before a redirect is sent). **FO's browser-side behaviour, inspected:** one fixed inline script in FO's root layout; Next's per-request inline hydration scripts; Google Fonts via `@import`; generated artifacts framed with `srcDoc` and `sandbox="allow-scripts allow-downloads"` (opaque origin); the **Sandpack preview is a cross-origin iframe to CodeSandbox's bundler** (`sandpack-react` with the default `bundlerURL`), and its `cdn.tailwindcss.com` script loads inside that frame's origin, not under FO's policy; the PDF viewer frames a `blob:` URL; the DOCX viewer is a `srcDoc` frame with `sandbox="allow-same-origin"` and no scripts; **the reports page frames generated HTML with `sandbox="allow-same-origin allow-scripts"`** (G32: with `allow-same-origin` the frame's origin is the parent's, so its script reads `localStorage` and issues credentialed same-origin fetches directly). No FO iframe uses an HTTP `src` on its own origin. FO's only external browser-side origins in the clone are Google Fonts and CodeSandbox. The PWA's own documents carry two fixed inline scripts (`app/layout.tsx:129`, `app/offline/page.tsx:111`) as `dangerouslySetInnerHTML` without a `nonce` prop. `lib/scan/` no longer exists; no PWA page calls `getUserMedia`.

#### 1. One writer per response kind (G33; reviews RP7-R1, R13, R14, R15)

**Precedence, verified in Next 16.1.4:** for a single-valued header the order is **middleware > `next.config.ts` `headers()` > route handler** (`resolve-routes.js` assigns config headers first and middleware headers after into the same pre-route set; `send-response.js` appends a route's header only when absent). Next's own error renderer is a further writer of `cache-control` on Next-rendered error documents (`renderErrorImpl` sets `private, no-cache, no-store, max-age=0, must-revalidate` after the middleware set). **The kind of a forwarded response is decided by the registry owner** (`fo-document`, `fo-api`, `fo-static`) plus the stream content type, never by content type alone, so a 304 or a HEAD inherits its row's value.

| Response kind | Writer | Value and why |
|---|---|---|
| PWA immutable static (`/pwa-assets/_next/static/*`) | `next.config.ts` `headers()` for the security set; `Cache-Control: public, max-age=31536000, immutable` is the config's or Next's identical own value | Kind fixed by the path alone. **`proxy.ts` writes the security set only, never `cache-control`, on the `/pwa-assets` rewrite**, or it would override the immutable value (middleware beats config) |
| PWA documents (`/login`, `/offline`, `/diagnostics`, the front door) and PWA API routes (`/api/pwa/*`) | **`proxy.ts`**, on `NextResponse.next({request:{headers}})` and its response headers | Middleware headers win over the route, so `proxy.ts` is the writer and no PWA route sets a security header itself; documents `no-cache, must-revalidate`, API `private, no-store` |
| Next-rendered error documents (the `/__gateway-not-found` rewrite, `app/not-found.tsx`, the 500 path) | `proxy.ts` for the security set; **Next's error renderer for `cache-control`** (`private, no-cache, no-store, max-age=0, must-revalidate` is the expected wire value) | Next writes it after the middleware set; the value is stricter, accepted as the wire value |
| Middleware body responses (RP5's API-kind JSON 404 from `proxy.ts`) | `proxy.ts` | `private, no-store` and the security set |
| Middleware redirects (the three 307s) | `proxy.ts` | Security set; `no-store` |
| PWA unversioned static (`/sw.js` route, `/manifest.webmanifest`, icons) | `proxy.ts` for the security set; the `/sw.js` route sets its own `Cache-Control` (RP9) | `no-cache, must-revalidate` so RP9's probe and update checks are honest |
| Forwarded gateway responses: document, API, stream, static, **including 304 and HEAD** | **the gateway route** (`downstreamResponseHeaders`, keyed by owner and stream content type) | Document `no-cache, must-revalidate`; API `private, no-store`; static FO's immutable header; stream `no-cache, no-transform`; a stub 304 carrying `s-maxage=31536000` on a document row reaches the wire as `no-cache, must-revalidate`, on an API row as `private, no-store` (a 304's headers replace the stored response's in the browser cache, RFC 9111 §4.3.4). FO's real 304 headers are a CP4/CP5 probe item |
| Gateway-originated errors: every status RP5's table attributes to the gateway (400, 401, 403, 404, 405, 413, 429, 502, 503, 504) | the gateway route (`respond`) | `private, no-store` and the security set; `proxy.ts` sets **no response header** on `toGateway()` rewrites (the request-header override for `x-request-id` and the marker only) |

**The `next.config.ts` `Cache-Control` rule is removed for everything but the immutable prefixes**, and `revalidateSourcePattern()` is deleted or repurposed as the immutable rule's positive pattern; `__tests__/gateway/cache-policy.test.ts` retires with it (its immutable set becomes a test of the config rule plus the "PWA static" wire test; its revalidate set becomes the per-kind wire tests), and `headers.test.ts`'s downstream cases are rewritten to the owner-keyed rule (review RP7-R16). `lib/security/headers.ts` exports the per-kind value sets; the writers above apply them. Tests are **wire-level on the real-server harness** (RP10-A), one per kind above, because helper-level tests cannot see precedence; one negative test asserts that a config header and a route header with the same name resolve to the route's value when the middleware sets nothing, which fails today; one runtime probe on preview records the wire `cache-control` on a gateway API response.

#### 2. Controls

| Concern | Control |
|---|---|
| **CSRF against FO's APIs** | The bearer-plus-cookie invariant (RP2 part 1; RP1 G31): a cookie-only request never yields an injected token; `required` rows → 401 unforwarded; `optional` rows → forwarded anonymously. Release-blocker test (part 3) |
| **CSRF against the PWA's credential routes** | RP3's `sameOriginVerdict` on login and logout; JSON-only on login |
| **G31 anonymous rows** | Only `/api/platform-theme` and `/api/health`; capped in RP3's `anon-cap` namespace |
| **XSS and the localStorage bearer** | The bearer must stay readable. Mitigations: CSP per part 4; the 12-hour limit; FO's idle eviction; the FO token never exposed; `private, no-store` on every API response so no cached body carries user data; the report-frame fix (G32) |
| **HttpOnly FO token** | Unchanged: `httpOnly`, `secure` per RP1 part 4's scheme rule, `SameSite=Lax`, `expires` = PWA `exp` |
| **Security headers on every kind** | `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `Strict-Transport-Security: max-age=<CP4>` (preload by CP4 decision; set at the app, CloudFront adds no conflicting value, RP10-B); `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (framing is a CP4 decision, default none; see part 5 for the FO-document check); `Permissions-Policy: camera=(), microphone=(), geolocation=()` everywhere (no PWA page calls `getUserMedia` today; if a scanner returns, its page gets a camera exception and the PWA `script-src` gains `'wasm-unsafe-eval'`; RP10-A's dependency guard flags the unused `zxing-wasm`; review RP7-R10) |
| **Cache-Control** | Every PWA API and every `fo-api` response and every gateway-originated error: `private, no-store`, written by the kind's writer (G25); documents `no-cache, must-revalidate`; hashed static immutable; SSE `no-cache, no-transform` |
| **Pass-through** (G24) | `retry-after` and `www-authenticate` added to the downstream allow-list; **FO's request-id header is read for logging only and never forwarded**; the PWA's `x-request-id` is set on every response by that kind's writer (review RP7-R8) |
| **Generated and untrusted content** | Part 5 |

#### 3. The CSRF invariant test (G26), corrected for G31
For every `fo-api` row: a request with the cookie and no bearer never yields an injected token: `required` → `401 {code:"session_invalid"}` and the stub receives nothing; `optional` → forwarded with no `authorization`; a bearer from another session plus this cookie → 401. A release blocker in CI (RP10-A). RP2's G10 test cell describes the same outcomes.

#### 4. CSP: what is actually possible, and the rule that decides it
**The CSP3 rule** (review RP7-R3): when a `script-src` contains any nonce or hash, `'unsafe-inline'` is ignored. Therefore the FO-document policy, which must allow Next's per-request inline hydration scripts, **carries no hash and no nonce** while `'unsafe-inline'` is required; RP10-A gains a build guard that fails if the FO policy string contains `'nonce-` or `'sha`. FO's fixed inline script is hashable in principle but adding its hash would blank every FO page; that path opens only after §9 question 50.

**PWA documents** (`proxy.ts` is the writer; review RP7-R4): `proxy.ts` generates a nonce per request, sets the policy as a **request** header (`content-security-policy`, or `content-security-policy-report-only` during the trial; Next reads the nonce from either) on `NextResponse.next({request:{headers}})` and on every rewrite that renders a PWA page, and the same policy as the response header; Next then nonces its hydration scripts. The two fixed inline scripts receive `nonce` from `headers()` (which makes those pages dynamically rendered; `/offline` is instead a fixed-string route handler whose one inline script is hash-listed, RP9 part 1) or stay hash-listed beside the nonce (they coexist); never `'unsafe-inline'`. Policy: `default-src 'self'; script-src 'self' 'nonce-<n>' 'sha256-<guard>' 'sha256-<probe>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Test: on the real server every `<script>` in `/login`, `/diagnostics` and the document 404 carries the response header's nonce, and `/offline`'s single inline script matches a listed hash.

**FO documents** (the gateway is the writer; review RP7-R2): `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' [plus whatever the trial shows FO's page fetching cross-origin, REQUIRES FO/PRODUCTION CONFIRMATION]; frame-src 'self' blob: https://*.codesandbox.io; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors per part 5`. `cdn.tailwindcss.com` is **not** in `script-src` (it loads inside CodeSandbox's frame, not under FO's policy); `blob:` in `frame-src` is for FO's PDF viewer. Its value against a stored XSS in FO's own pages is **limited by `'unsafe-inline'`**, stated plainly for CP4.

**Report-only first**, on preview, for both document kinds, with `report-uri` and `report-to` both sent. **The report endpoint** `POST /api/pwa/csp-report` (review RP7-R7): accepts `application/csp-report` and `application/reports+json` (WebKit sends only the former); ignores bearer and cookie entirely and is never bridged; `small-json` body class; RP3's `csp-report` cap; cross-site posts judged by `sameOriginVerdict`; answers 204 to anything well-formed and 204 to anything else after the cap; fields allow-listed and URLs reduced to path only before logging (RP10-A part 2 forbids query strings). **The trial must exercise** `/login`, `/offline`, `/chat`, `/home`, an artifact with a Sandpack preview, a PDF and a DOCX attachment, and a report, or the log's silence proves nothing.

#### 5. Framing and generated content (G32; reviews RP7-R5, R6)
- **Framing.** `X-Frame-Options: DENY` is safe by construction: FO frames no HTTP route of its own (the contract-drift test re-checks this if FO adds one). Whether an inherited `frame-ancestors 'none'` is enforced on FO's `srcdoc` and `blob:` frames is engine behaviour a report-only trial cannot show, so CP4's bring-list gains a rendered check: with the header enforced on preview, the four FO frames (artifact, report, PDF, DOCX) still render on Chromium and WebKit; if any fails, FO-document responses carry `frame-ancestors 'self'` instead (still forbids third-party framing). The installed PWA is a top-level context on iOS and Android, so neither header affects installation.
- **G32.** FO's reports page frames model-generated HTML with `sandbox="allow-same-origin allow-scripts"`: the frame is same-origin with the page, so its script reads the PWA bearer and calls the gateway with the cookie attached. The fix is FO's (`allow-scripts allow-downloads`, §9 question 51). **Interim** (§9 question 49; recommended): a **document-denial mechanism evaluated at `classify` step 5**, exact `/reports` and `/reports/*` for FO documents only, in `whole` and `surfaces` modes, leaving RP1's contested-path rule intact while the PWA's own `/reports` screen exists (the `FO_DENIED_PREFIXES` list cannot be used: it runs before the contested rule and by prefix). This is a post-freeze **RP1 part 5 delta**, queued. Tests: `whole` mode `GET /reports` (document and `rsc` fetch) → RP5's document or JSON 404 and the stub receives nothing; `off` mode → the PWA page; after RP8's deletion → 404 in every mode. The FO fix is verified by a Playwright test (Chromium and WebKit) against the clone: a script inside the report `srcDoc` cannot read `localStorage` and its `fetch('/api/auth/me')` carries no cookie (jsdom does not implement `sandbox`). The successor to `scripts/security-review.mjs`'s sandbox check is a check against the FO clone's `app/reports/page.tsx` attribute, with the FO owners as the control's real owner.

#### 6. Finding map

| Finding | Problem | Root cause | Fix | Components | Behavioural test |
|---|---|---|---|---|---|
| G33 | Gateway header overrides never reach the wire; config headers leak onto gateway paths | Config and middleware headers are set before the route; same-named route headers are discarded | One writer per kind (part 1); config carries only immutable-asset headers; `proxy.ts` sets nothing on gateway rewrites | `next.config.ts`, `proxy.ts`, `route.ts`, `headers.ts` | Wire-level: a config header and a route header of the same name resolve to the route's value; every gateway response carries exactly the gateway's `cache-control` |
| M12 | No security headers | None configured | The set in part 2, written per kind | as above, `lib/security/headers.ts` | Wire-level, one per kind: PWA document, PWA API, redirect, PWA static, gateway document, API, stream, static, gateway error (incl. 304 and HEAD) (review RP7-R11) |
| G9 | FO's headers dropped, none added | Allow-list | The PWA's set on gateway responses, one owner | `headers.ts`, `route.ts` | Gateway responses carry the PWA's set whatever the stub sends |
| G24 | Useful headers dropped | Allow-list | `retry-after`, `www-authenticate` pass through; FO's request id log-only | `headers.ts` | A stub 429 with `Retry-After` reaches the client; a stub `x-request-id` does not |
| G25 | User data cacheable | Config rule wins; FO's header passed | `private, no-store` written by the gateway for `fo-api` and its own errors; the config rule removed for those paths | `next.config.ts`, `headers.ts`, `route.ts` | Wire-level on the real server: every `fo-api` response and every gateway error carries `private, no-store` |
| G26 | Invariant unstated | — | RP2 part 1 rule; the release-blocker test (part 3) | `injection.test.ts` | Cookie-only → never injected; `required` 401 unforwarded; `optional` anonymous |
| G32 | A generated report can read the bridged session | FO's same-origin sandboxed frame | FO fix; interim document denial at `classify` step 5 (RP1 delta) | FO `app/reports/page.tsx`; `registry.ts` | As in part 5 |

**Tests.** Part 6 rows; the nonce test; the report endpoint accepts both content types, refuses cross-site, is capped, logs path-only URLs; the trial covers the eight surfaces; the framing rendered check; `scripts/security-review.mjs` extended to assert the header set per kind on preview and production.

**Acceptance criteria.** The wire-level header tests pass for every kind on the real server; the negative precedence test passes; the G26 test is a release blocker; the CSP trial log exists for CP4 with the eight surfaces exercised; the G32 interim is implemented, and the denial list is emptied only after the FO fix is confirmed in production at CP5 (never on the clone signal alone); no `fo-api` response reaches a client without `private, no-store`, measured on the wire.

**Dependencies.** RP1 (`headers.ts` is RP1's file; G31 rows; the `/reports` document-denial delta; the scheme rule for `secure`); RP2 (G10 wording delta; the CSRF invariant); RP3 (same-origin helper; `anon-cap` and `csp-report` namespaces); RP5 (HTML error pages as PWA documents; gateway errors as a kind); RP9 (`/offline` dynamic rendering for the nonce; `/sw.js` route headers); RP10-A (real-server harness; the two build guards: FO policy contains no nonce or hash, `zxing-wasm` unused; `x-request-id` precedence); RP10-B (HSTS at the app; the preview probe).

**Open decisions.** CP4: CSP strictness on FO documents (recommended report-only now, then the `'unsafe-inline'` policy with external-origin restrictions; strict only after §9 question 50); framing (default none, `'self'` on FO documents if the rendered check requires it); HSTS `max-age` and preload; the G32 interim (recommended deny `/reports` until FO fixes, §9 question 49). FO owners: §9 questions 49, 50, 51; the list of browser-side external origins.

**Review record.** Round 1 (28 September 2026): 1 BLOCKING (R1: header precedence on the standalone server; recorded as G33 and the one-writer-per-kind design), 7 FIX NOW (R2 Sandpack is cross-origin, `frame-src`, `blob:`, the trial surfaces; R3 the CSP3 nonce/hash rule; R4 the nonce mechanics; R5 the `/reports` denial mechanism and test engine; R6 framing check; R7 the report endpoint; R8 FO's request id log-only), 3 DEFER (R9 RP2's G10 wording, applied as a delta; R10 the camera exception and `'wasm-unsafe-eval'`, applied; R11 the response-kind enumeration, applied). . **Two-round cap reached; shown to the human.** Round-2 verdict was `NOT SAFE TO FREEZE` on the five text items, now applied.

---
### RP8 — PWA-native chat, cockpit and reports (retirement)

> **Status (revision 3.11).** Retirement plan at the depth it needs. First independent review: 0 BLOCKING, 6 FIX NOW, 3 DEFER; all FIX NOW applied; second round run and applied (two-round cap reached). **Not frozen.**

**Purpose.** Retire the PWA's own chat, cockpit and reports and their proxy routes once embedded FabOrchestrator has replaced them in production; contain B1 before then if the cutover is far enough away; keep a fallback that actually works for installed phones until evidence says it is no longer needed; delete on a stated day, from a derived list, with the redirects made unconditional on that day.

**Included findings.** B1, M1, M8, M9, M10, M11, M13, m6, m7, m8, m9, m10, m12, m13, m19, N4, N5, N6.

**What retires: a derived list, not a hand-written one** (review RP8-R1). Retire roots: `app/fabinsight/*`, `app/backend-agent/*`, `app/reports/page.tsx`, `app/page.tsx` (replaced by a server redirect to FO's `/home`; `/` stays `PWA_RESERVED_EXACT` and `start_url`), `components/fab/screens/{agent-chat,landing,landing-ask,reports}.tsx`, `components/fab/{nav-drawer,artifact-sheet,artifact-tile,sign-out-link}.tsx`, `components/fab/{nav-items,use-session}.ts`, `lib/faborch/{conversation,history,stream,agents,artifacts,enforce-light}.ts`, `app/api/faborch/*`, the native wording in `lib/faborch/errors.ts`, and in `client.ts` the functions `foChat`, `foConnectedMcpIds`, `foConversations`, `foConversation`, `foCreateConversation`, `foPinnedReports`, `foPinnedReport`, `foSetPinned`, `foErrorTextOf` (each used only by retiring routes). Plus **the transitive closure of every module with no surviving importer**, computed at the deletion commit by a script over the import graph and kept as a CI test: "no module outside the survive list is reachable from a surviving entry point, and no orphan remains". **Ordering rule** (extended, review RP8-R13): `lib/faborch/history.ts` and `foConversations` are deletable only together with `owns.ts`, because surviving code reaches them through it; `foConversation` (the only `GET /api/conversations/{id}`) survives if RP6's `proveOwnership` uses it, otherwise it retires and RP6 calls `fetchFo` directly. **Ordering rule:** `lib/faborch/owns.ts` is deletable only after RP6's `proveOwnership` has replaced `ownsConversation` in `lib/gateway/ownership.ts` (RP6 implemented, not merely frozen). **What survives:** `proxy.ts`, the gateway and `lib/gateway/*`, the session code, the login route, `fetchFo` with `foLogin`, `foLogout`, RP2's login-time `/me` probe (a new `fetchFo` call RP2 adds; none exists today) and RP6's per-id lookup, `/login`, `/offline`, `/diagnostics`, the worker and manifest, `components/fab/app-shell.tsx` only if a surviving page still uses it (else it retires too).

**Tests and scripts that pin retiring code** (review RP8-R2): `route-gate.test.ts` (source-text assertions on `app/page.tsx` and `landing.tsx`), `landing-ask.test.ts`, `nav-drawer.test.ts` retire with their subjects; `destinations.test.ts` keeps its subject but its flag-off cases **invert** at the deletion commit (below); `registry.test.ts`'s reserved-prefix assertions **stay** because the prefixes stay reserved for the redirects; `__tests__/faborch/*` suites for the native routes retire; `scripts/security-review.mjs`'s iframe-sandbox check is **handed to RP7**, whose G32 rule on FO's `/reports` is its successor; the live-check scripts are **derived like the module list** (review RP8-R12): at the deletion commit, grep `scripts/` for `/fabinsight`, `/backend-agent`, `/api/faborch` and `/api/fabinsight`, and list each match as retired or rewritten against FO's pages (today that includes `answer-render-check`, `journeys-check`, `landing-ask-check`, `nav-drawer-check`, `reports-live-check`, `latency-baseline`, `gate-live-check`, `e1-live-check`, `artifact-live-check`, `mobile-audit`, `progress-states-check`, `embed-cutover-check`, `embed-live-check`, `embed-dashboard-check`); after unconditional redirects a `goto('/fabinsight')` silently exercises FO's `/chat`, so a script is never left to "pass" against the wrong application.

**Temporary containment before cutover.** B1 only (and M1 if CP0 agrees): reproduce both scenarios in an interaction test against the real component (the harness RP10-A part 5 names for this purpose, review RP8-R7), make the URL the source of truth, reset state on selection change. Nothing else in the retiring code is touched, **except RP1 part 3 item 7's B5 body pre-check on the native chat route, which RP1 owns** (review RP8-R6).

**Redirect and cutover behaviour.** `FO_EMBED_MODE=whole` in production: `proxy.ts` sends `/fabinsight` and `/backend-agent` to FO's `/chat` and `/` to FO's `/home` (exists, tested). **During the soak the native API routes are closed** (reviews RP8-R5, R10) **when `registry.mode === "whole"`** (in `whole` mode no native page that calls `/api/faborch` is reachable; in `surfaces` mode with only `/chat` listed the native `/reports` page still renders and its API stays open; tests: `surfaces=/chat` → `GET /api/faborch/reports` reaches the handler, `whole` → 404 `no-store`, flag off → reaches the handler); earlier wording, superseded: whenever `chatIsEmbedded`, `proxy.ts` answers `/api/faborch/*` with a `no-store` 404, restored by the flag exactly like the redirects, so the least-hardened routes in the system are not reachable behind the redirect for the whole soak; only surviving files change.

**Native Reports shortcuts while FO's `/reports` is denied** (review RP8-R14): while RP1's document-denial list contains `/reports`, a `whole`-mode document `GET /reports` gets a 307 `no-store` to `/home` in `proxy.ts` before `classify`; the redirect is removed in the commit that empties the list; the rehearsal adds a shortcut created from the native `/reports` with the flag flipped on.

**Flag-off rollback for installed phones** (review RP8-R4). Turning the flag off makes every path the PWA's, and the PWA has no page at `/chat`, `/home` or any FO document path; an installed shortcut or bookmark created from an FO page (iOS pins the URL on screen at add time) would open a dead 404. Therefore, while the native code exists, `destinations.ts` carries the **inverse map** for the flag-off state, specified precisely (review RP8-R15): any document path (per `isDocument`) that is not PWA-reserved, not contested and not `/fabinsight` or `/backend-agent` gets a 307 `no-store` to `/`, `/chat` (segment-bounded) goes to `/fabinsight`, and the query string is cleared, so sub-paths and FO pages added after cutover also land somewhere (tests: `/modeling-agent/loader/x`, `/chat?c=1`, an uncatalogued `/new-fo-page`). The earlier catalogue wording, kept for the record: `/chat` → `/fabinsight`, `/home` → `/`, any other FO catalogue document → `/` **except `PWA_CONTESTED_PREFIXES`** (a path the PWA answers itself with the flag off, `/reports` while its native page exists, is not redirected and a flag-off test asserts it renders the PWA page), as 307 `no-store`, applied in `proxy.ts` before `classify`, tested in both states; RP10-B's rehearsal includes an iOS shortcut created from `/chat` and one from `/home` flipped off and landing on a PWA page.

**Soak period.** Length is a CP0/CP5 decision (recommended: two full release cycles or four weeks, whichever is longer). During it the flag is the rollback (its real latency is the platform's, RP10-B's rehearsal measures it; review RP8-R8) and nothing is deleted.

**Rollback boundary.** During the soak: flag off (rehearsed time, RP10-B) plus RP9's kill switch if the worker misbehaves; after deletion: image rollback only, and the mode is enforced (below).

**When code is deleted, and what the deletion commit does** (review RP8-R3): after the soak, one commit deletes the derived list and its tests; **makes `retiredScreenRedirect` and `frontDoorRedirect` unconditional** (the `off` and `surfaces` modes cease to be valid configurations); rewrites `destinations.test.ts` (its `navItems` import and nav block go; the `chatHref` tests go with `chatHref`; every OFF, EMPTY and `surfaces` case is removed or inverted to the unconditional result) and removes the dead symbols `chatHref`, `chatIsEmbedded`, the inverse map and the `/api/faborch` soak closure in the same commit (review RP8-R12); adds the no-orphan test; and has RP10-B's startup assertion **refuse `FO_EMBED_MODE !== "whole"`** from that build onward, so a missing or mistyped variable can never serve Next's 404 for every FO path. This retires frozen RP1's rollback statement "flag off means everything is the PWA's" on the same day: **a scheduled post-deletion RP1 delta**, recorded here.

**Evidence required before removing the fallback:** (1) RP1's route policy approved at CP1 and the contract-drift test green against the FO release in production; (2) RP2 to RP7 frozen and their release-blocker tests green; (3) L1–L5 run at the CP5 targets; (4) the rollback rehearsal record, including the installed-shortcut cases; (5) FO's go-live dependencies confirmed or explicitly accepted (§9 questions 44, 51); (6) the installed-phone checks green on production; (7) no flag-off event during the soak, evidenced by RP10-A's `startup` event and the `route.mode` distribution (review RP8-R9), or each one explained and closed; (8) **usage evidence**, observable because `proxy.ts` emits a `route` event on **every** return, including the three 307s, the inverse-map 307s and the soak 404, with an `outcome` field (`forwarded`, `redirect`, `closed`, `denied`, `pwa`) (review RP8-R11; a real-server test asserts `GET /fabinsight` in `whole` mode emits exactly one `route` with `outcome:"redirect"`) (review RP8-R5): from RP10-A's `route` events, zero redirects from `/fabinsight` and `/backend-agent` and zero requests to `/api/faborch/*` over the final N days of the soak (N a CP0 value), or each occurrence explained.

**Finding map.** All listed findings → closed by removal (evidence: the deletion commit and the no-orphan test), with these residues (review RP8-R6): **N6** the invented role label survives in the login route and `/me` (`DEFAULT_ROLE_LABEL`); owner RP10-B part 3's documentation-truth list (the login route and `/me` stop minting and returning an invented role; FO's embedded client reading the stored blob is confirmed first; WHOLE-R7), with the caveat that FO's embedded client may read the stored session blob before `roleName` is dropped (REQUIRES FO confirmation); **m9** the `llmatscale_auth_token` literal survives in four surviving files as FO's contract (record only; `fo-shell.js` is deliberately dependency-free); **M13** the PWA's renderer retires and the same risk class re-enters through FO's `/reports`, owned by RP7 as G32; **N4** copies in surviving files were not counted and are RP7/RP9's screens to tidy. **B1** → contained (two red-then-green interaction tests) if CP0 chooses containment.

**Dependencies.** RP0/CP0 (date, soak, per-screen fate); RP1 (`whole`; the post-deletion delta; the B5 pre-check); RP2 (credentials across the flip; the N6 residue); RP6 (ordering for `owns.ts`); RP7 (the sandbox check's new home); RP9 (kill switch); RP10-A (`startup` event; the interaction-test harness; the no-orphan test); RP10-B (rehearsal with installed shortcuts; flag latency; staged rollout; deletion after CP5).

**Open decisions.** Jothi (CP0): cutover date; soak length and N; whether any native screen survives; B1 containment before cutover.

**Acceptance criteria.** Cutover: flag on in production, redirect tests green, native API routes answer 404 in `whole` mode, the inverse map tested, rollback rehearsed with installed shortcuts. Retirement: the derived list deleted, the no-orphan test green, redirects unconditional, the mode assertion in place, `npm test` green, old bookmarks land on `/chat`.

**Review record.** Round 1 (27 September 2026): 0 BLOCKING, 6 FIX NOW (R1 derive the list, fix names, `/`'s fate, the `owns.ts` ordering; R2 the surviving tests and scripts, the sandbox check's home; R3 unconditional redirects and the mode assertion after deletion; R4 the inverse map for installed phones; R5 usage evidence and closing the native API routes during the soak; R6 N6 and m9 residues and RP1's B5 pre-check), 3 DEFER (R7 the interaction-test harness, owner RP10-A part 5, applied; R8 flag latency, owner RP10-B, applied; R9 the `startup` event, owner RP10-A, applied). Verdict was `NOT SAFE TO FREEZE`. **Round 2 (28 September 2026):** 0 BLOCKING, 6 FIX NOW (R10 the soak closure keyed on `whole` mode; R11 `route` events on every `proxy.ts` return with an `outcome`; R12 the deletion commit's test and script work derived; R13 the extended ordering rule and corrected names; R14 native Reports shortcuts redirect while FO's `/reports` is denied; R15 the inverse map specified for every document path), 2 DEFER (R16, R17, applied in RP10-A). All applied. **Two-round cap reached; shown to the human.**

---

### RP9 — Installable-app lifecycle: service worker, caching, offline, updates, manifest  *(Jothi #2)*

> **Status (revision 3.11).** Design-review depth. First independent review: 0 BLOCKING, 7 FIX NOW, 3 DEFER; all FIX NOW applied; second round run and applied (two-round cap reached). `T_nav`, `T_probe` and the CP4 decisions are inputs. **Not frozen.**

**Purpose.** The installed app loads within a budget or says honestly why not; it never serves stale authenticated content; it recovers from a bad deploy without user surgery; it learns about updates without breaking pages that are open; it has one identity; and all of that holds for FabOrchestrator's embedded pages, because the same worker controls them.

**Included findings.** M14, M15, M16, m14, m15, N2.

**Current architecture** ([code]; [Next-src]). `public/sw.js`: precaches `/offline` and two icons under a hand-bumped cache name; handles **navigations only**; awaits `preloadResponse` then `fetch` with two retries and **no deadline**; on failure serves the cached offline page only when `navigator.onLine === false`, else an inline recovery page whose text blames "stored files"; `skipWaiting` on install and `clients.claim` on activate. Registered on `load` from FO's pages (`fo-shell.js:133-138`) and in an effect from the PWA layout. The chunk guard in the root layout (present in `/offline`'s own HTML) reloads once per session on a failed `/_next/static` script and latches. Manifest `id` is `/orders`. **Next 16.1.4 serves a `public/` file in preference to an App Router route at the same path, silently, and the build's conflict check covers the pages router only** (`filesystem.js:393-416`, `build/index.js:815-827`). FO registers no worker of its own.

#### 1. Resource strategy, per category

| Category | Strategy | Rule |
|---|---|---|
| PWA app shell documents (`/login`, `/offline` when online, `/diagnostics`) | **NETWORK ONLY** with the navigation deadline and fallback (part 2) | Documents are session-gated; a cached document is stale authenticated UI and would survive logout |
| **Offline page** | **CACHE FIRST**: the single precache entry. **Served by a route handler `app/offline/route.ts` returning a fixed HTML string** (review RP9-R11), not a layout-rendered page, because any App Router page carries Next's runtime chunk scripts, flight scripts, a linked stylesheet and the root layout's chunk guard, which would fail and reload offline. The string holds an inline `<style>`, an inline SVG, a **system font stack** (web fonts cannot be available offline unless precached, which would be a Rule 1 change) and the probe script, allowed by the `'sha256-<probe>'` entry in RP7's PWA policy; the hash is **computed at startup from the same exported string**, never hand-copied. The handler sets only `Content-Type: text/html; charset=utf-8`; `proxy.ts` remains the writer of the CSP, the security set and `no-cache, must-revalidate` (RP7 part 1); the page carries no nonced script, so the cached header's nonce is harmless | Must render with no network, no chunk, no font request, and must not trigger any chunk guard. Test on the real server: `/offline` contains zero `<script src`, zero `<link rel="stylesheet"`, no `__next_f`, and exactly one inline script whose SHA-256 appears in the response CSP; the M16 three-cooldown test runs against the precached copy |
| Icons, manifest | **NETWORK (not intercepted)**; HTTP `no-cache` revalidation | The worker intercepts navigations only, so a cache-first strategy could not execute; the offline page draws an inline SVG; iOS fetches `apple-touch-icon` at add time outside the worker (review RP9-R6) |
| PWA static chunks `/pwa-assets/_next/static/*` | **NETWORK (not intercepted)**; HTTP immutable caching | A cached chunk against newer HTML is the M16 loop; **[open: CP4]** whether to add a capped cache-first later |
| FO HTML documents | **NETWORK ONLY**, same deadline and fallback | Same reasons as the app shell; FO deploys independently |
| FO static assets, PWA APIs, FO APIs, authenticated responses, SSE, downloads, generated content | **NETWORK (not intercepted)** | The worker returns before touching any non-navigation request; `/api/*` navigations (a download link) pass through untouched |

**Rule 1, stated structurally** (review RP9-R7): the worker's **only cache write is the install-time `cache.add` of the fixed precache list (`/offline`)**; there is no write in any fetch, message or activate handler. Tested behaviourally in the `node:vm` harness: a recording `Cache` mock, install, activate, a navigation success, a navigation failure, a 307 and an `/api/` navigation are driven, and the recorded writes must equal exactly the precache list and occur only during install. A second assertion on what the install fetch may store (no `private`/`no-store`, no `set-cookie`, no non-offline document) guards a future change to precache an authenticated page.

#### 2. Navigation handling and offline behaviour (M14, M15; review RP9-R4)
1. A navigation arrives; the worker races `preloadResponse` / its own `fetch` against **`T_nav`, total across preload, retries and the probe start**, with an `AbortController` on its own fetch (`preloadResponse` cannot be aborted and is ignored on expiry). **`T_nav = T_headers_document + T_connect + M`**, strictly larger than the gateway's own document budget, so the gateway's coded 504 always arrives before the worker gives up (RP4 part 7; `M` covers edge and network, a CP3 value).
2. Success → the response, uncached.
3. Failure or expiry → a **reachability probe** `HEAD /icon-192.png?probe=<now>` with `T_probe`, accepted only when `res.ok && res.type === "basic"` and `content-type` starts with `image/png`, so a captive portal or an intermediary HTML answer never counts as reachable (review RP9-R8). Probe fails → the cached **offline page**. Probe succeeds → the **recovery page**, whose text no longer blames stored files ("the server answered a check but not this page within N seconds") and whose reset (unregister and clear caches, still useful against a bad worker) is rate-limited by a timestamp cooldown in one shared module, never latched (M16). `navigator.onLine === false` may only shortcut to "offline".
4. The offline page's own probe-and-return uses **the same shared module** as the worker (review RP9-R12): it exports the probe URL builder, the acceptance predicate (`res.ok`, `res.type === "basic"`, `content-type` starting `image/png`) and the cooldown, and both the worker template and the offline route's inline script are generated from it; because the page is chunk-free, no chunk guard fires on it and it stays still while offline (reviews RP9-R5, R11). Test: the offline page with a stubbed 200 `text/html` probe answer stays on screen.
5. **Back/forward cache** (WHOLE-R12): `fo-shell.js` and the PWA layout handle `pageshow` with `event.persisted` when no bearer is present by `location.replace('/login')`, so a back gesture after sign-out cannot restore a previous FO page with its data; Playwright test with bfcache enabled. **Stale-session behaviour:** a 307 to `/login` passes through untouched; the worker never serves a document from cache except the offline page.

#### 3. Installation, activation, update and retirement (m15; reviews RP9-R1, R2, R3)
- **Source and serving.** `public/sw.js` is **deleted**. The template is a **TypeScript module exporting the worker source as a string constant** (so it is imported, bundled, traced into the standalone output and inside RP10-A's orphan guard); the route is `export const dynamic = "force-dynamic"` and reads `SW_KILL` per request; a check against the built standalone server asserts `GET /sw.js` returns 200 with the substituted build id and, after a restart with `SW_KILL=1`, the kill worker (review RP9-R14). `/sw.js` is served by `app/sw.js/route.ts` from a template module (`lib/pwa/sw.template.js`) with `__BUILD_ID__`, `__T_NAV__`, `__T_PROBE__` substituted; `Content-Type: application/javascript; charset=utf-8` and `Cache-Control: no-cache, must-revalidate` set explicitly by the route; the build id from `generateBuildId` in `next.config.ts`, exposed through a public env variable and pinned by a test. RP10-A gains a **build guard**: the build fails if any file in `public/` shadows an `app/**/route.ts` path. The `node:vm` test loads the generated source through the same function the route uses, in both modes. Consequence for CP4: every PWA deploy is a worker update and produces the notice even when worker logic is unchanged.
- **Install:** precache `/offline` under a cache named by the build id; `skipWaiting` is **not** called.
- **Waiting and the notice.** Both registration sites, after `register()` resolves: `if (registration.waiting) showNotice(registration.waiting)`; then listen for `updatefound` → `installing.statechange` to `installed`, showing the notice only if `navigator.serviceWorker.controller` exists (a worker already waiting before the page loaded is the common phone case; review RP9-R2). The notice is never offered, and the `controllerchange` handler does nothing, once a client-side session end has begun (`fo-shell.js`'s `signingOut` flag, and a matching flag set by `endClientSession` on PWA pages), so an accepted-update reload can never race the sign-out navigation to `/login` (review RP9-R13; test on an emulated FO document: accept the update, remove `llmatscale_auth_token`, deliver `controllerchange`, exactly one navigation, to `/login`). On FO documents the notice is created after `load` as a node appended to `document.body` outside FO's React root, with inline styles only. The notice posts `{type:"SKIP_WAITING"}` only when the user accepts, sets a local `acceptedUpdate` flag, and **reloads on `controllerchange` only if this client accepted** (review RP9-R1). What this does and does not promise, stated plainly: a `skipWaiting` hands every controlled client to the new worker at activation, so other open tabs experience `controllerchange` too and must either tolerate it or show their own notice (they do not reload); a waiting worker **activates by itself when the last client closes**, so on a phone the update normally lands at the next launch without a notice, and the notice covers the open-app case only; `clients.claim()` matters only for uncontrolled pages. **[open: CP4]** prompt (recommended) versus forced reload after a grace period.
- **First install:** no controller exists; the first worker activates and claims immediately; **no reload** (the `acceptedUpdate` guard).
- **Activate:** `clients.claim()`, then delete every cache not named by this build id.
- **Old-worker retirement:** automatic once the new worker activates; the cache deletion removes its data.
- **Kill switch:** with `SW_KILL=1` the route serves a worker whose `install` calls `skipWaiting` and whose `activate` unregisters itself and clears every cache. It **does become the controller of open pages** at activation (harmlessly: it has no fetch handler) and, with the `acceptedUpdate` guard, causes **no reload**. The browser's navigation-time update check (24 h) and `register()` on every load (which itself triggers an update check) deliver it; rehearsed in RP10-B.

#### 4. FO documents under the worker
`/chat` is treated exactly like `/login`: network only, deadline, fallback. FO deploys change FO's chunk hashes; the PWA caches none, so an open FO page after an FO deploy behaves as on FO's own origin. The injected manifest makes FO's pages installable; `fo-shell.js` registers the same worker with the same scope `/`, and its update notice sits beside, and never delays, the sign-out watcher.

#### 5. Identity (N2; review RP9-R10)
`id: "/orders"` names a removed workflow. Changing it orphans **Chromium-family installs** (Android, desktop Chrome); iOS Home Screen apps are keyed by the URL that was on screen when added and are unaffected (INFERRED; verified on the CP4 handset run). **[open: CP4, §9 question 58]**: change now while the installed base is a pilot (recommended, to a non-path value such as `"faborchestrator-pwa"`), or keep forever. `start_url` and `scope` stay `/`.

#### 6. Rollback behaviour
A PWA image rollback ships the previous worker source with a different build id: it installs as an update and waits; the notice appears. If the rolled-back build must take over at once, `SW_KILL=1` first, then the rollback. In RP10-B's runbook.

#### 7. Finding map

| Finding | Problem | Root cause | Fix | Components | Behavioural test |
|---|---|---|---|---|---|
| M14 | Blank installed window on a hanging origin | No deadline | `T_nav` (total, aborting, strictly above the gateway's document budget) + probe + fallback | `sw.template.js` | A hanging navigation reaches the offline or recovery page within `T_nav + T_probe`; a gateway 504 on a document arrives as the gateway's HTML error page, not the recovery page |
| M15 | Verdict from `navigator.onLine` | Link signal | Reachability probe with type and content-type checks | `sw.template.js` | Wi-Fi without internet → "no connection"; an HTML portal answer → "no connection" |
| M16 | Recovery latches; cooldown would reload the offline page | Permanent flag; chunk tags on `/offline` | Timestamp cooldown in one module; chunk-free offline page | layout guard, offline page, worker | Two deploys in one session both recover; with the network off the offline page stays on screen for three cooldown periods with no reload |
| m14 | Offline page unstyled | CSS not precached | `app/offline/route.ts` returns a fixed HTML string with an inline style, an inline SVG and a system font stack; no chunks, no font request | `app/offline/route.ts` | Renders styled with the network off; contains no `<script src`, no stylesheet link, no `__next_f` |
| m15 | No update notice; unsafe activation | `skipWaiting` on install; static file | Waiting worker, `registration.waiting` check, notice, user-accepted `SKIP_WAITING`, `acceptedUpdate` reload guard; the route with the kill switch; the shadowing build guard | worker template and route, `register-sw.tsx`, `fo-shell.js`, RP10-A guard | A worker waiting before load shows the notice on a PWA page and an FO page; first install → no reload; acceptance in tab A → tab B shows its own notice, no reload; kill worker activation → no reload, navigation passes through; a stray `public/sw.js` fails the build |
| N2 | Manifest names a removed workflow | Stale copy | Copy fixes; `id` per CP4 | manifest | `pwa-install-check.mjs` |

**Tests.** The rows above; Rule 1 (structural, recording cache mock); the stale-session test; the `node:vm` test against the generated worker in both modes; the FO-document test on preview; and, because desktop WebKit cannot exercise the installed-app lifecycle (review RP9-R9), **five cases on real devices** in RP10-B's installed-phone rehearsal record (one iOS, one Android): first launch from the Home Screen (no reload); an update while the app is open (notice) and while closed (silent activation at relaunch); `SW_KILL=1` reaching an installed copy; the offline and recovery pages. RP9's acceptance cites that record for these five, not the emulated run.

**Acceptance criteria.** All rows green on Chromium and WebKit (the matrix until CP4) for what emulation can prove; the five device cases recorded; Rule 1 green; the kill-switch rehearsal recorded; `pwa-install-check.mjs` and `fo-installed-nav-check.mjs` green on preview.

**Dependencies.** RP1 (FO documents; the injected head; `/sw.js` reserved); RP2 (never-cache-documents); RP4 (`T_nav` strictly above `T_headers_document`); RP5 (document error pages arrive before `T_nav`); RP7 (never cache `no-store`); RP8 (redirects pass through); RP10-A (the shadowing build guard; `sw_kill_served`); RP10-B (edge cache behaviour for the probe target must honour origin `Cache-Control` and forward the query string, review RP9-R8; the device rehearsal; the kill switch in rollback).

**Open decisions.** CP4: manifest `id` (§9 question 58; recommended change now to a non-path value); update policy (recommended prompt); caching PWA chunks (recommended no); the device matrix; what "offline" promises; MDM distribution.

**Review record.** Round 1 (27 September 2026): 0 BLOCKING, 7 FIX NOW (R1 the `controllerchange` guard and what waiting really promises; R2 the `registration.waiting` check; R3 route-vs-static precedence, the template and build id, the shadowing guard; R4 `T_nav` strictly above the gateway's budget, total, aborting, honest recovery text; R5 a chunk-free offline page; R6 icons and manifest are not intercepted; R7 Rule 1 restated structurally and tested behaviourally), 3 DEFER (R8 edge cache behaviour for the probe target, owner RP10-B, applied there; R9 device rehearsal, owner RP10-B, applied; R10 manifest-id scope, owner CP4/§9 question 58). All FIX NOW applied. Verdict was `NOT SAFE TO FREEZE`. **Round 2 (28 September 2026):** 0 BLOCKING, 4 FIX NOW (R11 a layout-rendered page cannot be chunk-free, so `/offline` becomes a fixed-string route handler with a hash-listed probe script and a system font stack; R12 one shared probe module for the worker and the offline page; R13 the accepted-update reload never races the sign-out navigation; R14 the template as a TypeScript string module, `force-dynamic`, a standalone check), 1 DEFER (R15 mixed-version `/sw.js` during a deploy, owner RP10-B, applied). All applied; RP7's `/offline` references corrected. **Two-round cap reached; shown to the human.**

---
### RP10-A — Engineering enablers: observability, behavioural test harness, build guards

> **Status (revision 3.11).** Design-review depth. First independent review: 1 BLOCKING, 13 FIX NOW, 2 DEFER; all BLOCKING and FIX NOW corrections applied below; second round run and applied (two-round cap reached). **Not frozen.**

**Purpose.** Give every other package the means to prove what it claims about *this* architecture: one request reconstructable from phone to FO by an id the PWA minted, every security-relevant decision logged without a credential or an access-bearing identifier, metrics that name the failure modes the other RPs designed against, tests that exercise behaviour on a stub FO and on a real Next server, and a CI gate on a named platform that produces the release evidence.

**Included findings.** M17, M18, m16, m17, m18, N1, N7, G28.

**Current architecture** ([code]; [Next-src]). 11 unstructured `console.*` calls in 8 files, several logging the FO URL, the raw configured `FABORCH_BASE_URL`, undici error objects and FO error bodies (`client.ts:542`, `route.ts:171`, `login/route.ts:100`), and one logging a full `conversationId` (`route.ts:144`); `node:test` via `tsx` in three suites (568 passing at the plan's baseline); source-text assertions in `nav-drawer.test.ts`, `route-gate.test.ts`, `landing-ask.test.ts`, `artifacts.test.ts`, `credentials.test.ts`, `markdown-lists.test.ts` and the worker's `PRECACHE` regex; Playwright installed without browsers; **no CI configuration**; Docker on tag-pinned `node:22-alpine` while `engines` says `>=20.11`; `server-only` not installed; `eslint.config.mjs` turns `react-hooks/set-state-in-effect` off with a justification naming files that no longer exist and leaves `no-unused-vars` at warn with a bare `eslint` script. `proxy.ts` passes overridden request headers **only on the gateway rewrite** (`:257-259`); every PWA-owned path returns a bare `NextResponse.next()` or rewrite (`:125, :216-222, :271`). No `instrumentation.ts`. **The repository is its own GitHub repository** (`origin https://github.com/KingCorsair/faborchestrator-pwa.git`; the working tree is the git root), not a subfolder of the parent monorepo: the earlier "no hosting connection" constraint concerned granting a host read access to the parent repo, which a workflow in this repository does not do.

#### 1. Request id: minted on every path, propagated explicitly (reviews RP10A-R1, R2)
`proxy()` wraps **every** return: it mints `crypto.randomUUID()` once, builds `headers = new Headers(req.headers)` with `x-request-id` set to it (an inbound value is **replaced** on every path, not only the gateway rewrite), passes `{request:{headers}}` on every `NextResponse.next()` and every rewrite (`toGateway`, `notFound`, the `/pwa-assets` rewrite); it sets the **response** header `x-request-id` on `NextResponse.next()`, on the `/pwa-assets` and `notFound` rewrites and on the three 307s, but **on `toGateway()` rewrites it sets the request header only and no response header** (RP7 part 1: the gateway route is that kind's writer and writes `x-request-id` from `ctx` through `downstreamResponseHeaders` and `respond`; review RP10A-R17). Each route or gateway entry builds **`requestContext(req)`** once: it accepts `x-request-id` only when it is a 36-character RFC 4122 UUID, otherwise mints one and emits `security {kind:"request_id_missing", pathPattern}` (defence in depth behind the matcher; review RP10A-R19); `ctx` is **immutable**: `{requestId, edgeRequestId?}` at entry, and the auth bridge returns `withSession(ctx, {sessionFp, userId})`, where `sessionFp` is set from the bearer's `fp` only after the signature verified (an expired-but-authentic bearer carries it, a forged one does not) and `userId` only after full verification; lines emitted before the bridge carry the request ids only; post-response closures capture the enriched `ctx` by value (review RP10A-R20). It is passed explicitly: `log(ctx, event, fields)` (the logger's `ctx` parameter is non-optional), `fetchFo(path, init, cls, ctx)` (an RP4 signature addition), the pipe and stream helpers, and RP2's post-response revoke, which captures `ctx` before the response returns so `session_end` and `stream_end` carry the id after the handler has finished. The gateway forwards `x-request-id` to FO (RP1's allow-list addition; RP1 part 4 now says "replaced before every return of `proxy()`"); `fetchFo` adds it on user-initiated calls. **Returned on every response as `x-request-id`, always the PWA's value**; any FO request-id header is logged as `foRequestId` and never passed through. **`edgeRequestId`** (CloudFront's `x-amz-cf-id`, the ALB's `x-amzn-trace-id`) is an **opaque, untrusted correlation aid** (review RP10A-R5): read only when the identity source is the AWS one, never on Fly; capped at 128 printable ASCII characters, else dropped with a `security {kind:"malformed_edge_id"}` line; never a trust input or join key (the ALB preserves client-authored `X-Amzn-Trace-Id` fields, an AWS behaviour recorded for CP5 confirmation).

#### 2. Safe correlation: names and values (reviews RP10A-R3, R4, R13)
An **allow-listed field set**, and **value rules** on top, because every present leak is a value inside an innocuous field:
- **Identity fields:** `sessionFp` = the first 8 **base64url** characters of `foFingerprint` (48 bits; unkeyed and client-visible by RP2's design, so correlation only, never a secret); `accountKeyPrefix` (RP3); `userId` (FO's id, only after RP2 verified the session).
- **Errors are logged as `{errorName (e.cause?.name ?? e.name, since undici's informative name sits on the cause), errorCode (e.cause?.code ?? e.code), stage}` only**; `message` and `stack` are never fields in production (`LOG_STACKS=1` in development only). No URL is ever logged: `upstream`, `route` and `body_refused` carry the **registry row pattern** (`/api/conversations/:id`) for FO API rows and the literal path only for PWA-owned and static owners without dynamic segments (PWA-owned dynamic segments such as `/api/faborch/conversations/:id` are logged as a pattern plus `idPrefix`, review RP8-R16), plus an `idPrefix` (8 characters) where a row has a dynamic segment; a `Location` is logged as its row pattern after `rewriteLocation`, never the concrete value (a conversation id is a capability at FO until RP6 lands).
- **`bodyPrefix`** (200 bytes, on `upstream_invalid` only): never emitted for the login, logout and `/me` calls (credential-carrying responses), only when the response content type is `text/html` or `application/json`, and scrubbed by definition: any email-shaped string and any run of 32 or more `[A-Za-z0-9_-]` characters is replaced.
- **Never logged:** `authorization`, `cookie`, `set-cookie`, emails, passwords, the PWA bearer, the FO token, `FABORCH_BASE_URL` or its raw configured value, query strings, full paths of dynamic FO rows, concrete `Location` values, request or response bodies beyond the scrubbed prefix. (The same rule closes the user-visible `Could not reach FabOrchestrator at <host>` message on the response side under RP5 part 2; review RP10A-R16.)
- **The redaction test is value-level:** a token-shaped and an email-shaped string are planted in the request path, the query string, an FO error body, FO's `Location`, an undici-style error `cause`, a bearer in `authorization`, the FO token in `cookie`, an FO `set-cookie` on a stub response, a password and email in the login body, and a `FABORCH_BASE_URL` of the form `https://user:<token>@host` for the run; the `startup` event's `flags` and `edgeValues` contain no URL; the whole test runs once more with `LOG_STACKS=1`; none of the planted values may appear in the captured sink (review RP10A-R18).

#### 3. Event catalogue (each tied to the failure mode it exists for)

| Event | Fields (beyond `ts, level, requestId, buildId, instanceId, region, mode`) | Failure mode |
|---|---|---|
| `startup` (once per process, emitted from `instrumentation.ts` `register()` guarded by `NEXT_RUNTIME === "nodejs"`, where RP10-B's startup assertions also run; review RP10A-R10) | `flags, keyRingIds, identitySource, edgeValues` | RP8's gate item 7; configuration drift |
| `route` (emitted by `proxy.ts` on every return) | `pathPattern, owner, outcome: forwarded\|redirect\|closed\|denied\|pwa, method, idPrefix?` | RP1 misclassification; requests to retiring paths (RP8 gate item 8) |
| `gateway_refused` | `owner, reason: method\|body\|auth\|anonymous\|ingress, code, status` | RP1 405/413; RP2 bridge; G31; RP3 `untrusted_ingress` |
| `upstream` | `owner, class, status, elapsedMs, bytesOut, foRequestId, pathPattern` | RP4 latency and status by class |
| `upstream_failed` | `class, reason: connect\|headers\|body\|idle\|lifetime\|cancelled\|invalid\|shutdown, errorName, errorCode, elapsedMs, msSinceLastUpstreamByte, msSinceLastDownstreamWrite` | RP4; an edge-caused close shows as a cancel at a constant offset after upstream silence |
| `stream_end` | `reason: complete\|idle\|lifetime\|cancelled\|upstream_error\|shutdown, bytes, elapsedMs, keepAliveMaxGapMs, msSinceLastUpstreamByte`; Next's own "failed to pipe response" (E180) that follows an intentional errored stream is classified by the matching `requestId` and never counted as an unexplained error (review RP4-R19) | RP4 deadlines; RP10-B draining |
| `login_attempt`, `login_throttled`, `limiter_store_unavailable`, `limiter_settle_failed`, `limiter_store_full`, `login_source_identity_unavailable` | RP3's fields | RP3 T1–T12 (tests 1–18) |
| `session_start`, `session_end` | `reason: user\|pwa_expired\|fo_expired\|gateway_refusal\|replaced\|probe_inactive\|probe_unexpected\|abandoned\|fo_logout\|fo_rejected\|storage_unavailable, revoked, revokeMs`; `fo_logout` and `fo_rejected` are emitted by the gateway where it clears the cookie after FO's own sign-out or an FO 401 on an injected call (FO-authoritative ends, `revoked: n/a`; WHOLE-R13) | RP2 lifecycle; m3 |
| `ownership_lookup`, `ownership_refused`, `ownership_unavailable` | `conversationIdPrefix, outcome, foStatus, elapsedMs, bytes` | RP6 |
| `body_refused` | `owner, stage: declared\|measured\|admission, bytes, limit` | RP1 G2; RP10-B admission cap |
| `csp_report` | `blockedUri (path only), violatedDirective, documentUri (path only)` | RP7 trial |
| `security` | `kind: cross_site\|marker_forged\|middleware_bypass_header\|forged_xff\|untrusted_ingress\|host_mismatch\|malformed_edge_id, pathPattern` | RP1, RP3, RP7, RP10-B boundary attempts |
| `sw_kill_served`, `startup_assertion_failed` | `buildId, check` | RP9; RP10-B |
| `gauges` (heartbeat every 15 s per process; review RP10A-R15) | `activeStreams, inFlightUpstream, storeLatencyP95Ms` | levels a log stream cannot reconstruct: L1 capacity, draining, RP3 store health; destination and cadence are RP10-B's |

#### 4. Metrics (derived from the events and the `gauges` heartbeat until CP5 names a platform)
Login attempts, failures, throttles by dimension, store latency and errors (RP3); gateway and FO latency p50/p95/p99 by owner and class (RP4); timeout rate by class and reason, cancellation rate and the cancel-after-silence offset distribution (RP4); active streams and in-flight upstream (gauges), stream end reasons, keep-alive max gap (RP4, RP10-B); body refusals by stage; 4xx and 5xx by code (RP5); ownership refusals by `foStatus`; session ends by reason, failed revokes (RP2); CSP violations by directive (RP7); kill switch served, startup assertion failures, mode distribution (RP9, RP10-B, RP8).

#### 5. Test layers (reviews RP10A-R6, R7, R8, R11)

| Layer | Harness | Proves |
|---|---|---|
| Unit | `node:test` via `tsx` | RP3 limiter arithmetic and compensation, RP2 token ring, RP1 classify and body maths, RP6 cache keys, RP5 table |
| Route (integration) | `__tests__/harness/route.ts`: handlers invoked directly with a scripted **in-process** stub FO (`fetch` replaced; modes: each status, malformed, slow, hang, signal-honouring), injectable clocks, a fixed `requestId`; runs with a small `--import` loader that resolves the bare specifier `server-only` to an empty module (the only exemption), because `server-only`'s default export throws on import outside a bundler | RP3 flows, RP2 login and logout, RP4 classes, RP5 injection and presentation-by-kind, RP6 outcomes, RP7 route-level headers |
| Component interaction | a deferred-resolution `fetch` stub (per-URL promises the test resolves in a chosen order, so B1's load-versus-selection race goes red deterministically; review RP8-R17), `node:test` + `jsdom` global set up in a harness preamble (one runner; a divergence from the product's Jest + RTL, recorded), `@testing-library/react` ≥ 16 and `@testing-library/dom`, `globalThis.IS_REACT_ACT_ENVIRONMENT = true`, and a `withAppRouter({pathname, searchParams, router})` wrapper providing `AppRouterContext`, `PathnameContext` and `SearchParamsContext` with a spy router, so components using `next/navigation` mount; never imports a guarded module; **its first test is RP8's B1 reproduction** | RP8's B1 containment; the PWA's own screens |
| Real Next runtime | `__tests__/harness/server.ts`: `startServer({env}) → {origin, stop}` runs `next build` once per job (cached by lockfile hash) then `next start` on a free port, against an **out-of-process** stub FO: a `node:http` listener on `127.0.0.1` (the one plain-http shape `client.ts` accepts) with socket-level modes (`res.socket.destroy()` for drop-after-headers, trickle, hang) | RP1 body ceiling and buffering; middleware redirects and their headers, header precedence (RP7 G33); `req.signal` in all three phases (RP4); the worker route in both modes (RP9, with Playwright); the once-per-process `startup` event; `x-request-id` replacement on a PWA route |
| Staging FO (preview, read-only) | `scripts/*-live-check.mjs` | route inventory, per-id ownership statuses, token length, keep-alive gap, p99 turn, `set-cookie` behaviour, the CloudFront `Miss` on the probe target, the wire `cache-control` on a gateway API response |
| Concurrency | route harness with `Promise.all` and a slow stub | RP3 race and compensation, RP6 concurrent misses, RP4 timer leaks |
| Load | RP10-B L1–L5 | capacity, memory (declared and chunked bodies), multi-instance |
| Failure simulation | stub modes plus store-down, edge-timeout emulation, SIGTERM during a stream | RP4, RP3 store, RP6, RP9, RP10-B draining |
| Device | RP10-B's installed-phone rehearsal (one iOS, one Android) | RP9's five lifecycle cases; RP8's shortcut rollback |

**Node versions:** every suite runs on the production Node major taken from the digest-pinned image's `FROM` line (one source of truth); a second, cheap job runs the unit and route suites on the declared minimum, or `engines` is raised to match the image (m18's cell says which).

#### 6. Build guards and CI (G28, m16, m17, m18, N1, N7; reviews RP10A-R9, R12, R14)
- **`server-only`** in every credential-holding module; its real enforcement is the bundler (`next build` fails on a client import); the runtime throw is proven by a test that imports a guarded module under a browser-like condition.
- **Lint (m17):** `react-hooks/set-state-in-effect` **re-enabled**; any remaining hit is fixed or carries a per-line disable with a reason naming the file's real pattern; `no-unused-vars` at error; the `lint` script gains `--max-warnings 0`; a test asserts the config contains no file-level `off` for that rule.
- **Guards, defined:** the **no-orphan import-graph test**: roots are Next's convention files under `app/**` (`page`, `layout`, `route`, `template`, `default`, `error`, `not-found`, `loading`), `proxy.ts`, `next.config.ts`, `instrumentation.ts` and `scripts/*`; walked with TypeScript's `createProgram` (`@/` via `paths`, `resolveJsonModule`) plus a CSS `@import` pass; compared with the git-tracked `.ts/.tsx/.css` set; `__tests__` and `design-review` are not roots (a file only tests reach is an orphan); an explicit allow-list with a reason and a removal date per entry. The **`public/` shadowing guard**: every path under `public/` is matched against the static route paths derived from `app/**/route.ts` and `page.tsx` plus the literal prefix of any catch-all, **and against the `whole`-mode registry's non-`pwa` prefixes** (a `public/` file under an FO-owned prefix is shadowed by the registry, not by a route; review RP10A-R21); a match fails before `next build`. Both guards run before `next build`. A **CSP policy guard** (the FO-document policy string contains no `'nonce-` or `'sha`, RP7) and a **dependency guard** that flags `zxing-wasm` and any other unused production dependency (RP7).
- **CI job on every change**, platform per §9 question 33: `npm ci`; the guards; `npm audit --omit=dev` at the CP5 threshold (temporary default high and critical); lint; typecheck; unit, route and component suites; `next build`; `playwright install --with-deps chromium webkit`; the real-server suite; the **release-blocker set** (RP7 G26 invariant; RP1 marker-forgery and G31; RP2 combined expiry; RP3 tests 1–3, 7, 16, 17; RP6 not-owned-never-reaches-FO; RP9 Rule 1; RP5 injection table; RP7 header precedence; RP10-A value-level redaction and id replacement on a PWA route); Dependabot or Renovate at the CP5 cadence; the base image digest-pinned. **Platform:** this repository is its own GitHub repository, so GitHub Actions with Dependabot is the recommended default; whether the current personal-account repository is the sanctioned home for release evidence, or the repository moves to an organisation-owned GitHub first, is **§9 question 60** (CP5).
- **Release evidence before production:** the CI run green on the release commit; the read-only live checks green on preview; the L1–L5 results; the rehearsal records; the CP5 readiness checklist signed.

#### 7. Finding map
M18 → the id on every path, explicit `ctx` propagation, the event catalogue, value-level redaction (tests: every line from a request carries the PWA's id, including a PWA route hit with `x-request-id: attacker` and one with no inbound header; a swallowed error emits `warn` with `errorName`/`errorCode` only; the value-level redaction test passes). M17 → the harness layers with their mechanics; the mutation check (`proveOwnership`'s proof predicate changed to "any 2xx proves" or "200 with a mismatched id proves" fails a test; retargeted from `owns.ts`, which the gateway stops using; review RP6-R14); deletion of every source-text assertion listed above. m16 → `server-only` with the loader exemption and the build-time proof. m17 → the lint corrections with their CI check. m18 → Node versions as stated. N1, N7 → deletions and the version fix with a CI check each. G28 → the CI job (a vulnerable production dependency fails it; a dev dependency does not; lockfile drift fails `npm ci`).

**Acceptance criteria.** One request followed phone → PWA → FO by the PWA's id on every route; the value-level redaction test passes; zero source-text assertions for behaviour; the mutation check fails as designed; the CI job runs on every change on the named platform with the release-blocker set; the two guards fail a deliberately broken tree; the component layer mounts `agent-chat-client.tsx` and reproduces B1.

**Dependencies.** Consumed by every RP; RP1 (`x-request-id` in the outbound allow-list, safe only because `proxy.ts` replaces it on every path; the wording delta applied); RP4 (`fetchFo(path, init, cls, ctx)`); RP5 (canonical body rule for the response-side leak); RP8 (B1 harness; `startup` and `route` events for the gate); RP9 (the shadowing guard); RP10-B (platforms, `buildId`/`instanceId`, the `gauges` destination, edge id confirmation).

**Open decisions.** CP5: §9 question 33 (log and metrics platform; CI platform, with GitHub Actions the recommended default now that the premise is corrected); **§9 question 60** (the sanctioned repository home for CI and release evidence); the audit threshold and cadence.

**Review record.** Round 1 (28 September 2026): 1 BLOCKING (R1: the id was minted only on the gateway branch; closed by minting on every `proxy()` return), 13 FIX NOW (R2 explicit `ctx` propagation; R3 value-level redaction; R4 path patterns and id prefixes; R5 `edgeRequestId` as untrusted; R6 `server-only` versus the test runner; R7 the component layer's mechanics; R8 Node versions; R9 the CI premise was stale, the repository is its own GitHub remote, new §9 question 60; R10 `instrumentation.ts`; R11 out-of-process stub, `next build` and browsers in CI; R12 the two guards defined; R13 `sessionFp` is base64url, RP3 has 18 tests, the test count; R14 the lint rule re-enabled), 2 DEFER (R15 the `gauges` heartbeat, owner RP10-B, applied here and there; R16 the response-side host leak, owner RP5 part 2, recorded). . Verdict **`SAFE TO FREEZE`** (the four items were wording with the text supplied).

---
### RP10-B — Deployment, capacity and documentation readiness

> **Status (revision 3.11).** Design-review depth. First independent review: 2 BLOCKING, 10 FIX NOW, 3 DEFER; all BLOCKING and FIX NOW applied below; second round run and applied (two-round cap reached). The topology is **PROPOSED**, not decided; every AWS behaviour it relies on is INFERRED from documentation and listed for deployment confirmation. **Not frozen.**

**Purpose.** Prove the finished system runs at the target scale under the target topology; that its trust, body, timeout and shared-state assumptions hold on that topology with more than one instance and *during* a deployment; that it can be rolled back in a rehearsed way at a known latency; and that its documentation describes code that exists.

**Included findings.** N3, N8, G6, G27, G29.

**Current architecture** ([code]). Fly: one 512 MB machine per app, no concurrency block, no deploy strategy, `force_https = true`; preview runs `whole` with the UI split; a standalone Next image; per-process limiter, ownership cache and anonymous cap; `SESSION_SIGNING_SECRET` a Fly secret; `isHttps` takes the **first** comma-separated `x-forwarded-proto` value (`session.ts:77-81`); `proxy.ts` builds absolute redirects from `req.nextUrl`, i.e. from the inbound `Host`; Next's standalone server sets only `keepAliveTimeout`, from `KEEP_ALIVE_TIMEOUT`; Next drains on `SIGTERM` by waiting for pending requests. Stale documentation: `fly.toml` cites `app/__fo/` and `lib/decisions.ts` (neither exists), `fly.preview.toml` says the gateway streams bodies (RP1 now buffers), `Dockerfile:1` and `package.json` still say demo.

#### 1. Proposed production topology, checked against the earlier RPs

**PROPOSED (CP5):** phone → CloudFront → ALB → ECS Fargate service (2+ tasks) → FO. ElastiCache Redis (RP3 store), Secrets Manager (key rings), CloudWatch (logs, metrics). Region **co-located with FO's origin (us-west-2)**, for the latency reason `fly.preview.toml` records (review RP10B-R14).

| Aspect | Design | Consistent with |
|---|---|---|
| **CloudFront behaviours** (review RP10B-R1, BLOCKING) | For every path except `fo-static` (`/_next/*`, `/logos/*`, `/pwa-assets/*`): the managed `CachingDisabled` policy (all TTLs 0) and the `AllViewer` origin request policy (all headers including `Authorization` and `Cookie`, all cookies, all query strings); **all seven methods allowed**; **compression off** (an SSE body must not be re-encoded). `fo-static` may cache with the query string in the key. PWA-owned unversioned files (`/icon-192.png`, `/manifest.webmanifest`, `/sw.js`, `/offline`) must honour origin `Cache-Control` (min TTL 0) and forward the query string, so RP9's reachability probe is never answered from the edge (review RP9-R8). **Smoke test from outside CloudFront:** `curl -I http://<edge>/login` answers 301 or 308 to https and the ALB has no port-80 listener (delta review RP1-D14); two authenticated `GET /api/pwa/auth/me` with different sessions return different bodies with `x-cache: Miss`, and the same through the gateway for FO's `/api/auth/me` with the bearer; a login POST reaches the PWA; the probe URL returns `Miss`; `Authorization` reaching the origin under `CachingDisabled` + `AllViewer` is confirmed on the real distribution (§9 question 48; review RP10B-R24) | RP1 (methods), RP2 (cookie and bearer reach the origin), RP7 (`no-store` is not enough alone), RP9 |
| **TLS** (review RP10B-R12) | CloudFront viewer protocol policy **redirect HTTP to HTTPS** on every behaviour (Fly's `force_https` equivalent); origin protocol policy **HTTPS only** to the ALB; ALB listener on 443 only; the container speaks plain HTTP inside the VPC. `isHttps` reads the request scheme from the per-source rule in RP1 part 4: **on AWS, as on Fly, the scheme is `https` by configuration** (`EDGE_SCHEME=https`, required whenever `CLIENT_IDENTITY_SOURCE` is `xff` or `cloudfront-viewer`, asserted at startup), because CloudFront writes no `x-forwarded-proto` (its header is `CloudFront-Forwarded-Proto`, present only when an origin request policy includes it) and the ALB's `x-forwarded-proto` describes the CloudFront→ALB leg, so no trusted position exists in that header on this topology; `x-forwarded-proto` is never read at any position (review RP10B-R16; RP1 delta); `req.nextUrl.protocol` with no identity source configured. Test: `CLIENT_IDENTITY_SOURCE=xff`, `EDGE_SCHEME=https`, no `x-forwarded-proto` → the login cookie is `Secure`; with a client-supplied `x-forwarded-proto: http` it is still `Secure`. `skipProxyUrlNormalize` stays unset so `proxy.ts`'s redirects are emitted origin-relative; because it is a build-time define, its absence is asserted by an RP10-A build guard (a test importing `next.config.ts`), not by a startup assertion (review RP10B-R20). Smoke test: a login through CloudFront returns `Set-Cookie … Secure; HttpOnly` | RP1 part 4, RP2 |
| **Ingress restricted to the edge** (reviews RP10B-R3, RP3-R2) | The ALB's security group admits only the AWS-managed CloudFront origin-facing prefix list, **and** CloudFront adds a secret custom origin header that an ALB listener rule requires (rotated with the key-ring runbook). Smoke test: a direct request to the ALB's DNS name is refused. This is what makes `TRUSTED_PROXY_HOPS=2` and RP3's `untrusted_ingress` rule sound | RP1 part 4, RP3 part 3 |
| **Trusted client identity** | `TRUSTED_PROXY_HOPS=2` (CloudFront then ALB append to `x-forwarded-for`), **chosen at deploy time**; `CloudFront-Viewer-Address` only when the origin request policy is known to include it and it is configured as the source, **never auto-detected "when present"**; a chain shorter than the hop count is `untrusted_ingress` (RP3). RP1 post-freeze delta test: a request carrying `CloudFront-Viewer-Address` while the configured source is XFF yields the XFF value | RP1 part 4, RP3 |
| **Forwarded-header policy and redirects** (review RP10B-R4) | Inbound: only the edge-written headers are trusted (`x-forwarded-for` at the trusted position (the scheme is `https` by configuration and `x-forwarded-proto` is never read, RP1 part 4), the edge request id); **`Host` is not trusted for anything**: every redirect `proxy.ts` issues is built on the request's own origin and emitted origin-relative by Next's adapter (RP1 part 1, delta review), so neither the inbound `Host` nor a configured origin can send the phone elsewhere, and a pilot deployment (staged rollout row) cannot bounce its users to production by a stale `PUBLIC_ORIGIN`; `PUBLIC_ORIGIN` is used only by RP3's same-origin gate; CloudFront need not forward the viewer `Host`. Outbound to FO: RP1's allow-list plus `x-forwarded-for`, `x-forwarded-proto`, `user-agent`, `x-request-id` | RP1, RP3 part 5, RP8 redirects, RP10-A |
| **Request bodies: pre-buffer controls and the admission cap** (reviews RP10B-R5, R17, WHOLE-R1) | CloudFront and the ALB impose no body cap below RP1's 25 MiB ceiling for a custom origin **[REQUIRES deployment confirmation, §9 question 48]**; API Gateway and Lambda are excluded. **Next buffers the whole upload before `proxy.ts` can answer** (verified, `next-server.js:1226-1243`), so the application's only pre-buffer control is a **thin Node entry** (`server.mjs`, replacing the standalone `server.js` as the container command): it wraps Next's request handler and, before handing a request to Next, refuses by declared `content-length` and path class (`/api/pwa/auth/*` above 16 KiB; anything above the ceiling; a body on a method with no body) and counts in-flight body-carrying requests against **`N_bodies`**, answering `503 busy` + `Retry-After` or the coded 413 with the canonical body; it releases the count on the response's `close` event, so no claim/sweep protocol is needed; it also makes Node's `headersTimeout` and `requestTimeout` settable (RP4 part 5). **Its duties, specified (delta review RP1/RP10-B-D15):** it creates its own `http.createServer` whose listener runs the pre-checks and then delegates to `next({dir, hostname, port, conf: <the build's embedded standalone config>, httpServer}).getRequestHandler()`, so config `headers()`, `proxyClientMaxBodySize` and every other build setting keep their values (a startup assertion checks the effective ceiling equals `PWA_BODY_CEILING_BYTES`); it sets `keepAliveTimeout` (`KEEP_ALIVE_TIMEOUT`), `headersTimeout` and `requestTimeout` from named inputs; it **owns `SIGTERM`**: `server.close()`, then `await app.close()` (which lets pending `after()` revokes finish), then exit, with RP4's shutdown listener unchanged; it sends refusals with `Connection: close` and destroys the socket once the response has flushed, so an unread upload is not consumed on a keep-alive socket. Tests under `server.mjs`: config `headers()` and the 25 MiB ceiling are observable; `SIGTERM` with a pending `after()` revoke still delivers it to the stub; the wire keep-alive timeout equals `KEEP_ALIVE_TIMEOUT`; a refused declared upload closes the connection. **At the edge**, a rate rule on body-carrying methods per client IP (WAF, if adopted, §9 question 67; otherwise CloudFront-level limits) bounds how many uploads one source can hold open; chunked bodies without a declared length are bounded only by the ceiling and the edge rule, so **task memory is sized for an attacker's connection count**, measured by L2 with declared and chunked bodies at about ceiling × 2 per body until the probe confirms the clone's cost. The earlier design (admission in `proxy.ts` with a claim/sweep registry, revisions 3.10 and 3.11) is superseded: `proxy.ts` cannot refuse before buffering. The gateway's buffered copy is bounded by the policy per request; there is no separate gateway semaphore | RP1 part 3, RP3, RP4, RP5 (`busy`) |
| **WAF, if enabled** (review RP10B-R11) | `SizeRestrictions_BODY` set to Count or excluded on gateway behaviours; every body-inspecting rule with oversize handling `CONTINUE`; rate-based rules sized above the largest office behind one NAT (RP3's `C_src` reasoning); WAF logs into the same CloudWatch group with the request id; L2 runs the maximum body through the WAF-enabled path | RP1 part 3, RP5 |
| **Streaming** | End-to-end SSE with no buffering (CloudFront passes uncached streamed responses; the ALB streams; `x-accel-buffering: no`, `no-transform`, compression off). **Confirm on the real distribution** that an origin-side abort mid-body reaches the phone as an abort, not a clean truncation (RP5 part 6; §9 question 48) | RP4, RP5 |
| **Timeouts, one rule** (review RP10B-R7) | `E = min(CloudFront origin response timeout, ALB idle timeout)`; every `T_*` that bounds a wait on FO, except `T_life_stream`, `< E − margin` (Node's inbound defaults excluded, RP4 part 5); `T_life_stream` bounded only by the app; **`KEEP_ALIVE_TIMEOUT` (Node) > ALB idle timeout**, or the ALB reuses connections Node closed and 502s appear; `stopTimeout` and the ALB deregistration delay per the draining row. §9 question 48's recommendation (CloudFront 60 s, ALB ≥ 120 s) gives `E = 60 s`. All checked by the startup assertion | RP4 part 5 |
| **Draining** (reviews RP10B-R8, R18, WHOLE-R11: the ALB's behaviour for in-flight requests when the deregistration delay expires is §9 question 48; the deploy-during-stream rehearsal runs on the ECS pilot, not Fly; the deregistration delay is set ≥ `T_life_stream` or the cut is accepted and recorded) | The sequence and the actor: stop request → target deregistration → deregistration delay (no new requests; open streams continue; a stream can therefore live deregistration delay + `stopTimeout` from the stop request) → `SIGTERM` → the Node entry's `server.close()` then `app.close()` (no new connections; it never touches an open stream; pending `after()` revokes finish) → **an application `SIGTERM` listener** (allowed beside Next's; `NEXT_MANUAL_SIG_HANDLE` stays unset) arms a timer at `stopTimeout − margin` that **errors every open stream** (`controller.error`, reason `shutdown`) and logs `stream_end` → Next exits → `SIGKILL` at `stopTimeout` only if something is still stuck (unlogged; the rehearsal counts it as a defect). Fargate `stopTimeout` = 120 s (the maximum), ALB deregistration delay ≥ 120 s, `margin ≥` the log flush time; assertion `T_revoke < stopTimeout − margin`; scale-in cooldown long enough that the stream gauge does not flap; deploys and rollbacks scheduled outside peak use. Test (real-server harness): a stream open, `SIGTERM` → the client read rejects at `stopTimeout − margin` and `stream_end {reason:"shutdown"}` is logged before exit. Rehearsal: one deploy during an active 3-minute stream on preview and what the phone saw | RP4, RP5, RP10-A |
| **Multi-instance sessions and key rotation** (review RP10B-R6) | Stateless: every task holds the same key ring from Secrets Manager. RP2's invariant "every instance carries the same keys" must hold **at every instant, including during a rolling update**, or a bearer minted by a new task is `session_invalid` on an old one and RP2's refusal revokes the FO session. **Rotation is therefore two deployments**: (1) add K2 to `SESSION_SIGNING_PREVIOUS_KEYS` everywhere and wait for the rollout; (2) promote K2 to current with K1 previous; (3) **one absolute TTL after step (2)'s rollout reports complete** (every task on the new revision; old tasks sign with K1 until then), remove K1 (review RP10B-R22). Rehearsal: rotate on preview with a signed-in phone, note the rollout completion time, remove K1 no earlier than one TTL after it, and confirm no `session_invalid`. `LOGIN_PROTECTION_SECRET` (RP3) is a separate secret whose rotation is a deliberate counter reset | RP2 parts 5 and 6, RP3 |
| **Shared rate-limit store** | ElastiCache Redis; RP3's `SharedCounterStore` with single-key Lua scripts; TLS in transit and auth token; RP1's anonymous cap moves onto it in RP3 stage 9; **a store outage degrades login only** (RP3 part 6) | RP3 |
| **Startup assertions, liveness, dependency status** (review RP10B-R2, BLOCKING) | Three things, each with its consumer named. **(1) Startup assertions** (the process refuses to start; the ECS deployment circuit breaker rolls the deployment back): `PUBLIC_ORIGIN` valid; identity source configured; `FABORCH_BASE_URL` https; key ring present with a ≥ 32-char secret and a non-empty key id; `LOGIN_PROTECTION_SECRET` present; ceiling > policy; every `T_*` inside the recorded `E`, `KEEP_ALIVE_TIMEOUT > ALB idle` and `T_revoke < stopTimeout − margin`, **all read from named inputs set by the same task definition that sets the platform values** (`EDGE_RESPONSE_TIMEOUT_MS`, `ALB_IDLE_TIMEOUT_MS`, `STOP_TIMEOUT_MS`), so IaC and the app cannot drift (review RP10B-R20); `EDGE_SCHEME=https` when the identity source is AWS; RP1's G18 assertion (`FO_UI_BASE_URL` without `FO_UI_SPLIT_ALLOWED=1` refuses); after RP8's deletion, `FO_EMBED_MODE === "whole"`. Never checked by a health check. **(2) Liveness** `GET /api/pwa/health` (review RP10B-R21): GET and HEAD only, no auth, **exempt from the identity, ingress and cap rules** (ALB health checks bypass listener rules, so the origin header and any `x-forwarded-for` are absent; applying `untrusted_ingress` here would mark every target unhealthy at once), `Cache-Control: no-store`, a constant JSON answered within a bound; the ALB target health check and the ECS container health check (the container check uses busybox `wget -qO- http://127.0.0.1:3000/api/pwa/health`, since the runner image has no `curl`). Test: with `CLIENT_IDENTITY_SOURCE=xff` and a request carrying only `Host`, `/api/pwa/health` is 200 while `/api/pwa/auth/login` is 403 `untrusted_ingress`. **(3) Dependency status** `GET /api/pwa/ready`: shared store, FO reachability, mode, as JSON for operators and CloudWatch alarms, **never a health check**, so a Redis outage never triggers ECS's replacement loop | RP1–RP4, RP8, RP9 |
| **Deployment strategy** | ECS rolling update (minimum healthy 100%, maximum 200%) with the deployment circuit breaker and automatic rollback; liveness gates traffic; on Fly preview the default rolling deploy | RP10-A CI evidence |
| **Staged rollout** (review RP10B-R10; §9 question 55) | (1) preview (Fly) on production FO with the test account; (2) a **pilot deployment** with the same image and a configuration identical except `PUBLIC_ORIGIN`, the hostname-bound values and its own key ring; **the pilot origin is disposable**: the worker scope, manifest identity, cookies and bearer are per origin, so pilot users reinstall from the main hostname at step 3, and step 2 proves the gateway, sessions and load on production FO, not installed-app continuity; whether the pilot **shares production's Redis and `LOGIN_PROTECTION_SECRET`** (one set of login counters for the same accounts; L3 and L5 measured on the real store; recommended) or runs its own is part of §9 question 55 (review RP10B-R26); (3) the main hostname flips the flag. That cost is the argument for a global flip with a short soak if a per-user pilot is not needed | RP3, RP7, RP8, RP9 |
| **Rollback levers, with their real latency** (review RP10B-R9; §9 question 59) | In order of blast radius: `FO_EMBED_MODE=off` (**soak period only**: after RP8's deletion commit this lever no longer exists, the startup assertion refuses any other mode, and the deletion checklist replaces the runbook entry with image rollback; review RP10B-R19) (on ECS a task-definition revision and a rolling update: **minutes**, gated by liveness; on Fly a redeploy; **seconds only if a runtime flag source is designed**: SSM Parameter Store or AppConfig polled by the app, with a poll interval and last-known-value failure semantics, a human decision); RP9's `SW_KILL=1` (same mechanism); ECS image rollback to the previous task definition; signing-key rotation with the previous key removed (signs everyone out; last resort). The rehearsal records two numbers, Fly preview and the ECS pilot, and the CP5 restoration limit is set against the ECS number. Installed shortcuts created from FO pages are part of the rehearsal (RP8) | RP8, RP9, RP2 |
| **Mixed-version `/sw.js` during a deploy** (review RP9-R15) | During a rolling update tasks on two builds serve different `/sw.js` bytes; consecutive update checks can alternate. Bound: the window is the rollout duration; the new template refuses to install over a worker whose build id is newer than its own; the device rehearsal records what an installed phone saw during one deploy | RP9 |
| **Service-worker rollback interaction** | An image rollback ships the previous worker as an update that waits (RP9 part 3); `SW_KILL=1` first if it must take over at once; both in the runbook | RP9 |
| **Logging and metrics destination** | Structured JSON to stdout → CloudWatch Logs (or the CP5 platform); metrics derived from RP10-A's events and its 15-second `gauges` heartbeat (active streams, in-flight upstream, store latency), or CloudWatch EMF fields; alerts on RP3 throttle spikes, store unavailability, timeout rate, 5xx rate, startup assertion failures, cancel-after-silence offsets **[values: CP5]** | RP10-A |
| **Concurrency limits** | Per task: `N_bodies` in the thin Node entry (declared-length bodies, released on response close) and `N_streams` in RP4's `stream-slots.ts` (acquired after the ownership proof, released in the lifecycle's terminal callback), both from L1/L2; ECS auto-scaling on the stream gauge and CPU with a scale-in cooldown, floor 2 tasks (WHOLE-R1, R5) | RP4, RP1, RP5 |
| **Egress to FO** (review RP10B-R14) | Fargate egress through NAT gateway addresses, one per AZ: FO's edge sees one or two IPs for the whole user base; L4 and §9 question 22 decide whether FO's edge throttles that; a NAT with several addresses or an allow-list at FO's edge are the remedies | RP1 part 4 (FO's application sees the forwarded identity, its edge does not) |

#### 2. Load-test matrix
L1 concurrent 60–120 s streams (sockets, memory, edge behaviour, `stream_end` reasons, the abort-propagation check); L2 concurrent maximum-size bodies, **declared and chunked**, with and without WAF (memory per body; confirms or revises RP1's 20/25 MiB; sizes `N_bodies` and the task); L3 a login burst from few and many sources (RP3 limiter, store latency, FO's response); L4 FO's own limits under PWA-originated traffic from the NAT addresses (§9 question 22); L5 two tasks (shared limiter consistency, ownership cache misses and per-id lookup cost at p95 on a real long thread, sessions across tasks, a rolling key rotation with a signed-in phone). Targets from CP5; no user-count claim before L1–L5 run on the environment §9 question 34 permits.

#### 3. Documentation truth (G6, N3, N8; review RP10B-R15)
The CI test: every backtick-quoted token matching `^(app|lib|components|scripts|public|docs|__tests__)/[\w\-\[\]./]+$` in `fly*.toml`, `README.md`, `CLAUDE.md`, `Dockerfile` and `*.ts(x)` comments must exist on disk. Known stale **claims** (not paths), hand-edited in the same commit: `fly.toml`'s `app/__fo/` and "WP1 does not authenticate"; `fly.toml`'s `lib/decisions.ts` justification for `--ha=false` (the real reason is per-process state until the shared store); `fly.preview.toml`'s "the gateway streams bodies"; `README.md`'s `--ha` reason; `Dockerfile:1` and `package.json`'s "demo"; `CLAUDE.md`'s heading.

#### 4. Response runbook (G29)
PWA-side levers with owners and **measured latencies**: embedding flag (mechanism per platform), `SW_KILL`, image rollback, two-deployment key rotation, `LOGIN_PROTECTION_SECRET` rotation (a counter reset), the origin-header secret rotation, the concurrency caps, where the request-id logs and metrics are, who to call at FabOrchestrator. The organisation's incident process and vulnerability intake are referenced (§9 question 42), not defined.

#### 5. Finding map
G27 → L1–L5 with recorded results and the caps they set (declared and chunked; draining measured). G29 → strategy with circuit breaker, staged rollout with the disposable pilot origin, rehearsed rollback with real latencies and installed shortcuts, the two-deployment rotation, the runbook. G6, N3, N8 → documentation truth with the defined test and the hand-edit list.

**Acceptance criteria.** L1–L5 at the CP5 targets meet the agreed thresholds; the startup assertions refuse each misconfiguration in their list (real-server harness); liveness and dependency status behave as specified under a simulated Redis outage (tasks stay in service, login degrades); the CloudFront smoke tests pass; the rehearsal records exist (rollback with installed shortcuts and both latencies, key rotation with a signed-in phone, a deploy during a stream, the kill switch, the five RP9 device cases); the runbook names an owner and a latency per lever; the documentation test passes; CP5 approved.

**Dependencies.** RP1 (ceilings, hops, the applied deltas: request-origin redirects emitted origin-relative, `CloudFront-Viewer-Address` rule, `x-request-id` allow-list); RP2 (keys at every instant; the `isHttps` delta); RP3 (store; `untrusted_ingress`; `LOGIN_PROTECTION_SECRET`); RP4 (`E`, draining, `KEEP_ALIVE_TIMEOUT`); RP5 (`busy`; the 408); RP7 (HSTS set at the app, CloudFront not adding a conflicting value; CP5 confirms); RP8 (staged rollout, installed-shortcut rehearsal, deletion after soak, the mode assertion); RP9 (kill switch, probe-target cache behaviour, device rehearsal); RP10-A (events, CI, edge id trust).

**Open decisions (all E unless marked).** Confirm topology A or name the alternative; instance count and task size; target users; ElastiCache; the edge timeout values and body behaviour (§9 question 48); the staged-rollout mechanism (§9 question 55, with the disposable-pilot cost); **seconds-scale flag rollback or minutes (§9 question 59, C/E)**; the log, metrics and CI platforms; audit threshold and cadence; alert thresholds; incident ownership; the cutover date; WAF yes or no; NAT egress design after L4.

**Review record.** Round 1 (27 September 2026): 2 BLOCKING (R1 CloudFront cache and origin request behaviour unspecified: default settings break the gateway, a non-zero minimum TTL leaks one user's API responses to another; R2 readiness mixing startup invariants with a runtime dependency would turn a Redis outage into ECS replacing every task), 10 FIX NOW (R3 edge-only ingress and no auto-detected identity source; R4 redirects from `PUBLIC_ORIGIN`; R5 the admission cap belongs in `proxy.ts` and cannot bound Next's buffer; R6 two-deployment key rotation; R7 one timeout rule plus `KEEP_ALIVE_TIMEOUT`; R8 draining; R9 real rollback latency; R10 the disposable pilot origin; R11 WAF body rules; R12 TLS row completeness and the `x-forwarded-proto` trust position), 3 DEFER (R13 `busy` in RP5's table, applied; R14 egress and region, applied; R15 the documentation test definition, applied). All applied above. Verdict was `NOT SAFE TO FREEZE`. **Round 2 (28 September 2026):** 0 BLOCKING, 8 FIX NOW (R16 no trusted `x-forwarded-proto` position exists on this topology, so `EDGE_SCHEME=https` by configuration, an RP1 delta; R17 the admission registry mechanism with release and sweep, an RP1 part 1 delta; R18 the draining sequence with an application `SIGTERM` listener; R19 the flag lever is soak-only; R20 `skipProxyUrlNormalize` as a build guard and named timeout inputs; R21 the liveness contract; R22 the rotation TTL runs from rollout completion; R23 the smoke path is `/api/pwa/auth/me`), 3 DEFER (R24 `Authorization` through CloudFront confirmed on the distribution, §9 question 48; R25 Node's inbound defaults recorded in RP4 part 5; R26 pilot store sharing, §9 question 55). All applied. **Two-round cap reached; shown to the human.**

---
## 8. Finding coverage matrix

**Columns:** **RP** = the primary owner (fault line F*n* = RP*n*). **Verified** = present in the current working tree ([code] unless noted). **Scope** = PROD / PREV / BOTH. **Fate** = under whole embedding, per `STATUS.md` §5 (proposed, not agreed). **Chetan** = the outcome in his follow-up (F fixed, P partial, H on hold, O open).

### 8.1 Review findings (50)

| ID | Sev | Finding | Verified (evidence) | Current files | RP | Deps | Scope | Fate | Chetan | Lesson from Chetan's attempt |
|---|---|---|---|---|---|---|---|---|---|---|
| B1 | Blocking | Question saved into a thread not on screen | Yes (`:109, :196`) | `app/fabinsight/agent-chat-client.tsx` | RP8 | RP0 (cutover date), RP10-A | PROD | Retires | P | Patching individual state transitions left a new stale path. Make the URL the single source of truth, and reproduce the defect before fixing it |
| B2 | Blocking | Any account resets the login throttle | Yes [code]+[test] (`rate-limit.test.ts:68`) | `login/route.ts:57-128`, `rate-limit.ts:120-122` | RP3 | RP0, RP1 | BOTH | Survives | F | Increment before the `await`. Per-account lockout enables targeted lockout and interacts with shared accounts |
| B3 | Blocking | Eight typos lock out a site | Yes [code]+[test] (`:61, :103`) | `login/route.ts:57-64`, `rate-limit.ts:85-101` | RP3 | RP0, RP1 | BOTH | Survives | F | Key separately by *what is attacked* and *who is attacking*. Still in memory (m1) |
| B4 | Blocking | No timeout on FO calls | Yes (`client.ts:535-548`) | `lib/faborch/client.ts` | RP4 | RP10-A, CP3 | BOTH | Survives | P | A headers-only deadline leaves body reads and streams unbounded. One policy can't serve both JSON and streams |
| B5 | Blocking | Unbounded body parsed before any check | Yes (`chat/route.ts:95`); bounded at 10 MB by Next [runtime] | `chat/route.ts`, `lib/validation.ts:139-154` | RP1 | RP0 | PROD | Retires (the principle survives via G2) | P | A Content-Length check is bypassed by chunked bodies; and Next's own 10 MB limit is the real bound |
| M1 | Major | Retry sends the question twice | Yes (`agent-chat.tsx:534`, `conversation.ts:137`) | chat screen, reducer | RP8 | RP0 | PROD | Retires | F | Retry is a state transition (drop the failed exchange), not a re-send |
| M2 | Major | PWA 401/400/404 read as "temporary" | Yes (`auth-middleware.ts:55-57`) | auth middleware, chat route | RP5 | RP2 | BOTH | Partly | F | Every error needs a code; the client's fallback still masks uncoded replies |
| M3 | Major | Ownership proof downloads the whole list | Yes (`owns.ts:32-45`; gateway on cache miss) | `owns.ts`, chat route, `ownership.ts` | RP6 | RP1, RP0 (FO request) | BOTH | Partly | P | Moved the cost off the network, but silent unsaved turns remained. Close the feedback loop |
| M4 | Major | Three serial upstream calls | Yes (`chat/route.ts:110, 133, 137`) | chat route | RP4 | RP0 | PROD | Retires | F | Caches trade freshness for speed; make the TTL an explicit decision |
| M5 | Major | FO responses cast, not validated | Yes (`client.ts:177, 206, 300`) | client, `reports/[id]` | RP4 | — | BOTH | Partly | P | Partial validation leaves casts. Validate every call at one boundary |
| M6 | Major | Copy-pasted error handling | Yes (conversations/reports routes, `chat/route.ts:225-226`) | `app/api/faborch/**` | RP5 | RP4, RP0 | PROD | Retires (principle → RP5) | F (contested) | The chat route kept its own copy. "One mapping" must be enforced by a test |
| M7 | Major | Model hardcoded | Yes (`client.ts:51`) | client | RP4 | RP0 | PROD | Retires | F | Let the authority (FO, by role) decide |
| M8 | Major | Long conversations hit a wall | Yes (`conversation.ts:272-273, 303`) | reducer, validation | RP8 | RP0 | PROD | Retires | H | This is a product policy, not code. It waited on a decision |
| M9 | Major | Every chunk re-renders everything | Yes (`agent-chat.tsx:650`, no memo) | chat screen | RP8 | RP0 | PROD | Retires | P | Memoisation without per-frame batching still re-parses the live answer |
| M10 | Major | Auto-scroll fights the reader | Yes (`:465`) | chat screen | RP8 | RP0 | PROD | Retires | F | Fixed, but with no "jump to latest" control |
| M11 | Major | 1,238-line component | Yes (1,238 lines) | `agent-chat.tsx` | RP8 | RP0, RP10-A | PROD | Retires | F | Moving code into a hook isn't the same as removing the mirror refs |
| M12 | Major | No security headers | Yes (`next.config.ts:125-135`) | `next.config.ts`, `proxy.ts` | RP7 | RP1 | BOTH | Survives | P | `headers()` doesn't cover middleware redirects; a CSP needs nonce plumbing |
| M13 | Major | Generated dashboards can exfiltrate data | Yes (`artifact-sheet.tsx:150`, `reports.tsx:283` without `enforceLightHtml`) | artifact sheet, reports | RP8 | RP0 | PROD | Retires (FO's own renderer is FO's concern) | P | Regex-injecting a CSP into HTML is fragile (it matched `<header>`), and navigation still leaks |
| M14 | Major | SW waits forever | Yes (`sw.js:86, 213`) | `public/sw.js` | RP9 | RP1 | BOTH | Survives | F | Budgets add up across retries (14 s worst case, not 8) |
| M15 | Major | SW trusts `navigator.onLine` | Yes (`sw.js:226, 126`) | `public/sw.js` | RP9 | — | BOTH | Survives | P | The fallback path still shows the wrong message when `/offline` isn't cached |
| M16 | Major | Chunk-reload guard latch | Yes (`layout.tsx:103-104`) | `app/layout.tsx` | RP9 | — | BOTH | Survives | F | The cooldown logic was duplicated rather than shared |
| M17 | Major | Tests check source text | Yes (`nav-drawer.test.ts:95`; no testing library) | `__tests__/` | RP10-A | — | BOTH | Survives | P | Test behaviour at route level with a stubbed upstream |
| M18 | Major | Failures vanish without a trace | Yes (11 calls in 8 files; swallowed paths) | client, owns, routes, gateway | RP10-A | — | BOTH | Survives | P | A request ID has to propagate end to end, not just on the chat route |
| m1 | Minor | Limiter in memory; XFF forgeable | Yes (`rate-limit.ts:58, 70-76`) | `lib/rate-limit.ts` | RP3 | RP1 (client identity), RP10-B | BOTH | Survives | P | An interface with no second implementation isn't multi-instance support |
| m2 | Minor | Single-key session token | Yes (`auth.ts:80`) | `lib/auth.ts` | RP2 | CP2 | BOTH | Survives | P | Rotation that isn't documented can't be used |
| m3 | Minor | Sessions not cleaned up | Yes (`use-session.ts:100-103`, `login-page.tsx:99-116`) | session hook, login page | RP2 | CP2 | BOTH (preview mitigated by `fo-shell.js`) | Survives | P | List *every* expiry-detection site; Chetan missed the login page |
| m4 | Minor | Upstream address leaks | Yes (`client.ts:543-545`, `login/route.ts:96-101`) | client, login | RP5 | — | BOTH | Survives | F | Keep configuration errors in a separate class |
| m5 | Minor | Login accepts cross-site posts | Yes (`login/route.ts:66`) | login route | RP3 | RP1 (`proto`) | BOTH | Survives | F | A missing Origin was treated as same-site, and the 403 was untested |
| m6 | Minor | No paging on conversations | Yes (`client.ts:364-375`) | client, conversations route | RP8 | FO API, RP0 | PROD | Retires | P | Blocked upstream; FO has no paging API |
| m7 | Minor | Follow-ups carry less context | Yes (`history.ts:75`) | history | RP8 | RP0 | PROD | Retires | H | Waiting on the same policy as M8 |
| m8 | Minor | Session re-fetched per screen | Yes (`use-session.ts:95`) | session hook | RP8 | RP0 | PROD | Mostly retires | O | Blocked by design: the token is in localStorage, which the server can't read |
| m9 | Minor | Client plumbing copy-pasted | Yes (token literal in 9 files) | screens, drawer | RP8 | RP0 | PROD | Retires | P | Only the key was centralised, not the fetch/cancel/error pattern |
| m10 | Minor | Start page ships the chat stack | Yes (`landing-ask.tsx:74`) | landing | RP8 | RP0 | PROD | Retires | P | Link prefetching still pulled in the chunk |
| m11 | Minor | No error boundaries | Yes (no `app/error.tsx` etc.) | `app/` | RP5 | — | BOTH | Survives (PWA pages) | F | Added boundaries; still no `loading.tsx` |
| m12 | Minor | Dialogs don't manage focus | Yes (`artifact-sheet.tsx:52-69`) | sheet, drawer | RP8 | RP0 | PROD | Retires | P | Focus escapes through the sandboxed iframe |
| m13 | Minor | Second agent list; invented numbers | Yes (`landing.tsx:324-325`) | landing | RP8 | RP0 | PROD | Retires | P | The figures were kept by instruction; this is a product decision |
| m14 | Minor | Offline page styles not cached | Yes (`sw.js:53, 56`) | SW, offline page | RP9 | — | BOTH | Survives | F | Inline styles, pinned by a test |
| m15 | Minor | Installs never learn of updates | Yes (`register-sw.tsx:16`) | register-sw | RP9 | — | BOTH | Survives | F | Checked on visibility change only; an update found before mount can be missed |
| m16 | Minor | Server modules not guarded | Yes (`server-only` absent) | client, lint | RP10-A | — | BOTH | Survives | P | A lint rule that nothing runs isn't a guard |
| m17 | Minor | Lint rules loosened | Yes (`eslint.config.mjs:31, 39`) | eslint config | RP10-A | — | BOTH | Survives | P | Justifications must match the code |
| m18 | Minor | Tests can't run on declared Node | Yes (`package.json:45`) | package.json, README | RP10-A | — | BOTH | Survives | P | Fix the README too; `engines` isn't enforced |
| m19 | Minor | History bucket hardcoded | Yes (`conversations/route.ts:51`) | conversations route, owns | RP8 | RP0 | PROD | Retires | P | A registry field that nothing reads per agent |
| N1 | Nit | Dead schemas | Yes (`validation.ts:16, 64`) | validation | RP10-A | — | BOTH | Survives (delete) | F | — |
| N2 | Nit | Screens describe removed features | Yes (`manifest:2`, `login-page.tsx:229, 242`) | manifest, login, offline, SW | RP9 | CP4 | BOTH | Survives | P | The manifest id is an identity decision, not a copy edit |
| N3 | Nit | Comments point at removed things | Yes (`login/route.ts:45-46`, …) | several | RP10-B | — | BOTH | Survives | P | Hand edits miss places; grep for the dead paths |
| N4 | Nit | Gradient repeated | Yes (10 copies) | screens | RP8 | RP0 | PROD | Retires | F | A new file reintroduced one copy |
| N5 | Nit | Sentences built in the state module | Yes (`conversation.ts:329`) | reducer | RP8 | RP0 | PROD | Retires | H | Goes with the M8 decision |
| N6 | Nit | Role label invented | Yes (`login/route.ts:21, 122`) | login, `/me`, top bar | RP8 | RP0 | PROD | Partly | F | A nullable role; the real role is still not fetched |
| N7 | Nit | tailwind-merge wrong major version | Yes (`package.json:26`) | package.json | RP10-A | — | BOTH | Survives | F | Merges weren't re-verified after the bump |
| N8 | Nit | Still named as a demo | Yes (`package.json:2`, `CLAUDE.md:1`) | package, CLAUDE.md | RP10-B | RP0 | BOTH | Survives | P | A dated note explains the staleness instead of removing it |

**Count:** Blocking 5, Major 18, Minor 19, Nit 8 — all 50 assigned.

| Package | Review findings owned |
|---|---|
| RP0 | 0 |
| RP1 | 1 |
| RP2 | 2 |
| RP3 | 4 |
| RP4 | 4 |
| RP5 | 4 |
| RP6 | 1 |
| RP7 | 1 |
| RP8 | 18 |
| RP9 | 6 |
| RP10-A | 7 |
| RP10-B | 2 |
| **Total** | **50** |

### 8.2 Verification findings (G1–G33; the gateway was not in the reviewed code; G28–G29 are readiness gaps; G30–G31 came from the RP2 and RP1 design passes; G32 and G33 from the RP7 design pass and its review)

| ID | Finding | Evidence | Files | RP | Scope |
|---|---|---|---|---|---|
| G1 | The gateway's upstream `fetch` has no deadline; its ownership path calls `fetchFo`, which has none either | [code] | `route.ts:119-125, 169`; `ownership.ts:207` | RP4 | PREV |
| G2 | Next truncates every body that passes `proxy.ts` at 10 MB. Through the gateway, a declared-length upload over 10 MB becomes a misleading 502; a chunked one reaches FO truncated. The 50 MB ceiling never takes effect | [runtime] (Next log; `fetch` probe); full path pending RP1 stage 2 | `proxy.ts:280`; `body-limit.ts:33`; `headers.ts:52`; `route.ts:170-173` | RP1 | BOTH (preview uploads most affected) |
| G3 | Ownership cache keys contain raw FO bearer tokens | [code] | `ownership.ts:134, 147` | RP6 | PREV |
| G4 | The audit client IP comes from the first `x-forwarded-for` entry, not the edge-set header | [code]; Fly's XFF behaviour [uncertain] | `route.ts:228-232` | RP1 | PREV |
| G5 | The gateway's refusal (bad or expired bearer) returns 401 without clearing the cookie; cleanup relies on `fo-shell.js` | [code] | `route.ts:86-91` | RP2 | PREV |
| G6 | Production config and docs are stale: the `fly.toml` embedding comment names `app/__fo/` and says "WP1 does not authenticate"; the `--ha=false` rationale cites the removed `lib/decisions.ts` | [code] | `fly.toml:55-66, 103-113` | RP10-B | BOTH |
| G7 | A cached "owned" answer lasts 30 minutes and can outlive FO soft-deleting the conversation | [code] + [FO-clone] (`deletedAt` filter); FO's resulting behaviour [uncertain] | `ownership.ts:105` | RP6 | PREV |
| G8 | Gateway-originated errors have no `code` and no shared envelope | [code] | `route.ts:90, 98, 141, 159, 172` | RP5 | PREV |
| G9 | The gateway's response allow-list drops any security headers FO sends and adds none; whether `next.config.ts` `headers()` applies to rewritten gateway responses is [uncertain] | [code] | `headers.ts:64-74` | RP7 | PREV |
| G10 | On the shared origin, the PWA bearer sits in FO's localStorage key, readable by every script on the origin; with the cookie attached automatically, an XSS in either app can act as the user | [code] (`login-page.tsx:24, 194`; [FO-clone] `providers.tsx:50`) | login page, auth bridge | RP2 | PREV |
| G11 | Documentation contradicts itself on direction (`docs/plan` Option B versus the embedding requirement and `STATUS` WP10); two WP numbering schemes; the embedding work is uncommitted | [code] + [team-record] | `docs/plan/*`, `docs/STATUS.md` | RP0 | BOTH |
| G12 | `whole` mode forwards any unreserved FO document by default (a policy that needs sign-off, not a bug) | [code] | `registry.ts:357-358` | RP1 | PREV |
| G13 | `fetchFo` forwards no client IP or user agent, so FO's audit attributes every production PWA session to the PWA server; any future per-IP throttle at FO would put every PWA user in one bucket | [code] (`client.ts:527-529`) | `lib/faborch/client.ts` | RP1 | PROD |
| G14 | No method allow-list: every owner class accepts GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS | [code] | `route.ts:238-244`; `registry.ts`, `proxy.ts` (method never read) | RP1 | PREV |
| G15 | The API allow-list forwards whole subtrees (`/api/user`, `/api/memory`, `/api/cmf`, `/api/modeling-agent/**`, `/api/fabinsight/warm`, `/api/fabinsight/render`) without a per-route review of exposure or cost | [code]; exposure needs FO input | `registry.ts:173` | RP1 | PREV |
| G16 | The Master Data Load agent is excluded from the PWA product (Jothi, 2 Sept), yet its API and page are forwarded and the 50 MB upload limit exists for it. **Decided 24 Sept: keep its routes available for now**; the body policy is sized for its `.xlsx` uploads | [code] + `STATUS.md:3286` | `registry.ts:69, 173`; `body-limit.ts:5-12` | RP1 | PREV |
| G17 | `Location` rewriting covers only the origin that request went to; with pages and API on different upstream origins, a redirect can leave the PWA origin | [code], [inferred] | `route.ts:175`; `headers.ts:101-106` | RP1 | PREV |
| G18 | The `FO_UI_BASE_URL` page/API split (plain HTTP on `.internal`) is a preview device for an unshipped FO UI change, not a production architecture | [code] | `upstream.ts:9-16, 41-69`; `fly.preview.toml:60` | RP1 | PREV |
| G19 | Preview uses production FO with real sessions, so it is a production-data system without a stated governance decision | [code] + [team-record] (the CloudFront host is production FO) | `fly.preview.toml:50` | RP0 | PREV |
| G20 | The PWA login ignores FO's forced-password-change state. FO signals it as a 403 `FORCE_PASSWORD_CHANGE` on every later authenticated call (not at login), and neither FO's client nor the PWA handles the code, so the user is stuck | [code] + [FO-clone] (`auth-middleware.ts:192-206`) | `client.ts:149-153`; `login/route.ts:117-126`; `registry.ts:70` | RP2 | BOTH |
| G21 | Sign-out awaits FO with no deadline before clearing the cookie, so it hangs when FO is slow | [code] | `logout/route.ts:42`; `client.ts:324-337` | RP4 | BOTH |
| G22 | No total request-lifetime cap: `maxDuration` is not enforced by `next start` | [Next-src] (only in build/adapter code) | `route.ts:64`; `chat/route.ts:59` | RP4 | BOTH |
| G23 | Error mapping is inconsistent: the gateway reports a network failure as 502 and `fetchFo` as 503; the login route turns FO 400, 429 and 5xx into 503; an FO 403 (suspended or deleted, pre-password) is indistinguishable from a wrong password in the logs, although its collapsed presentation is correct | [code] | `route.ts:170-173`; `client.ts:172, 543-546`; `login/route.ts:96-101` | RP5 | BOTH |
| G24 | The gateway's response allow-list drops `retry-after`, `www-authenticate` and FO's request-id headers | [code] | `headers.ts:64-74` | RP7 | PREV |
| G25 | FO API responses pass through with FO's own `cache-control`; nothing forces `private, no-store` on user data | [code]; `headers()` reach [uncertain] | `headers.ts:109-125` | RP7 | PREV |
| G26 | The CSRF invariant is unstated: the gateway injects the FO token only when a bearer header is present, which is the only thing stopping cross-site requests from using a user's FO access. A cookie-only design would remove it | [code] + [test] (`injection.test.ts:53`) | `auth-bridge.ts:56-57` | RP7 | PREV |
| G27 | Capacity is unknown: no concurrency settings in `fly.toml` (Fly defaults apply); each streaming chat holds two sockets for the whole turn. Fly is the present preview/development deployment; the production target is AWS, whose sizing is not yet known | [code]; Fly defaults [uncertain]; AWS topology [uncertain] | `fly.toml` | RP10-B | BOTH |
| G28 | No dependency audit, lockfile-integrity gate or update automation for the PWA's own dependency tree; the Docker build's `npm ci --ignore-scripts` is the only supply-chain control, and the base image is tag-pinned | [code] | `Dockerfile:11-32`, `package.json`, `package-lock.json`; no `.github/`, Dependabot or Renovate config | RP10-A | BOTH |
| G29 | No deployment strategy in `fly*.toml`, no staged rollout, no rehearsed rollback (the flag has never been turned off against an installed phone), and no runbook collecting the PWA-side response levers | [code]; Fly's default strategy [uncertain] | `fly.toml`, `fly.preview.toml`, `registry.ts:306-322` | RP10-B | BOTH |
| G30 | The PWA writes FO's `llmatscale_auth_session` key as `{expiresAt}` only, while FO's embedded pages read `user.name`, `user.email` and `user.canCreateDashboards` from it, so the sidebar shows "User" and dashboard rights read as unknown | [code] (`login-page.tsx:195`) + [FO-clone] (`full-chat-app.tsx:166-181, 799`, `modeling-chat-app.tsx:156`) | `components/login-page.tsx`, `app/api/pwa/auth/login/route.ts` | RP2 | PREV |
| G31 | The gateway forwards any bearer-less request to every allow-listed FO API path and lets FO refuse it, so the PWA origin relays unauthenticated traffic to all of FO's API although only `/api/platform-theme` and `/api/health` need to be public | [code] (`auth-bridge.ts:56-57`, `registry.ts:173`); FO's public routes [FO-clone] | `lib/gateway/auth-bridge.ts`, `lib/gateway/registry.ts` | RP1 | PREV |
| G32 | FabOrchestrator's reports page frames model-generated HTML with `sandbox="allow-same-origin allow-scripts"`; on the shared PWA origin such content is same-origin with the page and can read the PWA bearer from localStorage and call the gateway with it (the browser attaches the cookie). The artifact preview uses `allow-scripts allow-downloads` and is not affected | [FO-clone] (`app/reports/page.tsx:320-321`; `components/artifact-preview.tsx:767-772`); production REQUIRES CONFIRMATION | FO `app/reports/page.tsx`; PWA `lib/gateway/registry.ts` (interim row denial) | RP7 | BOTH |
| G33 | On the standalone Next server, headers from `next.config.ts` `headers()` and from middleware are written onto the response before the route handler runs, and a handler's same-named header is then discarded (`send-response.js:34-51`, `router-server.js:337-339`); the config's `Cache-Control: no-cache, must-revalidate` rule matches every gateway path, so the gateway's `cache-control` overrides (`headers.ts:118-123`) never reach the wire and any per-kind header the gateway sets can be pre-empted by the config | [Next-src] (read, not executed; a wire-level probe on preview is the confirmation) | `next.config.ts`, `proxy.ts`, `app/fo-gateway/[...path]/route.ts`, `lib/gateway/headers.ts` | RP7 | BOTH |

---

## 9. Questions requiring team decisions

Every question carries a **class** (revision 3.7): **A** technically derivable (resolved here, with the evidence); **B** provisional engineering default (recommended and configurable, confirmed later); **C** Jothi / product / security decision; **D** FO-owner decision; **E** deployment / CP5 decision. For B to E the columns give the plain-English meaning, why it matters, the recommended choice, the realistic alternatives and what changes under each, and what it blocks: **R** the architecture review, **I** implementation, **P** production. Struck-through questions are answered; their answers stand.

**Jothi (direction, product, security):**

| # | Question | Class | Meaning and why it matters | Recommended | Alternatives and what changes | Blocks R / I / P |
|---|---|---|---|---|---|---|
| 1 | Confirm the 2026-09-06 requirement in writing: the real FabOrchestrator, one login, no FO feature rebuilt. (CP0) | C | The fixed direction every RP assumes | Confirm as recorded | None realistic; a change reopens RP0 | No / No / Yes |
| 2 | Production cutover criteria and date. ~~`whole` or `surfaces`?~~ Decided 24 Sept: `whole`. (CP0) | C | Decides RP8's soak start and when RP10-B's gates must be met | Date after CP5; criteria = RP8's evidence list | An earlier date shortens the soak and raises rollback reliance | No / No / Yes |
| 3 | Do any PWA-native screens survive the cutover? (CP0) | C | A surviving screen needs a design pass of its own; otherwise RP8 is a pure retirement | None survive | Keeping the cockpit or reports adds a maintained duplicate of FO's surface | No / Yes (RP8) / No |
| 4 | Which retiring-code findings are contained now? (CP0) | C | Only B1 corrupts production data today | Contain B1 (and M1) if cutover is more than one release away | Contain nothing: B1 stays live until cutover | No / Yes (RP8 stage 1) / No |
| 5 | ~~Shared FO accounts?~~ Decided 24 Sept: not a PWA requirement. | — | | | | |
| 6 | ~~Deny Master Data Load routes?~~ Decided: kept. Still open: remove it later; and is refusing chat attachments above ~14 MB from the phone acceptable? (CP1) | C | The 20 MiB policy limits phone uploads; FO's web UI is unaffected | Accept 20 MiB provisionally; revisit with L2 | Raise the policy (memory per body rises; CP5 sizing) or lower it | No / No / Yes (CP5 confirms) |
| 7 | Does "no FO change" rule out asking FO to add an ownership check to `/api/chat`? (CP0) | C | RP6 is a compensating control until FO checks ownership itself | Ask FO (question 18) | Keep the compensation indefinitely (works, but the PWA stays the only guard) | No / No / No |
| 8 | Is preview, on production FO with real sessions, governed as a production-data system? (CP0) | C | Preview traffic is real FO traffic | Yes: dedicated test account, read-only live checks only | Treat as dev: risks real data | No / No / Yes |
| 9 | ~~PWA idle timer; 12 h absolute?~~ Decided 24 Sept: FO's idle rule; 12 h. | — | | | | |
| 10 | ~~Central revocation?~~ Decided: FO is the authority. | — | | | | |
| 11 | What counts as enterprise-ready here: MDM distribution, offline promises, accessibility level? (CP4/CP5) | C | Sets RP9's scope and the browser matrix | No MDM; offline = an honest page only; WCAG 2.x AA on PWA screens | MDM adds a distribution channel to design; richer offline needs a staleness story (Tier 5) | No / No / Yes (CP4) |
| 12 | User-facing wording and support flow for errors. (CP3) | C | RP5's `error` sentences and what support does with `requestId` | Approve RP5's table wording at CP3; support looks up `requestId` in logs | Different wording only | No / Yes (RP5 stage 3) / No |
| 13 | History limits and follow-up context (M8/m7), if native chat survives. (CP0) | C | Only if question 3 keeps the native chat | Moot under retirement | | No / No / No |
| 14 | Cockpit placeholder figures (m13), if it survives. | C | Only if question 3 keeps the cockpit | Moot under retirement | | No / No / No |
| 46 | Should the PWA offer password reset? (RP3, CP1) | C | Needs FO's `/api/auth/password-reset` as a third `auth: optional` row (a post-freeze RP1 delta) with its own anonymous limits (enumeration, mail-bombing) | Not in the first production release; FO's own web reset stays the path | Offer it: RP1 delta review, a new anonymous-cap policy, FO confirmation that the endpoint tolerates it | No / No / No |
| 49 (new) | Interim handling of the report-frame exposure (G32) until FO fixes `sandbox`. (CP4) | C (security) | FO's reports page frames generated HTML with `allow-same-origin allow-scripts`; on the shared origin a generated report can read the PWA bearer | Deny the `/reports` document row until FO confirms the fix in production (question 51). Visible cost for the interim: FO's own Reports entries (cockpit nav, chat sidebar) dead-end on RP5's document 404 page | Accept and record: the whole bridged session is exposed to model-generated content | No / No / **Yes** |
| 52 (new) | Collapse or disclose FO's pre-password 403 at the PWA's login (RP2 step 2a, RP2-D1). (CP2) | C (security) | FO's login refuses inactive accounts before checking the password; a distinct message would tell anyone an account's status | Collapse into "incorrect email or password" (already today's behaviour) | Disclose as FO does: the PWA adds a status oracle FO already has on its origin | No / No / No (default applies) |
| 53 (new) | RP3 account policy: progressive delay or hard lockout; `F`, `W`, `D_0`, `D_max`; and the **account-bound device-trust budget**: a signed, httpOnly cookie set on a successful login binds a browser to that account and gives it a larger budget `F_dev` at that account only (never a bypass; failures still count against the account). (CP2/CP3) | C (security) with B default | Hard lockout stops guessing harder but lets any colleague lock the plant manager out; without the device budget a persistent attacker keeps the owner out for the attack's duration at one request per `D_max` | Progressive delay; F=5, W=15 min, D_0=30 s, D_max=5 min; **adopt the bound device budget** with `F_dev = 4·F` | Hard lockout after F; accept the residual exposure without the device budget | No / No / Yes (values) |

**Chetan:**

| # | Question | Class | Meaning and why it matters | Recommended | Alternatives | Blocks |
|---|---|---|---|---|---|---|
| 15 | Were the B4 budgets (10 s, 15 s) measured or chosen? | A | Answered by RP4's method: every `T_*` is set at CP3 from stage 1 measurements; his values are superseded whatever their origin | — | — | No / No / No |
| 16 | Signed conversation handles (M3/B1): adopt or reference only? | A | RP6 proves ownership with FO's own per-id endpoint and RP8 retires the native client, so signed handles are not needed; reference only | — | — | No / No / No |
| 17 | Where is his clone (`c35bbf0`), and was it meant to merge? | C | Historical; nothing in the plan depends on it | Record as not merged | — | No / No / No |

**FO backend owners:**

| # | Question | Class | Meaning and why it matters | Recommended | Alternatives and what changes | Blocks |
|---|---|---|---|---|---|---|
| 18 | Will `/api/chat` check conversation ownership (and deletion) itself; and can FO offer a light ownership endpoint, since `GET /api/conversations/{id}` returns the whole thread (1.3 MB for a long one)? | D | Retires RP6's compensation and removes the per-id cost | Yes, in FO | No: the gateway stays the only guard and pays the per-id read | No / No / No |
| 19 | Production idle timeout, token lifetime, keep-alive intervals. | D | RP2's expiry maths and RP4's `T_idle_stream` assume the clone's 30 min, 30 days, 15 s | Confirm the clone's values | Different values: RP4's assertion and RP2's `exp = min(12 h, FO)` adapt by configuration | No / No / Yes |
| 20, 47 | Does `/api/chat` stop model work when the client aborts? | D | The clone never reads `req.signal`; an RP4 idle timeout or a phone leaving does not stop FO's spend | Confirm; if not, FO could honour the abort signal | Leave as is: cost only, no correctness impact | No / No / No |
| 21 | What does `addMessage` do for a soft-deleted conversation? **Clone answer: it appends** (`lib/storage.ts:202-229`, no `deletedAt` check); production to confirm | D | RP6's residual stale window (G7) writes a turn into a conversation the user deleted and cannot see again | CP1 chooses RP6 part 4 option (b): a shorter `T_own` for warmed and looked-up positives, session-length for ids the gateway saw created | (a) accept; (c) FO adds the deletion check in `/api/chat` (question 18) | No / No / No |
| 22 | Latency percentiles; does FO or CloudFront throttle per source IP? | D | The PWA's egress IP(s) carry every user; L4 measures it | Confirm no per-IP throttle, or the limit | If throttled: NAT with several egress IPs or an allow-list at FO's edge | No / No / Yes |
| 23 | A paging API for conversations (m6). | D | Only if native chat survives; moot under retirement | Moot | | No / No / No |
| 24 | Officially supported routes and methods for embedding; admin-only or expensive subtrees. | D | RP1's route policy table is built from the clone; production may differ | Confirm the table row by row at CP1 | Differences become table edits and a contract-drift test update | Yes (CP1) / Yes / Yes |
| 25 | ~~How should FO's client receive gateway errors (G8)?~~ **Superseded by question 57**: FO's chat renders a PWA JSON refusal as raw text; under question 57's recommended option (b) this becomes a **required** FO change | D | — | See question 57 | — | See question 57 |
| 26 | ~~Login on forced change?~~ Answered. Still open: a forced-change test account; should a password change revoke other sessions? | D | The live check needs the account; revocation is FO's policy | Provide the account; revoke other sessions on password change | No revocation: RP2 notes it as FO behaviour | No / No / Yes (test account for go-live) |
| 27 | ~~`llmatscale_user`?~~ Answered (G30). | — | | | | |
| 39 | Does FO's build run a dependency audit and security verification, against which standard? (CP4) | D | The PWA verifies only its own controls | Confirm | — | No / No / No |
| 40 | Which browser and device matrix are FO's pages tested on? (CP4) | D | Embedded pages must meet the PWA's matrix | Confirm iOS 16.4+, current Chrome, current Safari | A narrower FO matrix narrows the PWA's | No / No / Yes (CP4) |
| 44 | Does production's change-password clear `forcePasswordChange`? | D | The clone does not; the PWA cannot finish the flow alone (RP2 go-live dependency) | Confirm or fix FO | Not fixed: the forced-change flow is not accepted for production | No / No / **Yes** |
| 45 | FO's own login: no throttle, no failed-login audit, message and timing enumeration, pre-password status disclosure. | D | The PWA's limiter protects only the PWA door; FO's origin stays exposed | FO adds its own limiter and failed-login audit; considers status check after password | Leave: T10 stands as an FO exposure | No / No / No |
| 50 (new) | Will FO accept a per-request CSP nonce (Next's standard header mechanism) or ship hashable bootstrap scripts? | D | Without it the CSP for FO's documents cannot forbid inline script and gives limited XSS protection (RP7 part 4) | Add nonce support in FO | No: RP7 enforces the `'unsafe-inline'` policy and CP4 records the limit | No / No / No |
| 51 (new) | Change `app/reports/page.tsx` to `sandbox="allow-scripts allow-downloads"` (drop `allow-same-origin`) as the artifact preview already does. (G32) | D | The current attribute pair lets generated report content read the PWA bearer on the shared origin | Fix in FO before cutover | Not fixed: the PWA denies the `/reports` row (question 49) | No / No / **Yes** |

**Deployment and infrastructure (CP5):**

| # | Question | Class | Meaning and why it matters | Recommended | Alternatives and what changes | Blocks |
|---|---|---|---|---|---|---|
| 28 | Target registered, active and concurrent users; instance count and regions. | E | Sizes L1–L5 and the caps `N_streams`, `N_bodies` | Provide targets; start at 2 tasks, one region near the plant | More regions: latency to FO's region matters more than to users | No / No / Yes |
| 29 | Fly's effective concurrency limits (G27). | A | Fly is preview only; L1 on Fly is informative, production limits come from ECS/ALB | — | — | No / No / No |
| 30 | How `SESSION_SIGNING_SECRET` and the key ring are distributed per environment. | E with B default | RP2's key ring must be identical on every task | AWS Secrets Manager → task environment; Fly secrets on preview | Parameter Store; a vault | No / No / Yes |
| 31 | Does Fly's edge prepend or append to `x-forwarded-for`? | A | Irrelevant: RP1 prefers `fly-client-ip` on Fly | — | — | No / No / No |
| 32, 48 | The production edge in front of the PWA (CloudFront, ALB, both), its origin response and idle timeouts and body behaviour; FO's own edge timeouts; whether the ALB appends to or replaces a client-supplied `x-forwarded-proto` (the design does not read it, recorded for the reason); whether `Authorization` reaches the origin under `CachingDisabled` + `AllViewer`; whether an origin-side abort mid-body reaches the phone as an abort. | E | Bounds every RP4 `T_*`; sets `TRUSTED_PROXY_HOPS`; decides whether RP1's 25 MiB ceiling survives | Topology A: CloudFront → ALB → ECS; CloudFront origin response timeout raised to 60 s; ALB idle ≥ 120 s | ALB only (hops = 1, no CloudFront caching or WAF); API Gateway or Lambda **excluded** (body and timeout caps break RP1 and RP4) | **Yes (CP3 values)** / Yes / Yes |
| 33 | Log and metrics platform, SLOs, alerting, CI platform. | E | RP10-A's destination; the CI gate; alert thresholds. *Premise corrected in revision 3.9:* this repository is its own GitHub repository (`origin github.com/KingCorsair/faborchestrator-pwa`), so a workflow here grants no host access to the parent monorepo | CloudWatch Logs and metrics; **GitHub Actions with Dependabot on this repository** | Datadog or similar; another CI host with self-hosted Renovate | No / Yes (CI) / Yes |
| 34 | Who may run load tests against FO, and against which environment. | E | L1–L5 generate real FO load | A staging FO, or a scheduled window on production with FO owners present | No environment: capacity stays unknown | No / No / Yes |
| 41 | Deployment strategy; who runs the staged cutover and the rollback rehearsal. | E | RP10-B part 1 | ECS rolling with readiness gating; the PWA owner runs the rehearsal on preview with an installed phone | Blue/green (higher cost, instant rollback) | No / No / Yes |
| 42 | Who owns incident response and vulnerability intake; a disclosure contact? | E (organisation) | The runbook references it | Name an owner; add `SECURITY.md` | — | No / No / Yes |
| 43 | Dependency-audit threshold and update cadence. | E with B default | RP10-A's CI gate | Fail on high and critical; weekly update proposals | Fail on moderate too (more noise) | No / No / No |
| 54 (new) | Shared counter store: ElastiCache Redis, and the degraded fallback (`LOGIN_PROTECTION_FALLBACK`) when it is unavailable. | E with B default | RP3 fails closed without it; the fallback trades N-fold allowance for availability | Redis; fallback off | DynamoDB conditional writes; fallback to memory after N failures | No / No / Yes (if 2+ tasks) |
| 55 (new) | Staged-rollout mechanism: a separate pilot deployment, or the global flag for everyone. | E | The embedding flag is global; **a pilot hostname is a separate web origin, so pilot installs, cookies and bearers do not migrate** (RP10-B) | A disposable pilot deployment on its own hostname that proves gateway, sessions and load; pilot users reinstall from the main hostname | Global flip with a short soak (everyone at once; rollback is the flag at its real latency, question 59) | No / No / Yes |

| 56 (new) | FO owners: what, if anything, caps a chat turn in production FO (edge total, model timeout, tool timeout)? `maxDuration = 300` is not enforced under `next start`. | D | RP4's `T_life_stream` cannot be inherited from FO's number; it is measured (p99 plus headroom) | Confirm the real cap, or none | None: the PWA's lifetime is the only cap and FO keeps generating after it | No / No / Yes (value) |
| 57 (new) | FO's chat client renders a non-OK response's raw body text, so a PWA-originated refusal of a chat turn (400, 413, 429, 403, 503, 504) would appear as raw JSON in the conversation (RP5 part 5). | C (security/product) with D | The user is told nothing useful on exactly the surface Jothi's #4 is about | **(b)** ask FO owners to make the chat's error rendering parse a JSON body and show `error` (a few lines; question 25 becomes required); **(a)** raw JSON accepted as the interim | (c) the gateway answers chat-row refusals as a 200 UI-message stream carrying FO's own error part (loses the status code; the PWA composes FO-protocol bytes) | No / No / **Yes** (interim recorded) |
| 58 (new) | Manifest `id`: keep `/orders` or change now. Changing orphans **Chromium-family installs only**; iOS Home Screen apps are keyed by the URL on screen when added (RP9 part 5). | C (CP4) | A path-shaped `id` names a removed workflow and invites the same drift again | Change now, while the installed base is a pilot, to a non-path value such as `faborchestrator-pwa` | Keep forever (no orphaning; a misleading identity) | No / No / Yes |
| 60 (new) | Is the current personal-account GitHub repository (`KingCorsair/faborchestrator-pwa`) the sanctioned home for CI runs and release evidence, or must it move to an organisation-owned repository (or another host) first? | E (organisation) | RP10-A's CI job and the release evidence need a platform whose ownership the organisation accepts | (b) an organisation-owned GitHub repository first, then GitHub Actions + Dependabot; if no organisation exists, (a) now and migrate later | (a) GitHub Actions on the current repository now; (c) another CI host with self-hosted Renovate | No / Yes (CI) / Yes |
| 59 (new) | Is a seconds-scale rollback of the embedding flag a requirement? On ECS an environment change is a task-definition revision and a rolling update (minutes). | C/E | RP10-B's fastest lever is minutes unless a runtime flag source is designed | Accept minutes, documented, with the ECS-measured number in the runbook | Design a runtime flag (SSM Parameter Store or AppConfig polled by the app: poll interval, last-known-value semantics) for seconds | No / No / Yes |

| 61 (new) | Soak length before deleting the native fallback, and N (the final days with zero use). (RP8, CP0/CP5) | C | The fallback is deleted only after evidence | Two release cycles or four weeks, whichever is longer; N = 7 days | Shorter: less evidence; longer: the native routes stay reachable longer | No / No / Yes |
| 62 (new) | HSTS `max-age` and preload. (RP7, CP4) | C | HSTS mistakes are sticky | `max-age` 1 year, no preload until the hostname is final | Preload now (irreversible for months) | No / No / Yes |
| 63 (new) | May the PWA ever be framed? (RP7, CP4) | C | `frame-ancestors 'none'` forbids any future embedding | Never (`'none'`; `'self'` on FO documents only if the rendered check requires it) | Allow named origins | No / No / No |
| 64 (new) | Service-worker update policy: prompt or forced reload after a grace period. (RP9, CP4) | C | Every deploy is a worker update | Prompt | Forced reload after a grace period (can interrupt work) | No / No / No |
| 65 (new) | Production nginx body ceiling on FO (both clones say 50 MB). (RP1, CP5 input 6) | D | RP1's 20 MiB policy must stay below FO's ceiling | Confirm 50 MB | A lower ceiling lowers RP1's policy | No / No / Yes |
| 66 (new) | `LOGIN_PROTECTION_FALLBACK`: after how many consecutive store failures, if enabled. (RP3, CP5) | E | Part of question 54 | Off; if enabled, 5 | — | No / No / No |
| 67 (new) | WAF in front of the PWA: yes or no, and the rate rule on body-carrying methods. (RP10-B, CP5) | E | The edge rate rule is one of the two pre-buffer controls against upload exhaustion (WHOLE-R1) | Yes, with RP10-B's WAF row settings and a per-IP body-method rate rule | No WAF: CloudFront limits and the thin Node entry only | No / No / Yes |

**Things to verify by test** (class A; no decision; scheduled in the packages): 35 `req.signal` on disconnect under `next start` (RP4, real-server harness); 36 `headers()` on rewritten gateway responses (RP7; the design sets headers in the gateway regardless); 37 the G2 path on a fresh build and memory per body (RP1 stage 2, L2); 38 undici's defaults on the deployed Node (RP4; superseded by explicit `T_*`).

---

## 10. Suggested study sequence

Study the concepts listed for a package immediately before starting its checkpoint preparation. The order follows Jothi's priorities, adjusted only where one package's concepts need another's first.

| Step | Before | Study | Hands-on exercise in this repository |
|---|---|---|---|
| 1 | RP0 | Architecture decision records; the strangler-fig pattern; feature flags as rollback; iframe versus redirect versus same-origin proxy | Read `docs/plan/MASTER_PLAN.md:142-200` and `docs/STATUS.md:1022-1044` side by side, and write down how each fits the 2026-09-06 requirement |
| 2 | RP1 *(Jothi #1)* | The HTTP request lifecycle; reverse proxies; the same-origin policy; Next middleware versus route handlers; how Next clones bodies for middleware; rewrite versus redirect; hop-by-hop and `X-Forwarded-*` headers; `content-length` versus chunked; RSC headers; `assetPrefix`; Web Streams | Trace `/chat`, then a chunk, then `/api/chat` with devtools on preview; read `__tests__/gateway/*.test.ts` as the specification; reproduce G2 end to end |
| 3 | Enterprise PWA *(Jothi #2)* | Appendix A checklist; the service-worker lifecycle; manifest identity; security headers overview | Run `scripts/pwa-install-check.mjs` and `scripts/security-review.mjs` |
| 4 | RP2 *(Jothi #3, #6)* | Stateful versus stateless sessions; HMAC tokens and JWT claims; cookie attributes; XSS and localStorage; CSRF and bearer headers; OWASP Session Management (idle versus absolute); revocation; key rotation | Draw the session state diagram and the per-mode idle table from `lib/auth.ts`, `auth-bridge.ts`, `fo-shell.js`, and FO's `session-audit.ts` and `providers.tsx` (clone) |
| 5 | RP3 | Brute force versus stuffing; rate-limit algorithms; races across `await`; login CSRF; trusted proxy headers | Read `rate-limit.test.ts` and explain why `:61` and `:68` encode the defect |
| 6 | RP4 *(Jothi #5)* | The two phases of `fetch`; `AbortSignal` (`timeout`, `any`); undici's timeouts; SSE keep-alives; total versus idle deadlines; what `maxDuration` does when self-hosted; 502/503/504; idempotency and retries | Build a 20-line slow-FO stub and watch `fetchFo` and sign-out hang |
| 7 | RP5 *(Jothi #4)* | Error taxonomies; in-band errors in streams; correlation IDs; React error boundaries; information disclosure | Inventory every `NextResponse.json({ error` on surviving surfaces |
| 8 | RP6 | IDOR / BOLA; the confused deputy; negative caching and invalidation; compensating controls | Read `lib/gateway/ownership.ts` and its tests; explain why "no" is never cached |
| 9 | RP7 | CSP (nonces, report-only); HSTS; `frame-ancestors`; `Cache-Control: private, no-store`; CSRF | `curl -I` production and preview; list what's missing; show that a cookie-only request reaches FO anonymously |
| 10 | RP9 | Service-worker install, activate, update, `clients.claim`; navigation preload; cache strategies; iOS constraints | Throttle to offline and to hanging in devtools with the app installed |
| 11 | RP8 | URL as state; React rendering, memoisation, reducers, focus management | Reproduce B1 locally |
| 12 | RP10-A, RP10-B | Structured logging; RED metrics and SLOs; horizontal scaling and shared state; connection-based concurrency; the test pyramid; mutation testing | Follow one request through the logs after RP10-A stage 1; design load scenario L1 |

---

## Appendix A — Enterprise PWA characteristics mapped to packages

| Characteristic | What "industry-standard" means | Package | Current state |
|---|---|---|---|
| Installability and stable identity | A valid manifest with a stable `id`, `scope` and `start_url`; icons; standalone display | RP9 | `id: "/orders"` names a removed workflow (N2); the manifest is also injected into FO's pages |
| Update lifecycle | New builds detected and offered, with no stale chunks | RP9 | Register only (m15); a permanent latch (M16) |
| Honest offline behaviour | A deadline on every navigation; offline confirmed by a reachability probe; a styled offline page | RP9 | M14, M15, m14 |
| Transport and browser security | HSTS, CSP, `frame-ancestors`, `nosniff`, Referrer-Policy; `private, no-store` on user data | RP7 | Only Cache-Control (M12); the gateway adds nothing (G9, G25) |
| Session security | httpOnly credentials; idle and absolute timeouts; revocation; key management; login protection; CSRF defence | RP2, RP3, RP7 | httpOnly FO token (good); PWA bearer in localStorage (G10); B2/B3; m2/m3; the CSRF invariant holds but is unstated (G26) |
| Resilience to a slow backend | Deadlines, a lifetime cap, cancellation, distinct timeout errors | RP4 | None (B4, G1, G21, G22) |
| Clear error UX | Coded errors, the right next step, defined mid-stream failures, error boundaries | RP5 | M2, M6, m11, G8, G23 |
| Data isolation | Object-level authorisation on every resource | RP6 | The PWA compensates for FO's unguarded `/api/chat` |
| Controlled exposure | An explicit allow-list of routes and methods | RP1 | Path allow-list only; no method allow-list (G14); broad subtrees (G15) |
| Observability | Structured logs, request IDs, metrics, alerts | RP10-A | M18 |
| Verified behaviour | Behavioural and component tests; CI | RP10-A | M17; no CI |
| Operability at scale | Stateless instances or shared state; documented topology; load-tested capacity; rollback | RP10-B | Single machine; per-process maps (m1, G3); capacity unknown (G27) |
| Accessibility | WCAG 2.x AA: focus management, keyboard navigation | RP8 (PWA screens), RP9 | m12 |
| Performance on mid-range phones | Code splitting, render efficiency | RP8 | M9, m10 |
| Dependency hygiene | Lockfile-authoritative installs, vulnerability audit in CI, automated updates, pinned base image | RP10-A | `npm ci --ignore-scripts` in Docker only (G28) |
| Security verification | The app's own controls mapped to a standard (OWASP ASVS) and to the tests that prove them, at an agreed level | CP4 (RP2, RP3, RP6, RP7, RP10-B supply the controls) | Controls exist piecemeal; no checklist or level |
| Compatibility | An agreed browser and device matrix, tested on | CP4, RP9 | iOS 16.4+ floor recorded; tests on Chromium and WebKit; no agreed matrix |
| Deployment safety | A chosen deploy strategy, staged rollout, rehearsed rollback | RP10-B, CP5 | Flag-off rollback described, never rehearsed (G29) |
| Response readiness | The app's response levers collected with owners; the organisation's process referenced, not owned | RP10-B, CP5 | Levers exist in four packages, collected nowhere (G29) |

## Appendix B — How this plan was verified

- **Repository identity:** the review PDF's line anchors (`client.ts:535-538`, `login/route.ts:104-106, :128`, `rate-limit.ts:120-122`, `agent-chat-client.tsx:109, :196`, `package.json:2`) match HEAD `585aa00` exactly. Chetan's `c35bbf0` is absent.
- **All 50 findings** were re-checked by grep or reading on 23 September 2026 (the §8.1 "Verified" column). Baseline tests: 568 passing (`npm test`).
- **FO behaviour** was checked only in the local clone `fo-mobile-nav@1b9b117` (branch `mobile-nav-preview`), including, on 23 September:
  - the client idle timer (`providers.tsx:120-145`: warning at 28 min, expiry at 30 min, keyed to the last successful authenticated API call);
  - no login throttle;
  - no cookies set and no service worker registered;
  - `/api/chat` and `/api/modeling-agent/chat` are the only conversation routes without an ownership check.

  Production FO may differ.
- **Runtime checks on 23 September 2026:**
  - `next start` on the existing build (Next 16.1.4) with a 12 MB POST to `/login` logged: "Request body exceeded 10MB for /login. Only the first 10MB will be available unless configured."
  - A standalone probe on Node 24.19 / undici 7.29, mirroring the gateway: a request forwarded with `content-length: 20` and a 10-byte body failed with `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`; the same body without `content-length` was received as a complete 10-byte chunked body.
- **Body-limit probe, 24 September 2026** (a throwaway Next 16.1.4 app in the scratchpad, reproducing the mechanism: middleware with the `/(.*)` matcher rewriting to a catch-all route that enforces a 20 MiB policy and forwards to a stub upstream recording bytes and completeness):
  - ceiling 25 MiB: 5 MiB, 20 MiB − 1 and exactly 20 MiB accepted and forwarded byte-exact (declared and chunked); 20 MiB + 1 and 22 MiB refused with a coded 413 (declared at the "declared" stage, chunked at the "measured" stage with the true size); 25 MiB + 1 and 30 MiB refused, the route seeing exactly 25 MiB; the stub received nothing in every refused case; a multipart body with a 19.9 MiB file accepted (203 bytes overhead per part).
  - ceiling 20 MiB (equal to the policy): the chunked 20 MiB + 1 and 30 MiB bodies were cut to exactly 20 MiB, passed the policy check, and reached the stub as complete 20 MiB bodies (silent truncation); the declared 20 MiB + 1 was refused on its header.
  - `next start` applies `proxyClientMaxBodySize` from `next.config` at startup (a first control run with the value set only at build time still used the runtime default), and Next receives the whole upload before the route runs even when the route refuses on the declared length (its "exceeded" warning appeared for declared cases too).
- **Next.js source:** `maxDuration` appears only in Next's build, typegen and adapter code, not in the runtime request path.
- **Measurements quoted** come from `docs/probes/2026-09-08-wp0-latency.md` and `docs/probes/2026-09-09-wp8-latency.md`: few runs, from one client machine. They are not percentiles.
- **[team-record] items** (Jothi's 2026-09-06 requirement; the 7 September production probe) come from earlier working-session records, not this repository, and are listed for confirmation at CP0.
- **Live contract checks** in the packages run against preview, which is connected to production FO. They are read-only (`GET` only) wherever possible, and otherwise confined to a dedicated test account's own sessions or to an unpersisted chat turn. They never touch another account's data and never write into a conversation.

## Revision history

**Revision 3.12 (28 September 2026)**, the WHOLE review applied. Mechanism: one `general-purpose` subagent with the charter's WHOLE mode, run once against revision 3.11. Findings: 1 BLOCKING, 9 FIX NOW, 3 DEFER. **WHOLE-R1 (BLOCKING, verified in Next 16.1.4):** Next buffers the whole upload before `proxy.ts` can answer, so the admission cap and login pre-check placed in `proxy.ts` bounded neither memory nor time; corrected by moving pre-buffer refusal to a thin Node entry in front of Next and an edge rate rule, sizing task memory for an attacker's connection count, and correcting RP1 part 3's memory statement (an RP1 delta). FIX NOW, all applied: R2 the FO cookie outlives the bearer by a short grace `G` so absolute expiry revokes the FO session (an RP2 delta); R3 per-namespace store-failure semantics; R4 a `T_store` class in the login budget and a fifth revoke site for an abandoned login (RP4); R5 the stream cap `N_streams` owned by RP4 with release in the lifecycle's terminal callback; R6 the Design Review Summary rewritten at revision 3.12 and the §7 overview marked historical; R7 five leftover contradictions corrected; R8 §9 made complete (q25 superseded by q57, q53 rewritten for the bound device budget, questions 61 to 67 added); R9 the build-order note in §5.3 (contracts first); R10 the `login-device` namespace. DEFER, applied to owners: R11 ALB draining behaviour (§9 question 48, rehearsal on the ECS pilot); R12 back/forward cache after sign-out (RP9 part 2); R13 `session_end` for FO-initiated ends (RP10-A). The WHOLE review runs once by the workflow; its RP1/RP2 corrections (R1's memory statement and the `proxy.ts` row, R2's cookie grace) went to one delta review: `DELTA NOT SAFE` with three FIX NOW items, all applied on the reviewer's wording (RP1/RP10-B-D15 the Node entry's duties: embedded config, keep-alive and inbound timeouts, `SIGTERM` ownership preserving `after()`, refusals closing the connection; RP1-D16 three leftover `proxy.ts` admission statements and the G2 test split into declared and chunked; RP2-D11 the cookie grace as `Max-Age`, a named input with a bounded assertion, the stale equal-expiry test replaced) and one deferral applied (RP2-D12 the grace revokes only if the device is used within `G`; m3's residual recorded). By the workflow's cap no further automatic round runs; this is shown to the human. No application code was changed.

**Revision 3.11 (28 September 2026)**. **Delta batch 3** (the four revision 3.10 sentences in RP1 and RP2): `DELTA NOT SAFE` with four FIX NOW items, all applied on the reviewer's wording: RP1-D11 (only requests sent to the gateway are admitted against `N_bodies`; PWA-owned body routes never hold a slot), RP1/RP10-B-D12 (the route claims its entry; the sweep removes only unclaimed entries), RP1-D13 (a stale `x-forwarded-proto` test contradicted the corrected rule), RP2/RP4-D10 (the probe-401 revoke is site (iv) in RP4); RP1-D14 deferred to RP10-B's smoke list and applied. The same batch also corrects RP2's G5 paragraph wording ("bounded deadline" → RP4's `revoke` class, RP4-R18). **This was batch 3's first round; its corrections are text in the reviewer's own words and are covered by the WHOLE review rather than a further delta round.** **RP4 round 2** (7 FIX NOW, 1 DEFER), **RP6 round 2** (3 FIX NOW, 2 DEFER) **RP8 round 2** (6 FIX NOW, 2 DEFER) and **RP9 round 2** (4 FIX NOW, 1 DEFER: `/offline` becomes a fixed-string route handler, one shared probe module, update reload never races sign-out, the worker template as a TypeScript string module) applied (see their review records). No application code was changed.

**Revision 3.10 (28 September 2026)**, second review rounds applied. RP3 round 2: 1 BLOCKING (the device-trust cookie was unbound: any account holder's cookie would have exempted guesses at every account; corrected by binding to `accountKey` and making it a bounded budget `F_dev`), 6 FIX NOW (admission predicate, reservation deadlines and the `finally`, unique reservation ids, the short-chain `null` requirement and `CLIENT_IDENTITY_SOURCE`, the exemption's counting rules, the eviction tie-break), all applied. RP5 round 2: 3 FIX NOW (the probe-401 outcome, the producer and consumer lists, RP3's 429 mapping), 1 DEFER, applied. RP7 round 2: 5 FIX NOW (Next's error renderer as a writer, the middleware JSON 404 kind, the middleware > config > route precedence, no `cache-control` on the `/pwa-assets` rewrite, 304/HEAD keyed by owner, the retired tests, the `/offline` note in RP9), applied. RP10-A round 2: `SAFE TO FREEZE` with 4 FIX NOW wording items (one writer for `x-request-id`, the redaction plant list, UUID-only `requestContext`, immutable `ctx`), applied. RP10-B round 2: 8 FIX NOW (no trusted `x-forwarded-proto` position on this topology so `EDGE_SCHEME=https` by configuration, the admission registry mechanism, the draining sequence with an application `SIGTERM` listener, the flag lever soak-only, `skipProxyUrlNormalize` as a build guard with named timeout inputs, the liveness contract, the rotation TTL from rollout completion, the smoke path), 3 DEFER, applied. **The two-round cap is reached for RP3, RP5, RP7 and RP10-B; their round-2 corrections were applied on the reviewers' own wording and are shown to the human in this revision's report rather than sent to a third round.** Four sentences in frozen text were changed on these reviews' instructions and go to one delta review: RP1 part 4 (AWS scheme by configuration; short-chain `null`; the identity-source knob), RP1 part 1 (the admission registry as a `proxy.ts` responsibility), RP2 step 2 (the probe-401 outcome). RP4's second round was cut by a session limit and is rerun; RP6, RP8 and RP9 second rounds follow. No application code was changed.

**Revision 3.9 (28 September 2026)**. **RP1/RP2 delta, two rounds (record):** the six revision 3.8 edits to frozen RP1 and RP2 were reviewed in DELTA mode. Round 1: `DELTA NOT SAFE`, RP1-D1 (the request-scheme trust rule was undefined on Fly and locally; a literal implementation would drop the cookie's `Secure` flag on the live Fly host) and RP1-D2 (redirects built from a configured `PUBLIC_ORIGIN` opened a misconfiguration failure the Host-derived redirect could not have), plus RP1-D3 and RP1-D4 deferred; all four applied. Round 2 on the corrections: `DELTA NOT SAFE`, RP1-D5 (a hand-built relative `Location` would throw in Next's proxy adapter; the correct mechanism is today's request-origin redirect, which the adapter emits origin-relative) and RP1-D6 (Fly documents no `Fly-Forwarded-Proto`; the Fly branch is `https` by `force_https` configuration, or `Fly-Forwarded-Port`). Both applied on the reviewer's own verified wording. **The two-round cap is reached; no third round ran, and the human is shown this in the revision 3.9 report.** RP1 and RP2 remain frozen with these text corrections. **RP7 first round:** 1 BLOCKING (header precedence on the standalone Next server, recorded as **G33** and closed by one writer per response kind), 7 FIX NOW and 3 DEFER, all applied (see RP7's review record). **Three further wording deltas to frozen text**, queued for delta review: RP2's G10 mitigation row now says RP7's controls are partial until FO supports a nonce (RP7-R9); RP1 part 5 gains the document-denial mechanism for the G32 interim (RP7-R5); RP1 part 4's `x-request-id` sentence now says the inbound value is replaced before every return of `proxy()` (RP10A-R1). **Delta review of the G10 wording and the document-denial paragraph:** `DELTA SAFE` with two wording corrections applied (RP1-D7 the denial attaches to the `fo-document` outcome inside step 5, with the `surfaces` tests; RP1-D8 the list is emptied only after production confirmation) and three deferrals applied to their owners (RP1/RP8-D9 the inverse map excludes contested paths; RP1-D10 question 49 names the dead nav entries; RP2-D9 CP4's bring-list gains the G10 residual). The `x-request-id` sentence (RP10A-R1) is covered by the WHOLE review. **RP10-A first round:** 1 BLOCKING (the request id was minted only on the gateway branch, so the PWA's own routes would carry a client-chosen id; closed by minting on every `proxy()` return and explicit `ctx` propagation), 13 FIX NOW and 2 DEFER, all applied (see RP10-A's review record), including the corrected CI premise (this repository is its own GitHub remote) and new §9 question 60. No application code was changed.

**Revision 3.8 (27 September 2026)**, first independent review round applied for RP3, RP4, RP5, RP6, RP8, RP9 and RP10-B (mechanism: one `general-purpose` subagent per RP with the charter, run in parallel; RP7's and RP10-A's runs were cut by a session limit and are pending). Totals: 3 BLOCKING (RP5-R1: FO's chat client renders a PWA JSON refusal as raw text, a human decision recorded as §9 question 57 with an interim; RP10B-R1: CloudFront cache and origin-request behaviour unspecified; RP10B-R2: readiness would turn a store outage into ECS replacing every task), 52 FIX NOW, 21 DEFER; every FIX NOW and BLOCKING correction is applied in the sections and every DEFER has an owner named in the section's review record. Cross-cutting results: RP3 gained the reserve/settle compensation order, the two `null` identity cases with `untrusted_ingress`, sliding-expiry windows, eviction by lowest failure count, settle-failure semantics, a dedicated `LOGIN_PROTECTION_SECRET`, the device-trust option (§9 question 53) and a finding map; RP4 redefined `connect` as a rejection class, gave every piped body an idle-not-total deadline, starts the stream idle timer at headers, errors (never closes) the downstream stream, covers all four revoke sites with the caller signal never combined, measures the lifetime instead of inheriting `maxDuration`, and adds the inbound and shutdown phases; RP5 gained presentation by request kind with HTML error pages, a complete status table (`invalid_credentials`, `upstream_error`, `busy`, `untrusted_ingress`, `password_change_required`, `client_render_error`, `details`), the per-consumer table of what FO's client renders, the PWA code → screen → action table and the errored-stream rule; RP6 corrected the fingerprint description, made the outcome table total and positive-only, invalidates across fingerprints, warms from creates, validates the UUID shape and records the legitimate deleted-elsewhere case; RP8 derives its retire list, inverts the redirects and asserts the mode after deletion, adds the flag-off inverse map for installed phones, closes the native API routes during the soak and adds usage evidence to the gate; RP9 moved the worker to a route with a template, a shadowing build guard, the `registration.waiting` check, the accepted-update reload guard, a chunk-free offline page, a strictly larger `T_nav` and a structural Rule 1; RP10-A gained the `startup` event, request-id precedence, the component-interaction layer and the new guards; RP10-B gained the CloudFront behaviour row, the three-way split of startup assertions, liveness and dependency status, edge-only ingress, `PUBLIC_ORIGIN`-built redirects, the admission cap in `proxy.ts`, two-deployment key rotation, one timeout rule with `KEEP_ALIVE_TIMEOUT`, draining, real rollback latency, the disposable pilot origin, WAF rules and a complete TLS row. **Queued RP1/RP2 delta batch** (frozen text touched by these corrections, not yet edited): RP2's G5 finding-map cell (revoke-then-clear wording, RP4-R10); RP1's chat rows exact-match for POST (RP6-R9); `proxy.ts` redirects from `PUBLIC_ORIGIN` (RP10B-R4); the `CloudFront-Viewer-Address` rule (RP10B-R3); `x-request-id` in RP1's request allow-list (RP10-A); `isHttps` trust position (RP10B-R12); RP1's rollback statement retired after RP8's deletion (RP8-R3, scheduled). New §9 questions 56 to 59. No application code was changed.

**Revision 3.7 (27 September 2026)**, the design-review draft. **Delta review, second round (record):** the revision 3.6 RP2 step 2 correction was substantive (a presentation rule in a frozen RP), so the follow-up round the workflow requires ran here with the `general-purpose` subagent in DELTA mode, against the RP2 step 2 split and the G10 test-cell correction. Findings: RP2-D4 FIX NOW (a second RP2 test bullet still described the pre-G31 anonymous forwarding; corrected with the reviewer's wording, text only), RP2-D5 DEFER (FO's bcrypt timing separates active from inactive accounts; recorded in RP3 T11, owner §9 question 45), RP2-D6 DEFER (the probe-403 revoke needs a deadline class and a log line; carried in RP4 part 1), RP2-D7 DEFER (a wrong-password code was undefined; RP5 part 3 defines `invalid_credentials` and `account_inactive_post_password`), RP2-D8 DEFER (the collapse decision now sits in CP2's list and §9 question 52). Verdict `DELTA SAFE`; RP1 and RP2 remain frozen; the baseline is refreshed after this revision. Two delta rounds have now run for the RP2 change, which is the workflow's maximum; RP2-D4 was applied on the reviewer's own wording without a third round and is shown to the human in the revision 3.7 report. **Document integrity:** CP0's shared-account item and §5.2's blocked list were stale against the 24 September decisions and are struck through with pointers; the revision 3.5 delta record was rewritten to state the sequence truthfully (review, findings, corrections, the follow-up round that had not yet run). **Depth:** RP3 to RP10-B rewritten to design-review depth with parameters (`F`, `W`, `D_max`, `C_src`, `R_src`, `T_*`, `T_own`, `N_streams`, `N_bodies`) and provisional defaults marked as such; RP6 refuses rather than strips a non-owned conversation id and fails closed when FO cannot be asked; RP7 states what CSP is actually possible against FO's inline scripts and records **G32** (FO's reports page frames generated HTML with `allow-same-origin allow-scripts`); RP9 adopts a waiting worker with a user-accepted update and a kill-switch route; RP10-A ties every event, metric and test layer to a failure mode; RP10-B's AWS topology is marked PROPOSED with each dependent value parameterised. **§9** classified every question A to E with meaning, recommendation, alternatives and what each blocks; new questions 49 to 55. **Design Review Summary** added before §0. Independent reviews of RP3 to RP10-B and the WHOLE review are recorded in each section and below. No application code was changed.

**Revision 3.6 (27 September 2026)**, RP2 delta review applied and the whole-architecture first pass. The delta review of the 3.4 → 3.5 changes (mechanism: `general-purpose` subagent with the charter's DELTA mode) returned `DELTA SAFE` with RP2-D1 and RP1/RP3-D2 (FIX NOW) and RP2/RP3-D3 (DEFER), all applied as text corrections: FO's login 403 is pre-password, so RP3 counts it and RP5 presents it exactly as a wrong password (human decision recorded as open, collapse recommended); the RP1 → RP3 edge is `clientIdentity` only and RP3's new stage 9 hosts RP1's anonymous cap under namespaced, per-namespace-bounded keys; RP3's same-origin `self` comes from `PUBLIC_ORIGIN`. RP1 and RP2 stay frozen; the reviewed baseline was refreshed. Then RP4, RP5, RP6, RP7, RP8, RP9, RP10-A and RP10-B were rewritten from design language into a first-pass proposed architecture (components, flows, failure behaviour, trust boundary, finding map, dependencies, open decisions, acceptance criteria), with an overview at the head of §7 stating the end-to-end system, the seams checked, four cross-RP contradictions (RP7's CSRF test vs RP1's G31, with a delta review queued for RP2's G10 test cell; RP6 strip vs refuse; RP9 activation vs RP8 rollback; RP4's edge dependency) and the readiness of each section. No section other than RP1 and RP2 is frozen. §9 gained questions 47 (FO abort behaviour) and 48 (the production edge). No application code was changed.

**Revision 3.5 (27 September 2026)**, RP3 detailed architecture, awaiting decisions and the independent review. RP3 now holds the proposed corrected architecture for login protection: a threat model (T1–T12); a reordered route (same-origin gate and JSON-only before the body, RP1's `small-json` class, schema, reserve, `foLogin`, classify, settle); two independent limiter dimensions, an account bucket of failures keyed by an HMAC of the normalised email while the credential sent to FO is untouched (FO matches `email` case-sensitively and unnormalised, [FO-clone] `lib/storage.ts:44-48`), and a source token bucket keyed by RP1's `clientIdentity`, with a `null` identity disabling the source dimension loudly rather than sharing one bucket; a reserve-then-settle protocol that counts before the FO call and refunds indeterminate outcomes; success clears only the authenticated account; a `CounterStore` interface whose shared implementation waits for CP5 and whose token-bucket primitive serves RP1's G31 cap; the same-origin helper RP2's logout already names, with the same fail-open-on-absent-headers rule; structured `login_attempt` events. Open for the team: the account policy and its values (progressive delay recommended over hard lockout), the source rate, alerting, password reset in the PWA (§9 question 46), and FO's own unthrottled login (§9 question 45). **Delta review record (27 September 2026), sequence as it happened.** (1) Architecture changed in this revision: the RP2 login-flow fact about suspended accounts (RP2 step 2), the RP1 → RP3 dependency (§2, §5, §8.1), CP3's suspended-account item, §9 questions 44 to 46; affected frozen RPs RP2 and RP1. (2) Delta review run with the `general-purpose` subagent and the charter's DELTA mode against the 3.4 baseline diff. (3) Findings: RP2-D1 FIX NOW (FO's login 403 is pre-password, so a distinct presentation would be an account-status oracle), RP1/RP3-D2 FIX NOW (the §5 row folded two directions into one edge; namespaced keys and per-namespace capacity needed), RP2/RP3-D3 DEFER (derive `self` from `PUBLIC_ORIGIN`, owner RP3 part 5 and CP5). The reviewer's verdict line read `DELTA SAFE`, qualified: the corrected fact did not invalidate RP2's flows, states or tests, and the two FIX NOW items were text corrections to be applied before RP3's review consumed the statements. (4) Corrections applied in revision 3.6 (RP2 step 2 split into the pre-password and post-password paths; §5 row; RP3 parts 3, 5, 6 and stage 9; CP3; G23 wording). (5) Because the RP2 step 2 correction changes a presentation rule in a frozen RP, it is itself substantive, and the follow-up delta review the workflow requires **had not been run when revision 3.6 was published**; it is run in revision 3.7 together with the G10 test-cell correction (see the revision 3.7 record). Until that review returns `DELTA SAFE`, RP2 is frozen with a pending delta, not clean. Three consistency corrections found while restoring context: the RP1 → RP3 dependency edge (implied by RP3's design text and the m1 row, missing from §2 and §5) is added; RP3's stale "shared accounts: needs the team" entry now records the 24 September decision; and a factual error in RP2's login flow is corrected without changing the flow: the clone's login refuses suspended accounts at login (`login/route.ts:29-42`), so the RP2 probe's suspended branch is defence in depth, not the primary path. §9 question 44 and CP3 adjusted accordingly.

**Revision 3.4 (24 September 2026)**, clarification pass; RP1 and RP2 frozen for this design pass. Session end now states its order as the rule: clear local authentication state and respond first, then attempt FO revocation post-response under the bounded deadline, then record the outcome; the gateway-refusal wording that read as revoke-then-clear was corrected, and the hanging-FO test asserts a prompt response, not merely one inside the deadline. The anonymous-relay issue is now finding G31, owned by RP1: registry rows carry `auth: required` or `auth: optional`, `required` rows are refused without forwarding, and the two public rows are rate-capped per client identity. The forced-password-change flow is recorded as an external FO go-live dependency (CP5 input 6; §9 question 44): the PWA cannot complete the lifecycle if production FO does not clear `forcePasswordChange`. The logout same-origin gate's fail-open on absent headers is justified in the design and pinned by three tests. One stale contract cell ("streamed") was corrected to the revision 3.1 buffer-measure-forward rule.

**Revision 3.3 (24 September 2026)**, adversarial review of RP1 and RP2. Two corrections that closed real gaps: the client-identity rule now trusts only the value the edge itself writes (`fly-client-ip` on Fly; the N-th-from-last `x-forwarded-for` entry on AWS via `TRUSTED_PROXY_HOPS`), because the earlier "first entry" option would be forgeable behind an appending proxy; and the gateway's refusal of an expired or mismatched bearer now revokes the FO token before clearing the cookie, because a clear-only refusal left the token unrevoked on the main embedded expiry path (FO evicts lazily, so an unused row persists until the 30-day expiry). Smaller corrections: the body policy applies to the PWA's own routes because the framework ceiling is global (login `small-json`, a pre-check on the native chat route until it retires); the FO cookie now expires with the PWA session; the login probe revokes the token of a suspended account and tolerates probe failures; the logout same-origin gate fails open when no header is present; storage failure at login ends the session; a marker-forgery and middleware-bypass test; a combined RP1/RP2 expiry scenario test. Recorded for the FO owners: production's change-password may not clear `forcePasswordChange` (§9, question 44).

**Revision 3.2 (24 September 2026)**, RP2 detailed architecture. The two-credential model is kept and stated as rules (FO token only in the httpOnly cookie; PWA bearer in localStorage because FO's embedded client requires it; a cookie alone never authenticates; no PWA session store; one account per person). One server and one client end-of-session path close m3 and the logout hang; the gateway clears the cookie on expired or mismatched refusals (G5); key rotation uses explicit non-secret key ids with verify-only previous keys (m2); a login-time `/me` probe detects FO's forced-password-change state, which FO signals only on later calls (G20); the PWA writes FO's session-blob shape (new G30). Decisions by Amay on 24 September: 12-hour absolute limit kept; FO's API-activity idle semantics kept; stateless, FO is the revocation authority; shared accounts not a PWA requirement; G10 accepted and recorded as an architectural risk mitigated by RP7. CP2 and §9 mark the decided items.

**Revision 3.1 (24 September 2026)**, RP1 body limits made two-tier after a deployment clarification: the 512 MB Fly machine is the present preview/development deployment, not the production target (AWS). The application policy limit (20 MiB, now marked provisional) is separated from the framework transport ceiling (`proxyClientMaxBodySize`, proposed 25 MiB), with a startup assertion that the ceiling exceeds the policy. A runtime probe (Appendix B) showed that with the two equal, a chunked body just over the limit is silently truncated and forwarded as complete, and that with headroom the gateway measures and refuses it; also that Next applies the ceiling at startup and receives the whole upload before the route runs. The gateway now buffers, measures and forwards every body class with its own `content-length`, so no partial body can reach FO. AWS-dependent items (instance memory, ALB/API Gateway/Lambda limits, the concurrent-body cap) are routed to RP10-B / CP5.

**Revision 3.0 (24 September 2026)**, RP1 detailed architecture. The fixed target is restated (installed PWA → same-origin gateway → the real FabOrchestrator, `whole` mode; the native screens retire). RP1 now holds the proposed corrected architecture: component responsibilities, four request flows, the route policy table built from FabOrchestrator's route files, the body policy with the 20 MB limit and its justification, the client-identity rule, two-origin redirects, the preview opt-in flag, a finding map and the test suite. Decisions taken by Amay on 24 September: Master Data Load stays available; explicit API allow-list; `whole` mode; trusted client identity forwarded to FO; body limit 20 MB (from repository evidence). CP0, CP1 and §9 mark the decided items; RP3 records the account-plus-source keying confirmation.

**Revision 2.2 (24 September 2026)**, after an enterprise-readiness review of five topics (supply chain, ASVS-style verification, staged deployment and rollback, browser and device matrix, incident and vulnerability response). Each was first assigned a responsibility (PWA, FabOrchestrator, shared, or organisational); only the PWA's share entered the plan, as small additions to existing packages and checkpoints:
- G28 (dependency audit, lockfile gate, update automation) → RP10-A, with the threshold and cadence decided at CP5.
- G29 (deploy strategy, staged cutover, rehearsed rollback, response runbook of PWA-side levers) → RP10-B and CP5. The organisation's incident process is a CP5 question, not a plan deliverable.
- CP4 now brings an ASVS-mapped checklist of the PWA's own controls and decides the level, and decides the browser and device matrix that RP9's tests run on.
- §9 questions 39–43 record the FO-side and organisational dependencies; Appendix A gains five rows.

**Revision 2.1 (23 September 2026)**, after a second review pass on revision 2:
- RP4: the production chat call (`foChat`) is a stream and gets only the headers deadline plus the lifetime cap, never the bounded class; every `fetchFo` caller names its class; a 65-second streamed-answer test added.
- Live FO contract checks added to RP1, RP4 and RP6, and scoped in RP2: read-only, or confined to a dedicated test account's own data, because preview is connected to production FO.
- The text graph now shows the RP0 → RP2 edge; a note that checkpoint numbers are identifiers, not a sequence.
- [team-record] tags on the gateway being the chosen design and on the preview's upstream being production FO.
- CP3 now asks for a new percentile measurement run, since the existing scripts record medians of a few runs.
- RP7 stage 1 (the CSRF invariant test) moved to phase 1.

**Revision 2 (23 September 2026)**, after a design-review audit:
- Recorded Jothi's 2026-09-06 embedding requirement as the given direction; RP0 and CP0 now decide delivery, not direction.
- Corrected "the review predates the gateway": the review covered committed `main`; the gateway is uncommitted.
- Corrected RP4: `maxDuration` is not enforced by `next start`; added a PWA-enforced total lifetime cap (G22) and a sign-out deadline (G21).
- G2 is now verified at runtime, with its two outcomes (a misleading 502, or silent truncation).
- Added verification findings G13–G27 from the audit: method allow-list, API subtree breadth, the MDL exclusion conflict, two-origin redirects, the preview-only UI split, preview governance, forced password change, error-mapping inconsistencies, response-header policy, the CSRF invariant, and capacity.
- Restructured packages:
  - B5 → RP1 (the same body-buffering mechanism as G2);
  - RP6 slimmed to gateway authorisation;
  - RP7 slimmed to browser security policy;
  - RP8 now holds every native-chat, cockpit and reports finding (B1, M8, M13, m6, m7, m8, m19, N5 and N6 moved in);
  - RP10 split into RP10-A (enablers, with m16 and N1) and RP10-B (readiness);
  - G13 joined G4 in RP1 as one client-identity decision.
- Removed the RP3 → RP2 dependency, and work on native routes that retire (the streaming wrapper and the M6 migration).
- Added the per-mode idle table, the in-stream failure contract, the load-test matrix, live FO contract checks, and a B1 red-then-green requirement.
- Corrected N6's scope (PROD), m2's description (key management), and evidence tags on FO-dependent and inferred claims.

**Revision 1 (23 September 2026):** initial plan.
