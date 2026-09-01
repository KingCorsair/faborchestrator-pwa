/**
 * Barcode and QR decoding, with the platform first and wasm as the fallback.
 *
 * Two backends behind one `Scanner`:
 *
 * 1. **`BarcodeDetector`** — the browser's own decoder, hardware-accelerated,
 *    zero bytes to download. Present on Android Chrome and ChromeOS, which is
 *    what a shop-floor handheld actually runs.
 * 2. **`zxing-wasm`** — a 1 MB WebAssembly decoder, loaded only when the first
 *    is absent. That includes Chrome on Windows and every Firefox, so this is
 *    not a rare edge: it is the path the demo takes on the laptop it is
 *    demonstrated from. A feature that only works on the device nobody has in
 *    the room is not a feature.
 *
 * The wasm is fetched from `/zxing/zxing_reader.wasm`, served by this app —
 * never from the CDN zxing-wasm defaults to. See `scripts/copy-zxing-wasm.mjs`.
 *
 * ── Formats ─────────────────────────────────────────────────────────────────
 * Code 128 and Code 39 are what production order travellers are printed with;
 * Data Matrix is what gets laser-etched onto a part when there is no room for a
 * barcode; QR is what somebody sticks on a machine. Narrowing the set is not
 * cosmetic — every extra format is another decode attempt per frame.
 */

const FORMATS = ["qr_code", "code_128", "code_39", "data_matrix"] as const;

/** zxing spells its formats differently to the browser API. Same four. */
const ZXING_FORMATS = ["QRCode", "Code128", "Code39", "DataMatrix"] as const;

export type ScannerKind = "native" | "wasm";

export interface Scanner {
  kind: ScannerKind;
  /** Decoded text from one frame. Empty when the frame holds no barcode — the common case. */
  detect(video: HTMLVideoElement): Promise<string[]>;
  /** Release anything the backend holds. Safe to call twice. */
  dispose(): void;
}

/* ── The browser API, which TypeScript does not ship types for ─────────────── */

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

function nativeDetector(): BarcodeDetectorConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

/** Whether this browser can scan at all, without loading anything to find out. */
export function scanningIsSupported(): boolean {
  if (typeof window === "undefined") return false;
  // Both backends need a camera. Without `getUserMedia` there is nothing to
  // decode, and on an insecure origin the property is absent entirely.
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Pick a backend. Native if the browser has one **and** it supports the formats
 * we need — Safari ships `BarcodeDetector` with QR only, and silently missing
 * Code 128 would mean a scanner that ignores every real order label.
 */
export async function createScanner(): Promise<Scanner> {
  const Native = nativeDetector();
  if (Native) {
    try {
      const supported = (await Native.getSupportedFormats?.()) ?? [];
      const usable = FORMATS.filter((format) => supported.includes(format));
      if (usable.includes("code_128")) {
        const detector = new Native({ formats: usable });
        return {
          kind: "native",
          detect: async (video) => (await detector.detect(video)).map((b) => b.rawValue),
          dispose: () => {},
        };
      }
    } catch {
      // A present-but-broken implementation is a wasm case. Fall through.
    }
  }
  return createWasmScanner();
}

async function createWasmScanner(): Promise<Scanner> {
  // Imported here, not at module scope: this pulls a 1 MB binary, and a browser
  // that has `BarcodeDetector` must never pay for it.
  const { prepareZXingModule, readBarcodes } = await import("zxing-wasm/reader");

  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith(".wasm") ? "/zxing/zxing_reader.wasm" : prefix + path,
    },
  });

  // One canvas, reused. Allocating a canvas per frame at 4 fps is how a scanner
  // becomes the reason a handheld's battery dies before the shift ends.
  let canvas: HTMLCanvasElement | null = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  return {
    kind: "wasm",
    detect: async (video) => {
      if (!canvas || !context || !video.videoWidth) return [];
      // Decoded at half resolution: a 1280×720 frame is 3.7 MB of pixels to
      // copy and scan, and a Code 128 barcode filling a third of the viewfinder
      // survives the halving easily.
      const width = Math.max(1, Math.round(video.videoWidth / 2));
      const height = Math.max(1, Math.round(video.videoHeight / 2));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(video, 0, 0, width, height);
      const results = await readBarcodes(context.getImageData(0, 0, width, height), {
        formats: [...ZXING_FORMATS],
        tryHarder: true,
      });
      return results.filter((r) => r.isValid).map((r) => r.text);
    },
    dispose: () => {
      canvas = null;
    },
  };
}

/* ── What a scanned string means ──────────────────────────────────────────── */

/**
 * Pull a production order number out of whatever the label encodes.
 *
 * Real travellers do not encode a bare `PO-10382`. They encode
 * `https://mes.example/orders/PO-10382`, or `^PO-10382|OP30|ASM-04`, or the
 * number with a check digit appended by the label printer. Matching the pattern
 * anywhere in the payload is the difference between a scanner that works on the
 * demo's own QR codes and one that works on a customer's labels.
 *
 * Returns null rather than guessing. A scan that decoded cleanly but holds no
 * order number is a real answer — the operator scanned the wrong label — and
 * the sheet says so instead of searching for nothing.
 */
export function extractOrderNumber(scanned: string): string | null {
  const match = /PO[-_ ]?(\d{1,10})/i.exec(scanned);
  return match ? `PO-${match[1]}` : null;
}
