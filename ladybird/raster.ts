// The image calls background.js makes for a screenshot, which a Safari
// background page has and Bun does not: createImageBitmap of a PNG,
// OffscreenCanvas with unscaled drawImage and a solid fillRect (the
// privacy masks), convertToBlob to PNG, and FileReader.readAsDataURL.
// Ladybird's captures are 8-bit RGBA PNGs; RGB ones decode too.

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(png: Uint8Array): { width: number; height: number; data: Uint8ClampedArray } {
  if (!SIGNATURE.every((b, i) => png[i] === b)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0, colorType = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = body[8], interlace = body[12];
      colorType = body[9];
      if (depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported PNG (depth ${depth}, color ${colorType}, interlace ${interlace})`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: new Uint8ClampedArray(rows.buffer) };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, q = 0; p < rows.length; p += 3, q += 4) {
    data[q] = rows[p];
    data[q + 1] = rows[p + 1];
    data[q + 2] = rows[p + 2];
    data[q + 3] = 255;
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function encodePng(width: number, height: number, data: Uint8ClampedArray): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

export class ImageBitmap implements Pixels {
  constructor(readonly width: number, readonly height: number, readonly data: Uint8ClampedArray) {}
  close() {}
}

export async function createImageBitmap(blob: Blob): Promise<ImageBitmap> {
  const { width, height, data } = decodePng(new Uint8Array(await blob.arrayBuffer()));
  return new ImageBitmap(width, height, data);
}

class Context2D {
  fillStyle = "#000";
  constructor(private readonly canvas: OffscreenCanvas) {}

  // drawImage(src, dx, dy) or drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)
  // with dw = sw and dh = sh: background.js never scales.
  drawImage(src: Pixels, ...n: number[]) {
    const [sx, sy, sw, sh, dx, dy, dw, dh] = n.length === 2 ? [0, 0, src.width, src.height, n[0], n[1], src.width, src.height] : n;
    if (n.length !== 2 && n.length !== 8) throw new Error(`drawImage with ${n.length} numbers is not supported`);
    if (dw !== sw || dh !== sh) throw new Error("scaled drawImage is not supported");
    const dst = this.canvas;
    const x0 = Math.max(0, dx, dx - sx), y0 = Math.max(0, dy, dy - sy);
    const x1 = Math.min(dst.width, dx + sw, dx + src.width - sx), y1 = Math.min(dst.height, dy + sh, dy + src.height - sy);
    if (x1 <= x0) return;
    for (let y = y0; y < y1; y++) {
      const from = ((y - dy + sy) * src.width + (x0 - dx + sx)) * 4;
      dst.data.set(src.data.subarray(from, from + (x1 - x0) * 4), (y * dst.width + x0) * 4);
    }
  }

  fillRect(x: number, y: number, w: number, h: number) {
    const hex = this.fillStyle.replace(/^#/, "");
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`fillStyle ${this.fillStyle} is not supported`);
    const rgba = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).concat(255);
    const dst = this.canvas;
    for (let row = Math.max(0, y); row < Math.min(dst.height, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(dst.width, x + w); col++) dst.data.set(rgba, (row * dst.width + col) * 4);
    }
  }
}

export class OffscreenCanvas implements Pixels {
  readonly data: Uint8ClampedArray;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  getContext(kind: string): Context2D {
    if (kind !== "2d") throw new Error(`${kind} context is not supported`);
    return new Context2D(this);
  }
  async convertToBlob(opts: { type?: string } = {}): Promise<Blob> {
    if (opts.type && opts.type !== "image/png") throw new Error(`${opts.type} is not supported`);
    return new Blob([encodePng(this.width, this.height, this.data)], { type: "image/png" });
  }
}

export class FileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`;
      this.onload?.();
    }, (e) => {
      this.error = e;
      this.onerror?.();
    });
  }
}
