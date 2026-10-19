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
// A window that comes to hold several of its agent's tabs (GROUP_AT) then
// becomes a Safari tab group of that name (his ask of 09-28: a tab group
// per assignment; of 10-07: a group only when the task needs several tabs).
// Safari gives extensions no tab groups and the daemon has no
// Accessibility, so a keeper in the agent's terminal makes and deletes them
// (keeper.ts, groups.ts), asking here what to do through the hidden space
// tool; a window's size, which no other window has, is how it finds the
// window on screen. Until the user has left the keys alone a while the
// window stays plain (waiting); one that cannot become a group says why
// (plain). A window with fewer tabs is never the keeper's: it closes with
// its tabs, while a group needs the keeper again to go, and on 10-07 the
// keeper missed 55 of 91 deletes as the user worked, each miss an empty
// window left in his Safari.
//
// A turn's end or its agent's exit ends an empty owned window: an exited
// agent can use none of its windows again. A group waits for the keeper and
// remains intact while it contains any protected or foreign page. Only a
// caller's own call may start a Safari the user quit; ended windows wait
// while it is gone.
// The windows are saved as they change, so a restarted daemon picks up
// where the last left off (loadSpaces). A page with no durable ownership
// record is not enough evidence to close a window.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { bridge, TimedOut } from "./bridge.ts";
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
export type Space = SpaceNote & { key: string; id: string; window: number; size: Size; owner?: number; done?: true };

const spaces = new Map<string, Space>();
const making = new Map<string, Promise<Space>>();
// Ended while the extension was gone, their pages still open.
const ended = new Set<Space>();
// Ended groups, by name, for the keeper to delete.
const closing = new Map<string, Space>();
const SWEEP_MS = 5000;
// How many of its agent's tabs a waiting window holds before the keeper
// makes it a group (state).
const GROUP_AT = 3;
// Its live page (mission.ts), which the daemon serves on this port.
const PAGE = `http://127.0.0.1:${Number(process.env.SAFARI_HARNESS_HTTP_PORT ?? 37334)}/space`;

// Window sizes no other window is likely to have, one per assignment, from
// a random start so a restarted daemon does not reuse its last run's.
let sized = Math.floor(Math.random() * 5000);
const MIN_WIDTH = 1000;
function nextSize(): Size {
  const n = sized++;
  return { width: MIN_WIDTH + (n % 250), height: 780 + (Math.floor(n / 250) % 20) * 5 };
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
// or the user closed it. A tab list that times out leaves the window as it
// was: on 10-16 an open failed "extension request tabs.list timed out after
// 5000ms" on a Mac too loaded for Safari to list its tabs in 5 s (smoke run
// after the deploy). Only lost, the window an open just found gone, is then
// made anew. A stuck extension's error still fails the open at once.
export async function spaceWindow(group?: string, lost?: Space): Promise<Space> {
  const owner = currentOwner();
  const key = `${owner ?? "daemon"}:${group ?? ""}`;
  const had = spaces.get(key);
  const inWindow = had && (await located(had).catch((e: unknown) => {
    if (e instanceof TimedOut) return undefined;
    throw e;
  }));
  if (had && (inWindow === undefined ? had !== lost : inWindow.length > 0)) {
    delete had.done;
    save();
    return had;
  }
  if (had) await end(had);
  let made = making.get(key);
  if (!made) {
    made = (async () => {
      const id = randomUUID();
      const name = spaceName(group, owner);
      const size = nextSize();
      const page = `${PAGE}?id=${id}&name=${encodeURIComponent(name)}&size=${size.width}x${size.height}`;
      const w = (await bridge.request("windows.open", [page, size])) as { windowId: number };
      const off = groupsOff();
      const space: Space = { key, id, window: w.windowId, name, size, owner, group: off ? "plain" : "waiting", ...(off ? { why: off } : {}) };
      spaces.set(key, space);
      watchExit(owner);
      sweepSoon();
      save();
      note("window opened", { name, owner: owner ?? null });
      return space;
    })();
    making.set(key, made);
    made.finally(() => making.delete(key)).catch(() => {});
  }
  return made;
}


// A restart preserves every ownership record, but never a previous process's
// transient release permission. The current runtime must admit cleanup again.
type Kept = Space;
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
    delete s.done;
    spaces.set(s.key, s);
    watchExit(s.owner);
    sweepSoon();
  }
  for (const s of saved.closing ?? []) { delete s.done; closing.set(s.name, s); watchExit(s.owner); }
  for (const s of saved.ended ?? []) { delete s.done; ended.add(s); watchExit(s.owner); }
  sweepSoon();
}

const exitWatched = new Set<number>();

function watchExit(owner: number | undefined) {
  if (owner === undefined || exitWatched.has(owner)) return;
  exitWatched.add(owner);
  watchOwner(owner, () => {
    exitWatched.delete(owner);
    void turnEnded(owner).catch(() => {});
  });
}

function save() {
  if (!spacesFile) return;
  const kept = (s: Space): Kept => ({ key: s.key, id: s.id, window: s.window, name: s.name, size: s.size, owner: s.owner, group: s.group, ...(s.why ? { why: s.why } : {}) });
  try {
    const pending = `${spacesFile}.tmp`;
    writeFileSync(pending, JSON.stringify({ version: 2, spaces: [...spaces.values()].map(kept), closing: [...closing.values()].map(kept), ended: [...ended].map(kept) }), { mode: 0o600 });
    renameSync(pending, spacesFile);
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


// The keeper's side (keeper.ts). state lists the windows that are or will
// be groups and the ended groups, with each window's size and, while Safari
// runs, how many tabs a waiting one holds; making says the keeper begins
// on a window's group, which fails once the window has ended; grouped,
// plain, and waiting say how that went, and a window that ended meanwhile
// then ends as that; release reports whether the owned group is empty
// without moving any protected or foreign page. gone forgets the group;
// scratch opens a window to delete from a group whose own window is gone;
// raised says when a call last brought Safari to the front.
// None asks anything of a quit Safari.
export async function spaceTool(a: Record<string, unknown>): Promise<unknown> {
  const name = String(a.name ?? "");
  const live = [...spaces.values()].find((s) => s.name === name);
  switch (a.op) {
    case "state": {
      const watched = [...spaces.values()].filter((s) => s.group !== "plain");
      // A stuck extension (bridge.ts) answers no list: the keeper waits as
      // for a quit Safari, where the error a list threw stopped it.
      const asks = bridge.connected && !bridge.stuck && watched.some((s) => s.group === "waiting" || s.group === "making");
      const tabs = asks ? await listTabs().catch(() => undefined) : undefined;
      const counted = await Promise.all(watched.map(async (s) => ({ s, inWindow: tabs && (await located(s, tabs)) })));
      // A waiting window holding fewer than GROUP_AT of its agent's tabs is
      // not yet one the keeper makes a group of.
      const due = counted.filter(({ s, inWindow }) => s.group !== "waiting" || (inWindow?.filter((t) => !isPage(t, s)).length ?? 0) >= GROUP_AT);
      const row = (s: Space, over: boolean, inWindow?: TabInfo[]) => ({ name: s.name, ...s.size, owner: s.owner, group: s.group, ended: over, ...(inWindow ? { tabs: inWindow.length } : {}) });
      return { connected: bridge.connected && !bridge.stuck && (!asks || tabs !== undefined), spaces: [...[...closing.values()].map((s) => row(s, s.done === true)), ...due.map(({ s, inWindow }) => row(s, false, inWindow))] };
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
      const s = closing.get(name);
      if (!s?.done) return { ok: false };
      const now = await located(s);
      if (!s.done) return { ok: false };
      const left = now.filter((t) => !isPage(t, s)).length;
      // A kept, foreign, or newly added page is never moved to enable
      // deletion. Leave the whole group intact until it is truly empty.
      if (left) return { ok: true, tabs: now.length, left, ...s.size };
      // Safari hides the tab bar of a window as narrow as a phone's, and the
      // keeper counts a window's tabs in it: on 10-07 it waited for good on
      // agent 1431's groups, whose windows the agent had sized to 390
      // points. An ended window narrower than any the daemon gives goes back
      // to one of its sizes.
      const page = now.find((t) => isPage(t, s));
      if (page && s.size.width < MIN_WIDTH) {
        // background.js "window": the size Safari gave the window
        const widened = (await bridge.request("window", [page.id, nextSize(), true])) as { size: Size };
        s.size = widened.size;
        save();
      }
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

// A window page Safari would not close (a native sheet holds it, or the
// extension does not answer) is asked again after one, two, then four
// minutes, and then left until the daemon starts again: in the daemon log
// of 09-30 to 10-16 one lost window's close failed 69 times in 5.7 min,
// one try each sweep, each a wait in the extension's queue. A page
// already gone is closed.
const CLOSE_RETRY_MS = [60_000, 120_000, 240_000];
const unclosed = new Map<Space, { tries: number; at: number }>();

async function end(space: Space) {
  // once: each sweep ends again a window whose page is still open
  if (spaces.get(space.key) === space) {
    spaces.delete(space.key);
    note("window ended", { name: space.name, owner: space.owner ?? null });
  }
  if (space.group === "grouped" || space.group === "making") {
    closing.set(space.name, space);
    save();
    return;
  }
  ended.add(space);
  save();
  if (!bridge.connected || !space.done) return;
  // A page whose close failed is looked for again only once its next try is
  // due: until then a sweep would list Safari's tabs for nothing.
  const failed = unclosed.get(space);
  if (failed && (failed.tries > CLOSE_RETRY_MS.length || Date.now() < failed.at)) return;
  const inWindow = await located(space);
  if (!space.done || inWindow.some(t => !isPage(t, space))) return;
  const page = inWindow.find(t => isPage(t, space));
  if (page) {
    try {
      const result = await bridge.request("tabs.close", [page.id, "idle"], 10000) as { ok?: boolean };
      if (result.ok !== true) return;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (!why.startsWith("that tab is gone")) {
        const tries = (failed?.tries ?? 0) + 1;
        const wait = CLOSE_RETRY_MS[tries - 1];
        unclosed.set(space, { tries, at: Date.now() + (wait ?? 0) });
        note("window not closed", { name: space.name, error: why, retryS: wait === undefined ? null : wait / 1000 });
        return;
      }
    }
  }
  unclosed.delete(space);
  ended.delete(space);
  save();
}

let sweeping: Timer | undefined;

function sweepSoon() {
  sweeping ??= setInterval(() => void sweep().catch(() => {}), SWEEP_MS);
  sweeping.unref();
}

let spaceSweeping: Promise<void> | undefined;

function sweep(): Promise<void> {
  spaceSweeping ??= sweepOnce().finally(() => { spaceSweeping = undefined; });
  return spaceSweeping;
}

async function sweepOnce() {
  if (!bridge.connected) return;
  // A pass with no window to locate, and no ended one whose agent's turn has
  // ended, is the last, and asks Safari nothing: a window that ended before
  // its agent's turn did waits for turnEnded, which sweeps by itself.
  if (spaces.size === 0 && ![...ended].some((s) => s.done)) {
    clearInterval(sweeping);
    sweeping = undefined;
    return;
  }
  for (const s of [...ended]) if (s.done) await end(s);
  if (spaces.size === 0) return;
  const tabs = await listTabs();
  for (const s of [...spaces.values()]) {
    const inWindow = await located(s, tabs);
    if (inWindow.length === 0 || (s.done && !inWindow.some((t) => !isPage(t, s)))) await end(s);
  }
}

// A new owned call invalidates an earlier completion's empty-window intent.
export function turnResumed(owner: number): void {
  for (const s of [...spaces.values(), ...closing.values(), ...ended]) if (s.owner === owner) delete s.done;
  save();
}

// The runtime admitted cleanup of this owner's disposable tabs (endTurn,
// tools.ts). Its windows can end only when nothing but their marker remains.
export async function turnEnded(owner: number): Promise<void> {
  for (const s of [...spaces.values(), ...closing.values(), ...ended]) if (s.owner === owner) s.done = true;
  save();
  if (spaces.size > 0 || ended.size > 0) sweepSoon();
  if (spaceSweeping) await spaceSweeping;
  await sweep();
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

// Whether the window whose page carries id has ended, its page left open
// until the keeper deletes its group or the extension is back (mission.ts).
export function spaceEnded(id: string): boolean {
  return [...closing.values(), ...ended].some((s) => s.id === id);
}

// The agent each window is for, read off the window pages in tabs: a
// Safari that started again gave the windows new ids (restored, tools.ts).
export function ownersByPage(tabs: TabInfo[]): Map<number, number> {
  const owners = new Map<number, number>();
  for (const t of tabs) {
    const p = pageAt(t);
    const owner = p === undefined ? undefined : spaceById(p.id)?.owner;
    if (p !== undefined && owner !== undefined) owners.set(p.window, owner);
  }
  return owners;
}

// The agent windows open now, and whose each is (tabs-view.ts): a tab in
// one is that agent's.
export function windowOwners(): Map<number, number | undefined> {
  return new Map([...spaces.values()].map((s) => [s.window, s.owner]));
}

// A window its agent sized (tools.ts viewport), which its keeper finds by
// the size it has now.
export function resized(window: number, size: Size): void {
  const space = [...spaces.values()].find((s) => s.window === window);
  if (!space) return;
  space.size = size;
  save();
}

// An agent window's own page, which is no one's tab to work in.
export const isSpacePage = (t: TabInfo) => t.url?.startsWith(`${PAGE}?`) ?? false;
