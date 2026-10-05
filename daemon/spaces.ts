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
// When the agent exits, when its turn ends and the window holds nothing
// but its page, or when the window has held nothing but its page for
// IDLE_MS, the assignment ends. A plain window's page closes: the window
// goes with the agent's last tab (tools.ts closes them), and a tab it kept
// stays there for the user. A group waits for the keeper, which moves
// every tab but the page out to windows of the user's own
// (release) and deletes the group, closing the page with it. So does a
// window the keeper is making a group of, until it says how that went:
// closed under its steps, the window left a group no one deleted. Only a
// caller's own call may start a Safari the user quit (socket in bridge.ts):
// while the extension is gone, an ended window waits for it to come back.
// The windows are saved as they change, so a restarted daemon picks up
// where the last left off (loadSpaces), and the page of a window no record
// holds any more closes at the next sweep (reclaim).

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { bridge } from "./bridge.ts";
import { lastRaised } from "./front.ts";
import { groupsOff, readQueue } from "./groups.ts";
import { note } from "./journal.ts";
import { currentOwner, watchOwner } from "./owner.ts";
import type { TabInfo } from "./tools.ts";

type Size = { width: number; height: number };
type Group = "waiting" | "making" | "grouped" | "plain";
// What an open says of its window: its name, and whether it is a tab group
// (grouped), is becoming one (making), will be one once the user is away
// from the keys (waiting), or stays plain, and why.
export type SpaceNote = { name: string; group: Group; why?: string };
// id: this window alone, in its page's address
// done: the agent's turn ended (turnEnded); the window ends once it holds
// nothing but its page, and its agent's next open clears it
export type Space = SpaceNote & { key: string; id: string; window: number; size: Size; owner?: number; emptySince?: number; done?: true; unwatch?: () => void };

const spaces = new Map<string, Space>();
const making = new Map<string, Promise<Space>>();
// Ended while the extension was gone, their pages still open.
const ended = new Set<Space>();
// Ended groups, by name, for the keeper to delete.
const closing = new Map<string, Space>();
// The ids of windows being opened, whose pages show before their records.
const opening = new Set<string>();

const IDLE_MS = 2 * 60_000;
const SWEEP_MS = 5000;
// Its live page (mission.ts), which the daemon serves on this port.
const PAGE = `http://127.0.0.1:${Number(process.env.SAFARI_HARNESS_HTTP_PORT ?? 37334)}/space`;

// Window sizes no other window is likely to have, one per assignment, from
// a random start so a restarted daemon does not reuse its last run's.
let sized = Math.floor(Math.random() * 5000);
function nextSize(): Size {
  const n = sized++;
  return { width: 1000 + (n % 250), height: 780 + (Math.floor(n / 250) % 20) * 5 };
}

// An assignment's name, which its tab group takes: the task's group, or
// "agent", with the agent's process id, which keeps two agents apart, and
// a window number when a group of that name is still to be deleted
// (groups.json) or a window has it: a restarted daemon gave an agent's new
// window the name of the group its last run made, and the keeper then
// waited on that group for good. Quotes would blur the name a delete's
// confirm sheet quotes, and % the one the window's group picker spells.
function spaceName(group: string | undefined, owner: number | undefined): string {
  const label = (group ?? "").replace(/[%"“”]/g, "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  const who = owner === undefined ? "agent" : `agent ${owner}`;
  const base = label ? `${label} (${who})` : who;
  const taken = new Set([...Object.keys(readQueue()), ...[...spaces.values(), ...closing.values()].map((s) => s.name)]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}, window ${n}`)) n++;
  return `${base}, window ${n}`;
}

const isPage = (t: TabInfo, s: Space) => t.url?.startsWith(`${PAGE}?id=${s.id}&`) ?? false;

const listTabs = async () => (await bridge.request("tabs.list")) as TabInfo[];

// The keeper begins, or is done, making space's window a tab group. The
// extension takes no tab Safari makes in the window meanwhile for a page's
// popup (09-30: a blank one went to an agent, which could neither read nor
// close it; 01a0f14c). A quit Safari hears nothing, and one that cannot
// answer does not hold up the keeper.
async function regrouping(space: Space, on: boolean) {
  if (bridge.connected) await bridge.request("windows.regrouping", [space.window, on]).catch(() => undefined);
}

// The tabs in space's window. Its page names the window: Safari gives every
// window a new id when the extension reloads and when Safari itself starts
// again, which no reload maps. On 10-05 every agent's window was lost three
// times so: its page closed, its tabs stayed in a window no one owned, and
// the agent's next tab opened another window. Without the page, the
// extension maps an id a reload changed.
async function located(space: Space, tabs?: TabInfo[]): Promise<TabInfo[]> {
  const all = tabs ?? (await listTabs());
  const page = all.find((t) => isPage(t, space))?.windowId;
  if (page !== undefined && page !== space.window) {
    space.window = page;
    save();
  }
  const inWindow = all.filter((t) => t.windowId === space.window);
  if (inWindow.length > 0) return inWindow;
  const now = (await bridge.request("windows.resolve", [space.window]).catch(() => null)) as number | null;
  if (now === null || now === space.window) return [];
  space.window = now;
  save();
  return all.filter((t) => t.windowId === now);
}

// The window an open by the calling agent goes in, made when it has none
// or the user closed it.
export async function spaceWindow(group?: string): Promise<Space> {
  const owner = currentOwner();
  const key = `${owner ?? "daemon"}:${group ?? ""}`;
  const had = spaces.get(key);
  if (had && (await located(had)).length > 0) {
    delete had.done;
    return had;
  }
  if (had) await end(had);
  let made = making.get(key);
  if (!made) {
    made = (async () => {
      const id = randomUUID();
      opening.add(id);
      try {
        const name = spaceName(group, owner);
        const size = nextSize();
        // The name and size also find the window of a group a restarted
        // daemon no longer knows (orphaned).
        const page = `${PAGE}?id=${id}&name=${encodeURIComponent(name)}&size=${size.width}x${size.height}`;
        const w = (await bridge.request("windows.open", [page, size])) as { windowId: number };
        const off = groupsOff();
        const space: Space = { key, id, window: w.windowId, name, size, owner, group: off ? "plain" : "waiting", ...(off ? { why: off } : {}) };
        spaces.set(key, space);
        watch(space);
        save();
        return space;
      } finally {
        opening.delete(id);
      }
    })();
    making.set(key, made);
    made.finally(() => making.delete(key)).catch(() => {});
  }
  return made;
}

function watch(space: Space) {
  if (space.owner !== undefined) space.unwatch = watchOwner(space.owner, () => void end(space).catch((e) => console.error(`[safari-harness] closing the window of ${space.key} failed:`, e)));
  sweepSoon();
}

// The windows, saved as they change, so a restarted daemon (a deploy)
// still knows them: an agent's next tab joins its window, the window still
// closes when the agent exits, and the keeper still deletes its group.
// Before, a restart left every agent window open for good.
type Kept = Omit<Space, "unwatch" | "emptySince" | "done">;
let spacesFile: string | undefined;

export function loadSpaces(path: string): void {
  spacesFile = path;
  let saved: { spaces?: Kept[]; closing?: Kept[]; ended?: Kept[] } = {};
  try {
    saved = JSON.parse(readFileSync(path, "utf8")) as typeof saved;
  } catch {
    // none kept yet
  }
  for (const s of saved.spaces ?? []) {
    spaces.set(s.key, s);
    watch(s);
  }
  for (const s of saved.closing ?? []) closing.set(s.name, s);
  for (const s of saved.ended ?? []) ended.add(s);
  // The first sweep also closes what the last daemon lost track of.
  sweepSoon();
}

function save() {
  if (!spacesFile) return;
  const kept = (s: Space): Kept => ({ key: s.key, id: s.id, window: s.window, name: s.name, size: s.size, owner: s.owner, group: s.group, ...(s.why ? { why: s.why } : {}) });
  try {
    writeFileSync(spacesFile, JSON.stringify({ spaces: [...spaces.values()].map(kept), closing: [...closing.values()].map(kept), ended: [...ended].map(kept) }));
  } catch (e) {
    console.error("[safari-harness] window list not written:", e instanceof Error ? e.message : e);
  }
}

// The reasons each agent has been told for a window staying plain, so each
// comes once per agent, not once per window: on 09-29 agent 21859's windows
// 681333, 693176, and 801195 each repeated a day-old reason
// (groups-off.json), 330 characters that only the user can act on. Calls
// with no agent known share one list.
const told = new Map<number | undefined, Set<string>>();

// What an open says of its window, with why it stays plain the first time
// its agent meets that reason.
export function spaceNote(s: Space): SpaceNote {
  let reasons = told.get(s.owner);
  if (!reasons) {
    reasons = new Set();
    told.set(s.owner, reasons);
    if (s.owner !== undefined) watchOwner(s.owner, () => told.delete(s.owner));
  }
  const why = s.why === undefined || reasons.has(s.why) ? undefined : s.why;
  if (why) reasons.add(why);
  return { name: s.name, group: s.group, ...(why ? { why } : {}) };
}

// What an agent window's page says in its address (spaceWindow): the
// window's id, name, and size. A copy the user opened from /agents, which
// links pages by id and name alone, is his.
function pageAt(t: TabInfo): { tab: number; window: number; id: string; name: string; size: Size } | undefined {
  if (!t.url?.startsWith(`${PAGE}?`) || t.windowId === undefined) return undefined;
  const q = new URL(t.url).searchParams;
  const [width, height] = (q.get("size") ?? "").split("x").map(Number);
  const id = q.get("id");
  const name = q.get("name");
  return id && name && width && height ? { tab: t.id, window: t.windowId, id, name, size: { width, height } } : undefined;
}

// The window of a group a restarted daemon no longer knows, found by the
// name and size its page's address carries.
async function orphaned(name: string): Promise<Space | undefined> {
  const p = (await listTabs()).map(pageAt).find((x) => x?.name === name);
  if (!p) return undefined;
  const s: Space = { key: `orphan:${name}`, id: p.id, window: p.window, name, size: p.size, group: "grouped" };
  closing.set(name, s);
  save();
  return s;
}

// The keeper's side (keeper.ts). state lists the windows that are or will
// be groups and the ended groups, with each window's size and, while Safari
// runs, how many tabs a waiting one holds; making says the keeper begins
// on a window's group, which fails once the window has ended; grouped,
// plain, and waiting say how that went, and a window that ended meanwhile
// then ends as that; release moves every tab but its page out of an ended
// group's window, since deleting the group closes its tabs, and says how
// many stayed (left); gone forgets the group; scratch opens a window to
// delete from a group whose own window is gone; raised says when a call
// last brought Safari to the front. None asks anything of a quit Safari.
export async function spaceTool(a: Record<string, unknown>): Promise<unknown> {
  const name = String(a.name ?? "");
  const live = [...spaces.values()].find((s) => s.name === name);
  switch (a.op) {
    case "state": {
      const watched = [...spaces.values()].filter((s) => s.group !== "plain");
      const tabs = bridge.connected && watched.some((s) => s.group === "waiting" || s.group === "making") ? await listTabs() : undefined;
      const row = async (s: Space, over: boolean) => ({ name: s.name, ...s.size, owner: s.owner, group: s.group, ended: over, ...(tabs && !over ? { tabs: (await located(s, tabs)).length } : {}) });
      return { connected: bridge.connected, spaces: await Promise.all([...[...closing.values()].map((s) => row(s, true)), ...watched.map((s) => row(s, false))]) };
    }
    case "making":
      if (!live) return { ok: false };
      live.group = "making";
      save();
      await regrouping(live, true);
      return { ok: true };
    case "grouped":
    case "plain":
    case "waiting": {
      const held = closing.get(name);
      const s = live ?? (held?.group === "making" ? held : undefined);
      if (!s) return { ok: false };
      await regrouping(s, false);
      s.group = a.op;
      s.why = a.op === "plain" ? String(a.why ?? "") : undefined;
      if (s === held && a.op !== "grouped") {
        closing.delete(name);
        await end(s);
      }
      save();
      return { ok: true };
    }
    case "release": {
      if (!bridge.connected) return { ok: false };
      const s = closing.get(name) ?? (await orphaned(name));
      if (!s) return { ok: true, tabs: 0, left: 0 };
      // A tab can close meanwhile (close-on-exit): it needs no moving then.
      for (const t of await located(s)) if (!isPage(t, s)) await bridge.request("tabs.detach", [t.id, s.window]).catch(() => undefined);
      const now = await located(s);
      return { ok: true, tabs: now.length, left: now.filter((t) => !isPage(t, s)).length, ...s.size };
    }
    case "gone": {
      const ok = closing.delete(name);
      save();
      return { ok };
    }
    case "scratch": {
      if (!bridge.connected) return { ok: false };
      const s = await spaceWindow("tab group cleanup");
      s.group = "plain";
      s.why = "a window to delete tab groups from";
      save();
      return { ok: true, ...s.size, tabs: (await located(s)).length };
    }
    case "raised":
      return { at: lastRaised() };
  }
  throw new Error("space op must be state, making, grouped, plain, waiting, release, gone, scratch, or raised");
}

async function end(space: Space) {
  if (spaces.get(space.key) === space) spaces.delete(space.key);
  space.unwatch?.();
  space.unwatch = undefined;
  if (space.group === "grouped" || space.group === "making") {
    closing.set(space.name, space);
    save();
    return;
  }
  if (!bridge.connected) {
    ended.add(space);
    save();
    return;
  }
  ended.delete(space);
  save();
  const page = (await located(space)).find((t) => isPage(t, space));
  if (page) await bridge.request("tabs.close", [page.id], 10000);
}

let sweeping: Timer | undefined;

function sweepSoon() {
  sweeping ??= setInterval(() => void sweep().catch(() => {}), SWEEP_MS);
  sweeping.unref();
}

// The page of an agent window no record here holds closes, and the window
// with it unless it holds a tab: the daemon lost the record (a deploy, an
// extension reload it could not follow, a close that failed), and nothing
// else would close it. On 10-04 agent 50573's window had stood on "Not
// tracked" for two days, its agent long gone. A window being opened shows
// its page before its record, and a group still queued is the keeper's to
// delete (orphaned), once its tabs have moved out.
async function reclaim(tabs: TabInfo[]) {
  const records = [...spaces.values(), ...closing.values(), ...ended];
  const lost = tabs.flatMap((t) => {
    const p = pageAt(t);
    return p && !opening.has(p.id) && !records.some((s) => s.id === p.id) ? [p] : [];
  });
  if (lost.length === 0) return;
  const queued = readQueue();
  for (const p of lost) {
    if (Object.hasOwn(queued, p.name)) continue;
    try {
      await bridge.request("tabs.close", [p.tab], 10000);
      note("lost window closed", { name: p.name });
    } catch (e) {
      console.error(`[safari-harness] closing the lost window of ${p.name} failed:`, e instanceof Error ? e.message : e);
    }
  }
}

async function sweep() {
  if (!bridge.connected) return;
  // A pass that begins with nothing to watch is the last, once it has
  // closed what windows that ended since left behind.
  const idle = spaces.size === 0 && ended.size === 0;
  for (const s of [...ended]) await end(s);
  const tabs = await listTabs();
  await reclaim(tabs);
  const now = Date.now();
  for (const s of [...spaces.values()]) {
    const inWindow = await located(s, tabs);
    if (inWindow.some((t) => !isPage(t, s))) s.emptySince = undefined;
    else s.emptySince ??= now;
    if (inWindow.length === 0 || (s.emptySince !== undefined && (s.done || now - s.emptySince >= IDLE_MS))) await end(s);
  }
  // A window opened meanwhile keeps the sweep going.
  if (!idle || spaces.size > 0 || ended.size > 0) return;
  clearInterval(sweeping);
  sweeping = undefined;
}

// owner handed its turn back to the user (endTurn, tools.ts), which closes
// its tabs: each of its windows then ends at the first sweep that finds it
// holding nothing but its page. Before, the window stayed two minutes
// after its last tab, and the user saw agents that had stopped still open.
export function turnEnded(owner: number): void {
  for (const s of spaces.values()) if (s.owner === owner) s.done = true;
  if (spaces.size > 0) sweepSoon();
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

// The agent windows open now, and whose each is (tabs-view.ts): a tab in
// one is that agent's.
export function windowOwners(): Map<number, number | undefined> {
  return new Map([...spaces.values()].map((s) => [s.window, s.owner]));
}

// An agent window's own page, which is no one's tab to work in.
export const isSpacePage = (t: TabInfo) => t.url?.startsWith(`${PAGE}?`) ?? false;
