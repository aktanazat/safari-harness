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
let silent = false;
const closed: number[] = [];
let heardClose = () => {};

function answer(op: string, args: unknown[]): { value: unknown } | { error: string } | undefined {
  if (op === "tabs.list") return silent ? undefined : { value: rows };
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
    rows = rows.filter((r) => r.id !== args[0]);
    closed.push(Number(args[0]));
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
const home = mkdtempSync(join(tmpdir(), "turn-end-"));
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

// From 10-30 01:05Z to 01:50Z Safari left tabs.list unanswered and every
// turn end failed as Bun's 500 with its error dump.
test("a turn end Safari does not answer fails as JSON, and its agent's tab closes once the extension is back", async () => {
  const opened = (await (await post("/rpc", { tool: "open", args: { url: "https://own.example/", background: true }, caller: process.pid, own: true })).json()) as { value: { id: number } };
  const tab = opened.value.id;
  const gone = Promise.withResolvers<void>();
  heardClose = () => {
    if (closed.includes(tab)) gone.resolve();
  };
  silent = true;
  const prepared: unknown = await (await post("/turn-end/prepare", { owner: process.pid })).json();
  const res = await post("/turn-end", { owner: process.pid, prepared });
  const body = await res.text();
  expect(res.status).toBe(503);
  expect(JSON.parse(body)).toEqual({ ok: false, error: "extension request tabs.list timed out after 5000ms" });
  expect(closed).not.toContain(tab);
  // the extension reloads, as the daemon has a stuck one do (bridge.ts)
  silent = false;
  extension.close();
  extension = connect();
  await gone.promise;
  expect(closed).toContain(tab);
}, 30_000);
