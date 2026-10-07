import { NextResponse, type NextRequest } from "next/server";
import { issueChallenge, testEnabled, type Purpose } from "@/lib/device-crypto-test/challenges";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Device-credential feasibility test only (`lib/device-crypto-test/`): a fresh,
 * single-use, 60-second challenge for one public key. 404 unless
 * `DEVICE_CRYPTO_TEST=1`.
 */
export async function POST(req: NextRequest) {
  if (!testEnabled()) return NextResponse.json({ code: "not_found", error: "Not found." }, { status: 404, headers: NO_STORE });
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "Same-origin only." }, { status: 403, headers: NO_STORE });
  }
  const body = await readJsonBody(req, 4096);
  const value = (body.tooLarge ? null : body.value) as { purpose?: unknown; keyFingerprint?: unknown } | null;
  const purpose: Purpose | null = value?.purpose === "enroll" || value?.purpose === "verify" ? value.purpose : null;
  const issued =
    purpose && typeof value?.keyFingerprint === "string" ? issueChallenge(purpose, value.keyFingerprint) : null;
  if (!issued) return NextResponse.json({ code: "invalid_request", error: "Bad challenge request." }, { status: 400, headers: NO_STORE });
  return NextResponse.json(issued, { headers: NO_STORE });
}
