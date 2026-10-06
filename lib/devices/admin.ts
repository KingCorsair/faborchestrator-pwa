/**
 * Who may issue enrollments and revoke devices.
 *
 * ── An explicit allowlist, not FabOrchestrator's role name ──────────────────
 * This app learns a role *label* from FabOrchestrator's `/api/auth/me` at
 * sign-in (`lib/auth.ts`), and FabOrchestrator's role names are not a contract
 * this app can rely on: a renamed role would silently grant or remove the
 * power to approve devices. So device administrators are named in
 * `DEVICE_ADMIN_EMAILS` (comma-separated FabOrchestrator emails). Unset means
 * nobody: the API refuses every administration request, and the first
 * enrollment is issued with the bootstrap CLI (`scripts/device-enrollment.mjs`)
 * from a shell on the machine.
 *
 * An administrator needs, on every request: an approved device (when the gate
 * is enforced), a valid session (`requireAuth`), and an email on the list.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { SessionPayload } from "@/lib/auth";
import { requireAuth } from "@/lib/auth-middleware";
import { requireApprovedDevice } from "./gate";
import { normaliseEmail, type Device } from "./store";

export const DEVICE_ADMIN_ENV = "DEVICE_ADMIN_EMAILS";

export function deviceAdminEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env[DEVICE_ADMIN_ENV] ?? "")
      .split(",")
      .map((entry) => normaliseEmail(entry))
      .filter(Boolean),
  );
}

export async function requireDeviceAdmin(
  req: NextRequest,
): Promise<{ admin: SessionPayload; device: Device | null } | NextResponse> {
  const device = await requireApprovedDevice(req);
  if (device instanceof NextResponse) return device;
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!deviceAdminEmails().has(normaliseEmail(auth.user.email))) {
    return NextResponse.json(
      { code: "forbidden", error: "Only a device administrator can do this." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return { admin: auth.user, device: device.device };
}
