/**
 * Scan-payload tests.
 *
 * The decoders themselves are not tested here — one is the browser's and one is
 * a wasm binary, and neither runs under `node --test`. What is testable, and
 * what actually breaks on a shop floor, is the step after decoding: turning
 * whatever a label encodes into an order number.
 *
 * Real travellers do not encode a bare `PO-10382`. They encode a URL, or a
 * pipe-delimited record, or the number with a printer's prefix. A scanner that
 * only handles the demo's own QR codes is a scanner that fails at the customer.
 *
 * Run: npm run test:scan
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractOrderNumber } from "../../lib/scan/barcode";

describe("extractOrderNumber", () => {
  it("reads a bare order number", () => {
    assert.equal(extractOrderNumber("PO-10382"), "PO-10382");
  });

  it("reads one out of a URL", () => {
    assert.equal(extractOrderNumber("https://mes.example/orders/PO-10382"), "PO-10382");
  });

  it("reads one out of a delimited record", () => {
    assert.equal(extractOrderNumber("^PO-10382|OP30|ASM-04|2026-08-10"), "PO-10382");
  });

  it("tolerates the separators label printers actually emit", () => {
    for (const raw of ["PO10382", "PO_10382", "PO 10382", "po-10382"]) {
      assert.equal(extractOrderNumber(raw), "PO-10382", raw);
    }
  });

  it("normalises to the canonical form the API accepts", () => {
    // `OrderNumberSchema` is /^PO-\d{1,10}$/i, so anything this returns must
    // survive being put straight into the route. A scan that produced
    // "po 10382" would 400 on a screen that says the scan succeeded.
    const scanned = extractOrderNumber("po 10382");
    assert.ok(scanned);
    assert.match(scanned, /^PO-\d{1,10}$/);
  });

  it("returns null for a label that holds no order number", () => {
    // The operator scanned the machine's asset tag. That is a real answer, and
    // the sheet says so rather than searching for nothing.
    for (const raw of ["ASM-04", "https://example.com", "", "PO-"]) {
      assert.equal(extractOrderNumber(raw), null, raw);
    }
  });

  it("takes the first order number when a label carries two", () => {
    assert.equal(extractOrderNumber("PO-10382 supersedes PO-10365"), "PO-10382");
  });
});
