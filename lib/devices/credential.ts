/**
 * The approved-device credential (device enrollment, 6 October 2026).
 *
 * ── What it is ──────────────────────────────────────────────────────────────
 * A device is approved by going through a one-time enrollment an administrator
 * issued (`lib/devices/store.ts`). At the end of it this app mints, for that
 * browser only:
 *
 *   device id     `DEVICE-001`, a public label, assigned in order
 *   device token  32 bytes from `crypto.randomBytes` (256 bits), base64url
 *
 * and keeps both in one httpOnly cookie, `__Host-fo_device=<id>.<token>`. The
 * server keeps only the SHA-256 of the token. Every request is checked against
 * it before anything else on this origin answers (`lib/devices/gate.ts`).
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 * **It is a bearer credential.** It identifies the browser (or installed app)
 * that holds this cookie, not the physical phone: nothing here proves a serial
 * number, and anybody who copies the cookie's value can present it from another
 * machine until the device is revoked. It is not derived from any hardware
 * identifier, fingerprint or user agent, and it is not the seat cookie
 * (`lib/faborch/device.ts`), which any browser gets at its first sign-in and
 * which grants nothing. The upgrade path, if cloning resistance is ever needed,
 * is a non-exportable device key with a challenge-response (WebAuthn, or an
 * enterprise device identity such as Entra/Intune) in place of
 * `verifyPresented` below; the store, the gate and the admin screens do not
 * depend on which verifier is used.
 *
 * ── Why a cookie, not IndexedDB ─────────────────────────────────────────────
 * The check has to happen *in front of* the document (`proxy.ts`), and only a
 * cookie arrives with a navigation. httpOnly keeps the token out of reach of
 * page scripts, including FabOrchestrator's own pages served on this origin.
 * `__Host-` (Secure, Path=/, host-only) means a sibling host cannot set it and a
 * script cannot shadow it at another path. SameSite=Lax so it is sent on the
 * top-level navigation a scanned QR code opens; state-changing routes carry
 * their own same-origin checks.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { hostCookieName } from "@/lib/faborch/device";

/** The cookie's base name; `__Host-` is added everywhere but loopback http. */
export const DEVICE_CREDENTIAL_COOKIE_BASE = "fo_device";

/** The pending-enrollment cookie: the enrollment token, between scanning the link and signing in. */
export const ENROLLMENT_COOKIE_BASE = "fo_enroll";

/** 400 days: the longest lifetime browsers honour. Renewed at every sign-in. */
export const DEVICE_CREDENTIAL_MAX_AGE_S = 400 * 24 * 60 * 60;

/** A device id as this app assigns them. */
export const DEVICE_ID = /^DEVICE-\d{3,9}$/;

/** 32 random bytes, base64url: what `newSecretToken` produces. */
export const SECRET_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A SHA-256, base64url: what `hashSecret` produces. */
export const SECRET_HASH = /^[A-Za-z0-9_-]{43}$/;

/** 256 bits from the operating system's CSPRNG. Used for device and enrollment tokens alike. */
export function newSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The one-way hash the server keeps. A fast hash is right here: the input is
 * 256 random bits, so there is nothing for a slow hash to protect against.
 */
export function hashSecret(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Whether `token` hashes to `expectedHash`, compared in constant time. */
export function secretMatches(token: string, expectedHash: string): boolean {
  const presented = Buffer.from(hashSecret(token));
  const expected = Buffer.from(expectedHash);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export function deviceCredentialCookieName(req: NextRequest): string {
  return hostCookieName(req, DEVICE_CREDENTIAL_COOKIE_BASE);
}

export function enrollmentCookieName(req: NextRequest): string {
  return hostCookieName(req, ENROLLMENT_COOKIE_BASE);
}

export interface PresentedCredential {
  deviceId: string;
  token: string;
  /** The cookie's value as presented, for renewing it without re-deriving it. */
  raw: string;
}

/**
 * Read exactly one cookie of `name` from the raw header. More than one is
 * treated as none: which of two same-named cookies is "the" credential must not
 * be decided silently (the seat cookie's rule, `lib/faborch/device.ts`).
 */
function singleCookie(req: NextRequest, name: string): string | null {
  const prefix = `${name}=`;
  const found = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  return found.length === 1 ? found[0]!.slice(prefix.length) : null;
}

export type PresentedRead =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "present"; credential: PresentedCredential };

/** The device credential on this request, if it has exactly one well-formed one. */
export function presentedCredential(req: NextRequest): PresentedRead {
  const raw = singleCookie(req, deviceCredentialCookieName(req));
  if (raw === null || raw === "") return { kind: "none" };
  const dot = raw.lastIndexOf(".");
  const deviceId = dot > 0 ? raw.slice(0, dot) : "";
  const token = dot > 0 ? raw.slice(dot + 1) : "";
  if (!DEVICE_ID.test(deviceId) || !SECRET_TOKEN.test(token)) return { kind: "malformed" };
  return { kind: "present", credential: { deviceId, token, raw } };
}

/** The value the device credential cookie holds. */
export function credentialValue(deviceId: string, token: string): string {
  return `${deviceId}.${token}`;
}

function secure(name: string): boolean {
  return name.startsWith("__Host-");
}

/** Issue (or renew) the device credential on this browser. */
export function setDeviceCredentialCookie(req: NextRequest, res: NextResponse, value: string): void {
  const name = deviceCredentialCookieName(req);
  res.cookies.set({
    name,
    value,
    httpOnly: true,
    secure: secure(name),
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_CREDENTIAL_MAX_AGE_S,
  });
}

/** The pending enrollment's token, or null when there is not exactly one well-formed one. */
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
    // Strict: it is only ever read by this app's own enrollment page and its
    // own POST, both same-origin, after the redirect that set it.
    sameSite: "strict",
    path: "/",
    maxAge: Math.max(1, Math.floor(maxAgeS)),
  });
}

export function clearEnrollmentCookie(req: NextRequest, res: NextResponse): void {
  const name = enrollmentCookieName(req);
  res.cookies.set({ name, value: "", path: "/", maxAge: 0, httpOnly: true, secure: secure(name) });
}
