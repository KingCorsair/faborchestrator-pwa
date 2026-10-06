import { NextResponse, type NextRequest } from "next/server";
import { requireDeviceAdmin } from "@/lib/devices/admin";
import { deviceAudit } from "@/lib/devices/audit";
import { enrollmentQrSvg, enrollmentTtlMs, enrollmentUrl } from "@/lib/devices/enrollment";
import { deviceStore, DeviceStoreUnavailableError } from "@/lib/devices/store";
import { enrollmentView } from "@/lib/devices/views";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { publicOrigin, sameOriginVerdict } from "@/lib/same-origin";
import { CreateEnrollmentSchema, SMALL_JSON_BODY_LIMIT } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Device enrollments, for administrators (`lib/devices/admin.ts`).
 *
 * POST issues a one-time enrollment for one user and answers with the link and
 * its QR code. **This is the only response that ever carries the enrollment
 * token**, and it goes to the administrator who asked; the store keeps its
 * hash. GET lists the enrollments still waiting to be used, without tokens.
 *
 * Bearer-authenticated, so another site cannot forge either call; the
 * same-origin check on POST is the convention every state-changing route here
 * follows anyway.
 */
export async function POST(req: NextRequest) {
  if (sameOriginVerdict(req.headers, publicOrigin()) === "cross-site") {
    return NextResponse.json(
      { code: "cross_site_request", error: "This has to come from this app." },
      { status: 403, headers: NO_STORE },
    );
  }
  const auth = await requireDeviceAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const body = await readJsonBody(req, SMALL_JSON_BODY_LIMIT);
  if (body.tooLarge) {
    return NextResponse.json({ code: "body_too_large", error: "That request is too large." }, { status: 413 });
  }
  const parsed = CreateEnrollmentSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "invalid_request", error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400, headers: NO_STORE },
    );
  }

  let ttlMs: number;
  try {
    ttlMs = enrollmentTtlMs();
  } catch (error) {
    reportError("devices/enrollment-config", error);
    return notConfigured("The enrollment lifetime is misconfigured on this server.");
  }
  if (!publicOrigin()) {
    // Without a configured origin the link would have to be built from the
    // request's Host header, which is exactly what must not happen.
    return notConfigured("PUBLIC_ORIGIN is not set on this server, so no enrollment link can be issued.");
  }

  try {
    const { enrollment, token } = await deviceStore().createEnrollment({
      allowedEmail: parsed.data.email,
      createdBy: auth.admin.email,
      site: parsed.data.site,
      friendlyName: parsed.data.friendlyName,
      ttlMs,
    });
    const url = enrollmentUrl(token)!;
    deviceAudit("DEVICE_ENROLLMENT_CREATED", {
      enrollmentId: enrollment.enrollmentId,
      email: enrollment.allowedEmail,
      site: enrollment.site,
      actor: auth.admin.email,
      expiresAt: new Date(enrollment.expiresAt).toISOString(),
    });
    return NextResponse.json(
      { enrollment: enrollmentView(enrollment), url, qrSvg: await enrollmentQrSvg(url) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    return storeFailure(error);
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireDeviceAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const pending = await deviceStore().listPendingEnrollments();
    return NextResponse.json({ enrollments: pending.map(enrollmentView) }, { headers: NO_STORE });
  } catch (error) {
    return storeFailure(error);
  }
}

function notConfigured(error: string) {
  return NextResponse.json({ code: "not_configured", error }, { status: 503, headers: NO_STORE });
}

function storeFailure(error: unknown) {
  if (!(error instanceof DeviceStoreUnavailableError)) throw error;
  reportError("devices/enrollments", error);
  return NextResponse.json(
    { code: "device_store_unavailable", error: "Devices cannot be managed just now. Try again shortly." },
    { status: 503, headers: NO_STORE },
  );
}
