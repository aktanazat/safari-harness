import { afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { captureFixture, connect } from "./fake-safari.ts";
import * as front from "./front.ts";
import { runAs } from "./owner.ts";
import * as spaces from "./spaces.ts";
import { captureTab, loadTabs } from "./tools.ts";

// On 10-22 Safari opened every agent window at one place on the display
// above, and the shots of every agent whose window others covered failed
// "the protected page did not paint". The Mac here keeps its windows front
// to back in global points from the main display's top-left, as
// scripts/input lists them. Its Safari draws no page in a window another
// window covers whole, opens a window behind the user's at one place, and
// moves a window as WebKit's windows.update does, counting left and top
// from the top-left of the display holding most of it.

type Rect = { x: number; y: number; width: number; height: number };
type Win = Rect & { id: number; safari: boolean };
// The main display, whose top 33 points the menu bar takes, and a larger
// display above it.
const MAIN = { frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 33, width: 1512, height: 949 } };
const ABOVE = { frame: { x: -538, y: -1440, width: 2560, height: 1440 }, visible: { x: -538, y: -1440, width: 2560, height: 1440 } };
// The user's Safari window filling the main display, and where Safari
// opens every agent window.
const HIS = { id: 1, safari: true, ...MAIN.visible };
const SAFARI_PUT = { x: -538, y: -1440 };
// The virtual display agent-display adds right of the main one, for agents.
const AGENTS = { id: 26, name: "Agents", frame: { x: 1512, y: 0, width: 2560, height: 1440 }, visible: { x: 1512, y: 0, width: 2560, height: 1440 } };
const UNPAINTED = "screenshot privacy: the protected page did not paint";

const shared = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

// Windows front to back; tabs, each in a window; owners, each window's agent;
// urls, the address of a tab not at https://page.example/<tab>.
function mac(windows: Win[], tabs: Record<number, number>, owners: Record<number, number>, moves?: Rect[], moveOffset = 0, screens = [MAIN, ABOVE], urls: Record<number, string> = {}, births: Rect[] = [], reference = MAIN.frame) {
  // A window the daemon opens shows its status page at the address asked.
  const pages = new Map<number, string>(Object.entries(urls).map(([tab, url]) => [Number(tab), url]));
  const urlOf = (tab: number) => pages.get(tab) ?? `https://page.example/${tab}`;
  const windowOf = (tab: number) => windows.find((w) => w.id === tabs[tab])!;
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      const reply = (answer: { value?: unknown; error?: string }) => queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...answer })));
      if (op === "tabs.list") return reply({ value: Object.entries(tabs).map(([tab, windowId]) => ({ id: Number(tab), windowId, url: urlOf(Number(tab)), active: true })) });
      if (op === "windows.open") {
        const { width, height } = args[1] as { width: number; height: number };
        const bounds = args[2] as { left: number; top: number } | undefined;
        const opened = { id: Math.max(...windows.map((w) => w.id)) + 1, safari: true, ...(bounds ? { x: reference.x + bounds.left, y: reference.y + bounds.top } : SAFARI_PUT), width, height };
        births.push({ ...opened });
        windows.splice(1, 0, opened);
        tabs[opened.id * 10 + 1] = opened.id;
        pages.set(opened.id * 10 + 1, String(args[0]));
        return reply({ value: { windowId: opened.id, tabId: opened.id * 10 + 1 } });
      }
      const tab = args[0] as number;
      if (op === "windows.frame") {
        const w = windowOf(tab);
        const bounds = args[1] as { left: number; top: number } | undefined;
        if (bounds) {
          moves?.push({ ...w });
          const on = screens.reduce((a, b) => (shared(w, b.frame) > shared(w, a.frame) ? b : a)).frame;
          Object.assign(w, { x: on.x + bounds.left, y: on.y + bounds.top + (moves?.length === 1 ? moveOffset : 0) });
        }
        const on = screens.reduce((a, b) => (shared(w, b.frame) > shared(w, a.frame) ? b : a)).frame;
        return reply({ value: { width: w.width, height: w.height, left: w.x - on.x, top: w.y - on.y, state: "normal" } });
      }
      if (op === "shot") {
        const w = windowOf(tab);
        const coveredWhole = windows.slice(0, windows.indexOf(w)).some((f) => shared(w, f) === w.width * w.height);
        return reply(coveredWhole ? { error: UNPAINTED } : { value: captureFixture(urlOf(tab)) });
      }
      if (op === "dialogs") return reply({ value: { ok: true } });
      if (op === "tabs.close") {
        delete tabs[tab];
        return reply({ value: { ok: true } });
      }
      reply({ error: `no ${op} here` });
    },
    close() {},
  });
  spyOn(front, "input").mockImplementation(async (args) => {
    if (args[0] !== "windows") throw new Error(`no input ${args[0]} here`);
    return { windows: windows.map(({ id: _, ...w }) => ({ ...w })), screens, reference };
  });
  spyOn(spaces, "windowOwners").mockImplementation(() => new Map(Object.entries(owners).map(([w, owner]) => [Number(w), owner])));
  return windows;
}

const byId = (windows: Win[], id: number) => windows.find((w) => w.id === id)!;

afterEach(() => {
  mock.restore();
});

test.each([0, 30])("a covered owned window returns to its original place after Safari shifts its screenshot position by %i points", async (offset) => {
  const theirs = { id: 3, safari: true, ...SAFARI_PUT, width: 1001, height: 780 };
  const moves: Rect[] = [];
  const windows = mac([{ ...HIS }, { ...theirs }, { id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 }], { 11: 1, 21: 2, 31: 3 }, { 2: 7, 3: 8 }, moves, offset);
  const capture = await runAs(7, () => captureTab(21));
  expect(capture.source.url).toBe("https://page.example/21");
  expect(moves).toHaveLength(2);
  expect([shared(moves[1], HIS), shared(moves[1], theirs)]).toEqual([0, 0]);
  expect(byId(windows, 2)).toEqual({ id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 });
  expect([byId(windows, 1), byId(windows, 3)]).toEqual([HIS, theirs]);
});

test("a shot whose page did not paint leaves a window that is not the caller's where it is", async () => {
  const theirs = { id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 };
  const windows = mac([{ ...HIS }, { id: 3, safari: true, ...SAFARI_PUT, width: 1001, height: 780 }, { ...theirs }], { 11: 1, 21: 2, 31: 3 }, { 2: 7, 3: 8 });
  await expect(runAs(8, () => captureTab(21))).rejects.toMatchObject({ code: "privacy", message: UNPAINTED, next: expect.stringContaining("activate") });
  expect(byId(windows, 2)).toEqual(theirs);
});

test("a popup window returns to its original place after its page is captured", async () => {
  const popup = { id: 5, safari: true, x: 200, y: 200, width: 600, height: 500 };
  const moves: Rect[] = [];
  const windows = mac([{ ...HIS }, { ...popup }], { 11: 1, 51: 5 }, {}, moves);
  const state = join(mkdtempSync(join(tmpdir(), "place-")), "tabs.json");
  writeFileSync(state, JSON.stringify({ 51: process.pid }));
  loadTabs(state);
  const capture = await runAs(process.pid, () => captureTab(51));
  expect(capture.source.url).toBe("https://page.example/51");
  expect(moves).toHaveLength(2);
  expect([shared(moves[1], HIS), byId(windows, 5), byId(windows, 1)]).toEqual([0, popup, HIS]);
});

test("a shot whose window no display has room to show says it is covered, and moves nothing", async () => {
  const ours = { id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 };
  const windows = mac([{ ...HIS }, { id: 4, safari: false, ...ABOVE.visible }, { ...ours }], { 11: 1, 21: 2 }, { 2: 7 });
  const failed = await runAs(7, () => captureTab(21)).catch((e: unknown) => e);
  expect(failed).toMatchObject({ code: "unavailable", effect: "none", next: expect.stringContaining("activate") });
  expect((failed as Error).message).toStartWith("screenshot: other windows cover your window");
  expect(byId(windows, 2)).toEqual(ours);
});

test("opening an agent window leaves it behind the user's windows where Safari placed it", async () => {
  const older = { id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 };
  const moves: Rect[] = [];
  const windows = mac([{ ...HIS }, { ...older }], { 11: 1, 21: 2 }, { 2: 8 }, moves);
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?place`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("place"));
  const opened = byId(windows, space.window);
  expect(opened).toEqual({ id: space.window, safari: true, ...SAFARI_PUT, width: space.size.width, height: space.size.height });
  expect(moves).toEqual([]);
  expect(byId(windows, 2)).toEqual(older);
});

test.each([MAIN.frame, ABOVE.frame, AGENTS.frame])("a new window starts on Agents from keyboard-focus display %j", async (reference) => {
  const there = { id: 2, safari: true, x: AGENTS.visible.x, y: AGENTS.visible.y, width: 1000, height: 780 };
  const births: Rect[] = [];
  const windows = mac([{ ...HIS }, { ...there }], { 11: 1, 21: 2 }, { 2: 8 }, undefined, 0, [MAIN, ABOVE, AGENTS], {}, births, reference);
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?agents-${reference.x}-${reference.y}`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("agents"));
  const opened = byId(windows, space.window);
  expect(shared(opened, AGENTS.frame)).toBe(opened.width * opened.height);
  expect(births.map((frame) => shared(frame, AGENTS.frame))).toEqual([opened.width * opened.height]);
  expect(shared(opened, there)).toBe(0);
  expect([byId(windows, 1), byId(windows, 2)]).toEqual([HIS, there]);
});

test("hidden window creation refuses an extension that cannot place it at creation", async () => {
  const windows = mac([{ ...HIS }], { 11: 1 }, {}, undefined, 0, [MAIN, AGENTS]);
  bridge.extensionInfo!.windowPlacement = false;
  // This case needs its own empty window registry.
  const fresh = (await import("./spaces.ts?old-window-extension")) as typeof spaces;
  await expect(runAs(process.pid, () => fresh.spaceWindow("old extension"))).rejects.toThrow("must finish updating");
  expect(windows).toEqual([HIS]);
});

test("a new window starts on Agents even when native listing cannot see Safari's Space", async () => {
  const births: Rect[] = [];
  const windows = mac([{ ...HIS }], { 11: 1 }, {}, undefined, 0, [MAIN, AGENTS], {}, births);
  spyOn(front, "input").mockResolvedValue({ windows: [], screens: [MAIN, AGENTS], reference: MAIN.frame });
  // This case needs its own empty window registry.
  const fresh = (await import("./spaces.ts?invisible-window-space")) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("other Space"));
  const opened = byId(windows, space.window);
  expect(births.map((frame) => shared(frame, AGENTS.frame))).toEqual([opened.width * opened.height]);
  expect(byId(windows, 1)).toEqual(HIS);
});

test.each(["missing", "unreadable"])("requiring hidden windows refuses a new page when the Agents display is %s", async (condition) => {
  const windows = mac([{ ...HIS }], { 11: 1 }, {});
  spyOn(fs, "existsSync").mockImplementation((path) => String(path).endsWith("/hidden-windows"));
  if (condition === "unreadable") spyOn(front, "input").mockRejectedValue(new Error("display query failed"));
  // Each case needs an empty window registry, not another case's cached space.
  const fresh = (await import(`./spaces.ts?required-${condition}`)) as typeof spaces;
  await expect(runAs(process.pid, () => fresh.spaceWindow("hidden required"))).rejects.toThrow(condition === "missing" ? "The Agents display is unavailable" : "display query failed");
  expect(windows).toEqual([HIS]);
});

const onAgents = (w: Rect) => shared(w, AGENTS.frame) === w.width * w.height;

test("an agent window opened while the Agents display was down goes there once a sweep finds the display back", async () => {
  const screens = [MAIN, ABOVE];
  const windows = mac([{ ...HIS }], { 11: 1 }, {}, undefined, 0, screens);
  const fresh = (await import(`./spaces.ts?down`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("down"));
  const before = onAgents(byId(windows, space.window));
  screens.push(AGENTS);
  await fresh.sweep();
  expect([before, onAgents(byId(windows, space.window))]).toEqual([false, true]);
});

// 11-19: a window holding only his hub page and an X post sat on the
// Agents display, out of his sight, until another agent moved it by hand.
test("a sweep moves a window of only the user's tabs off the Agents display to the display of his front window once it has been there 10 s, and leaves the agent window there", async () => {
  const strayWindow = { id: 3, safari: true, x: AGENTS.visible.x + 1400, y: AGENTS.visible.y, width: 900, height: 700 };
  const windows = mac([{ ...HIS }, { ...strayWindow }], { 11: 1, 31: 3, 32: 3 }, {}, undefined, 0, [MAIN, ABOVE, AGENTS]);
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?stray`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("stray"));
  try {
    await fresh.sweep();
    const first = onAgents(byId(windows, 3));
    setSystemTime(Date.now() + 11_000);
    await fresh.sweep();
    const moved = byId(windows, 3);
    expect([first, shared(moved, MAIN.frame), onAgents(byId(windows, space.window))]).toEqual([true, moved.width * moved.height, true]);
  } finally {
    setSystemTime();
  }
});

// 11-27: three of the user's Ladybird windows lay one on another on the
// Agents display, each its full size; no sweep could tell which was which
// by size, so they stayed out of his sight.
test.each([
  ["at one place", 0],
  ["at two places", 200],
])("a sweep moves two windows of only the user's tabs, of one size %s on the Agents display, to his display", async (_, apart) => {
  const his = (id: number, x: number) => ({ id, safari: true, x: AGENTS.visible.x + x, y: AGENTS.visible.y, width: 900, height: 700 });
  const windows = mac([{ ...HIS }, his(3, 0), his(4, apart)], { 11: 1, 31: 3, 41: 4 }, {}, undefined, 0, [MAIN, ABOVE, AGENTS]);
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?alike${apart}`)) as typeof spaces;
  await runAs(process.pid, () => fresh.spaceWindow(`alike${apart}`));
  try {
    await fresh.sweep();
    setSystemTime(Date.now() + 11_000);
    await fresh.sweep();
    expect([onAgents(byId(windows, 3)), onAgents(byId(windows, 4))]).toEqual([false, false]);
  } finally {
    setSystemTime();
  }
});

test("a done agent's window on the Agents display that still holds a tab of the user's moves to his display, the tab still in it", async () => {
  const tabs: Record<number, number> = { 11: 1 };
  const windows = mac([{ ...HIS }], tabs, {}, undefined, 0, [MAIN, ABOVE, AGENTS]);
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?done`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("done"));
  tabs[99] = space.window;
  await fresh.turnEnded(process.pid);
  await fresh.sweep();
  const moved = byId(windows, space.window);
  expect([shared(moved, MAIN.frame), tabs[99]]).toEqual([moved.width * moved.height, space.window]);
});

test("a done agent's window moved to his display for his tab goes back to the Agents display once its agent works in it again", async () => {
  const tabs: Record<number, number> = { 11: 1 };
  const windows = mac([{ ...HIS }], tabs, {}, undefined, 0, [MAIN, ABOVE, AGENTS]);
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?again`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("again"));
  tabs[97] = space.window;
  await fresh.turnEnded(process.pid);
  await fresh.sweep();
  const shown = onAgents(byId(windows, space.window));
  const again = await runAs(process.pid, () => fresh.spaceWindow("again"));
  await fresh.sweep();
  expect([again.window, shown, onAgents(byId(windows, space.window))]).toEqual([space.window, false, true]);
});

// 11-20: check-live's ended tab group window held only the Start Page
// Safari leaves in a group, and a sweep moved it onto his screen.
test("a done agent's window holding only Safari's Start Page stays on the Agents display", async () => {
  const tabs: Record<number, number> = { 11: 1 };
  const windows = mac([{ ...HIS }], tabs, {}, undefined, 0, [MAIN, ABOVE, AGENTS], { 96: "favorites://" });
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?start`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("start"));
  tabs[96] = space.window;
  await fresh.turnEnded(process.pid);
  await fresh.sweep();
  expect(onAgents(byId(windows, space.window))).toBe(true);
});

// 11-23: nine windows holding only Safari's Start Page sat on the Agents
// display for up to two days, each left by an agent window that ended.
test("an agent window whose task ended stays on the Agents display as its page closes, when only Safari's Start Page is left in it, and closes 10 s on", async () => {
  const tabs: Record<number, number> = { 11: 1 };
  const windows = mac([{ ...HIS }], tabs, {}, undefined, 0, [MAIN, ABOVE, AGENTS], { 95: "favorites://" });
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?startended`)) as typeof spaces;
  let tracked = true;
  fresh.loadSpaces(join(mkdtempSync(join(tmpdir(), "place-")), "spaces.json"), () => tracked);
  const space = await runAs(process.pid, () => fresh.spaceWindow("startended"));
  tabs[95] = space.window;
  tracked = false;
  try {
    await fresh.sweep();
    const statusPage = space.window * 10 + 1;
    const first = [statusPage in tabs, 95 in tabs, onAgents(byId(windows, space.window))];
    tracked = true;
    await runAs(process.pid + 1, () => fresh.spaceWindow("working"));
    await fresh.sweep();
    setSystemTime(Date.now() + 11_000);
    await fresh.sweep();
    expect([first, 95 in tabs]).toEqual([[false, true, true], false]);
  } finally {
    setSystemTime();
  }
});

test("an agent window whose task ended moves to his display as its page closes, when only a tab of the user's is left in it", async () => {
  const tabs: Record<number, number> = { 11: 1 };
  const windows = mac([{ ...HIS }], tabs, {}, undefined, 0, [MAIN, ABOVE, AGENTS]);
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?ended`)) as typeof spaces;
  let tracked = true;
  fresh.loadSpaces(join(mkdtempSync(join(tmpdir(), "place-")), "spaces.json"), () => tracked);
  const space = await runAs(process.pid, () => fresh.spaceWindow("ended"));
  tabs[98] = space.window;
  tracked = false;
  await fresh.sweep();
  const moved = byId(windows, space.window);
  expect([space.window * 10 + 1 in tabs, shared(moved, MAIN.frame)]).toEqual([false, moved.width * moved.height]);
});

// 11-20, work Mac: an exited agent's tabs closed while its window ended,
// and the window, left with the user's tabs, stayed on the Agents display:
// the move named one of the closed tabs ("that tab is gone").
test("an agent window whose task ended moves to his display even when another tab in it closes as its page does", async () => {
  const tabs: Record<number, number> = { 11: 1 };
  const windows = mac([{ ...HIS }], tabs, {}, undefined, 0, [MAIN, ABOVE, AGENTS]);
  // Isolate this window from other tests' module records.
  const fresh = (await import(`./spaces.ts?closing`)) as typeof spaces;
  let tracked = true;
  fresh.loadSpaces(join(mkdtempSync(join(tmpdir(), "place-")), "spaces.json"), () => tracked);
  const space = await runAs(process.pid, () => fresh.spaceWindow("closing"));
  // the one look at untracked windows a load asks for, while its task runs
  await fresh.sweep();
  const statusPage = space.window * 10 + 1;
  // tab 93 is listed while the status page is open and gone once it closes
  Object.defineProperty(tabs, 93, { enumerable: true, configurable: true, get: () => (statusPage in tabs ? space.window : undefined) });
  tabs[94] = space.window;
  tracked = false;
  await fresh.sweep();
  const moved = byId(windows, space.window);
  expect([statusPage in tabs, shared(moved, MAIN.frame)]).toEqual([false, moved.width * moved.height]);
});

test("an agent window the user moves off the Agents display stays where he put it, through an activate and its turn's end", async () => {
  const windows = mac([{ ...HIS }], { 11: 1 }, {}, undefined, 0, [MAIN, ABOVE, AGENTS]);
  const fresh = (await import(`./spaces.ts?moved`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("moved"));
  Object.assign(byId(windows, space.window), { x: 100, y: 100 });
  await fresh.sweep();
  runAs(process.pid, () => fresh.showing(space.window));
  fresh.unshow(process.pid, undefined);
  await fresh.sweep();
  expect(byId(windows, space.window)).toMatchObject({ x: 100, y: 100 });
});

// omp's tasks: a lead's [session, agent], and a helper's with its lead.
const LEAD = JSON.stringify(["s", "Main"]);
const HELPER = JSON.stringify(["s", "Helper", "Main"]);

test("a window activate showed stays on his screen through another task's turn end, and goes back at the end of its own", async () => {
  const windows = mac([{ ...HIS }], { 11: 1 }, {}, undefined, 0, [MAIN, ABOVE, AGENTS]);
  const fresh = (await import(`./spaces.ts?shown`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("shown"), LEAD);
  runAs(process.pid, () => fresh.showing(space.window), LEAD);
  Object.assign(byId(windows, space.window), { x: 100, y: 100 });
  fresh.unshow(process.pid, HELPER);
  await fresh.sweep();
  const afterHelper = onAgents(byId(windows, space.window));
  fresh.unshow(process.pid, LEAD);
  await fresh.sweep();
  expect([afterHelper, onAgents(byId(windows, space.window))]).toEqual([false, true]);
});
