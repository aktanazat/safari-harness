import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daemon runs in a process of its own with a stand-in extension on its
// socket, as in repl-host.test.ts, and this test is the agent its calls
// work for (own: true).

type Row = { id: number; url: string; title: string; windowId: number; active: boolean };
let rows: Row[] = [];
let lastId = 7000;
// windows the daemon opened, and tabs it closed
let windowOpens = 0;
const closed: number[] = [];

function answer(op: string, args: unknown[]): { value: unknown } | { error: string } | undefined {
  if (op === "tabs.list") return { value: rows };
  if (op === "windows.open") {
    windowOpens++;
    const windowId = ++lastId;
    rows.push({ id: ++lastId, url: String(args[0]), title: "", windowId, active: true });
    return { value: { windowId } };
  }
  if (op === "tabs.close") {
    rows = rows.filter((r) => r.id !== args[0]);
    closed.push(Number(args[0]));
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
const home = mkdtempSync(join(tmpdir(), "scratch-owner-"));
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
const http = `http://127.0.0.1:${httpPort}`;

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

function connect(): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/`, { headers: { origin: "safari-web-extension://stand-in" } });
  socket.onmessage = (e) => {
    const { id, op, args } = JSON.parse(String(e.data)) as { id?: string; op: string; args?: unknown[] };
    const reply = answer(op, args ?? []);
    if (id !== undefined && reply) socket.send(JSON.stringify({ id, ...reply }));
  };
  return socket;
}

await logs("extension+cdp ws");
let extension = connect();
await logs("connect");

afterAll(async () => {
  extension.close();
  daemon.kill();
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: "POST", body: JSON.stringify(body) });

// The keeper's space calls carry its pid, and while the process that
// spawned it (mcp.ts under omp, call.ts) lives, ownerOf() finds that agent
// above it. Its scratch window, "tab group cleanup (agent N)", was then N's
// and ended at N's every turn end, and the keeper's next pass opened
// another: 33 in an hour for agent 39993 on 11-05, 19 for agent 16935 on
// 11-02 (journal).
test("the keeper's scratch window is the daemon's, and outlasts the turn end of the agent its call came through", async () => {
  const scratch = async () => (await (await post("/rpc", { tool: "space", args: { op: "scratch" }, caller: process.pid, own: true })).json()) as { ok: boolean; value: { ok: boolean } };
  expect((await scratch()).value.ok).toBe(true);
  const before = windowOpens;
  const prepared: unknown = await (await post("/turn-end/prepare", { owner: process.pid })).json();
  await post("/turn-end", { owner: process.pid, prepared });
  expect((await scratch()).value.ok).toBe(true);
  expect({ opened: windowOpens - before, closed }).toEqual({ opened: 0, closed: [] });
}, 30_000);
