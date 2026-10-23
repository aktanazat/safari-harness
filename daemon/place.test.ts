import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { captureFixture, connect } from "./fake-safari.ts";
import * as front from "./front.ts";
import { runAs } from "./owner.ts";
import * as spaces from "./spaces.ts";
import { captureTab } from "./tools.ts";

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
const UNPAINTED = "screenshot privacy: the protected page did not paint";

const shared = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

// windows front to back; tabs, each in a window; owners, each window's agent.
function mac(windows: Win[], tabs: Record<number, number>, owners: Record<number, number>) {
  const urlOf = (tab: number) => `https://page.example/${tab}`;
  const windowOf = (tab: number) => windows.find((w) => w.id === tabs[tab])!;
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      const reply = (answer: { value?: unknown; error?: string }) => queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...answer })));
      if (op === "tabs.list") return reply({ value: Object.entries(tabs).map(([tab, windowId]) => ({ id: Number(tab), windowId, url: urlOf(Number(tab)), active: true })) });
      if (op === "windows.open") {
        const { width, height } = args[1] as { width: number; height: number };
        const opened = { id: Math.max(...windows.map((w) => w.id)) + 1, safari: true, ...SAFARI_PUT, width, height };
        windows.splice(1, 0, opened);
        tabs[opened.id * 10 + 1] = opened.id;
        return reply({ value: { windowId: opened.id, tabId: opened.id * 10 + 1 } });
      }
      const tab = args[0] as number;
      if (op === "windows.frame") {
        const w = windowOf(tab);
        const bounds = args[1] as { left: number; top: number } | undefined;
        if (bounds) {
          const on = [MAIN, ABOVE].reduce((a, b) => (shared(w, b.frame) > shared(w, a.frame) ? b : a)).frame;
          Object.assign(w, { x: on.x + bounds.left, y: on.y + bounds.top });
        }
        return reply({ value: { width: w.width, height: w.height, state: "normal" } });
      }
      if (op === "shot") {
        const w = windowOf(tab);
        const coveredWhole = windows.slice(0, windows.indexOf(w)).some((f) => shared(w, f) === w.width * w.height);
        return reply(coveredWhole ? { error: UNPAINTED } : { value: captureFixture(urlOf(tab)) });
      }
      reply({ error: `no ${op} here` });
    },
    close() {},
  });
  spyOn(front, "input").mockImplementation(async (args) => {
    if (args[0] !== "windows") throw new Error(`no input ${args[0]} here`);
    return { windows: windows.map(({ id: _, ...w }) => ({ ...w })), screens: [MAIN, ABOVE] };
  });
  spyOn(spaces, "windowOwners").mockImplementation(() => new Map(Object.entries(owners).map(([w, owner]) => [Number(w), owner])));
  return windows;
}

const byId = (windows: Win[], id: number) => windows.find((w) => w.id === id)!;

afterEach(() => {
  mock.restore();
});

test("a shot whose window another agent's covers moves that window alone where nothing covers it, and captures its page", async () => {
  const theirs = { id: 3, safari: true, ...SAFARI_PUT, width: 1001, height: 780 };
  const windows = mac([{ ...HIS }, { ...theirs }, { id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 }], { 11: 1, 21: 2, 31: 3 }, { 2: 7, 3: 8 });
  const capture = await runAs(7, () => captureTab(21));
  expect(capture.source.url).toBe("https://page.example/21");
  const ours = byId(windows, 2);
  expect([shared(ours, HIS), shared(ours, theirs)]).toEqual([0, 0]);
  expect([byId(windows, 1), byId(windows, 3)]).toEqual([HIS, theirs]);
});

test("a shot whose page did not paint leaves a window that is not the caller's where it is", async () => {
  const theirs = { id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 };
  const windows = mac([{ ...HIS }, { id: 3, safari: true, ...SAFARI_PUT, width: 1001, height: 780 }, { ...theirs }], { 11: 1, 21: 2, 31: 3 }, { 2: 7, 3: 8 });
  await expect(runAs(8, () => captureTab(21))).rejects.toMatchObject({ code: "privacy", message: UNPAINTED });
  expect(byId(windows, 2)).toEqual(theirs);
});

test("a shot whose window no display has room to show says it is covered, and moves nothing", async () => {
  const ours = { id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 };
  const windows = mac([{ ...HIS }, { id: 4, safari: false, ...ABOVE.visible }, { ...ours }], { 11: 1, 21: 2 }, { 2: 7 });
  const failed = await runAs(7, () => captureTab(21)).catch((e: unknown) => e);
  expect(failed).toMatchObject({ code: "unavailable", effect: "none" });
  expect((failed as Error).message).toStartWith("screenshot: other windows cover your window");
  expect(byId(windows, 2)).toEqual(ours);
});

test("an agent's new window, which Safari opens over another agent's, moves where neither that window nor the user's covers any of it", async () => {
  const older = { id: 2, safari: true, ...SAFARI_PUT, width: 1000, height: 780 };
  const windows = mac([{ ...HIS }, { ...older }], { 11: 1, 21: 2 }, { 2: 8 });
  // A module of its own keeps this agent's window out of other files'
  // records (spaces.test.ts does the same).
  const fresh = (await import(`./spaces.ts?place`)) as typeof spaces;
  const space = await runAs(process.pid, () => fresh.spaceWindow("place"));
  const opened = byId(windows, space.window);
  expect([shared(opened, HIS), shared(opened, older)]).toEqual([0, 0]);
  expect(shared(opened, ABOVE.visible) + shared(opened, MAIN.visible)).toBe(opened.width * opened.height);
  expect(byId(windows, 2)).toEqual(older);
});
