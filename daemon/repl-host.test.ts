import { afterAll, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

// A named REPL session is a process of its own that the first `safari repl
// --session` command starts and leaves running (repl-host.ts); each command
// exits once it has its answer. Here the daemon runs in a process of its
// own with a stand-in extension on its socket, as in renumber-caller.test.ts,
// and each command is a child of this test's agent. repl-host.ts reads HOME
// for its sockets as it loads, so only the children, whose HOME is a scratch
// folder, import it.

const HOST = join(import.meta.dir, "repl-host.ts");
const SESSION = JSON.stringify("lasting");

type Row = { id: number; url: string; title: string; windowId: number; active: boolean };
let rows: Row[] = [];
let lastId = 7000;
const closed: number[] = [];
let heardClose = () => {};

function answer(op: string, args: unknown[]): { value: unknown } | { error: string } {
  if (op === "tabs.list") return { value: rows };
  if (op === "windows.open") {
    const windowId = ++lastId;
    rows.push({ id: ++lastId, url: String(args[0]), title: "", windowId, active: true });
    return { value: { windowId } };
  }
  if (op === "tabs.open") {
    const row = { id: ++lastId, url: String(args[0]), title: "", windowId: Number(args[2]), active: false };
    rows.push(row);
    return { value: row };
  }
  if (op === "tabs.close") {
    closed.push(Number(args[0]));
    rows = rows.filter((r) => r.id !== args[0]);
    heardClose();
    return { value: { ok: true } };
  }
  if (op === "relay" && args[1] === "tabInfo") {
    const row = rows.find((r) => r.id === args[0]);
    return row ? { value: { url: row.url, title: row.title, ready: "complete" } } : { error: `Tab '${String(args[0])}' was not found` };
  }
  if (op === "probe") return { value: [] };
  return { error: `no ${op} here` };
}

const probes = [Bun.serve({ port: 0, fetch: () => new Response() }), Bun.serve({ port: 0, fetch: () => new Response() })];
const [wsPort, httpPort] = probes.map((s) => s.port);
await Promise.all(probes.map((s) => s.stop(true)));
// A unix socket's path must fit in 104 bytes, so the scratch HOME is short.
const home = mkdtempSync("/tmp/repl-host-");
const state = join(home, ".local/share/safari-harness");
mkdirSync(state, { recursive: true });
// A keeper counts as running, so none starts to group a window in the real
// Safari (claimSpaces in call.ts).
writeFileSync(join(state, "keeper.pid"), String(process.pid));
const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
  env: { ...process.env, HOME: home, SAFARI_HARNESS_WS: String(wsPort), SAFARI_HARNESS_HTTP_PORT: String(httpPort) },
  stdout: "pipe",
  stderr: "inherit",
});
const env = { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${httpPort}` };

// bun under the name omp: the daemon takes the nearest agent harness above
// a call's process for its agent (owner.ts), whatever runs this test.
const omp = join(home, "omp");
linkSync(process.execPath, omp);

// This test's agent. It runs each argv it reads, a JSON line on its stdin,
// as a child of its own, and writes back what that printed, as a JSON
// string on a line.
const RELAY = `for await (const line of console) {
  const p = Bun.spawn(JSON.parse(line), { stdout: "pipe", stderr: "inherit" });
  console.log(JSON.stringify(await new Response(p.stdout).text()));
}`;
const me = Bun.spawn([omp, "-e", RELAY], { env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const replies = (async function* () {
  let rest = "";
  for await (const text of me.stdout.pipeThrough(new TextDecoderStream())) {
    const lines = (rest + text).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) yield JSON.parse(line) as string;
  }
})();

async function run(argv: string[]): Promise<string> {
  me.stdin.write(JSON.stringify(argv) + "\n");
  await me.stdin.flush();
  const { value, done } = await replies.next();
  if (done) throw new Error("this test's agent exited");
  return value;
}

// What the daemon has logged, a line at a time, and a wake-up for what
// waits on a line.
const logged: string[] = [];
let ended = false;
let heard = () => {};
void (async () => {
  let rest = "";
  for await (const text of daemon.stdout.pipeThrough(new TextDecoderStream())) {
    const lines = (rest + text).split("\n");
    rest = lines.pop() ?? "";
    logged.push(...lines);
    heard();
  }
  ended = true;
  heard();
})();

function logs(what: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  heard = () => {
    if (logged.some((l) => l.split("[safari-harness] ")[1]?.startsWith(what))) resolve();
    else if (ended) reject(new Error(`the daemon exited before it logged ${what}`));
  };
  heard();
  return promise;
}

await logs("extension+cdp ws");
const extension = new WebSocket(`ws://127.0.0.1:${wsPort}/`, { headers: { origin: "safari-web-extension://stand-in" } });
extension.onmessage = (e) => {
  const { id, op, args } = JSON.parse(String(e.data)) as { id?: string; op: string; args?: unknown[] };
  if (id !== undefined) extension.send(JSON.stringify({ id, ...answer(op, args ?? []) }));
};
await logs("connect");

// A `safari repl` command: a process of its own that calls repl-host.ts and
// exits once it has the answer, as the CLI does. elsewhere runs it for
// another agent: an agent harness of its own between this test and the
// command.
async function command(call: string, elsewhere = false): Promise<unknown> {
  const script = `const repl = await import(${JSON.stringify(HOST)});
await Bun.write(Bun.stdout, JSON.stringify(await repl.${call}));
process.exit(0);`;
  const argv = [process.execPath, "-e", script];
  if (!elsewhere) return JSON.parse(await run(argv));
  const p = Bun.spawn([omp, "-e", `process.exit(await Bun.spawn(${JSON.stringify(argv)}, { stdout: "inherit", stderr: "inherit" }).exited)`], { env, stdout: "pipe", stderr: "inherit" });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return JSON.parse(out);
}

// Settles once the daemon's owner sweep has run since now: an agent (an
// agent harness whose child calls) opens a tab and is killed, and its tab
// closes in the first sweep that finds it gone, after the tabs of every
// agent that ended before it. The daemon names the agent as the call
// arrives, so the child is done with then.
async function ownerSweep(): Promise<void> {
  const agent = Bun.spawn([omp, "-e", "await Bun.write(Bun.stdout, `${Bun.spawn(['sleep', '60']).pid}\\n`); await Bun.sleep(60_000)"], { stdout: "pipe" });
  const { value } = await agent.stdout.getReader().read();
  const caller = Number(new TextDecoder().decode(value).trim());
  const res = await fetch(`http://127.0.0.1:${httpPort}/rpc`, { method: "POST", body: JSON.stringify({ tool: "open", args: { url: "https://marker.example/", background: true }, caller }) });
  const { value: tab } = (await res.json()) as { value: { id: number } };
  process.kill(caller, 9);
  const gone = Promise.withResolvers<void>();
  heardClose = () => {
    if (closed.includes(tab.id)) gone.resolve();
  };
  agent.kill(9);
  await gone.promise;
}

afterAll(async () => {
  for (const session of (await command("listSessions()")) as { pid: number }[]) process.kill(session.pid, 9);
  me.kill();
  await me.exited;
  extension.close();
  daemon.kill();
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
});

test("a named session's tab still answers in its next call after the command that started the session has exited", async () => {
  const first = await command(`runInSession(${SESSION}, "const p = await openTab('https://a.example/'); p.id")`);
  expect(first).toEqual({ output: expect.any(String), started: true });
  await ownerSweep();
  const second = await command(`runInSession(${SESSION}, "(await page.info()).url")`);
  expect(second).toEqual({ output: "https://a.example/", started: false });
}, 30_000);

// The tab a session's code opens, by a command this test's agent runs.
async function sessionTab(url: string): Promise<number> {
  const { output } = (await command(`runInSession(${SESSION}, "(await openTab('${url}')).id")`)) as { output: string };
  return Number(output);
}

test("a named session's tab opens in the window of the agent that ran the code, beside the agent's own tabs", async () => {
  // a command of the agent's calls, as a shell's safari command does
  const opened = await run([process.execPath, "-e", `const res = await fetch("http://127.0.0.1:${httpPort}/rpc", { method: "POST", body: JSON.stringify({ tool: "open", args: { url: "https://own.example/", background: true }, caller: process.pid }) });
console.log(JSON.stringify(await res.json()));`]);
  const { value: own } = JSON.parse(opened) as { value: { id: number } };
  const tab = await sessionTab("https://b.example/");
  const placed = rows.filter((r) => r.id === own.id || r.id === tab).map((r) => r.windowId);
  expect(placed).toEqual([placed[0], placed[0]]);
}, 30_000);

test("a named session's tab closes when the turn of the agent that ran the code ends", async () => {
  const tab = await sessionTab("https://c.example/");
  const gone = Promise.withResolvers<void>();
  heardClose = () => {
    if (closed.includes(tab)) gone.resolve();
  };
  await fetch(`http://127.0.0.1:${httpPort}/turn-end`, { method: "POST", body: JSON.stringify({ owner: me.pid }) });
  await gone.promise;
  expect(closed).toContain(tab);
}, 30_000);

// From 09-26 to 10-05, 40 of 191 session names were one agent's numbered
// retries (tt-agent … tt-agent4), each starting over with new tabs.
test("a session an agent starts names the sessions that agent already runs, and not another agent's", async () => {
  await command(`runInSession("first", "await openTab('https://d.example/')")`);
  const mine = (await command(`runInSession("second", "1")`)) as { hint?: string };
  expect(mine.hint).toContain("first (d.example)");
  const theirs = (await command(`runInSession("third", "1")`, true)) as { hint?: string };
  expect(theirs.hint).toBeUndefined();
}, 30_000);

// `safari repl` itself, run as an agent's shell runs it.
const CLI = join(import.meta.dir, "../cli/safari.ts");

// On 10-07 Akyl set globalThis.dmid in one plain call and found it gone in
// the next: each call was then a session of its own.
test("a value one plain safari repl call sets, the same agent's next plain call reads", async () => {
  await run([process.execPath, CLI, "repl", "globalThis.dmid = 'D0123'"]);
  expect(await run([process.execPath, CLI, "repl", "globalThis.dmid"])).toBe("D0123\n");
}, 30_000);

test("the session of an agent's plain safari repl calls ends when that agent exits", async () => {
  // an agent of its own: it runs one plain call, says so, and stays
  const agent = Bun.spawn([omp, "-e", `await Bun.spawn([process.execPath, ${JSON.stringify(CLI)}, "repl", "1"], { stdout: "ignore", stderr: "inherit" }).exited; console.log("ran"); await Bun.sleep(60_000);`], { env, stdout: "pipe", stderr: "inherit" });
  await agent.stdout.getReader().read();
  const session = `agent-${agent.pid}`;
  const running = async () => ((await command("listSessions()")) as { id: string }[]).some((s) => s.id === session);
  expect(await running()).toBe(true);
  // A session that ends takes its socket away.
  const sock = join(state, "repl", `${session}.sock`);
  const ended = Promise.withResolvers<void>();
  const watcher = watch(join(state, "repl"), () => {
    if (!existsSync(sock)) ended.resolve();
  });
  agent.kill(9);
  await ended.promise;
  watcher.close();
  expect(await running()).toBe(false);
}, 30_000);
