import { NextResponse, type NextRequest } from "next/server";
import { deviceAudit } from "@/lib/devices/audit";
import { DEVICE_NOT_APPROVED } from "@/lib/devices/gate";
import {
  grantCookieUntil,
  INSTALL_GRANT_RENEW_BELOW_MS,
  INSTALL_GRANT_TTL_MS,
  installGrantsEnabled,
  installGrantToken,
  setInstallGrantCookie,
} from "@/lib/devices/install-grant";
import { verifyCredentialProof } from "@/lib/devices/proof";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { DeviceProofSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Give this device's ROOT credential an install grant
 * (`lib/devices/install-grant.ts`): the one-time permission an app added to the
 * Home Screen from this browser needs to join the same `DEVICE-nnn`.
 *
 * The browser calls this in the background while its pages are open, so that
 * whenever the person adds the app to the Home Screen there is a grant in the
 * cookies iOS copies into it.
 *
 *  1. **A fresh proof from the ROOT key**: a signature over a `grant` challenge
 *     (`/api/pwa/device-auth/challenge`), single use, bound to that
 *     credential, checked against the public key the store holds. Nothing the
 *     caller says makes it a ROOT: the store's record does.
 *  2. Refused for an APP credential, a credential that is not ACTIVE, and a
 *     device that is not APPROVED.
 *  3. If this browser still holds the device's outstanding grant (its cookie
 *     is on this request: the cookie's path covers this route) and the cookie
 *     has plenty of time left, it stands and nothing new is issued. Otherwise
 *     a new one is issued, which cancels the old: one outstanding grant per
 *     device. Grants have no time limit (14 October 2026); `expiresAt` in the
 *     answer is when the browser will drop the cookie.
 *  4. The code goes into an httpOnly cookie scoped to the attach routes. It is
 *     never in a response body, and only its hash is stored.
 *
 * No session is needed, created or changed: this is about the device, and a
 * person may add the app to the Home Screen before signing in.
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
  const limiterKey = `install-grant:${address}`;
  const allowed = checkLoginAllowed(limiterKey);
  if (!allowed.allowed) {
    return NextResponse.json(
      { code: "rate_limited", error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(allowed.retryAfterSeconds) } },
    );
  }
  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  const parsed = DeviceProofSchema.safeParse(body.tooLarge ? null : body.value);
  if (!parsed.success) {
    return NextResponse.json({ code: "invalid_request", error: "Bad install grant request." }, { status: 400, headers: NO_STORE });
  }

  try {
    const store = deviceStore();
    const now = Date.now();
    const proof = await verifyCredentialProof(parsed.data, "grant", store, now);
    if (!proof.ok) {
      recordLoginFailure(limiterKey);
      deviceAudit("INSTALL_GRANT_REJECTED", { deviceId: proof.deviceId, credentialId: proof.credentialId, reason: `proof_${proof.reason}`, address });
      return NextResponse.json(DEVICE_NOT_APPROVED, { status: 403, headers: NO_STORE });
    }
    const { device, credential } = proof;
    if (credential.kind !== "ROOT") {
      deviceAudit("INSTALL_GRANT_REJECTED", { deviceId: device.deviceId, credentialId: credential.credentialId, reason: "not_root", address });
      return NextResponse.json(
        { code: "not_root", error: "Only the browser this device was enrolled in can do this." },
        { status: 403, headers: NO_STORE },
      );
    }

    // What the browser shows its owner: the app currently attached to this
    // device, if any. Only after the proof, so only to the device itself.
    const attached = (await store.credentialsOf(device.deviceId)).find((c) => c.kind === "APP" && c.status === "ACTIVE");
    const app = attached ? { credentialId: attached.credentialId, addedAt: new Date(attached.createdAt).toISOString() } : null;

    const latest = await store.latestGrant(credential.credentialId, now);
    const held = installGrantToken(req);
    const heldGrant = held ? await store.lookupGrant(held, now) : null;
    const holdsLatest = latest?.state === "ISSUED" && heldGrant?.kind === "valid" && heldGrant.grant.grantId === latest.grant.grantId;
    if (holdsLatest && grantCookieUntil(latest.grant.createdAt) - now > INSTALL_GRANT_RENEW_BELOW_MS) {
      return NextResponse.json(
        { ok: true, kept: true, expiresAt: new Date(grantCookieUntil(latest.grant.createdAt)).toISOString(), app },
        { headers: NO_STORE },
      );
    }

    const issued = await store.issueGrant({ credentialId: credential.credentialId, ttlMs: INSTALL_GRANT_TTL_MS, now });
    if (issued.kind !== "issued") {
      deviceAudit("INSTALL_GRANT_REJECTED", { deviceId: device.deviceId, credentialId: credential.credentialId, reason: issued.kind, address });
      return NextResponse.json(DEVICE_NOT_APPROVED, { status: 403, headers: NO_STORE });
    }
    const cookieUntil = grantCookieUntil(issued.grant.createdAt);
    const expiresAt = new Date(cookieUntil).toISOString();
    deviceAudit("INSTALL_GRANT_ISSUED", {
      deviceId: device.deviceId,
      credentialId: credential.credentialId,
      grantId: issued.grant.grantId,
      expiresAt,
      address,
    });
    const res = NextResponse.json({ ok: true, kept: false, expiresAt, app }, { headers: NO_STORE });
    setInstallGrantCookie(req, res, issued.token, cookieUntil, now);
    return res;
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/install-grant", error);
    return NextResponse.json(
      { code: "device_store_unavailable", error: "This could not be done just now. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
}
