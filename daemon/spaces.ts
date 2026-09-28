// Agent windows: every tab the harness opens goes into a Safari window of
// the agent's own, never into one of the user's windows or tab groups (his
// ask of 09-28). A window is one assignment: the agent process a call works
// for (currentOwner, owner.ts) and the group name open was given, if any.
// It opens behind his window, without focus, on one blank tab.
//
// They are plain windows, not tab groups. Safari gives extensions no tab
// groups; its window controls make one through Accessibility, but none
// deletes one safely from a window in the background: the sidebar's menu
// serves whatever row sits mid-list, a tab's as often as a group's, and File
// > Delete Tab Group did nothing there (probes of 09-28). A group left
// behind syncs to the user's other devices.
//
// When the agent exits, or its window has held nothing but its blank tab
// for IDLE_MS, the blank tab closes: the window goes with the agent's last
// tab (close-on-exit, tools.ts), and a tab it opened in front stays there
// for the user.

import { bridge } from "./bridge.ts";
import { currentOwner, watchOwner } from "./owner.ts";
import type { TabInfo } from "./tools.ts";

type Space = { key: string; window: number; blank: number; emptySince?: number; unwatch?: () => void };

const spaces = new Map<string, Space>();
const making = new Map<string, Promise<Space>>();

const IDLE_MS = 2 * 60_000;
const SWEEP_MS = 5000;

const listTabs = async () => (await bridge.request("tabs.list")) as TabInfo[];

// The window an open by the calling agent goes in, made when it has none
// or the user closed it.
export async function spaceWindow(group?: string): Promise<number> {
  const owner = currentOwner();
  const key = `${owner ?? "daemon"}:${group ?? ""}`;
  const had = spaces.get(key);
  if (had && (await listTabs()).some((t) => t.windowId === had.window)) return had.window;
  if (had) await end(had);
  let made = making.get(key);
  if (!made) {
    made = (async () => {
      const w = (await bridge.request("windows.open", ["about:blank"])) as { windowId: number; tabId: number };
      const space: Space = { key, window: w.windowId, blank: w.tabId };
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
  if ((await listTabs()).some((t) => t.id === space.blank)) await bridge.request("tabs.close", [space.blank], 10000);
}

let sweeping: Timer | undefined;

async function sweep() {
  if (spaces.size === 0) {
    clearInterval(sweeping);
    sweeping = undefined;
    return;
  }
  const tabs = await listTabs();
  const now = Date.now();
  for (const s of [...spaces.values()]) {
    const inWindow = tabs.filter((t) => t.windowId === s.window);
    if (inWindow.some((t) => t.id !== s.blank)) s.emptySince = undefined;
    else s.emptySince ??= now;
    if (inWindow.length === 0 || now - s.emptySince! >= IDLE_MS) await end(s);
  }
}
