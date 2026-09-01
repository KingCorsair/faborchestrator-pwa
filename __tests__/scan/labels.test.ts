/**
 * The demo labels must actually decode.
 *
 * `generate-demo-labels.ts` hand-rolls Code 39 — nine elements a character,
 * three of them wide — and a hand-rolled symbology that is subtly wrong still
 * *looks* exactly like a barcode. The only honest check is to read it back with
 * the same decoder the app uses, which is what this does: same `zxing-wasm`,
 * same `Code39` format, same `tryHarder`.
 *
 * This is as close to end-to-end as the scanner gets without a camera. It
 * proves the encoder, the PNG writer, `extractOrderNumber` and the decoder all
 * agree; what it cannot prove is that a phone can see a screen.
 *
 * Run: npm run test:scan
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractOrderNumber } from "../../lib/scan/barcode";

const ROOT = join(import.meta.dirname, "..", "..");
const ORDERS = ["PO-10382", "PO-10344", "PO-10365", "PO-10377", "PO-10391", "PO-10402"];

/**
 * The wasm is handed over as bytes rather than located by URL: Node's `fetch`
 * cannot load `file://`, and the browser path (`/zxing/…`, served by Next) does
 * not exist in a test process.
 */
async function reader() {
  const { prepareZXingModule, readBarcodes } = await import("zxing-wasm/reader");
  const wasm = readFileSync(
    join(ROOT, "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm"),
  );
  prepareZXingModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    },
  });
  return readBarcodes;
}

describe("demo labels", () => {
  it("every label decodes to its own order number", async () => {
    const readBarcodes = await reader();

    for (const order of ORDERS) {
      const png = readFileSync(join(ROOT, "public", "demo-labels", `${order}.png`));
      const results = await readBarcodes(new Blob([png], { type: "image/png" }), {
        formats: ["Code39"],
        tryHarder: true,
      });

      const hit = results.find((r) => r.isValid);
      assert.ok(hit, `${order}: no valid barcode found in the generated label`);
      assert.equal(hit.format, "Code39");
      assert.equal(hit.text, order, `${order}: label decodes to "${hit.text}"`);

      // And the decoded text survives the step the app actually takes next.
      assert.equal(extractOrderNumber(hit.text), order);
    }
  });
});
