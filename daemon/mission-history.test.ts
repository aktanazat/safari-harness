import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { saveCapture, verifyEvidence, type CaptureResult } from "./evidence.ts";
import { captureSummaries, MissionHistory } from "./mission-history.ts";
import { captureFixture } from "./fake-safari.ts";

const directories: string[] = [];
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), "mission-history-"));
  directories.push(path);
  return path;
};
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const now = Date.UTC(2026, 9, 21);
const mission = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), owner: 120, process: "bun", since: now, active: now, raised: 1, status: "working", calls: [], ...extra });
const summary = { sha256: "a".repeat(64), capturedAt: new Date(now).toISOString(), width: 1, height: 1, masked: 1, url: "https://example.com" };
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const capture = (out: string) => saveCapture({ data: PIXEL, source: { url: "https://example.com/?token=not-in-history", title: "Private title", capturedAt: new Date(now).toISOString(), width: 1, height: 1, viewport: { width: 1, height: 1, devicePixelRatio: 1 }, privacy: { masked: 1 } } }, out);

function picture(id: string, saved: CaptureResult) {
  return { id, receipt: saved.evidence.path, bytes: Buffer.from(PIXEL, "base64").byteLength, capture: captureSummaries(saved)[0] };
}

test("a fresh process reads durable calls as read-only interrupted history, never as live controls", async () => {
  const path = join(folder(), "history.json");
  const history = new MissionHistory(path, () => now);
  const entry = mission({ spaces: [randomUUID()], pictures: true, calls: [{ t: now, tool: "click", tab: 4, outcome: "running" }] });
  history.save(entry);
  const script = `import { MissionHistory } from ${JSON.stringify(new URL("./mission-history.ts", import.meta.url).href)}; console.log(JSON.stringify(new MissionHistory(${JSON.stringify(path)}, () => ${now}).list()));`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(text)).toEqual([expect.objectContaining({ id: entry.id, controls: false, status: "ended", interrupted: true, calls: [expect.objectContaining({ tool: "click", outcome: "interrupted" })] })]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
});

test.each([false, true])("restart restores inspection-only restrictions only for interrupted work, ended=%s", async (ended) => {
  const path = join(folder(), "history.json");
  const missionUrl = new URL("./mission.ts", import.meta.url).href;
  const historyUrl = new URL("./mission-history.ts", import.meta.url).href;
  const script = `
    import { randomUUID } from "node:crypto";
    import { MissionHistory } from ${JSON.stringify(historyUrl)};
    import { openMissionHistory, watched } from ${JSON.stringify(missionUrl)};
    const now = Date.now();
    const history = new MissionHistory(${JSON.stringify(path)});
    history.save({id:randomUUID(),owner:process.pid,process:"bun",since:now,active:now,raised:0,status:${JSON.stringify(ended ? "ended" : "working")},${ended ? "ended:now," : ""}inspectionOnly:true,calls:[]});
    openMissionHistory(${JSON.stringify(path)});
    let dispatched = 0;
    let code = null;
    try { await watched(process.pid, "eval", {}, async () => { dispatched++; }); }
    catch (error) { code = error.code; }
    console.log(JSON.stringify({dispatched,code}));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(text)).toEqual(ended ? { dispatched: 1, code: null } : { dispatched: 0, code: "blocked" });
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
});

test("durable history defaults to structural fields and drops typed values, page text, query tokens, titles, paths, and capabilities", () => {
  const path = join(folder(), "history.json");
  const history = new MissionHistory(path, () => now);
  const address = new URL("https://example.com/private/secret?token=query-secret#fragment");
  address.username = "fixture-user";
  address.password = "fixture-password";
  history.save(mission({ process: "secret-process-name", secret: "page-control-token", calls: [{
    t: now, tool: "type", tab: 7, args: "text=typed-password", text: "typed-password", error: "body-secret", outcome: "failed", code: "invalid_argument",
    evidence: [{ ...summary, url: address.href, title: "page-title-secret", path: "/private/screenshot-secret.png" }],
    screenshot: PIXEL,
  }, { t: now + 1, tool: "tool-name-secret", args: "another secret", outcome: "done" }] }));
  const saved = readFileSync(path, "utf8");
  for (const value of ["typed-password", "body-secret", "query-secret", "page-title-secret", "screenshot-secret", "page-control-token", "fixture-user", "fixture-password", "tool-name-secret", "secret-process-name", PIXEL]) expect(saved).not.toContain(value);
  const shown = history.list()[0];
  expect(shown.process).toBeNull();
  expect(shown.calls[0]).toMatchObject({ tool: "type", args: "tab=7", code: "invalid_argument", evidence: [{ ...summary, url: "https://example.com" }] });
  expect(shown.calls[1].tool).toBe("unknown");
});

test("capture summaries come only from actual evidence results and never collect screenshot bytes or page text", () => {
  const evidence = { ...summary, privacy: { masked: 2 }, title: "not retained", path: "/private/raw.png", url: "https://example.com/path?token=not-retained" };
  expect(captureSummaries({ snapshot: "page text", data: PIXEL, sha256: summary.sha256 })).toEqual([]);
  expect(captureSummaries({ steps: [{ value: { evidence, data: PIXEL } }, { value: { evidence } }] })).toEqual([{ ...summary, masked: 2, url: "https://example.com" }]);
  expect(captureSummaries({ files: [{ evidence }], pages: [{ evidence }] })).toEqual([{ ...summary, masked: 2, url: "https://example.com" }]);
});

test("history has fixed session, call, byte and age bounds", () => {
  let time = now;
  const path = join(folder(), "history.json");
  const history = new MissionHistory(path, () => time);
  for (let i = 0; i < 105; i++) history.save(mission({ active: now + i, calls: Array.from({ length: 205 }, (_, j) => ({ t: now + j, tool: "click", tab: j + 1, outcome: "done" })) }));
  expect(history.list()).toHaveLength(100);
  expect(history.list().every((m) => m.calls.length === 200)).toBe(true);
  for (let i = 0; i < 3; i++) history.save(mission({ active: now + 200 + i, calls: Array.from({ length: 200 }, (_, j) => ({ t: now + j, tool: "shot", outcome: "done", evidence: Array.from({ length: 16 }, () => summary) })) }));
  expect(statSync(path).size).toBeLessThanOrEqual(2 * 1024 * 1024);
  time += 31 * 24 * 60 * 60_000;
  expect(history.list()).toEqual([]);
  expect(JSON.parse(readFileSync(path, "utf8")).missions).toEqual([]);
});

test("retained action pictures survive a fresh store while arbitrary local paths and picture traversal are refused", async () => {
  const path = join(folder(), "history.json");
  const history = new MissionHistory(path, () => now);
  const entry = mission();
  const id = randomUUID();
  const saved = await capture(history.pictureOutput(entry.id, id));
  history.save({ ...entry, calls: [{ t: now, tool: "click", outcome: "done", picture: picture(id, saved) }, { t: now + 1, tool: "click", outcome: "done", picture: { ...picture(randomUUID(), saved), receipt: "/etc/passwd" } }] });
  const restored = new MissionHistory(path, () => now);
  const calls = restored.list()[0].calls;
  expect(calls[0].picture).toMatchObject({ id, capture: { ...summary, sha256: saved.evidence.sha256 } });
  expect(calls[1].picture).toBeUndefined();
  expect(() => history.pictureOutput("../outside", id)).toThrow();
  expect(() => history.pictureOutput(entry.id, "../outside")).toThrow();
  await restored.cleanup();
  const kept = calls[0].picture;
  if (!kept || !("receipt" in kept)) throw new Error("retained picture missing");
  expect((await verifyEvidence(kept.receipt)).image).toEqual(Buffer.from(PIXEL, "base64"));
});

test("picture count retention removes only expired generated capture bundles and leaves explicit gaps", async () => {
  const path = join(folder(), "history.json");
  const history = new MissionHistory(path, () => now);
  const entry = mission();
  const calls = [];
  let expired: CaptureResult | undefined;
  for (let i = 0; i < 101; i++) {
    const id = randomUUID();
    const saved = await capture(history.pictureOutput(entry.id, id));
    expired ??= saved;
    calls.push({ t: now + i, tool: "click", outcome: "done", picture: picture(id, saved) });
  }
  history.save({ ...entry, calls });
  expect(history.list()[0].calls[0].picture).toMatchObject({ missing: "picture expired" });
  expect(history.list()[0].calls.filter((c) => c.picture && "receipt" in c.picture)).toHaveLength(100);
  const unrelated = join(dirname(history.pictureOutput(entry.id, randomUUID())), "unrelated.txt");
  writeFileSync(unrelated, "keep this");
  await history.cleanup();
  if (!expired) throw new Error("expired picture fixture missing");
  expect(existsSync(expired.evidence.path)).toBe(false);
  expect(readFileSync(unrelated, "utf8")).toBe("keep this");
  const kept = history.list()[0].calls.at(-1)?.picture;
  if (!kept || !("receipt" in kept)) throw new Error("newest picture missing");
  expect((await verifyEvidence(kept.receipt)).image.byteLength).toBe(Buffer.from(PIXEL, "base64").byteLength);
});

test("age retention deletes generated images and restart cleanup removes an orphaned generated picture", async () => {
  let time = now;
  const path = join(folder(), "history.json");
  const history = new MissionHistory(path, () => time);
  const entry = mission();
  const id = randomUUID();
  const saved = await capture(history.pictureOutput(entry.id, id));
  const orphan = await capture(history.pictureOutput(entry.id, randomUUID()));
  history.save({ ...entry, calls: [{ t: now, tool: "click", outcome: "done", picture: picture(id, saved) }] });
  const restarted = new MissionHistory(path, () => time);
  await restarted.cleanup();
  expect(existsSync(orphan.evidence.path)).toBe(false);
  expect(existsSync(saved.evidence.path)).toBe(true);
  time += 31 * 24 * 60 * 60_000;
  expect(restarted.list()).toEqual([]);
  await restarted.cleanup();
  expect(existsSync(saved.evidence.path)).toBe(false);
});

test("retained PNG storage stays within its byte budget after cleanup and restart", async () => {
  const path = join(folder(), "history.json");
  const history = new MissionHistory(path, () => now);
  const entry = mission();
  const fixture = captureFixture("https://example.com/public-image", 1536, 1536);
  const original = Buffer.from(fixture.data, "base64");
  const headerBytes = 8 + 12 + 13;
  const packedLength = original.readUInt32BE(headerBytes);
  const packed = deflateSync(inflateSync(original.subarray(headerBytes + 8, headerBytes + 8 + packedLength)), { level: 0 });
  const block = Buffer.alloc(packed.length + 12);
  block.writeUInt32BE(packed.length);
  block.write("IDAT", 4, "ascii");
  packed.copy(block, 8);
  block.writeUInt32BE(crc32(block.subarray(4, block.length - 4)), block.length - 4);
  const image = Buffer.concat([original.subarray(0, headerBytes), block, original.subarray(headerBytes + packedLength + 12)]);
  const data = image.toString("base64");
  const calls = [];
  const paths = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const id = randomUUID();
    const saved = await saveCapture({ ...fixture, data }, history.pictureOutput(entry.id, id));
    const verified = await verifyEvidence(saved.evidence.path);
    paths.add(saved.path);
    paths.add(verified.path);
    calls.push({ t: now + i, tool: "click", outcome: "done", picture: { ...picture(id, saved), bytes: image.byteLength } });
  }
  history.save({ ...entry, calls });
  const restarted = new MissionHistory(path, () => now);
  await restarted.cleanup();
  const storedBytes = [...paths].reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0);
  expect(storedBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  const retained = restarted.list()[0].calls;
  expect(retained[0].picture).toMatchObject({ missing: "picture expired" });
  const newest = retained.at(-1)?.picture;
  if (!newest || !("receipt" in newest)) throw new Error("newest picture missing");
  expect((await verifyEvidence(newest.receipt)).image.equals(image)).toBe(true);
});
