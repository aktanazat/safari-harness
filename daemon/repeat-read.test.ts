import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daemon runs in a process of its own with a stand-in extension on its
// socket (turn-end.test.ts). The CLI and the MCP server call it from
// processes of their own, under one omp session's task, as an agent's do.

const MCP = join(import.meta.dir, "mcp-tools.ts");
const AGENT = join(import.meta.dir, "agent.ts");
const CLI = join(import.meta.dir, "../cli/safari.ts");
const TASK = JSON.stringify(["session", "agent"]);
const tab = 7001;
const url = "https://shop.example/";
const page = Array.from({ length: 40 }, (_, i) => `[${i + 1}] button "Product ${i}"`);

function answer(op: string, args: unknown[]): unknown {
  if (op === "relay" && args[1] === "snapshot") return { url, documentId: "document", title: "Shop", nodes: page.length, truncated: false, snapshot: page.join("\n") };
  if (op === "relay" && args[1] === "tabInfo") return { url, title: "Shop", ready: "complete" };
  if (op === "relay" && args[1] === "hover") return { ok: true };
  if (op === "tabs.list") return [{ id: tab, url, title: "Shop", windowId: 1, active: true }];
  return [];
}

const probes = [Bun.serve({ port: 0, fetch: () => new Response() }), Bun.serve({ port: 0, fetch: () => new Response() })];
const [wsPort, httpPort] = probes.map((s) => s.port);
await Promise.all(probes.map((s) => s.stop(true)));
const home = mkdtempSync(join(tmpdir(), "repeat-read-"));
const state = join(home, ".local/share/safari-harness");
mkdirSync(join(state, "tasks"), { recursive: true });
// A keeper counts as running, so no call starts one in the real Safari
// (claimSpaces in call.ts).
writeFileSync(join(state, "keeper.pid"), String(process.pid));
writeFileSync(join(state, "tasks", "session"), TASK);
const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
  env: { ...process.env, HOME: home, SAFARI_HARNESS_WS: String(wsPort), SAFARI_HARNESS_HTTP_PORT: String(httpPort) },
  stdout: "pipe",
  stderr: "inherit",
});
const env = { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${httpPort}`, PI_SESSION_ID: "session" };

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
  if (id !== undefined) extension.send(JSON.stringify({ id, value: answer(op, args ?? []) }));
};
await logs("connect");

afterAll(async () => {
  extension.close();
  daemon.kill();
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
});

async function output(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const [text, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  return text;
}

// What the agent's shell prints for safari snapshot.
const cli = () => output(Bun.spawn([process.execPath, CLI, "snapshot", "--tab", String(tab)], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));

// The answers the agent's MCP server gives its reads, one after another; a
// failed call throws (mcp-tools.ts). marks: what the omp extension adds.
async function mcp(reads: number, marks: Record<string, unknown> = {}): Promise<string[]> {
  const code = `import { callTool } from ${JSON.stringify(MCP)};
const answers = [];
for (let i = 0; i < ${reads}; i++) answers.push(await callTool("snapshot", { tab: ${tab}, __safariTask: ${JSON.stringify(TASK)}, ...${JSON.stringify(marks)} }));
process.stdout.write(JSON.stringify(answers));`;
  return JSON.parse(await output(Bun.spawn([process.execPath, "-e", code], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })));
}

const whole = page.join("\n");
const own = { __safariVerbatim: true };

test("a repeat read answers with only what changed for the model's own MCP tool call, and whole for the CLI, whose read ends that base", async () => {
  expect(await cli()).toContain(whole);
  // The CLI's output may go through a pipe that keeps a few of its lines.
  expect(await cli()).toContain(whole);
  const [first, again] = await mcp(2, own);
  expect(first).toContain(whole);
  expect(again).toContain(url);
  expect(again).not.toContain(page[0]);
  await cli();
  // Changes from the MCP read before the CLI's would say nothing changed.
  const [after] = await mcp(1, own);
  expect(after).toContain(whole);
}, 30_000);

// An eval cell's code reads the answers of the MCP calls it makes, and a
// session that began before a deploy keeps the extension it loaded, which
// marks no call as the model's own.
test("MCP reads the omp extension does not mark as the model's own come back whole", async () => {
  await mcp(1, own);
  for (const read of await mcp(2)) expect(read).toContain(whole);
}, 30_000);

// A session that began on a later release keeps that release's extension
// after a rollback to this one.
test("an MCP call with a __safari argument this release does not read still runs", async () => {
  const [read] = await mcp(1, { ...own, __safariLater: true });
  expect(read).toContain(whole);
}, 30_000);

// safari do's loop trims its older tool results (agent.ts).
test("safari do's repeat action read holds the whole page", async () => {
  const code = `import { runAgent } from ${JSON.stringify(AGENT)};
const hover = { role: "assistant", content: null, tool_calls: [{ id: "hover", type: "function", function: { name: "hover", arguments: JSON.stringify({ tab: ${tab}, ref: "1", snapshot: true }) } }] };
const replies = [hover, hover, { role: "assistant", content: "done" }];
const messages = [{ role: "user", content: "check the shop" }];
await runAgent(messages, { baseUrl: "", model: "test", maxSteps: 4, recall: false, onEvent() {}, complete: async () => replies.shift() });
process.stdout.write(JSON.stringify(messages.filter((m) => m.role === "tool").map((m) => m.content)));`;
  const reads: string[] = JSON.parse(await output(Bun.spawn([process.execPath, "-e", code], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })));
  expect(reads).toHaveLength(2);
  expect(reads[1]).toContain(whole);
}, 30_000);
