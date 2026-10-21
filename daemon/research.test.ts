import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { saveCapture, verifyEvidence } from "./evidence.ts";
import { createResearchReport } from "./research.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "safari-research-test-")));
  directories.push(path);
  return path;
}
function chunk(type: string, body: Buffer): Buffer {
  const checked = Buffer.concat([Buffer.from(type), body]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(body.length); checksum.writeUInt32BE(crc32(checked));
  return Buffer.concat([size, checked, checksum]);
}
function png(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 20, 40, 60, 255]))), chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function saved(directory: string, title = "Revenue") {
  return saveCapture({
    data: png().toString("base64"),
    source: {
      url: "https://example.test/revenue?token=fixture-token&year=2026", title,
      capturedAt: "2026-10-21T12:00:00.000Z", width: 1, height: 1,
      viewport: { width: 100, height: 100, devicePixelRatio: 2 },
      crop: { x: 4, y: 6, width: 0.5, height: 0.5 }, privacy: { masked: 1 },
    },
  }, join(directory, "capture.png"));
}

test("a report leads with its answer and calculates mismatches from supplied numbers rather than supplied labels", async () => {
  const directory = temporary(), capture = await saved(directory);
  const result = await createResearchReport({
    out: join(directory, "report"), title: "Revenue check", answer: "The chart and data disagree in two comparisons.",
    findings: [
      { claim: "The first pair differs", evidence: capture.evidence.path, region: { x: 0, y: 0, width: 1, height: 1 }, comparison: { visual: 12, data: 10, unit: "USD", tolerance: 1, mismatch: false } },
      { claim: "The second pair is within tolerance", evidence: capture.evidence.path, comparison: { visual: 11, data: 10, unit: "USD", tolerance: 1, mismatch: true } },
      { claim: "Negative values differ", evidence: capture.evidence.path, comparison: { visual: -2, data: -5, unit: "USD" } },
    ],
    unchecked: [
      { url: "https://example.test/archive?token=fixture-unchecked", reason: "Login required" },
      { url: "https://other.test/source", reason: "The page did not finish loading" },
    ],
  });
  expect(result).toMatchObject({ findings: 3, unchecked: 2, mismatches: 2 });
  const markdown = readFileSync(result.path, "utf8"), html = readFileSync(result.html, "utf8");
  expect(markdown.indexOf("The chart and data disagree")).toBeLessThan(markdown.indexOf("## Findings"));
  expect(html.indexOf("The chart and data disagree")).toBeLessThan(html.indexOf('<section aria-labelledby="findings"'));
  const numbers: string[] = [];
  let cell = "";
  await new HTMLRewriter().on("tbody td", {
    element(element) { cell = ""; element.onEndTag(() => { numbers.push(cell); }); },
    text(chunk) { cell += chunk.text; },
  }).transform(new Response(html)).text();
  expect(numbers).toEqual(["12", "10", "2", "1", "11", "10", "1", "1", "-2", "-5", "3", "0"]);
  expect(html).toContain("Login required");
  expect(html).toContain("The page did not finish loading");
  expect(html).not.toContain("fixture-token");
  expect(html).not.toContain("fixture-unchecked");
  expect(markdown).not.toContain("fixture-token");
});

test("the report carries the exact saved receipt and distinguishes CSS crop from original raster finding coordinates", async () => {
  const directory = temporary(), capture = await saved(directory);
  const result = await createResearchReport({ out: join(directory, "report"), answer: "The saved region is attached.", findings: [{ claim: "A saved region", evidence: capture.evidence.path, region: { x: 0, y: 0, width: 1, height: 1 } }] });
  const markdown = readFileSync(result.path, "utf8"), html = readFileSync(result.html, "utf8");
  const exactReceipt = readFileSync(capture.evidence.path, "utf8").trimEnd().split("\n").map((line) => `    ${line}`).join("\n");
  expect(markdown).toContain(exactReceipt);
  expect(markdown).toContain(capture.evidence.sha256);
  expect(html).toContain(capture.evidence.sha256);
  expect(markdown).toContain("Capture crop: x 4, y 6, width 0.5, height 0.5 CSS px");
  expect(markdown).toContain("Finding region: x 0, y 0, width 1, height 1 original raster px");
  expect(html).toContain("x 4, y 6, width 0.5, height 0.5 CSS px");
  expect(html).toContain("x 0, y 0, width 1, height 1 original raster px");
  expect(statSync(result.path).mode & 0o777).toBe(0o600);
  expect(statSync(result.html).mode & 0o777).toBe(0o600);
  expect(statSync(join(directory, "report")).mode & 0o777).toBe(0o700);
});

test("a copied report keeps its actual images offline without scripts or external assets", async () => {
  const directory = temporary(), capture = await saved(directory), folder = join(directory, "report");
  await createResearchReport({ out: folder, answer: "The saved image is attached.", findings: [{ claim: "A saved image", evidence: capture.evidence.path }] });
  const portable = temporary(); cpSync(folder, portable, { recursive: true }); rmSync(directory, { recursive: true });
  const html = readFileSync(join(portable, "index.html"), "utf8"), tags: string[] = [], images: string[] = [], externalAssets: string[] = [];
  await new HTMLRewriter().on("*", { element(element) {
    tags.push(element.tagName);
    if (element.tagName === "img") images.push(element.getAttribute("src") ?? "");
    if (["img", "script", "link", "iframe", "object", "embed", "audio", "video", "source"].includes(element.tagName)) {
      for (const attribute of ["src", "href", "data", "poster"]) {
        const value = element.getAttribute(attribute);
        if (value && !value.startsWith("data:image/png;base64,")) externalAssets.push(value);
      }
    }
  } }).transform(new Response(html)).text();
  expect(tags).not.toContain("script");
  expect(externalAssets).toEqual([]);
  expect(images).toEqual([`data:image/png;base64,${png().toString("base64")}`]);
  expect(Buffer.from(images[0].split(",")[1], "base64")).toEqual(png());
  expect(readFileSync(join(portable, "evidence", `${capture.evidence.sha256}.png`))).toEqual(png());
  expect(html).toContain("Content-Security-Policy");
  expect(html).not.toMatch(/@import|url\(https?:/i);
});

test("hostile report text stays text and cannot create executable elements or attributes", async () => {
  const directory = temporary(), capture = await saved(directory, '</title><script>globalThis.sourceAttack=1</script>');
  const result = await createResearchReport({
    out: join(directory, "report"), title: '</title><script>globalThis.titleAttack=1</script>',
    answer: '<img src="bad" onerror="globalThis.answerAttack=1"> [bad](javascript:alert(1))',
    findings: [{ claim: '<svg onload="globalThis.claimAttack=1"></svg>', evidence: capture.evidence.path, comparison: { visual: 1, data: 2, unit: '</caption><script>globalThis.unitAttack=1</script>' } }],
    unchecked: [{ url: "javascript:alert(1)", reason: '</p><iframe src="https://bad.test"></iframe>' }],
  });
  const html = readFileSync(result.html, "utf8"), executable: string[] = [], imageSources: string[] = [], headings: string[] = [];
  await new HTMLRewriter().on("*", { element(element) {
    if (["script", "iframe", "svg", "object", "embed"].includes(element.tagName)) executable.push(element.tagName);
    for (const [name, value] of element.attributes) {
      if (/^on/i.test(name) || (["href", "src"].includes(name) && /^javascript:/i.test(value))) executable.push(`${name}=${value}`);
    }
    if (element.tagName === "img") imageSources.push(element.getAttribute("src") ?? "");
    if (/^h[1-6]$/.test(element.tagName)) headings.push(element.tagName);
  } }).transform(new Response(html)).text();
  expect(executable).toEqual([]);
  expect(imageSources).toEqual([`data:image/png;base64,${png().toString("base64")}`]);
  expect(headings).toEqual(["h1", "h2", "h3", "h2"]);
  expect(html).toContain("globalThis.answerAttack");
  expect(html).toContain("globalThis.sourceAttack");
  expect(html).not.toContain('<img src="bad"');
  const markdownExecutable: string[] = [];
  const renderedMarkdown = Bun.markdown.html(readFileSync(result.path, "utf8"), { tagFilter: false });
  await new HTMLRewriter().on("*", { element(element) {
    if (["script", "iframe", "svg", "object", "embed"].includes(element.tagName)) markdownExecutable.push(element.tagName);
    for (const [name, value] of element.attributes) {
      if (/^on/i.test(name) || (["href", "src"].includes(name) && /^javascript:/i.test(value))) markdownExecutable.push(`${name}=${value}`);
    }
  } }).transform(new Response(renderedMarkdown)).text();
  expect(markdownExecutable).toEqual([]);
});

test("an uncited finding is rejected before any report folder is written", async () => {
  const directory = temporary(), out = join(directory, "report");
  await expect(createResearchReport({ out, answer: "No saved support.", findings: [{ claim: "An unsupported claim" }] })).rejects.toThrow(/finding.evidence/);
  expect(existsSync(out)).toBe(false);
});

test("tampered evidence cannot be turned into a report", async () => {
  const directory = temporary(), capture = await saved(directory), verified = await verifyEvidence(capture.evidence.path), out = join(directory, "report");
  writeFileSync(verified.path, "not the saved image");
  await expect(createResearchReport({ out, answer: "This must not be published.", findings: [{ claim: "A claim", evidence: capture.evidence.path }] })).rejects.toThrow(/SHA256 does not match/);
  expect(existsSync(out)).toBe(false);
});

const invalidRegions: [string, Record<string, number>][] = [
  ["negative origin", { x: -1, y: 0, width: 1, height: 1 }],
  ["past the right edge", { x: 1, y: 0, width: 1, height: 1 }],
  ["past the bottom edge", { x: 0, y: 1, width: 1, height: 1 }],
  ["fractional raster coordinate", { x: 0.5, y: 0, width: 0.5, height: 1 }],
  ["empty region", { x: 0, y: 0, width: 0, height: 1 }],
  ["nonfinite coordinate", { x: NaN, y: 0, width: 1, height: 1 }],
];
test.each(invalidRegions)("a finding with %s is rejected", async (_name, region) => {
  const directory = temporary(), capture = await saved(directory), out = join(directory, "report");
  await expect(createResearchReport({ out, answer: "Invalid region.", findings: [{ claim: "A region", evidence: capture.evidence.path, region }] })).rejects.toThrow(/region/);
  expect(existsSync(out)).toBe(false);
});

const invalidComparisons: [string, Record<string, unknown>, RegExp][] = [
  ["NaN visual value", { visual: NaN, data: 1, unit: "USD" }, /finite number/],
  ["infinite data value", { visual: 1, data: Infinity, unit: "USD" }, /finite number/],
  ["infinite tolerance", { visual: 1, data: 2, unit: "USD", tolerance: Infinity }, /finite number/],
  ["negative tolerance", { visual: 1, data: 2, unit: "USD", tolerance: -1 }, /cannot be negative/],
  ["overflowing difference", { visual: Number.MAX_VALUE, data: -Number.MAX_VALUE, unit: "USD" }, /difference must be finite/],
  ["missing unit", { visual: 1, data: 2 }, /comparison.unit/],
];
test.each(invalidComparisons)("a comparison with %s is rejected", async (_name, comparison, error) => {
  const directory = temporary(), capture = await saved(directory), out = join(directory, "report");
  await expect(createResearchReport({ out, answer: "Invalid comparison.", findings: [{ claim: "A comparison", evidence: capture.evidence.path, comparison }] })).rejects.toThrow(error);
  expect(existsSync(out)).toBe(false);
});

test("an unchecked source requires a real reason rather than being silently counted as absent", async () => {
  const directory = temporary(), out = join(directory, "report");
  await expect(createResearchReport({ out, answer: "Not checked.", findings: [], unchecked: [{ url: "https://example.test/", reason: " " }] })).rejects.toThrow(/unchecked.reason/);
  expect(existsSync(out)).toBe(false);
});

test("a report with no findings still keeps unchecked sources and their reasons separate", async () => {
  const result = await createResearchReport({ out: join(temporary(), "report"), answer: "The source could not be checked.", findings: [], unchecked: [{ url: "https://example.test/", reason: "Login required" }] });
  expect(result).toMatchObject({ findings: 0, unchecked: 1, mismatches: 0 });
  const html = readFileSync(result.html, "utf8");
  expect(html).toContain("Login required");
  expect(html).not.toContain("data:image/png");
});


test("a relative output folder is rejected", async () => {
  await expect(createResearchReport({ out: "relative-report", answer: "A report.", findings: [] })).rejects.toThrow(/absolute folder/);
});
