/**
 * Generates the PWA icons in `public/`.
 *
 * They are committed as PNGs, but they are generated rather than drawn so the
 * palette stays tied to `faborch-theme.css` — an icon that drifts from the
 * product's accent is the kind of thing nobody notices until it is on a
 * hundred tablets. Re-run with `npm run icons` after changing the colours here.
 *
 * The PNG encoder lives in `png.ts`, shared with the demo-label generator —
 * dependency-free rather than sharp/canvas, because flat-colour
 * rectangles-and-lines images do not justify a native module in the install.
 *
 * Run: npm run icons
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Canvas, encodePng, rgb } from "./png";

/* ── palette ───────────────────────────────────────────────────────────────
   From `app/faborch-theme.css`, which copies them from the product's own
   `globals.css`. The two indigos are the ends of the gradient every brand
   surface in this app wears — the login button, the nav avatar, the brand
   tile. The header comment used to cite `console-theme.css`, a stylesheet this
   app does not have and never shipped; corrected 2026-08-23. */

const GROUND = rgb("#10153a"); // --navy-3, and the manifest's theme_color
const TILE_FROM = rgb("#6f73ff"); // --brand-indigo-light
const TILE_TO = rgb("#4842d4"); // --cockpit-indigo
const MARK = rgb("#ffffff");

/* ── the mark ──────────────────────────────────────────────────────────────── */

/**
 * The FabOrchestrator brand tile: the indigo gradient square with a white **F**.
 *
 * ── Why this replaced the progress bars (2026-08-23) ────────────────────────
 * The icon used to be three rounded progress bars on navy — the order screens'
 * own signature, chosen when this app was the Production Order Assistant and
 * an order's completion bar was the thing every card led with. It is now
 * FabOrchestrator's front door, and the mark a stakeholder recognises is the
 * one in the top nav and on the landing page: `components/fab/brand.tsx`'s
 * gradient tile with an F in it. A tab icon that disagrees with the wordmark
 * three centimetres below it is a small thing that reads as carelessness.
 *
 * ── Why the F is rectangles ────────────────────────────────────────────────
 * `png.ts` has no text rendering, and adding a font rasteriser to draw one
 * glyph would cost more than the icon is worth. An F is a stem and two arms,
 * which is three rounded rectangles — and at 16px in a browser tab, which is
 * where this is mostly seen, a drawn F and a typeset one are indistinguishable.
 * The proportions below are eyeballed against Plus Jakarta Sans ExtraBold, the
 * face `brand.tsx` sets the real one in.
 *
 * `safe` is the fraction of the canvas the **artwork** may occupy; `tile` is
 * the fraction the gradient square occupies. They differ for the maskable
 * icon, where launchers crop the outer 10% on every side and may clip to a
 * circle: the background must run edge to edge so no corner shows through,
 * while the F has to stay well inside.
 */
function drawMark(size: number, safe: number, tile: number): Canvas {
  const canvas = new Canvas(size, size, GROUND);

  // The tile. At `tile: 1` this covers the canvas with square corners, which
  // is what a maskable icon wants — the launcher supplies the rounding.
  const tileBox = size * tile;
  const tileInset = (size - tileBox) / 2; // zero when the tile is full-bleed
  const tileRadius = tile >= 1 ? 0 : tileBox * 0.22;
  canvas.fillRoundRect(tileInset, tileInset, tileBox, tileBox, tileRadius, TILE_FROM, TILE_TO);

  // The F, centred on the canvas and sized to the safe area.
  const box = size * safe;
  const capH = box * 0.82; // cap height
  const capW = capH * 0.62; // an F is markedly narrower than it is tall
  const stroke = capH * 0.215; // ExtraBold: a heavy stem
  const radius = stroke * 0.16; // barely rounded, as the face's terminals are

  const fx = (size - capW) / 2;
  const fy = (size - capH) / 2;

  // Stem, full height. Drawn first so the arms sit flush against it.
  canvas.fillRoundRect(fx, fy, stroke, capH, radius, MARK);
  // Top arm, full width.
  canvas.fillRoundRect(fx, fy, capW, stroke, radius, MARK);
  // Middle arm, shorter, a little above the optical centre — where the eye
  // expects it, rather than at the mathematical middle, which reads as low.
  canvas.fillRoundRect(fx, fy + capH * 0.41, capW * 0.8, stroke, radius, MARK);

  return canvas;
}

/* ── output ────────────────────────────────────────────────────────────────── */

const outDir = join(import.meta.dirname, "..", "public");

const targets: { file: string; size: number; safe: number; tile: number }[] = [
  { file: "icon-192.png", size: 192, safe: 0.5, tile: 0.92 },
  { file: "icon-512.png", size: 512, safe: 0.5, tile: 0.92 },
  // Maskable: gradient edge to edge, artwork inside the 40% safe circle.
  { file: "icon-maskable-512.png", size: 512, safe: 0.38, tile: 1 },
  // iOS. Without an apple-touch-icon, adding the app to the Home Screen uses a
  // *screenshot of the page* as the icon — which is the single most visible
  // defect in an iPhone demo. 180 is the size current iPhones ask for, and iOS
  // applies its own rounded mask, so the tile runs to the edge like the
  // maskable one while the F keeps the ordinary safe area.
  { file: "apple-touch-icon.png", size: 180, safe: 0.5, tile: 1 },
];

for (const { file, size, safe, tile } of targets) {
  const png = encodePng(drawMark(size, safe, tile));
  writeFileSync(join(outDir, file), png);
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
}
