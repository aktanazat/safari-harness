import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { changeQueue, files, turnOff } from "./groups.ts";
import { runAs } from "./owner.ts";
import { spaceEnded, spaceTool, turnEnded } from "./spaces.ts";
import type * as Spaces from "./spaces.ts";
import { callTool, endTurn, openTab } from "./tools.ts";

// The keeper's files, away from the real ones (groups-off.json there would
// make every window plain).
const dir = mkdtempSync(join(tmpdir(), "spaces-test-"));
Object.assign(files, { queue: join(dir, "groups.json"), off: join(dir, "groups-off.json"), keeper: join(dir, "keeper.pid"), log: join(dir, "keeper.log") });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Tab = { id: number; url: string; windowId: number; active: boolean };

// The ids every fake Safari here hands out, none twice in this file: the
// daemon's records of one test's windows outlast that test.
let next = 1000;

// Safari as the extension reports it, with the user's window 1 open.
function safari() {
  const tabs = new Map<number, Tab>([[1, { id: 1, url: "https://his.example/", windowId: 1, active: true }]]);
  const closed: number[] = [];
  // Windows the extension holds the keeper to be making a tab group of.
  const regrouping = new Set<number>();
  // What the extension maps the ids it had before a reload to (adopt in
  // background.js).
  const oldTabs = new Map<number, number>();
  const oldWindows = new Map<number, number>();
  // What the daemon told the extension of each tab it sized.
  const sized: { tab: number; whole: boolean }[] = [];
  const ops: Record<string, (args: unknown[]) => unknown> = {
    "tabs.list": () => [...tabs.values()],
    "tabs.open": ([url, background, windowId]) => {
      const t = { id: next++, url: String(url), windowId: typeof windowId === "number" ? windowId : 1, active: !background };
      tabs.set(t.id, t);
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
    "windows.regrouping": ([id, on]) => {
      if (on) regrouping.add(id as number);
      else regrouping.delete(id as number);
      return { ok: true };
    },
    // the page ops open waits on (afterWall): a plain page, no bot check
    probe: () => [],
    relay: () => ({ ok: true }),
    // how an owned tab answers dialogs, which also owns it (renumber)
    dialogs: () => ({ ok: true }),
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
      if (id === undefined) return;
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
    const windows = new Map<number, number>();
    tabs.clear();
    for (const t of was) {
      if (!windows.has(t.windowId)) windows.set(t.windowId, next++);
      const id = next++;
      tabs.set(id, { ...t, id, windowId: windows.get(t.windowId)! });
    }
  };
  return { tabs, closed, sock, ops, reload, relaunch, oldTabs, regrouping, sized };
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

// On 09-29 each new window of one agent repeated the same 330-character
// reason, which only the user can act on.
test("a window that stays plain says why once to its agent, not on its later opens or windows", async () => {
  safari();
  turnOff("Safari's menu stayed open after delete");
  const e = agent();
  const first = await runAs(e.pid, () => openTab("https://e.example/1", true));
  const again = await runAs(e.pid, () => openTab("https://e.example/2", true));
  const research = await runAs(e.pid, () => openTab("https://e.example/3", true, "research"));
  rmSync(files.off);
  expect(first.space).toMatchObject({ group: "plain", why: expect.stringContaining("menu stayed open") });
  expect(again.space).toEqual({ name: first.space.name, group: "plain" });
  expect(research.windowId).not.toBe(first.windowId);
  expect(research.space).toEqual({ name: expect.any(String), group: "plain" });
  e.kill();
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

// 10-07: agent 1431's two groups stood in windows it had sized to 390
// points, where Safari hides the tab bar the keeper counts a window's tabs
// in: the keeper waited on them for good.
test("an ended group's window its agent sized as narrow as a phone goes back to a size of the daemon's for the keeper", async () => {
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
  const released = (await spaceTool({ op: "release", name })) as { width: number };
  expect(released.width).toBeGreaterThanOrEqual(1000);
  expect(s.sized.at(-1)).toEqual({ tab: page.id, whole: true });
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
  // the group goes the ended group's way; the window that is none closes
  expect(pages.map((id) => s.closed.includes(id))).toEqual([false, true]);
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
  first.loadSpaces(saved);
  const before = await runAs(q.pid, () => first.spaceWindow());
  restarted.loadSpaces(saved);
  const after = await runAs(q.pid, () => restarted.spaceWindow());
  expect(after.window).toBe(before.window);
  q.kill();
  await Promise.all([first.turnEnded(q.pid), restarted.turnEnded(q.pid)]);
  // Both have saved by the time the page closes, before the folder goes.
  await until(() => !pageIn(s.tabs, before.window));
});

test.each(["spaces", "closing", "ended"] as const)("a saved %s cleanup intent retains ownership but requires fresh runtime admission", async phase => {
  const s = safari();
  const q = agent();
  const path = join(dir, `admission-${phase}.json`);
  const first = await daemonOn(47343, `before-${phase}`);
  const restarted = await daemonOn(47343, `after-${phase}`);
  try {
    first.loadSpaces(path);
    const owned = await runAs(q.pid, () => first.spaceWindow());
    const page = pageIn(s.tabs, owned.window)!;
    const stored = JSON.parse(readFileSync(path, "utf8")) as { spaces: Spaces.Space[] };
    const record: Spaces.Space = { ...stored.spaces[0], group: phase === "closing" ? "grouped" : "plain", done: true };
    writeFileSync(path, JSON.stringify({ version: 2, spaces: [], closing: [], ended: [], [phase]: [record] }));
    restarted.loadSpaces(path);
    await restarted.turnEnded(q.pid + 1);
    expect(s.tabs.has(page.id)).toBe(true);
    expect(s.closed).not.toContain(page.id);
    expect(await restarted.spaceTool({ op: "release", name: owned.name })).toEqual({ ok: false });
    const retained = JSON.parse(readFileSync(path, "utf8")) as Record<typeof phase, Spaces.Space[]>;
    const expected: Spaces.Space = { ...record };
    delete expected.done;
    expect(retained[phase]).toStrictEqual([expected]);
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

// A page address is not ownership evidence: a user can copy the same link.
test("a restarted daemon leaves a window page it has no durable ownership record for", async () => {
  const s = safari();
  const daemon = await daemonOn(47341, "lost");
  s.tabs.set(900, { id: 900, url: "http://127.0.0.1:47341/space?id=gone&name=agent%2050573&size=1100x800", windowId: 901, active: true });
  daemon.loadSpaces(join(dir, "lost.json"));
  await daemon.turnEnded(process.pid);
  expect({ retained: s.tabs.has(900), closed: s.closed }).toEqual({ retained: true, closed: [] });
});

test("a restarted daemon leaves a page the user opened from the agents list, and a group's window still queued for the keeper", async () => {
  const s = safari();
  const daemon = await daemonOn(47342, "kept");
  const page = (id: number, query: string, windowId: number) => s.tabs.set(id, { id, url: `http://127.0.0.1:47342/space?${query}`, windowId, active: true });
  changeQueue((q) => (q["trip (agent 4242)"] = { since: 0 }));
  try {
    page(910, "id=his&name=agent%204241", 1);
    page(911, "id=queued&name=trip%20(agent%204242)&size=1100x800", 912);
    // A lost window's, last: once it closes, the pass has looked at the others.
    page(913, "id=lost&name=agent%204243&size=1101x800", 914);
    daemon.loadSpaces(join(dir, "kept.json"));
    await daemon.turnEnded(process.pid);
    expect(s.closed).toEqual([]);
    expect([910, 911, 913].map(id => s.tabs.has(id))).toEqual([true, true, true]);
  } finally {
    changeQueue((q) => delete q["trip (agent 4242)"]);
  }
}, 15_000);

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

// One lost window's close failed 69 times in 5.7 min, a try each sweep.
test("an ended window whose page Safari will not close is asked again after one, two and four minutes, then left", async () => {
  let now = Date.now();
  const tries: number[] = [];
  const start = now;
  const w = await unclosable(() => {
    tries.push(now - start);
    throw new Error("Safari did not close the tab: a native sheet (a sign-in or permission prompt) or a window off screen holds it. Tell the user; closing again will not help");
  });
  try {
    for (const at of [0, 59_000, 60_000, 179_000, 180_000, 419_000, 420_000, 3_600_000]) {
      now = start + at;
      setSystemTime(new Date(now));
      await turnEnded(w.pid);
    }
  } finally {
    setSystemTime();
  }
  expect({ tries, ended: spaceEnded(w.id) }).toEqual({ tries: [0, 60_000, 180_000, 420_000], ended: true });
});

// A stuck extension (bridge.ts) answers no list; the keeper stopped at
// the error, where it waits for a quit Safari.
test("the keeper's look at the windows tells it Safari is away while the extension answers no list", async () => {
  safari();
  const k = agent();
  await runAs(k.pid, () => openTab("https://stuck.example/", true));
  const request = bridge.request;
  bridge.request = () => Promise.reject(new Error("extension stuck: the Safari extension has answered none of the last 2 tabs.list requests (for 10 s); run safari extension reload, then try again"));
  try {
    expect(await spaceTool({ op: "state" })).toMatchObject({ connected: false });
  } finally {
    bridge.request = request;
  }
  expect(await spaceTool({ op: "state" })).toMatchObject({ connected: true });
  k.kill();
});
