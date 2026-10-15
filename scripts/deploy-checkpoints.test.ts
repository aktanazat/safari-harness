import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let data: string;
let legacy: string;
let current: string;
const base = "http://127.0.0.1:47334";
const files = ["tabs-47334.json", "spaces-47334.json"];
const original = [JSON.stringify({ 41: { owner: 101, used: 500, held: true }, 42: { owner: 202, used: 600 } }), JSON.stringify({ spaces: [{ key: "101:", id: "owned", name: "owned window", window: 71, owner: 101, group: "plain" }], closing: [], ended: [] })];
const newer = [JSON.stringify({ version: 2, tabs: { 41: { owner: 101, used: 700, acted: true, handoff: true, unsafe: true }, 42: { owner: 202, used: 600, site: true } }, closed: { 43: { agent: 101, at: 800, why: "admitted", url: "https://example.test/result" } }, keepers: { 44: 202 } }), JSON.stringify({ version: 2, spaces: [{ key: "101:", id: "owned", name: "owned window", window: 71, owner: 101, group: "plain", done: true }], closing: [], ended: [] })];
const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "deploy-checkpoints.ts"), ...args.slice(0, 1), data, base, ...args.slice(1)], { stdout: "pipe", stderr: "pipe" });
function takeSnapshot(release = legacy): string {
  const result = invoke("snapshot", release);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safari-checkpoint-rollback-"));
  data = join(root, "data"); legacy = join(root, "legacy"); current = join(root, "current");
  for (const path of [data, legacy, current]) mkdirSync(path);
  writeFileSync(join(legacy, "package.json"), JSON.stringify({ name: "legacy" }));
  writeFileSync(join(current, "package.json"), JSON.stringify({ safariHarnessCheckpointFormat: 2 }));
  for (const [index, name] of files.entries()) { writeFileSync(join(data, name), original[index]); chmodSync(join(data, name), 0o600); }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the actual installer guard permits an upgrade without rewriting either checkpoint", () => {
  expect(invoke("check", legacy, current).exitCode).toBe(0);
  expect(files.map(name => readFileSync(join(data, name), "utf8"))).toEqual(original);
});

test.each(["before-first-write", "version-2-written"])("manual legacy rollback is refused %s without touching ownership", mode => {
  if (mode === "version-2-written") for (const [index, name] of files.entries()) writeFileSync(join(data, name), newer[index]);
  const before = files.map(name => readFileSync(join(data, name), "utf8"));
  const result = invoke("check", current, legacy);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("manual rollback across checkpoint formats is blocked");
  expect(files.map(name => readFileSync(join(data, name), "utf8"))).toEqual(before);
});

test("failed-start recovery restores the exact unchanged snapshot before a legacy reader can run", () => {
  const saved = takeSnapshot();
  expect(statSync(saved).mode & 0o777).toBe(0o700);
  const result = invoke("restore", saved, legacy, current);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("restored before legacy fallback");
  expect(files.map(name => readFileSync(join(data, name), "utf8"))).toEqual(original);
  expect(files.map(name => statSync(join(data, name)).mode & 0o777)).toEqual([0o600, 0o600]);
  expect(files.map(name => readFileSync(join(saved, name), "utf8"))).toEqual(original);
  expect(invoke("discard", saved).exitCode).toBe(0);
  expect(existsSync(saved)).toBe(false);
});

test("a failed startup cannot erase newly persisted dirty, foreign, held or resume metadata", () => {
  const saved = takeSnapshot();
  for (const [index, name] of files.entries()) writeFileSync(join(data, name), newer[index]);
  const result = invoke("restore", saved, legacy, current);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("checkpoints changed since admission");
  expect(files.map(name => readFileSync(join(data, name), "utf8"))).toEqual(newer);
  expect(files.map(name => readFileSync(join(saved, name), "utf8"))).toEqual(original);
});

test("a compatible fallback keeps all newer checkpoint bytes rather than restoring stale state", () => {
  for (const [index, name] of files.entries()) writeFileSync(join(data, name), newer[index]);
  const saved = takeSnapshot(current);
  const changed = newer.map(text => text.replace("owned window", "retained user window"));
  for (const [index, name] of files.entries()) writeFileSync(join(data, name), changed[index]);
  const result = invoke("restore", saved, current, current);
  expect(result.exitCode).toBe(0);
  expect(files.map(name => readFileSync(join(data, name), "utf8"))).toEqual(changed);
});

test("a checkpoint first created during startup blocks a legacy fallback", () => {
  for (const name of files) rmSync(join(data, name));
  const saved = takeSnapshot();
  expect(invoke("restore", saved, legacy, current).exitCode).toBe(0);
  expect(files.map(name => existsSync(join(data, name)))).toEqual([false, false]);
  writeFileSync(join(data, files[0]), newer[0]);
  expect(invoke("restore", saved, legacy, current).exitCode).toBe(1);
  expect(readFileSync(join(data, files[0]), "utf8")).toBe(newer[0]);
});

test("a damaged rollback backup fails without replacing a current checkpoint", () => {
  const saved = takeSnapshot();
  writeFileSync(join(saved, files[0]), "{}");
  expect(invoke("restore", saved, legacy, current).exitCode).toBe(1);
  expect(files.map(name => readFileSync(join(data, name), "utf8"))).toEqual(original);
});

test("malformed current state blocks release without echoing page data", () => {
  const broken = "private-page-data:not-json";
  writeFileSync(join(data, files[0]), broken);
  const result = invoke("check", legacy, current);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).not.toContain(broken);
  expect(readFileSync(join(data, files[0]), "utf8")).toBe(broken);
});
