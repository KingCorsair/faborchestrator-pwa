# Approved devices: one-time enrollment

**As of 6 October 2026.** On `pwa/amay-embed-fo-production-hardening`. Code:
`lib/devices/`, `proxy.ts`, the routes below. Deployed to
`faborch-pwa-amay-hardening` with the gate **off**.

## In one picture

```
Enrollment (once per device)
  admin creates a one-time QR at /device-admin
    → the device scans it
    → the device stamp is installed automatically   (no email, no password)
    → the device is APPROVED

Normal use (every time)
  normal FO QR / front door
    → device stamp checked FIRST
         no stamp, unknown or REVOKED → BLOCKED
         APPROVED                     → normal FabOrchestrator sign-in → FO
```

**The enrollment QR authorizes a device. It does not authenticate a person.**
Holding the QR within its ten minutes is permission to approve exactly one
device. Nobody signs in during enrollment and FabOrchestrator is not asked
anything. Who uses an approved device is decided by the normal FabOrchestrator
sign-in, every time, and FabOrchestrator's own permissions decide what that
person may do. The device belongs to no user: any FabOrchestrator account may
sign in on it.

Three separate concerns:

| Concern | Decided by |
|---|---|
| Who may open `/device-admin`, create QR codes, revoke devices | `DEVICE_ADMIN_EMAILS` (plus an approved device and a session) |
| Which device may enter at all | the device stamp, installed by a one-time enrollment QR |
| Who the person is, and what they may do | the normal FabOrchestrator sign-in and FabOrchestrator's permissions |

## How it fits this app

| Question | Answer in this repository |
|---|---|
| Frontend / backend | One Next.js 16 app. Route handlers are the backend; `proxy.ts` (Next's middleware, Node runtime) sees every request first. |
| Database | None. Durable state is append-only, checksummed JSON-lines files on a Fly volume. The device store follows the seat store's pattern. |
| User auth | FabOrchestrator is the only identity (`foLogin`), unchanged. |
| PWA | `manifest.webmanifest`, `public/sw.js` (navigation fallback to `/offline` only; caches no data). |
| QR | The everyday QR is a static image of the app URL (`scripts/generate-qr.ts`), scanned with the phone's **native camera**. Enrollment QR codes are drawn by `/device-admin`. |
| Admin console | None existed; `/device-admin` is this feature's. |

## The flow in detail

**1. Create.** An administrator presses *Create Device Enrollment* at
`/device-admin` (optionally naming the device and site).
`POST /api/pwa/device-enrollments` makes a 256-bit random token from
`crypto.randomBytes`, stores only its **SHA-256**, and answers once with the
link `<PUBLIC_ORIGIN>/device-enroll/<token>`, its QR code and the expiry
(10 minutes; `DEVICE_ENROLLMENT_TTL_MINUTES`, 1–60). The screen shows the QR,
a countdown and a *Copy link* button.

**2. Scan.** The phone opens the link. `GET /device-enroll/<token>` checks the
token exists, has not expired and has not been used, moves it into a short-lived
httpOnly cookie (`__Host-fo_enroll`, SameSite=Lax) and redirects (303,
`Referrer-Policy: no-referrer`) to the bare `/device-enroll`, so the token
leaves the address bar.

**3. Enroll, automatically.** The `/device-enroll` page posts to
`/api/pwa/device-enrollments/complete` by itself as soon as it opens. No
email, no password, no button. The store uses the enrollment **exactly once**
and mints `DEVICE-nnn` and a 256-bit device token, keeping only the token's
hash. The browser receives `__Host-fo_device=<DEVICE-nnn>.<token>` (HttpOnly,
Secure, SameSite=Lax, Path=/, 400 days). The page says *Device enrolled
successfully. This device is now approved for FabOrchestrator access as
DEVICE-nnn* and offers *Open FabOrchestrator*. It does **not** sign anybody in.

Why the page posts rather than the link's GET doing it: link previews and
mail scanners (iMessage, Slack, Teams, Outlook) fetch links they see. If a GET
enrolled, such a fetcher would enroll itself and burn the QR. A same-origin
POST from the running page is something only a real browser on the page
makes. To the person scanning, it is still automatic.

**4. Normal use.** Every request passes `proxy.ts` first: no stamp, a wrong
token, an unknown or a revoked device → documents go to `/device-blocked`, APIs
answer `403 device_not_approved`. An approved device continues to the normal
sign-in gate and FabOrchestrator's login. The sign-in route checks the device
again itself, and renews the stamp.

**Revocation.** `POST /api/pwa/devices/{id}/revoke` appends a revocation with
the administrator and time. The proxy re-reads the store whenever the file
changes, so the device is refused **on its very next request**, existing
session or not. Its blocked page then signs out: the server clears the
FabOrchestrator cookie and revokes that FabOrchestrator session.

**Replacement.** A new phone needs a new QR and gets a new id and token.
Enrolling a browser that still holds an approved stamp revokes the old stamp.

**Cleared storage.** No cookie means unenrolled. There is no recovery from
metadata; scan a new QR.

## Security properties

- **Device stamp:** HttpOnly, Secure, `__Host-` (no sibling host, no path
  shadowing; two cookies of the name count as none), SameSite=Lax so it is sent
  on the navigation a scanned QR opens. Page JavaScript cannot read it.
- **Secrets:** 256-bit tokens from the OS CSPRNG; SHA-256 on the server; the
  device token compared by hash in constant time. No raw token is stored,
  logged, or returned after issuance. The QR link is the only place an
  enrollment token appears, so treat a live QR like a key for its ten minutes.
- **One use, even under races:** using an enrollment first creates a marker
  file with `O_EXCL`; exactly one creator wins, across processes on the volume.
  A crash after the marker burns the enrollment rather than allowing a second
  device.
- **Fails closed:** any `DEVICE_GATE` value but unset/`off` enforces; an unset
  or unreadable store blocks everything; a torn, altered or orphaned record
  grants nothing.
- **CSRF:** state-changing routes refuse cross-site `Sec-Fetch-Site`/`Origin`
  and require JSON; admin routes also need the bearer.
- **Rate limiting:** enrollment attempts with unknown codes are limited per
  address (8 per 10 minutes); FabOrchestrator sign-in keeps its own limiter.
- **Links from `PUBLIC_ORIGIN` only,** never the `Host` header.
- **Headers on the device pages:** CSP (`default-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`), `no-referrer`,
  `X-Frame-Options: DENY`, `no-store`. Scripts still need `'unsafe-inline'`
  (the root layout and Next's hydration use inline scripts).
- **Audit** (`device_audit` log lines, identifiers only):
  `DEVICE_ENROLLMENT_CREATED`, `DEVICE_ENROLLMENT_REJECTED`, `DEVICE_ENROLLED`,
  `DEVICE_REENROLLED`, `DEVICE_ACCESS_ALLOWED` (when last-seen is written, at
  most every 15 minutes per device), `DEVICE_ACCESS_BLOCKED` (bounded),
  `DEVICE_REVOKED`, `DEVICE_LOGIN_REFUSED`. The store file is the durable record
  of who issued and who revoked what.
- **Metadata is description only** (type, OS, browser, installed app or
  browser). No decision reads it.

## Limitations

- **It is a bearer credential.** It identifies the browser or installed app
  holding the cookie, **not** the physical phone, and proves no serial number.
  Anyone who copies the cookie can present it until the device is revoked.
  Stronger cloning resistance means a non-exportable device key with
  challenge-response (WebAuthn) or an enterprise device identity
  (Entra/Intune); only `lib/devices/credential.ts` and the check in
  `lib/devices/gate.ts` would change.
- **Anyone holding a live QR can enroll a device with it.** That is the design
  (the QR is the authorization). Show it only to the device it is for; it dies
  after one use or ten minutes, and a device enrolled by mistake is revoked
  from `/device-admin`.
- **iOS: Safari and the Home Screen app keep separate cookies.** The camera
  opens a scanned QR in Safari, so scanning approves Safari, not the installed
  app. To approve the installed app, open it (it shows "not approved"), and
  paste the enrollment link there (*Copy link* on `/device-admin`). Not tested
  on a real iPhone; whether iOS copies cookies into the app at install time
  was not verified.
- **Android:** an installed Chrome PWA shares Chrome's cookies, so scanning
  with the camera should cover the app. Expected, not tested on a device.
- **FabOrchestrator sessions after revocation** end when the device next
  opens a page here; otherwise FabOrchestrator's own 30-minute idle rule ends
  them. This app holds no FabOrchestrator tokens server-side.
- **Enrollments made before this change** (the user-named version, record
  version 1) are not read: such a device must scan a new QR.
- **One machine, one volume,** like the seat store. **`/device-admin` has no
  link** from FabOrchestrator's screens; open it by URL.

## Rolling it out (hardening app)

1. Deployed with `DEVICE_GATE = "off"`; `DEVICE_ADMIN_EMAILS` set. Nothing is
   blocked yet.
2. At `/device-admin`, create a QR for each device that should keep access,
   **the administrator's own first**, and scan it on that device. (If no
   administrator has an approved device once the gate is on, issue one from
   the machine: `flyctl ssh console --app faborch-pwa-amay-hardening -C
   "su-exec nextjs:nodejs node scripts/device-enrollment.mjs --name 'Admin laptop'"`.)
3. Set `DEVICE_GATE = "enforce"` in `fly.hardening.toml` and redeploy.
   Rollback: set it back to `off`.

## Demo script (gate enforced)

1. **Unapproved device:** Phone A opens the normal FO URL → "This device is not
   approved".
2. **Generate:** the admin opens `/device-admin` → *Create Device Enrollment* →
   QR, countdown, link.
3. **Automatic enrollment:** Phone A scans the QR → "Device enrolled
   successfully … DEVICE-nnn", no email or password asked. `/device-admin` lists
   DEVICE-nnn as APPROVED; scanning the same QR again says it has been used.
4. **Normal access:** Phone A opens the normal FO URL → the sign-in page → the
   user signs in → FabOrchestrator.
5. **Second phone:** Phone B opens the same URL → blocked, even with valid FO
   credentials.
6. **Revocation:** the admin revokes DEVICE-nnn → Phone A's next tap lands on
   "not approved", although its cookie is still there.

## Verified

- `npm test` (all suites), `tsc`, `eslint`, `next build`.
  `__tests__/devices/` covers: enrollment with no FabOrchestrator call, email
  or session; a QR naming a user refused; link previews cannot spend a QR;
  expired and reused QR; eight simultaneous uses of one QR → exactly one
  device; rate limiting; blocked before enrollment, through after; another
  unapproved device blocked; revocation on the next request; replacement;
  sign-in a separate step, open to any account on an approved device; admin
  authorization; no token or hash in responses, the store file or logs; the
  bootstrap CLI's record format.
- Over the wire against `next start` with the gate enforced and a stub
  FabOrchestrator: demo scenarios 1–6 (see the commit for the run).
- Not run: a real iPhone or Android device, or the gate enforced on the
  deployed app.
