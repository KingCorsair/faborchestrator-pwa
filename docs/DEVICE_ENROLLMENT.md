# Approved devices: one-time enrollment QR, Web Crypto device key

**As of 6 October 2026.** Jothi's Option 2: FabOrchestrator-PWA-managed device
enrollment. Branch `pwa/amay-embed-fo-production-hardening`; code in
`lib/devices/`, `proxy.ts`, the sign-in page and route, and the routes below.

## In one picture

```
Enrollment (once per device)
  admin creates a one-time QR at /device-admin
    → the device opens it (camera link, in-app scanner, or pasted link)
    → the device generates its own key pair (Web Crypto, ECDSA P-256);
      the private key is non-extractable and stays in this device's IndexedDB
    → the public key is registered: DEVICE-nnn, APPROVED
    → the QR is spent                     (no email, no password, no cookie)

Normal use (every time)
  normal FO QR / the Fly app's address
    → sign-in page: does this device hold a key?   no → "not approved"
    → the device signs a fresh server challenge with its key
    → server: signature valid for DEVICE-nnn's registered public key, and
      DEVICE-nnn APPROVED?   no → refused, before the password is checked
    → normal FabOrchestrator sign-in (email + password)
    → the session is bound to DEVICE-nnn on the server; every request on it
      checks DEVICE-nnn is still APPROVED (revoke → stopped on the next tap)
```

**The enrollment QR authorizes a device; it does not authenticate a person.**
The device stamp is `DEVICE-nnn` + a private key that never leaves the device.
There is **no device cookie** and no device secret in local storage. The device
belongs to no user: any FabOrchestrator account may sign in on an approved
device, and FabOrchestrator's own permissions decide what it may do.

| Concern | Decided by |
|---|---|
| Who may use `/device-admin` (create QRs, revoke) | `DEVICE_ADMIN_EMAILS`, plus an approved device and a session |
| Which device may enter | possession of the enrolled private key, proved by a signed challenge, and DEVICE-nnn's server status |
| Who the person is | the normal FabOrchestrator sign-in |

## How it works

| Step | Where | What |
|---|---|---|
| Create QR | `POST /api/pwa/device-enrollments` | 256-bit one-time code (CSPRNG), stored as SHA-256, 10 minutes. The link is `<PUBLIC_ORIGIN>/device-enroll/<code>`. |
| Open the link | `GET /device-enroll/<code>` | Code checked, moved into a short-lived httpOnly cookie (temporary enrollment permission, not an identity), 303 to `/device-enroll` so the code leaves the address bar. Opening spends nothing (link previews cannot burn it). |
| Enroll, 1 | `POST /api/pwa/device-enrollments/start` | Code usable? Then a challenge bound to this enrollment. Checked **before** the device makes a key. |
| Enroll, 2 | `lib/devices/keystore.ts` | `generateKey(ECDSA P-256, extractable: false)`; the `CryptoKey` stored in IndexedDB and read back; the challenge signed. |
| Enroll, 3 | `POST /api/pwa/device-enrollments/complete` | Signature checked against the sent public key (proof of possession); the code consumed exactly once (`O_EXCL` marker); DEVICE-nnn created, APPROVED, holding the public key. |
| Sign in, 1 | `POST /api/pwa/device-auth/challenge` | 32 random bytes, 60 s, single use, bound to DEVICE-nnn and to sign-in. Refused for a revoked device (403 `device_revoked`). The sign-in page asks for one **as soon as it opens**, so a revoked device goes to `/device-blocked?reason=revoked` before anyone types a password, and "Approved device: DEVICE-nnn" appears only when the server confirms it. |
| Sign in, 2 | `POST /api/pwa/auth/login` | With the gate on: no proof, a bad or replayed signature, an unknown or revoked device → 403 **before FabOrchestrator is asked about the password**. Then FabOrchestrator sign-in; the session is bound to DEVICE-nnn (`bound` record, keyed by the FO token's fingerprint, never the token). |
| Every request | `proxy.ts` → `lib/devices/gate.ts` | A request carrying a session must belong to a session bound to an APPROVED device; otherwise documents go to `/device-blocked?reason=…` (which signs out), APIs get 403. A request without a session reaches nothing of FabOrchestrator's. |
| Revoke | `POST /api/pwa/devices/{id}/revoke` | Recorded with the admin and time; the device's sessions stop on their next request. The phone keeps its key (the server cannot delete it), but its sign-in challenge is refused from then on, and a proof it signed earlier is refused at sign-in. |

`/device-blocked` shows what this device holds, as the server reports it on
arrival rather than what the key or `?reason=` alone suggests: an approved key
("Sign in"), a revoked device, or nothing ("not approved"). If the server
cannot be asked, it says so and offers sign-in, which checks the device anyway.
It offers **Scan enrollment QR**
(in-page camera, `lib/devices/scanner.ts`, zxing-wasm served by this app) and a
paste box. Enrolling there puts the key in that page's own storage, which in an
installed app is the app's.

## An administrator approves each enrolled device (14 October 2026)

Scanning an enrollment QR no longer approves a device by itself. It makes a
**request**: the device generates its key as before and is registered as
`DEVICE-nnn`, **PENDING**. A pending device's key opens nothing: the sign-in
challenge answers `403 device_pending`, sign-in refuses its proof before
FabOrchestrator is asked about the password, and it is given no install grant.
The phone shows "Waiting for approval" and asks the server every few seconds
(`components/devices/awaiting-approval.tsx`), moving on by itself once decided.

On `/device-admin` the request appears under **Waiting for approval** with
where it came from (`lib/devices/origin.ts`): the IP address the edge saw
(`Fly-Client-IP`), the Fly region it came in through (`Fly-Region`, the data
centre nearest the phone, not its location), the time zone and language the
device reports, its browser, and who issued the QR. **Approve** makes it
APPROVED (`POST /api/pwa/devices/<id>/approve`, `approved` record, approver
and time kept); **Block** uses the revoke route, which marks a pending device
**REJECTED** for good: approving it later is refused (`409`), and it needs a
new QR. None of the origin details are proof of anything (a VPN hides the
address; the device says what it likes about its time zone); they help a
person notice a request they did not expect. No address is sent to any
outside service.

- Switch: `DEVICE_ENROLLMENT_APPROVAL`. Unset or `manual`: approval required.
  `auto`: the QR approves at once, as before.
- Enrollments issued by `scripts/device-enrollment.mjs` (`bootstrap-cli`) are
  approved by being used either way: the first administrator's device has
  nobody to approve it, and whoever runs the script already has the server.
- Devices enrolled before this change are APPROVED as written: an `enrolled`
  line is PENDING only when it carries `pend: true`.

## An installed app joins its browser's device (9 October 2026)

On an iPhone, Safari and an app added to the Home Screen from it keep separate
IndexedDB. The browser that scanned the enrollment QR holds the device's key;
the app installed from it held nothing, and used to need a second QR, which
made a second `DEVICE-nnn` for the same phone. It no longer does.

**A device has credentials.** Each is one public key, identified by its
fingerprint:

| | ROOT | APP |
|---|---|---|
| What it is | the key the enrollment QR registered | an installed app's own key |
| How many | exactly one per device | at most one ACTIVE per device |
| Created by | an `enrolled` record | an `attached` record (an install grant) |
| May obtain install grants | yes | never |

Every device enrolled before this existed is read as device + ROOT from the
same `enrolled` line: nothing in the store file is rewritten, no key is
regenerated, nobody enrolls again, and sessions already signed in count as the
ROOT's. The record version is still 3. Which kind a credential is comes only
from the record that created it; a client cannot claim one.

**The install grant** (`lib/devices/install-grant.ts`). iOS and iPadOS 17.2 and
later copy the browser's cookies, and nothing else, into a newly added Home
Screen app. So:

```
approved browser (ROOT, KEY-A) --signs a `grant` challenge--> server
   <-- one-time install grant, in an httpOnly cookie (hash stored) --
"Add to Home Screen": iOS copies the cookie into the new app
app (no key) --grant cookie--> attach/start --> challenge bound to that grant
app generates KEY-B (non-extractable, its own IndexedDB), signs it
app --KEY-B public key + signature + grant cookie--> attach/complete
   server: APP credential under the SAME DEVICE-nnn; grant spent
app --> ordinary sign-in, with KEY-B's proof and the password
```

- The browser keeps a grant ready while its pages are open (the root layout's
  `InstallGrantKeeper`, and `public/fo-shell.js` on FabOrchestrator's pages):
  nothing announces "Add to Home Screen", so the grant must already be there.
- A grant works once and has **no time limit** (14 October 2026; it was 15
  minutes), so the app can be added to the Home Screen days after enrolling.
  There is one per device: a new one cancels the last, and so does revoking
  the device or its ROOT. Its cookie lives 400 days, the most a browser keeps
  one. A browser is given a new grant when it does not hold the outstanding
  one (used, cancelled, or its cookie lost) or when the cookie has under 30
  days left. The trade-off: an unused grant in a browser stays usable by
  whoever has that browser's cookies; each attachment is shown, with its
  address, on `/device-admin` and can be removed there.
- It registers one installed-app key under the device that asked. It signs
  nobody in, reads nothing, creates no device, and cannot mint another grant.
- Its cookie is `__Secure-fo_install`: HttpOnly, Secure, SameSite=Strict,
  `Path=/api/pwa/device-credentials`, so it is sent only to the attach routes.
- **Reinstalling** attaches a new key (APP-C) and marks the earlier install
  (APP-B) SUPERSEDED in the same record. APP-B's sessions stop on their next
  request.
- Switch: `DEVICE_INSTALL_GRANTS`. Unset or `on` enables it; anything else
  turns grants off (the routes answer 404) and an installed app enrolls with a
  QR as before.

**Sessions belong to a credential.** A `bound` record names the credential
that signed in (`cr`; absent on older lines, meaning the ROOT). The proxy
requires the session's device to be APPROVED **and** its credential ACTIVE.
The browser's sessions and the app's are distinct on `/device-admin` and are
stopped separately.

**A copied session cookie is forgotten, not ended.** The same cookie copy
gives the new app the browser's FabOrchestrator session cookie, with no bearer
and no key. Ending that session signed the browser out when its owner opened
the app. Now:

| Where | Before | Now |
|---|---|---|
| A FabOrchestrator page that **loaded** with a cookie and no bearer (`fo-shell.js`) | sign-out, revoked at FO | `POST /api/pwa/auth/forget`: cookie cleared here, nothing revoked |
| One of this app's screens in the same state (`token_missing`) | sign-out, revoked | forget |
| `/device-blocked` on arrival | sign-out, revoked | the server decides: a session bound to an ACTIVE credential on an APPROVED device is forgotten; any other is revoked |
| Sign-in overwriting an older cookie | older session revoked | revoked only if it is this credential's own, or bound to none |

A session whose bearer was there and then went (sign-out in another tab,
FabOrchestrator's idle timer) and an ordinary sign-out are still revoked.

**Revocation.** Revoking a device stops every credential under it, their
sessions on the next request, their sign-ins, and any outstanding grant.
`POST /api/pwa/devices/<id>/credentials/<credentialId>/revoke` (and "Remove
app only" / "Remove browser only" on `/device-admin`) stops one credential and
leaves the device approved.

## Security properties

- Private key generated non-extractable; the `CryptoKey` itself is stored, never
  exported or serialized; the server holds only public keys and SHA-256 hashes
  of enrollment codes.
- Challenges: CSPRNG, 60 s, single use (spent even by a failed attempt),
  bound to one purpose (`enroll`, `sign-in`, `grant`, `attach`) and to the
  enrollment, credential or grant; replay refused, and one key's signature
  does not answer another credential's challenge.
- Verification against the public key the store holds for that credential,
  never one the caller supplies; EC P-256 only; one key, one credential.
- One enrollment → one device, and one install grant → one credential, even
  under races (marker file with `O_EXCL`).
- Install grants: issued only after a fresh proof from an ACTIVE ROOT on an
  APPROVED device; 256 random bits, hash stored; 15 minutes, one use, one
  outstanding per device; httpOnly, Secure, Strict, path-scoped cookie.
- Fails closed: `DEVICE_GATE` other than unset/`off` enforces; an unusable
  store refuses sessions and sign-ins.
- Same-origin checks and JSON-only on state-changing routes; rate limits on
  enrollment codes and device challenges; links from `PUBLIC_ORIGIN` only.
- Device pages: CSP (`'wasm-unsafe-eval'` added for the scanner), no framing,
  no referrer, no caching.
- Audit (`device_audit` lines): ENROLLMENT_CREATED / REJECTED, ENROLLED,
  ACCESS_ALLOWED (sign-in, and last-seen), ACCESS_BLOCKED, REVOKED,
  LOGIN_REFUSED, INSTALL_GRANT_ISSUED / REJECTED, CREDENTIAL_ATTACHED /
  SUPERSEDED / REVOKED; `session_forgotten` for a cookie dropped without
  ending its session. No codes, keys or tokens in logs.

## Limitations

- **Not hardware attestation.** It proves "this browser or installed app holds
  the key it generated at an approved enrollment", not a phone serial number.
- **Same-origin script can use the key** while the page is open (it cannot
  export it). FabOrchestrator's pages share this origin, so an injected script
  there could answer a challenge; the proof still only opens a sign-in that
  needs the password, and challenges are short-lived and single-use.
- **The same script could attach a key of its own.** Running in an approved
  browser it can ask the ROOT key for a grant and use it with a key it made.
  Accepted, and bounded: one installed-app credential per device (the owner's
  own app is superseded, which they notice), an audit line and a "New" entry
  on `/device-admin` for every attachment, a notice in the browser, revocation
  per credential and per device, and the password sign-in still needs.
- **iPhone: Safari and the Home Screen app keep separate storage.** A QR
  scanned with the Camera opens Safari and approves **Safari**. An app then
  added to the Home Screen from that Safari joins the same device by itself
  (above). That relies on iOS copying cookies at install: **iOS / iPadOS 17.2
  or later**, and the app opened within a few minutes of being added (a grant
  lasts 15 minutes and the browser replaces it once it has under 5 left).
  Where the grant is missing, expired or already used, the app falls back to
  what it did before: `/device-blocked` → Scan enrollment QR, inside the app.
  Whether iOS copies a cookie with exactly these attributes (path-scoped,
  Strict, `__Secure-`) **has not been confirmed on a real iPhone**: if it is
  not, the attributes are set in one place, `lib/devices/install-grant.ts`.
  Safari tab storage can also be cleared by Safari's 7-day rule for sites not
  visited; Home Screen apps are exempt.
- **One installed app per device.** iOS allows two Home Screen icons for one
  site, each with its own storage; only the most recently attached one stays
  approved.
- **A forgotten session is not revoked.** A cookie dropped by the rules above
  leaves its FabOrchestrator session alive until its owner signs out or
  FabOrchestrator's idle rule ends it. The cookie alone opens no data: the
  gateway needs the matching bearer beside it.
- **Android (Chrome):** the installed app shares Chrome's storage, so either
  path enrolls both. Not yet tested on a real Android phone.
- **Cleared storage, eviction, uninstall** delete the key: the device is
  unenrolled and needs a new QR. Not recoverable from metadata.
- **Existing sessions** from before the gate is turned on are not bound to a
  device and are signed out at their next request once it is on; signing in
  again (with the device's proof) binds them.
- **Real-device status:** verified in Chromium and WebKit on a computer (see
  below). Not yet run on a real iPhone or Android phone.
- One machine, one volume; `/device-admin` is reached by URL.

## Rolling it out

1. Deploy with `DEVICE_GATE = "off"`. Nothing is blocked; sign-ins with a
   device key already bind their sessions.
2. On the administrator's computer: `/device-admin` → Create Device Enrollment
   → open the link on that computer → "Device enrolled successfully". Sign out
   and sign in again (the sign-in page now shows "Approved device: DEVICE-nnn").
3. Enroll every other device that should keep access.
4. Set `DEVICE_GATE = "enforce"` and redeploy. Rollback: `off`.
   Lost every admin device? `flyctl ssh console -C "su-exec nextjs:nodejs node
   scripts/device-enrollment.mjs --name 'Admin laptop'"` prints a one-time link.

## Verified (9 October 2026): credentials, install grants, copied sessions

- `npm test` (all suites; 110 in `__tests__/devices/`, of which
  `install-grant.test.ts` is 42), `tsc`, `eslint`, `next build`.
- Production build, gate enforced, stand-in FabOrchestrator, WebKit with an
  iPhone user agent; "the app" is a second context with empty storage given a
  copy of the browser's cookies, which is what iOS does. Safari enrolled by QR
  → grant cookie present → signed in → app context opened at `/` → copied
  session forgotten, not signed out → approved as the **same** DEVICE-001 with
  its own non-extractable key, no QR → signed in → Safari still signed in, its
  FabOrchestrator session never revoked → `/device-admin` lists both keys and
  Safari shows the "app was added" notice → reinstall attaches a third key and
  the earlier install is stopped on its next request → a device with no grant
  still gets the QR page.
- **Not yet run on a real iPhone.** The cookie copy itself is iOS's behaviour
  and cannot be reproduced on a computer.
- Rolling back to the code before this: older code ignores the new record
  types (it reports them as unreadable lines and grants nothing from them) and
  does not read a `bound` line that names a credential, so sessions signed in
  after the upgrade sign in again. Devices and their enrollments are untouched.

## Verified (6 October 2026)

- `npm test` (all suites, 67 in `__tests__/devices/`), `tsc`, `eslint`,
  `next build`.
- Production build, gate enforced, stand-in FabOrchestrator, real browsers:
  computer bootstraps itself and runs `/device-admin`; Phone A blocked →
  in-page scan of the Enrollment QR → DEVICE-002 → restart → sign-in shows the
  approved device → signs in; Phone B blocked, same QR "already used", valid
  password refused; DEVICE-002 revoked → next tap "has been revoked", sign-in
  refused; WebKit phone enrolled by pasted link, kept its key across restart,
  signed in. 18/18.

## Fixed (8 October 2026): a revoked phone was told it was approved

A revoked phone that reopened the app with no session (for example from the
app's QR code, after its first refusal had signed it out) landed on sign-in
showing **"Approved device: DEVICE-nnn"**. The page read that from the key in
its own storage, which a revocation does not remove. The phone was refused only
after typing its password. `/device-blocked` reached without `?reason=revoked`
said "This device is approved" for the same reason.

The fix: the challenge is refused for a revoked device, and both pages ask for
one before saying anything about approval (`deviceStatus` in
`lib/devices/keystore.ts`). A revoked id does not count against the sign-in
limiter, and its refusals are logged at most once a minute per device and
address (`DEVICE_ACCESS_BLOCKED`, reason `revoked`).

Verified:
- `npm test` passes: 949 tests, 70 of them in `__tests__/devices/`. `tsc`,
  `eslint` and `next build` pass.
- Production build in Edge, gate enforced, stand-in FabOrchestrator, 13/13:
  - an approved phone still sees "Approved device" and signs in;
  - after it is revoked, reopening the app lands on the revoked page;
  - `/device-blocked` with no reason says revoked;
  - a phone with no key still sees "not approved";
  - a new QR approves the phone again.
  - The same run on the unfixed build failed exactly the two revoked-phone
    checks.
- With the challenge unreachable: the form still works, shows no label, and
  reports the failure when Sign in is pressed. `/device-blocked` says "could
  not be checked", or "revoked" when arriving with `?reason=revoked`.
