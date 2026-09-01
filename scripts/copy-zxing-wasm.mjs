/**
 * Copies zxing's reader wasm into `public/zxing/` so the app can serve it itself.
 *
 * zxing-wasm fetches its binary from a CDN (jsDelivr) by default. That is the
 * one thing this app must not do: a factory network that cannot reach
 * fonts.googleapis.com — the reason `app/layout.tsx` self-hosts Plus Jakarta
 * Sans — cannot reach a CDN either, and a scanner that works at a desk and
 * fails at the line is worse than no scanner. `lib/scan/barcode.ts` points
 * `locateFile` at the copy this script writes.
 *
 * Run by `postinstall` rather than committed: it is a 1 MB binary whose only
 * correct version is the one in `node_modules` right now, and a stale copy in
 * git is a bug that reproduces on exactly one machine. `public/zxing/` is
 * gitignored for the same reason.
 */

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm");
const targetDir = join(root, "public", "zxing");
const target = join(targetDir, "zxing_reader.wasm");

if (!existsSync(source)) {
  // Not fatal. `npm install` runs this before every dependency is guaranteed
  // present in every install order, and the scanner degrades to manual entry.
  console.warn("[zxing] reader wasm not found in node_modules; skipping copy.");
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log("[zxing] wrote public/zxing/zxing_reader.wasm");
