/**
 * The device key and its seat: what tells two phones apart when they sign in
 * with the **same** FabOrchestrator account (1 October 2026).
 *
 * ── The requirement ─────────────────────────────────────────────────────────
 * Several people may share one FabOrchestrator username and password. Each
 * device must still be its own private session: it sees, opens, continues,
 * renames and deletes only the conversations it started, and gets them back
 * when it signs in again. FabOrchestrator keys conversations by user id and is
 * **not being changed**, so the separation is this app's, added in front of it:
 *
 *   this file              names the device (a key in a cookie) and derives
 *                          its **seat** (a one-way hash of the key)
 *   `lib/auth.ts`          carries the seat in the signed session token (`sid`)
 *   `lib/gateway/seat-store.ts`  remembers which seat started which conversation
 *   `lib/gateway/seats.ts` applies the rule to every conversation request
 *
 * Nothing about the device is sent to FabOrchestrator.
 *
 * ── Why the key outlives sign-out ───────────────────────────────────────────
 * The seat is the device, not the login. A session ends after 12 hours or 30
 * idle minutes; if the seat ended with it, every sign-in would open on an empty
 * history. So sign-out and expiry leave this cookie alone, and signing in again
 * on the same browser returns to the same conversations.
 *
 * ── A key nobody else may choose ────────────────────────────────────────────
 * A browser that signs in with a key somebody else knows shares its seat with
 * them. Two rules keep a page script from choosing the key:
 *
 *  1. The cookie is `__Host-faborch_seat`. A `__Host-` cookie is host-only,
 *     `Secure` and `Path=/`: a sibling subdomain cannot set it, and a script
 *     cannot add one at another path or overwrite in place the httpOnly one
 *     the server set.
 *  2. A request carrying more than one cookie of the name is treated as
 *     carrying none: a new key is minted rather than a planted one trusted.
 *
 * **These raise the cost and close shadowing; they do not close the path.** A
 * script that runs on this origin can still set the key: directly, before a
 * browser's first sign-in; and afterwards by filling the browser's per-site
 * cookie limit until this cookie is evicted and then setting its own, which
 * the next sign-in adopts and renews. It can also force a new, empty seat by
 * adding a second cookie of the name. That is the plan's accepted risk G10 (a
 * script on the shared origin), not something a cookie attribute can end.
 *
 * On a loopback address over plain http (local development) a `__Host-` cookie
 * cannot be set, so the name is `faborch_seat` there, and only there.
 *
 * **The name does not depend on `x-forwarded-proto`.** A probe of a Fly
 * deployment on 1 October 2026 showed that a client's own
 * `x-forwarded-proto: http` reaches this app ahead of the edge's value, and
 * that header is one a page script may set. So the choice is made from the
 * `Host` header, which a page script cannot set: anything but a loopback host
 * gets `__Host-` and `Secure`, whatever the forwarded scheme claims.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 * Not a credential: it opens nothing without the account's password. Not the
 * login limiter's device-trust cookie (plan RP3 part 4, `faborch_device`): this
 * one grants no exemption from anything. Not per person: it is the browser, so
 * whoever signs in next on the same browser with the same account is on the
 * same seat. Not recoverable: clearing the browser's data, or using another
 * browser on the same phone (on iOS, Safari and the installed app keep separate
 * cookies), starts a new, empty seat. Never sent to client JavaScript, and
 * never forwarded by the gateway (`lib/gateway/headers.ts` forwards no cookie).
 */

import { createHash, randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { isHttps } from "@/lib/faborch/session";

/** Every deployment. */
export const DEVICE_COOKIE = "__Host-faborch_seat";

/** A loopback address over plain http only (local development): `__Host-` needs a secure origin. */
export const DEVICE_COOKIE_INSECURE = "faborch_seat";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether the request was addressed to this machine itself. From the `Host`
 * header, which a browser sets and a page script cannot; never from a
 * forwarded header.
 */
function isLoopbackHost(req: NextRequest): boolean {
  const host = (req.headers.get("host") ?? req.nextUrl.host).toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return LOOPBACK_HOSTS.has(name);
}

/** 400 days: the longest lifetime browsers honour. Renewed at every sign-in. */
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** 32 random bytes, base64url: exactly what `newDeviceKey` produces. */
const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/;

/**
 * The cookie's name for this request: `__Host-` everywhere except plain http
 * on a loopback host. A forwarded scheme can only matter on loopback.
 */
export function deviceCookieName(req: NextRequest): string {
  return isLoopbackHost(req) && !isHttps(req) ? DEVICE_COOKIE_INSECURE : DEVICE_COOKIE;
}

export function newDeviceKey(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The seat a device key names: a one-way hash, 43 base64url characters. It is
 * what the session token and the seat store hold; the key itself stays in the
 * cookie and is never stored or logged.
 */
export function seatIdFor(deviceKey: string): string {
  return createHash("sha256").update(deviceKey).digest("base64url");
}

/**
 * This browser's device key, or null when it has none.
 *
 * Read from the raw header, not the parsed jar: the jar keeps the last of two
 * same-named cookies, and "which of two" is exactly what must not be decided
 * silently. More than one, or a value that is not one of ours, is treated as
 * absent, so tampering costs a new seat rather than adopting somebody's key.
 */
export function deviceKeyFrom(req: NextRequest): string | null {
  const prefix = `${deviceCookieName(req)}=`;
  const found = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  if (found.length !== 1) return null;
  const value = found[0]!.slice(prefix.length);
  return DEVICE_KEY.test(value) ? value : null;
}

/** Keep (or renew) the device key on this browser. Called only after a successful sign-in. */
export function setDeviceCookie(req: NextRequest, res: NextResponse, deviceKey: string): void {
  const name = deviceCookieName(req);
  res.cookies.set({
    name,
    value: deviceKey,
    httpOnly: true,
    // `__Host-` is only accepted with `Secure`; the two go together.
    secure: name === DEVICE_COOKIE,
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE_S,
  });
}
