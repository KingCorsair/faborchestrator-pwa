/**
 * Generates the QR code you send to whoever is opening the demo on a phone.
 *
 * ── Why a dependency here, when the Code 39 labels are hand-rolled ───────────
 * `generate-demo-labels.ts` encodes Code 39 in about forty lines because each
 * character is nine elements with no error correction and no matrix. QR is
 * Reed–Solomon over GF(256), a version table and eight mask patterns scored
 * against four penalty rules — several hundred lines to get right, and a
 * subtly wrong one produces an image that scans on your phone and not on
 * theirs. `qrcode` is a **devDependency**: it runs here, never in the browser
 * bundle, so this is not the trade CLAUDE.md's "reuse before adding" rule is
 * about.
 *
 * ── Two guards, both learned the hard way ────────────────────────────────────
 * The URL must be **https**. Over plain http the service worker will not
 * register and `getUserMedia` is unavailable, so the scanner is silently dead
 * and there is no offline page — an installed app missing both features the
 * install was meant to demonstrate. A QR is exactly the wrong place to
 * discover that, because nobody reads a URL they scanned.
 *
 * And it refuses a `trycloudflare.com` or `ngrok` host. Those URLs are
 * ephemeral: the QR outlives the tunnel by days, and a code that resolves to
 * nothing reads to the recipient as "the demo is broken" rather than "the
 * tunnel stopped".
 *
 * Error correction is level Q (~25%) rather than the usual M. This code is
 * photographed off a laptop screen, at an angle, with glare — the failure mode
 * redundancy actually fixes. The URL is short enough that the extra bytes cost
 * a version bump and nothing else.
 *
 * Run: npm run qr -- https://your-app.fly.dev/orders
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import QRCode from "qrcode";

/** --navy-3, so the code matches the demo labels and the product's ink. */
const INK = "#10153a";
const PAPER = "#ffffff";

const EPHEMERAL_HOSTS = ["trycloudflare.com", "ngrok.io", "ngrok-free.app", "ngrok.app", "loca.lt"];

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const input = process.argv[2];
if (!input) {
  fail("Usage: npm run qr -- https://your-app.fly.dev/");
}

let url: URL;
try {
  url = new URL(input);
} catch {
  fail(`"${input}" is not a URL. Include the scheme: https://…`);
}

if (url.protocol !== "https:") {
  fail(
    `${url.protocol}// will not work on a phone.\n` +
      "    The service worker cannot register and the camera is unavailable\n" +
      "    outside a secure context, so the scanner would be silently dead.",
  );
}

const ephemeral = EPHEMERAL_HOSTS.find((host) => url.hostname.endsWith(host));
if (ephemeral) {
  fail(
    `${url.hostname} is a tunnel URL, which changes every time the tunnel restarts.\n` +
      "    A QR code made from it stops resolving the moment you stop the tunnel.\n" +
      "    Deploy to a stable host first, then generate the code from that URL.",
  );
}

// Not `public/` — this encodes one deployment's URL, and serving it from the
// app itself would put a link to the app inside the app. `qr/` is gitignored
// for the same reason: it is specific to a deploy, not to the source.
const outDir = resolve(join(import.meta.dirname, "..", "qr"));
mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, `${url.hostname.replace(/[^a-z0-9]+/gi, "-")}.png`);

// Wrapped rather than awaited at the top level: tsx compiles these scripts to
// CJS (there is no `"type": "module"` in package.json), where top-level await
// is a syntax error. The sibling generators are all synchronous and never met
// this.
/**
 * Reads the PNG back with the decoder the app itself ships.
 *
 * The same argument `__tests__/scan/labels.test.ts` makes about Code 39: an
 * image that is subtly wrong still *looks* exactly like a QR code, and the
 * moment you find out is the moment somebody points a phone at it. Here the
 * cost of being wrong is higher than for a label, because the code is sent to
 * somebody else and scanned somewhere you are not.
 *
 * This proves the bytes on disk decode to the intended URL. It cannot prove a
 * phone camera can see it on a screen — that is the next section of the README.
 */
async function verify(): Promise<string | null> {
  const { prepareZXingModule, readBarcodes } = await import("zxing-wasm/reader");

  // Handed over as bytes, not located by URL: Node's fetch cannot load file://,
  // and the browser path (/zxing/…, served by Next) does not exist here.
  const wasm = readFileSync(
    join(import.meta.dirname, "..", "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm"),
  );
  prepareZXingModule({
    overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) },
  });

  const png = readFileSync(outFile);
  const results = await readBarcodes(new Blob([png], { type: "image/png" }), {
    formats: ["QRCode"],
    tryHarder: true,
  });

  return results.find((r) => r.isValid)?.text ?? null;
}

async function main() {
  await QRCode.toFile(outFile, url.toString(), {
    errorCorrectionLevel: "Q",
    // 4 modules is the quiet zone the spec requires. Scanners are forgiving of
    // more and unreliable with less, and a code pasted into a dark-mode chat
    // client has no white around it but this.
    margin: 4,
    width: 900,
    color: { dark: INK, light: PAPER },
  });

  // A code that does not read back is worse than no code: you would send it,
  // and find out from the person who could not open it. Delete it rather than
  // leave a broken file sitting there looking finished.
  const decoded = await verify();
  if (decoded === null) {
    rmSync(outFile, { force: true });
    fail("The generated image did not decode as a QR code at all. Nothing written.");
  }
  if (decoded !== url.toString()) {
    rmSync(outFile, { force: true });
    fail(`The image decoded to a different URL.\n    wrote:   ${url.toString()}\n    decoded: ${decoded}`);
  }

  console.log(`
  ✓ ${outFile}

    Encodes:  ${url.toString()}
    Verified: read back with zxing-wasm — the same decoder the app scans with

    Send the recipient all three of:
      • this image          (to scan from a laptop screen)
      • the URL as text     (in case they open your message on the phone itself)
      • the sign-in details (never put them in the URL — a QR is not a secret)
`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
