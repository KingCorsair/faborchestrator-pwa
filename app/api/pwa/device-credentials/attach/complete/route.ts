import { NextResponse, type NextRequest } from "next/server";
import { deviceAudit } from "@/lib/devices/audit";
import { verifyProof } from "@/lib/devices/challenges";
import { clearInstallGrantCookie, installGrantsEnabled, installGrantToken } from "@/lib/devices/install-grant";
import { requestOrigin } from "@/lib/devices/origin";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { AttachCredentialSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Step 2 of an installed app joining its device
 * (`lib/devices/install-grant.ts`). The app has generated its own key pair,
 * private key non-extractable in its own IndexedDB, and sends the public key
 * with its signature over the attach challenge.
 *
 *  1. The grant, from its httpOnly cookie, must still be usable.
 *  2. The signature is checked against the public key sent, which proves the
 *     app holds the private key. The challenge is bound to this grant and is
 *     spent whatever the outcome.
 *  3. The store consumes the grant **exactly once** (`attachCredential`, an
 *     `O_EXCL` marker per grant) and registers the key as an APP credential of
 *     the grant's device. **No device is created.** An installed-app
 *     credential the device already had is superseded by the same record.
 *  4. The answer is the device id. No session is created and nobody is signed
 *     in: the app goes on to the ordinary sign-in, with its own proof.
 *
 * Whether the credential is a ROOT or an APP is not asked and cannot be said:
 * one attached with a grant is an APP, and an APP can never obtain a grant.
 */
export async function POST(req: NextRequest) {
  if (!installGrantsEnabled()) {
    return NextResponse.json({ code: "not_found", error: "Not available." }, { status: 404, headers: NO_STORE });
  }
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "This has to come from this app." }, { status: 403, headers: NO_STORE });
  }
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ code: "unsupported_media_type", error: "This expects JSON." }, { status: 415, headers: NO_STORE });
  }
  const address = clientAddress(req.headers);
  const limiterKey = `attach:${address}`;
  if (!checkLoginAllowed(limiterKey).allowed) {
    return NextResponse.json({ code: "rate_limited", error: "Too many attempts. Try again in a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  const parsed = AttachCredentialSchema.safeParse(body.tooLarge ? null : body.value);
  if (!parsed.success) {
    return NextResponse.json({ code: "invalid_request", error: "Bad attach request." }, { status: 400, headers: NO_STORE });
  }
  const token = installGrantToken(req);
  if (!token) {
    return NextResponse.json({ code: "no_install_grant", error: "This app has no install grant." }, { status: 404, headers: NO_STORE });
  }

  try {
    const store = deviceStore();
    const lookup = await store.lookupGrant(token);
    if (lookup.kind !== "valid") {
      if (lookup.kind === "unknown") recordLoginFailure(limiterKey);
      return unusable(req, lookup.kind, lookup.kind === "unknown" ? null : lookup.grant.grantId, address);
    }
    const { grant } = lookup;
    const proof = verifyProof({
      challengeId: parsed.data.challengeId,
      purpose: "attach",
      subject: grant.grantId,
      publicKeySpki: parsed.data.publicKeySpki,
      signature: parsed.data.signature,
    });
    if (!proof.ok) {
      recordLoginFailure(limiterKey);
      deviceAudit("INSTALL_GRANT_REJECTED", { reason: `proof_${proof.reason}`, grantId: grant.grantId, deviceId: grant.deviceId, address });
      return NextResponse.json(
        { code: "attach_proof_invalid", error: "This app could not prove its new key. Try again." },
        { status: 401, headers: NO_STORE },
      );
    }

    const result = await store.attachCredential({
      token,
      publicKeySpki: parsed.data.publicKeySpki,
      context: parsed.data.installedApp === true ? "installed-app" : "browser",
      origin: requestOrigin(req, parsed.data),
    });
    if (result.kind !== "attached") return unusable(req, result.kind, grant.grantId, address);

    const { device, credential, superseded } = result;
    deviceAudit("CREDENTIAL_ATTACHED", {
      deviceId: device.deviceId,
      credentialId: credential.credentialId,
      relatedCredentialId: credential.parentId,
      grantId: grant.grantId,
      site: device.site,
      address,
    });
    for (const old of superseded) {
      deviceAudit("CREDENTIAL_SUPERSEDED", {
        deviceId: device.deviceId,
        credentialId: old.credentialId,
        relatedCredentialId: credential.credentialId,
      });
    }
    const res = NextResponse.json(
      { ok: true, device: { deviceId: device.deviceId, friendlyName: device.friendlyName }, credentialId: credential.credentialId },
      { headers: NO_STORE },
    );
    clearInstallGrantCookie(req, res);
    return res;
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/attach-complete", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "This could not be done just now. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
}

function unusable(req: NextRequest, reason: string, grantId: string | null, address: string): NextResponse {
  deviceAudit("INSTALL_GRANT_REJECTED", { reason: `grant_${reason}`, grantId, address });
  const res = NextResponse.json(
    { code: "install_grant_invalid", reason, error: "This app's install grant has already been used or was replaced." },
    { status: 410, headers: NO_STORE },
  );
  clearInstallGrantCookie(req, res);
  return res;
}
