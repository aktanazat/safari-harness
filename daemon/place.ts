// WebKit stops painting a page when another window covers its whole window.
// Only an owned screenshot may briefly move that window to make it paint.
// An agent window lives on the agents' display, when the Mac has one.

import { bridge } from "./bridge.ts";
import { input } from "./front.ts";

type Rect = { x: number; y: number; width: number; height: number };
// A display, its id and name, and the part of it the menu bar and Dock
// leave free.
type Screen = { id?: number; name?: string; frame: Rect; visible: Rect };
// A window on screen, as scripts/input lists them, front to back.
type Win = Rect & { safari: boolean };
type Here = { at: Rect; front: Win[]; behind: Win[]; screen: Rect; screens: Screen[] };

const FRAME_MS = 5000;
// The least part of a window that must show for it to count as shown. Any
// part shown is enough for WebKit to draw, but AppKit keeps a window's top
// out of a display's menu bar, which visibleFrame leaves in when it hides:
// on 10-22 a window put at the top of the display above came to rest 30
// points lower, under the terminal there.
const SHOWS = 0.1;

// The area two rects share.
function shared(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

// The display holding most of r, from whose top-left Safari's
// windows.update counts a window's left and top (tools.ts, ontoMainDisplay).
function holding(r: Rect, screens: Screen[]): Screen | undefined {
  let most = 0;
  let found: Screen | undefined;
  for (const s of screens) {
    const area = shared(r, s.frame);
    if (area > most) {
      most = area;
      found = s;
    }
  }
  return found;
}

// The places a window of at's size can take in a display's free part, top
// row first: each edge against the free part's or another window's, which
// is where a free place is when there is one. A window wider or taller than
// the free part goes to its left or top.
function places(at: Rect, free: Rect, windows: Rect[]): Rect[] {
  const along = (start: number, room: number, size: number, edges: number[]) =>
    size >= room ? [start] : [...new Set([start, start + room - size, ...edges])].filter((n) => n >= start && n <= start + room - size).sort((a, b) => a - b);
  const xs = along(free.x, free.width, at.width, windows.flatMap((r) => [r.x + r.width, r.x - at.width]));
  const ys = along(free.y, free.height, at.height, windows.flatMap((r) => [r.y + r.height, r.y - at.height]));
  return ys.flatMap((y) => xs.map((x) => ({ x, y, width: at.width, height: at.height })));
}

// Where the window at `at` shows: a place no window in front of it shares
// any part of, covering the least of the windows behind it, or else the
// place where the most of it shows, at least SHOWS of it; where it is
// first, then its display's places, then the other displays'. What shows
// is what is on a display less what each window in front covers, so two
// that overlap there count twice and it is never overstated. Undefined when
// too little of it shows anywhere.
function showingSpot(here: Here): Rect | undefined {
  const { at, front, behind, screens } = here;
  const own = holding(at, screens);
  const displays = own ? [own, ...screens.filter((s) => s !== own)] : screens;
  let best: { r: Rect; shows: number; covers: number } | undefined;
  for (const r of [at, ...displays.flatMap((s) => places(at, s.visible, [...front, ...behind]))]) {
    const hidden = front.reduce((sum, f) => sum + shared(r, f), 0);
    const onDisplay = screens.reduce((sum, s) => sum + shared(r, s.frame), 0);
    if (onDisplay - hidden < SHOWS * at.width * at.height) continue;
    const shows = hidden === 0 ? Infinity : onDisplay - hidden;
    const covers = behind.reduce((sum, b) => sum + shared(r, b), 0);
    if (!best || shows > best.shows || (shows === best.shows && covers < best.covers)) best = { r, shows, covers };
    if (best.shows === Infinity && best.covers === 0) break;
  }
  return best?.r;
}

// tab's window on screen, with the windows in front of it and behind it.
// "hidden" when it is minimized, or on another desktop. Undefined when the
// extension predates windows.frame, the window is in full screen or zoomed
// (Safari's windows.update moves only a normal one), or another Safari
// window has its size, so which one is the tab's cannot be told.
async function onScreen(tab: number): Promise<Here | "hidden" | undefined> {
  const frame = (await bridge.request("windows.frame", [tab], FRAME_MS)) as { width?: unknown; height?: unknown; state?: unknown } | null | undefined;
  if (typeof frame?.width !== "number" || typeof frame.height !== "number") return undefined;
  if (frame.state === "minimized") return "hidden";
  if (frame.state !== "normal") return undefined;
  const { width, height } = frame;
  const { windows, screens } = (await input(["windows"], FRAME_MS)) as { windows: (Rect & { safari: boolean })[]; screens: Screen[] };
  const mine = windows.flatMap((w, i) => (w.safari && Math.abs(w.width - width) < 1 && Math.abs(w.height - height) < 1 ? [i] : []));
  if (mine.length > 1) return undefined;
  const at = windows[mine[0]];
  const screen = at && holding(at, screens);
  if (!screen) return "hidden";
  return { at, front: windows.slice(0, mine[0]), behind: windows.slice(mine[0] + 1), screen: screen.frame, screens };
}

// Windows a screenshot has moved and not yet put back, by size: a sweep
// that met one there would take it for a window the user moved.
const uncovering = new Set<string>();
const sizeKey = (r: { width: number; height: number }) => `${Math.round(r.width)}x${Math.round(r.height)}`;

// A screenshot may temporarily move its owned window where Safari can paint
// it. Return a restoration step only when it moved; a user who moves the
// window during capture keeps their chosen position.
export async function uncover(tab: number): Promise<(() => Promise<void>) | "shown" | "covered" | "hidden" | undefined> {
  const here = await onScreen(tab);
  if (here === undefined || here === "hidden") return here;
  const to = showingSpot(here);
  if (!to) return "covered";
  if (to.x === here.at.x && to.y === here.at.y) return "shown";
  const key = sizeKey(here.at);
  uncovering.add(key);
  let restore: (() => Promise<void>) | undefined;
  try {
    await bridge.request("windows.frame", [tab, { left: Math.round(to.x - here.screen.x), top: Math.round(to.y - here.screen.y) }], FRAME_MS);
    const placed = await onScreen(tab);
    if (placed === undefined || placed === "hidden") {
      await bridge.request("windows.frame", [tab, { left: Math.round(here.at.x - here.screen.x), top: Math.round(here.at.y - here.screen.y) }], FRAME_MS);
      return undefined;
    }
    restore = async () => {
      try {
        const now = await onScreen(tab);
        if (now === undefined || now === "hidden" || now.at.x !== placed.at.x || now.at.y !== placed.at.y) return;
        await bridge.request("windows.frame", [tab, { left: Math.round(here.at.x - now.screen.x), top: Math.round(here.at.y - now.screen.y) }], FRAME_MS);
      } finally {
        uncovering.delete(key);
      }
    };
    return restore;
  } finally {
    if (!restore) uncovering.delete(key);
  }
}

// The virtual display agent-display (github.com/mikedelgaudio/agent-display)
// adds under this name, which no one looks at: agent windows go there so
// they stay off the user's screen while he works (his ask of 11-17). A Mac
// without it keeps them where Safari puts them.
const AGENTS = "Agents";

// Moves the window at here onto display to, to the place there that covers
// least of the windows already on it. Takes no focus.
async function moveOnto(tab: number, here: Here, to: Screen): Promise<void> {
  const there = [...here.front, ...here.behind].filter((w) => shared(w, to.frame) > 0);
  const covered = (r: Rect) => there.reduce((sum, w) => sum + shared(r, w), 0);
  const spot = places(here.at, to.visible, there).reduce((best, r) => (covered(r) < covered(best) ? r : best));
  await bridge.request("windows.frame", [tab, { left: Math.round(spot.x - here.screen.x), top: Math.round(spot.y - here.screen.y) }], FRAME_MS);
}

// Moves tab's window onto the Agents display, since one fully covered
// stops painting. Answers the display's id once the window is there,
// undefined when the Mac has no such display or the window is not found or
// did not land there.
export async function toAgentScreen(tab: number): Promise<number | undefined> {
  const here = await onScreen(tab);
  if (here === undefined || here === "hidden") return undefined;
  const to = here.screens.find((s) => s.name === AGENTS);
  if (!to) return undefined;
  if (holding(here.at, here.screens) === to) return to.id;
  await moveOnto(tab, here, to);
  const landed = await onScreen(tab);
  return landed !== undefined && landed !== "hidden" && holding(landed.at, landed.screens)?.name === AGENTS ? to.id : undefined;
}

// Moves tab's window off the Agents display, where a window of the user's
// is out of his sight (11-19: his hub page and an X post sat there), onto
// the display of his front Safari window elsewhere, else the main display.
// Answers whether it moved there.
export async function toUserScreen(tab: number): Promise<boolean> {
  const here = await onScreen(tab);
  if (here === undefined || here === "hidden") return false;
  const agents = here.screens.find((s) => s.name === AGENTS);
  if (!agents || holding(here.at, here.screens) !== agents) return false;
  const his = [...here.front, ...here.behind].find((w) => w.safari && holding(w, here.screens) !== agents);
  const to = (his && holding(his, here.screens)) ?? here.screens.find((s) => s !== agents);
  if (!to) return false;
  await moveOnto(tab, here, to);
  const landed = await onScreen(tab);
  return landed !== undefined && landed !== "hidden" && holding(landed.at, landed.screens)?.id === to.id;
}

// Where the Safari window of each size is: on the Agents display, off it,
// or undefined when not on screen (minimized, on another desktop) or two
// windows share the size. agents is that display's id, which a restarted
// agent-display changes; undefined while the Mac has none. strays counts
// the Safari windows on that display of none of the sizes in known.
export async function agentWindows(sizes: { width: number; height: number }[], known = sizes): Promise<{ agents?: number; at: ("agents" | "off" | undefined)[]; strays: number }> {
  const { windows, screens } = (await input(["windows"], FRAME_MS)) as { windows: Win[]; screens: Screen[] };
  const agents = screens.find((s) => s.name === AGENTS);
  if (!agents) return { at: [], strays: 0 };
  const sized = (w: Rect, size: { width: number; height: number }) => Math.abs(w.width - size.width) < 1 && Math.abs(w.height - size.height) < 1;
  const at = sizes.map((size) => {
    const mine = windows.filter((w) => w.safari && sized(w, size));
    if (mine.length !== 1 || uncovering.has(sizeKey(mine[0]))) return undefined;
    return holding(mine[0], screens) === agents ? "agents" : "off";
  });
  const strays = windows.filter((w) => w.safari && holding(w, screens) === agents && !known.some((size) => sized(w, size))).length;
  return { agents: agents.id, at, strays };
}
