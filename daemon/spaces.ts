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
// Each window then becomes a Safari tab group of that name (his ask of
// 09-28: a tab group per assignment). Safari gives extensions no tab groups
// and the daemon has no Accessibility, so a keeper in the agent's terminal
// makes and deletes them (keeper.ts, groups.ts), asking here what to do
// through the hidden space tool; a window's size, which no other window
// has, is how it finds the window on screen. Until the user has left the
// keys alone a while the window stays plain (waiting); one that cannot
// become a group says why (plain).
//
// When the agent exits, or its window has held nothing but its page for
// IDLE_MS, the assignment ends. A plain window's page closes: the window
// goes with the agent's last tab (close-on-exit, tools.ts), and a tab it
// opened in front stays there for the user. A group waits for the keeper,
// which moves every tab but the page out to windows of the user's own
// (release) and deletes the group, closing the page with it. Only a
// caller's own call may start a Safari the user quit (socket in bridge.ts):
// while the extension is gone, an ended window waits for it to come back.

import { randomUUID } from "node:crypto";
import { bridge } from "./bridge.ts";
import { groupsOff } from "./groups.ts";
import { currentOwner, watchOwner } from "./owner.ts";
import type { TabInfo } from "./tools.ts";

type Size = { width: number; height: number };
type Group = "waiting" | "grouped" | "plain";
// What an open says of its window: its name, and whether it is a tab group
// (grouped), will be one once the user is away from the keys (waiting), or
// stays plain, and why.
export type SpaceNote = { name: string; group: Group; why?: string };
// id: this window alone, in its page's address
type Space = SpaceNote & { key: string; id: string; window: number; size: Size; owner?: number; emptySince?: number; unwatch?: () => void };

const spaces = new Map<string, Space>();
const making = new Map<string, Promise<Space>>();
// Ended while the extension was gone, their pages still open.
const ended = new Set<Space>();
// Ended groups, by name, for the keeper to delete.
const closing = new Map<string, Space>();

const IDLE_MS = 2 * 60_000;
const SWEEP_MS = 5000;
// main.ts serves it (spacePage) on this port.
const PAGE = `http://127.0.0.1:${Number(process.env.SAFARI_HARNESS_HTTP_PORT ?? 37334)}/space`;

// Window sizes no other window is likely to have, one per assignment, from
// a random start so a restarted daemon does not reuse its last run's.
let sized = Math.floor(Math.random() * 5000);
function nextSize(): Size {
  const n = sized++;
  return { width: 1000 + (n % 250), height: 780 + (Math.floor(n / 250) % 20) * 5 };
}

// The page an agent window opens on, titled with its assignment's name.
export function spacePage(url: URL): Response {
  const name = (url.searchParams.get("name") ?? "agent").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>${name}</title><p>This window holds the tabs of ${name}. It closes when that task ends.</p>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// An assignment's name, which its tab group takes: the task's group, or
// "agent", with the agent's process id, which keeps two agents apart. Quotes
// would blur the name a delete's confirm sheet quotes, and % the one the
// window's group picker spells.
function spaceName(group: string | undefined, owner: number | undefined): string {
  const label = (group ?? "").replace(/[%"“”]/g, "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
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
export async function spaceWindow(group?: string): Promise<Space> {
  const owner = currentOwner();
  const key = `${owner ?? "daemon"}:${group ?? ""}`;
  const had = spaces.get(key);
  if (had && (await located(had)).length > 0) return had;
  if (had) await end(had);
  let made = making.get(key);
  if (!made) {
    made = (async () => {
      const id = randomUUID();
      const name = spaceName(group, owner);
      const size = nextSize();
      // The name and size also find the window of a group a restarted
      // daemon no longer knows (orphaned).
      const page = `${PAGE}?id=${id}&name=${encodeURIComponent(name)}&size=${size.width}x${size.height}`;
      const w = (await bridge.request("windows.open", [page, size])) as { windowId: number };
      const off = groupsOff();
      const space: Space = { key, id, window: w.windowId, name, size, owner, group: off ? "plain" : "waiting", ...(off ? { why: off } : {}) };
      spaces.set(key, space);
      if (owner !== undefined) space.unwatch = watchOwner(owner, () => void end(space).catch((e) => console.error(`[safari-harness] closing the window of ${key} failed:`, e)));
      sweeping ??= setInterval(() => void sweep().catch(() => {}), SWEEP_MS);
      sweeping.unref();
      return space;
    })();
    making.set(key, made);
    made.finally(() => making.delete(key)).catch(() => {});
  }
  return made;
}

export const spaceNote = (s: Space): SpaceNote => ({ name: s.name, group: s.group, ...(s.why ? { why: s.why } : {}) });

// The window of a group a restarted daemon no longer knows, found by the
// name and size its page's address carries.
async function orphaned(name: string): Promise<Space | undefined> {
  for (const t of await listTabs()) {
    if (!t.url?.startsWith(`${PAGE}?`) || t.windowId === undefined) continue;
    const q = new URL(t.url).searchParams;
    const [width, height] = (q.get("size") ?? "").split("x").map(Number);
    if (q.get("name") !== name || !width || !height) continue;
    const s: Space = { key: `orphan:${name}`, id: q.get("id") ?? "", window: t.windowId, name, size: { width, height }, group: "grouped" };
    closing.set(name, s);
    return s;
  }
  return undefined;
}

// The keeper's side (keeper.ts). state lists the windows that are or will
// be groups and the ended groups, with each window's size and, while Safari
// runs, how many tabs a waiting one holds; grouped and plain say how a
// window turned out; release moves every tab but its page out of an ended
// group's window, since deleting the group closes its tabs, and says how
// many stayed (left); gone forgets the group; scratch opens a window to
// delete from a group whose own window is gone. None asks anything of a
// quit Safari.
export async function spaceTool(a: Record<string, unknown>): Promise<unknown> {
  const name = String(a.name ?? "");
  const live = [...spaces.values()].find((s) => s.name === name);
  switch (a.op) {
    case "state": {
      const watched = [...spaces.values()].filter((s) => s.group !== "plain");
      const tabs = bridge.connected && watched.some((s) => s.group === "waiting") ? await listTabs() : undefined;
      const row = async (s: Space, over: boolean) => ({ name: s.name, ...s.size, owner: s.owner, group: s.group, ended: over, ...(tabs && !over ? { tabs: (await located(s, tabs)).length } : {}) });
      return { connected: bridge.connected, spaces: await Promise.all([...[...closing.values()].map((s) => row(s, true)), ...watched.map((s) => row(s, false))]) };
    }
    case "grouped":
    case "plain":
      if (!live) return { ok: false };
      live.group = a.op;
      live.why = a.op === "plain" ? String(a.why ?? "") : undefined;
      return { ok: true };
    case "release": {
      if (!bridge.connected) return { ok: false };
      const s = closing.get(name) ?? (await orphaned(name));
      if (!s) return { ok: true, tabs: 0, left: 0 };
      // A tab can close meanwhile (close-on-exit): it needs no moving then.
      for (const t of await located(s)) if (!isPage(t, s)) await bridge.request("tabs.detach", [t.id, s.window]).catch(() => undefined);
      const now = await located(s);
      return { ok: true, tabs: now.length, left: now.filter((t) => !isPage(t, s)).length, ...s.size };
    }
    case "gone":
      return { ok: closing.delete(name) };
    case "scratch": {
      if (!bridge.connected) return { ok: false };
      const s = await spaceWindow("tab group cleanup");
      s.group = "plain";
      s.why = "a window to delete tab groups from";
      return { ok: true, ...s.size, tabs: (await located(s)).length };
    }
  }
  throw new Error("space op must be state, grouped, plain, release, gone, or scratch");
}

async function end(space: Space) {
  if (spaces.get(space.key) === space) spaces.delete(space.key);
  space.unwatch?.();
  space.unwatch = undefined;
  if (space.group === "grouped") {
    closing.set(space.name, space);
    return;
  }
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
