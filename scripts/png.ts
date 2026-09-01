/**
 * A dependency-free PNG encoder, shared by the icon and label generators.
 *
 * Extracted from `generate-icons.ts` when the demo labels needed the same
 * encoder at a non-square aspect ratio. Two copies of a CRC table and a
 * scanline packer is exactly the kind of duplication that drifts silently, so
 * there is one.
 *
 * Still no `sharp`/`canvas`: flat-colour rectangles do not justify a native
 * module in the install, and this file is about eighty lines.
 */

import { deflateSync } from "node:zlib";

export type RGB = [number, number, number];

export function rgb(hex: string): RGB {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** A rectangular RGB canvas. */
export class Canvas {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;

  // Fields are assigned rather than declared as constructor parameter
  // properties, which Node's type-stripping loader cannot compile.
  constructor(width: number, height: number, fill: RGB) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      this.pixels[i * 3] = fill[0];
      this.pixels[i * 3 + 1] = fill[1];
      this.pixels[i * 3 + 2] = fill[2];
    }
  }

  fillRect(x: number, y: number, w: number, h: number, color: RGB) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * this.width + px) * 3;
        this.pixels[i] = color[0];
        this.pixels[i + 1] = color[1];
        this.pixels[i + 2] = color[2];
      }
    }
  }

  /**
   * A rounded rectangle, optionally filled with a horizontal gradient.
   *
   * Antialiased by coverage: each pixel's distance from the corner arc gives a
   * 0–1 alpha that is blended against what is already there. Without this the
   * corners stair-step badly at 192px, which is precisely the size the icon is
   * most often seen at.
   */
  fillRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    from: RGB,
    to: RGB = from,
  ) {
    const r = Math.min(radius, w / 2, h / 2);
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;

        // Distance outside the rounded shape, measured from the nearest corner
        // centre when the pixel sits in a corner quadrant.
        const dx = Math.max(x + r - cx, 0, cx - (x + w - r));
        const dy = Math.max(y + r - cy, 0, cy - (y + h - r));
        const dist = Math.hypot(dx, dy);
        const alpha = Math.min(1, Math.max(0, r + 0.5 - dist));
        if (alpha <= 0) continue;

        const t = w > 0 ? (cx - x) / w : 0;
        const color: RGB = [
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * t,
          from[2] + (to[2] - from[2]) * t,
        ];

        const i = (py * this.width + px) * 3;
        for (let c = 0; c < 3; c++) {
          this.pixels[i + c] = Math.round(this.pixels[i + c] * (1 - alpha) + color[c] * alpha);
        }
      }
    }
  }
}

/* ── PNG encoding ──────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

export function encodePng(canvas: Canvas): Buffer {
  const { width, height, pixels } = canvas;

  // Each scanline is prefixed with its filter type. 0 (None) throughout: these
  // images are flat colour, so deflate already collapses them to nothing.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
