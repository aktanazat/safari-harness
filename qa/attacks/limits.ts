import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import type { Server, Subprocess } from "bun";

const candidate = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
const scratch = mkdtempSync("/private/var/tmp/safari-limits-");
const home = join(scratch, "home");
mkdirSync(home, { mode: 0o700 });
process.env.HOME = home;
process.env.TMPDIR = scratch;
const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
const children: Subprocess[] = [];
const exitedChildren = new Set<Subprocess>();
const listeners: Server<undefined>[] = [];
const results: { name: string; pass: boolean; error?: string }[] = [];
let requests = 0;
let daemonLog = "";
let base = "";
let cleanup = false;
const sentinels = new Map<string, Buffer>();
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function sentinel(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(`unrelated synthetic file ${randomUUID()}`);
  writeFileSync(path, bytes);
  sentinels.set(path, bytes);
}
function intact(): void {
  for (const [path, bytes] of sentinels) assert.deepEqual(readFileSync(path), bytes, `unrelated file changed: ${path}`);
}
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); intact(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); results.push({ name, pass: false, error: message }); console.log(`FAIL ${name}: ${message}`); }
}
function reserve(): Server<undefined> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  assert(![37333, 37334].includes(server.port!));
  listeners.push(server);
  return server;
}
async function request(path: string, body?: unknown, raw?: string): Promise<{ status: number; text: string; value: unknown }> {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload) assert(Buffer.byteLength(payload) <= 1024 * 1024);
  requests++;
  const response = await fetch(`${base}${path}`, { method: payload === undefined ? "GET" : "POST", headers: { "user-agent": userAgent, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, body: payload, signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, text, value };
}
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function refused(response: { status: number; value: unknown }, expected: number): void {
  assert.equal(response.status, expected);
  const value = object(response.value);
  assert.equal(value.ok, false);
  assert.equal(typeof value.error, "string");
  assert(String(value.error).length > 0);
}
function chunk(type: string, body: Buffer): Buffer {
  const bytes = Buffer.concat([Buffer.from(type), body]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(body.length); checksum.writeUInt32BE(crc32(bytes));
  return Buffer.concat([size, bytes, checksum]);
}
function png(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 20, 40, 60, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
async function stop(child: Subprocess): Promise<void> {
  if (exitedChildren.has(child)) return;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1500);
  try { await child.exited; exitedChildren.add(child); } finally { clearTimeout(timer); }
}
try {
  assert(existsSync(join(candidate, "daemon/main.ts")), "candidate daemon missing");
  const evidence = await import(pathToFileURL(join(candidate, "daemon/evidence.ts")).href);
  const http = reserve(), ws = reserve();
  const httpPort = http.port!, wsPort = ws.port!;
  base = `http://127.0.0.1:${httpPort}`;
  const state = join(home, ".local/share/safari-harness");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const historyFile = join(state, `history-${httpPort}.json`), pictureRoot = `${historyFile}.pictures`;
  const mission = randomUUID(), picture = randomUUID(), expiredMission = randomUUID(), expiredPicture = randomUUID();
  const now = Date.now(), old = now - 31 * 24 * 60 * 60_000;
  const image = png();
  const capture = { data: image.toString("base64"), source: { url: `${base}/synthetic`, title: "Synthetic image", capturedAt: new Date(now).toISOString(), width: 1, height: 1, viewport: { width: 1, height: 1, devicePixelRatio: 1 }, privacy: { masked: 0 } } };
  const saved = await evidence.saveCapture(capture, join(pictureRoot, mission, `${picture}.png`));
  const expired = await evidence.saveCapture(capture, join(pictureRoot, expiredMission, `${expiredPicture}.png`));
  const orphan = await evidence.saveCapture(capture, join(pictureRoot, mission, `${randomUUID()}.png`));
  const summary = { sha256: saved.evidence.sha256, capturedAt: capture.source.capturedAt, width: 1, height: 1, masked: 0, url: base };
  const record = (id: string, active: number, calls: unknown[]) => ({ id, owner: null, process: null, since: active, active, raised: 0, status: "ended", controls: false, spaces: [], pictures: true, calls });
  const calls: unknown[] = Array.from({ length: 204 }, (_, i) => ({ t: now + i, tool: "unknown", outcome: "failed", args: "synthetic-private-text" }));
  calls.push({ t: now + 205, tool: "click", outcome: "done", picture: { id: picture, receipt: saved.evidence.path, bytes: image.length, capture: summary } });
  const fixtures = Array.from({ length: 102 }, (_, i) => record(randomUUID(), now - i, []));
  fixtures.push(record(expiredMission, old, [{ t: old, tool: "click", outcome: "done", picture: { id: expiredPicture, receipt: expired.evidence.path, bytes: image.length, capture: summary } }]));
  fixtures.push(record(mission, now, calls));
  const seeded = JSON.stringify({ version: 1, missions: fixtures });
  assert(Buffer.byteLength(seeded) < 1024 * 1024);
  writeFileSync(historyFile, seeded);
  sentinel(join(scratch, "unrelated.txt"));
  sentinel(join(dirname(expired.evidence.path), "keep.txt"));
  sentinel(join(pictureRoot, mission, "keep.txt"));
  const linkedOutside = join(scratch, "outside-linked-folder");
  sentinel(join(linkedOutside, "keep.txt"));
  symlinkSync(linkedOutside, join(pictureRoot, randomUUID()));
  http.stop(true); ws.stop(true);
  const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, HOME: home, TMPDIR: scratch }, stdout: "ignore", stderr: "ignore" });
  children.push(owner);
  const daemon = Bun.spawn([process.execPath, join(candidate, "daemon/main.ts")], { cwd: candidate, env: { ...process.env, HOME: home, TMPDIR: scratch, SAFARI_HARNESS_WS: String(wsPort), SAFARI_HARNESS_HTTP_PORT: String(httpPort) }, stdout: "pipe", stderr: "pipe" });
  children.push(daemon);
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    while (true) { const part = await reader.read(); if (part.done) break; daemonLog = (daemonLog + new TextDecoder().decode(part.value)).slice(-65536); }
  };
  const logs = [collect(daemon.stdout), collect(daemon.stderr)];
  const deadline = Date.now() + 15000;
  while (true) {
    try { const response = await request("/health"); assert.equal(object(response.value).pid, daemon.pid); assert.equal(object(response.value).root, candidate); break; }
    catch (error) { if (Date.now() >= deadline || daemon.exitCode !== null) throw new Error(`isolated daemon unavailable: ${String(error)}\n${daemonLog}`); await Bun.sleep(40); }
  }
  const rpc = (args: Record<string, unknown>) => request("/rpc", { tool: "report", args, caller: owner.pid, own: true });
  let sequence = 0;
  const reportArgs = (finding: Record<string, unknown>, out = join(scratch, `report-${sequence++}`)) => ({ out, answer: "Synthetic answer.", findings: [{ claim: "Synthetic claim.", evidence: saved.evidence.path, ...finding }] });
  await check("valid report verifies actual receipt, image, region and calculated comparison", async () => {
    const response = await rpc(reportArgs({ region: { x: 0, y: 0, width: 1, height: 1 }, comparison: { visual: -2, data: -5, unit: "USD", tolerance: 1, mismatch: false } }));
    assert.equal(response.status, 200); assert.equal(object(response.value).ok, true);
    const value = object(object(response.value).value);
    assert.equal(value.findings, 1); assert.equal(value.mismatches, 1);
    const html = readFileSync(String(value.html), "utf8");
    assert(html.includes(`data:image/png;base64,${image.toString("base64")}`));
    const numbers: string[] = [];
    let cell = "";
    await new HTMLRewriter().on("tbody td", {
      element(element) { cell = ""; element.onEndTag(() => { numbers.push(cell); }); },
      text(chunk) { cell += chunk.text; },
    }).transform(new Response(html)).text();
    assert.deepEqual(numbers, ["-2", "-5", "3", "1"]);
    assert(readFileSync(String(value.path), "utf8").includes(saved.evidence.sha256));
    assert.deepEqual(readFileSync(join(dirname(String(value.path)), "evidence", `${saved.evidence.sha256}.png`)), image);
    assert.equal(lstatSync(String(value.html)).mode & 0o777, 0o600);
  });
  const overview = object((await request("/agents.json")).value);
  assert(Array.isArray(overview.agents));
  const live = object(overview.agents.find((value: unknown) => object(value).owner === owner.pid));
  const control = (extra: Record<string, unknown>) => request("/agents/control", { owner: owner.pid, mission: live.id, secret: live.controlSecret, ...extra });
  await check("own capability pauses, resumes and toggles pictures without browser connection", async () => {
    for (const [action, status] of [["pause", "paused"], ["resume", "working"], ["pictures_on", "working"], ["pictures_off", "working"]]) {
      const response = await control({ action }); assert.equal(response.status, 200); assert.equal(object(response.value).ok, true); assert.equal(object(response.value).status, status);
    }
    const rows = object((await request("/agents.json")).value).agents;
    assert(Array.isArray(rows)); assert.equal(object(rows.find((v: unknown) => object(v).owner === owner.pid)).pictures, false);
  });
  for (const [name, ownerValue] of [["empty", ""], ["negative", -1], ["zero", 0], ["null", null], ["fraction", 1.5], ["special", "../<script>\u0000"], ["object", {}]] as const) {
    await check(`control rejects ${name} owner`, async () => refused(await control({ owner: ownerValue, action: "pause" }), 404));
  }
  for (const [name, action] of [["empty", ""], ["negative", -1], ["null", null], ["special", "../pause\u0000<script>"], ["array", ["pause"]]] as const) {
    await check(`control rejects ${name} action`, async () => refused(await control({ action }), 400));
  }
  await check("control rejects malformed JSON and missing capability", async () => {
    refused(await request("/agents/control", undefined, "{"), 400);
    refused(await control({ action: "pause", secret: "" }), 403);
    refused(await control({ action: "pause", mission: "../wrong" }), 409);
  });
  for (const id of ["", "-1", "../outside", "<script>\"&\u0000", "__proto__"]) {
    await check(`space control rejects identifier ${JSON.stringify(id)}`, async () => refused(await request("/space/control", { id, secret: live.controlSecret, action: "pause" }), 409));
  }
  await check("history enforces age, mission and call retention and strips private arguments", async () => {
    const response = await request("/agents/history.json"); assert.equal(response.status, 200);
    const value = object(response.value); assert(Array.isArray(value.missions)); assert(value.missions.length <= 100);
    assert(!value.missions.some((v: unknown) => object(v).id === expiredMission));
    const kept = object(value.missions.find((v: unknown) => object(v).id === mission));
    assert.equal(kept.controls, false); assert(Array.isArray(kept.calls)); assert.equal(kept.calls.length, 200);
    assert(!response.text.includes("synthetic-private-text")); assert(!response.text.includes(scratch));
    assert(!existsSync(expired.evidence.path)); assert(!existsSync(expired.path)); assert(!existsSync(orphan.evidence.path));
    assert(existsSync(saved.evidence.path)); assert.deepEqual(readFileSync(saved.path), image);
  });
  await check("retained picture returns verified PNG bytes with no-store", async () => {
    const response = await fetch(`${base}/agents/picture?id=${mission}&picture=${picture}`, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(5000) }); requests++;
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png"); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  });
  for (const id of ["", "-1", "../outside", "<script>\"&\u0000", saved.path, saved.evidence.path]) {
    await check(`picture lookup rejects identifier ${JSON.stringify(id)}`, async () => {
      refused(await request(`/agents/picture?id=${mission}&picture=${encodeURIComponent(id)}`), 404);
      refused(await request(`/agents/picture?id=${encodeURIComponent(id)}&picture=${picture}`), 404);
    });
  }
  const invalidRegions: [string, unknown][] = [["empty", {}], ["negative", { x: -1, y: 0, width: 1, height: 1 }], ["zero width", { x: 0, y: 0, width: 0, height: 1 }], ["fraction", { x: 0.5, y: 0, width: 1, height: 1 }], ["outside", { x: 1, y: 0, width: 1, height: 1 }], ["unsafe integer", { x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 }], ["string", "../outside"]];
  for (const [name, region] of invalidRegions) await check(`report rejects ${name} region without writing`, async () => {
    const args = reportArgs({ region }); refused(await rpc(args), 200); assert(!existsSync(args.out));
  });
  const invalidComparisons: [string, unknown][] = [["empty", {}], ["string number", { visual: "1", data: 2, unit: "USD" }], ["negative tolerance", { visual: 1, data: 2, unit: "USD", tolerance: -1 }], ["empty unit", { visual: 1, data: 2, unit: "" }], ["null unit", { visual: 1, data: 2, unit: "x\u0000" }], ["overflow", { visual: Number.MAX_VALUE, data: -Number.MAX_VALUE, unit: "USD" }]];
  for (const [name, comparison] of invalidComparisons) await check(`report rejects ${name} comparison without writing`, async () => {
    const args = reportArgs({ comparison }); refused(await rpc(args), 200); assert(!existsSync(args.out));
  });
  await check("report refuses wire-level infinity", async () => {
    const args = reportArgs({ comparison: { visual: "INFINITY_MARKER", data: 1, unit: "USD" } });
    const body = JSON.stringify({ tool: "report", args, caller: owner.pid, own: true }).replace('"INFINITY_MARKER"', "1e309");
    refused(await request("/rpc", undefined, body), 200); assert(!existsSync(args.out));
  });
  for (const path of ["", "../outside", join(scratch, "unrelated.txt"), `${saved.evidence.path}\u0000`, saved.path]) await check(`report refuses arbitrary evidence ${JSON.stringify(path)}`, async () => {
    const args = reportArgs({ evidence: path }); refused(await rpc(args), 200); assert(!existsSync(args.out));
  });
  await check("report output refuses final-directory, asset-directory and file symlinks", async () => {
    for (const kind of ["folder", "assets", "file"]) {
      const out = join(scratch, `linked-report-${kind}`), target = join(scratch, `target-${kind}`);
      sentinel(join(target, "keep.txt"));
      if (kind === "folder") symlinkSync(target, out);
      else { mkdirSync(out); symlinkSync(kind === "assets" ? target : join(target, "keep.txt"), join(out, kind === "assets" ? "evidence" : "index.html")); }
      refused(await rpc(reportArgs({}, out)), 200);
    }
  });
  await check("corrupt receipt is refused by report and picture consumers", async () => {
    const original = readFileSync(saved.evidence.path);
    try {
      writeFileSync(saved.evidence.path, Buffer.concat([original, Buffer.from(" ")]));
      const args = reportArgs({}); refused(await rpc(args), 200); assert(!existsSync(args.out));
      refused(await request(`/agents/picture?id=${mission}&picture=${picture}`), 410);
    } finally { writeFileSync(saved.evidence.path, original); }
  });
  await check("corrupt retained image is refused by report and picture consumers", async () => {
    const manifest = JSON.parse(readFileSync(saved.evidence.path, "utf8")), path = String(manifest.image.path), original = readFileSync(path);
    try {
      writeFileSync(path, "synthetic corruption");
      const args = reportArgs({}); refused(await rpc(args), 200); assert(!existsSync(args.out));
      refused(await request(`/agents/picture?id=${mission}&picture=${picture}`), 410);
    } finally { writeFileSync(path, original); }
  });
  await check("rehashed receipt cannot redirect evidence reads to unrelated synthetic file", async () => {
    const manifest = JSON.parse(readFileSync(saved.evidence.path, "utf8"));
    manifest.image.path = join(scratch, "unrelated.txt");
    const document = JSON.stringify(manifest), forged = join(dirname(saved.evidence.path), `capture-${hash(document)}.json`);
    writeFileSync(forged, document);
    const args = reportArgs({ evidence: forged }); refused(await rpc(args), 200); assert(!existsSync(args.out));
  });
  await check("positive controls still succeed after malformed and corrupt requests", async () => {
    const args = reportArgs({ comparison: { visual: 11, data: 10, tolerance: 1, unit: "USD", mismatch: true } });
    const response = await rpc(args); assert.equal(object(response.value).ok, true); assert.equal(object(object(response.value).value).mismatches, 0);
    assert.equal((await control({ action: "resume" })).status, 200);
    assert.equal((await request("/health")).status, 200);
  });
  await stop(daemon); await Promise.all(logs);
} catch (error) {
  results.push({ name: "scenario setup/execution", pass: false, error: error instanceof Error ? error.stack : String(error) });
  console.error(error);
} finally {
  for (const child of children.toReversed()) await stop(child);
  for (const server of listeners) server.stop(true);
  try { intact(); rmSync(scratch, { recursive: true, force: true }); cleanup = !existsSync(scratch) && children.every((child) => exitedChildren.has(child)); }
  catch (error) { results.push({ name: "cleanup and unrelated-file preservation", pass: false, error: String(error) }); }
  const failed = results.filter((result) => !result.pass);
  console.log(JSON.stringify({ scenario: "limits", candidate, passed: results.length - failed.length, failed: failed.length, requests, concurrentReadBurst: 0, payloadLimitBytes: 1048576, cleanup, stoppedChildren: exitedChildren.size, findings: failed, checks: results }, null, 2));
  if (failed.length || !cleanup) process.exitCode = 1;
}
