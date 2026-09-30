// Real mouse and keyboard input through scripts/input, which posts events the
// way a physical mouse and keyboard do, so pages see event.isTrusted true.
// Captcha checkboxes, some drag handles, and sites that check isTrusted
// ignore the extension's scripted events. Posting input needs Accessibility
// permission, which the launchd daemon lacks, so these tools run in the
// caller (terminal, MCP server) and reach the tab through the daemon's RPC
// port. Real input lands on whatever is on screen, so the tab comes to the
// front for the moment it takes. A single click on a tab not in front goes
// through Safari's accessibility tree instead, and nothing comes forward.

import { frontApp, inFront, input, SAFARI, type TabOps } from "./front.ts";
import { pageErrorsOf } from "./receipt.ts";
import { rpc } from "./rpc.ts";
import { REF, TAB, type TabInfo, type Tool, X, Y } from "./tools.ts";

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

// Real input reaches tabs through the daemon's RPC port. It gives the user
// back his own front tab, so it lists his tabs too (tabs-view.ts).
const VIA_RPC: TabOps = { tabs: async () => (await rpc("tabs", { all: true })) as TabInfo[], activate: (tab) => rpc("activate", { tab }) };

type PageState = { marks: number; focus: boolean };

// The page's count of the helper's closing F20 presses (mark in
// scripts/input.swift), kept in the content script's own world and set up
// on first use in each page.
const MARKS = `(window.__realInputMarks ??= (() => { const s = { n: 0 }; addEventListener("keyup", (e) => { if (e.code === "F20") s.n++; }, true); return s; })())`;

// Waits in the page, up to ms, until it has seen more than `after` marks and,
// when focus is asked for, has keyboard focus. Returns the count and the
// focus either way. Safari stops a hidden tab's timers, which would stall
// the wait in the page, so it has a limit here as well.
async function pageState(tab: number, want: { focus: boolean; after: number; ms: number }): Promise<PageState> {
  const expression = `(() => {
    const s = ${MARKS};
    const end = Date.now() + ${want.ms};
    const { promise, resolve } = Promise.withResolvers();
    const check = () => {
      if ((s.n > ${want.after} && (${!want.focus} || document.hasFocus())) || Date.now() >= end) resolve({ marks: s.n, focus: document.hasFocus() });
      else setTimeout(check, 10);
    };
    check();
    return promise;
  })()`;
  const { promise: late, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`tab ${tab} stopped answering`)), want.ms + 3000);
  try {
    const { result } = (await Promise.race([rpc("eval", { tab, expression }), late])) as { result?: PageState };
    if (typeof result?.marks !== "number") throw new Error(`tab ${tab} did not report its input state`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// Posts real input to the tab with a helper click, type, or key command.
// Safari hands an event to whichever tab is in front when it gets to it, not
// when it was posted, so both ends are guarded. Keys go only to a page that
// has keyboard focus. Afterwards this waits until the page has seen the
// helper's closing F20 press, which follows all the rest, before the user's
// tab can come back. A page does not see keys that go into an embedded
// frame, so that wait ends after half a second. Its failure is ignored: the
// input is already sent, and an error would invite a retry that repeats it.
async function post(tab: number, args: string[], keys: boolean, timeout?: number): Promise<void> {
  const before = await pageState(tab, { focus: keys, after: -1, ms: keys ? 1000 : 0 });
  if (keys && !before.focus) throw new Error("the page does not have keyboard focus, so no keys were sent; click a field with real_input first");
  await input(args, timeout);
  await pageState(tab, { focus: false, after: before.marks, ms: 500 }).catch(() => {});
}

// Clicks the middle of ref, or the point x, y, with the real mouse; the tab
// must be in front. x and y are what click takes: a point of the viewport
// in CSS px, as the page's clientX and clientY count it. locate gives the
// target in CSS px within the top page's viewport, and that viewport's
// size, once the tab has painted: an element's box scrolled into view with
// frame offsets added, or the point as a box of no size. webarea gives the
// page area of Safari's front window in screen points; their width ratio
// is the page zoom. An area whose height at that zoom is not the
// viewport's shows another page (another window came in front), where the
// click would land, so nothing is clicked. A window with no page on show
// has a prompt or panel in front of it, such as Touch ID or a passkey,
// which only the user can answer. The point clicked is in global screen
// points, negative on a display above or left of the main one.
async function clickAt(tab: number, a: Record<string, unknown>, count: number, button: string): Promise<Point> {
  const point = a.ref === undefined;
  const what = point ? `${String(a.x)}, ${String(a.y)}` : String(a.ref);
  const box = ((await rpc("locate", point ? { tab, x: a.x, y: a.y } : { tab, ref: a.ref })) ?? {}) as Partial<Rect & { innerWidth: number; innerHeight: number }>;
  const { x, y, width, height, innerWidth, innerHeight } = box;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" || typeof innerWidth !== "number" || typeof innerHeight !== "number") {
    throw new Error(`locate returned no box for ${what}: ${JSON.stringify(box)}`);
  }
  const cx = x + width / 2;
  const cy = y + height / 2;
  if ((!point && (width <= 0 || height <= 0)) || cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) {
    throw new Error(`${what} is not visible in the page's ${innerWidth}x${innerHeight} viewport, so the mouse cannot reach it`);
  }
  const area = (await input(["webarea"]).catch((e: unknown) => {
    if (e instanceof Error && e.message.includes("no web page is showing")) {
      throw new Error(`Safari shows no page for tab ${tab}: a prompt or panel is in front of its window (Touch ID, a passkey, a permission), so no input was sent; the user must answer it (handoff)`);
    }
    throw e;
  })) as Rect;
  const scale = area.width / innerWidth;
  if (Math.abs(area.height / scale - innerHeight) > 2) {
    throw new Error(`Safari's front window shows a page of another size than tab ${tab}'s (another window or a panel came in front), so no input was sent; try again, and if a prompt is showing, the user must answer it (handoff)`);
  }
  const at = { x: Math.round(area.x + cx * scale), y: Math.round(area.y + cy * scale) };
  await post(tab, ["click", String(at.x), String(at.y), "--count", String(count), "--button", button], false);
  return at;
}

// press_mark's answer once it has marked the element (pressMark in
// extension/content.js): the class the helper finds it by, and its
// window's size.
type Mark = { mark: string; width: number; height: number };
const isMark = (v: unknown): v is Mark =>
  !!v && typeof v === "object" && "mark" in v && typeof v.mark === "string" && "width" in v && typeof v.width === "number" && "height" in v && typeof v.height === "number";

// Presses ref through Safari's accessibility tree (press in
// scripts/input.swift), which reaches a page in a window behind another
// app's: the page gets a trusted click (mousedown, mouseup, and click; no
// pointer events, and a detail of 0), and Safari, its windows, and the
// pointer stay as they were. The tree holds only the tab each window
// shows, so a tab behind another in its agent window is shown there for
// the press and put back after. Returns the errors the page threw from the
// press on (pressDone in extension/content.js). Returns null, having
// pressed nothing, where the real mouse takes over: the tab Safari shows
// in front while Safari is the app in front, where it takes nothing from
// the user (so activate, then real_input, gives a page the real mouse); a
// tab behind another in one of his windows; a control Safari answers with
// its own UI; and an element the tree lacks (a canvas) or offers no press
// on.
async function pressBehind(tab: number, ref: unknown): Promise<string[] | null> {
  const [app, tabs] = await Promise.all([frontApp(), VIA_RPC.tabs()]);
  const target = tabs.find((t) => t.id === tab);
  if (!target) throw new Error(`no tab ${tab}`);
  if (app === SAFARI && target.shown) return null;
  const back = target.active ? undefined : tabs.find((t) => t.windowId === target.windowId && t.active);
  if (back && !(await rpc("select_tab", { tab }))) return null;
  try {
    const marked = await rpc("press_mark", { tab, ref });
    if (marked && typeof marked === "object" && "picker" in marked) return null;
    if (!isMark(marked)) throw new Error(`press_mark returned no mark for ${String(ref)}: ${JSON.stringify(marked)}`);
    let pressed = false;
    let errors: unknown;
    try {
      const r = await input(["press", marked.mark, String(marked.width), String(marked.height)]);
      pressed = !!r && typeof r === "object" && "pressed" in r && r.pressed === true;
    } finally {
      errors = await rpc("press_done", { tab, ref, mark: marked.mark, ms: pressed ? 500 : 0 }).catch(() => []);
    }
    if (!pressed) return null;
    return Array.isArray(errors) ? errors.filter((e): e is string => typeof e === "string") : [];
  } finally {
    if (back) await rpc("select_tab", { tab: back.id }).catch(() => {});
  }
}

// One tool for the three kinds of input: agents reach for it rarely, and
// every tool listed costs its description on every turn.
const REAL: Record<string, (tab: number, a: Record<string, unknown>) => Promise<object>> = {
  click: async (tab, a) => {
    const count = a.count ?? 1;
    if (count !== 1 && count !== 2 && count !== 3) throw new Error("count must be 1, 2, or 3");
    const button = a.button ?? "left";
    if (button !== "left" && button !== "right") throw new Error("button must be left or right");
    // A press is one click of the left button on an element: two in a row
    // are two clicks, never a double click, the right button's menu opens
    // on screen over the user's app, and a point is for what the tree
    // cannot press (a canvas).
    if (count === 1 && button === "left" && a.ref !== undefined) {
      const errors = await pressBehind(tab, a.ref);
      if (errors) return { ok: true, background: true, ...pageErrorsOf(errors) };
    }
    const at = await inFront(tab, VIA_RPC, () => clickAt(tab, a, count, button));
    return { ok: true, at };
  },
  type: async (tab, a) => {
    const text = a.text;
    if (typeof text !== "string") throw new Error("type needs text");
    await inFront(tab, VIA_RPC, async () => {
      if (a.ref !== undefined) await clickAt(tab, a, 1, "left");
      // A character takes about 60 ms (input.swift); allow twice that.
      await post(tab, ["type", text], true, 10000 + text.length * 120);
    });
    return { ok: true };
  },
  key: async (tab, a) => {
    const key = a.key;
    if (typeof key !== "string") throw new Error("key needs key");
    await inFront(tab, VIA_RPC, () => post(tab, ["key", key], true));
    return { ok: true };
  },
};

export const INPUT_TOOLS: Record<string, Tool> = {
  real_input: {
    desc: "The real mouse and keyboard, for controls that ignore scripted input: click a ref (or x/y), type text (at ref or the caret), or press a key (Enter, Cmd+A). One left click on a ref stays in the background; the rest bring the tab to the front briefly.",
    params: {
      tab: TAB,
      do: { type: "string", enum: ["click", "type", "key"], description: "what to do" },
      ref: REF,
      text: { type: "string", description: "to type; a line break presses Return" },
      key: { type: "string", description: "key name or combo" },
      count: { type: "number", description: "2 or 3: double or triple click" },
      button: { type: "string", enum: ["left", "right"], description: "default left" },
    },
    // click's x and y, which its listing describes
    unlisted: { x: X, y: Y },
    required: ["tab", "do"],
    run: async (a) => {
      const act = typeof a.do === "string" ? REAL[a.do] : undefined;
      if (!act) throw new Error("do must be click, type, or key");
      const point = a.x !== undefined || a.y !== undefined;
      if (point && (a.do !== "click" || a.ref !== undefined)) throw new Error("x and y are for a click without ref");
      if (point && !(Number.isFinite(a.x) && Number.isFinite(a.y))) throw new Error("a click at a point needs x and y, both numbers");
      if (a.do === "click" && !point && a.ref === undefined) throw new Error("click needs ref, or x and y");
      // The daemon names the tab: it alone hears the new id a deploy gave a
      // tab the agent calls by its old one, and says so in replaced.
      const { tab, ...news } = (await rpc("resolve_tab", { tab: a.tab })) as { tab: number };
      return { ...(await act(tab, a)), ...news };
    },
  },
};
