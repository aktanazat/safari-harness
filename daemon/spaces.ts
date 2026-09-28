// Agent windows: every tab the harness opens goes into a Safari window of
// the agent's own, never into one of the user's windows or tab groups (his
// ask of 09-28). A window is one assignment: the agent process a call works
// for (currentOwner, owner.ts) and the group name open was given, if any.
// It opens behind his window, without focus, on the daemon's /space page,
// titled with the assignment's name, which labels the window for him. The
// page also lets the extension find the window after it reloads, which
// gives every window a new id (adopt in background.js): about:blank runs no
// content script to keep the window's id.
//
// They are plain windows, not tab groups. Safari gives extensions no tab
// groups; its window controls make one through Accessibility, but none
// deletes one safely from a window in the background: the sidebar's menu
// serves whatever row sits mid-list, a tab's as often as a group's, and File
// > Delete Tab Group did nothing there (probes of 09-28). A group left
// behind syncs to the user's other devices.
//
// When the agent exits, or its window has held nothing but its page for
// IDLE_MS, the page closes: the window goes with the agent's last tab
// (close-on-exit, tools.ts), and a tab it opened in front stays there for
// the user. Only a caller's own call may start a Safari the user quit
// (socket in bridge.ts): while the extension is gone, an ended window's
// page waits for it to come back.

import { randomUUID } from "node:crypto";
import { bridge } from "./bridge.ts";
import { currentOwner, watchOwner } from "./owner.ts";
import type { TabInfo } from "./tools.ts";

// id: this window alone, in its page's address
type Space = { key: string; id: string; window: number; emptySince?: number; unwatch?: () => void };

const spaces = new Map<string, Space>();
const making = new Map<string, Promise<Space>>();
// Ended while the extension was gone, their pages still open.
const ended = new Set<Space>();

const IDLE_MS = 2 * 60_000;
const SWEEP_MS = 5000;
// Its live page (mission.ts), which the daemon serves on this port.
const PAGE = `http://127.0.0.1:${Number(process.env.SAFARI_HARNESS_HTTP_PORT ?? 37334)}/space`;

// An assignment's name: the task's group, or "agent", with the agent's
// process id, which keeps two agents apart.
function spaceName(group: string | undefined, owner: number | undefined): string {
  const label = (group ?? "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  const who = owner === undefined ? "agent" : `agent ${owner}`;
  return label ? `${label} (${who})` : who;
}

const isPage = (t: TabInfo, s: Space) => t.url?.startsWith(`${PAGE}?id=${s.id}&`) ?? false;

const listTabs = async () => (await bridge.request("tabs.list")) as TabInfo[];

// The tabs in space's window, which the window's new id names after an
// extension reload.
async function located(space: Space, tabs?: TabInfo[]): Promise<TabInfo[]> {
  const all = tabs ?? (await listTabs());
  const inWindow = all.filter((t) => t.windowId === space.window);
  if (inWindow.length > 0) return inWindow;
  const now = (await bridge.request("windows.resolve", [space.window]).catch(() => null)) as number | null;
  if (now === null || now === space.window) return [];
  space.window = now;
  return all.filter((t) => t.windowId === now);
}

// The window an open by the calling agent goes in, made when it has none
// or the user closed it.
export async function spaceWindow(group?: string): Promise<number> {
  const owner = currentOwner();
  const key = `${owner ?? "daemon"}:${group ?? ""}`;
  const had = spaces.get(key);
  if (had && (await located(had)).length > 0) return had.window;
  if (had) await end(had);
  let made = making.get(key);
  if (!made) {
    made = (async () => {
      const id = randomUUID();
      const page = `${PAGE}?id=${id}&name=${encodeURIComponent(spaceName(group, owner))}`;
      const w = (await bridge.request("windows.open", [page])) as { windowId: number };
      const space: Space = { key, id, window: w.windowId };
      spaces.set(key, space);
      if (owner !== undefined) space.unwatch = watchOwner(owner, () => void end(space).catch((e) => console.error(`[safari-harness] closing the window of ${key} failed:`, e)));
      sweeping ??= setInterval(() => void sweep().catch(() => {}), SWEEP_MS);
      sweeping.unref();
      return space;
    })();
    making.set(key, made);
    made.finally(() => making.delete(key)).catch(() => {});
  }
  return (await made).window;
}

async function end(space: Space) {
  if (spaces.get(space.key) === space) spaces.delete(space.key);
  space.unwatch?.();
  space.unwatch = undefined;
  if (!bridge.connected) {
    ended.add(space);
    return;
  }
  ended.delete(space);
  const page = (await located(space)).find((t) => isPage(t, space));
  if (page) await bridge.request("tabs.close", [page.id], 10000);
}

let sweeping: Timer | undefined;

async function sweep() {
  if (spaces.size === 0 && ended.size === 0) {
    clearInterval(sweeping);
    sweeping = undefined;
    return;
  }
  if (!bridge.connected) return;
  for (const s of [...ended]) await end(s);
  const tabs = await listTabs();
  const now = Date.now();
  for (const s of [...spaces.values()]) {
    const inWindow = await located(s, tabs);
    if (inWindow.some((t) => !isPage(t, s))) s.emptySince = undefined;
    else s.emptySince ??= now;
    if (inWindow.length === 0 || now - s.emptySince! >= IDLE_MS) await end(s);
  }
}

// The assignment whose window's page carries id, for that page
// (mission.ts): undefined once the window has ended, or after a restart.
export function spaceById(id: string): { owner?: number; window: number } | undefined {
  const space = [...spaces.values()].find((s) => s.id === id);
  if (!space) return undefined;
  // key: "<owner, or daemon>:<group>" (spaceWindow)
  const who = space.key.slice(0, space.key.indexOf(":"));
  return who === "daemon" ? { window: space.window } : { owner: Number(who), window: space.window };
}
