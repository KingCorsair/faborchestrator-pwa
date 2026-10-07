import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

/**
 * The QR decoder's wasm for the in-app enrollment scanner on `/device-blocked`
 * (`lib/devices/scanner.ts`), served by this app from `zxing-wasm`, never a CDN.
 * Traced into the standalone build by `outputFileTracingIncludes` in
 * `next.config.ts`. Public, like any other script asset: it holds no data.
 */
export async function GET() {
  const bytes = await readFile(join(process.cwd(), "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm"));
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": "application/wasm", "Cache-Control": "public, max-age=86400" },
  });
}
