import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import * as front from "./front.ts";
import { INPUT_TOOLS } from "./input.ts";
import * as daemonRpc from "./rpc.ts";
import * as spaces from "./spaces.ts";
import { callTool } from "./tools.ts";

// real_input clicks a tab that is not in front by pressing the element
// through Safari's accessibility tree, and nothing comes forward. Where a
// press cannot serve, the tab comes to the front and the real mouse clicks.
// The caller's RPC calls go straight to the daemon's tools; Safari, the
// page, and the helper are fakes.

const GHOSTTY = "com.mitchellh.ghostty";

// Safari's answer to press_mark, and the helper's to press.
type Page = { picker?: boolean; press?: { pressed: boolean; why?: string } };
type Mac = {
  app: string;
  // helper commands, and what Safari was asked of its tabs and pages, in order
  helper: string[][];
  asked: string[];
  // the tab agent window 2 showed when the helper pressed
  pressedIn?: number;
  shows(windowId: number): number | undefined;
};

// Ghostty is in front. The user's window 1, Safari's front window, shows his
// tab 3, with his tab 4 behind it. Agent window 2 shows its own page, tab
// 20, with the agent's tab 21 behind it. Showing a tab sets it active in its
// window; activating one also makes its window Safari's front window.
function mac(page: Page = {}): Mac {
  const tabs = [{ id: 3, windowId: 1, active: true }, { id: 4, windowId: 1, active: false }, { id: 20, windowId: 2, active: true }, { id: 21, windowId: 2, active: false }];
  let frontWindow = 1;
  let marks = 0;
  const show = (id: number) => {
    const windowId = tabs.find((t) => t.id === id)!.windowId;
    for (const t of tabs) if (t.windowId === windowId) t.active = t.id === id;
    return windowId;
  };
  const m: Mac = { app: GHOSTTY, helper: [], asked: [], shows: (windowId) => tabs.find((t) => t.windowId === windowId && t.active)?.id };
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      const answer = (value: unknown) => queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
      if (op === "tabs.list") return answer(tabs.map((t) => ({ ...t, ...(t.windowId === 1 && t.active ? { front: true } : {}), ...(t.windowId === frontWindow && t.active ? { shown: true } : {}) })));
      m.asked.push(`${op === "relay" ? args[1] : op} ${args[0]}`);
      if (op === "tabs.select") return (show(args[0]), answer({ ok: true }));
      if (op === "tabs.activate") return ((frontWindow = show(args[0])), answer({ ok: true }));
      const dom = op === "relay" ? args[1] : undefined;
      if (dom === "pressMark") return answer(page.picker ? { picker: true } : { mark: "__sh_press_t", width: 1247, height: 870 });
      if (dom === "pressDone") return answer(true);
      if (dom === "locate") return answer({ x: 100, y: 50, width: 80, height: 20, innerWidth: 1200, innerHeight: 800 });
      if (dom === "eval") return answer({ result: { marks, focus: true } });
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, error: `no ${op} here` })));
    },
    close() {},
  });
  spyOn(front, "input").mockImplementation(async (args) => {
    m.helper.push(args);
    if (args[0] === "front") return { bundleId: m.app };
    if (args[0] === "activate") m.app = args[1];
    if (args[0] === "press") {
      m.pressedIn = m.shows(2);
      return page.press ?? { pressed: true };
    }
    if (args[0] === "webarea") return { x: 0, y: 100, width: 1200, height: 800 };
    // the helper's closing F20, which the page counts
    if (args[0] === "click") marks++;
    return {};
  });
  spyOn(spaces, "windowOwners").mockImplementation(() => new Map([[2, 7]]));
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => callTool(tool, args));
  return m;
}

afterEach(() => {
  mock.restore();
});

const click = (tab: number, more: Record<string, unknown> = {}) => INPUT_TOOLS.real_input.run({ tab, do: "click", ref: "#go", ...more });
const run = (m: Mac, verb: string) => m.helper.filter((c) => c[0] === verb);

test("a single click on a tab behind is pressed where it is: the answer says so, and no app or window comes forward", async () => {
  const m = mac();
  expect(await click(21)).toEqual({ ok: true, background: true });
  expect(run(m, "press")).toEqual([["press", "__sh_press_t", "1247", "870"]]);
  expect({ app: m.app, activated: run(m, "activate"), asked: m.asked.filter((a) => a.startsWith("tabs.activate")) }).toEqual({ app: GHOSTTY, activated: [], asked: [] });
});

test("a tab behind another in its agent window is shown there for the press, and the window shows its own tab again after", async () => {
  const m = mac();
  await click(21);
  expect({ pressedIn: m.pressedIn, after: m.shows(2) }).toEqual({ pressedIn: 21, after: 20 });
});

test.each([[{ pressed: true }], [{ pressed: false, why: "Safari offers no press on the element" }]])("the page gets its mark taken off, pressed or not (%j)", async (press) => {
  const m = mac({ press });
  await click(21);
  expect(m.asked.filter((a) => a.startsWith("press"))).toEqual(["pressMark 21", "pressDone 21"]);
});

test("where Safari offers no press, the tab comes to the front and the real mouse clicks", async () => {
  const m = mac({ press: { pressed: false, why: "Safari offers no press on the element" } });
  expect(await click(21)).toEqual({ ok: true, at: { x: 140, y: 160 } });
  expect(run(m, "click")).toEqual([["click", "140", "160", "--count", "1", "--button", "left"]]);
});

test("a select, a date or color input, or a file input's label takes the real mouse, with no press tried", async () => {
  const m = mac({ picker: true });
  expect(await click(21)).toEqual({ ok: true, at: { x: 140, y: 160 } });
  expect(run(m, "press")).toEqual([]);
});

test.each([[{ count: 2 }, ["--count", "2", "--button", "left"]], [{ button: "right" }, ["--count", "1", "--button", "right"]]])(
  "%j takes the real mouse, with no press tried: presses in a row are single clicks, and the right button's menu opens on screen",
  async (more, flags) => {
    const m = mac();
    expect(await click(21, more)).toEqual({ ok: true, at: { x: 140, y: 160 } });
    expect({ marked: m.asked.filter((a) => a.startsWith("pressMark")), clicks: run(m, "click") }).toEqual({ marked: [], clicks: [["click", "140", "160", ...flags]] });
  },
);

test("a tab behind another in one of the user's windows is not shown there behind his back: the real mouse clicks it", async () => {
  const m = mac();
  expect(await click(4)).toEqual({ ok: true, at: { x: 140, y: 160 } });
  expect({ selected: m.asked.filter((a) => a.startsWith("tabs.select")), pressed: run(m, "press") }).toEqual({ selected: [], pressed: [] });
});

test("the tab Safari shows while it is the app in front takes the real mouse: activate first, and a page gets pointer events", async () => {
  const m = mac();
  m.app = front.SAFARI;
  expect(await click(3)).toEqual({ ok: true, at: { x: 140, y: 160 } });
  expect(m.asked.filter((a) => a.startsWith("pressMark"))).toEqual([]);
});
