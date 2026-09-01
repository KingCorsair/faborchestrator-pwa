/**
 * Generates scannable Code 39 labels for the demo orders.
 *
 * The scanner had nothing to point at. You cannot demonstrate
 * "scan a production order" without a production order barcode, and photographs
 * of someone else's label on a phone screen are exactly the sort of prop that
 * fails live.
 *
 * ── Why Code 39 and not QR ──────────────────────────────────────────────────
 * Two reasons, both practical. It is what production travellers are actually
 * printed with, so the demo shows the real thing rather than a QR code nobody
 * on a shop floor would ever see. And it encodes in about forty lines: each
 * character is nine elements, three of them wide, with no error correction and
 * no matrix placement. A QR encoder is Reed–Solomon, masking and a version
 * table — several hundred lines, or a second wasm binary, for a demo prop.
 *
 * `lib/scan/barcode.ts` already lists `code_39` for both backends, so nothing
 * on the reading side changes.
 *
 * The human-readable number is deliberately *not* drawn into the PNG — there is
 * no font here, and `app/labels/page.tsx` renders it in Plus Jakarta Sans under
 * the image, which looks like the product rather than like bitmap text.
 *
 * Run: npm run labels
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Canvas, encodePng, rgb } from "./png";

/**
 * Code 39, as bar/space widths: nine elements per character, alternating
 * bar-space-bar…, starting and ending on a bar. `w` is wide, `n` is narrow.
 * Exactly three of the nine are wide in every character — which is where the
 * name comes from and what makes the symbology self-checking.
 */
const CODE39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn",
  "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw",
  "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw",
  E: "wnnnwwnnn", F: "nnwnwwnnn", G: "nnnnnwwnw", H: "wnnnnwwnn",
  I: "nnwnnwwnn", J: "nnnnwwwnn", K: "wnnnnnnww", L: "nnwnnnnww",
  M: "wnwnnnnwn", N: "nnnnwnnww", O: "wnnnwnnwn", P: "nnwnwnnwn",
  Q: "nnnnnnwww", R: "wnnnnnwwn", S: "nnwnnnwwn", T: "nnnnwnwwn",
  U: "wwnnnnnnw", V: "nwwnnnnnw", W: "wwwnnnnnn", X: "nwnnwnnnw",
  Y: "wwnnwnnnn", Z: "nwwnwnnnn",
  "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn",
  /** Start and stop. Never appears in the decoded text. */
  "*": "nwnnwnwnn",
};

const NARROW = 3;
const WIDE = NARROW * 3; // 3:1 — comfortably inside the 2:1–3:1 the spec allows
const BAR_HEIGHT = 150;
/** Ten narrow modules of clear space each side, as the spec requires to decode. */
const QUIET = NARROW * 10;

const INK = rgb("#10153a"); // --navy-3, so the labels read as FabOrchestrator
const PAPER = rgb("#ffffff");

function encode(text: string): Canvas {
  const chars = `*${text.toUpperCase()}*`;

  for (const ch of chars) {
    if (!CODE39[ch]) throw new Error(`Code 39 cannot encode ${JSON.stringify(ch)} in "${text}"`);
  }

  // Width first, so the canvas is allocated once at the right size.
  const charWidth = (pattern: string) =>
    [...pattern].reduce((sum, el) => sum + (el === "w" ? WIDE : NARROW), 0);
  const body =
    [...chars].reduce((sum, ch) => sum + charWidth(CODE39[ch]), 0) +
    NARROW * (chars.length - 1); // one narrow space between characters

  const canvas = new Canvas(QUIET * 2 + body, BAR_HEIGHT, PAPER);

  let x = QUIET;
  for (let i = 0; i < chars.length; i++) {
    const pattern = CODE39[chars[i]];
    for (let e = 0; e < pattern.length; e++) {
      const width = pattern[e] === "w" ? WIDE : NARROW;
      // Even elements are bars, odd are spaces. Spaces are simply skipped —
      // the canvas is already paper-coloured.
      if (e % 2 === 0) canvas.fillRect(x, 0, width, BAR_HEIGHT, INK);
      x += width;
    }
    if (i < chars.length - 1) x += NARROW; // inter-character gap
  }

  return canvas;
}

/* ── output ────────────────────────────────────────────────────────────────── */

/**
 * Every order in the mock dataset, so a scan can be demonstrated against
 * something other than the one scenario order — including an order with no
 * detected problems, which is a perfectly good thing to show.
 */
const ORDERS = ["PO-10382", "PO-10344", "PO-10365", "PO-10377", "PO-10391", "PO-10402"];

const outDir = join(import.meta.dirname, "..", "public", "demo-labels");
mkdirSync(outDir, { recursive: true });

for (const order of ORDERS) {
  const png = encodePng(encode(order));
  writeFileSync(join(outDir, `${order}.png`), png);
  console.log(`${order}.png  ${png.length} bytes`);
}
