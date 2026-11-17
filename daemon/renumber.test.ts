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
// and the tab an agent's info reached is noted (the window sweep's own
// look at its page is not), as is each close. Like background.js, the
// extension takes an old id for the tab it names now, fails an id it knows
// nothing of as Safari does, and closes a tab for the daemon's sweep (only)
// when the harness owns it: opened as owned, or given how to answer its
// dialogs.
type Row = { id: number; url: string; windowId: number };
const tabs = new Map<number, Row>();
const owned = new Set<number>();
const tabNow = new Map<number, number>(); // an old tab id, and that tab's id now
const windowNow = new Map<number, number>();
const reached: number[] = [];
let nextTab = 300;
let nextWindow = 30;

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
    if (args[1] !== undefined && !owned.has(row.id)) return { value: { ok: false } };
    tabs.delete(row.id);
    return { value: { ok: true } };
  }
  if (op === "dialogs") {
    if (args[1]) owned.add(row.id);
    return { value: { dialogs: [], answer: "dismiss" } };
  }
  if (op === "relay" && args[1] === "tabInfo") reached.push(row.id);
  return { value: { ok: true, url: row.url } };
}

// It says when its page started as it connects (hello): a reload or a
// Safari that started again starts a new one.
function extension(): ExtSocket {
  const sock: ExtSocket = {
    send(raw: string) {
      const { id, op, args } = JSON.parse(raw) as { id?: string; op: string; args: unknown[] };
      if (id === undefined) return;
      bridge.handleMessage(JSON.stringify({ id, ...answer(op, args) }), sock);
    },
    close() {},
  };
  return sock;
}

function connectNew(sock: ExtSocket) {
  connect(sock);
  bridge.handleMessage(JSON.stringify({ op: "hello", role: "extension", started: Date.now() }), sock);
}

// A deploy that changes the extension: Safari reloads it, which closes its
// socket, gives every tab and window a new id, and empties its session
// storage, where it lists the tabs the harness owns. The extension, once it
// connects again, says each old tab id's new one (background.js). Those of
// late pages Safari answered too slowly come only later, each showing
// another address by then.
function deploy(late: number[] = []): ExtSocket {
  // connections are told apart by the millisecond they began
  for (const began = Date.now(); Date.now() === began; );
  const windows = new Map<number, number>();
  // over a copy: the loop adds each tab again under its new id
  for (const t of [...tabs.values()]) {
    const windowId = windows.get(t.windowId) ?? ++nextWindow;
    windows.set(t.windowId, windowId);
    const row = { ...t, id: ++nextTab, windowId, ...(late.includes(t.id) ? { url: `${t.url}next` } : {}) };
    tabs.delete(t.id);
    tabs.set(row.id, row);
    tabNow.set(t.id, row.id);
  }
  for (const [was, now] of windows) windowNow.set(was, now);
  owned.clear();
  const sock = extension();
  connectNew(sock);
  bridge.handleMessage(JSON.stringify({ op: "tab", kind: "renumbered", tabs: Object.fromEntries([...tabNow].filter(([was]) => !late.includes(was))) }), sock);
  return sock;
}

function now(old: number): number {
  const id = tabNow.get(old);
  if (id === undefined) throw new Error(`the deploy gave tab ${old} no new id`);
  return id;
}

// Safari quits and starts again: its extension connects before Safari has
// restored any window, and says no old id's new one (it read no marks),
// and the windows come back later, every tab and window under a new id.
// The window's page is found again by its proof (located in spaces.ts).
function relaunch(): () => void {
  for (const began = Date.now(); Date.now() === began; );
  const windows = new Map<number, number>();
  const back: Row[] = [];
  for (const t of [...tabs.values()]) {
    const windowId = windows.get(t.windowId) ?? ++nextWindow;
    windows.set(t.windowId, windowId);
    back.push({ ...t, id: ++nextTab, windowId });
    tabs.delete(t.id);
  }
  owned.clear();
  connectNew(extension());
  return () => {
    for (const row of back) tabs.set(row.id, row);
    for (const [was, now] of windows) windowNow.set(was, now);
  };
}


connect(extension());
loadTabs(join(mkdtempSync(join(tmpdir(), "renumber-")), "tabs.json"));
const agent = Bun.spawn(["sleep", "60"]);
const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
const open = async (url = "https://a.example/") => {
  const t = await as("open", { url, background: true });
  if (!t || typeof t !== "object" || !("id" in t) || typeof t.id !== "number") throw new Error("open gave no tab");
  return t.id;
};

afterAll(async () => {
  agent.kill();
  await agent.exited;
  await endTurn(agent.pid);
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
  expect(await as("tabs", {})).toEqual({ tabs: [expect.objectContaining({ id: now(first) }), expect.objectContaining({ id: now(second) })] });
  // one kept by its old id outlasts the turn; the other closes as it ends
  await as("keep", { tab: second });
  await endTurn(agent.pid);
  expect(tabs.has(now(first))).toBe(false);
  expect(tabs.has(now(second))).toBe(true);
});

// 11-16 20:06: a reload while Safari answered slowly mapped some of the
// agents' tabs; the rest got their new ids only once their pages answered,
// and by then the turn-end sweep had found them missing and let them go,
// open in Safari for good.
test("a tab whose new id comes after the sweep found it missing is its agent's again, and closes as the turn ends", async () => {
  const tab = await open();
  const sock = deploy([tab]);
  await endTurn(agent.pid);
  expect(tabs.has(now(tab))).toBe(true);
  bridge.handleMessage(JSON.stringify({ op: "tab", kind: "renumbered", tabs: { [tab]: now(tab) } }), sock);
  await endTurn(agent.pid);
  expect(tabs.has(now(tab))).toBe(false);
});

// 11-16 20:06:58: Safari quit 7 s after a reload and started again; the
// sweep listed its tabs 40 ms after its extension connected, before Safari
// had restored any window, and let 45 agents' tabs go, open for good.
test("after Safari starts again, an agent's tabs it restores only later are found by their pages and close as the turn ends", async () => {
  const url = "https://relaunch.example/";
  await open(url);
  const restore = relaunch();
  await endTurn(agent.pid);
  restore();
  const page = [...tabs.values()].find((t) => t.url === url)!;
  await as("tabs", {});
  await endTurn(agent.pid);
  expect(tabs.has(page.id)).toBe(false);
});
