import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeHash } from "../daemon/codehash.ts";

// `safari routine run` starts omp, and omp starts the safari MCP server for
// the model's calls. Here omp is a stand-in in the scratch home: it runs the
// MCP server as omp does, makes the calls its prompt lists, then prints the
// summary a model would end with. The daemon is a fake that answers every
// call but one at tab 99.
const REPO = realpathSync(join(import.meta.dir, ".."));
const TYPED = "typed-in-words-7731";
const daemon = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, code: codeHash(REPO), root: REPO });
    const { args }: { args: { tab?: number } } = await req.json();
    return args.tab === 99 ? Response.json({ ok: false, error: "no tab 99" }) : Response.json({ ok: true, value: { ok: true } });
  },
});
afterAll(() => daemon.stop(true));

const home = mkdtempSync(join(tmpdir(), "routine-cli-"));
const routines = join(home, ".local", "share", "safari-harness", "routines");
mkdirSync(routines, { recursive: true });
mkdirSync(join(home, ".bun", "bin"), { recursive: true });
writeFileSync(join(home, "omp.ts"), `
const prompt = Bun.argv.at(-1)!.slice(1);
const calls: { name: string; arguments: Record<string, unknown> }[] = JSON.parse(await Bun.file(prompt).text());
const mcp = Bun.spawn([process.execPath, ${JSON.stringify(join(REPO, "daemon", "mcp.ts"))}], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const lines = mcp.stdout.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";
for (const [i, params] of calls.entries()) {
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params }) + "\\n");
  mcp.stdin.flush();
  while (!buf.includes("\\n")) buf += (await lines.read()).value;
  buf = buf.slice(buf.indexOf("\\n") + 1);
}
mcp.stdin.end();
await mcp.exited;
console.log("Summary: the model's closing words.");
`);
writeFileSync(join(home, ".bun", "bin", "omp"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(home, "omp.ts"))} "$@"\n`);
chmodSync(join(home, ".bun", "bin", "omp"), 0o755);

async function run(name: string, calls: unknown[]): Promise<string[]> {
  writeFileSync(join(routines, `${name}.md`), JSON.stringify(calls));
  writeFileSync(join(routines, `${name}.json`), JSON.stringify({ name, schedule: { every: 60 }, created: "2026-09-30" }));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "safari.ts"), "routine", "run", name], {
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${daemon.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(0);
  const log = /log: (.+)$/m.exec(out)?.[1];
  return readFileSync(String(log), "utf8").trimEnd().split("\n");
}

test("a routine's log has a line for each tool call, with its status and time, before the summary, and no typed secret", async () => {
  const lines = await run("calls", [
    { name: "type", arguments: { tab: 1, ref: "Password", text: TYPED } },
    { name: "goto", arguments: { tab: 99, url: "https://portal.example/signin?code=482913&next=home" } },
  ]);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/ type .*tab=1 .*ok \d+ ms$/);
  expect(lines[1]).toMatch(/ goto .*tab=99 .*portal\.example.*error \d+ ms$/);
  expect(lines[2]).toBe("Summary: the model's closing words.");
  expect(lines.join("\n")).not.toContain(TYPED);
  expect(lines.join("\n")).not.toContain("482913");
});

test("a routine that makes more calls than the log keeps logs the first ones, says the rest were not, and still ends with its summary", async () => {
  const lines = await run("loop", Array.from({ length: 450 }, () => ({ name: "tabs", arguments: {} })));
  expect(lines.filter((l) => / tabs .*ok \d+ ms$/.test(l)).length).toBeLessThan(450);
  expect(lines).toHaveLength(lines.filter((l) => / tabs /.test(l)).length + 2);
  expect(lines.at(-1)).toBe("Summary: the model's closing words.");
});

// A script routine runs a saved repl script with no model.
async function runScript(name: string, code: string, schedule: unknown, flags: string[]): Promise<{ code: number; out: string }> {
  writeFileSync(join(routines, `${name}.js`), code);
  writeFileSync(join(routines, `${name}.json`), JSON.stringify({ name, schedule, created: "2026-10-07" }));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "safari.ts"), "routine", "run", name, ...flags], {
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${daemon.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, exit] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code: exit, out };
}

test("a script routine's practice run (--dry) runs the script with DRY true", async () => {
  const { code, out } = await runScript("practice", `console.log("dry:", DRY)`, { everyMinutes: 60 }, ["--dry"]);
  expect(code).toBe(0);
  const log = /log: (.+)$/m.exec(out)?.[1];
  expect(readFileSync(String(log), "utf8").trim()).toBe("dry: true");
});

test("a routine set for one day that launchd starts on another day runs nothing", async () => {
  const { code, out } = await runScript("missed", `console.log("ran")`, { at: { hour: 6, minute: 36 }, on: { year: 2020, month: 1, day: 1 } }, ["--scheduled"]);
  expect(code).toBe(1);
  expect(out).toContain("missed did not run");
  expect(existsSync(join(home, "Library", "Logs", "safari-harness", "routines", "missed.last"))).toBe(false);
});
