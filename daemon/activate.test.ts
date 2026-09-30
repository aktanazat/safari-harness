import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import * as front from "./front.ts";
import * as spaces from "./spaces.ts";
import { callTool } from "./tools.ts";

// activate puts an agent's window in front on the main display, where the
// user sees it: Safari opens agent windows where it likes, and on 09-28
// GitHub's Authorize stayed disabled in one on the display above. Safari,
// its windows, and the helper are fakes. Points are global, from the main
// display's top-left; the fake moves a window as WebKit's windows.update
// does, counting left and top from the top-left of the screen it is on.

type Rect = { x: number; y: number; width: number; height: number };
// The main display, whose top 33 points the menu bar takes, and a larger
// display above it and to its left.
const MAIN = { x: 0, y: 0, width: 1512, height: 982 };
const FREE = { x: 0, y: 33, width: 1512, height: 949 };
const ABOVE = { x: -538, y: -1440, width: 2560, height: 1440 };
const screenOf = (w: Rect) => (w.y < 0 ? ABOVE : MAIN);

// The user's window 1 shows his tab 3, and agent window 2 the agent's tab
// 21. The Mac records the window focused last and the app in front.
function mac(agent: Rect, his: Rect = FREE) {
  const windows = new Map([[1, { ...his }], [2, { ...agent }]]);
  const windowOf = new Map([[3, 1], [21, 2]]);
  const m = { app: "com.mitchellh.ghostty", focused: 1, windows };
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      const answer = (value: unknown) => queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
      if (op === "tabs.list") return answer([...windowOf].map(([tab, windowId]) => ({ id: tab, windowId, active: true, ...(windowId === 1 ? { front: true } : {}) })));
      if (op !== "tabs.activate") return queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, error: `no ${op} here` })));
      const [tab, bounds] = args as [number, { left: number; top: number; width: number; height: number } | undefined];
      m.focused = windowOf.get(tab)!;
      const w = windows.get(m.focused)!;
      if (bounds) {
        const s = screenOf(w);
        Object.assign(w, { x: s.x + bounds.left, y: s.y + bounds.top, width: bounds.width, height: bounds.height });
      }
      answer({ ok: true, windowId: m.focused, width: w.width, height: w.height });
    },
    close() {},
  });
  spyOn(front, "input").mockImplementation(async (args) => {
    if (args[0] === "activate") m.app = args[1];
    if (args[0] !== "window") return {};
    const w = [...windows.values()].find((r) => r.width === Number(args[1]) && r.height === Number(args[2]))!;
    return { window: { ...w }, screen: screenOf(w), visible: FREE };
  });
  spyOn(spaces, "windowOwners").mockImplementation(() => new Map([[2, 7]]));
  return m;
}

afterEach(() => {
  mock.restore();
});

test.each([
  ["on the display above the main one", { x: 29, y: -1410, width: 1145, height: 875 }, { x: 29, y: 33, width: 1145, height: 875 }],
  ["hanging off the main display's corner", { x: 400, y: 300, width: 1145, height: 875 }, { x: 367, y: 107, width: 1145, height: 875 }],
  ["already on the main display", { x: 200, y: 60, width: 1145, height: 875 }, { x: 200, y: 60, width: 1145, height: 875 }],
])("an agent's window %s comes to the front inside the main display at its own size, and the answer says where", async (_where, start, end) => {
  const m = mac(start);
  expect(await callTool("activate", { tab: 21 })).toEqual({ ok: true, window: end });
  expect({ window: m.windows.get(2), focused: m.focused, app: m.app }).toEqual({ window: end, focused: 2, app: front.SAFARI });
});

test("an agent's window of no size comes onto the main display at 1000 by 800", async () => {
  const m = mac({ x: 29, y: -1410, width: 0, height: 0 });
  await callTool("activate", { tab: 21 });
  expect(m.windows.get(2)).toEqual({ x: 29, y: 33, width: 1000, height: 800 });
});

test("a tab in one of the user's windows comes to the front with his window left where he put it", async () => {
  const his = { x: 29, y: -1410, width: 1076, height: 790 };
  const m = mac({ x: 200, y: 60, width: 1145, height: 875 }, his);
  await callTool("activate", { tab: 3 });
  expect({ window: m.windows.get(1), focused: m.focused, app: m.app }).toEqual({ window: his, focused: 1, app: front.SAFARI });
});
