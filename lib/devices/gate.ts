/**
 * The approved-device gate (device enrollment, 6 October 2026).
 *
 * ── The device stamp, and where it is checked ──────────────────────────────
 * A device is approved by a one-time enrollment QR: it generates an ECDSA
 * P-256 key pair with Web Crypto, keeps the non-extractable private key in its
 * own IndexedDB, and registers the public key as `DEVICE-nnn`. There is no
 * device cookie. The device proves itself by signing a fresh challenge, and it
 * does so **at sign-in**, before FabOrchestrator is asked about the password:
 *
 *   device proof (sign-in page + `/api/pwa/auth/login`)
 *     → FabOrchestrator sign-in → the session is bound to DEVICE-nnn on the
 *       server (`DeviceStore.bindSession`)
 *     → every later request on that session: this file checks that the
 *       session's device is still APPROVED
 *     → FabOrchestrator's own authorization → FabOrchestrator
 *
 * A request without a session reaches nothing of FabOrchestrator's: documents
 * are sent to sign-in by the session gate in `proxy.ts`, where the device check
 * runs first and an unenrolled device is sent to `/device-blocked`; API calls
 * are refused for want of a session. So every request that can reach
 * FabOrchestrator data has passed a device proof, and revoking a device stops
 * its sessions on their next request.
 *
 * The device check and the user check stay separate: the device belongs to no
 * user, and any FabOrchestrator account may sign in on an approved device.
 *
 * ── Switched by `DEVICE_GATE` ───────────────────────────────────────────────
 *   unset, empty or `off`  nothing is checked or required (the rollback; how
 *                          devices are enrolled before the gate is turned on)
 *   `enforce`              sign-in needs a device proof; sessions must belong
 *                          to an APPROVED device
 *   anything else          treated as `enforce`: a typo must not open the door
 *
 * With the gate enforced and the store unusable, sessions are refused and so
 * is sign-in. It fails closed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { foFingerprint } from "@/lib/auth";
import { foTokenFrom } from "@/lib/faborch/session";
import { clientAddress } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { deviceAudit } from "./audit";
import {
  deviceStore,
  DeviceStoreNotConfiguredError,
  DeviceStoreUnavailableError,
  type Device,
  type DeviceStore,
} from "./store";

export const DEVICE_GATE_ENV = "DEVICE_GATE";

export const DEVICE_BLOCKED_PAGE = "/device-blocked";
export const DEVICE_ENROLL_PAGE = "/device-enroll";
export const DEVICE_ADMIN_PAGE = "/device-admin";
/** The in-app QR scanner's decoder, served by this app (`app/device-blocked/zxing_reader.wasm`). */
export const DEVICE_SCANNER_WASM = "/device-blocked/zxing_reader.wasm";

export type DeviceGateMode = "enforce" | "off";

export function deviceGateMode(env: Record<string, string | undefined> = process.env): DeviceGateMode {
  const value = (env[DEVICE_GATE_ENV] ?? "").trim().toLowerCase();
  return value === "" || value === "off" ? "off" : "enforce";
}

/**
 * Paths whose requests are never refused for their session's device: what a
 * device needs to be told it is not approved, to enroll, to prove itself and
 * sign in, to sign out, and to install the app. None returns FabOrchestrator
 * data. (A request here still meets the session gate and every route's own
 * checks.)
 */
const EXEMPT_EXACT = new Set([
  DEVICE_BLOCKED_PAGE,
  DEVICE_ENROLL_PAGE,
  DEVICE_SCANNER_WASM,
  "/api/pwa/device-enrollments/start",
  "/api/pwa/device-enrollments/complete",
  "/api/pwa/device-auth/challenge",
  "/login",
  "/api/pwa/auth/login",
  "/api/pwa/auth/logout",
  "/offline",
  "/sw.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
]);

export function isDeviceExempt(pathname: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  // `/device-enroll/<code>`: one segment, nothing deeper.
  return /^\/device-enroll\/[^/]+$/.test(pathname);
}

export type BlockReason =
  /** The session never signed in with a device proof (or its binding has lapsed). */
  | "unbound_session"
  /** The session's device is no longer in the store. */
  | "unknown_device"
  | "revoked"
  | "not_configured"
  | "store_unavailable";

export type DeviceCheck =
  | { ok: true; device: Device }
  | { ok: false; reason: BlockReason; deviceId?: string }
  /** No session on the request: nothing to check here; sign-in will ask for a proof. */
  | { ok: "no-session" };

/** The device this request's session signed in with, and whether it may still be used. */
export async function checkSessionDevice(req: NextRequest, store?: DeviceStore): Promise<DeviceCheck> {
  const foToken = foTokenFrom(req);
  if (!foToken) return { ok: "no-session" };
  try {
    const device = await (store ?? deviceStore()).sessionDevice(foFingerprint(foToken));
    if (!device) return { ok: false, reason: "unbound_session" };
    if (device.status !== "APPROVED") return { ok: false, reason: "revoked", deviceId: device.deviceId };
    return { ok: true, device };
  } catch (error) {
    if (error instanceof DeviceStoreUnavailableError) {
      reportError("devices/gate", error);
      return { ok: false, reason: error instanceof DeviceStoreNotConfiguredError ? "not_configured" : "store_unavailable" };
    }
    throw error;
  }
}

type RequestKind = "api" | "document" | "asset";

function requestKind(pathname: string): RequestKind {
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  if (pathname.startsWith("/_next/") || /\.[^/]+$/.test(pathname)) return "asset";
  return "document";
}

export const DEVICE_NOT_APPROVED = {
  code: "device_not_approved",
  error: "This device is not approved to access FabOrchestrator. Contact your administrator to enroll it.",
} as const;

/**
 * The refusal, in the shape the caller can use. A document goes to the blocked
 * page, which signs the session out (ending it at FabOrchestrator too) and,
 * if this device holds an approved key, offers to sign in again with a proof.
 */
export function deviceBlockedResponse(req: NextRequest, reason: BlockReason): NextResponse {
  const kind = requestKind(req.nextUrl.pathname);
  const unavailable = reason === "not_configured" || reason === "store_unavailable";
  if (kind === "api") {
    return NextResponse.json(
      unavailable
        ? { code: "device_check_unavailable", error: "This device could not be checked just now. Try again shortly." }
        : DEVICE_NOT_APPROVED,
      { status: unavailable ? 503 : 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (kind === "asset") {
    return new NextResponse(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const url = req.nextUrl.clone();
  url.pathname = DEVICE_BLOCKED_PAGE;
  url.search = `?reason=${unavailable ? "unavailable" : reason === "revoked" ? "revoked" : "session"}`;
  const res = NextResponse.redirect(url, 307);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/* ── Blocked-request logging, bounded ──────────────────────────────────────── */

const BLOCK_LOG_INTERVAL_MS = 60_000;
const MAX_BLOCK_KEYS = 10_000;
const lastBlockLog = new Map<string, number>();

function logBlocked(req: NextRequest, reason: BlockReason, deviceId: string | undefined, now: number): void {
  const kind = requestKind(req.nextUrl.pathname);
  if (kind === "asset") return;
  const address = clientAddress(req.headers);
  const key = `${reason}|${deviceId ?? ""}|${address}|${kind}`;
  const last = lastBlockLog.get(key);
  if (last !== undefined && now - last < BLOCK_LOG_INTERVAL_MS) return;
  if (lastBlockLog.size >= MAX_BLOCK_KEYS) lastBlockLog.clear();
  lastBlockLog.set(key, now);
  deviceAudit("DEVICE_ACCESS_BLOCKED", { reason, deviceId, requestKind: kind, address });
}

/** Testing seam. */
export function resetDeviceGateLogs(): void {
  lastBlockLog.clear();
}

/**
 * The proxy's check: null to continue, or the refusal to answer with. A
 * request without a session continues (it reaches nothing but sign-in and
 * public files). Logs a blocked request (bounded) and an allowed device each
 * time its last use is written down, not on every request.
 */
export async function deviceGate(req: NextRequest, now: number = Date.now()): Promise<NextResponse | null> {
  const check = await checkSessionDevice(req);
  if (check.ok === "no-session") return null;
  if (!check.ok) {
    logBlocked(req, check.reason, check.deviceId, now);
    return deviceBlockedResponse(req, check.reason);
  }
  if (await deviceStore().recordSeen(check.device.deviceId, now)) {
    deviceAudit("DEVICE_ACCESS_ALLOWED", { deviceId: check.device.deviceId, site: check.device.site });
  }
  return null;
}

/**
 * For a route handler, in `requireAuth`'s convention: `{ device }` or a
 * response to return. With the gate off there is no device to require, and
 * `device` is null. A request with no session is refused: the routes that call
 * this need one.
 */
export async function requireApprovedDevice(req: NextRequest): Promise<{ device: Device | null } | NextResponse> {
  if (deviceGateMode() === "off") return { device: null };
  const check = await checkSessionDevice(req);
  if (check.ok === "no-session") {
    return NextResponse.json(DEVICE_NOT_APPROVED, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (!check.ok) {
    logBlocked(req, check.reason, check.deviceId, Date.now());
    return deviceBlockedResponse(req, check.reason);
  }
  return { device: check.device };
}
