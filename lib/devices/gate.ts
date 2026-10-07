/**
 * The approved-device gate: **is this browser an enrolled, approved device?**
 * (device enrollment, 6 October 2026).
 *
 * ── Where it runs ───────────────────────────────────────────────────────────
 * In `proxy.ts`, in front of everything else on this origin: before the
 * sign-in gate, before this app's pages and APIs, and before any request is
 * handed to the FabOrchestrator gateway. So the order on every request is
 *
 *   device check (this file) → user session (`gate` in proxy.ts, `requireAuth`)
 *     → FabOrchestrator's own authorization → FabOrchestrator
 *
 * and an unapproved device never reaches sign-in, let alone FabOrchestrator.
 * Device approval says nothing about who the person is, and the user session
 * says nothing about the device: the two checks stay separate. Routes that
 * need it twice (the device administration API) call `requireApprovedDevice`
 * again rather than trusting that the proxy ran.
 *
 * ── Switched by `DEVICE_GATE` ───────────────────────────────────────────────
 *   unset, empty or `off`  the gate is off: nothing is checked (the rollback,
 *                          and how devices are enrolled before it is turned on)
 *   `enforce`              every request not on the exempt list must carry an
 *                          approved device credential
 *   anything else          treated as `enforce`: a typo must not open the door
 *
 * With the gate enforced and the store unusable (`DEVICE_STORE_PATH` unset, or
 * the file unreadable), every request is refused. It fails closed.
 *
 * ── What may pass without a device ──────────────────────────────────────────
 * Only what an unenrolled phone needs to be told it is unenrolled, to enroll,
 * and to install the app: the blocked page, the enrollment page and its link
 * and completion endpoint, sign-out (which only ends sessions), the offline
 * page, the service worker, the manifest and icons, and this app's own build
 * chunks (handled before this check in `proxy.ts`). None of them reads or
 * returns FabOrchestrator data.
 */

import { NextResponse, type NextRequest } from "next/server";
import { clientAddress } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { deviceAudit } from "./audit";
import { presentedCredential } from "./credential";
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
export const DEVICE_ENROLLMENT_COMPLETE_API = "/api/pwa/device-enrollments/complete";

export type DeviceGateMode = "enforce" | "off";

export function deviceGateMode(env: Record<string, string | undefined> = process.env): DeviceGateMode {
  const value = (env[DEVICE_GATE_ENV] ?? "").trim().toLowerCase();
  return value === "" || value === "off" ? "off" : "enforce";
}

const EXEMPT_EXACT = new Set([
  DEVICE_BLOCKED_PAGE,
  DEVICE_ENROLL_PAGE,
  DEVICE_ENROLLMENT_COMPLETE_API,
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

/** Paths an unapproved device may reach. Exact matches, plus the enrollment link itself. */
export function isDeviceExempt(pathname: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  // `/device-enroll/<token>`: one segment, nothing deeper.
  return /^\/device-enroll\/[^/]+$/.test(pathname);
}

export type BlockReason =
  | "missing"
  | "malformed"
  | "unknown_device"
  | "token_mismatch"
  | "revoked"
  | "not_configured"
  | "store_unavailable";

export type DeviceCheck = { ok: true; device: Device } | { ok: false; reason: BlockReason; deviceId?: string };

/**
 * Verify the device credential on this request. The verifier is the bearer
 * token check in the store; replacing it with a challenge-response one would
 * change this function and `lib/devices/credential.ts` only.
 */
export async function checkApprovedDevice(req: NextRequest, store?: DeviceStore): Promise<DeviceCheck> {
  const presented = presentedCredential(req);
  if (presented.kind === "none") return { ok: false, reason: "missing" };
  if (presented.kind === "malformed") return { ok: false, reason: "malformed" };
  const { deviceId, token } = presented.credential;

  try {
    const verdict = await (store ?? deviceStore()).verifyDevice(deviceId, token);
    switch (verdict.kind) {
      case "approved":
        return { ok: true, device: verdict.device };
      case "revoked":
        return { ok: false, reason: "revoked", deviceId };
      case "mismatch":
        return { ok: false, reason: "token_mismatch", deviceId };
      case "unknown":
        return { ok: false, reason: "unknown_device" };
    }
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
 * The refusal, in the shape the caller can use. Every reason looks the same
 * from outside except a store fault, which the blocked page words differently
 * so an approved phone is not told it was never approved.
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
  url.search = unavailable ? "?reason=unavailable" : "";
  const res = NextResponse.redirect(url, 307);
  // A cached redirect would outlive an enrollment, exactly as the sign-in gate's would.
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/* ── Blocked-request logging, bounded ──────────────────────────────────────── */

const BLOCK_LOG_INTERVAL_MS = 60_000;
const MAX_BLOCK_KEYS = 10_000;
const lastBlockLog = new Map<string, number>();

function logBlocked(req: NextRequest, check: Extract<DeviceCheck, { ok: false }>, now: number): void {
  const kind = requestKind(req.nextUrl.pathname);
  if (kind === "asset") return; // a blocked page's sub-requests would drown the signal
  const address = clientAddress(req.headers);
  const key = `${check.reason}|${check.deviceId ?? ""}|${address}|${kind}`;
  const last = lastBlockLog.get(key);
  if (last !== undefined && now - last < BLOCK_LOG_INTERVAL_MS) return;
  if (lastBlockLog.size >= MAX_BLOCK_KEYS) lastBlockLog.clear();
  lastBlockLog.set(key, now);
  deviceAudit("DEVICE_ACCESS_BLOCKED", { reason: check.reason, deviceId: check.deviceId, requestKind: kind, address });
}

/** Testing seam. */
export function resetDeviceGateLogs(): void {
  lastBlockLog.clear();
}

/**
 * The proxy's check: null to continue, or the refusal to answer with. Logs a
 * blocked request (bounded) and an allowed device each time its last use is
 * written down (`SEEN_PERSIST_MS`), not on every request.
 */
export async function deviceGate(req: NextRequest, now: number = Date.now()): Promise<NextResponse | null> {
  const check = await checkApprovedDevice(req);
  if (!check.ok) {
    logBlocked(req, check, now);
    return deviceBlockedResponse(req, check.reason);
  }
  const store = deviceStore();
  if (await store.recordSeen(check.device.deviceId, now)) {
    deviceAudit("DEVICE_ACCESS_ALLOWED", { deviceId: check.device.deviceId, site: check.device.site });
  }
  return null;
}

/**
 * For a route handler, in `requireAuth`'s convention: `{ device }` or a
 * response to return. With the gate off there is no device to require, and
 * `device` is null.
 */
export async function requireApprovedDevice(req: NextRequest): Promise<{ device: Device | null } | NextResponse> {
  if (deviceGateMode() === "off") return { device: null };
  const check = await checkApprovedDevice(req);
  if (!check.ok) {
    logBlocked(req, check, Date.now());
    return deviceBlockedResponse(req, check.reason);
  }
  return { device: check.device };
}
