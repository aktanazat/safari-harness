import { expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { changeQueue, files, readQueue } from "./groups.ts";
import { recent } from "./journal.ts";
import { tracksOwner } from "./mission.ts";
import { alive, runAs } from "./owner.ts";
import { closeManagedWindow, loadSpaces, managedWindows, spaceEnded, spaceTool, turnEnded } from "./spaces.ts";
import type * as Spaces from "./spaces.ts";
import { callTool, endTurn, openTab } from "./tools.ts";

// The keeper's files, away from the real ones (groups-off.json there would
// make every window plain).
const dir = mkdtempSync(join(tmpdir(), "spaces-test-"));
Object.assign(files, { queue: join(dir, "groups.json"), off: join(dir, "groups-off.json"), keeper: join(dir, "keeper.pid"), log: join(dir, "keeper.log") });
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));

type Tab = { id: number; url: string; windowId: number; active: boolean; history?: unknown };

// The ids every fake Safari here hands out, none twice in this file: the
// daemon's records of one test's windows outlast that test.
let next = 1000;

// Safari as the extension reports it, with the user's window 1 open.
function safari() {
  const tabs = new Map<number, Tab>([[1, { id: 1, url: "https://his.example/", windowId: 1, active: true }]]);
  const closed: number[] = [];
  const owned = new Set<number>();
  // Windows the extension holds the keeper to be making a tab group of.
  const regrouping = new Set<number>();
  // What the extension maps the ids it had before a reload to (adopt in
  // background.js).
  const oldTabs = new Map<number, number>();
  const oldWindows = new Map<number, number>();
  // What the daemon told the extension of each tab it sized.
  const sized: { tab: number; whole: boolean }[] = [];
  // Ops a Safari too loaded to answer leaves unanswered.
  const silent = new Set<string>();
  const ops: Record<string, (args: unknown[]) => unknown> = {
    "tabs.list": () => [...tabs.values()],
    "tabs.open": ([url, background, windowId]) => {
      const t = { id: next++, url: String(url), windowId: typeof windowId === "number" ? windowId : 1, active: !background };
      tabs.set(t.id, t);
      owned.add(t.id);
      return t;
    },
    "tabs.navigate": ([id, url]) => {
      const t = tabs.get(id as number)!;
      t.url = String(url);
      return t;
    },
    "windows.open": ([url]) => {
      const t = { id: next++, url: String(url), windowId: next++, active: true };
      tabs.set(t.id, t);
      owned.add(t.id);
      return { windowId: t.windowId, tabId: t.id };
    },
    "windows.resolve": ([id]) => {
      const now = oldWindows.get(id as number) ?? (id as number);
      return [...tabs.values()].some((t) => t.windowId === now) ? now : null;
    },
    "tabs.close": ([id, only]) => {
      const now = oldTabs.get(id as number) ?? (id as number);
      if (only === "idle" && !owned.has(now)) return { ok: false };
      tabs.delete(now);
      closed.push(now);
      return { ok: true };
    },
    // windows.create({tabId}), while the tab is still in that window
    "tabs.detach": ([id, windowId]) => {
      const t = tabs.get(id as number);
      if (t && t.windowId === windowId) t.windowId = next++;
      return { ok: true };
    },
    "windows.regrouping": ([id, on]) => {
      if (on) regrouping.add(id as number);
      else regrouping.delete(id as number);
      return { ok: true };
    },
    // the page ops open waits on (afterWall): a plain page, no bot check
    probe: () => [],
    relay: ([id, op, args]) => {
      const tab = tabs.get(Number(id));
      if (op !== "eval" || !tab?.url.includes("/space?")) return { ok: true };
      const history = { state: tab.history, replaceState(value: unknown) { tab.history = value; } };
      return { ok: true, result: runInNewContext(String((args as unknown[])[0]), { history }) };
    },
    // how an owned tab answers dialogs, which also owns it (renumber)
    dialogs: ([id]) => { owned.add(Number(id)); return { ok: true }; },
    // background.js "window": the size a window gets is one no other window
    // has, here a point taller than asked.
    window: ([id, size, whole]) => {
      const { width, height } = size as { width: number; height: number };
      sized.push({ tab: id as number, whole: whole as boolean });
      return { ok: true, windowId: tabs.get(id as number)!.windowId, size: { width, height: height + 1 } };
    },
  };
  // An op that throws is the extension's error answer.
  const sock: ExtSocket = {
    send(data) {
      const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
      if (id === undefined || silent.has(op)) return;
      let reply: { value: unknown } | { error: string };
      try {
        reply = { value: ops[op](args) };
      } catch (e) {
        reply = { error: e instanceof Error ? e.message : String(e) };
      }
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
    },
    close() {},
  };
  connect(sock);
  // The extension reloads: every tab and window gets a new id.
  const reload = () => {
    const was = [...tabs.values()];
    owned.clear();
    tabs.clear();
    for (const t of was) {
      if (!oldWindows.has(t.windowId)) oldWindows.set(t.windowId, next++);
      oldTabs.set(t.id, next++);
      tabs.set(oldTabs.get(t.id)!, { ...t, id: oldTabs.get(t.id)!, windowId: oldWindows.get(t.windowId)! });
    }
  };
  // Safari quits and starts again: it restores every tab and window under
  // new ids, which the extension, started afresh, maps to nothing.
  const relaunch = () => {
    const was = [...tabs.values()];
    owned.clear();
    const windows = new Map<number, number>();
    tabs.clear();
    for (const t of was) {
      if (!windows.has(t.windowId)) windows.set(t.windowId, next++);
      const id = next++;
      tabs.set(id, { ...t, id, windowId: windows.get(t.windowId)! });
    }
  };
  return { tabs, closed, sock, ops, reload, relaunch, oldTabs, regrouping, sized, silent };
}

test("an untracked living agent loses its disposable tabs and status page but not kept or personal pages", async () => {
  const s = safari();
  const daemon = await daemonOn(47354, "untracked");
  const owner = agent();
  let tracked = true;
  daemon.loadSpaces(join(dir, "untracked.json"), () => tracked);
  try {
    const space = await runAs(owner.pid, () => daemon.spaceWindow());
    const marker = pageIn(s.tabs, space.window)!;
    const disposable = await runAs(owner.pid, () => callTool("open", { url: "https://research.example/", background: true })) as { id: number };
    const kept = { id: next++, url: "https://kept.example/", windowId: space.window, active: false };
    s.tabs.set(kept.id, kept);
    tracked = false;
    await daemon.turnEnded(owner.pid + 1);
    await until(() => !s.tabs.has(disposable.id));
    expect(s.tabs.has(marker.id)).toBe(false);
    expect(s.tabs.has(kept.id)).toBe(true);
    expect(s.tabs.has(1)).toBe(true);
    expect(owner.exitCode).toBeNull();
  } finally {
    owner.kill();
    await owner.exited;
  }
});

test("untracked owned tabs close even when their window record is missing", async () => {
  const s = safari();
  const daemon = await daemonOn(47355, "missing-window");
  const owner = agent();
  try {
    const disposable = await runAs(owner.pid, () => callTool("open", { url: "https://research.example/", background: true })) as { id: number };
    const kept = await runAs(owner.pid, () => callTool("open", { url: "https://kept.example/", background: true, keep: true })) as { id: number };
    daemon.loadSpaces(join(dir, "missing-window.json"), () => false);
    await daemon.turnEnded(owner.pid + 1);
    await until(() => !s.tabs.has(disposable.id));
    expect(s.tabs.has(kept.id)).toBe(true);
    expect(s.tabs.has(1)).toBe(true);
    expect(owner.exitCode).toBeNull();
  } finally {
    owner.kill();
    await owner.exited;
  }
});

test("window management finds a restored registered window without an agent record and closes only that window", async () => {
  const s = safari();
  const path = join(dir, "managed-restart.json");
  const before = await daemonOn(47350, "managed-before");
  const after = await daemonOn(47350, "managed-after");
  before.loadSpaces(path, () => true);
  const window = await runAs(process.pid, () => before.spaceWindow("receipt"));
  const content = { id: next++, url: "https://receipt.example/success", windowId: window.window, active: false };
  s.tabs.set(content.id, content);
  after.loadSpaces(path, () => true);
  s.relaunch();
  const listed = await after.managedWindows();
  expect(listed).toHaveLength(1);
  expect(listed[0].tabs.map(t => t.url)).toEqual(["https://receipt.example/success"]);
  expect(await after.closeManagedWindow(listed[0].id)).toEqual({ ok: true, closed: 1, remaining: 0 });
  expect([...s.tabs.values()].map(t => t.url)).toEqual(["https://his.example/"]);
  expect(await after.managedWindows()).toEqual([]);
});

test("a copied or unknown window page never grants manual close authority", async () => {
  const s = safari();
  const foreign = { id: next++, url: "http://127.0.0.1:37334/space?id=foreign&name=receipt&size=1100x800", windowId: 1, active: false };
  s.tabs.set(foreign.id, foreign);
  expect(await managedWindows()).toEqual([]);
  await expect(closeManagedWindow("foreign")).rejects.toThrow("no longer tracked");
  expect([...s.tabs.keys()]).toEqual([1, foreign.id]);
});

test("a registered marker restored without extension ownership still closes when its task ends", async () => {
  const s = safari();
  const daemon = await daemonOn(47351, "restored-marker");
  const owned = await runAs(process.pid, () => daemon.spaceWindow());
  s.relaunch();
  await daemon.turnEnded(process.pid);
  expect(pageIn(s.tabs, owned.window)).toBeUndefined();
  expect([...s.tabs.values()].map(t => t.url)).toEqual(["https://his.example/"]);
});

test("a copied registered address cannot redirect window closure into the user's window", async () => {
  const s = safari();
  const daemon = await daemonOn(47352, "copied-registered");
  const owned = await runAs(process.pid, () => daemon.spaceWindow());
  const marker = pageIn(s.tabs, owned.window)!;
  const content = { id: next++, url: "https://result.example/", windowId: owned.window, active: false };
  s.tabs.set(content.id, content);
  s.tabs.delete(marker.id);
  const copied = { ...marker, id: next++, windowId: 1, history: undefined };
  s.tabs.set(copied.id, copied);
  expect((await daemon.managedWindows()).map(w => w.window)).toEqual([owned.window]);
  expect(await daemon.closeManagedWindow(owned.id)).toEqual({ ok: true, closed: 1, remaining: 0 });
  expect([...s.tabs.keys()]).toEqual([1, copied.id]);
});

test("a copied registered address cannot resurrect closure authority after the real window is gone", async () => {
  const s = safari();
  const daemon = await daemonOn(47353, "copied-after-close");
  const owned = await runAs(process.pid, () => daemon.spaceWindow());
  const marker = pageIn(s.tabs, owned.window)!;
  s.tabs.delete(marker.id);
  const copied = { ...marker, id: next++, windowId: 1, history: undefined };
  s.tabs.set(copied.id, copied);
  expect(await daemon.managedWindows()).toEqual([]);
  await expect(daemon.closeManagedWindow(owned.id)).rejects.toThrow("no longer tracked");
  expect([...s.tabs.keys()]).toEqual([1, copied.id]);
});

// An agent process, to open tabs for and then end.
const agent = () => Bun.spawn(["sleep", "60"]);

// A window closes up when owner.ts sees its agent's process gone, which it
// checks against the kernel once a second; there is no clock to fake there,
// so this polls for the result.
async function until(ok: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

// The page a window opens on, which names its assignment.
const pageIn = (tabs: Map<number, Tab>, window: number | undefined) => [...tabs.values()].find((t) => t.windowId === window && t.url.includes("/space?"));

// A daemon started afresh, as after a deploy: a spaces.ts of its own,
// serving its pages on its own port, as one daemon at a time does. The
// windows of this file's other daemons are then none of its business.
// Imported by a specifier with a query, since a static import would share
// this file's one module and its records.
async function daemonOn(port: number, as: string) {
  const was = process.env.SAFARI_HARNESS_HTTP_PORT;
  process.env.SAFARI_HARNESS_HTTP_PORT = String(port);
  try {
    return (await import(`./spaces.ts?${as}`)) as typeof Spaces;
  } finally {
    if (was === undefined) delete process.env.SAFARI_HARNESS_HTTP_PORT;
    else process.env.SAFARI_HARNESS_HTTP_PORT = was;
  }
}

test("each agent's tabs open in a window of its own, never the user's, and a task's later tabs join its window", async () => {
  safari();
  const [a, b] = [agent(), agent()];
  const a1 = await runAs(a.pid, () => openTab("https://a.example/1", true));
  const a2 = await runAs(a.pid, () => openTab("https://a.example/2", true));
  const b1 = await runAs(b.pid, () => openTab("https://b.example/1", true));
  const b2 = await runAs(b.pid, () => openTab("https://b.example/2", true, "research"));
  expect([a1, a2, b1, b2].map((t) => t.windowId)).not.toContain(1);
  expect(a2.windowId).toBe(a1.windowId);
  expect(b1.windowId).not.toBe(a1.windowId);
  expect(b2.windowId).not.toBe(b1.windowId);
  a.kill();
  b.kill();
});

test("a task shares one window across named and default opens while another task stays separate", async () => {
  const s = safari();
  const first = await runAs(process.pid, () => openTab("https://example.com/first", true), "browserbase-first");
  const named = await runAs(process.pid, () => openTab("https://example.com/named", true, "browserbase-videos"), "browserbase-first");
  const again = await runAs(process.pid, () => openTab("https://example.com/again", true), "browserbase-first");
  const other = await runAs(process.pid, () => openTab("https://example.com/other", true), "browserbase-second");
  expect([named.windowId, again.windowId]).toEqual([first.windowId, first.windowId]);
  expect(other.windowId).not.toBe(first.windowId);
  expect(new Set([...s.tabs.values()].map((tab) => tab.windowId)).size).toBe(3);
});

test("parallel helpers of one project share a window without sharing their tabs or cleanup", async () => {
  const s = safari();
  const a = agent();
  const main = JSON.stringify(["project-window", "Main"]);
  const first = JSON.stringify(["helper-one", "First", "project-window"]);
  const second = JSON.stringify(["helper-two", "Second", "project-window"]);
  const open = (task: string, url: string) => runAs(a.pid, () => callTool("open", { url, background: true }), task) as Promise<{ id: number; windowId: number }>;
  const parent = await open(main, "https://research.example/main");
  const one = await open(first, "https://research.example/first");
  const two = await open(second, "https://research.example/second");
  expect(new Set([parent.windowId, one.windowId, two.windowId])).toEqual(new Set([parent.windowId]));
  expect([...s.tabs.values()].filter((tab) => tab.url.includes("/space?"))).toHaveLength(1);
  const listed = await runAs(a.pid, () => callTool("tabs", {}), first) as { tabs: { id: number }[] };
  expect(listed.tabs.map((tab) => tab.id)).toEqual([one.id]);
  await endTurn(a.pid, undefined, first);
  expect(s.tabs.has(one.id)).toBe(false);
  expect(s.tabs.has(parent.id)).toBe(true);
  expect(s.tabs.has(two.id)).toBe(true);
  a.kill();
});

test("restoring identical addresses from different helpers never assigns either tab to the other", async () => {
  const s = safari();
  const a = agent();
  const first = JSON.stringify(["helper-one", "First", "project-restore"]);
  const second = JSON.stringify(["helper-two", "Second", "project-restore"]);
  const open = (task: string) => runAs(a.pid, () => callTool("open", { url: "https://research.example/shared", background: true }), task);
  await open(first);
  const secondPage = await open(second) as { id: number };
  s.relaunch();
  const restoredFirst = [...s.tabs.values()].find((tab) => tab.url === "https://research.example/shared")!;
  s.tabs.delete(restoredFirst.id);
  s.tabs.set(secondPage.id, { ...restoredFirst, id: secondPage.id });
  setSystemTime(new Date(Date.now() + 1000));
  connect(s.sock);
  setSystemTime();
  await runAs(a.pid, () => callTool("tabs", { all: true }), first);
  const restored = [...s.tabs.values()].filter((tab) => tab.url === "https://research.example/shared").map((tab) => tab.id);
  expect(restored).toHaveLength(2);
  await endTurn(a.pid, undefined, first);
  expect(restored.every((id) => s.tabs.has(id))).toBe(true);
  const secondView = await runAs(a.pid, () => callTool("tabs", {}), second) as { tabs: { id: number }[] };
  expect(secondView.tabs.some((tab) => restored.includes(tab.id))).toBe(false);
  a.kill();
});

test("after Safari restarts, distinct helper pages in one window retain separate completion ownership", async () => {
  const s = safari();
  const a = agent();
  const first = JSON.stringify(["helper-one", "First", "project-restart"]);
  const second = JSON.stringify(["helper-two", "Second", "project-restart"]);
  const open = (task: string, url: string) => runAs(a.pid, () => callTool("open", { url, background: true }), task);
  await open(first, "https://research.example/first");
  await open(second, "https://research.example/second");
  s.relaunch();
  setSystemTime(new Date(Date.now() + 1000));
  connect(s.sock);
  setSystemTime();
  await runAs(a.pid, () => callTool("tabs", {}), first);
  const restored = [...s.tabs.values()].filter((tab) => tab.url.startsWith("https://research.example/"));
  expect(restored).toHaveLength(2);
  await endTurn(a.pid, undefined, first);
  expect(s.tabs.has(restored.find((tab) => tab.url.endsWith("/first"))!.id)).toBe(false);
  expect(s.tabs.has(restored.find((tab) => tab.url.endsWith("/second"))!.id)).toBe(true);
  a.kill();
});

test("a saved task window from the old per-group layout is reused after restart", async () => {
  const s = safari();
  const before = await daemonOn(47367, "legacy-group-before");
  const opened = await runAs(process.pid, () => before.spaceWindow("videos"), "legacy-restored");
  const path = join(dir, "legacy-group.json");
  writeFileSync(path, JSON.stringify({ version: 2, spaces: [{ ...opened, key: JSON.stringify([process.pid, "legacy-restored", "videos"]) }] }));
  const after = await daemonOn(47367, "legacy-group-after");
  after.loadSpaces(path, () => true);
  const reused = await runAs(process.pid, () => after.spaceWindow(), "legacy-restored");
  expect(reused.window).toBe(opened.window);
  expect(new Set([...s.tabs.values()].map((tab) => tab.windowId)).size).toBe(2);
});

test("an older task window still recovers its tabs beside a new helper window", async () => {
  const s = safari();
  const a = agent();
  const main = JSON.stringify(["mixed-project", "Main"]);
  const helper = JSON.stringify(["mixed-helper", "Helper", "mixed-project"]);
  const window = next++;
  const marker = next++;
  const space: Spaces.Space = { key: JSON.stringify([a.pid, main, ""]), id: "mixed-legacy", window, name: "mixed-legacy", size: { width: 1100, height: 800 }, owner: a.pid, task: main, group: "plain" };
  s.tabs.set(marker, { id: marker, url: "http://127.0.0.1:37334/space?id=mixed-legacy&name=mixed-legacy&size=1100x800", windowId: window, active: false });
  const path = join(dir, "mixed-legacy.json");
  writeFileSync(path, JSON.stringify({ version: 2, spaces: [space] }));
  loadSpaces(path, () => true);
  const open = (task: string, url: string) => runAs(a.pid, () => callTool("open", { url, background: true }), task);
  await open(main, "https://research.example/legacy");
  await open(helper, "https://research.example/helper");
  s.relaunch();
  setSystemTime(new Date(Date.now() + 1000));
  connect(s.sock);
  setSystemTime();
  await runAs(a.pid, () => callTool("tabs", {}), main);
  const restored = [...s.tabs.values()].find((tab) => tab.url === "https://research.example/legacy")!;
  await endTurn(a.pid, undefined, main);
  expect(s.tabs.has(restored.id)).toBe(false);
  expect([...s.tabs.values()].some((tab) => tab.url === "https://research.example/helper")).toBe(true);
  a.kill();
});

test("a stale saved group does not hide another live window of the same task", async () => {
  const s = safari();
  const before = await daemonOn(47368, "legacy-stale-before");
  const task = "legacy-stale";
  const stale = await runAs(process.pid, () => before.spaceWindow("old"), task);
  s.tabs.delete(pageIn(s.tabs, stale.window)!.id);
  const id = "live-legacy";
  const marker = s.ops["windows.open"]([`http://127.0.0.1:47368/space?id=${id}&name=live&size=1001x780`]) as { windowId: number };
  const live = { ...stale, id, name: "live", window: marker.windowId, proof: undefined, key: JSON.stringify([process.pid, task, "new"]) };
  const path = join(dir, "legacy-stale.json");
  writeFileSync(path, JSON.stringify({ version: 2, spaces: [{ ...stale, key: JSON.stringify([process.pid, task, "old"]) }, live] }));
  const after = await daemonOn(47368, "legacy-stale-after");
  after.loadSpaces(path, () => true);
  const reused = await runAs(process.pid, () => after.spaceWindow("new"), task);
  expect(reused.window).toBe(live.window);
  expect(new Set([...s.tabs.values()].map((tab) => tab.windowId)).size).toBe(2);
});

test("an exited agent's kept page and window remain intact without disposable completion authority", async () => {
  const s = safari();
  const c = agent();
  const his = await runAs(c.pid, () => openTab("https://hotel.example/booking", false));
  const page = pageIn(s.tabs, his.windowId)!;
  c.kill();
  await c.exited;
  await turnEnded(c.pid);
  expect(s.tabs.has(his.id)).toBe(true);
  expect(s.closed.filter(tab => tab === page.id || tab === his.id)).toEqual([]);
});

// From 10-14 to 10-19 a window ended only at a turn end omp never sent, and
// every exited agent's window stayed in his Safari.
test("an exited agent's window that holds only its page closes without a turn end", async () => {
  const s = safari();
  const x = agent();
  const t = await runAs(x.pid, () => openTab("https://exit.example/", true));
  const page = pageIn(s.tabs, t.windowId)!;
  await runAs(x.pid, () => callTool("close", { tab: t.id }));
  x.kill();
  await x.exited;
  await until(() => s.closed.includes(page.id), 8000);
  expect(s.tabs.has(page.id)).toBe(false);
}, 15_000);

test("a copied marker URL does not authorize adopting or deleting an unknown group", async () => {
  const s = safari();
  const copied = { id: next++, url: `http://127.0.0.1:37334/space?title=foreign&owner=999999&id=unregistered`, windowId: next++, active: true };
  s.tabs.set(copied.id, copied);
  expect(await spaceTool({ op: "release", name: "foreign (agent 999999)" })).toEqual({ ok: false });
  expect(s.tabs.get(copied.id)).toEqual(copied);
  expect(s.closed).toEqual([]);
});

// 09-30: the windows of agents the user had stopped stayed open, each with
// only its page, for two minutes after their tabs had closed.
test("when an agent's turn ends its window closes with its tabs, unless it holds a tab it kept; a working agent's stays", async () => {
  const s = safari();
  const [keeper, working, done] = [agent(), agent(), agent()];
  const open = (who: { pid: number }, keep = false) => runAs(who.pid, () => callTool("open", { url: "https://turn.example/", background: true, keep })) as Promise<{ windowId: number }>;
  // One sweep looks at the windows in the order they opened: done's last,
  // so the others have been looked at once its page closes.
  const windows = [await open(keeper, true), await open(working), await open(done)].map((t) => t.windowId);
  const pages = windows.map((w) => pageIn(s.tabs, w)!.id);
  endTurn(keeper.pid);
  endTurn(done.pid);
  await until(() => s.closed.includes(pages[2]), 8000);
  expect(pages.map((id) => s.closed.includes(id))).toEqual([false, false, true]);
  for (const p of [keeper, working, done]) p.kill();
  // The files after this one reuse these tab ids: the working agent's tab
  // closes at its cleanup.
  await endTurn(working.pid);
}, 15_000);

test("an agent whose window the user closed gets a new one on its next open", async () => {
  const s = safari();
  const d = agent();
  const first = await runAs(d.pid, () => openTab("https://d.example/1", true));
  for (const t of s.tabs.values()) if (t.windowId === first.windowId) s.tabs.delete(t.id);
  const next = await runAs(d.pid, () => openTab("https://d.example/2", true));
  expect(next.windowId).not.toBe(first.windowId);
  expect(next.windowId).not.toBe(1);
  d.kill();
});

// 10-21: the sweep the extension's connect starts listed Safari's tabs,
// then judged by that list every window the daemon held, one an agent
// opened while Safari listed too: missing from the list, it ended as one
// the user had closed, and the agent's next tab opened another window.
test("a window an agent opens while a sweep lists Safari's tabs stays its window", async () => {
  const s = safari();
  const daemon = await daemonOn(47358, "listing");
  const [early, late] = [agent(), agent()];
  await runAs(early.pid, () => daemon.spaceWindow());
  const send = s.sock.send;
  let answer: (() => void) | undefined;
  s.sock.send = (data) => {
    const { id, op } = JSON.parse(data) as { id?: string; op: string };
    if (answer || op !== "tabs.list" || id === undefined) return send(data);
    const listed = [...s.tabs.values()];
    answer = () => bridge.handleMessage(JSON.stringify({ id, value: listed }));
  };
  const pass = daemon.sweep();
  await until(() => answer !== undefined);
  const first = await runAs(late.pid, () => daemon.spaceWindow());
  answer!();
  await pass;
  s.sock.send = send;
  const again = await runAs(late.pid, () => daemon.spaceWindow());
  expect(again.window).toBe(first.window);
  early.kill();
  late.kill();
});

// 10-21 audit: each call an agent made wrote the daemon's file of windows
// again, though only the time of its last call had moved, and that time
// counts in minutes (sweepOnce).
test("an agent's calls within a minute of its window's last write leave the daemon's file of windows unwritten", async () => {
  safari();
  const daemon = await daemonOn(47359, "calls");
  const q = agent();
  const path = join(dir, "calls.json");
  daemon.loadSpaces(path, () => true);
  await runAs(q.pid, () => daemon.spaceWindow());
  writeFileSync(path, "as left");
  for (let i = 0; i < 3; i++) daemon.turnResumed(q.pid);
  expect(readFileSync(path, "utf8")).toBe("as left");
  q.kill();
});

// 10-23 review: the file waited for a call a minute after the one before,
// and each call moved that time, so a window called every 30 s kept in the
// file the time it opened, and a daemon that started again closed it as
// unused.
test("an agent's window called every 30 s keeps its last use in the daemon's file of windows within a minute", async () => {
  safari();
  const daemon = await daemonOn(47360, "used");
  const q = agent();
  const path = join(dir, "used.json");
  daemon.loadSpaces(path, () => true);
  await runAs(q.pid, () => daemon.spaceWindow());
  const start = Date.now();
  const behind: number[] = [];
  try {
    for (let at = 30_000; at <= 25 * 60_000; at += 30_000) {
      setSystemTime(new Date(start + at));
      daemon.turnResumed(q.pid);
      const { spaces } = JSON.parse(readFileSync(path, "utf8")) as { spaces: Spaces.Space[] };
      behind.push(start + at - spaces[0]!.used!);
    }
  } finally {
    setSystemTime();
  }
  q.kill();
  expect(Math.max(...behind)).toBeLessThanOrEqual(60_000);
});

// 10-07: an agent sizing its tab for a screenshot split it from its window
// into one that named no agent. Its own window takes the size, and the
// keeper, which finds the window by size, is told the size Safari gave it.
test("an agent sizing its tab sizes its own window, which the keeper then looks for at Safari's size; a user's tab leaves his window alone", async () => {
  const s = safari();
  const h = agent();
  const t = await runAs(h.pid, () => openTab("https://h.example/", true));
  // the keeper looks only for a window holding several tabs
  for (const site of ["h2", "h3"]) await runAs(h.pid, () => openTab(`https://${site}.example/`, true));
  await runAs(h.pid, () => callTool("window", { tab: t.id, width: 390, height: 844 }));
  await callTool("window", { tab: 1, width: 390, height: 844 });
  const { spaces } = (await spaceTool({ op: "state" })) as { spaces: { name: string; width: number; height: number }[] };
  expect(spaces.find((x) => x.name === t.space.name)).toMatchObject({ width: 390, height: 845 });
  expect(s.sized).toEqual([{ tab: t.id, whole: true }, { tab: 1, whole: false }]);
  h.kill();
});

// 10-07: every agent window became a tab group, a one-page look included,
// and the keeper missed 55 of 91 deletes as the user worked, each miss an
// empty window left in his Safari. A window with fewer tabs stays plain and
// closes with them.
test("an agent's window is the keeper's to make a tab group of only once it holds three of the agent's tabs", async () => {
  safari();
  const g = agent();
  const offered = async () => {
    // the keeper's view of the windows (spaceTool state, spaces.ts)
    const state = (await spaceTool({ op: "state" })) as { spaces: { name: string }[] };
    return state.spaces.map((x) => x.name);
  };
  const first = await runAs(g.pid, () => openTab("https://g1.example/", true));
  await runAs(g.pid, () => openTab("https://g2.example/", true));
  expect(await offered()).not.toContain(first.space.name);
  await runAs(g.pid, () => openTab("https://g3.example/", true));
  expect(await offered()).toContain(first.space.name);
  g.kill();
});

// A deploy reloads the extension, and Safari renumbers every window: before,
// the agent's next tab went into a second window, and the first one's page
// stayed open for good.
test("after an extension reload an agent rejoins its old window, which closes after admitted empty cleanup", async () => {
  const s = safari();
  const e = agent();
  const first = await runAs(e.pid, () => openTab("https://e.example/1", true));
  s.reload();
  const window = s.tabs.get(s.oldTabs.get(first.id)!)!.windowId;
  const next = await runAs(e.pid, () => openTab("https://e.example/2", true));
  expect(next.windowId).toBe(window);
  const page = pageIn(s.tabs, window)!;
  e.kill();
  await callTool("close", { tab: first.id });
  await callTool("close", { tab: next.id });
  await turnEnded(e.pid);
  await until(() => s.closed.includes(page.id));
});

// On 10-05 every agent's window was lost three times as Safari or its
// extension started again: their tabs stayed behind in windows no one
// owned, and each agent's next tab opened another window. The tech-week
// sign-up agent went through five windows in two hours.
test("after Safari starts again an agent rejoins its old window, which closes after admitted empty cleanup", async () => {
  const s = safari();
  const r = agent();
  const first = await runAs(r.pid, () => openTab("https://r.example/1", true));
  const address = pageIn(s.tabs, first.windowId)!.url;
  s.relaunch();
  const page = [...s.tabs.values()].find((t) => t.url === address)!;
  const next = await runAs(r.pid, () => openTab("https://r.example/2", true));
  expect(next.windowId).toBe(page.windowId);
  r.kill();
  for (const t of s.tabs.values()) if (t.windowId === next.windowId && !t.url.includes("/space?")) await callTool("close", { tab: t.id });
  await turnEnded(r.pid);
  await until(() => s.closed.includes(page.id));
});

// 10-05: three restarts of Safari each left one agent's tabs behind, under
// new ids no one owned, in windows that read as the user's: 22 by the
// afternoon, closed only by hand.
test("restored tabs retain exact ownership across admitted cleanup and later model reuse", async () => {
  const s = safari();
  const [r, q] = [agent(), agent()];
  const open = async (who: Bun.Subprocess, url: string) => {
    const t = await runAs(who.pid, () => callTool("open", { url, background: true }, true));
    if (!t || typeof t !== "object" || !("id" in t) || typeof t.id !== "number") throw new Error(`open answered ${JSON.stringify(t)}`);
    return t.id;
  };
  await open(r, "https://r.example/1");
  await open(q, "https://q.example/1");
  s.relaunch();
  // the extension connects again, a moment later
  setSystemTime(new Date(Date.now() + 1000));
  connect(s.sock);
  setSystemTime();
  const now = (url: string) => [...s.tabs.values()].find((t) => t.url === url)!.id;
  const [mine, theirs] = [now("https://r.example/1"), now("https://q.example/1")];
  q.kill();
  await endTurn(q.pid);
  await until(() => s.closed.includes(theirs));
  expect(await open(r, "https://r.example/2")).toBe(mine);
  expect(s.closed).not.toContain(mine);
  r.kill();
  await endTurn(r.pid);
  await until(() => s.closed.includes(mine));
});

// A kept page blocks group deletion. Cleanup cannot move protected or
// foreign tabs merely to make the remaining window disposable.
test("a grouped window containing a kept page remains intact and cannot be adopted for deletion", async () => {
  const s = safari();
  const g = agent();
  const his = await runAs(g.pid, () => openTab("https://hotel.example/booking", false, "trip"));
  const { name } = his.space;
  expect(his.space).toEqual({ name: `trip (agent ${g.pid})`, group: "waiting" });
  await spaceTool({ op: "grouped", name });
  const page = pageIn(s.tabs, his.windowId)!;
  g.kill();
  await g.exited;
  await turnEnded(g.pid);
  const { spaces } = (await spaceTool({ op: "state" })) as { spaces: { name: string; ended: boolean }[] };
  expect(spaces.filter((x) => x.name === name)).toMatchObject([{ ended: false }]);
  expect(await spaceTool({ op: "release", name })).toEqual({ ok: false });
  expect(s.tabs.get(his.id)!.windowId).toBe(his.windowId!);
  expect(s.closed).not.toContain(page.id);
  expect(s.tabs.get(page.id)!.windowId).toBe(his.windowId!);
});

test("an ended narrow grouped window closes before the keeper removes its tab group", async () => {
  const s = safari();
  const g = agent();
  const t = await runAs(g.pid, () => openTab("https://m.example/", true, "phone"));
  const { name } = t.space;
  await spaceTool({ op: "grouped", name });
  await runAs(g.pid, () => callTool("window", { tab: t.id, width: 390, height: 844 }));
  const page = pageIn(s.tabs, t.windowId)!;
  g.kill();
  await g.exited;
  await callTool("close", { tab: t.id });
  await turnEnded(g.pid);
  expect(s.tabs.has(page.id)).toBe(false);
  expect(await spaceTool({ op: "release", name })).toMatchObject({ ok: true, tabs: 0, left: 0 });
  await spaceTool({ op: "gone", name });
});

// 10-30: Safari keeps a tab group from emptying, so closing an ended
// group's page left a blank tab, which release counted as a page left; six
// groups stood in his sidebar for hours.
test("an ended group holding only the blank tab Safari leaves releases as empty, and a blank beside another tab does not", async () => {
  const s = safari();
  const g = agent();
  const t = await runAs(g.pid, () => openTab("https://blank.example/", true, "blank"));
  const { name } = t.space;
  await spaceTool({ op: "grouped", name });
  g.kill();
  await g.exited;
  await callTool("close", { tab: t.id });
  await turnEnded(g.pid);
  expect(pageIn(s.tabs, t.windowId)).toBeUndefined();
  s.tabs.set(990001, { id: 990001, url: "", windowId: t.windowId, active: true });
  expect(await spaceTool({ op: "release", name })).toMatchObject({ ok: true, tabs: 1, left: 0 });
  s.tabs.set(990002, { id: 990002, url: "https://other.example/", windowId: t.windowId, active: false });
  expect(await spaceTool({ op: "release", name })).toMatchObject({ ok: true, tabs: 2, left: 2 });
  await spaceTool({ op: "gone", name });
});

// An agent that finishes in a second exits while the keeper makes its
// window's group: before, the daemon closed the window under the steps, and
// a group named for the task, or Untitled, stayed in the sidebar.
test("an admitted empty cleanup during group creation waits for the keeper's result", async () => {
  const s = safari();
  const [g, p] = [agent(), agent()];
  const made = await runAs(g.pid, () => openTab("https://made.example/", true, "made"));
  const failed = await runAs(p.pid, () => openTab("https://failed.example/", true, "failed"));
  const pages = [made, failed].map((t) => pageIn(s.tabs, t.windowId)!.id);
  for (const t of [made, failed]) expect(await spaceTool({ op: "making", name: t.space.name })).toEqual({ ok: true });
  g.kill();
  p.kill();
  await Promise.all([g.exited, p.exited]);
  await callTool("close", { tab: made.id });
  await callTool("close", { tab: failed.id });
  await Promise.all([turnEnded(g.pid), turnEnded(p.pid)]);
  expect(pages.map((id) => s.closed.includes(id))).toEqual([false, false]);
  await spaceTool({ op: "grouped", name: made.space.name });
  await spaceTool({ op: "plain", name: failed.space.name, why: "the new group took no name" });
  expect(pages.map((id) => s.closed.includes(id))).toEqual([true, true]);
  const { spaces } = (await spaceTool({ op: "state" })) as { spaces: { name: string; ended: boolean }[] };
  expect(spaces.filter((x) => x.name === made.space.name || x.name === failed.space.name)).toMatchObject([{ name: made.space.name, ended: true }]);
  await spaceTool({ op: "gone", name: made.space.name });
});

// 09-30: a blank tab Safari made while the keeper made a window's tab group
// went to an agent as a page's popup (01a0f14c). The extension leaves out
// tabs made in that window while it holds the keeper to be at work there.
test("the extension hears a window's tab group is being made from making until the keeper says how that went", async () => {
  const s = safari();
  const g = agent();
  const t = await runAs(g.pid, () => openTab("https://grouping.example/", true, "grouping"));
  const { name } = t.space;
  expect(await spaceTool({ op: "making", name })).toEqual({ ok: true });
  expect([...s.regrouping]).toEqual([t.windowId]);
  await spaceTool({ op: "plain", name, why: "the new group took no name" });
  expect([...s.regrouping]).toEqual([]);
  const page = pageIn(s.tabs, t.windowId)!;
  g.kill();
  await callTool("close", { tab: t.id });
  await turnEnded(g.pid);
  await until(() => s.closed.includes(page.id));
});

// A deploy restarts the daemon while a long-lived agent's window is its
// group: the agent's next window was named alike, the keeper waited on the
// old group for good, and the old group's queue entry went with the wait.
test("an agent's window takes a name no group still to be deleted has", async () => {
  safari();
  const q = agent();
  changeQueue((x) => (x[`agent ${q.pid}`] = { owner: q.pid, since: 0 }));
  const t = await runAs(q.pid, () => openTab("https://q.example/", true));
  expect(t.space.name).toBe(`agent ${q.pid}, window 2`);
  q.kill();
});

// A deploy restarts the daemon. It forgot every agent window: the agent's
// next tab opened a second window, and the first stayed open for good,
// its page left behind when the agent exited.
test("a restarted daemon puts an agent's next tab in the window it already had", async () => {
  const s = safari();
  const q = agent();
  const saved = join(dir, "spaces.json");
  // The daemon before the restart and the one after.
  const first = await daemonOn(47340, "first");
  const restarted = await daemonOn(47340, "restarted");
  first.loadSpaces(saved, () => true);
  const before = await runAs(q.pid, () => first.spaceWindow());
  restarted.loadSpaces(saved, () => true);
  const after = await runAs(q.pid, () => restarted.spaceWindow());
  expect(after.window).toBe(before.window);
  q.kill();
  await Promise.all([first.turnEnded(q.pid), restarted.turnEnded(q.pid)]);
  // Both have saved by the time the page closes, before the folder goes.
  await until(() => !pageIn(s.tabs, before.window));
});

test.each(["spaces", "closing", "ended"] as const)("a saved %s window without admitted completion preserves a living owner's work", async phase => {
  const s = safari();
  const q = agent();
  const path = join(dir, `admission-${phase}.json`);
  const first = await daemonOn(47343, `before-${phase}`);
  const restarted = await daemonOn(47343, `after-${phase}`);
  try {
    first.loadSpaces(path, () => true);
    const owned = await runAs(q.pid, () => first.spaceWindow());
    const page = pageIn(s.tabs, owned.window)!;
    const stored = JSON.parse(readFileSync(path, "utf8")) as { spaces: Spaces.Space[] };
    const record: Spaces.Space = { ...stored.spaces[0], group: phase === "closing" ? "grouped" : "plain" };
    writeFileSync(path, JSON.stringify({ version: 2, spaces: [], closing: [], ended: [], [phase]: [record] }));
    const content = { id: next++, url: "https://working.example/", windowId: owned.window, active: false };
    s.tabs.set(content.id, content);
    restarted.loadSpaces(path, tracksOwner);
    await restarted.turnEnded(q.pid + 1);
    expect(s.tabs.has(page.id)).toBe(true);
    expect(s.closed).not.toContain(page.id);
    expect(await restarted.spaceTool({ op: "release", name: owned.name })).toEqual({ ok: false });
    const retained = JSON.parse(readFileSync(path, "utf8")) as Record<typeof phase, Spaces.Space[]>;
    const expected: Spaces.Space = { ...record };
    expect(retained[phase]).toStrictEqual([expected]);
    s.tabs.delete(content.id);
    await restarted.turnEnded(q.pid);
    if (phase === "closing") {
      expect(await restarted.spaceTool({ op: "release", name: owned.name })).toMatchObject({ ok: true, left: 0 });
      restarted.turnResumed(q.pid);
      expect(await restarted.spaceTool({ op: "release", name: owned.name })).toEqual({ ok: false });
      expect(s.tabs.has(page.id)).toBe(true);
    } else {
      expect(s.tabs.has(page.id)).toBe(false);
    }
  } finally {
    q.kill();
    await q.exited;
  }
});

test.each(["spaces", "closing", "ended"] as const)("a restart closes an empty untracked %s window while its owner is still alive", async phase => {
  const s = safari();
  const owner = agent();
  const path = join(dir, `empty-untracked-${phase}.json`);
  const first = await daemonOn(47358, `empty-before-${phase}`);
  const restarted = await daemonOn(47358, `empty-after-${phase}`);
  try {
    first.loadSpaces(path, () => true);
    const owned = await runAs(owner.pid, () => first.spaceWindow());
    const page = pageIn(s.tabs, owned.window)!;
    const stored = JSON.parse(readFileSync(path, "utf8")) as { spaces: Spaces.Space[] };
    const record: Spaces.Space = { ...stored.spaces[0], group: phase === "closing" ? "grouped" : "plain" };
    writeFileSync(path, JSON.stringify({ version: 2, spaces: [], closing: [], ended: [], [phase]: [record] }));
    restarted.loadSpaces(path, tracksOwner);
    await restarted.turnEnded(owner.pid + 1);
    expect(s.tabs.has(page.id)).toBe(false);
    expect(s.tabs.has(1)).toBe(true);
    expect(owner.exitCode).toBeNull();
  } finally {
    owner.kill();
    await owner.exited;
  }
});

test("a restarted daemon closes an untracked status page without closing other pages in its window", async () => {
  const s = safari();
  const daemon = await daemonOn(47341, "lost");
  s.tabs.set(900, { id: 900, url: "http://127.0.0.1:47341/space?id=gone&name=agent%2050573&size=1100x800", windowId: 901, active: true });
  s.tabs.set(902, { id: 902, url: "https://kept.example/", windowId: 901, active: false });
  daemon.loadSpaces(join(dir, "lost.json"), () => false);
  await daemon.turnEnded(process.pid);
  expect(s.tabs.has(900)).toBe(false);
  expect([1, 902].map(id => s.tabs.has(id))).toEqual([true, true]);
  expect(s.closed).toEqual([900]);
});

test("untracked status cleanup closes copied and queued status pages without claiming their other tabs", async () => {
  const s = safari();
  const daemon = await daemonOn(47342, "kept");
  const page = (id: number, query: string, windowId: number) => s.tabs.set(id, { id, url: `http://127.0.0.1:47342/space?${query}`, windowId, active: true });
  changeQueue((q) => (q["trip (agent 4242)"] = { since: 0 }));
  try {
    page(910, "id=his&name=agent%204241", 1);
    page(911, "id=queued&name=trip%20(agent%204242)&size=1100x800", 912);
    page(913, "id=lost&name=agent%204243&size=1101x800", 914);
    s.tabs.set(915, { id: 915, url: "https://example.com/kept", windowId: 912, active: false });
    daemon.loadSpaces(join(dir, "kept.json"), () => false);
    await daemon.turnEnded(process.pid);
    expect(s.closed).toEqual([910, 911, 913]);
    expect([1, 915].map(id => s.tabs.has(id))).toEqual([true, true]);
    expect([910, 911, 913].map(id => s.tabs.has(id))).toEqual([false, false, false]);
    expect(readQueue()["trip (agent 4242)"]).toBeDefined();
  } finally {
    changeQueue((q) => delete q["trip (agent 4242)"]);
  }
}, 15_000);

// A turn's end with no window to watch asked Safari for its tabs, and
// nothing read the list. In a full test run such a list reached the next
// file's Safari, which counts the lists it is asked for (tools-wait.test.ts).
test("a turn's end with no window to watch asks Safari nothing", async () => {
  const s = safari();
  const daemon = await daemonOn(47344, "idle");
  const list = s.ops["tabs.list"];
  let lists = 0;
  s.ops["tabs.list"] = (args) => {
    lists++;
    return list(args);
  };
  await daemon.turnEnded(process.pid);
  expect(lists).toBe(0);
});

// A window the user closed before its agent's turn ended waits for that
// turn's end, which sweeps by itself. Meanwhile every sweep, each 5 s, asked
// Safari for its tabs for as long as the daemon ran, and nothing read them.
test("a window closed before its agent's turn ended leaves the sweep asking Safari nothing", async () => {
  const s = safari();
  const daemon = await daemonOn(47345, "closed");
  const q = agent();
  try {
    const owned = await runAs(q.pid, () => daemon.spaceWindow());
    for (const t of s.tabs.values()) if (t.windowId === owned.window) s.tabs.delete(t.id);
    // A pass finds the window gone; it ends, and waits for its agent's turn.
    await daemon.turnEnded(process.pid);
    const list = s.ops["tabs.list"];
    let lists = 0;
    s.ops["tabs.list"] = (args) => {
      lists++;
      return list(args);
    };
    await daemon.turnEnded(process.pid);
    expect(lists).toBe(0);
  } finally {
    await daemon.turnEnded(q.pid);
    q.kill();
  }
});

test("the tab group keeper's questions ask nothing of a quit Safari", async () => {
  const s = safari();
  const h = agent();
  const t = await runAs(h.pid, () => openTab("https://h.example/", true, "quit"));
  bridge.detach(s.sock);
  const request = bridge.request;
  const asked: unknown[] = [];
  bridge.request = (...args: Parameters<typeof request>) => {
    asked.push(args[0]);
    return Promise.reject(new Error("Safari is quit"));
  };
  try {
    expect(await spaceTool({ op: "state" })).toMatchObject({ connected: false });
    expect(await spaceTool({ op: "release", name: t.space.name })).toEqual({ ok: false });
    expect(await spaceTool({ op: "scratch" })).toEqual({ ok: false });
    expect(asked).toEqual([]);
  } finally {
    bridge.request = request;
    connect(s.sock);
  }
  h.kill();
});

// He quit Safari: asking it anything would start it again. An exited
// agent's page then waits, unasked, for the extension to come back.
test("an agent exit with Safari disconnected preserves its protected window and page after reconnect", async () => {
  const s = safari();
  const f = agent();
  const first = await runAs(f.pid, () => openTab("https://f.example/1", true));
  const page = pageIn(s.tabs, first.windowId)!;
  bridge.detach(s.sock);
  const request = bridge.request;
  const asked: unknown[] = [];
  bridge.request = (...args: Parameters<typeof request>) => {
    asked.push(args[0]);
    return Promise.reject(new Error("Safari is quit"));
  };
  try {
    f.kill();
    await turnEnded(f.pid);
    expect(asked).toEqual([]);
  } finally {
    bridge.request = request;
    connect(s.sock);
  }
  await turnEnded(f.pid);
  expect(s.closed).not.toContain(page.id);
  expect(s.tabs.has(first.id)).toBe(true);
}, 15_000);

// An ended window whose page's close fails, with the page's own id for
// spaceEnded; fail throws the extension's answer to that close.
async function unclosable(fail: () => never) {
  const s = safari();
  const a = agent();
  const t = await runAs(a.pid, () => openTab("https://unclosable.example/", true));
  const page = pageIn(s.tabs, t.windowId)!;
  const close = s.ops["tabs.close"];
  let asked = 0;
  s.ops["tabs.close"] = (args) => {
    if (args[0] !== page.id) return close(args);
    asked++;
    return fail();
  };
  await callTool("close", { tab: t.id });
  a.kill();
  await a.exited;
  return { pid: a.pid, id: new URL(page.url).searchParams.get("id")!, asked: () => asked };
}

// In the daemon log of 09-30 to 10-16 about 55 closes of lost windows
// failed as "that tab is gone": the page had closed already, and each
// sweep asked again.
test("an ended window whose page Safari says is already gone is closed, and not asked again", async () => {
  const w = await unclosable(() => {
    throw new Error("that tab is gone: Safari knows no tab by that id");
  });
  await turnEnded(w.pid);
  await turnEnded(w.pid);
  expect({ asked: w.asked(), ended: spaceEnded(w.id) }).toEqual({ asked: 1, ended: false });
});

// One lost window's close failed 69 times in 5.7 min, a try each sweep; a
// page left after its third try stayed open until the daemon restarted.
test("an ended window whose page Safari will not close is asked again after one, two and four minutes, then every 15", async () => {
  let now = Date.now();
  const tries: number[] = [];
  const start = now;
  const w = await unclosable(() => {
    tries.push(now - start);
    throw new Error("Safari did not close the tab: a native sheet (a sign-in or permission prompt) or a window off screen holds it. Tell the user; closing again will not help");
  });
  try {
    for (const at of [0, 59_000, 60_000, 179_000, 180_000, 419_000, 420_000, 1_319_000, 1_320_000]) {
      now = start + at;
      setSystemTime(new Date(now));
      await turnEnded(w.pid);
    }
  } finally {
    setSystemTime();
  }
  expect({ tries, ended: spaceEnded(w.id) }).toEqual({ tries: [0, 60_000, 180_000, 420_000, 1_320_000], ended: true });
});

// On 10-28 and 10-29 the journal noted 149 agents' cleanups failed by the
// extension's link dropping in 18 hours.
test("an ended window whose page close the extension's link took down closes as soon as it connects again", async () => {
  const s = safari();
  const a = agent();
  const t = await runAs(a.pid, () => openTab("https://dropped.example/", true));
  const page = pageIn(s.tabs, t.windowId)!;
  const close = s.ops["tabs.close"];
  s.ops["tabs.close"] = (args) => {
    if (args[0] !== page.id) return close(args);
    s.ops["tabs.close"] = close;
    bridge.detach(s.sock);
    throw new Error("never answered: the link is down");
  };
  await callTool("close", { tab: t.id });
  a.kill();
  await a.exited;
  await turnEnded(a.pid);
  expect(s.closed).not.toContain(page.id);
  connect(s.sock);
  await until(() => s.closed.includes(page.id));
});

// On 10-23 ended agents' windows stayed open through restarts, and nothing
// in safari status --journal said so.
test("a window that holds only its page five minutes after its task ended is noted in the journal once", async () => {
  const start = Date.now();
  const w = await unclosable(() => {
    throw new Error("Safari did not close the tab: a native sheet (a sign-in or permission prompt) or a window off screen holds it. Tell the user; closing again will not help");
  });
  const noted: number[] = [];
  try {
    for (const at of [0, 299_000, 300_000, 1_500_000]) {
      setSystemTime(new Date(start + at));
      await turnEnded(w.pid);
      noted.push(recent(2000).filter((e) => e.kind === "agent window whose task ended over 5 min ago is still open" && e.owner === w.pid).reduce((n, e) => n + (typeof e.n === "number" ? e.n : 1), 0));
    }
  } finally {
    setSystemTime();
  }
  expect(noted).toEqual([0, 0, 1, 1]);
});

// Between the tries of a close that failed, every 5 s sweep asked Safari for
// its tabs to find a page it was not yet to close again.
test("an ended window waiting to try its close again asks Safari nothing until the try is due", async () => {
  const s = safari();
  const daemon = await daemonOn(47346, "backoff");
  const q = agent();
  const owned = await runAs(q.pid, () => daemon.spaceWindow());
  const page = pageIn(s.tabs, owned.window)!;
  const [close, list] = [s.ops["tabs.close"], s.ops["tabs.list"]];
  const start = Date.now();
  const tries: number[] = [];
  let now = start;
  let lists = 0;
  s.ops["tabs.close"] = (args) => {
    if (args[0] !== page.id) return close(args);
    tries.push(now - start);
    throw new Error("Safari did not close the tab: a native sheet (a sign-in or permission prompt) or a window off screen holds it. Tell the user; closing again will not help");
  };
  s.ops["tabs.list"] = (args) => {
    lists++;
    return list(args);
  };
  const pass = async (at: number) => {
    now = start + at;
    setSystemTime(new Date(now));
    await daemon.turnEnded(q.pid);
  };
  try {
    await pass(0);
    const waiting = lists;
    await pass(59_000);
    expect(lists).toBe(waiting);
    await pass(60_000);
    expect(tries).toEqual([0, 60_000]);
  } finally {
    // The third try, two minutes on, closes the page: the window is gone.
    s.ops["tabs.close"] = close;
    await pass(180_000);
    setSystemTime();
    q.kill();
  }
});

// A stuck extension (bridge.ts) answers no list; the keeper stopped at
// the error, where it waits for a quit Safari.
test("the keeper's look at the windows tells it Safari is away while the extension answers no list", async () => {
  safari();
  const k = agent();
  await runAs(k.pid, () => openTab("https://stuck.example/", true));
  const request = bridge.request;
  bridge.request = () => Promise.reject(new Error("extension stuck: the Safari extension has answered none of the last 2 tabs.list requests (for 10 s); try again in a minute"));
  try {
    expect(await spaceTool({ op: "state" })).toMatchObject({ connected: false });
  } finally {
    bridge.request = request;
  }
  expect(await spaceTool({ op: "state" })).toMatchObject({ connected: true });
  k.kill();
});

// On 10-16 an open failed "extension request tabs.list timed out after
// 5000ms" as it looked for its agent's window, on a Mac too loaded for
// Safari to list its tabs in 5 s (smoke run after the deploy).
test("an open goes on in its agent's window while Safari lists no tabs, and fails at once when the extension is stuck", async () => {
  const s = safari();
  const o = agent();
  const first = await runAs(o.pid, () => openTab("https://slow.example/1", true));
  const request = bridge.request;
  let stuck = false;
  // tabs.list's 5 s limit, cut to 50 ms
  bridge.request = (op, args, ms) => (stuck && op === "tabs.list" ? Promise.reject(new Error("extension stuck: the Safari extension has answered none of the last 2 tabs.list requests (for 10 s); try again in a minute")) : request.call(bridge, op, args, op === "tabs.list" ? 50 : ms));
  s.silent.add("tabs.list");
  try {
    const next = await runAs(o.pid, () => openTab("https://slow.example/2", true));
    expect(next.windowId).toBe(first.windowId);
    stuck = true;
    const tabs = s.tabs.size;
    await expect(runAs(o.pid, () => openTab("https://slow.example/3", true))).rejects.toThrow(/^extension stuck: /);
    expect(s.tabs.size).toBe(tabs);
  } finally {
    bridge.request = request;
    s.silent.clear();
    o.kill();
  }
});

test.each([{ registered: false, port: 47356 }, { registered: true, port: 47357 }])("untracked status close failures back off to every 15 minutes (registered=$registered)", async ({ registered, port }) => {
  const s = safari();
  const daemon = await daemonOn(port, `untracked-backoff-${registered}`);
  const owner = agent();
  const page = registered
    ? pageIn(s.tabs, (await runAs(owner.pid, () => daemon.spaceWindow())).window)!
    : { id: next++, url: `http://127.0.0.1:${port}/space?id=blocked&name=blocked&size=1100x800`, windowId: next++, active: true };
  if (!registered) s.tabs.set(page.id, page);
  const healthy = { id: next++, url: `http://127.0.0.1:${port}/space?id=healthy&name=healthy&size=1101x800`, windowId: next++, active: true };
  s.tabs.set(healthy.id, healthy);
  const close = s.ops["tabs.close"];
  const start = Date.now();
  let now = start;
  const tries: number[] = [];
  s.ops["tabs.close"] = (args) => {
    if (args[0] !== page.id) return close(args);
    tries.push(now - start);
    throw new Error("Safari did not close the status page");
  };
  daemon.loadSpaces(join(dir, `untracked-backoff-${registered}.json`), () => false);
  try {
    for (const at of [0, 59_000, 60_000, 179_000, 180_000, 419_000, 420_000, 1_319_000, 1_320_000]) {
      now = start + at;
      setSystemTime(new Date(now));
      daemon.inspectUntrackedWindows();
      await daemon.turnEnded(owner.pid);
    }
    expect(tries).toEqual([0, 60_000, 180_000, 420_000, 1_320_000]);
    expect(s.tabs.has(healthy.id)).toBe(false);
    expect(s.tabs.has(1)).toBe(true);
  } finally {
    setSystemTime();
    s.ops["tabs.close"] = close;
    owner.kill();
    await owner.exited;
  }
});

// On 10-23 each open of /agents from an agent made it a window of its own.
test("an agent's open of the daemon's own page makes no window: a plain tab without one, else a tab in its window", async () => {
  const s = safari();
  const a = agent();
  const windows = () => [...s.tabs.values()].filter((t) => t.url.includes("/space?")).length;
  try {
    const before = windows();
    const plain = await runAs(a.pid, () => callTool("open", { url: "http://127.0.0.1:37334/agents", background: true })) as { id: number };
    expect({ windows: windows(), window: s.tabs.get(plain.id)?.windowId }).toEqual({ windows: before, window: 1 });
    const work = await runAs(a.pid, () => openTab("https://work.example/", true));
    const memory = await runAs(a.pid, () => callTool("open", { url: "http://127.0.0.1:37334/memory", background: true })) as { id: number };
    expect({ windows: windows(), window: s.tabs.get(memory.id)?.windowId }).toEqual({ windows: before + 1, window: work.windowId });
  } finally {
    a.kill();
    await a.exited;
    await endTurn(a.pid);
  }
});

// The windows on /agents close an ended agent's window after asking; an
// agent asked to clear such windows had no way to (10-23).
test("close {window} asks first, then closes an untracked agent's window with its kept page, and refuses a working agent's", async () => {
  const s = safari();
  const daemon = await daemonOn(47480, "close-window");
  const [gone, working] = [agent(), agent()];
  daemon.loadSpaces(join(dir, "close-window.json"), (o) => (o === working.pid ? true : undefined));
  try {
    const ended = await runAs(gone.pid, () => daemon.spaceWindow());
    const busy = await runAs(working.pid, () => daemon.spaceWindow());
    const kept = { id: next++, url: "https://kept.example/", windowId: ended.window, active: false };
    s.tabs.set(kept.id, kept);
    gone.kill();
    await gone.exited;
    expect(await daemon.closeWindow(ended.window, false)).toMatchObject({ ok: false, ask: "Close this window and all its tabs, including kept pages?" });
    expect(s.tabs.has(kept.id)).toBe(true);
    expect(await daemon.closeWindow(ended.window, true)).toEqual({ ok: true, closed: 1, remaining: 0 });
    expect([...s.tabs.values()].filter((t) => t.windowId === ended.window)).toEqual([]);
    await expect(daemon.closeWindow(busy.window, true)).rejects.toThrow(`window ${busy.window} is agent ${working.pid}'s, which is still working`);
    expect(pageIn(s.tabs, busy.window)).toBeDefined();
  } finally {
    working.kill();
    await working.exited;
    await daemon.turnEnded(working.pid);
  }
});

// Every window state, restart, and owner kind, and what cleanup leaves of
// the window once its agent's task ends: on 10-23 an ended agent's windows
// stayed open through a daemon restart and an extension reload, and a
// window closed under the keeper while it made the window's group (HD-3).
// Each case writes the saved records itself, so no other daemon's sweep
// closes its page first.
const STATES = ["making", "active", "closing", "ended", "kept"] as const;
const RESTARTS = ["none", "daemon", "Safari", "extension"] as const;
const OWNERS = ["main", "helper", "CLI", "untracked"] as const;
type Outcome = "closed" | "open" | "released" | "closed by the keeper";
const OUTCOMES: Record<(typeof STATES)[number], Record<(typeof OWNERS)[number], Outcome>> = {
  // The keeper's step on the window goes on; its answer ends the window.
  making: { main: "closed by the keeper", helper: "closed by the keeper", CLI: "closed by the keeper", untracked: "closed by the keeper" },
  active: { main: "closed", helper: "closed", CLI: "closed", untracked: "closed" },
  // The group goes to the keeper, which deletes it.
  closing: { main: "released", helper: "released", CLI: "released", untracked: "released" },
  ended: { main: "closed", helper: "closed", CLI: "closed", untracked: "closed" },
  // A page kept for the user holds a living agent's window; an exited
  // agent's label closes beside it.
  kept: { main: "open", helper: "open", CLI: "closed", untracked: "open" },
};
const CASES = STATES.flatMap((state) => RESTARTS.flatMap((restart) => OWNERS.map((owner) => ({ state, restart, owner, outcome: OUTCOMES[state][owner] }))))
  .map((c, i) => ({ ...c, port: 47400 + i }));

test.each(CASES)("a $state window of a $owner agent after a $restart restart: $outcome", async ({ state, restart, owner: kind, outcome, port }) => {
  const s = safari();
  const proc = agent();
  const pid = proc.pid;
  const task = kind === "main" ? "main" : kind === "helper" ? "helper" : undefined;
  const lost = restart === "daemon" || kind === "untracked";
  const window = (task: string | undefined, group: Spaces.Space["group"], extra: string[] = []) => {
    const id = `table-${port}-${task ?? "cli"}`;
    const windowId = next++;
    const size = { width: 1000 + (port % 250), height: task === "main" && kind === "helper" ? 900 : 800 };
    const name = `${task ?? "cli"} (agent ${pid})`;
    const proof = `proof-${id}`;
    const page = { id: next++, url: `http://127.0.0.1:${port}/space?id=${id}&name=${encodeURIComponent(name)}&size=${size.width}x${size.height}`, windowId, active: true, history: { safariHarnessSpace: proof } };
    s.tabs.set(page.id, page);
    for (const url of extra) {
      const t = { id: next++, url, windowId, active: false };
      s.tabs.set(t.id, t);
    }
    const record: Spaces.Space = { key: task === undefined ? `${pid}:` : JSON.stringify([pid, task, ""]), id, window: windowId, name, size, owner: pid, ...(task === undefined ? {} : { task }), group, used: Date.now(), proof };
    return record;
  };
  const saved: { spaces: Spaces.Space[]; closing: Spaces.Space[]; ended: Spaces.Space[] } = { spaces: [], closing: [], ended: [] };
  if (kind === "helper") saved.spaces.push(window("main", "waiting", ["https://main.example/working"]));
  const own = window(task, state === "making" ? "making" : state === "closing" ? "grouped" : "waiting", state === "kept" ? ["https://kept.example/"] : []);
  if (state === "closing") saved.closing.push(own);
  else if (state === "ended") saved.ended.push(own);
  else saved.spaces.push(own);
  const pages = [...s.tabs.values()].filter((t) => t.url.includes("/space?")).map((t) => t.url);
  const open = (url: string) => [...s.tabs.values()].some((t) => t.url === url);
  const path = join(dir, `table-${port}.json`);
  writeFileSync(path, JSON.stringify({ version: 2, ...saved }));
  if (state === "making") writeFileSync(files.keeper, String(process.pid));
  const daemon = await daemonOn(port, `table-${port}`);
  try {
    daemon.loadSpaces(path, (o) => (o !== pid ? true : !alive(pid) ? false : lost ? undefined : true));
    if (restart === "Safari") s.relaunch();
    if (restart === "extension") s.reload();
    if (kind === "CLI") {
      proc.kill();
      await proc.exited;
    }
    await daemon.turnEnded(kind === "untracked" ? pid + 1 : pid, task);
    if (outcome === "closed by the keeper") {
      expect(open(pages.at(-1)!)).toBe(true);
      expect(await daemon.spaceTool({ op: "plain", name: own.name, why: "the group took no name" })).toEqual({ ok: true });
    }
    if (outcome === "released") expect(await daemon.spaceTool({ op: "release", name: own.name })).toMatchObject({ ok: true, left: 0 });
    else expect(open(pages.at(-1)!)).toBe(outcome === "open");
    expect(open("https://his.example/")).toBe(true);
    if (state === "kept") expect(open("https://kept.example/")).toBe(true);
    if (kind === "helper") expect(open(pages[0]) && open("https://main.example/working")).toBe(true);
  } finally {
    rmSync(files.keeper, { force: true });
    proc.kill();
    await proc.exited;
    await daemon.turnEnded(pid);
  }
}, 15_000);
