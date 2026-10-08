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

## Security properties

- Private key generated non-extractable; the `CryptoKey` itself is stored, never
  exported or serialized; the server holds only public keys and SHA-256 hashes
  of enrollment codes.
- Challenges: CSPRNG, 60 s, single use (spent even by a failed attempt),
  bound to purpose and to the enrollment or device; replay refused.
- Verification against the public key registered at enrollment, never one the
  caller supplies; EC P-256 only; one key per device.
- One enrollment → one device, even under races (marker file with `O_EXCL`).
- Fails closed: `DEVICE_GATE` other than unset/`off` enforces; an unusable
  store refuses sessions and sign-ins.
- Same-origin checks and JSON-only on state-changing routes; rate limits on
  enrollment codes and device challenges; links from `PUBLIC_ORIGIN` only.
- Device pages: CSP (`'wasm-unsafe-eval'` added for the scanner), no framing,
  no referrer, no caching.
- Audit (`device_audit` lines): ENROLLMENT_CREATED / REJECTED, ENROLLED,
  ACCESS_ALLOWED (sign-in, and last-seen), ACCESS_BLOCKED, REVOKED,
  LOGIN_REFUSED. No codes, keys or tokens in logs.

## Limitations

- **Not hardware attestation.** It proves "this browser or installed app holds
  the key it generated at an approved enrollment", not a phone serial number.
- **Same-origin script can use the key** while the page is open (it cannot
  export it). FabOrchestrator's pages share this origin, so an injected script
  there could answer a challenge; the proof still only opens a sign-in that
  needs the password, and challenges are short-lived and single-use.
- **iPhone: Safari and the Home Screen app keep separate storage.** A QR
  scanned with the Camera opens Safari and approves **Safari**; the installed
  app needs its own enrollment, scanned **inside the app** (`/device-blocked` →
  Scan enrollment QR). Then the everyday entry for the app is tapping its icon;
  the normal QR scanned with the Camera opens Safari, which is a separate
  (approved or not) context. Safari tab storage can also be cleared by Safari's
  7-day rule for sites not visited; Home Screen apps are exempt.
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
