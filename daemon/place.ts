// Where an agent's window shows its page. WebKit draws nothing in a window
// other windows cover whole: its frame callbacks wait, so the paint check
// before every screenshot (background.js) never passes. On 10-22 Safari had
// opened every agent window at one place on the display above, each over
// the ones before it, and every agent's shots but the front one's failed
// "the protected page did not paint" until its window was moved by hand.
// An agent's new window (spaces.ts), and the calling agent's own window
// when its shot did not paint (tools.ts, captureTab), move where no window
// in front of them covers any of them, or else where the most of them
// shows. No other window moves. scripts/input lists every app's windows on
// screen front to back, in global points from the main display's top-left;
// a tab's window is the Safari window of its size, which no other window
// has (spaces.ts nextSize, background.js "window").

import { bridge } from "./bridge.ts";
import { input } from "./front.ts";

type Rect = { x: number; y: number; width: number; height: number };
// A display, and the part of it the menu bar and Dock leave free.
type Screen = { frame: Rect; visible: Rect };
type Here = { at: Rect; front: Rect[]; behind: Rect[]; screen: Rect; screens: Screen[] };

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

// Moves tab's window, without focus, where it shows (showingSpot): "moved";
// "shown" when it is there already; "covered" when too little of it would
// show anywhere; "hidden" when it is not on screen; undefined when its
// window cannot be told or moved. left and top count from the top-left of
// the display it is on, as Safari's windows.update counts them.
export async function uncover(tab: number): Promise<"moved" | "shown" | "covered" | "hidden" | undefined> {
  const here = await onScreen(tab);
  if (here === undefined || here === "hidden") return here;
  const to = showingSpot(here);
  if (!to) return "covered";
  if (to.x === here.at.x && to.y === here.at.y) return "shown";
  await bridge.request("windows.frame", [tab, { left: Math.round(to.x - here.screen.x), top: Math.round(to.y - here.screen.y) }], FRAME_MS);
  return "moved";
}
