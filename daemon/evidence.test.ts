import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { removeCapture, saveCapture, verifyEvidence, type Capture } from "./evidence.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "safari-evidence-test-")));
  directories.push(path);
  return path;
}
function chunk(type: string, body: Buffer): Buffer {
  const label = Buffer.from(type), checked = Buffer.concat([label, body]);
  let crc = 0xffffffff;
  for (const byte of checked) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(body.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, checked, checksum]);
}
function png(width = 2, height = 200, originY = 0, variant = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4 + 1, rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const start = y * stride + 1 + x * 4;
    rows[start] = (x + variant) % 256; rows[start + 1] = (y + originY) % 256;
    rows[start + 2] = (x + y + originY) % 256; rows[start + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
function capture(variant = 0): Capture {
  return {
    data: png(2, 200, 0, variant).toString("base64"),
    source: {
      url: "https://example.test/chart?order=7", title: "Revenue", capturedAt: "2026-10-21T12:00:00.000Z", width: 2, height: 200,
      viewport: { width: 2, height: 200, devicePixelRatio: 1 }, privacy: { masked: 1 },
    },
  };
}
function tiled(): Capture {
  return { ...capture(), tiles: [
    { data: png(2, 140).toString("base64"), region: { x: 0, y: 0, width: 2, height: 140 } },
    { data: png(2, 140, 60).toString("base64"), region: { x: 0, y: 60, width: 2, height: 140 } },
  ] };
}

test("a saved capture retains real PNG bytes and verifies its source, dimensions and private receipt", async () => {
  const directory = temporary(), input = capture();
  input.screens = 2; input.cut = true;
  input.source.crop = { x: 12, y: 30, width: 1, height: 100 };
  input.source.viewport = { width: 80, height: 200, devicePixelRatio: 2 };
  const result = await saveCapture(input, join(directory, "capture.without-png-suffix"));
  const verified = await verifyEvidence(result.evidence.path), bytes = Buffer.from(input.data, "base64");
  expect(readFileSync(result.path)).toEqual(bytes);
  expect(verified.image).toEqual(bytes);
  expect(verified.path).not.toBe(result.path);
  expect(verified.output).toBe(result.path);
  expect(result.evidence.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(verified.evidence).toEqual(result.evidence);
  expect(verified.evidence.crop).toEqual({ x: 12, y: 30, width: 1, height: 100 });
  expect(verified.evidence.viewport.devicePixelRatio).toBe(2);
  expect(verified.screens).toBe(2);
  expect(verified.cut).toBe(true);
  expect(result.cut).toContain("rest is not in the image");
  expect(statSync(result.path).mode & 0o777).toBe(0o600);
  expect(statSync(verified.path).mode & 0o777).toBe(0o600);
  expect(statSync(result.evidence.path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(result.evidence.path)).mode & 0o777).toBe(0o700);
  expect(statSync(`${result.path}.evidence`).mode & 0o777).toBe(0o700);
});

test("a default capture uses a private scratch directory", async () => {
  const result = await saveCapture(capture());
  directories.push(dirname(result.path));
  expect(statSync(dirname(result.path)).mode & 0o777).toBe(0o700);
  expect((await verifyEvidence(result.evidence.path)).image).toEqual(png());
});

test("source URL credentials and secret parameters and code titles never enter saved receipts", async () => {
  const input = capture();
  const url = new URL("https://example.test/chart?token=fixture-token&order=7#state=fixture-state");
  url.username = "fixture-user"; url.password = "fixture-password";
  input.source.url = url.href;
  input.source.title = "123456 verification code https://example.test/?otp=654321";
  const result = await saveCapture(input, join(temporary(), "safe.png"));
  const receipt = readFileSync(result.evidence.path, "utf8");
  expect(result.evidence.url).toBe("https://example.test/chart?token=...&order=7#state=...");
  expect(result.evidence.title).toBe("... verification code https://example.test/?otp=...");
  expect(receipt).not.toMatch(/fixture-user|fixture-password|fixture-token|fixture-state|123456|654321/);
  expect((await verifyEvidence(result.evidence.path)).evidence.url).toBe(result.evidence.url);
});

test("overlapping tiles preserve original raster coordinates and verify their actual pixels", async () => {
  const result = await saveCapture(tiled(), join(temporary(), "tiles.png"));
  const verified = await verifyEvidence(result.evidence.path);
  expect(verified.evidence.tiles?.map((tile) => tile.region)).toEqual([
    { x: 0, y: 0, width: 2, height: 140 }, { x: 0, y: 60, width: 2, height: 140 },
  ]);
  const tile = verified.evidence.tiles?.[1];
  expect(tile).toBeDefined();
  expect(readFileSync(tile!.path)).toEqual(png(2, 140, 60));
  expect(statSync(tile!.path).mode & 0o777).toBe(0o600);
});

const invalidTiles: [string, Capture, RegExp][] = [
  ["a tile outside the image", { ...capture(), tiles: [{ data: png(2, 200).toString("base64"), region: { x: 0, y: 1, width: 2, height: 200 } }] }, /outside the original raster/],
  ["uncovered image rows", { ...capture(), tiles: [{ data: png(2, 100).toString("base64"), region: { x: 0, y: 0, width: 2, height: 100 } }] }, /do not cover/],
  ["less than 64 pixels of overlap", { ...capture(), tiles: [
    { data: png(2, 120).toString("base64"), region: { x: 0, y: 0, width: 2, height: 120 } },
    { data: png(2, 100, 100).toString("base64"), region: { x: 0, y: 100, width: 2, height: 100 } },
  ] }, /64 original raster pixels/],
  ["pixels from the wrong original coordinates", { ...capture(), tiles: [
    { data: png(2, 140).toString("base64"), region: { x: 0, y: 0, width: 2, height: 140 } },
    { data: png(2, 140).toString("base64"), region: { x: 0, y: 60, width: 2, height: 140 } },
  ] }, /pixels do not match/],
  ["dimensions different from the tile region", { ...capture(), tiles: [{ data: png(2, 199).toString("base64"), region: { x: 0, y: 0, width: 2, height: 200 } }] }, /dimensions do not match/],
];
test.each(invalidTiles)("a capture rejects %s before writing evidence", async (_name, input, error) => {
  const out = join(temporary(), "invalid.png");
  await expect(saveCapture(input, out)).rejects.toThrow(error);
  expect(existsSync(out)).toBe(false);
  expect(existsSync(`${out}.evidence`)).toBe(false);
});

const invalidCaptures: [string, (input: Capture) => Capture, RegExp][] = [
  ["a non-PNG payload", (input) => ({ ...input, data: Buffer.from("not a PNG").toString("base64") }), /not a valid PNG/],
  ["a malformed base64 payload", (input) => ({ ...input, data: "!!!!" }), /base64 PNG/],
  ["source dimensions different from the PNG", (input) => ({ ...input, source: { ...input.source, width: 3 } }), /dimensions do not match/],
  ["nonfinite viewport geometry", (input) => ({ ...input, source: { ...input.source, viewport: { ...input.source.viewport, width: Infinity } } }), /finite positive/],
  ["a negative capture crop", (input) => ({ ...input, source: { ...input.source, crop: { x: -1, y: 0, width: 1, height: 1 } } }), /finite nonnegative/],
  ["a crop outside the viewport", (input) => ({ ...input, source: { ...input.source, crop: { x: 2, y: 0, width: 1, height: 1 } } }), /outside the captured CSS viewport/],
  ["an invalid capture timestamp", (input) => ({ ...input, source: { ...input.source, capturedAt: "yesterday" } }), /ISO timestamp/],
  ["a negative privacy mask count", (input) => ({ ...input, source: { ...input.source, privacy: { masked: -1 } } }), /integer of at least 0/],
];
test.each(invalidCaptures)("a capture rejects %s without creating an output", async (_name, change, error) => {
  const out = join(temporary(), "invalid.png");
  await expect(saveCapture(change(capture()), out)).rejects.toThrow(error);
  expect(existsSync(out)).toBe(false);
});

test("an older extension capture without source metadata explains that a reload is needed", async () => {
  const out = join(temporary(), "legacy.png");
  await expect(Reflect.apply(saveCapture, undefined, [{ data: capture().data }, out])).rejects.toThrow(/reload.*extension/);
  expect(existsSync(out)).toBe(false);
});

test("a PNG with intact chunk checksums but invalid compressed image data is rejected", async () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(200, 4); header[8] = 8; header[9] = 6;
  const invalid = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0)),
  ]);
  await expect(saveCapture({ ...capture(), data: invalid.toString("base64") }, join(temporary(), "invalid-image.png"))).rejects.toThrow(/cannot be decoded/);
});

test("a PNG with corrupted bytes is rejected even before it has a receipt", async () => {
  const bytes = png(); bytes[bytes.length - 5] ^= 1;
  await expect(saveCapture({ ...capture(), data: bytes.toString("base64") }, join(temporary(), "corrupt.png"))).rejects.toThrow(/checksum/);
});

test("corrupting an immutable evidence image invalidates its receipt", async () => {
  const result = await saveCapture(capture(), join(temporary(), "tamper.png"));
  const original = await verifyEvidence(result.evidence.path);
  const bytes = readFileSync(original.path); bytes[50] ^= 1; writeFileSync(original.path, bytes);
  await expect(verifyEvidence(result.evidence.path)).rejects.toThrow(/image SHA256 does not match/);
});

test("changing saved source metadata invalidates the content-addressed receipt", async () => {
  const result = await saveCapture(capture(), join(temporary(), "metadata.png"));
  const raw = JSON.parse(readFileSync(result.evidence.path, "utf8")); raw.source.title = "Different title";
  writeFileSync(result.evidence.path, JSON.stringify(raw));
  await expect(verifyEvidence(result.evidence.path)).rejects.toThrow(/receipt was modified/);
});

test("changing a tile file invalidates the capture even when the full image is unchanged", async () => {
  const result = await saveCapture(tiled(), join(temporary(), "tile-tamper.png"));
  const tile = result.evidence.tiles?.[0];
  expect(tile).toBeDefined();
  writeFileSync(tile!.path, png(2, 140, 1));
  await expect(verifyEvidence(result.evidence.path)).rejects.toThrow(/tile SHA256 does not match/);
});

test("evidence cannot be redirected to an arbitrary image path by rewriting and renaming a manifest", async () => {
  const directory = temporary(), result = await saveCapture(capture(), join(directory, "paths.png"));
  const raw = JSON.parse(readFileSync(result.evidence.path, "utf8")); raw.image.path = join(directory, "unrelated.png");
  writeFileSync(raw.image.path, png());
  const document = JSON.stringify(raw), sha = createHash("sha256").update(document).digest("hex");
  const forged = join(dirname(result.evidence.path), `capture-${sha}.json`); writeFileSync(forged, document);
  await expect(verifyEvidence(forged)).rejects.toThrow(/outside its generated capture bundle/);
});

test("a saved image cannot be replaced with a symbolic link", async () => {
  const directory = temporary(), result = await saveCapture(capture(), join(directory, "links.png"));
  const verified = await verifyEvidence(result.evidence.path), other = join(directory, "other.png");
  writeFileSync(other, verified.image); unlinkSync(verified.path); symlinkSync(other, verified.path);
  await expect(verifyEvidence(result.evidence.path)).rejects.toThrow(/ELOOP|symbolic|link/i);
});

test("reusing an output path replaces its public image without changing earlier saved evidence", async () => {
  const out = join(temporary(), "reused.png");
  const first = await saveCapture(capture(), out), secondInput = capture(20);
  secondInput.source.capturedAt = "2026-10-21T12:01:00.000Z";
  const second = await saveCapture(secondInput, out);
  expect(readFileSync(out)).toEqual(png(2, 200, 0, 20));
  expect((await verifyEvidence(first.evidence.path)).image).toEqual(png());
  expect((await verifyEvidence(second.evidence.path)).image).toEqual(png(2, 200, 0, 20));
  writeFileSync(out, "user changed only the output alias");
  expect((await verifyEvidence(first.evidence.path)).image).toEqual(png());
  expect((await verifyEvidence(second.evidence.path)).image).toEqual(png(2, 200, 0, 20));
});

test("cleaning an output removes only its newest generated bundle and preserves earlier citations and unrelated files", async () => {
  const out = join(temporary(), "cleanup.png"), first = await saveCapture(capture(), out);
  const second = await saveCapture(tiled(), out), preserved = join(dirname(second.evidence.path), "owner-notes.txt");
  writeFileSync(preserved, "keep this");
  await removeCapture(out);
  expect(existsSync(out)).toBe(false);
  expect(existsSync(second.evidence.path)).toBe(false);
  expect(existsSync(second.evidence.tiles![0].path)).toBe(false);
  expect(readFileSync(preserved, "utf8")).toBe("keep this");
  expect((await verifyEvidence(first.evidence.path)).image).toEqual(png());
  await removeCapture(second.evidence.path);
  expect(readFileSync(preserved, "utf8")).toBe("keep this");
});

test("cleaning an older receipt preserves the latest screenshot and its receipt", async () => {
  const out = join(temporary(), "older-cleanup.png"), first = await saveCapture(capture(), out);
  const second = await saveCapture(capture(20), out);
  await removeCapture(first.evidence.path);
  expect(existsSync(first.evidence.path)).toBe(false);
  expect(readFileSync(out)).toEqual(png(2, 200, 0, 20));
  expect((await verifyEvidence(second.evidence.path)).image).toEqual(png(2, 200, 0, 20));
});

test("cleanup preserves a user-edited alias while removing only the generated evidence bundle", async () => {
  const out = join(temporary(), "edited.png"), saved = await saveCapture(capture(), out);
  writeFileSync(out, "owner's image replacement");
  await removeCapture(saved.evidence.path);
  expect(readFileSync(out, "utf8")).toBe("owner's image replacement");
  expect(existsSync(saved.evidence.path)).toBe(false);
});

test("cleanup refuses an unrelated file with no generated receipt", async () => {
  const out = join(temporary(), "unrelated.png"); writeFileSync(out, png());
  await expect(removeCapture(out)).rejects.toThrow(/refusing to remove an unrelated file/);
  expect(readFileSync(out)).toEqual(png());
});

test("identical image bytes can retain distinct source and time receipts", async () => {
  const out = join(temporary(), "same-image.png"), first = await saveCapture(capture(), out);
  const later = capture();
  later.source.capturedAt = "2026-10-21T13:00:00.000Z";
  later.source.title = "Revenue, later visit";
  const second = await saveCapture(later, out);
  expect(second.evidence.sha256).toBe(first.evidence.sha256);
  expect(second.evidence.path).not.toBe(first.evidence.path);
  expect((await verifyEvidence(first.evidence.path)).evidence.capturedAt).toBe("2026-10-21T12:00:00.000Z");
  expect((await verifyEvidence(second.evidence.path)).evidence.capturedAt).toBe("2026-10-21T13:00:00.000Z");
});

test("failed output publication cleans its partial bundle and preserves an unrelated link target", async () => {
  const directory = temporary(), target = join(directory, "owner-file"), out = join(directory, "capture.png");
  writeFileSync(target, "owner's original content"); symlinkSync(target, out);
  await expect(saveCapture(capture(), out)).rejects.toThrow(/regular file, not a link/);
  expect(readFileSync(target, "utf8")).toBe("owner's original content");
  expect(readFileSync(out, "utf8")).toBe("owner's original content");
  expect(existsSync(`${out}.evidence`)).toBe(false);
});

test("cleanup refuses corrupt evidence without deleting its output or manifest", async () => {
  const result = await saveCapture(capture(), join(temporary(), "corrupt-cleanup.png"));
  const verified = await verifyEvidence(result.evidence.path);
  writeFileSync(verified.path, "changed image");
  await expect(removeCapture(result.evidence.path)).rejects.toThrow(/SHA256 does not match/);
  expect(existsSync(result.path)).toBe(true);
  expect(existsSync(result.evidence.path)).toBe(true);
});

test("a capture output must be absolute", async () => {
  await expect(saveCapture(capture(), "relative.png")).rejects.toThrow(/absolute path/);
});
