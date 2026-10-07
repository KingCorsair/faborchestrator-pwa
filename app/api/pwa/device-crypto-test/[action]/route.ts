import { NextResponse, type NextRequest } from "next/server";
import { issueChallenge, testEnabled, verifyProof } from "@/lib/device-crypto-test/challenges";
import {
  createEnrollment,
  finishAccess,
  finishEnrollment,
  setStatus,
  snapshot,
  startAccess,
  startEnrollment,
} from "@/lib/device-crypto-test/registry";
import { enrollmentQrSvg } from "@/lib/devices/enrollment";
import { checkLoginAllowed, clientAddress, recordLoginFailure } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const str = (v: unknown, max = 512): string | null => (typeof v === "string" && v.length <= max ? v : null);

/**
 * The device-credential feasibility test's API (`lib/device-crypto-test/`).
 * 404 unless `DEVICE_CRYPTO_TEST=1`. Isolated: an in-memory registry, never the
 * production device store, never the device gate.
 *
 *   GET  state             what the test admin panel shows (no tokens, no hashes)
 *   POST enrollments       create a one-time Enrollment QR
 *   POST enroll-start      { token } → challenge, only if the code is usable
 *   POST enroll-finish     { token, challengeId, publicKeySpki, signature } → DEVICE-nnn
 *   POST access-start      { deviceId } → challenge
 *   POST access-finish     { deviceId, challengeId, signature } → approved / revoked
 *   POST revoke, reinstate { deviceId }
 *   POST challenge, verify the debug buttons (a challenge bound to a key fingerprint)
 *
 * The admin actions are open to anyone who can reach the page while the flag is
 * on: this is a test harness, not the product's administration.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  if (!testEnabled()) return json({ code: "not_found" }, 404);
  const { action } = await ctx.params;
  if (action !== "state") return json({ code: "not_found" }, 404);
  return json(snapshot());
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  if (!testEnabled()) return json({ code: "not_found" }, 404);
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") return json({ code: "cross_site_request" }, 403);
  const { action } = await ctx.params;
  const body = await readJsonBody(req, 8192);
  const v = ((body.tooLarge ? null : body.value) ?? {}) as Record<string, unknown>;
  const address = `crypto-test:${clientAddress(req.headers)}`;

  switch (action) {
    case "enrollments": {
      const origin = publicOrigin();
      if (!origin) return json({ code: "not_configured", error: "PUBLIC_ORIGIN is not set." }, 503);
      const { enrollment, token } = createEnrollment();
      const url = `${origin}/device-crypto-test?enroll=${token}`;
      return json(
        { enrollmentId: enrollment.enrollmentId, expiresAt: enrollment.expiresAt, url, qrSvg: await enrollmentQrSvg(url) },
        201,
      );
    }
    case "enroll-start": {
      if (!checkLoginAllowed(address).allowed) return json({ code: "rate_limited" }, 429);
      const result = startEnrollment(str(v.token, 64) ?? "");
      if (!result.ok) {
        if (result.problem === "unknown") recordLoginFailure(address);
        return json(result, 410);
      }
      return json(result);
    }
    case "enroll-finish": {
      const token = str(v.token, 64);
      const challengeId = str(v.challengeId, 64);
      const spki = str(v.publicKeySpki, 400);
      const signature = str(v.signature, 128);
      if (!token || !challengeId || !spki || !signature) return json({ code: "invalid_request" }, 400);
      const result = finishEnrollment({ token, challengeId, publicKeySpki: spki, signature });
      return result.ok
        ? json({ ok: true, deviceId: result.device.deviceId, fingerprint: result.device.fingerprint, status: result.device.status })
        : json(result, result.problem === "bad_proof" ? 401 : 410);
    }
    case "access-start": {
      const result = startAccess(str(v.deviceId, 32) ?? "");
      return json(result, result.ok ? 200 : 404);
    }
    case "access-finish": {
      const deviceId = str(v.deviceId, 32);
      const challengeId = str(v.challengeId, 64);
      const signature = str(v.signature, 128);
      if (!deviceId || !challengeId || !signature) return json({ code: "invalid_request" }, 400);
      const result = finishAccess({ deviceId, challengeId, signature });
      return json(result, result.result === "approved" ? 200 : 403);
    }
    case "revoke":
    case "reinstate": {
      const device = setStatus(str(v.deviceId, 32) ?? "", action === "revoke" ? "REVOKED" : "APPROVED");
      return device ? json({ deviceId: device.deviceId, status: device.status }) : json({ code: "not_found" }, 404);
    }
    case "challenge": {
      const fingerprint = str(v.keyFingerprint, 32);
      const issued = fingerprint && /^[0-9a-f]{32}$/.test(fingerprint) ? issueChallenge("verify", fingerprint) : null;
      return issued ? json(issued) : json({ code: "invalid_request" }, 400);
    }
    case "verify": {
      const challengeId = str(v.challengeId, 64);
      const spki = str(v.publicKeySpki, 400);
      const signature = str(v.signature, 128);
      const fingerprint = str(v.keyFingerprint, 32);
      if (!challengeId || !spki || !signature || !fingerprint) return json({ code: "invalid_request" }, 400);
      const result = verifyProof({ challengeId, purpose: "verify", subject: fingerprint, publicKeySpki: spki, signature });
      return json(result, result.ok ? 200 : 401);
    }
    default:
      return json({ code: "not_found" }, 404);
  }
}
