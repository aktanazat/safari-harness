import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as front from "./front.ts";
import { INPUT_TOOLS } from "./input.ts";

// real_input runs in the agent's own process (the CLI, the MCP server), and
// only the daemon hears which new id each old one names once a deploy has
// reloaded the extension. Here the daemon runs in a process of its own, as
// under launchd, with a stand-in extension on its socket; this process is
// the agent's, and the helper that presses is a fake. Like background.js,
// the stand-in takes an old id for the tab it names now. It brings no tab
// forward, which the daemon would follow by raising the real Safari.

type Row = { id: number; url: string; windowId: number; active: boolean };
// Ids no other file's stand-in gives out: bun runs every file in this
// process, where an id another file saw renumbered leads to its new one.
let tabs: Row[] = [{ id: 5001, url: "https://shop.example/cart", windowId: 51, active: true }];
const tabNow: Record<number, number> = {};
const pressed: number[] = [];

function answer(op: string, args: unknown[]): { value: unknown } | { error: string } {
  if (op === "tabs.list") return { value: tabs };
  if (op !== "relay") return { error: `no ${op} here` };
  const [tab, dom] = args as [number, string];
  const row = tabs.find((t) => t.id === (tabNow[tab] ?? tab));
  if (!row) return { error: `Tab '${tab}' was not found` };
  if (dom === "pressMark") {
    pressed.push(row.id);
    return { value: { mark: "__sh_press_t", width: 1200, height: 800 } };
  }
  if (dom === "pressDone") return { value: [] };
  return { error: `no ${dom} here` };
}

const probes = [Bun.serve({ port: 0, fetch: () => new Response() }), Bun.serve({ port: 0, fetch: () => new Response() })];
const [wsPort, httpPort] = probes.map((s) => s.port);
await Promise.all(probes.map((s) => s.stop(true)));
const home = mkdtempSync(join(tmpdir(), "renumber-caller-"));
const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
  // its journal and its lists of tabs and windows go in the scratch HOME
  env: { ...process.env, HOME: home, SAFARI_HARNESS_WS: String(wsPort), SAFARI_HARNESS_HTTP_PORT: String(httpPort) },
  stdout: "pipe",
  stderr: "inherit",
});

// What the daemon has logged (main.ts, journal.ts), a line at a time, and
// a wake-up for what waits on a line.
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

// Settles once the daemon has logged what, the words after its mark,
// count times in all.
function logs(what: string, count = 1): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  heard = () => {
    if (logged.filter((l) => l.split("[safari-harness] ")[1]?.startsWith(what)).length >= count) resolve();
    else if (ended) reject(new Error(`the daemon exited before it logged ${what}`));
  };
  heard();
  return promise;
}

// The extension's socket, once it is open at both ends and the daemon has
// taken it: its nth connection.
async function extension(nth: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`, { headers: { origin: "safari-web-extension://stand-in" } });
  const opened = Promise.withResolvers<unknown>();
  ws.onopen = opened.resolve;
  ws.onmessage = (e) => {
    const { id, op, args } = JSON.parse(String(e.data)) as { id?: string; op: string; args: unknown[] };
    if (id !== undefined) ws.send(JSON.stringify({ id, ...answer(op, args) }));
  };
  await Promise.all([opened.promise, logs("connect", nth)]);
  return ws;
}

// A deploy that changes the extension: Safari reloads it, which closes its
// socket and gives every tab and window a new id, and the extension, once it
// connects again, says each old tab id's new one (background.js).
async function deploy(old: WebSocket): Promise<void> {
  old.close();
  await logs("disconnect");
  tabs = tabs.map((t) => {
    tabNow[t.id] = t.id + 10;
    return { ...t, id: t.id + 10, windowId: t.windowId + 10 };
  });
  const ws = await extension(2);
  ws.send(JSON.stringify({ op: "tab", kind: "renumbered", tabs: tabNow }));
  await logs("renumbered");
}

await logs("extension+cdp ws");
const first = await extension(1);

afterAll(async () => {
  mock.restore();
  delete process.env.SAFARI_HARNESS_HTTP;
  daemon.kill();
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
});

// A left click on a ref, in a tab that is not the one in front, is pressed
// where the tab is (input.ts).
test("real input from an agent's own process reaches its tab by the id it held before a deploy", async () => {
  const held = tabs[0].id;
  await deploy(first);
  process.env.SAFARI_HARNESS_HTTP = `http://127.0.0.1:${httpPort}`;
  spyOn(front, "input").mockImplementation(async (args) => (args[0] === "front" ? { bundleId: "com.mitchellh.ghostty" } : args[0] === "press" ? { pressed: true } : {}));
  expect(await INPUT_TOOLS.real_input.run({ tab: held, do: "click", ref: "#go" })).toEqual({ ok: true, background: true, replaced: { from: held, to: tabNow[held] } });
  expect(pressed).toEqual([tabNow[held]]);
});
