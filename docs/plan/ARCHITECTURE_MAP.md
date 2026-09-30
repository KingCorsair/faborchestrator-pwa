# Architecture map

Companion to `MASTER_PLAN.md`. Diagrams, the real file and endpoint inventory,
and the option-by-option comparison including the single-login problem.

---

## 1. Current PWA — as it runs today

```
 iPhone (installed PWA, standalone)
   │
   │  httpOnly faborch_token  +  HMAC session (lib/auth.ts)
   ▼
 PWA · Fly.io "faborch-demo", region sin
   │
   ├─ proxy.ts ───────────────── session gate, deny-by-default
   │
   ├─ app/api/faborch/[agent]/chat/route.ts
   │     • requireAuth
   │     • foTokenFrom(req)                     ← cookie, never in JS
   │     • foConnectedMcpIds(token)             ← +1 serial FO round trip
   │     • ownsConversation(token, id)          ← +1 when resuming
   │     • foChat(...)  ──────────────┐
   │                                  │
   ├─ app/api/faborch/conversations/* │  history proxy, strips tool parts
   ├─ app/api/faborch/reports/*       │  pinned dashboards, read-only
   │                                  ▼
   │                        FabOrchestrator (CloudFront → ALB → EB)
   │                            /api/chat
   │                              model · MCP · MES
   │                            ← UI message stream (SSE)
   │
   ◄── piped, never buffered ── new Response(upstream.body)
   │
   ▼
 components/fab/screens/agent-chat.tsx
   lib/faborch/stream.ts      frames  → events
   lib/faborch/conversation.ts events  → turns   (pure reducer)
   lib/faborch/artifacts.ts   text     → segments
   .fab-md                    markdown → DOM
```

### Endpoint inventory — PWA

| Route | Purpose |
|---|---|
| `app/api/auth/login/route.ts` | FO sign-in, mints the session, sets the cookie |
| `app/api/auth/logout/route.ts` | revocation |
| `app/api/auth/me/route.ts` | session + `faborch` flag |
| `app/api/faborch/[agent]/chat/route.ts` | **the one chat proxy, all agents** |
| `app/api/faborch/conversations/route.ts` | list / create |
| `app/api/faborch/conversations/[id]/route.ts` | load (stripped) / pin |
| `app/api/faborch/reports/route.ts`, `[id]` | pinned dashboards |

### Endpoint inventory — FabOrchestrator, verified in production

| Endpoint | Status | Body / notes |
|---|---|---|
| `POST /api/chat` | live | `messages, model, activeMcpIds, webSearch, enableReasoning, conversationId` |
| `POST /api/modeling-agent/chat` | live | `messages, conversationId` — **no model, no MCP ids** |
| `GET /api/modeling-agent/access` | live | `{enabled:boolean}` — the capability probe |
| `POST /api/modeling-agent/chat/parse-upload` | live | multipart |
| `GET /api/modeling-agent/chat/download/[id]` | live | file out |
| `GET /api/modeling-agent/chat/parent-options/[targetType]` | live | form data |
| `GET/POST /api/conversations` | live | `?agent=chat` \| `modeling` |
| `GET/PATCH/DELETE /api/conversations/[id]` | live | ownership-checked |
| `GET /api/conversations/[id]/messages` | live | |
| `GET /api/mcp/connections` | live | bare array, `status:"connected"` |
| `GET /api/fabinsight/pinned` | live | |
| `GET /api/artifacts?conversationId=` | live | |
| `POST /api/backend-agent/chat` | **404** | in source, not deployed |
| `POST /api/agent`, `/api/orchestrate` | **404** | no orchestrator |
| `/admin`, `/api/admin/*` | **404** | separate host |

---

## 2. Option B — Generic Agent Host (recommended, short term)

```
 lib/faborch/agents.ts                     ← ONE descriptor per agent
   {
     id, slug, label, blurb, chips,
     foPath:            "/api/chat" | "/api/modeling-agent/chat",
     historyAgent:      "chat" | "modeling" | null,
     requestProfile:    "chat" | "minimal",
     access:            null | "/api/modeling-agent/access",
     capabilities: { history, mcp, artifacts, uploads, downloads }
   }
        │
        ├──────────────── server ────────────────┐
        │  app/api/faborch/[agent]/chat/route.ts │
        │    reads the descriptor, then:         │
        │      lib/faborch/request-profiles.ts   │ ← body built per profile
        │      lib/faborch/access.ts             │ ← permission probe, cached
        │      lib/faborch/owns.ts               │ ← history bucket from descriptor
        │      lib/faborch/client.ts foChat()    │ ← takes a body, does not build one
        └────────────────────────────────────────┘
        │
        └──────────────── client ────────────────┐
           app/agent/[slug]/page.tsx             │ ← ONE page for every agent
             components/fab/screens/agent-chat.tsx
               capabilities drive: drawer on/off,
               composer, uploads, artifact tiles
        └────────────────────────────────────────┘
```

**Adding an agent:** one object. Adding an agent with a new capability: one
object plus one adapter behind a declared flag.

---

## 3. Option C — Unified FO orchestrator (long term)

```
 PWA (thin client)
   │  POST /api/orchestrate { message, conversationId?, context? }
   │  GET  /api/agents        → capability discovery
   ▼
 FabOrchestrator
   agent selection · permissions · MCP selection · history
   artifacts · streaming
```

**FO changes required — none of this exists today:**

1. `POST /api/orchestrate` — one entry point, stable contract.
2. `GET /api/agents` — discovery: id, label, capabilities, permission state for the caller.
3. Server-side agent selection (routing), which FO does not have.
4. A uniform permission answer, replacing per-agent gates like `modeling_agent`.
5. A uniform artifact/file contract across agents.
6. Versioning, so a client is not broken by a routing change.

Until these exist the PWA cannot be thin. The Generic Host is the same client
with the descriptors kept locally instead of fetched.

---

## 4. Option D — Embedding, and the single-login problem

### What was measured

| Question | Answer | Evidence |
|---|---|---|
| Does FO set `X-Frame-Options`? | **No** | `curl -D -` on `/`, `/chat`, `/home` |
| Does FO set a CSP? | **No** | same; `next.config.ts` has no `headers()` |
| Does FO render in a cross-origin frame? | **Yes** | loaded from another origin |
| Does the framed session carry over? | **No** | `/chat` redirected to the marketing page — signed out |
| Where does FO keep its session? | `localStorage["llmatscale_auth_token"]` | `app/chat/page.tsx` |
| CORS on the API? | **None** | `OPTIONS /api/chat` → 204, no `Access-Control-Allow-Origin` |

The PWA's `faborch_token` is httpOnly on the PWA origin. A cross-origin frame
has its own partitioned storage. **There is no supported way to hand the session
across**, so an iframe means a second login — and on iOS that second session
sits in ITP-managed partitioned storage.

### Session-sharing designs, ranked

| # | Design | PWA change | FO change | Works with FO today | iOS |
|---|---|---|---|---|---|
| 1 | **Reverse-proxy FO under the PWA origin** (`/fo/*`) | rewrite + asset handling | possibly `basePath`/`assetPrefix` | partly | **best** — same origin, no partitioning |
| 2 | **Short-lived handoff token**: PWA mints a one-time code, FO exchanges it | small | **new endpoint** `POST /api/auth/exchange` | **no** | good |
| 3 | **Shared parent domain cookie** (`app.fo.ai` / `pwa.fo.ai`) | cookie domain | cookie domain + CORS | **no** | good, needs real DNS |
| 4 | `postMessage` the token into the frame | small | frame must accept it | **no** | **rejected** — puts a live credential in JS on both sides |
| 5 | Log in twice | none | none | yes | **poor** — ITP eviction |

**Recommended if embedding is ever pursued: #1, and only #1.** Same-origin
removes the storage-partitioning problem completely rather than working around
it. It costs asset proxying and egress, and it does not reduce latency — it adds
a hop.

**Explicitly rejected: #4.** Never send a credential into frame code.

### What embedding costs regardless of the auth fix

- The service worker cannot cache a cross-origin frame → offline page is lost over that region.
- Navigating to FO's origin leaves `manifest.scope: "/"` → iOS drops out of standalone.
- FO's chat is desktop-first (16rem rail); the PWA's mobile work is bypassed.
- The drawer, `?c=` deep links and artifact sheets stop applying to framed content.

---

## 5. Single-login flow — recommended shape (no FO change)

This is what already happens, and it is why the PWA has no second login:

```
 user → PWA /login
   POST /api/auth/login
     └─ FO POST /api/auth/login  { email, password }
          ← { token }                       FO session token
     ├─ Set-Cookie faborch_token  httpOnly, Secure, sameSite=lax
     └─ HMAC session bound to fp(faborch_token)     lib/auth.ts

 every later call:
   browser → PWA (cookie, never readable by JS)
             PWA → FO  Authorization: Bearer <faborch_token>
```

The credential is entered once, on a screen the PWA controls, and the FO token
never reaches client JavaScript. **Any embedding design must preserve this
property or it is a regression**, which is the specific reason design #4 is out.

---

## 6. History flow

```
 drawer opens
   GET /api/faborch/conversations
     → FO GET /api/conversations?agent=<descriptor.historyAgent>
     → toSummaries()   id, title, isPinned, updatedAt   (drops isShared, model, agent)

 row tapped  →  /agent/<slug>?c=<uuid>
   GET /api/faborch/conversations/[id]
     → FO GET /api/conversations/{id}       (ownership-checked by FO)
     → toTurns()   text only; drops tool-*, step-start, reasoning, file-download
     → continuable = every turn ≤ MAX_TEXT
     measured: 1,306 KB thread → a few KB on the wire

 first send
   POST /api/faborch/conversations  → FO creates → id
   POST /api/faborch/<agent>/chat   { messages, conversationId }
     → route proves ownership before forwarding      lib/faborch/owns.ts
     → FO /api/chat writes both turns
```

**Why the ownership check exists:** FO's `/api/chat` accepts a `conversationId`
and never verifies it belongs to the caller — no `getConversation`, no `userId`
comparison, straight to `addMessage` and the S3-reference lookup. Every other
conversation route in FO checks. This is an upstream gap; the PWA refuses to be
a vehicle for it. **This check must survive every refactor in this plan.**

---

## 7. Artifact flow

```
 FO text-delta stream
   …<antArtifact identifier type title>…</antArtifact>…
        │  lib/faborch/artifacts.ts  (regexes byte-identical to FO's parser)
        ▼
   segments: text | artifact
        ├─ text     → .fab-md (react-markdown + remark-gfm)
        └─ artifact → ArtifactTile → ArtifactSheet
                        <iframe sandbox="allow-scripts">   ← never allow-same-origin
```

Under a Generic Host this becomes `capabilities.artifacts`. Agents that never
emit them skip the parser entirely.

---

## 8. Deployment boundaries

```
┌ GitHub KingCorsair/faborchestrator-pwa ┐   ┌ FabOrchestrator (not ours) ┐
│  Fly.io  app faborch-demo, region sin  │   │  CloudFront → ALB → EB     │
│  1 machine, auto_stop=false            │   │  Postgres · S3 · Anthropic │
│  no database, no model key             │   │  MCP servers → MES         │
└────────────────────────────────────────┘   └────────────────────────────┘
        └────── HTTPS, Bearer, ~357 ms round trip ──────┘
```

Measured: client→Fly 212 ms · Fly→FO 357 ms · client→FO direct 91 ms.
Pre-stream overhead ~1.9 s; FO's own work 12–39 s.

---

## 9. Files a new engineer should read first

| Order | File | Why |
|---|---|---|
| 1 | `lib/faborch/agents.ts` | the registry this plan widens |
| 2 | `app/api/faborch/[agent]/chat/route.ts` | the one proxy; where the adapter goes |
| 3 | `lib/faborch/client.ts` | `foChat()` — the body construction to extract |
| 4 | `components/fab/screens/agent-chat.tsx` | the screen to make capability-driven |
| 5 | `lib/faborch/conversation.ts` | already generic; the model to copy |
| 6 | `lib/faborch/history.ts` | the stripping boundary |
| 7 | `lib/faborch/owns.ts` | the security property that must not regress |
| 8 | `CLAUDE.md` | the rules — especially "what NOT to build" |
