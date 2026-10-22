import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeHash } from "../daemon/codehash.ts";
import { watchOwner } from "../daemon/owner.ts";

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
const input: unknown = JSON.parse(await Bun.file(prompt).text());
if (!Array.isArray(input)) {
  const gate = input as { gate: string };
  await fetch(gate.gate, { headers: { "x-worker-pid": String(process.pid) } });
  console.log("The scheduled task finished.");
  process.exit(0);
}
const calls = input as { name: string; arguments: Record<string, unknown> }[];
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
writeFileSync(join(home, ".bun", "bin", "launchctl"), "#!/bin/sh\ncase \"$1\" in print) exit 1;; *) exit 0;; esac\n");
chmodSync(join(home, ".bun", "bin", "launchctl"), 0o755);
afterAll(() => rmSync(home, { recursive: true, force: true }));

function startCommand(args: string[]) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "safari.ts"), ...args], {
    env: {
      ...process.env, HOME: home,
      PATH: `${join(home, ".bun", "bin")}:${process.env.PATH ?? ""}`,
      SAFARI_HARNESS_HTTP: `http://127.0.0.1:${daemon.port}`,
    },
    stdout: "pipe", stderr: "pipe",
  });
}

async function command(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = startCommand(args);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

function routineMeta(name: string): { generation: string; paused?: boolean; pauseReason?: string } {
  return JSON.parse(readFileSync(join(routines, `${name}.json`), "utf8"));
}

function outputLog(out: string): string {
  const path = /log: (.+)$/m.exec(out)?.[1];
  if (!path) throw new Error(`routine returned no log: ${out}`);
  return readFileSync(path, "utf8");
}

async function addScript(name: string): Promise<string> {
  const path = join(home, `${name}.js`);
  writeFileSync(path, `console.log("script ran:", DRY)`);
  const added = await command(["routine", "add", name, "--every", "60", "--script", path]);
  expect(added.code).toBe(0);
  return path;
}

async function run(name: string, calls: unknown[]): Promise<string[]> {
  writeFileSync(join(routines, `${name}.md`), JSON.stringify(calls));
  writeFileSync(join(routines, `${name}.json`), JSON.stringify({ name, schedule: { everyMinutes: 60 }, created: "2026-09-30" }));
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
async function runScript(name: string, code: string, schedule: unknown, flags: string[]): Promise<{ code: number; out: string; err: string }> {
  writeFileSync(join(routines, `${name}.js`), code);
  writeFileSync(join(routines, `${name}.json`), JSON.stringify({ name, schedule, created: "2026-10-07" }));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "safari.ts"), "routine", "run", name, ...flags], {
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${daemon.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code: exit, out, err };
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

// Under -q a failed run printed nothing at all, its failure with the rest
// (Tools.md, 10-16): its one line on stderr says why.
test("a routine run that fails under -q prints its one line on stderr and nothing else", async () => {
  const { code, out, err } = await runScript("missed-quiet", `console.log("ran")`, { at: { hour: 6, minute: 36 }, on: { year: 2020, month: 1, day: 1 } }, ["--scheduled", "-q"]);
  expect({ code, out }).toEqual({ code: 1, out: "" });
  expect(err.trimEnd().split("\n")).toEqual([expect.stringMatching(/^error: exit 1: missed-quiet did not run: it was set to run /)]);
});

test("pause survives a new CLI process, blocks manual and scheduled runs, and resume rejects the old queued schedule", async () => {
  await addScript("pausable");
  const before = routineMeta("pausable").generation;
  expect((await command(["routine", "pause", "pausable"])).code).toBe(0);
  const list = await command(["routine", "list", "--json"]);
  const rows: { name: string; paused: boolean }[] = JSON.parse(list.out);
  expect(rows.find((row) => row.name === "pausable")?.paused).toBe(true);
  const manual = await command(["routine", "run", "pausable", "--dry"]);
  expect(manual.code).toBe(1);
  expect(manual.out).toContain("is paused");
  const queued = await command(["routine", "run", "pausable", "--scheduled", "--generation", before, "--dry"]);
  expect(queued.code).toBe(1);
  expect(queued.out).not.toContain("log:");
  expect((await command(["routine", "resume", "pausable"])).code).toBe(0);
  const stale = await command(["routine", "run", "pausable", "--scheduled", "--generation", before, "--dry"]);
  expect(stale.code).toBe(1);
  expect(stale.out).toContain("schedule changed");
  const current = await command(["routine", "run", "pausable", "--scheduled", "--generation", routineMeta("pausable").generation, "--dry"]);
  expect(current.code).toBe(0);
  expect(outputLog(current.out).trim()).toBe("script ran: true");
});

test("removing then reusing a name does not let an old queued schedule run the replacement", async () => {
  await addScript("replaced");
  const old = routineMeta("replaced").generation;
  expect((await command(["routine", "remove", "replaced"])).code).toBe(0);
  const removed = await command(["routine", "run", "replaced", "--scheduled", "--generation", old, "--dry"]);
  expect(removed.code).toBe(1);
  expect(removed.out).toContain("no routine named");
  await addScript("replaced");
  const stale = await command(["routine", "run", "replaced", "--scheduled", "--generation", old, "--dry"]);
  expect(stale.code).toBe(1);
  expect(stale.out).toContain("schedule changed");
  const manual = await command(["routine", "run", "replaced", "--dry"]);
  expect(manual.code).toBe(0);
  expect(outputLog(manual.out).trim()).toBe("script ran: true");
});

test.each([false, true])("scheduled invocations cannot overlap a task after wrapper death=%s", async (killWrapper) => {
  const entered = Promise.withResolvers<number>();
  const release = Promise.withResolvers<Response>();
  let requests = 0;
  const gate = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      requests++;
      entered.resolve(Number(req.headers.get("x-worker-pid")));
      return requests === 1 ? release.promise : new Response("continue");
    },
  });
  writeFileSync(join(routines, "single.md"), JSON.stringify({ gate: `http://127.0.0.1:${gate.port}` }));
  writeFileSync(join(routines, "single.json"), JSON.stringify({ name: "single", schedule: { everyMinutes: 60 }, created: "2026-10-22", generation: "selected-schedule" }));
  const first = startCommand(["routine", "run", "single"]);
  const firstOutput = new Response(first.stdout).text();
  const firstError = new Response(first.stderr).text();
  let childExited: Promise<void> | undefined;
  try {
    const child = await Promise.race([entered.promise, first.exited.then((code) => { throw new Error(`routine exited before its task started: ${code}`); })]);
    childExited = new Promise<void>((resolve) => watchOwner(child, resolve));
    if (killWrapper) {
      first.kill("SIGKILL");
      expect(await first.exited).toBeGreaterThan(0);
    }
    const second = await command(["routine", "run", "single", "--scheduled", "--generation", "selected-schedule"]);
    expect(second.code).toBe(1);
    expect(second.out).toContain("already running");
    expect(requests).toBe(1);
    release.resolve(new Response("continue"));
    await childExited;
    await first.exited;
    if (killWrapper) {
      const recovered = await command(["routine", "run", "single"]);
      expect(recovered.code).toBe(0);
      expect(outputLog(recovered.out).trim()).toBe("The scheduled task finished.");
      expect(requests).toBe(2);
    } else {
      expect(outputLog(await firstOutput).trim()).toBe("The scheduled task finished.");
    }
  } finally {
    release.resolve(new Response("continue"));
    await first.exited;
    await childExited;
    gate.stop(true);
  }
  expect(await firstError).toBe("");
}, 15_000);

const sessions = join(home, ".local", "share", "safari-harness", "sessions");

function savedSession(id: string, baseUrl: string): string {
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, `${id}.json`);
  writeFileSync(path, JSON.stringify({
    id, task: "the original saved task", created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z",
    status: "done", host: "local", model: "saved-model", baseUrl,
    messages: [{ role: "system", content: "keep the saved instructions" }, { role: "user", content: "the original saved task" }, { role: "assistant", content: "earlier answer" }],
  }));
  return path;
}

test("a routine continues the selected conversation with its original messages, host and model", async () => {
  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      requests.push(await req.json());
      return Response.json({ choices: [{ message: { role: "assistant", content: "continued the saved task" } }] });
    },
  });
  const path = savedSession("abc12345", `http://127.0.0.1:${endpoint.port}/v1`);
  try {
    expect((await command(["routine", "add", "continue-work", "--every", "60", "--session", "abc12345", "check for updates"])).code).toBe(0);
    const run = await command(["routine", "run", "continue-work"]);
    expect(run.code).toBe(0);
    expect(outputLog(run.out)).toContain("continued the saved task");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("saved-model");
    expect(requests[0]?.messages.slice(0, 3)).toEqual([
      { role: "system", content: "keep the saved instructions" },
      { role: "user", content: "the original saved task" },
      { role: "assistant", content: "earlier answer" },
    ]);
    expect(requests[0]?.messages.at(-1)?.content).toContain("check for updates");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.id).toBe("abc12345");
    expect(stored.answer).toBe("continued the saved task");
    expect(stored.messages.at(-1)).toEqual({ role: "assistant", content: "continued the saved task" });
  } finally { endpoint.stop(true); }
});

test("a disappeared saved conversation pauses its routine and never starts a fresh task", async () => {
  const path = savedSession("abc23456", "http://127.0.0.1:1/v1");
  expect((await command(["routine", "add", "missing-work", "--every", "60", "--session", "abc23456", "continue"])).code).toBe(0);
  rmSync(path);
  const run = await command(["routine", "run", "missing-work"]);
  expect(run.code).toBe(1);
  expect(run.out).toContain("paused");
  expect(outputLog(run.out)).toContain("no session abc23456");
  expect(routineMeta("missing-work").paused).toBe(true);
  expect((await command(["routine", "resume", "missing-work"])).code).toBe(1);
  expect((await command(["routine", "run", "missing-work"])).out).toContain("is paused");
  expect(existsSync(path)).toBe(false);
});

test("a changed saved conversation identity is not silently accepted", async () => {
  const path = savedSession("abc34567", "http://127.0.0.1:1/v1");
  expect((await command(["routine", "add", "changed-work", "--every", "60", "--session", "abc34567", "continue"])).code).toBe(0);
  const replacement = JSON.parse(readFileSync(path, "utf8"));
  replacement.created = "2026-10-22T00:00:00.000Z";
  writeFileSync(path, JSON.stringify(replacement));
  const run = await command(["routine", "run", "changed-work"]);
  expect(run.code).toBe(1);
  expect(run.out).toContain("changed identity");
  expect(routineMeta("changed-work").paused).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).messages).toEqual(replacement.messages);
});

test("a saved conversation already running in another process cannot be resumed by a routine", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  let requests = 0;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      requests++;
      entered.resolve();
      return release.promise;
    },
  });
  savedSession("abc45678", `http://127.0.0.1:${endpoint.port}/v1`);
  expect((await command(["routine", "add", "busy-work", "--every", "60", "--session", "abc45678", "continue"])).code).toBe(0);
  const first = startCommand(["session", "resume", "abc45678", "manual continuation"]);
  const stdout = new Response(first.stdout).text();
  const stderr = new Response(first.stderr).text();
  try {
    await Promise.race([entered.promise, first.exited.then((code) => { throw new Error(`session exited before reaching the endpoint: ${code}`); })]);
    const run = await command(["routine", "run", "busy-work"]);
    expect(run.code).toBe(1);
    expect(run.out).toContain("already running");
    expect(routineMeta("busy-work").paused).toBe(true);
    expect(requests).toBe(1);
  } finally {
    release.resolve(Response.json({ choices: [{ message: { role: "assistant", content: "manual task finished" } }] }));
    await first.exited;
    await Promise.all([stdout, stderr]);
    endpoint.stop(true);
  }
}, 15_000);

test.each(["pause", "remove"] as const)("a running saved continuation respects %s and cannot restore its old schedule", async (control) => {
  const id = control === "pause" ? "abc56789" : "abc67890";
  const name = `active-${control}`;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  let requests = 0;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() { requests++; entered.resolve(); return release.promise; },
  });
  const path = savedSession(id, `http://127.0.0.1:${endpoint.port}/v1`);
  expect((await command(["routine", "add", name, "--every", "60", "--session", id, "continue"])).code).toBe(0);
  const generation = routineMeta(name).generation;
  const first = startCommand(["routine", "run", name, "--scheduled", "--generation", generation]);
  const stdout = new Response(first.stdout).text();
  const stderr = new Response(first.stderr).text();
  try {
    await Promise.race([entered.promise, first.exited.then((code) => { throw new Error(`continuation ended before reaching the endpoint: ${code}`); })]);
    expect((await command(["routine", control, name])).code).toBe(0);
    expect(await first.exited).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("stopped");
    expect(requests).toBe(1);
    const queued = await command(["routine", "run", name, "--scheduled", "--generation", generation]);
    expect(queued.code).toBe(1);
    expect(queued.out).toContain(control === "pause" ? "is paused" : "no routine named");
    expect(existsSync(join(routines, `${name}.json`))).toBe(control === "pause");
  } finally {
    release.resolve(Response.json({ choices: [{ message: { role: "assistant", content: "must not be used after stopping" } }] }));
    if (first.exitCode === null) first.kill();
    await first.exited;
    await Promise.all([stdout, stderr]);
    endpoint.stop(true);
  }
}, 15_000);

test("an interrupted CLI releases both execution leases so saved work can resume after a restart", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  let requests = 0;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      requests++;
      if (requests === 1) { entered.resolve(); return release.promise; }
      return Response.json({ choices: [{ message: { role: "assistant", content: "recovered after restart" } }] });
    },
  });
  const path = savedSession("abc78901", `http://127.0.0.1:${endpoint.port}/v1`);
  expect((await command(["routine", "add", "restart-work", "--every", "60", "--session", "abc78901", "continue"])).code).toBe(0);
  const first = startCommand(["routine", "run", "restart-work"]);
  const stdout = new Response(first.stdout).text();
  const stderr = new Response(first.stderr).text();
  try {
    await Promise.race([entered.promise, first.exited.then((code) => { throw new Error(`continuation ended before interruption: ${code}`); })]);
    first.kill("SIGKILL");
    expect(await first.exited).toBeGreaterThan(0);
    const next = await command(["routine", "run", "restart-work"]);
    expect(next.code).toBe(0);
    expect(outputLog(next.out)).toContain("recovered after restart");
    expect(requests).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8")).id).toBe("abc78901");
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("done");
  } finally {
    release.resolve(new Response("interrupted"));
    if (first.exitCode === null) first.kill("SIGKILL");
    await first.exited;
    await Promise.all([stdout, stderr]);
    endpoint.stop(true);
  }
}, 15_000);

test("a saved continuation failure exits nonzero and leaves its error and last-run outcome", async () => {
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("not available", { status: 503 }),
  });
  savedSession("abc89012", `http://127.0.0.1:${endpoint.port}/v1`);
  try {
    expect((await command(["routine", "add", "failed-work", "--every", "60", "--session", "abc89012", "continue"])).code).toBe(0);
    const run = await command(["routine", "run", "failed-work"]);
    expect(run.code).toBe(1);
    expect(outputLog(run.out)).toContain("model error 503");
    expect(readFileSync(join(home, "Library", "Logs", "safari-harness", "routines", "failed-work.last"), "utf8")).toContain("exit 1");
    expect((await command(["session", "show", "abc89012", "--json"])).out).toContain('"status":"failed"');
  } finally { endpoint.stop(true); }
});
