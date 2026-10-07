import { NextResponse, type NextRequest } from "next/server";
import { testEnabled, verifyProof } from "@/lib/device-crypto-test/challenges";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Device-credential feasibility test only (`lib/device-crypto-test/`): verify a
 * browser's ECDSA P-256 signature over a challenge with Node's crypto, as the
 * production check would. The challenge is spent whatever the outcome. 404
 * unless `DEVICE_CRYPTO_TEST=1`.
 */
export async function POST(req: NextRequest) {
  if (!testEnabled()) return NextResponse.json({ code: "not_found", error: "Not found." }, { status: 404, headers: NO_STORE });
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json({ code: "cross_site_request", error: "Same-origin only." }, { status: 403, headers: NO_STORE });
  }
  const body = await readJsonBody(req, 8192);
  const v = (body.tooLarge ? null : body.value) as Record<string, unknown> | null;
  if (
    !v ||
    typeof v.challengeId !== "string" ||
    (v.purpose !== "enroll" && v.purpose !== "verify") ||
    typeof v.publicKeySpki !== "string" ||
    typeof v.signature !== "string"
  ) {
    return NextResponse.json({ code: "invalid_request", error: "Bad proof." }, { status: 400, headers: NO_STORE });
  }
  const result = verifyProof({
    challengeId: v.challengeId,
    purpose: v.purpose,
    publicKeySpki: v.publicKeySpki,
    signature: v.signature,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 401, headers: NO_STORE });
}
