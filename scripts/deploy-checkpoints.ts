// The installer owns the sole daemon while restoring. These short-lived
// byte snapshots are rollback backups, never a task-completion authority.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type Format = 1 | 2;
type Entry = { name: string; present: boolean; mode: number; digest: string };
type Snapshot = { version: 1; data: string; port: number; format: Format; files: Entry[] };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function json(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`cannot read valid JSON from ${basename(path)}; checkpoint left intact`); }
}
function releaseFormat(release: string, kind: "checkpoint" | "browser memory" = "checkpoint"): Format {
  const value = json(join(release, "package.json"));
  if (!object(value)) throw new Error("invalid release package metadata");
  const format = value[kind === "checkpoint" ? "safariHarnessCheckpointFormat" : "safariHarnessBrowserMemoryFormat"] ?? 1;
  if (format !== 1 && format !== 2) throw new Error(`unsupported release ${kind} format`);
  return format;
}
function memoryCompatible(source: string, target: string): void {
  if (releaseFormat(target, "browser memory") < releaseFormat(source, "browser memory")) throw new Error("browser memory requires a newer reader; rollback is blocked");
}
function names(port: number): string[] { return [`tabs-${port}.json`, `spaces-${port}.json`]; }
function entry(data: string, name: string): Entry {
  const path = join(data, name);
  if (!existsSync(path)) return { name, present: false, mode: 0, digest: "" };
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error(`${name} is not a regular checkpoint file`);
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`${name} changed while being read; retry only in a quiet handoff`);
  return { name, present: true, mode: after.mode & 0o777, digest: createHash("sha256").update(bytes).digest("hex") };
}
function compatible(data: string, port: number, format: Format): void {
  for (const name of names(port)) {
    if (!entry(data, name).present) continue;
    const value = json(join(data, name));
    if (!object(value)) throw new Error(`${name} is not a checkpoint object`);
    const version = value.version ?? 1;
    if ((version !== 1 && version !== 2) || version > format) throw new Error(`${name} requires a newer reader; legacy rollback is blocked`);
    if (name.startsWith("tabs-") && version === 2 && !object(value.tabs)) throw new Error(`${name} has no version-2 tab records`);
    if (name.startsWith("tabs-") && version === 1 && Object.keys(value).some(key => !/^[1-9]\d*$/.test(key))) throw new Error(`${name} is not a legacy tab map`);
  }
}
function same(a: Entry, b: Entry): boolean { return a.name === b.name && a.present === b.present && a.mode === b.mode && a.digest === b.digest; }
function loadSnapshot(path: string, data: string, port: number): Snapshot {
  if (dirname(resolve(path)) !== resolve(data) || !basename(path).startsWith(".checkpoint-rollback-")) throw new Error("rollback snapshot is outside its data directory");
  const value = json(join(path, "snapshot.json"));
  if (!object(value) || value.version !== 1 || value.data !== resolve(data) || value.port !== port || (value.format !== 1 && value.format !== 2) || !Array.isArray(value.files) || value.files.length !== 2) throw new Error("invalid rollback snapshot");
  const files: Entry[] = [];
  for (const [index, row] of value.files.entries()) {
    if (!object(row) || row.name !== names(port)[index] || typeof row.present !== "boolean" || typeof row.mode !== "number" || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777 || typeof row.digest !== "string" || (row.present ? !/^[a-f0-9]{64}$/.test(row.digest) : row.digest !== "")) throw new Error("invalid rollback snapshot entry");
    files.push({ name: String(row.name), present: row.present, mode: row.mode, digest: row.digest });
  }
  for (const row of files) {
    const kept = entry(path, row.name);
    if (row.present !== kept.present || row.digest !== kept.digest) throw new Error(`rollback backup ${row.name} changed; nothing restored`);
  }
  return { version: 1, data: resolve(data), port, format: value.format, files };
}
function snapshot(data: string, port: number, release: string): string {
  const format = releaseFormat(release);
  compatible(data, port, format);
  mkdirSync(data, { recursive: true });
  const directory = mkdtempSync(join(data, ".checkpoint-rollback-"));
  chmodSync(directory, 0o700);
  const files = names(port).map(name => entry(data, name));
  for (const row of files) if (row.present) {
    copyFileSync(join(data, row.name), join(directory, row.name));
    chmodSync(join(directory, row.name), 0o600);
  }
  if (files.some(row => !same(row, entry(data, row.name)) || (row.present && createHash("sha256").update(readFileSync(join(directory, row.name))).digest("hex") !== row.digest))) throw new Error(`checkpoints changed during backup; retained ${directory}, no release switch allowed`);
  writeFileSync(join(directory, "snapshot.json"), JSON.stringify({ version: 1, data: resolve(data), port, format, files } satisfies Snapshot), { mode: 0o600 });
  return directory;
}
function restore(path: string, data: string, port: number, target: string, current: string): void {
  memoryCompatible(current, target);
  const saved = loadSnapshot(path, data, port);
  const format = releaseFormat(target);
  if (format >= releaseFormat(current)) {
    compatible(data, port, format);
    console.log("compatible fallback retains current checkpoint bytes");
    return;
  }
  if (saved.format > format) throw new Error("the original snapshot also needs a newer reader; fallback is blocked");
  // Never replace newer ownership, dirty flags, foreign/kept pages or a new
  // file with an older snapshot, even if startup itself was unsuccessful.
  if (saved.files.some(row => !same(row, entry(data, row.name)))) throw new Error(`checkpoints changed since admission; legacy fallback blocked, backup retained at ${path}`);
  compatible(path, port, format);
  const staged = mkdtempSync(join(data, ".checkpoint-restore-"));
  try {
    for (const row of saved.files) if (row.present) {
      copyFileSync(join(path, row.name), join(staged, row.name));
      chmodSync(join(staged, row.name), row.mode);
      if (entry(staged, row.name).digest !== row.digest) throw new Error(`rollback backup ${row.name} changed during restore; nothing restored`);
    }
    if (saved.files.some(row => !same(row, entry(data, row.name)))) throw new Error("checkpoints changed during restore preparation; nothing restored");
    for (const row of saved.files) if (row.present) renameSync(join(staged, row.name), join(data, row.name));
  } finally {
    for (const name of names(port)) if (existsSync(join(staged, name))) unlinkSync(join(staged, name));
    rmdirSync(staged);
  }
  console.log("unchanged pre-start checkpoint restored before legacy fallback");
}
function discard(path: string, data: string, port: number): void {
  const saved = loadSnapshot(path, data, port);
  for (const row of saved.files) if (row.present) unlinkSync(join(path, row.name));
  unlinkSync(join(path, "snapshot.json"));
  rmdirSync(path);
}

try {
  const [action, data, base, ...args] = process.argv.slice(2);
  if (!data || !base) throw new Error("usage: deploy-checkpoints.ts check|snapshot|restore|discard DATA HTTP_BASE ...");
  const url = new URL(base);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (action === "check" && args.length === 2) {
    memoryCompatible(args[0], args[1]);
    const source = releaseFormat(args[0]);
    const target = releaseFormat(args[1]);
    if (target < source) throw new Error("manual rollback across checkpoint formats is blocked; no release or checkpoint changed");
    compatible(data, port, target);
  } else if (action === "snapshot" && args.length === 1) console.log(snapshot(data, port, args[0]));
  else if (action === "restore" && args.length === 3) restore(args[0], data, port, args[1], args[2]);
  else if (action === "discard" && args.length === 1) discard(args[0], data, port);
  else throw new Error("invalid checkpoint transaction arguments");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
