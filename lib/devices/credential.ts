/**
 * Secrets and identifiers for device enrollment (6 October 2026).
 *
 * The **device stamp is not here**. It is `DEVICE-nnn` plus an ECDSA P-256
 * private key the device generates itself, non-extractable, kept in its own
 * IndexedDB (`lib/devices/keystore.ts`); the server holds only the public key
 * (`lib/devices/store.ts`) and checks signed challenges
 * (`lib/devices/challenges.ts`). No cookie carries a device credential.
 *
 * What is here: the one-time **enrollment code** (256 bits from the CSPRNG,
 * stored as SHA-256) and the short-lived cookie that carries it from the
 * enrollment link to the enrollment page, so the code leaves the address bar
 * at once. That cookie is the temporary permission to enroll one device, not
 * an identity; it is cleared when the enrollment completes and expires with
 * the enrollment.
 */

import { createHash, randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { hostCookieName } from "@/lib/faborch/device";

/** The pending-enrollment cookie: the enrollment code, between opening the link and enrolling. */
export const ENROLLMENT_COOKIE_BASE = "fo_enroll";

/** A device id as this app assigns them. */
export const DEVICE_ID = /^DEVICE-\d{3,9}$/;

/** 32 random bytes, base64url: what `newSecretToken` produces. */
export const SECRET_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A SHA-256, base64url: what `hashSecret` produces. */
export const SECRET_HASH = /^[A-Za-z0-9_-]{43}$/;

/** 256 bits from the operating system's CSPRNG. */
export function newSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The one-way hash the server keeps of an enrollment code. A fast hash is right
 * here: the input is 256 random bits, so there is nothing for a slow hash to
 * protect against.
 */
export function hashSecret(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function enrollmentCookieName(req: NextRequest): string {
  return hostCookieName(req, ENROLLMENT_COOKIE_BASE);
}

/**
 * Read exactly one cookie of `name` from the raw header. More than one is
 * treated as none: which of two same-named cookies is meant must not be
 * decided silently (the seat cookie's rule, `lib/faborch/device.ts`).
 */
function singleCookie(req: NextRequest, name: string): string | null {
  const prefix = `${name}=`;
  const found = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  return found.length === 1 ? found[0]!.slice(prefix.length) : null;
}

function secure(name: string): boolean {
  return name.startsWith("__Host-");
}

/** The pending enrollment's code, or null when there is not exactly one well-formed one. */
export function pendingEnrollmentToken(req: NextRequest): string | null {
  const raw = singleCookie(req, enrollmentCookieName(req));
  return raw && SECRET_TOKEN.test(raw) ? raw : null;
}

export function setEnrollmentCookie(req: NextRequest, res: NextResponse, token: string, maxAgeS: number): void {
  const name = enrollmentCookieName(req);
  res.cookies.set({
    name,
    value: token,
    httpOnly: true,
    secure: secure(name),
    // Lax, not Strict: it is set on the redirect that answers a scanned QR
    // code, a navigation that starts outside the browser, and the page that
    // redirect lands on must receive it. Its only reader that acts on it is a
    // same-origin JSON POST, which carries the route's own cross-site check.
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(1, Math.floor(maxAgeS)),
  });
}

export function clearEnrollmentCookie(req: NextRequest, res: NextResponse): void {
  const name = enrollmentCookieName(req);
  res.cookies.set({ name, value: "", path: "/", maxAge: 0, httpOnly: true, secure: secure(name) });
}
