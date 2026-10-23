import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const MCP = join(import.meta.dir, "mcp-tools.ts");
const CLI = join(import.meta.dir, "../cli/safari.ts");
type WireCall = { tool: string; args: Record<string, unknown>; caller?: number; task?: string };

async function transport(run: (url: string, home: string, calls: WireCall[]) => Promise<void>) {
  const home = await mkdtemp("/tmp/safari-task-");
  const calls: WireCall[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true });
    const call = await req.json() as WireCall;
    calls.push(call);
    const value = call.tool === "tabs" ? { tabs: [] } : call.tool === "open" ? { id: 801, url: call.args.url, title: "fixture" } : { ok: true };
    return Response.json({ ok: true, value });
  } });
  try { await run(`http://127.0.0.1:${server.port}`, home, calls); }
  finally { server.stop(true); await rm(home, { recursive: true, force: true }); }
}

async function script(code: string, url: string, home: string, task = "bootstrap") {
  const child = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: url, SAFARI_HARNESS_TASK: task },
    stdout: "pipe", stderr: "pipe",
  });
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  return output;
}

test("concurrent mounted calls deliver distinct task identities outside the Safari arguments", async () => {
  await transport(async (url, home, calls) => {
    await script(`import { callTool } from ${JSON.stringify(MCP)};
await Promise.all([callTool('tabs', { __safariTask: 'session:helper' }), callTool('tabs', { __safariTask: 'session:sibling' })]);`, url, home);
    expect(calls.filter(c => c.tool === "tabs").map(c => ({ task: c.task, args: c.args })).sort((a, b) => String(a.task).localeCompare(String(b.task)))).toEqual([
      { task: "session:helper", args: {} },
      { task: "session:sibling", args: {} },
    ]);
  });
});

test("anonymous REPL reuse preserves each run's task rather than its first call's identity", async () => {
  await transport(async (url, home, calls) => {
    await script(`import { callTool, closeSession } from ${JSON.stringify(MCP)};
try {
 await Promise.all([
  callTool('repl', { code: "await openTab('https://helper.example/')", __safariTask: 'session:helper' }),
  callTool('repl', { code: "await openTab('https://sibling.example/')", __safariTask: 'session:sibling' })
 ]);
} finally { await closeSession(); }`, url, home);
    expect(calls.filter(c => c.tool === "open").map(c => [c.args.url, c.task]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["https://helper.example/", "session:helper"],
      ["https://sibling.example/", "session:sibling"],
    ]);
  });
});

test("a named REPL reused by another task and a legacy caller never inherits its launch task", async () => {
  await transport(async (url, home, calls) => {
    await script(`import { callTool } from ${JSON.stringify(MCP)};
import * as host from ${JSON.stringify(join(import.meta.dir, "repl-host.ts"))};
import { existsSync, watch } from 'node:fs';
try {
 await callTool('repl', { session: 'shared', code: "await openTab('https://helper.example/')", __safariTask: 'session:helper' });
 await callTool('repl', { session: 'shared', code: "await openTab('https://sibling.example/')", __safariTask: 'session:sibling' });
 await callTool('repl', { session: 'shared', code: "await openTab('https://legacy.example/')" });
} finally {
 for (const session of await host.listSessions()) {
  const socket = host.REPL_DIR + '/' + session.id + '.sock';
  const gone = Promise.withResolvers();
  const watcher = watch(host.REPL_DIR, () => { if (!existsSync(socket)) gone.resolve(); });
  try {
   await host.closeSession(session.id);
   if (existsSync(socket)) await gone.promise;
  } finally { watcher.close(); }
 }
}`, url, home);
    expect(calls.filter(c => c.tool === "open").map(c => [c.args.url, c.task])).toEqual([
      ["https://helper.example/", "session:helper"],
      ["https://sibling.example/", "session:sibling"],
      ["https://legacy.example/", undefined],
    ]);
  });
}, 30_000);

test("Safari CLI RPCs inherit only the command's task environment", async () => {
  await transport(async (url, home, calls) => {
    const command = async (task: string) => {
      const child = Bun.spawn([process.execPath, CLI, "tabs", "--json", "--host", "local"], {
        env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: url, SAFARI_HARNESS_TASK: task }, stdout: "pipe", stderr: "pipe",
      });
      const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, error }).toEqual({ exit: 0, error: "" });
      expect(JSON.parse(output)).toEqual({ tabs: [] });
    };
    await Promise.all([command("session:helper"), command("session:sibling")]);
    expect(calls.filter(c => c.tool === "tabs").map(c => c.task).sort()).toEqual(["session:helper", "session:sibling"]);
  });
});

test("overlapping RPC scopes retain their task after another invocation resumes first", async () => {
  await transport(async (url, home, calls) => {
    await script(`import { rpc, withTask, currentTask } from ${JSON.stringify(join(import.meta.dir, "rpc.ts"))};
const resume = Promise.withResolvers();
const entered = Promise.withResolvers();
const first = withTask('session:helper', async () => {
 entered.resolve();
 await resume.promise;
 await rpc('info', { tab: 1 });
});
await entered.promise;
await withTask('session:sibling', async () => {
 await rpc('info', { tab: 2 });
 resume.resolve();
});
await first;
await withTask(undefined, async () => {
 await rpc('info', { tab: 3 });
});
await rpc('info', { tab: 4 });
if (currentTask() !== 'bootstrap') throw new Error('task context escaped its invocation');`, url, home);
    expect(calls.map(c => [c.args.tab, c.task])).toEqual([
      [2, "session:sibling"],
      [1, "session:helper"],
      [3, undefined],
      [4, "bootstrap"],
    ]);
  });
});
