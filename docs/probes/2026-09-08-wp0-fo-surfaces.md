# FabOrchestrator surface probe — 2026-09-08T19:00:57.084Z
Target: `https://d7y8a8whrch88.cloudfront.net`

## Surfaces (unauthenticated)
| Path | Status | Content-Type | Cache-Control | Frame / CSP | Cookies set | Notes |
|---|---|---|---|---|---|---|
| `/` | 200 | text/html | s-maxage=31536000 | no XFO, no CSP | AWSALB, AWSALBCORS | 16 js, 3 css, 2 fonts, 21 /_next refs; no absolute asset URLs; no manifest link; no apple-web-app meta; viewport: width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes |
| `/chat` | 200 | text/html | s-maxage=31536000 | no XFO, no CSP | AWSALB, AWSALBCORS | 22 js, 4 css, 2 fonts, 28 /_next refs; no absolute asset URLs; no manifest link; no apple-web-app meta; viewport: width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes |
| `/reports` | 200 | text/html | s-maxage=31536000 | no XFO, no CSP | AWSALB, AWSALBCORS | 19 js, 4 css, 2 fonts, 25 /_next refs; no absolute asset URLs; no manifest link; no apple-web-app meta; viewport: width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes |
| `/settings` | 200 | text/html | s-maxage=31536000 | no XFO, no CSP | AWSALB, AWSALBCORS | 16 js, 3 css, 2 fonts, 21 /_next refs; no absolute asset URLs; no manifest link; no apple-web-app meta; viewport: width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes |
| `/home` | 200 | text/html | s-maxage=31536000 | no XFO, no CSP | AWSALB, AWSALBCORS | 19 js, 4 css, 2 fonts, 25 /_next refs; no absolute asset URLs; no manifest link; no apple-web-app meta; viewport: width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes |
| `/modeling-agent` | 200 | text/html | s-maxage=31536000 | no XFO, no CSP | AWSALB, AWSALBCORS | 22 js, 4 css, 2 fonts, 28 /_next refs; no absolute asset URLs; no manifest link; no apple-web-app meta; viewport: width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes |
| `/manifest.webmanifest` | 404 | text/html | private, no-cache, no-store, max-age=0, must-revalidate | no XFO, no CSP | AWSALB, AWSALBCORS |  |
| `/sw.js` | 404 | text/html | private, no-cache, no-store, max-age=0, must-revalidate | no XFO, no CSP | AWSALB, AWSALBCORS |  |
| `/favicon.ico` | 200 | image/x-icon | public, max-age=0, must-revalidate | no XFO, no CSP | AWSALB, AWSALBCORS |  |
| `/wp0-does-not-exist` | 404 | text/html | private, no-cache, no-store, max-age=0, must-revalidate | no XFO, no CSP | AWSALB, AWSALBCORS |  |

## Chunk, CORS, API envelope, plain http
- Chunk `/_next/static/chunks/691d640dd1298ee5.js`: 200; cache-control `public, max-age=31536000, immutable`; content-encoding `gzip`; length ?
- OPTIONS /api/chat from a foreign origin: 204; Access-Control-Allow-Origin: absent; Allow: GET, HEAD, OPTIONS, POST
- GET /api/auth/me without a token: 401; error.type `SESSION_TIMEOUT`; keys `error`
- Plain http → 301 → https://d7y8a8whrch88.cloudfront.net/chat

## Signed in as the probe account
- login 200; session expires 2026-10-08T19:00:58.208Z; role `Business User`
- MCP connections: 3
  - CMF_Assembly_DB_Test3: connected, 11 tools
  - Jira_Tickets: disconnected, 7 tools
  - CM MES - Assembly (Use Cases): connected, 9 tools
- pinned reports: 13 (canManage false)
- fabinsight access: {"canCreateDashboards":false}; modeling access: {"enabled":true}
- models: default claude-opus-4-7; claude-opus-4-7, claude-sonnet-5, claude-opus-4-8
- logout 200
