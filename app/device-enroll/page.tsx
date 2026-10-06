import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { NextRequest } from "next/server";
import { DeviceCard, Notice } from "@/components/devices/device-card";
import { EnrollForm } from "@/components/devices/enroll-form";
import { enrollmentCookieName, SECRET_TOKEN } from "@/lib/devices/credential";
import { deviceStore, DeviceStoreUnavailableError, type EnrollmentLookup } from "@/lib/devices/store";
import { reportError } from "@/lib/report-error";

export const metadata: Metadata = {
  title: "Enroll this device — FabOrchestrator",
  robots: "noindex, nofollow",
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * `/device-enroll` — the page the enrollment link lands on, after
 * `app/device-enroll/[token]` has moved the token into a cookie and out of the
 * address bar. It shows who the enrollment is for and asks that user to prove
 * it; `/api/pwa/device-enrollments/complete` does the rest.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { link } = await searchParams;
  const lookup = await pendingEnrollment();

  if (link === "limited") {
    return (
      <Frame>
        <Notice tone="error">Too many attempts from this network. Try again in a few minutes.</Notice>
      </Frame>
    );
  }
  if (link === "unavailable" || lookup === "unavailable") {
    return (
      <Frame>
        <Notice tone="error">Enrollment is not available just now. Try again shortly.</Notice>
      </Frame>
    );
  }
  if (lookup === null || lookup.kind !== "valid") {
    return (
      <Frame>
        <Notice tone="error">
          {link === "invalid" || lookup !== null
            ? "This enrollment link has expired or has already been used."
            : "Open the enrollment link or QR code your administrator gave you, on the device you want to enroll."}
        </Notice>
        <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
          Enrollment links work once and expire after a few minutes. Ask your administrator for a new one.
        </p>
      </Frame>
    );
  }

  return (
    <Frame>
      <p className="m-0 text-[14px] leading-[1.6]" style={{ color: "var(--text-muted-cool)" }}>
        Your administrator has approved one device for{" "}
        <strong style={{ color: "var(--text-ink)" }}>{lookup.enrollment.allowedEmail}</strong>. Sign in with that
        FabOrchestrator account to make <em>this</em> device the approved one. The link then stops working.
      </p>
      <EnrollForm
        email={lookup.enrollment.allowedEmail}
        expiresAt={new Date(lookup.enrollment.expiresAt).toISOString()}
      />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <DeviceCard eyebrow="DEVICE ENROLLMENT" title="Enroll this device">
      {children}
    </DeviceCard>
  );
}

/** The enrollment this browser's pending cookie names, null for none, or "unavailable". */
async function pendingEnrollment(): Promise<EnrollmentLookup | null | "unavailable"> {
  // The cookie's name depends on the host and scheme (`hostCookieName`), which
  // the helpers read from a request.
  const h = await headers();
  const req = new NextRequest(`http://${h.get("host") ?? "localhost"}/device-enroll`, { headers: h });
  const token = (await cookies()).get(enrollmentCookieName(req))?.value;
  if (!token || !SECRET_TOKEN.test(token)) return null;
  try {
    return await deviceStore().lookupEnrollment(token);
  } catch (error) {
    if (!(error instanceof DeviceStoreUnavailableError)) throw error;
    reportError("devices/enroll-page", error);
    return "unavailable";
  }
}
