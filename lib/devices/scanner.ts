/**
 * QR decoding for the in-app enrollment scanner (`/device-blocked`), adapted from the
 * scanner this app had until 1 September 2026 (`lib/scan/barcode.ts`, removed
 * in c7b9b04): the browser's `BarcodeDetector` when it can read QR codes, and
 * `zxing-wasm` otherwise. QR only.
 *
 * The wasm is served by this app at `/device-blocked/zxing_reader.wasm`,
 * never from a CDN. Decoding wasm needs `'wasm-unsafe-eval'` in the page's
 * content security policy (`next.config.ts`).
 */

export interface Scanner {
  kind: "native" | "wasm";
  detect(video: HTMLVideoElement): Promise<string[]>;
  dispose(): void;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

export function cameraAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

export async function createScanner(): Promise<Scanner> {
  const Native = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (Native) {
    try {
      const supported = (await Native.getSupportedFormats?.()) ?? [];
      if (supported.includes("qr_code")) {
        const detector = new Native({ formats: ["qr_code"] });
        return {
          kind: "native",
          detect: async (video) => (await detector.detect(video)).map((b) => b.rawValue),
          dispose: () => {},
        };
      }
    } catch {
      /* fall through to wasm */
    }
  }

  const { prepareZXingModule, readBarcodes } = await import("zxing-wasm/reader");
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith(".wasm") ? "/device-blocked/zxing_reader.wasm" : prefix + path,
    },
  });
  let canvas: HTMLCanvasElement | null = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return {
    kind: "wasm",
    detect: async (video) => {
      if (!canvas || !context || !video.videoWidth) return [];
      const width = Math.max(1, Math.round(video.videoWidth / 2));
      const height = Math.max(1, Math.round(video.videoHeight / 2));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(video, 0, 0, width, height);
      const results = await readBarcodes(context.getImageData(0, 0, width, height), {
        formats: ["QRCode"],
        tryHarder: true,
      });
      return results.filter((r) => r.isValid).map((r) => r.text);
    },
    dispose: () => {
      canvas = null;
    },
  };
}

/**
 * The one-time code in a scanned enrollment QR, or null for anything else.
 * Enrollment QRs encode `<this origin>/device-enroll/<43-character code>`;
 * a QR for another origin is never followed.
 */
export function enrollmentCodeFrom(text: string, origin: string): string | null {
  try {
    const url = new URL(text.trim(), origin);
    if (url.origin !== origin) return null;
    const match = /^\/device-enroll\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}
