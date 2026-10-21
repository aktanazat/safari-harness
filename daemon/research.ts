import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { evidenceRegion, verifyEvidence, type Region, type VerifiedEvidence } from "./evidence.ts";
import { redacted, redactUrl } from "./redact.ts";

type Comparison = { visual: number; data: number; unit: string; tolerance: number; difference: number; mismatch: boolean };
type Finding = { claim: string; capture: VerifiedEvidence; region?: Region; comparison?: Comparison };
type Unchecked = { url: string; reason: string };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const markdownText = (value: string) => escapeHtml(value.replace(/([\\`*_{}\[\]()#+=.!|:~-])/g, "\\$1"));

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.includes("\0") || !value.trim()) throw new Error(`${name} must be nonempty text without null bytes`);
  return value;
}
function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}
function comparisonOf(value: unknown): Comparison {
  const raw = object(value, "comparison");
  const visual = number(raw.visual, "comparison.visual"), data = number(raw.data, "comparison.data");
  const tolerance = raw.tolerance === undefined ? 0 : number(raw.tolerance, "comparison.tolerance");
  if (tolerance < 0) throw new Error("comparison.tolerance cannot be negative");
  const unit = redactUrl(text(raw.unit, "comparison.unit"));
  const difference = Math.abs(visual - data);
  if (!Number.isFinite(difference)) throw new Error("comparison difference must be finite");
  return { visual, data, unit, tolerance, difference, mismatch: difference > tolerance };
}
function regionText(region: Region): string {
  return `x ${region.x}, y ${region.y}, width ${region.width}, height ${region.height}`;
}
function sourceLink(url: string): string {
  const parsed = new URL(url);
  return parsed.protocol === "https:" || parsed.protocol === "http:"
    ? `<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(url)}</a>`
    : `<span>${escapeHtml(url)}</span>`;
}
function comparisonHtml(value: Comparison): string {
  const unit = escapeHtml(value.unit);
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Numeric comparison"><table><caption>Supplied values (${unit})</caption><thead><tr><th scope="col">Image</th><th scope="col">Data</th><th scope="col">Difference</th><th scope="col">Allowed difference</th></tr></thead><tbody><tr><td>${value.visual}</td><td>${value.data}</td><td>${value.difference}</td><td>${value.tolerance}</td></tr></tbody></table></div><p class="comparison ${value.mismatch ? "mismatch" : "match"}">${value.mismatch ? "The difference is larger than allowed." : "The difference is within the allowed amount."}</p>`;
}
function findingHtml(finding: Finding, index: number): string {
  const { capture, region, comparison } = finding, evidence = capture.evidence;
  const geometry = region ? `${regionText(region)} original raster px` : `Full image: ${evidence.width} × ${evidence.height} original raster px`;
  const alt = `Saved capture: ${evidence.title || evidence.url}${region ? `. Marked region: ${geometry}` : ""}`;
  const crop = evidence.crop ? `<dt>Capture crop</dt><dd>${escapeHtml(regionText(evidence.crop))} CSS px</dd>` : "";
  const tiles = evidence.tiles?.length ? `<dt>Tiles</dt><dd><ul>${evidence.tiles.map((tile) => `<li>${escapeHtml(regionText(tile.region))} original raster px<br><code>${tile.sha256}</code></li>`).join("")}</ul></dd>` : "";
  return `<article aria-labelledby="finding-${index}"><h3 id="finding-${index}">${escapeHtml(finding.claim)}</h3>
${capture.cut ? '<p class="mismatch">The rest of the page is not in this capture.</p>' : ""}
<figure><div class="image-wrap"><img src="data:image/png;base64,${capture.image.toString("base64")}" width="${evidence.width}" height="${evidence.height}" alt="${escapeHtml(alt)}">${region ? `<span class="region region-${index}" aria-hidden="true"></span>` : ""}</div><figcaption>Source: ${sourceLink(evidence.url)}<br>Captured <time datetime="${evidence.capturedAt}">${evidence.capturedAt}</time></figcaption></figure>
${comparison ? comparisonHtml(comparison) : ""}
<details><summary>Capture details and receipt</summary><dl class="source"><dt>Page title</dt><dd>${escapeHtml(evidence.title || "Untitled")}</dd><dt>Image</dt><dd>${evidence.width} × ${evidence.height} raster px</dd><dt>Viewport</dt><dd>${evidence.viewport.width} × ${evidence.viewport.height} CSS px; pixel ratio ${evidence.viewport.devicePixelRatio}</dd>${crop}<dt>Finding region</dt><dd>${escapeHtml(geometry)}</dd><dt>Masked areas</dt><dd>${evidence.privacy.masked}</dd>${capture.screens === undefined ? "" : `<dt>Captured screens</dt><dd>${capture.screens}</dd>`}${tiles}<dt>Receipt</dt><dd><code>${escapeHtml(evidence.path)}</code></dd><dt>Image</dt><dd><code>${escapeHtml(capture.path)}</code></dd><dt>SHA256</dt><dd><code>${evidence.sha256}</code></dd></dl><pre><code>${escapeHtml(capture.receipt)}</code></pre></details></article>`;
}
function findingMarkdown(finding: Finding): string {
  const { capture, region, comparison } = finding, evidence = capture.evidence;
  const lines = [
    `### ${markdownText(finding.claim).replace(/\n/g, " ")}`, "",
    "![Saved capture](evidence/" + evidence.sha256 + ".png)", "",
    `- Source: ${markdownText(evidence.url)}`,
    `- Page title: ${markdownText(evidence.title || "Untitled")}`,
    `- Captured: ${markdownText(evidence.capturedAt)}`,
    `- Image: ${evidence.width} × ${evidence.height} raster px`,
    `- Viewport: ${evidence.viewport.width} × ${evidence.viewport.height} CSS px; pixel ratio ${evidence.viewport.devicePixelRatio}`,
    ...(evidence.crop ? [`- Capture crop: ${regionText(evidence.crop)} CSS px`] : []),
    `- Finding region: ${region ? `${regionText(region)} original raster px` : "full original raster image"}`,
    `- Masked areas: ${evidence.privacy.masked}`,
    ...(capture.screens === undefined ? [] : [`- Captured screens: ${capture.screens}`]),
    ...(capture.cut ? ["- The rest of the page is not in this capture."] : []),
    ...(evidence.tiles ?? []).map((tile) => `- Tile: ${regionText(tile.region)} original raster px; SHA256 ${tile.sha256}`),
  ];
  if (comparison) lines.push("", `Supplied comparison: image ${comparison.visual} ${markdownText(comparison.unit)}; data ${comparison.data} ${markdownText(comparison.unit)}; difference ${comparison.difference} ${markdownText(comparison.unit)}; allowed difference ${comparison.tolerance} ${markdownText(comparison.unit)}. ${comparison.mismatch ? "Mismatch" : "Within tolerance"}.`);
  lines.push("", `Receipt: ${markdownText(evidence.path)}`, "", `Image SHA256: ${evidence.sha256}`, "", "Evidence receipt:", "", capture.receipt.trimEnd().split("\n").map((line) => `    ${line}`).join("\n"), "");
  return lines.join("\n");
}

const STYLE = `
:root{color-scheme:light dark;--bg:oklch(98.5% 0.004 90);--text:oklch(23% 0.01 90);--muted:oklch(45% 0.012 90);--line:oklch(89% 0.008 90);--surface:oklch(95% 0.006 90);--link:oklch(45% 0.11 240);--mismatch:oklch(50% 0.17 27)}
@media(prefers-color-scheme:dark){:root{--bg:oklch(19% 0.006 90);--text:oklch(94% 0.006 90);--muted:oklch(73% 0.01 90);--line:oklch(31% 0.008 90);--surface:oklch(25% 0.008 90);--link:oklch(79% 0.09 240);--mismatch:oklch(73% 0.15 27)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}main{max-width:66rem;margin-inline:auto;padding:2.5rem clamp(1rem,4vw,3rem) 4rem}h1,h2,h3{line-height:1.25;overflow-wrap:anywhere;text-wrap:balance}h1{font-size:1.8rem;letter-spacing:-.02em;margin:0 0 1.1rem}h2{font-size:1.35rem;margin:2.7rem 0 1rem}h3{font-size:1.15rem;margin:0 0 1rem}p{margin:.6rem 0;text-wrap:pretty;overflow-wrap:anywhere}.answer{font-size:1.15rem;white-space:pre-wrap;max-width:60ch}.accounting,.limits,figcaption{color:var(--muted)}.limits{font-size:.9rem;max-width:70ch}article{padding:1.6rem 0;border-top:1px solid var(--line)}article:last-child{border-bottom:1px solid var(--line)}a{color:var(--link);text-underline-offset:.18em;overflow-wrap:anywhere}a:focus-visible,summary:focus-visible,.table-scroll:focus-visible{outline:2px solid var(--link);outline-offset:3px}.source{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:.35rem 1rem;font-size:.9rem;margin:1rem 0}.source dt{color:var(--muted)}.source dd{margin:0;overflow-wrap:anywhere}.source ul{margin:0;padding-left:1.1rem}.source li+li{margin-top:.5rem}code,pre{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.8rem}code{overflow-wrap:anywhere}pre{padding:1rem;background:var(--surface);white-space:pre-wrap;overflow-wrap:anywhere}figure{margin:1.4rem 0}.image-wrap{position:relative;line-height:0;outline:1px solid var(--line);outline-offset:-1px}img{display:block;width:100%;height:auto}.region{position:absolute;outline:2px solid var(--link);outline-offset:-2px;box-shadow:0 0 0 1px var(--bg) inset;pointer-events:none}figcaption{font-size:.85rem;margin-top:.5rem}summary{cursor:pointer;min-height:44px;display:list-item;align-content:center;padding:.65rem 0}details{border-top:1px solid var(--line)}.table-scroll{overflow-x:auto;margin-top:1.3rem}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.9rem}caption{text-align:left;margin-bottom:.4rem}th,td{text-align:right;padding:.5rem .65rem;border-bottom:1px solid var(--line);white-space:nowrap}th{font-weight:500;color:var(--muted)}th:first-child,td:first-child{padding-left:0}th:last-child,td:last-child{padding-right:0}.comparison{font-size:.9rem;font-variant-numeric:tabular-nums}.mismatch{color:var(--mismatch)}.unchecked{padding-left:1.2rem}.unchecked li{padding:.6rem 0}.unchecked p{margin:.2rem 0}.unchecked .url{font-size:.9rem}nav{margin:1.4rem 0}nav a{display:inline-flex;min-height:44px;align-items:center;margin-right:1.3rem}.skip{position:absolute;left:1rem;top:0;transform:translateY(-150%);padding:.7rem;background:var(--bg);z-index:2}.skip:focus{transform:none}@media(max-width:540px){main{padding-top:1.5rem}.source{grid-template-columns:1fr;gap:.1rem}.source dt:not(:first-child){margin-top:.65rem}h1{font-size:1.6rem}}@media print{body{background:white;color:black}details{break-inside:avoid}details>summary{display:none}details:not([open])>*{display:block}a{color:inherit}nav,.skip{display:none}.region{outline-color:black}}
@media(pointer:coarse),(max-width:540px){.source a,.unchecked .url a,figcaption a{display:inline-block;min-width:44px;min-height:44px;align-content:center}}
`;

async function writePrivate(path: string, bytes: Uint8Array | string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("report output must be a regular file, not a link");
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const temporary = join(dirname(path), `.report-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); } finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; });
  }
}

export async function createResearchReport(args: Record<string, unknown>): Promise<{ path: string; html: string; findings: number; unchecked: number; mismatches: number }> {
  const asked = text(args.out, "out");
  if (!isAbsolute(asked)) throw new Error("out must be an absolute folder path");
  const safeTitle = object(redacted({ title: args.title === undefined ? "Research" : text(args.title, "title") }), "redacted title");
  const title = text(safeTitle.title, "title");
  const answer = redactUrl(text(args.answer, "answer"));
  if (!Array.isArray(args.findings)) throw new Error("findings must be a list of evidence-backed claims");
  if (args.unchecked !== undefined && !Array.isArray(args.unchecked)) throw new Error("unchecked must be a list of URLs with reasons");
  const unchecked: Unchecked[] = (args.unchecked ?? []).map((value: unknown) => {
    const raw = object(value, "unchecked source");
    const url = text(raw.url, "unchecked.url");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("unchecked.url must be a valid absolute URL"); }
    parsed.username = ""; parsed.password = "";
    return { url: redactUrl(parsed.href), reason: redactUrl(text(raw.reason, "unchecked.reason")) };
  });
  const verified = new Map<string, VerifiedEvidence>();
  const findings: Finding[] = [];
  for (const value of args.findings) {
    const raw = object(value, "finding"), claim = redactUrl(text(raw.claim, "finding.claim"));
    const receipt = text(raw.evidence, "finding.evidence");
    let capture = verified.get(receipt);
    if (!capture) { capture = await verifyEvidence(receipt); verified.set(receipt, capture); }
    const region = raw.region === undefined ? undefined : evidenceRegion(raw.region, capture.evidence.width, capture.evidence.height);
    const comparison = raw.comparison === undefined ? undefined : comparisonOf(raw.comparison);
    findings.push({ claim, capture, ...(region === undefined ? {} : { region }), ...(comparison === undefined ? {} : { comparison }) });
  }
  const mismatches = findings.filter((finding) => finding.comparison?.mismatch).length;
  const accounting = `${findings.length} finding${findings.length === 1 ? "" : "s"} · ${mismatches} numeric mismatch${mismatches === 1 ? "" : "es"} · ${unchecked.length} unchecked source${unchecked.length === 1 ? "" : "s"}`;
  const limits = "Saved image integrity checked. Claims and comparison inputs were not independently checked.";
  const regions = findings.flatMap((finding, index) => finding.region ? [`.region-${index}{left:${finding.region.x / finding.capture.evidence.width * 100}%;top:${finding.region.y / finding.capture.evidence.height * 100}%;width:${finding.region.width / finding.capture.evidence.width * 100}%;height:${finding.region.height / finding.capture.evidence.height * 100}%}`] : []).join("\n");
  const style = `${STYLE}\n${regions}`;
  const styleHash = createHash("sha256").update(style).digest("base64");
  const csp = `default-src 'none'; img-src data:; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'`;
  const uncheckedHtml = unchecked.length
    ? `<ul class="unchecked">${unchecked.map((item) => `<li><div class="url">${sourceLink(item.url)}</div><p>${escapeHtml(item.reason)}</p></li>`).join("")}</ul>`
    : '<p class="limits">No unchecked sources were listed.</p>';
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><title>${escapeHtml(title)}</title><style>${style}</style></head><body><a class="skip" href="#answer">Skip to answer</a><main><header><h1>${escapeHtml(title)}</h1><p class="answer" id="answer">${escapeHtml(answer)}</p><p class="accounting">${accounting}</p><p class="limits">${limits}</p></header><nav aria-label="Report sections"><a href="#findings">Findings</a><a href="#unchecked">Unchecked sources (${unchecked.length})</a></nav><section aria-labelledby="findings"><h2 id="findings">Findings</h2>${findings.length ? findings.map(findingHtml).join("") : '<p class="limits">No findings were supplied.</p>'}</section><section aria-labelledby="unchecked"><h2 id="unchecked">Unchecked sources</h2>${uncheckedHtml}</section></main></body></html>`;
  const markdown = [
    `# ${markdownText(title).replace(/\n/g, " ")}`, "", markdownText(answer), "", accounting, "", limits, "", "## Findings", "",
    ...(findings.length ? findings.map(findingMarkdown) : ["No findings were supplied.", ""]),
    "## Unchecked sources", "",
    ...(unchecked.length ? unchecked.map((item) => `- ${markdownText(item.url)}\n\n  ${markdownText(item.reason).replace(/\n/g, "\n  ")}`) : ["No unchecked sources were listed."]), "",
  ].join("\n");
  const folder = resolve(asked);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("out must be a real folder, not a link");
  await chmod(folder, 0o700);
  const out = await realpath(folder), assets = join(out, "evidence");
  await mkdir(assets, { recursive: true, mode: 0o700 });
  const assetStat = await lstat(assets);
  if (!assetStat.isDirectory() || assetStat.isSymbolicLink()) throw new Error("report evidence must be a real folder, not a link");
  await chmod(assets, 0o700);
  for (const capture of verified.values()) await writePrivate(join(assets, `${capture.evidence.sha256}.png`), capture.image);
  const path = join(out, "report.md"), html = join(out, "index.html");
  await writePrivate(path, markdown);
  await writePrivate(html, document);
  return { path, html, findings: findings.length, unchecked: unchecked.length, mismatches };
}
