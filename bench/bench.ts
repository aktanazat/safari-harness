// Rows for the WebKit bench (scripts/bench.swift), which runs the extension's
// page scripts in a web view no window shows. A row names a contract, the
// page in bench/fixtures it shows on, and the requests background.js would
// send, each with the answer it must get. Each row gets a fresh web view.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export type Step = {
  op: string;
  args?: unknown[];
  // a page in bench/fixtures that an embedded frame shows: the op goes to
  // that frame's copy of content.js
  frame?: string;
  // ms before the bench gives up on the answer (default 5000)
  timeout?: number;
  // what the answer must hold, as toMatchObject reads it; a step without one
  // must answer with a value
  answer?: unknown;
};

export type Row = {
  name: string;
  page: string;
  // embedded frames running their own copy, all reported in before the steps
  frames?: number;
  steps: Step[];
};

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "scripts", "bench.swift");
const CACHE = join(ROOT, ".build");

// Why the runner cannot be built on this Mac, or null. xcrun is asked only
// once a developer directory exists: with none, it offers to install the
// tools in a window.
function unbuildable(): string | null {
  const dir = Bun.which("xcode-select") ? Bun.spawnSync(["xcode-select", "-p"], { stderr: "ignore" }).stdout.toString().trim() : "";
  if (!dir || !existsSync(dir)) return "Apple's command line tools are not installed (xcode-select --install)";
  if (Bun.spawnSync(["xcrun", "--find", "swiftc"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) return `the developer tools at ${dir} have no Swift compiler`;
  return null;
}

// The runner, built once for each version of its source. A source that does
// not compile fails the run: that is the bench broken, not the Mac.
function build(): string {
  const name = `bench-${createHash("sha256").update(readFileSync(SOURCE)).digest("hex").slice(0, 16)}`;
  const path = join(CACHE, name);
  if (existsSync(path)) return path;
  mkdirSync(CACHE, { recursive: true });
  const partial = `${path}.${process.pid}`;
  const swiftc = Bun.spawnSync(["xcrun", "swiftc", "-O", SOURCE, "-o", partial], { stdout: "ignore", stderr: "pipe" });
  if (swiftc.exitCode !== 0) throw new Error(`scripts/bench.swift did not compile:\n${swiftc.stderr.toString()}`);
  for (const old of readdirSync(CACHE)) if (/^bench-[0-9a-f]{16}$/.test(old)) rmSync(join(CACHE, old));
  renameSync(partial, path);
  return path;
}

const skip = unbuildable();
// The test reporter names no skipped test, so the reason is printed once.
if (skip !== null) console.warn(`the WebKit bench is skipped: ${skip}`);
const runner = skip === null ? build() : "";
const page = (name: string) => pathToFileURL(join(import.meta.dir, "fixtures", name)).href;

// The answers in order: the load's, then one per step. Frame tokens are
// random, so each prints as its frame's page in angle brackets.
async function answers(row: Row): Promise<unknown[]> {
  const requests = [
    { load: page(row.page), frames: row.frames ?? 0 },
    ...row.steps.map((s) => ({ op: s.op, args: s.args, frame: s.frame && page(s.frame), timeout: s.timeout })),
  ];
  const proc = Bun.spawn([runner, join(ROOT, "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(requests.map((r) => JSON.stringify(r) + "\n").join(""));
  proc.stdin.end();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`the bench exited ${code}: ${err.trim()}`);
  const [first, ...rest] = out.trim().split("\n");
  const loaded = JSON.parse(first) as { frames?: { url: string; token: string }[] };
  return [loaded, ...rest.map((l) => {
    let named = l;
    for (const f of loaded.frames ?? []) named = named.replaceAll(f.token, `<${basename(f.url)}>`);
    return JSON.parse(named) as unknown;
  })];
}

// One test per row, under title, all skipped on a Mac that cannot build the
// runner.
export function benchRows(title: string, rows: Row[]): void {
  describe.skipIf(skip !== null)(title, () => {
    test.each(rows.map((r) => [r.name, r] as const))("%s", async (_name, row) => {
      expect(await answers(row)).toMatchObject([
        { url: page(row.page) },
        ...row.steps.map((s) => s.answer ?? { value: expect.anything() }),
      ]);
    }, 20_000);
  });
}
