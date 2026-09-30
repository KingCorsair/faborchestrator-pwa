# WP8 — one visit to the embedded chat, cold then warm — 2026-09-09T21:09:28.971Z
`https://faborch-embed-preview.fly.dev` · iPhone 13 emulation · Chromium

## The visit
| | First load (empty cache) | Second load (warm cache) |
|---|---|---|
| time to first byte | 55 ms | 77 ms |
| interactive (DOMContentLoaded) | 588 ms | 241 ms |
| finished loading | 830 ms | 243 ms |
| requests | 40 | 40 |
| …served from the browser's own cache | 1 | 32 |
| bytes over the wire | 1308 KB | 17 KB |

FabOrchestrator serves its chunks `immutable` and the gateway forwards that header
untouched, so the second visit is the one an operator actually lives with. The first
is paid once per deploy.

## What FabOrchestrator's client requested, in order
| Path | Status |
|---|---|
| `/api/platform-theme` | 200 |
| `/api/auth/me` | 200 |
| `/api/user/models` | 200 |
| `/api/mcp/connections` | 200 |
| `/api/fabinsight/access` | 200 |
| `/api/fabinsight/warm` | 200 |
| `/api/conversations` | 200 |

`GET /api/conversations` **was** requested (HTTP 200) on the way in — which is
what WP8's cache warming depends on: the list that proves conversation ownership has
already crossed the gateway before the operator can type a word into a thread.

