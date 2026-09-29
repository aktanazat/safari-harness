import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { callTool, endTurn, loadTabs } from "./tools.ts";

// A stand-in Safari and its extension. The daemon opens the agent's tabs in
// a window of the agent's own; a page op answers from the tab it reached,
// which is noted, as is each close. Like background.js, the extension takes
// an old id for the tab it names now, fails an id it knows nothing of as
// Safari does, and closes a tab for the daemon's sweep (only) when the
// harness owns it: opened as owned, or given how to answer its dialogs.
type Row = { id: number; url: string; windowId: number };
const tabs = new Map<number, Row>();
const owned = new Set<number>();
const tabNow = new Map<number, number>(); // an old tab id, and that tab's id now
const windowNow = new Map<number, number>();
const reached: number[] = [];
const closes: [number, unknown][] = [];
const asked: number[] = []; // each tab Safari was asked to close
let nextTab = 300;
let nextWindow = 30;
let onAsk = () => {};

function answer(op: string, args: unknown[]): { value: unknown } | { error: string } {
  if (op === "windows.open") {
    const row = { id: ++nextTab, url: String(args[0]), windowId: ++nextWindow };
    tabs.set(row.id, row);
    return { value: { windowId: row.windowId, tabId: row.id } };
  }
  if (op === "windows.resolve") return { value: windowNow.get(Number(args[0])) ?? null };
  if (op === "tabs.list") return { value: [...tabs.values()] };
  if (op === "tabs.open") {
    const row = { id: ++nextTab, url: String(args[0]), windowId: Number(args[2]) };
    tabs.set(row.id, row);
    if (args[3]) owned.add(row.id);
    return { value: row };
  }
  if (op === "probe") return { value: [] };
  const id = tabs.has(Number(args[0])) ? Number(args[0]) : tabNow.get(Number(args[0]));
  const row = id === undefined ? undefined : tabs.get(id);
  if (!row) return { error: `Tab '${String(args[0])}' was not found` };
  if (op === "tabs.close") {
    asked.push(row.id);
    onAsk();
    if (args[1] !== undefined && !owned.has(row.id)) return { value: { ok: false } };
    tabs.delete(row.id);
    closes.push([row.id, args[1]]);
    return { value: { ok: true } };
  }
  if (op === "dialogs") {
    if (args[1]) owned.add(row.id);
    return { value: { dialogs: [], answer: "dismiss" } };
  }
  if (op === "relay") reached.push(row.id);
  return { value: { ok: true, url: row.url } };
}

function extension(): ExtSocket {
  const sock: ExtSocket = {
    send(raw: string) {
      const { id, op, args } = JSON.parse(raw) as { id: string; op: string; args: unknown[] };
      bridge.handleMessage(JSON.stringify({ id, ...answer(op, args) }), sock);
    },
    close() {},
  };
  return sock;
}

// A deploy that changes the extension: Safari reloads it, which closes its
// socket, gives every tab and window a new id, and empties its session
// storage, where it lists the tabs the harness owns. The extension, once it
// connects again, says each old tab id's new one (background.js).
function deploy() {
  // connections are told apart by the millisecond they began
  for (const began = Date.now(); Date.now() === began; );
  const windows = new Map<number, number>();
  // over a copy: the loop adds each tab again under its new id
  for (const t of [...tabs.values()]) {
    const windowId = windows.get(t.windowId) ?? ++nextWindow;
    windows.set(t.windowId, windowId);
    const row = { ...t, id: ++nextTab, windowId };
    tabs.delete(t.id);
    tabs.set(row.id, row);
    tabNow.set(t.id, row.id);
  }
  for (const [was, now] of windows) windowNow.set(was, now);
  owned.clear();
  const sock = extension();
  connect(sock);
  bridge.handleMessage(JSON.stringify({ op: "tab", kind: "renumbered", tabs: Object.fromEntries(tabNow) }), sock);
}

function now(old: number): number {
  const id = tabNow.get(old);
  if (id === undefined) throw new Error(`the deploy gave tab ${old} no new id`);
  return id;
}

// Settles once Safari has been asked to close the tab.
function askedToClose(id: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  onAsk = () => { if (asked.includes(id)) resolve(); };
  onAsk();
  return promise;
}

connect(extension());
loadTabs(join(mkdtempSync(join(tmpdir(), "renumber-")), "tabs.json"));
const agent = Bun.spawn(["sleep", "60"]);
const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
const open = async () => {
  const t = await as("open", { url: "https://a.example/", background: true });
  if (!t || typeof t !== "object" || !("id" in t) || typeof t.id !== "number") throw new Error("open gave no tab");
  return t.id;
};

// Once the agent exits, its window's page closes; a watch left running would
// outlive this file.
afterAll(async () => {
  const page = [...tabs.values()].find((t) => t.url.includes("/space?"));
  agent.kill();
  if (page) await askedToClose(page.id);
});

// A daemon left with the ids from before the deploy lists the agent's tabs
// as the user's, and what the agent asks of them by the ids it holds
// reaches them only where the extension looks the id up itself. An
// extension that no longer knows the harness owns them keeps them open
// when the agent's turn ends.
test("after a deploy gives every tab a new id, an agent's calls on its old ids reach its tabs, which stay its own", async () => {
  const [first, second] = [await open(), await open()];
  deploy();
  for (const old of [first, second]) {
    expect(await as("info", { tab: old })).toMatchObject({ replaced: { from: old, to: now(old) } });
    expect(reached.at(-1)).toBe(now(old));
  }
  expect(await as("tabs", {})).toEqual([expect.objectContaining({ id: now(first) }), expect.objectContaining({ id: now(second) })]);
  // one kept by its old id outlasts the turn; the other closes as it ends
  await as("keep", { tab: second });
  endTurn(agent.pid);
  await askedToClose(now(first));
  expect(closes).toEqual([[now(first), "idle"]]);
  expect(tabs.has(now(second))).toBe(true);
});
