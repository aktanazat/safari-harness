import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { crc32, inflateSync } from "node:zlib";
import { redacted, redactUrl } from "./redact.ts";

export type Region = { x: number; y: number; width: number; height: number };
export type CaptureSource = {
  url: string;
  title: string;
  capturedAt: string;
  width: number;
  height: number;
  viewport: { width: number; height: number; devicePixelRatio: number };
  crop?: Region;
  privacy: { masked: number };
};
export type Capture = {
  data: string;
  screens?: number;
  cut?: boolean;
  source: CaptureSource;
  tiles?: { data: string; region: Region }[];
};
type TileReceipt = { path: string; sha256: string; region: Region };
export type Evidence = CaptureSource & { path: string; sha256: string; tiles?: TileReceipt[] };
export type CaptureResult = { path: string; screens?: number; cut?: string; evidence: Evidence };
type Manifest = {
  version: 1;
  output: string;
  image: { path: string; sha256: string };
  source: CaptureSource;
  screens?: number;
  cut?: boolean;
  tiles?: TileReceipt[];
};
export type VerifiedEvidence = {
  output: string;
  path: string;
  image: Buffer;
  receipt: string;
  evidence: Evidence;
  screens?: number;
  cut?: boolean;
};
type Png = { width: number; height: number; depth: number; color: number; channels: number; stride: number; rows: Buffer; palette?: Buffer; transparency?: Buffer };

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CUT = "page longer than 12 screens; the rest is not in the image";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${name} must be text without null bytes`);
  return value;
}
function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite positive number`);
  return value;
}
function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
  return value;
}
function absolute(value: unknown, name: string): string {
  const path = text(value, name);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("evidence SHA256 is invalid");
  return value;
}
function rectangle(value: unknown, name: string, pixels: boolean): Region {
  const rect = object(value, name);
  const x = pixels ? integer(rect.x, `${name}.x`) : positiveOrZero(rect.x, `${name}.x`);
  const y = pixels ? integer(rect.y, `${name}.y`) : positiveOrZero(rect.y, `${name}.y`);
  const width = pixels ? integer(rect.width, `${name}.width`, 1) : positive(rect.width, `${name}.width`);
  const height = pixels ? integer(rect.height, `${name}.height`, 1) : positive(rect.height, `${name}.height`);
  if (!Number.isFinite(x + width) || !Number.isFinite(y + height)) throw new Error(`${name} exceeds finite coordinates`);
  return { x, y, width, height };
}
function positiveOrZero(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite nonnegative number`);
  return value;
}
export function evidenceRegion(value: unknown, width: number, height: number): Region {
  const region = rectangle(value, "region", true);
  if (region.x + region.width > width || region.y + region.height > height) throw new Error("region is outside the original raster image");
  return region;
}
function sourceOf(value: unknown): CaptureSource {
  const source = object(value, "capture source");
  const url = text(source.url, "source.url");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("source.url must be a valid absolute URL"); }
  parsed.username = "";
  parsed.password = "";
  const title = text(source.title, "source.title");
  const safe = object(redacted({ url: redactUrl(parsed.href), title }), "redacted source");
  const capturedAt = text(source.capturedAt, "source.capturedAt");
  if (!Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) throw new Error("source.capturedAt must be an ISO timestamp");
  const width = integer(source.width, "source.width", 1);
  const height = integer(source.height, "source.height", 1);
  if (width * height > MAX_PIXELS) throw new Error("capture exceeds the image pixel limit");
  const rawViewport = object(source.viewport, "source.viewport");
  const viewport = {
    width: positive(rawViewport.width, "viewport.width"),
    height: positive(rawViewport.height, "viewport.height"),
    devicePixelRatio: positive(rawViewport.devicePixelRatio, "viewport.devicePixelRatio"),
  };
  const crop = source.crop === undefined ? undefined : rectangle(source.crop, "source.crop", false);
  if (crop && (crop.x + crop.width > viewport.width + Number.EPSILON * viewport.width * 4 || crop.y + crop.height > viewport.height + Number.EPSILON * viewport.height * 4)) throw new Error("source.crop is outside the captured CSS viewport");
  const privacy = object(source.privacy, "source.privacy");
  return {
    url: text(safe.url, "redacted URL"), title: text(safe.title, "redacted title"), capturedAt, width, height,
    viewport,
    ...(crop === undefined ? {} : { crop }),
    privacy: { masked: integer(privacy.masked, "privacy.masked") },
  };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
function png(bytes: Buffer): Png {
  if (bytes.length > MAX_BYTES || bytes.length < 45 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error("capture is not a valid PNG");
  let width = 0, height = 0, depth = 0, color = -1, channels = 0;
  let palette: Buffer | undefined, transparency: Buffer | undefined;
  let ended = false, dataEnded = false;
  const parts: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error("PNG chunk is truncated");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("PNG chunk is truncated");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error("PNG chunk checksum is invalid");
    const body = bytes.subarray(offset + 8, end - 4);
    if (offset === 8 && type !== "IHDR") throw new Error("PNG must start with IHDR");
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw new Error("PNG header is invalid");
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; color = body[9];
      channels = CHANNELS[color] ?? 0;
      const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
      if (!width || !height || width * height > MAX_PIXELS || !channels || !depths.includes(depth) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) throw new Error("PNG header is invalid or is not a non-interlaced browser capture");
    } else if (type === "PLTE") {
      if (palette || parts.length || !length || length % 3 || length > 768 || color === 0 || color === 4) throw new Error("PNG palette is invalid");
      palette = body;
    } else if (type === "tRNS") {
      if (transparency || parts.length || color === 4 || color === 6 || (color === 0 && length !== 2) || (color === 2 && length !== 6) || (color === 3 && (!palette || !length || length > palette.length / 3))) throw new Error("PNG transparency is invalid");
      transparency = body;
    } else if (type === "IDAT") {
      if (dataEnded || (color === 3 && !palette)) throw new Error("PNG image data is invalid");
      parts.push(body);
    } else if (type === "IEND") {
      if (length || !parts.length || end !== bytes.length) throw new Error("PNG end is invalid");
      ended = true;
    } else if (type[0] === type[0].toUpperCase()) {
      throw new Error("PNG contains an unsupported critical chunk");
    }
    if (parts.length && type !== "IDAT") dataEnded = true;
    offset = end;
  }
  if (!ended) throw new Error("PNG end is missing");
  if (color === 3 && palette && palette.length / 3 > 2 ** depth) throw new Error("PNG palette exceeds its bit depth");
  const stride = Math.ceil(width * channels * depth / 8) + 1;
  const expected = stride * height;
  if (expected > MAX_BYTES) throw new Error("PNG decoded data exceeds the byte limit");
  let rows: Buffer;
  try { rows = inflateSync(Buffer.concat(parts), { maxOutputLength: expected }); }
  catch { throw new Error("PNG image data cannot be decoded"); }
  if (rows.length !== expected) throw new Error("PNG decoded dimensions do not match its header");
  const bpp = Math.max(1, channels * depth / 8);
  for (let y = 0; y < height; y++) {
    const start = y * stride, filter = rows[start];
    if (filter > 4) throw new Error("PNG scanline filter is invalid");
    if (filter === 0) continue;
    for (let x = 1; x < stride; x++) {
      const left = x > bpp ? rows[start + x - bpp] : 0;
      const up = y > 0 ? rows[start + x - stride] : 0;
      const corner = y > 0 && x > bpp ? rows[start + x - stride - bpp] : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, corner);
      rows[start + x] = (rows[start + x] + predictor) & 255;
    }
  }
  const image: Png = { width, height, depth, color, channels, stride, rows, palette, transparency };
  if (color === 3 && palette) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (sample(image, x, y, 0) >= palette.length / 3) throw new Error("PNG palette index is invalid");
    }
  }
  return image;
}
function sample(image: Png, x: number, y: number, channel: number): number {
  const n = x * image.channels + channel;
  const offset = y * image.stride + 1;
  if (image.depth === 16) return image.rows.readUInt16BE(offset + n * 2);
  if (image.depth === 8) return image.rows[offset + n];
  return (image.rows[offset + Math.floor(n * image.depth / 8)] >>> (8 - image.depth - (n * image.depth % 8))) & ((1 << image.depth) - 1);
}
function rgba(image: Png, x: number, y: number, out: Uint16Array): void {
  const scale = 65535 / (2 ** image.depth - 1);
  const first = sample(image, x, y, 0), trns = image.transparency;
  if (image.color === 3) {
    const palette = image.palette;
    if (!palette) throw new Error("PNG palette is missing");
    out[0] = palette[first * 3] * 257; out[1] = palette[first * 3 + 1] * 257; out[2] = palette[first * 3 + 2] * 257;
    out[3] = (trns?.[first] ?? 255) * 257;
  } else if (image.color === 0 || image.color === 4) {
    out[0] = out[1] = out[2] = first * scale;
    out[3] = image.color === 4 ? sample(image, x, y, 1) * scale : trns && first === trns.readUInt16BE(0) ? 0 : 65535;
  } else {
    const green = sample(image, x, y, 1), blue = sample(image, x, y, 2);
    out[0] = first * scale; out[1] = green * scale; out[2] = blue * scale;
    out[3] = image.color === 6 ? sample(image, x, y, 3) * scale : trns && first === trns.readUInt16BE(0) && green === trns.readUInt16BE(2) && blue === trns.readUInt16BE(4) ? 0 : 65535;
  }
}
function tileMatches(image: Png, tile: Png, region: Region): void {
  if (tile.width !== region.width || tile.height !== region.height) throw new Error("tile PNG dimensions do not match its region");
  const samePalette = image.palette === undefined ? tile.palette === undefined : tile.palette !== undefined && image.palette.equals(tile.palette);
  const sameTransparency = image.transparency === undefined ? tile.transparency === undefined : tile.transparency !== undefined && image.transparency.equals(tile.transparency);
  const sameFormat = image.color === tile.color && image.depth === tile.depth && image.depth >= 8 && samePalette && sameTransparency;
  if (sameFormat) {
    const bpp = image.channels * image.depth / 8;
    for (let y = 0; y < tile.height; y++) {
      const start = (region.y + y) * image.stride + 1 + region.x * bpp;
      const row = y * tile.stride + 1;
      if (!image.rows.subarray(start, start + tile.width * bpp).equals(tile.rows.subarray(row, row + tile.width * bpp))) throw new Error("tile pixels do not match the original raster coordinates");
    }
    return;
  }
  const original = new Uint16Array(4), piece = new Uint16Array(4);
  for (let y = 0; y < tile.height; y++) for (let x = 0; x < tile.width; x++) {
    rgba(image, region.x + x, region.y + y, original); rgba(tile, x, y, piece);
    if (original[0] !== piece[0] || original[1] !== piece[1] || original[2] !== piece[2] || original[3] !== piece[3]) throw new Error("tile pixels do not match the original raster coordinates");
  }
}
function tileCoverage(regions: Region[], width: number, height: number): void {
  if (!regions.length || regions.length > 256) throw new Error("tiles must contain between 1 and 256 image pieces");
  const edges = [...new Set([0, width, ...regions.flatMap((r) => [r.x, r.x + r.width])])].sort((a, b) => a - b);
  for (let i = 0; i < edges.length - 1; i++) {
    const intervals = regions.filter((r) => r.x <= edges[i] && r.x + r.width >= edges[i + 1]).sort((a, b) => a.y - b.y);
    let covered = 0;
    for (const r of intervals) {
      if (r.y > covered) throw new Error("tiles do not cover the original raster image");
      covered = Math.max(covered, r.y + r.height);
    }
    if (covered !== height) throw new Error("tiles do not cover the original raster image");
  }
  const reached = new Set([0]);
  const pending = [0];
  for (let i = 0; i < pending.length; i++) {
    const a = regions[pending[i]];
    for (let j = 0; j < regions.length; j++) {
      if (reached.has(j)) continue;
      const b = regions[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if ((a.x !== b.x && overlapX >= 64 && overlapY > 0) || (a.y !== b.y && overlapY >= 64 && overlapX > 0) || (a.x === b.x && a.y === b.y && overlapX > 0 && overlapY > 0)) { reached.add(j); pending.push(j); }
    }
  }
  if (reached.size !== regions.length) throw new Error("tiles need at least 64 original raster pixels of overlap");
}
function decode(value: unknown): Buffer {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(MAX_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("capture data must be base64 PNG bytes");
  return Buffer.from(value, "base64");
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("evidence directory must be a real directory");
  await chmod(path, 0o700);
}
async function writePrivate(path: string, bytes: Uint8Array | string, immutable = false): Promise<void> {
  if (immutable) {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(bytes); } finally { await file.close(); }
    return;
  }
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("capture output must be a regular file, not a link");
  } catch (error) { if (!missing(error)) throw error; }
  const temporary = join(dirname(path), `.capture-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; }); }
}
async function readRegular(path: string, maximum = MAX_BYTES): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("evidence must be a regular file within the byte limit");
    const bytes = await file.readFile();
    if (bytes.length !== stat.size) throw new Error("evidence changed while it was read");
    return bytes;
  } finally { await file.close(); }
}
function resultEvidence(manifest: Manifest, receipt: string): Evidence {
  return { path: receipt, sha256: manifest.image.sha256, ...manifest.source, ...(manifest.tiles === undefined ? {} : { tiles: manifest.tiles }) };
}

const pendingOutputs = new Map<string, Promise<void>>();
async function withOutput<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = pendingOutputs.get(path) ?? Promise.resolve();
  const result = previous.then(run);
  const completed = result.then(() => undefined, () => undefined);
  pendingOutputs.set(path, completed);
  try { return await result; }
  finally { if (pendingOutputs.get(path) === completed) pendingOutputs.delete(path); }
}
async function removeFile(path: string): Promise<void> {
  try { await unlink(path); } catch (error) { if (!missing(error)) throw error; }
}
async function removeEmptyDirectory(path: string): Promise<void> {
  try { await rmdir(path); }
  catch (error) {
    if (!missing(error) && !(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error;
  }
}
async function latestReceipt(output: string): Promise<string | undefined> {
  try {
    const latest = object(JSON.parse((await readRegular(join(`${output}.evidence`, "latest.json"), 16 * 1024)).toString("utf8")), "latest capture");
    return absolute(latest.receipt, "latest receipt");
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

export async function saveCapture(capture: Capture, out?: string): Promise<CaptureResult> {
  if (out !== undefined) absolute(out, "out");
  const raw = object(capture, "capture");
  if (raw.source === undefined) throw new Error("capture has no protected source metadata; reload the Safari Harness extension before taking another screenshot");
  let source: CaptureSource;
  try { source = sourceOf(raw.source); }
  catch (error) { throw new Error(`capture source metadata is invalid; reload the Safari Harness extension: ${error instanceof Error ? error.message : String(error)}`); }
  const bytes = decode(raw.data), image = png(bytes);
  if (image.width !== source.width || image.height !== source.height) throw new Error("PNG dimensions do not match the capture source");
  const screens = raw.screens === undefined ? undefined : integer(raw.screens, "screens", 1);
  if (raw.cut !== undefined && typeof raw.cut !== "boolean") throw new Error("cut must be a boolean");
  const cut = raw.cut;
  const tiles: { bytes: Buffer; sha256: string; region: Region }[] = [];
  if (raw.tiles !== undefined) {
    if (!Array.isArray(raw.tiles)) throw new Error("tiles must be a list of image pieces");
    const regions = raw.tiles.map((v) => evidenceRegion(object(v, "tile").region, image.width, image.height));
    tileCoverage(regions, image.width, image.height);
    for (let i = 0; i < raw.tiles.length; i++) {
      const tileBytes = decode(object(raw.tiles[i], "tile").data);
      tileMatches(image, png(tileBytes), regions[i]);
      tiles.push({ bytes: tileBytes, sha256: digest(tileBytes), region: regions[i] });
    }
  }
  const asked = out === undefined ? join(await mkdtemp(join(tmpdir(), "safari-shot-")), "shot.png") : absolute(out, "out");
  await mkdir(dirname(asked), { recursive: true, mode: 0o700 });
  const output = join(await realpath(dirname(asked)), basename(asked));
  return withOutput(output, async () => {
    const sidecar = `${output}.evidence`;
    await privateDirectory(sidecar);
    const bundle = join(sidecar, `capture-${randomUUID()}`);
    await mkdir(bundle, { mode: 0o700 });
    const generated: string[] = [];
    let published = false;
    const sha256 = digest(bytes), path = join(bundle, `image-${sha256}.png`);
    try {
      const receipts: TileReceipt[] = [];
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i], tilePath = join(bundle, `tile-${i + 1}-${tile.sha256}.png`);
        generated.push(tilePath);
        await writePrivate(tilePath, tile.bytes, true);
        receipts.push({ path: tilePath, sha256: tile.sha256, region: tile.region });
      }
      generated.push(path);
      await writePrivate(path, bytes, true);
      const manifest: Manifest = {
        version: 1, output, image: { path, sha256 }, source,
        ...(screens === undefined ? {} : { screens }), ...(cut === undefined ? {} : { cut }),
        ...(raw.tiles === undefined ? {} : { tiles: receipts }),
      };
      const document = `${JSON.stringify(manifest, null, 2)}\n`;
      const receipt = join(bundle, `capture-${digest(document)}.json`);
      generated.push(receipt);
      await writePrivate(receipt, document, true);
      await writePrivate(output, bytes);
      published = true;
      await writePrivate(join(sidecar, "latest.json"), `${JSON.stringify({ receipt })}\n`);
      return { path: asked, ...(screens === undefined ? {} : { screens }), ...(cut ? { cut: CUT } : {}), evidence: resultEvidence(manifest, receipt) };
    } catch (error) {
      if (published && digest(await readRegular(output)) === sha256) await removeFile(output);
      for (const file of generated) await removeFile(file);
      await removeEmptyDirectory(bundle);
      await removeEmptyDirectory(sidecar);
      throw error;
    }
  });
}

export async function verifyEvidence(receiptPath: string): Promise<VerifiedEvidence> {
  const asked = absolute(receiptPath, "evidence");
  const match = /^capture-([a-f0-9]{64})\.json$/.exec(basename(asked));
  if (!match) throw new Error("evidence must name a saved capture receipt");
  const document = await readRegular(asked, 4 * 1024 * 1024);
  if (digest(document) !== match[1]) throw new Error("evidence receipt was modified");
  const receipt = await realpath(asked), bundle = dirname(receipt);
  let raw: Record<string, unknown>;
  try { raw = object(JSON.parse(document.toString("utf8")), "evidence receipt"); }
  catch { throw new Error("evidence receipt is not valid JSON"); }
  if (raw.version !== 1) throw new Error("evidence receipt version is unsupported");
  const output = absolute(raw.output, "receipt output");
  const stored = object(raw.image, "receipt image");
  const path = absolute(stored.path, "receipt image path"), sha256 = hash(stored.sha256);
  if (!/^capture-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(basename(bundle)) || dirname(bundle) !== `${output}.evidence` || path !== join(bundle, `image-${sha256}.png`)) throw new Error("evidence receipt is outside its generated capture bundle");
  const source = sourceOf(raw.source);
  if (JSON.stringify(source) !== JSON.stringify(raw.source)) throw new Error("evidence source is invalid or contains unredacted data");
  const screens = raw.screens === undefined ? undefined : integer(raw.screens, "screens", 1);
  if (raw.cut !== undefined && typeof raw.cut !== "boolean") throw new Error("receipt cut must be a boolean");
  const cut = raw.cut;
  const imageBytes = await readRegular(path);
  if (digest(imageBytes) !== sha256) throw new Error("evidence image SHA256 does not match its receipt");
  const image = png(imageBytes);
  if (image.width !== source.width || image.height !== source.height) throw new Error("evidence PNG dimensions do not match its receipt");
  const tiles: TileReceipt[] = [];
  if (raw.tiles !== undefined) {
    if (!Array.isArray(raw.tiles)) throw new Error("receipt tiles must be a list");
    const regions = raw.tiles.map((v) => evidenceRegion(object(v, "receipt tile").region, image.width, image.height));
    tileCoverage(regions, image.width, image.height);
    for (let i = 0; i < raw.tiles.length; i++) {
      const tile = object(raw.tiles[i], "receipt tile"), tileHash = hash(tile.sha256);
      const tilePath = absolute(tile.path, "receipt tile path");
      if (tilePath !== join(bundle, `tile-${i + 1}-${tileHash}.png`)) throw new Error("evidence tile path is outside its generated capture bundle");
      const tileBytes = await readRegular(tilePath);
      if (digest(tileBytes) !== tileHash) throw new Error("evidence tile SHA256 does not match its receipt");
      tileMatches(image, png(tileBytes), regions[i]);
      tiles.push({ path: tilePath, sha256: tileHash, region: regions[i] });
    }
  }
  const manifest: Manifest = {
    version: 1, output, image: { path, sha256 }, source,
    ...(screens === undefined ? {} : { screens }), ...(cut === undefined ? {} : { cut }),
    ...(raw.tiles === undefined ? {} : { tiles }),
  };
  return { output, path, image: imageBytes, receipt: document.toString("utf8"), evidence: resultEvidence(manifest, receipt), ...(screens === undefined ? {} : { screens }), ...(cut === undefined ? {} : { cut }) };
}

async function removeVerified(capture: VerifiedEvidence): Promise<void> {
  const output = capture.output, receipt = capture.evidence.path, sidecar = `${output}.evidence`;
  if (await latestReceipt(output) === receipt) {
    try {
      if (digest(await readRegular(output)) === capture.evidence.sha256) await removeFile(output);
    } catch (error) { if (!missing(error)) throw error; }
    await removeFile(join(sidecar, "latest.json"));
  }
  for (const tile of capture.evidence.tiles ?? []) await removeFile(tile.path);
  await removeFile(capture.path);
  await removeFile(receipt);
  await removeEmptyDirectory(dirname(receipt));
  await removeEmptyDirectory(sidecar);
}

export async function removeCapture(path: string): Promise<void> {
  const asked = absolute(path, "capture");
  let reference: string;
  try { reference = join(await realpath(dirname(asked)), basename(asked)); }
  catch (error) { if (missing(error)) return; throw error; }
  const latest = await latestReceipt(reference);
  if (latest !== undefined) {
    await withOutput(reference, async () => {
      const receipt = await latestReceipt(reference);
      if (receipt === undefined) return;
      const capture = await verifyEvidence(receipt);
      if (capture.output !== reference) throw new Error("latest receipt belongs to a different capture output");
      await removeVerified(capture);
    });
    return;
  }
  if (/^capture-[a-f0-9]{64}\.json$/.test(basename(reference))) {
    try { await lstat(reference); }
    catch (error) { if (missing(error)) return; throw error; }
    const capture = await verifyEvidence(reference);
    await withOutput(capture.output, () => removeVerified(capture));
    return;
  }
  try { await lstat(reference); }
  catch (error) { if (missing(error)) return; throw error; }
  throw new Error("capture has no generated receipt; refusing to remove an unrelated file");
}
