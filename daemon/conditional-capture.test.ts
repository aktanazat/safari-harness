import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import * as evidence from "./evidence.ts";
import { removeCapture, verifyEvidence, type Capture, type CaptureResult, type CaptureScope, type ConditionalCaptureResult } from "./evidence.ts";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { screenshot } from "./tools.ts";

const ConditionalCaptures = evidence.ConditionalCaptures;

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "safari-conditional-test-")));
  directories.push(path);
  return path;
}
function chunk(type: string, body: Buffer): Buffer {
  const checked = Buffer.concat([Buffer.from(type), body]);
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(body.length); checksum.writeUInt32BE(crc32(checked));
  return Buffer.concat([size, checked, checksum]);
}
type Encoding = { level?: 0 | 9; metadata?: string; rgb?: boolean; filter?: 0 | 1 };
function png(width = 2, height = 200, originY = 0, variant = 0, encoding: Encoding = {}): Buffer {
  const header = Buffer.alloc(13), channels = encoding.rgb ? 3 : 4;
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = encoding.rgb ? 2 : 6;
  const stride = width * channels + 1, rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * channels);
    for (let x = 0; x < width; x++) {
      const at = x * channels;
      row[at] = (x + (x === width - 1 && y === height - 1 ? variant : 0)) % 256;
      row[at + 1] = (y + originY) % 256; row[at + 2] = (x + y + originY) % 256;
      if (channels === 4) row[at + 3] = 255;
    }
    rows[y * stride] = encoding.filter ?? 0;
    for (let x = 0; x < row.length; x++) rows[y * stride + 1 + x] = (row[x] - (encoding.filter === 1 && x >= channels ? row[x - channels] : 0)) & 255;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    ...(encoding.metadata === undefined ? [] : [chunk("tEXt", Buffer.from(`fixture\0${encoding.metadata}`))]),
    chunk("IDAT", deflateSync(rows, { level: encoding.level ?? 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function capture(variant = 0, encoding: Encoding = {}): Capture {
  return {
    data: png(2, 200, 0, variant, encoding).toString("base64"), document: "protected-document-one",
    source: {
      url: "https://example.test/chart", title: "Revenue", capturedAt: "2026-10-21T12:00:00.000Z", width: 2, height: 200,
      viewport: { width: 2, height: 200, devicePixelRatio: 1 }, privacy: { masked: 1 },
    },
  };
}
function tiled(): Capture {
  return { ...capture(), screens: 2, cut: false, tiles: [
    { data: png(2, 140).toString("base64"), region: { x: 0, y: 0, width: 2, height: 140 } },
    { data: png(2, 140, 60).toString("base64"), region: { x: 0, y: 60, width: 2, height: 140 } },
  ] };
}
const scope: CaptureScope = { tab: 12, caller: 77 };
function saved(result: ConditionalCaptureResult): CaptureResult {
  expect("unchanged" in result).toBe(false);
  if ("unchanged" in result) throw new Error("expected a newly saved capture");
  return result;
}

test("shot ifChanged returns one image across repeated identical protected captures", async () => {
  const out = join(temporary(), "tool-count.png"), options = { tab: 987654, out, ifChanged: true };
  connect({
    send(data: string) {
      const { id, op } = JSON.parse(data) as { id: string; op: string };
      const value = op === "shot" ? capture() : [];
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  });
  const results: ConditionalCaptureResult[] = [];
  for (let index = 0; index < 8; index++) results.push(await screenshot(options));
  expect(results.filter((result) => !("unchanged" in result))).toHaveLength(1);
  expect(readdirSync(`${out}.evidence`).filter((name) => name.startsWith("capture-"))).toHaveLength(1);
});

test("repeated identical protected captures return one image and retain exactly the first receipt", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "repeated.png");
  const results: ConditionalCaptureResult[] = [];
  for (let index = 0; index < 8; index++) {
    const input = capture();
    input.source.capturedAt = `2026-10-21T12:00:0${index}.000Z`;
    results.push(await captures.save(input, scope, out, true));
  }
  const first = saved(results[0]);
  expect(results.filter((result) => !("unchanged" in result))).toHaveLength(1);
  expect(results.slice(1)).toEqual(Array.from({ length: 7 }, () => ({ unchanged: true, previous: first })));
  expect(readdirSync(`${out}.evidence`).filter((name) => name.startsWith("capture-"))).toHaveLength(1);
  expect((await verifyEvidence(first.evidence.path)).evidence.capturedAt).toBe("2026-10-21T12:00:00.000Z");
});

test("compression metadata and scanline filters do not turn identical decoded pixels into a new image", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "encoding.png");
  const firstInput = capture(0, { level: 0, metadata: "first" }), secondInput = capture(0, { level: 9, metadata: "second", filter: 1 });
  expect(firstInput.data).not.toBe(secondInput.data);
  const first = await captures.save(firstInput, scope, out, true);
  const second = await captures.save(secondInput, scope, out, true);
  expect(second).toEqual({ unchanged: true, previous: first });
  expect(readFileSync(out)).toEqual(Buffer.from(firstInput.data, "base64"));
});

test("equivalent opaque RGB and RGBA PNGs share the previous protected receipt", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "colors.png");
  const first = await captures.save(capture(), scope, out, true);
  expect(await captures.save(capture(0, { rgb: true }), scope, out, true)).toEqual({ unchanged: true, previous: first });
});

test("one changed protected pixel returns a new independently verified receipt", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "changed.png");
  const first = saved(await captures.save(capture(), scope, out, true));
  const changed = capture();
  const image = png();
  changed.data = png(2, 200, 0, 1).toString("base64");
  const second = saved(await captures.save(changed, scope, out, true));
  expect(second.evidence.path).not.toBe(first.evidence.path);
  expect((await verifyEvidence(first.evidence.path)).image).toEqual(image);
  expect((await verifyEvidence(second.evidence.path)).image).toEqual(Buffer.from(changed.data, "base64"));
});

test("an ordinary successful save becomes the baseline rather than an earlier conditional image", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "ordinary.png");
  await captures.save(capture(), scope, out, true);
  const latest = await captures.save(capture(3), scope, out);
  expect(await captures.save(capture(3), scope, out, true)).toEqual({ unchanged: true, previous: latest });
});

test("suppressed image encodings never replace the first successfully saved receipt", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "suppressed.png");
  const first = await captures.save(capture(0, { metadata: "returned" }), scope, out, true);
  await captures.save(capture(0, { metadata: "suppressed-one", level: 0 }), scope, out, true);
  expect(await captures.save(capture(0, { metadata: "suppressed-two", filter: 1 }), scope, out, true)).toEqual({ unchanged: true, previous: first });
});

test("concurrent identical protected saves publish only one image", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "concurrent.png");
  const [first, second] = await Promise.all([captures.save(capture(), scope, out, true), captures.save(capture(), scope, out, true)]);
  expect(second).toEqual({ unchanged: true, previous: first });
  expect(readdirSync(`${out}.evidence`).filter((name) => name.startsWith("capture-"))).toHaveLength(1);
});

type ScopeChange = { name: string; change: (input: Capture, current: CaptureScope) => void };
const scopeChanges: ScopeChange[] = [
  { name: "another tab", change: (_input, current) => { current.tab++; } },
  { name: "another caller", change: (_input, current) => { current.caller = "another-agent"; } },
  { name: "a new document at the same URL", change: (input) => { input.document = "protected-document-two"; } },
  { name: "a new source URL", change: (input) => { input.source.url = "https://example.test/other"; } },
  { name: "a new source title", change: (input) => { input.source.title = "Different chart"; } },
  { name: "different viewport dimensions", change: (input) => { input.source.viewport.width = 3; } },
  { name: "a different display scale", change: (input) => { input.source.viewport.devicePixelRatio = 2; } },
  { name: "a different crop", change: (input) => { input.source.crop = { x: 0, y: 0, width: 2, height: 199 }; } },
  { name: "a different target ref", change: (_input, current) => { current.settings = { ref: "18" }; } },
  { name: "annotations", change: (_input, current) => { current.settings = { annotate: true }; } },
  { name: "full-page capture", change: (_input, current) => { current.settings = { fullPage: true }; } },
  { name: "live animations", change: (_input, current) => { current.settings = { live: true }; } },
];
test.each(scopeChanges)("identical pixels do not reuse evidence after $name", async ({ change }) => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "scope.png");
  const first = saved(await captures.save(capture(), scope, out, true));
  const next = capture(), nextScope = structuredClone(scope);
  change(next, nextScope);
  const second = saved(await captures.save(next, nextScope, out, true));
  expect(second.evidence.path).not.toBe(first.evidence.path);
});

test("changed raster dimensions never reuse an earlier receipt", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "size.png");
  const first = saved(await captures.save(capture(), scope, out, true));
  const next = capture(); next.data = png(3, 200).toString("base64"); next.source.width = 3; next.source.viewport.width = 3;
  const second = saved(await captures.save(next, scope, out, true));
  expect(second.evidence.width).toBe(3);
  expect(second.evidence.path).not.toBe(first.evidence.path);
});

test("a newly requested output path is written even when its pixels match an earlier capture", async () => {
  const captures = new ConditionalCaptures(), directory = temporary();
  await captures.save(capture(), scope, join(directory, "first.png"), true);
  const out = join(directory, "second.png"), second = saved(await captures.save(capture(), scope, out, true));
  expect(second.path).toBe(out);
  expect(readFileSync(out)).toEqual(png());
});

test("stitched tiled captures suppress unchanged pixels without writing new tile files", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "tiled.png"), tileScope = { ...scope, settings: { fullPage: true, tiles: true } };
  const first = saved(await captures.save(tiled(), tileScope, out, true));
  const before = readdirSync(dirname(first.evidence.path)).sort();
  const next = tiled();
  next.tiles![0].data = png(2, 140, 0, 0, { metadata: "alternate tile encoding", level: 0 }).toString("base64");
  expect(await captures.save(next, tileScope, out, true)).toEqual({ unchanged: true, previous: first });
  expect(readdirSync(dirname(first.evidence.path)).sort()).toEqual(before);
  expect(readdirSync(`${out}.evidence`).filter((name) => name.startsWith("capture-"))).toHaveLength(1);
});

const tileChanges: ScopeChange[] = [
  { name: "tile settings", change: (_input, current) => { current.settings = { fullPage: true, tiles: true, tileHeight: 512 }; } },
  { name: "tile layout", change: (input) => { input.tiles = [{ data: input.data, region: { x: 0, y: 0, width: 2, height: 200 } }]; } },
  { name: "stitched screen count", change: (input) => { input.screens = 3; } },
  { name: "stitched truncation", change: (input) => { input.cut = true; } },
];
test.each(tileChanges)("identical stitched pixels do not reuse evidence after changing $name", async ({ change }) => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "tile-scope.png"), tileScope: CaptureScope = { ...scope, settings: { fullPage: true, tiles: true } };
  const first = saved(await captures.save(tiled(), tileScope, out, true));
  const next = tiled(), nextScope = structuredClone(tileScope);
  change(next, nextScope);
  const second = saved(await captures.save(next, nextScope, out, true));
  expect(second.evidence.path).not.toBe(first.evidence.path);
});

test("an invalid tile cannot hide behind an unchanged full protected image", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "bad-tile.png");
  await captures.save(tiled(), scope, out, true);
  const invalid = tiled(); invalid.tiles![0].data = png(2, 140, 1).toString("base64");
  await expect(captures.save(invalid, scope, out, true)).rejects.toThrow(/tile pixels do not match/);
  expect(readdirSync(`${out}.evidence`).filter((name) => name.startsWith("capture-"))).toHaveLength(1);
});

test("an invalid protected source cannot be suppressed as unchanged", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "bad-source.png");
  await captures.save(capture(), scope, out, true);
  const invalid = capture(); invalid.source.capturedAt = "not a timestamp";
  await expect(captures.save(invalid, scope, out, true)).rejects.toThrow(/capture source metadata is invalid/);
});

test.each([undefined, "", "x".repeat(257)])("conditional capture rejects an unavailable or invalid document identity: %s", async (document) => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "no-document.png");
  await expect(captures.save({ ...capture(), document }, scope, out, true)).rejects.toThrow(/capture document identity/);
  expect(readdirSync(dirname(out))).toEqual([]);
});

test("failed image publication preserves the earlier successful baseline", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "failure.png");
  const first = saved(await captures.save(capture(), scope, out, true));
  unlinkSync(out); mkdirSync(out);
  await expect(captures.save(capture(5), scope, out, true)).rejects.toThrow(/regular file/);
  rmSync(out, { recursive: true }); writeFileSync(out, png());
  expect(await captures.save(capture(), scope, out, true)).toEqual({ unchanged: true, previous: first });
  const second = saved(await captures.save(capture(5), scope, out, true));
  expect((await verifyEvidence(second.evidence.path)).image).toEqual(png(2, 200, 0, 5));
});

test("removed prior evidence causes a fresh protected save rather than a dangling receipt", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "removed.png");
  const first = saved(await captures.save(capture(), scope, out, true));
  await removeCapture(first.evidence.path);
  const next = saved(await captures.save(capture(), scope, out, true));
  expect(next.evidence.path).not.toBe(first.evidence.path);
  expect((await verifyEvidence(next.evidence.path)).image).toEqual(png());
});

test("changed immutable evidence cannot be returned as an unchanged protected receipt", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "tampered.png");
  const first = saved(await captures.save(capture(), scope, out, true));
  writeFileSync((await verifyEvidence(first.evidence.path)).path, png(2, 200, 0, 8));
  const next = saved(await captures.save(capture(), scope, out, true));
  expect(next.evidence.path).not.toBe(first.evidence.path);
  expect((await verifyEvidence(next.evidence.path)).image).toEqual(png());
});

test("mutating a returned receipt object cannot alter the retained protected baseline", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "mutated-result.png");
  const first = saved(await captures.save(capture(), scope, out, true)), expected = structuredClone(first);
  first.evidence.path = "/not-the-receipt.json"; first.evidence.capturedAt = "2026-10-22T12:00:00.000Z";
  expect(await captures.save(capture(), scope, out, true)).toEqual({ unchanged: true, previous: expected });
});

test("the entry bound evicts older tab baselines rather than retaining every tab", async () => {
  const captures = new ConditionalCaptures({ maxEntries: 1 }), out = join(temporary(), "entry-bound.png");
  await captures.save(capture(), scope, out, true);
  await captures.save(capture(), { ...scope, tab: 13 }, out, true);
  const latest = saved(await captures.save(capture(), scope, out, true));
  expect((await verifyEvidence(latest.evidence.path)).image).toEqual(png());
  expect(readdirSync(`${out}.evidence`).filter((name) => name.startsWith("capture-"))).toHaveLength(3);
});

test("the total byte bound evicts decoded pixels even when the entry bound has room", async () => {
  const captures = new ConditionalCaptures({ maxEntries: 50, maxBytes: 8192 }), out = join(temporary(), "byte-bound.png");
  const input = capture(); input.data = png(4, 300).toString("base64"); input.source.width = 4; input.source.height = 300; input.source.viewport = { width: 4, height: 300, devicePixelRatio: 1 };
  const first = await captures.save(input, scope, out, true);
  expect(await captures.save(input, scope, out, true)).toEqual({ unchanged: true, previous: first });
  await captures.save(input, { ...scope, tab: 13 }, out, true);
  saved(await captures.save(input, scope, out, true));
  expect(readdirSync(`${out}.evidence`).filter((name) => name.startsWith("capture-"))).toHaveLength(3);
});

test("captures larger than the byte budget are returned without retaining their pixels", async () => {
  const captures = new ConditionalCaptures({ maxBytes: 1 }), out = join(temporary(), "oversized.png");
  await captures.save(capture(), scope, out, true);
  saved(await captures.save(capture(), scope, out, true));
  expect(readdirSync(`${out}.evidence`).filter((name) => name.startsWith("capture-"))).toHaveLength(2);
});

const cleanupCases: { name: string; clean: (captures: InstanceType<typeof ConditionalCaptures>) => void }[] = [
  { name: "tab closes", clean: (captures) => captures.forgetTab(scope.tab) },
  { name: "caller exits", clean: (captures) => captures.forgetCaller(scope.caller) },
  { name: "daemon cache clears", clean: (captures) => captures.clear() },
];
test.each(cleanupCases)("a fresh image is returned after $name", async ({ clean }) => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "cleanup.png");
  const first = saved(await captures.save(capture(), scope, out, true));
  clean(captures);
  const next = saved(await captures.save(capture(), scope, out, true));
  expect(next.evidence.path).not.toBe(first.evidence.path);
});

test("tab renumbering preserves the real document baseline under its new tab id", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "renumbered.png");
  const first = await captures.save(capture(), scope, out, true);
  captures.renumberTab(scope.tab, 44);
  expect(await captures.save(capture(), { ...scope, tab: 44 }, out, true)).toEqual({ unchanged: true, previous: first });
});

test("a forgotten tab cannot be repopulated by a save that was already queued", async () => {
  const captures = new ConditionalCaptures(), out = join(temporary(), "pending.png");
  const pending = captures.save(capture(), scope, out, true);
  captures.forgetTab(scope.tab);
  const first = saved(await pending), next = saved(await captures.save(capture(), scope, out, true));
  expect(next.evidence.path).not.toBe(first.evidence.path);
});
