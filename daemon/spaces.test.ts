import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { changeQueue, files, turnOff } from "./groups.ts";
import { runAs, watchOwner } from "./owner.ts";
import { spaceTool } from "./spaces.ts";
import { openTab } from "./tools.ts";

// The keeper's files, away from the real ones (groups-off.json there would
// make every window plain).
const dir = mkdtempSync(join(tmpdir(), "spaces-test-"));
Object.assign(files, { queue: join(dir, "groups.json"), off: join(dir, "groups-off.json"), keeper: join(dir, "keeper.pid"), log: join(dir, "keeper.log") });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Tab = { id: number; url: string; windowId: number; active: boolean };

// Safari as the extension reports it, with the user's window 1 open.
function safari() {
  const tabs = new Map<number, Tab>([[1, { id: 1, url: "https://his.example/", windowId: 1, active: true }]]);
  const closed: number[] = [];
  // What the extension maps the ids it had before a reload to (adopt in
  // background.js).
  const oldTabs = new Map<number, number>();
  const oldWindows = new Map<number, number>();
  let next = 100;
  const ops: Record<string, (args: unknown[]) => unknown> = {
    "tabs.list": () => [...tabs.values()],
    "tabs.open": ([url, background, windowId]) => {
      const t = { id: next++, url: String(url), windowId: typeof windowId === "number" ? windowId : 1, active: !background };
      tabs.set(t.id, t);
      return t;
    },
    "windows.open": ([url]) => {
      const t = { id: next++, url: String(url), windowId: next++, active: true };
      tabs.set(t.id, t);
      return { windowId: t.windowId, tabId: t.id };
    },
    "windows.resolve": ([id]) => {
      const now = oldWindows.get(id as number) ?? (id as number);
      return [...tabs.values()].some((t) => t.windowId === now) ? now : null;
    },
    "tabs.close": ([id]) => {
      const now = oldTabs.get(id as number) ?? (id as number);
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
  };
  const sock: ExtSocket = {
    send(data) {
      const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
      if (id !== undefined) queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value: ops[op](args) })));
    },
    close() {},
  };
  connect(sock);
  // The extension reloads: every tab and window gets a new id.
  const reload = () => {
    const was = [...tabs.values()];
    tabs.clear();
    for (const t of was) {
      if (!oldWindows.has(t.windowId)) oldWindows.set(t.windowId, next++);
      oldTabs.set(t.id, next++);
      tabs.set(oldTabs.get(t.id)!, { ...t, id: oldTabs.get(t.id)!, windowId: oldWindows.get(t.windowId)! });
    }
  };
  return { tabs, closed, sock, reload, oldTabs };
}

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

test("when an agent exits its window's page closes, and a tab it opened for the user stays", async () => {
  const s = safari();
  const c = agent();
  const his = await runAs(c.pid, () => openTab("https://hotel.example/booking", false));
  const page = pageIn(s.tabs, his.windowId)!;
  c.kill();
  await until(() => s.closed.includes(page.id));
  expect(s.tabs.has(his.id)).toBe(true);
  expect(s.closed).not.toContain(his.id);
});

test("an agent whose window the user closed gets a new one on its next open", async () => {
  const s = safari();
  const d = agent();
  const first = await runAs(d.pid, () => openTab("https://d.example/1", true));
  for (const t of [...s.tabs.values()]) if (t.windowId === first.windowId) s.tabs.delete(t.id);
  const next = await runAs(d.pid, () => openTab("https://d.example/2", true));
  expect(next.windowId).not.toBe(first.windowId);
  expect(next.windowId).not.toBe(1);
  d.kill();
});

test("a window that stays plain says why on its first open, not on every open after", async () => {
  safari();
  turnOff("Safari's menu stayed open after delete");
  const e = agent();
  const first = await runAs(e.pid, () => openTab("https://e.example/1", true));
  const second = await runAs(e.pid, () => openTab("https://e.example/2", true));
  rmSync(files.off);
  expect(first.space).toMatchObject({ group: "plain", why: expect.stringContaining("menu stayed open") });
  expect(second.space).toEqual({ name: first.space.name, group: "plain" });
  e.kill();
});

// A deploy reloads the extension, and Safari renumbers every window: before,
// the agent's next tab went into a second window, and the first one's page
// stayed open for good.
test("after an extension reload an agent's next tab joins the window it had, whose page still closes when it exits", async () => {
  const s = safari();
  const e = agent();
  const first = await runAs(e.pid, () => openTab("https://e.example/1", true));
  s.reload();
  const window = s.tabs.get(s.oldTabs.get(first.id)!)!.windowId;
  const next = await runAs(e.pid, () => openTab("https://e.example/2", true));
  expect(next.windowId).toBe(window);
  const page = pageIn(s.tabs, window)!;
  e.kill();
  await until(() => s.closed.includes(page.id));
});

// Deleting a tab group closes its tabs: a tab the agent opened for the user
// has to leave the group's window first, and the page stays for the delete.
test("when a task whose window is a tab group ends, a tab it opened for the user moves out to a window of its own", async () => {
  const s = safari();
  const g = agent();
  const his = await runAs(g.pid, () => openTab("https://hotel.example/booking", false, "trip"));
  const { name } = his.space;
  expect(his.space).toEqual({ name: `trip (agent ${g.pid})`, group: "waiting" });
  await spaceTool({ op: "grouped", name });
  const page = pageIn(s.tabs, his.windowId)!;
  const marker = Bun.spawnSync(["true"]).pid;
  g.kill();
  await g.exited;
  // one owner sweep calls the watches in turn: the window's came first
  await new Promise<void>((resolve) => { const stop = watchOwner(marker, () => { stop(); resolve(); }); });
  const { spaces } = (await spaceTool({ op: "state" })) as { spaces: { name: string; ended: boolean }[] };
  expect(spaces.filter((x) => x.name === name)).toMatchObject([{ ended: true }]);
  expect(await spaceTool({ op: "release", name })).toMatchObject({ ok: true, tabs: 1, left: 0 });
  const moved = s.tabs.get(his.id)!.windowId;
  expect([moved === his.windowId, moved === 1]).toEqual([false, false]);
  expect(s.closed).not.toContain(page.id);
  expect(s.tabs.get(page.id)!.windowId).toBe(his.windowId!);
  await spaceTool({ op: "gone", name });
});

// An agent that finishes in a second exits while the keeper makes its
// window's group: before, the daemon closed the window under the steps, and
// a group named for the task, or Untitled, stayed in the sidebar.
test("a window whose agent exits while its group is being made stays until the keeper says how that went", async () => {
  const s = safari();
  const [g, p] = [agent(), agent()];
  const made = await runAs(g.pid, () => openTab("https://made.example/", true, "made"));
  const failed = await runAs(p.pid, () => openTab("https://failed.example/", true, "failed"));
  const pages = [made, failed].map((t) => pageIn(s.tabs, t.windowId)!.id);
  for (const t of [made, failed]) expect(await spaceTool({ op: "making", name: t.space.name })).toEqual({ ok: true });
  const marker = Bun.spawnSync(["true"]).pid;
  g.kill();
  p.kill();
  await Promise.all([g.exited, p.exited]);
  await new Promise<void>((resolve) => { const stop = watchOwner(marker, () => { stop(); resolve(); }); });
  expect(pages.map((id) => s.closed.includes(id))).toEqual([false, false]);
  await spaceTool({ op: "grouped", name: made.space.name });
  await spaceTool({ op: "plain", name: failed.space.name, why: "the new group took no name" });
  // the group goes the ended group's way; the window that is none closes
  expect(pages.map((id) => s.closed.includes(id))).toEqual([false, true]);
  const { spaces } = (await spaceTool({ op: "state" })) as { spaces: { name: string; ended: boolean }[] };
  expect(spaces.filter((x) => x.name === made.space.name || x.name === failed.space.name)).toMatchObject([{ name: made.space.name, ended: true }]);
  await spaceTool({ op: "gone", name: made.space.name });
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
  // Each daemon's spaces.ts, loaded afresh: the one before the restart and
  // the one after.
  const first = (await import(`./spaces.ts?first`)) as typeof import("./spaces.ts");
  const restarted = (await import(`./spaces.ts?restarted`)) as typeof import("./spaces.ts");
  first.loadSpaces(saved);
  const before = await runAs(q.pid, () => first.spaceWindow());
  restarted.loadSpaces(saved);
  const after = await runAs(q.pid, () => restarted.spaceWindow());
  expect(after.window).toBe(before.window);
  q.kill();
  // Both have saved by the time the page closes, before the folder goes.
  await until(() => !pageIn(s.tabs, before.window));
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
test("an agent's exit asks nothing of a quit Safari, and its window's page closes once Safari is back", async () => {
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
    const marker = Bun.spawnSync(["true"]).pid;
    f.kill();
    // one owner sweep calls the watches in turn: the window's came first
    await new Promise<void>((resolve) => { const stop = watchOwner(marker, () => { stop(); resolve(); }); });
    expect(asked).toEqual([]);
  } finally {
    bridge.request = request;
    connect(s.sock);
  }
  // The next space sweep closes it, within 5 s on the real clock: the sweep
  // runs on an interval the first open of this file started, before any fake
  // clock could take it over.
  await until(() => s.closed.includes(page.id), 8000);
}, 15_000);
