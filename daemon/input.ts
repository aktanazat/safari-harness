// Real mouse and keyboard input through scripts/input, which posts events the
// way a physical mouse and keyboard do, so pages see event.isTrusted true.
// Captcha checkboxes, some drag handles, and sites that check isTrusted
// ignore the extension's scripted events. Posting input needs Accessibility
// permission, which the launchd daemon lacks, so these tools run in the
// caller (terminal, MCP server) and reach the tab through the daemon's RPC
// port. Real input lands on whatever is on screen, so the tab comes to the
// front for the moment it takes.

import { inFront, input, type TabOps } from "./front.ts";
import { rpc } from "./rpc.ts";
import { REF, resolveTab, TAB, type TabInfo, type Tool } from "./tools.ts";

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

// Real input reaches tabs through the daemon's RPC port.
const VIA_RPC: TabOps = { tabs: async () => (await rpc("tabs")) as TabInfo[], activate: (tab) => rpc("activate", { tab }) };

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
  if (keys && !before.focus) throw new Error("the page does not have keyboard focus, so no keys were sent; real_click a field first");
  await input(args, timeout);
  await pageState(tab, { focus: false, after: before.marks, ms: 500 }).catch(() => {});
}

// Clicks the middle of ref with the real mouse; the tab must be in front.
// locate gives the element's box in CSS px within the page's viewport,
// scrolled into view and with frame offsets added, once the tab has painted;
// webarea gives that viewport in screen points. Their width ratio is the
// page zoom.
async function clickRef(tab: number, ref: unknown, count: number, button: string): Promise<Point> {
  const box = ((await rpc("locate", { tab, ref })) ?? {}) as Partial<Rect & { innerWidth: number; innerHeight: number }>;
  const { x, y, width, height, innerWidth, innerHeight } = box;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" || typeof innerWidth !== "number" || typeof innerHeight !== "number") {
    throw new Error(`locate returned no box for ${String(ref)}: ${JSON.stringify(box)}`);
  }
  const cx = x + width / 2;
  const cy = y + height / 2;
  if (width <= 0 || height <= 0 || cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
    throw new Error(`${String(ref)} is not visible on the page, so the mouse cannot reach it`);
  }
  const area = (await input(["webarea"])) as Rect;
  const scale = area.width / innerWidth;
  const at = { x: Math.round(area.x + cx * scale), y: Math.round(area.y + cy * scale) };
  await post(tab, ["click", String(at.x), String(at.y), "--count", String(count), "--button", button], false);
  return at;
}

// One tool for the three kinds of input: agents reach for it rarely, and
// every tool listed costs its description on every turn.
const REAL: Record<string, (tab: number, a: Record<string, unknown>) => Promise<unknown>> = {
  click: async (tab, a) => {
    const count = a.count ?? 1;
    if (count !== 1 && count !== 2 && count !== 3) throw new Error("count must be 1, 2, or 3");
    const button = a.button ?? "left";
    if (button !== "left" && button !== "right") throw new Error("button must be left or right");
    const at = await inFront(tab, VIA_RPC, () => clickRef(tab, a.ref, count, button));
    return { ok: true, at };
  },
  type: async (tab, a) => {
    const text = a.text;
    if (typeof text !== "string") throw new Error("type needs text");
    await inFront(tab, VIA_RPC, async () => {
      if (a.ref !== undefined) await clickRef(tab, a.ref, 1, "left");
      // A character takes about 25 ms; allow twice that.
      await post(tab, ["type", text], true, 10000 + text.length * 50);
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
    desc: "The real mouse and keyboard, for controls that ignore scripted input: click a ref, type text (at ref, or where the caret is), or press a key (Enter, Cmd+A). Brings the tab to the front for a moment.",
    params: {
      tab: TAB,
      do: { type: "string", enum: ["click", "type", "key"], description: "what to do" },
      ref: REF,
      text: { type: "string", description: "to type; a line break presses Return" },
      key: { type: "string", description: "key name or combo" },
      count: { type: "number", description: "2 or 3: double or triple click" },
      button: { type: "string", enum: ["left", "right"], description: "default left" },
    },
    required: ["tab", "do"],
    run: async (a) => {
      const act = typeof a.do === "string" ? REAL[a.do] : undefined;
      if (!act) throw new Error("do must be click, type, or key");
      if (a.do === "click" && a.ref === undefined) throw new Error("click needs ref");
      return act(await resolveTab(a.tab, VIA_RPC.tabs), a);
    },
  },
};
