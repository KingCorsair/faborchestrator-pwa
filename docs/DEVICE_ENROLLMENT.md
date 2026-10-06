# Approved devices: one-time enrollment

**As of 6 October 2026.** On `pwa/amay-embed-fo-production-hardening`. Not pushed,
not deployed. Code: `lib/devices/`, `proxy.ts`, the routes below.

## The requirement

Only a device that has been through a one-time enrollment, issued by an
administrator after business approval, may open anything on this origin. The
device check comes **before** sign-in:

```
device check (proxy.ts, lib/devices/gate.ts)
  → user session (sign-in gate, requireAuth)
  → FabOrchestrator's own authorization
  → FabOrchestrator
```

The same account on a second, unenrolled phone is blocked: approval belongs to
the device, not to the account. The device system is an extra gate; it does not
replace or change FabOrchestrator's users or permissions, and FabOrchestrator is
not changed.

## How it fits this app

| Question | Answer in this repository |
|---|---|
| Frontend / backend | One Next.js 16 app (App Router). Route handlers are the backend; `proxy.ts` (Next's middleware, Node runtime) sees every request first. |
| Database | None. Durable state is append-only, checksummed JSON-lines files on a Fly volume (the seat store). The device store follows the same pattern. |
| Auth | FabOrchestrator is the only identity (`foLogin`). This app mints a signed bearer (localStorage) bound to FO's httpOnly cookie. |
| PWA | `manifest.webmanifest`, `public/sw.js` (navigation fallback to `/offline` only; caches no data). |
| QR | A static QR of the app URL (`scripts/generate-qr.ts`), scanned with the phone's **native camera**. There is no in-app scanner. |
| Admin console | None in this app; FabOrchestrator's admin app is separate and not changed. So `/device-admin` is new, here. |

## The flow

**Enrollment.**

1. An administrator (`DEVICE_ADMIN_EMAILS`, on an approved device, signed in)
   opens `/device-admin` and creates an enrollment for a user's email.
   `POST /api/pwa/device-enrollments` stores the **SHA-256 of a 256-bit random
   token** and answers once with `<PUBLIC_ORIGIN>/device-enroll/<token>`, its QR
   code and the expiry (10 minutes by default).
2. The user opens the link on the device. `GET /device-enroll/<token>` checks it
   exists, is unexpired and unused, moves the token into a short-lived httpOnly
   cookie and redirects (303, `Referrer-Policy: no-referrer`) to the bare
   `/device-enroll`. The token leaves the address bar. Opening the link spends
   nothing, so link previews cannot burn it.
3. The user signs in on that page. `POST /api/pwa/device-enrollments/complete`
   checks the enrollment again, checks the typed email is the enrollment's
   user, then FabOrchestrator verifies the password and must name the same user.
   The FabOrchestrator session this creates is revoked; enrollment does not sign
   anyone in.
4. The store uses the enrollment **exactly once** and mints `DEVICE-nnn` plus a
   256-bit device token; it keeps only the token's hash.
5. The browser receives `__Host-fo_device=<DEVICE-nnn>.<token>` (HttpOnly,
   Secure, SameSite=Lax, Path=/, 400 days, renewed at each sign-in). The token
   is never in a response body and no API returns it again.

**Every request.** `proxy.ts` reads the cookie, looks the device up, compares
the token's hash in constant time, and requires `APPROVED`. Otherwise:
documents redirect to `/device-blocked`, APIs get `403 device_not_approved`,
assets `403`. Exempt: the blocked and enrollment pages, the enrollment link and
completion, sign-out, `/offline`, the service worker, manifest and icons, and
this app's own build chunks. None carries FabOrchestrator data.

**Sign-in.** The login route re-checks the device and refuses an account other
than the one the device was enrolled for (`403 device_user_mismatch`, FO token
revoked). The credential is renewed.

**Revocation.** `POST /api/pwa/devices/{id}/revoke` appends a revocation with
the administrator and time. The proxy re-reads the store whenever the file
changes, so the device is refused **on its very next request**, including
requests carrying an existing session. When the phone next opens anything it
lands on `/device-blocked`, which signs out: the server clears the
FabOrchestrator cookie and revokes that FabOrchestrator session.

**Replacement.** A new phone needs a new enrollment and gets a new id and
token. Re-enrolling a browser that still holds an approved credential revokes
that credential.

**Cleared storage.** No cookie means unenrolled. There is no recovery from
metadata; enroll again.

## Security decisions

- **HttpOnly cookie, not IndexedDB.** The check must happen in front of the
  document, and only a cookie arrives with a navigation. HttpOnly keeps the
  secret away from page scripts, including FabOrchestrator's pages on this
  origin. `__Host-` stops sibling hosts and path shadowing; two cookies of the
  name count as none.
- **Hashes only.** Enrollment and device tokens: 32 bytes from
  `crypto.randomBytes`, base64url; SHA-256 on the server; constant-time compare.
- **One-use under races.** Using an enrollment first creates a marker file with
  `O_EXCL`; exactly one creator wins, across processes on the volume. A crash
  after the marker burns the enrollment rather than allowing a second device.
- **Fails closed.** `DEVICE_GATE` other than unset/`off` enforces. An unset or
  unreadable store blocks everything. A torn, altered or orphaned record grants
  nothing.
- **CSRF.** State-changing routes refuse cross-site `Sec-Fetch-Site`/`Origin`
  and require JSON; admin routes also need the bearer, which a forged form
  cannot send.
- **Rate limiting.** Enrollment completion uses the sign-in limiter; bad
  enrollment links count against a separate per-address bucket.
- **Links from `PUBLIC_ORIGIN` only,** never the `Host` header.
- **Headers on the device pages:** CSP (`default-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`), `no-referrer`,
  `X-Frame-Options: DENY`, `no-store`. Scripts still need `'unsafe-inline'`
  (the root layout and Next's hydration use inline scripts; no nonce plumbing).
  No CSP was added to FabOrchestrator's proxied pages.
- **Audit.** `device_audit` log lines: `DEVICE_ENROLLMENT_CREATED`,
  `DEVICE_ENROLLMENT_REJECTED`, `DEVICE_ENROLLED`, `DEVICE_REENROLLED`,
  `DEVICE_ACCESS_ALLOWED` (when last-seen is written, at most every 15 minutes
  per device), `DEVICE_ACCESS_BLOCKED` (bounded to one per reason, device and
  address per minute), `DEVICE_REVOKED`, `DEVICE_LOGIN_REFUSED`. Identifiers
  only; tests check that no token reaches a log line. The store file is the
  durable audit of who enrolled and revoked what.
- **Metadata is description only** (type, OS, browser, installed app or
  browser, from the user agent and display mode). No decision reads it.

## Limitations (read these)

- **It is a bearer credential.** It identifies the browser or installed app
  that holds the cookie, **not** the physical phone. Anyone who copies the
  cookie's value can present it until the device is revoked. It does not prove
  a serial number. The upgrade, if cloning resistance is needed, is a
  non-exportable device key with challenge-response (WebAuthn) or an enterprise
  device identity (Entra/Intune); only `lib/devices/credential.ts` and the
  check in `gate.ts` would change.
- **iOS: Safari and the installed Home Screen app keep separate cookies.**
  The existing QR is scanned with the native camera, which opens **Safari**.
  Enrolling there enrolls Safari, not the installed app (this app's own seat
  work found the same separation for its seat cookie; whether iOS copies
  cookies into the app at install time was not verified here). So: install the
  app first, open it (it shows "not approved"), and paste the enrollment link
  there; `/device-admin` shows a Copy link button and the enrollment page warns
  when it is opened in a browser rather than the app. The admin list shows each
  device's context (`installed-app` or `browser`). Not tested on a real iPhone.
- **Android:** an installed Chrome PWA shares Chrome's cookies, so enrolling
  from the camera's Chrome tab should cover the app. Expected, not tested on a
  device.
- **The everyday QR is unchanged.** Scanning it in an enrolled context opens the
  app and passes; scanning it in another context (Safari on an iPhone whose
  enrollment is in the app) is blocked, correctly.
- **FabOrchestrator sessions after revocation.** Through this app the revoked
  device is refused at once. Its FabOrchestrator session token (httpOnly, never
  on the page) is revoked when the device next opens a page here; if it never
  comes back, FabOrchestrator's own 30-minute idle rule ends it. This app keeps
  no FabOrchestrator tokens server-side, so it cannot revoke one it is not shown.
- **The administrator allowlist is an environment setting**, not
  FabOrchestrator's role names, which this app cannot rely on.
- **One machine, one volume,** like the seat store.
- **`/device-admin` has no link** from FabOrchestrator's screens; open it by URL.
- **Shared accounts:** devices are bound to the account they were enrolled for.
  Several people on one shared account each need their own device enrolled for
  that account.

## Rolling it out (hardening app)

1. Deploy with `DEVICE_GATE = "off"` (as `fly.hardening.toml` now has it) and
   `flyctl secrets set DEVICE_ADMIN_EMAILS=…`. Nothing changes for anyone yet.
2. Issue the first administrator's enrollment from the machine:
   `flyctl ssh console --app faborch-pwa-amay-hardening -C "su-exec nextjs:nodejs node scripts/device-enrollment.mjs --email <admin>"`,
   open the printed link on the administrator's device, sign in.
3. From `/device-admin`, enroll every device that should keep access.
4. Set `DEVICE_GATE = "enforce"` and redeploy. Rollback: set it back to `off`.

## Manual acceptance test

With the gate enforced and an administrator enrolled:

- **A** Phone A, not enrolled, opens the normal QR → "This device is not
  approved".
- **B** Admin creates an enrollment for the user at `/device-admin`; Phone A
  opens it (inside the installed app on an iPhone: paste the link), signs in →
  "approved as DEVICE-002".
- **C** Phone A opens the normal QR → sign-in → FabOrchestrator.
- **D** Phone B, same account, not enrolled → blocked, and its sign-in is
  refused.
- **E** Admin revokes DEVICE-002 → Phone A's next tap lands on "not approved".
- **F** Phone B gets its own enrollment → DEVICE-003 works on its own; DEVICE-002
  stays blocked.

## Verified (6 October 2026)

- `npm test`: 923 tests (879 existing, unchanged in behaviour; 44 new in
  `__tests__/devices/`), `tsc`, `eslint`, `next build`.
- Over the wire against `next start` (production build) with the gate enforced
  and a stub FabOrchestrator: scenarios A–F plus link handling, CSP, admin list
  and store contents, **25 of 25**; none of the six secrets of the run appeared
  in the server log; page JavaScript saw no cookie. The store file was deleted
  under the running server between runs and enrollment kept working.
- Not run: a real iPhone or Android device, the real FabOrchestrator, or the
  deployed hardening app.
