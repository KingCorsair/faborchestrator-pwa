/**
 * Install grants: how an installed Home Screen app joins the device its
 * browser already enrolled (9 October 2026).
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * On an iPhone, Safari and an app added to the Home Screen from it keep
 * separate IndexedDB. The browser enrolled with an enrollment QR and holds the
 * device's key; the app installed a minute later holds nothing, and used to
 * need a second enrollment QR, which made a second `DEVICE-nnn` for the same
 * phone.
 *
 * ── The mechanism ───────────────────────────────────────────────────────────
 * iOS and iPadOS 17.2 and later copy the browser's **cookies** into a newly
 * added Home Screen app (WebKit documents this; nothing else is copied). So:
 *
 *   1. The browser's key, the device's ROOT credential, proves itself with a
 *      fresh signed challenge and is given an **install grant**: 256 random
 *      bits in a cookie, of which the server keeps only the hash.
 *   2. "Add to Home Screen" copies that cookie into the new app.
 *   3. The app, finding no key of its own, generates one (non-extractable, in
 *      its own IndexedDB), proves it holds it, and presents the grant. The
 *      server registers the key as an APP credential of the **same**
 *      `DEVICE-nnn` and the grant is spent.
 *
 * ── What a grant is, and is not ─────────────────────────────────────────────
 *  · Issued only after a fresh proof from a ROOT credential that is ACTIVE on
 *    an APPROVED device. An APP credential can never obtain one.
 *  · One use (`DeviceStore.attachCredential`, an `O_EXCL` marker per grant),
 *    and one outstanding per device: issuing a new one cancels the last, and
 *    so does revoking the device or its ROOT.
 *  · **No time limit** (14 October 2026; it was 15 minutes). Someone may add
 *    the app to the Home Screen days after enrolling the browser, and the
 *    grant they need must still be there. The server keeps it until it is
 *    used, replaced or cancelled; only the cookie has a lifetime, the longest
 *    a browser keeps one (`INSTALL_GRANT_COOKIE_MS`), and it is renewed well
 *    before that runs out.
 *  · It registers one installed-app key under the device that asked. It signs
 *    nobody in, reads nothing, creates no device and cannot mint another
 *    grant. Signing in still needs the person's password, every time.
 *  · The cookie is `HttpOnly` (page script cannot read it), `Secure`,
 *    `SameSite=Strict`, and scoped to `INSTALL_GRANT_PATH`, so it is sent to
 *    the attach routes and to nothing else on this origin, FabOrchestrator's
 *    forwarded pages and API included.
 *
 * ── What it does not stop ───────────────────────────────────────────────────
 * Script running on this origin inside an approved browser can ask the ROOT
 * key to sign, and so could obtain a grant and attach a key of its own. That
 * is the same exposure the device key already had (`lib/devices/keystore.ts`).
 * It is bounded here: one installed-app credential per device (attaching
 * another supersedes the last, which the owner then sees), an audit line and
 * an entry on `/device-admin` for every attachment, with the address it came
 * from, per-credential and per-device revocation, and the password that
 * sign-in still needs. With no time limit, a grant left unused in a browser
 * can be used whenever that browser's cookies are: the device's own
 * approval, and its revocation, govern it, not a clock.
 *
 * ── Switched by `DEVICE_INSTALL_GRANTS` ─────────────────────────────────────
 * Unset or `on`: grants are issued and accepted. Anything else: they are not,
 * the routes answer 404, and an installed app enrolls with an enrollment QR
 * as before. A rollback that needs no deploy of older code.
 */

import type { NextRequest, NextResponse } from "next/server";
import { isHttps } from "@/lib/faborch/session";
import { SECRET_TOKEN } from "./credential";

export const INSTALL_GRANTS_ENV = "DEVICE_INSTALL_GRANTS";

export function installGrantsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env[INSTALL_GRANTS_ENV] ?? "").trim().toLowerCase();
  return value === "" || value === "on";
}

/** A grant's lifetime on the server: none. It stands until used, replaced or cancelled. */
export const INSTALL_GRANT_TTL_MS = null;

/**
 * The grant cookie's lifetime: 400 days, the longest Chrome keeps any cookie
 * (and longer than Safari keeps an idle site's data). The grant itself does
 * not run out; this is only how long the browser holds it.
 */
export const INSTALL_GRANT_COOKIE_MS = 400 * 24 * 60 * 60 * 1000;

/** When the cookie holding a grant issued at `createdAt` is dropped by the browser. */
export function grantCookieUntil(createdAt: number): number {
  return createdAt + INSTALL_GRANT_COOKIE_MS;
}

/**
 * A browser asks again whenever a page loads or returns to the foreground. It
 * is given a new grant when it does not hold the outstanding one (used,
 * cancelled, or its cookie lost), or when that one's cookie has less than this
 * left; otherwise the outstanding one stands, so an app installed from it a
 * moment ago is not cut off by its own browser.
 */
export const INSTALL_GRANT_RENEW_BELOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The only paths the grant cookie is sent to. */
export const INSTALL_GRANT_PATH = "/api/pwa/device-credentials";

const COOKIE_BASE = "fo_install";

/**
 * `__Secure-fo_install` everywhere except plain http on a loopback host (a
 * developer's machine, the tests), where the prefix cannot be set. Not
 * `__Host-`: that prefix forbids the narrow path this cookie is scoped to.
 */
export function installGrantCookieName(req: NextRequest): string {
  return isHttps(req) ? `__Secure-${COOKIE_BASE}` : COOKIE_BASE;
}

/** The grant code on this request, or null when there is not exactly one well-formed one. */
export function installGrantToken(req: NextRequest): string | null {
  const prefix = `${installGrantCookieName(req)}=`;
  const found = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  const raw = found.length === 1 ? found[0]!.slice(prefix.length) : null;
  return raw && SECRET_TOKEN.test(raw) ? raw : null;
}

export function setInstallGrantCookie(req: NextRequest, res: NextResponse, token: string, cookieUntil: number, now: number = Date.now()): void {
  const name = installGrantCookieName(req);
  res.cookies.set({
    name,
    value: token,
    httpOnly: true,
    secure: name.startsWith("__Secure-"),
    // Strict: its only readers are same-origin POSTs from this app's own pages.
    sameSite: "strict",
    path: INSTALL_GRANT_PATH,
    maxAge: Math.max(1, Math.floor((cookieUntil - now) / 1000)),
  });
}

export function clearInstallGrantCookie(req: NextRequest, res: NextResponse): void {
  const name = installGrantCookieName(req);
  res.cookies.set({
    name,
    value: "",
    httpOnly: true,
    secure: name.startsWith("__Secure-"),
    sameSite: "strict",
    path: INSTALL_GRANT_PATH,
    maxAge: 0,
  });
}
