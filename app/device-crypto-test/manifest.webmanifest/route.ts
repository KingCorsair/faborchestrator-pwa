import { NextResponse } from "next/server";
import { testEnabled } from "@/lib/device-crypto-test/challenges";

/**
 * The feasibility test's own manifest: installing from `/device-crypto-test`
 * makes a separate Home Screen app whose start URL and scope are the test page,
 * with its own installed-app storage. 404 unless `DEVICE_CRYPTO_TEST=1`.
 */
export function GET() {
  if (!testEnabled()) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(
    {
      id: "/device-crypto-test",
      name: "FO Crypto Test",
      short_name: "FO Crypto Test",
      start_url: "/device-crypto-test",
      scope: "/device-crypto-test",
      display: "standalone",
      background_color: "#f6f7fc",
      theme_color: "#4b3fd6",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } },
  );
}
