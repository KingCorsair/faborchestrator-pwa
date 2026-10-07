import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { randomBytes } from "node:crypto";
import { CryptoTest } from "@/components/device-crypto-test/crypto-test";
import { testEnabled } from "@/lib/device-crypto-test/challenges";
import { enrollmentQrSvg } from "@/lib/devices/enrollment";
import { publicOrigin } from "@/lib/same-origin";

/**
 * `/device-crypto-test` — developer-only feasibility test for the Option 2
 * device stamp (non-exportable Web Crypto key in IndexedDB). 404 unless
 * `DEVICE_CRYPTO_TEST=1`.
 *
 * It has its **own manifest** (`./manifest.webmanifest`, start_url and scope
 * this page), so "Add to Home Screen" from here installs a separate test app,
 * "FO Crypto Test". On iOS every Home Screen app has its own storage, so this
 * tests exactly what the real installed app would get, without changing the
 * real app's pages or manifest.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "FO Crypto Test",
  robots: "noindex, nofollow",
  manifest: "/device-crypto-test/manifest.webmanifest",
  appleWebApp: { capable: true, title: "FO Crypto Test", statusBarStyle: "default" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#4b3fd6" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!testEnabled()) notFound();
  const { enroll } = await searchParams;
  const origin = publicOrigin();
  // A throwaway enrollment-style value, made per page load. Not a real enrollment.
  const enrollUrl = origin ? `${origin}/device-crypto-test?enroll=TEST-${randomBytes(12).toString("base64url")}` : null;
  const normalUrl = origin ? `${origin}/` : null;

  return (
    <CryptoTest
      enrollUrl={enrollUrl}
      normalUrl={normalUrl}
      enrollQrSvg={enrollUrl ? await enrollmentQrSvg(enrollUrl) : null}
      normalQrSvg={normalUrl ? await enrollmentQrSvg(normalUrl) : null}
      openedWithEnrollToken={typeof enroll === "string" && /^TEST-[A-Za-z0-9_-]{8,64}$/.test(enroll) ? enroll : null}
    />
  );
}
