# One account, several devices: each device's conversations are its own

**As of 2 October 2026.** On `pwa/amay-embed-fo-production-hardening`, deployed
to `faborch-pwa-amay-hardening` as release v4 (2 October, 00:21 UTC). Not
pushed. Release v3 (`06acee8`) is the rollback.

## The requirement

Several people may sign in to this app with the **same** FabOrchestrator
username and password. Inside this app each device is its own private session:

- it sees only the conversations it started;
- it cannot open, continue, rename, pin, delete, or read or write the messages
  of a conversation another device started, even by supplying its id;
- signing out, or a session ending, on one device does not affect another;
- signing in again on the same device brings its conversations back.

FabOrchestrator is **not changed**. Logins, plant data, the model and every
answer still come from the existing real FabOrchestrator, exactly as before.

## How it works

FabOrchestrator knows one user and would show each device everything. This app
sits in front of it and adds the one fact FabOrchestrator does not have: which
device started which conversation.

| Step | Where | What |
|---|---|---|
| The device is named | `lib/faborch/device.ts` | A browser's first sign-in mints 32 random bytes, kept in the httpOnly cookie `__Host-faborch_seat` (400 days, renewed at each sign-in; `faborch_seat` on loopback http). Its hash is the device's **seat**. Sign-out and expiry never clear the cookie. |
| The seat is signed into the session | `lib/auth.ts`, `app/api/pwa/auth/login/route.ts` | The session token carries the seat (`sid`). It is signed, so a client cannot claim another seat. Nothing about the device is sent to FabOrchestrator. |
| Ownership is remembered | `lib/gateway/seat-store.ts` | One append-only file: a validated, checksummed line per conversation, written and flushed to disk before it is believed. |
| The rule is applied | `lib/gateway/seats.ts`, `app/fo-gateway/[...path]/route.ts` | The list is cut down to the seat's rows; a new conversation is recorded as the seat's before the phone hears of it; any request naming a conversation that is not the seat's is refused before FabOrchestrator is asked. |

Everything that passes is forwarded unchanged: same body, same token, same
model, same plant data.

## It fails closed

- A conversation with no valid record is nobody's: hidden from every list and
  refused to every device.
- A corrupt, torn or altered record grants nothing. Two records that give one
  conversation to two seats leave it with neither.
- A conversation is never reassigned: the first owner is the only owner.
- If the store cannot be read or written, conversation routes answer 503. A new
  conversation whose ownership could not be stored is deleted again in
  FabOrchestrator rather than left unowned.
- A list this app cannot parse is refused, never passed through unfiltered.
- A session with no seat (minted before this change) is ended at its first
  conversation request; the next sign-in has a seat.
- With `SEAT_STORE_PATH` unset there is no store and no in-memory fallback.

## What a person will notice

- **Everybody is signed out once** when this is deployed, and **every device
  starts with an empty history.** Existing conversations are not lost: they are
  in FabOrchestrator and visible at FabOrchestrator's own site. They are simply
  not any device's inside this app.
- A new phone, a different browser, or a browser whose site data was cleared is
  a new, empty seat. On an iPhone, Safari and the installed app are two seats:
  sign in inside the installed app.
- The seat is the browser, not the person. Two people who use the same browser
  one after the other share its conversations.

## Limits

- **Inside this app only.** Signing in at FabOrchestrator's own site with the
  same credentials shows every conversation of the account, as it always did.
- **Feedback and file downloads** name a message id or a file id, not a
  conversation, so they are not tied to a device. Both ids are random and reach
  a browser only inside a conversation its seat owns.
- **The artifacts route is closed** (`/api/artifacts` answers 404). An artifact
  id cannot be tied to a device, and FabOrchestrator's client never calls it.
- **Still shared by account:** memory, usage limits, settings, MCP connections,
  the Modeling Agent's uploads, and the password.
- **A script running on this origin** could choose or reset a browser's device
  key (the plan's accepted risk G10).
- **One machine.** The store is one file on one volume. Several instances would
  need a shared store.
- **The plan has not been revised.** It still records "no PWA session store" and
  "shared accounts are not a PWA requirement" (RP2, 24 September). This change
  departs from both on the owner's instruction of 1 October 2026.

## Verified locally (1 October 2026)

- 879 unit and route tests, `tsc`, `eslint`, `next build`.
- `__tests__/gateway/seat-store.test.ts` (23): concurrency, restart, corrupt and
  conflicting records, unwritable and unreadable files.
- `__tests__/gateway/seat-isolation.test.ts` (39): two devices on one account
  through the gateway route, against a stub that behaves as the real
  FabOrchestrator does.
- `scripts/two-seat-check.mjs`: **72 of 72** over the wire, through this app's
  production build, against an **unmodified** local FabOrchestrator (FO `main`,
  `1b9b117`). The same run shows FabOrchestrator itself still lists both
  conversations for the account, so the separation is this app's.
- The app was killed and restarted on the same store file: each device still
  had exactly its own (6 of 6).
- Two separate browsers on FabOrchestrator's real screens through this app:
  each asked a question and saw only its own conversation (11 of 11).

The local FabOrchestrator used a local test database and a stand-in for the
model, because no working model key was available. Nothing has been run against
the real FabOrchestrator or the deployed hardening app.

## Deploying it to `faborch-pwa-amay-hardening`

1. Create the volume once:
   `flyctl volumes create seat_store --size 1 --region sjc --app faborch-pwa-amay-hardening`
2. Deploy from this branch:
   `flyctl deploy . -c fly.hardening.toml --ha=false --app faborch-pwa-amay-hardening`
   The machine is recreated to attach the volume (about a minute of downtime).
3. Check the logs for a clean start, then run `scripts/two-seat-check.mjs`
   against the app with a real FabOrchestrator account. It creates two
   conversations and sends two short real model turns in that account, then
   deletes the conversations.

Rollback: redeploy release v3's image with the previous configuration
(`git show 06acee8:fly.hardening.toml`). The volume and its file can stay.
