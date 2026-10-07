import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { testEnabled } from "@/lib/device-crypto-test/challenges";

/**
 * The QR decoder's wasm for the feasibility test's in-app scanner, served by
 * this app from `zxing-wasm` (never a CDN). Traced into the standalone build by
 * `outputFileTracingIncludes` in `next.config.ts`. 404 unless
 * `DEVICE_CRYPTO_TEST=1`.
 */
export async function GET() {
  if (!testEnabled()) return new NextResponse("Not found", { status: 404 });
  const bytes = await readFile(join(process.cwd(), "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm"));
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": "application/wasm", "Cache-Control": "public, max-age=3600" },
  });
}
