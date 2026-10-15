import { NextResponse, type NextRequest } from "next/server";
import { requireDeviceAdmin } from "@/lib/devices/admin";
import { deviceAudit } from "@/lib/devices/audit";
import { CREDENTIAL_ID } from "@/lib/devices/challenges";
import { DEVICE_ID } from "@/lib/devices/credential";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { credentialView } from "@/lib/devices/views";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { RevokeDeviceSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Revoke **one credential** of a device and leave the device approved: for
 * example the installed app on a phone whose browser should keep working, or
 * an attachment nobody recognises.
 *
 * From its next request, that credential's sessions open nothing on this
 * origin (the proxy checks the credential a session signed in with,
 * `lib/devices/gate.ts`) and it can no longer sign in. The device's other
 * credential is untouched. Revoking the ROOT also cancels any outstanding
 * install grant and stops new ones; to stop everything, revoke the device.
 *
 * Idempotent: revoking a revoked credential answers 200 and keeps the first
 * revocation's time and administrator.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ deviceId: string; credentialId: string }> }) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "This has to come from this app." }, { status: 403, headers: NO_STORE });
  }
  const auth = await requireDeviceAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { deviceId, credentialId } = await ctx.params;
  const notFound = () => NextResponse.json({ code: "not_found", error: "No such credential." }, { status: 404, headers: NO_STORE });
  if (!DEVICE_ID.test(deviceId) || !CREDENTIAL_ID.test(credentialId)) return notFound();

  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  if (body.tooLarge) {
    return NextResponse.json({ code: "body_too_large", error: "That request is too large." }, { status: 413 });
  }
  const parsed = RevokeDeviceSchema.safeParse(body.value ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { code: "invalid_request", error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const store = deviceStore();
    // The credential must be this device's: the path names both.
    if (!(await store.resolveCredential(deviceId, credentialId))) return notFound();
    const result = await store.revokeCredential(credentialId, {
      by: auth.admin.email,
      reason: parsed.data.reason || "revoked by administrator",
    });
    if (!result) return notFound();
    if (result.changed) {
      deviceAudit("CREDENTIAL_REVOKED", {
        deviceId,
        credentialId,
        actor: auth.admin.email,
        reason: result.credential.endReason,
      });
    }
    return NextResponse.json({ credential: credentialView(result.credential), changed: result.changed }, { headers: NO_STORE });
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/credential-revoke", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "The credential could not be revoked just now. Try again." },
      { status: 503, headers: NO_STORE },
    );
  }
}
