// Agent windows: every tab the harness opens goes into a Safari window of
// the agent's own, never into one of the user's windows or tab groups (his
// ask of 09-28).
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
// where the last left off (loadSpaces).

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { bridge, TimedOut } from "./bridge.ts";
import { lastRaised } from "./front.ts";
import { uncover } from "./place.ts";
import { groupsOff, keeperRunning, readQueue } from "./groups.ts";
import { note } from "./journal.ts";
import { alive, currentOwner, currentTask, matchesTask, watchOwner } from "./owner.ts";
import { closeTab, endUntrackedTurns, windowPageClosed, type TabInfo } from "./tools.ts";

type Size = { width: number; height: number };
type Group = "waiting" | "making" | "grouped" | "plain";
// What an open says of its window: its name, and whether it is a tab group
// (grouped), is becoming one (making), will be one once the user is away
// from the keys (waiting), or stays plain, and why.
export type SpaceNote = { name: string; group: Group; why?: string };
// id: this window alone, in its page's address
// done: the agent's turn ended (turnEnded); the window ends once it holds
// nothing but its page, and its agent's next open clears it
export type Space = SpaceNote & { key: string; id: string; window: number; size: Size; owner?: number; task?: string; done?: true; used?: number; proof?: string };

const spaces = new Map<string, Space>();
const making = new Map<string, Promise<Space>>();
// Ended while the extension was gone, their pages still open.
const ended = new Set<Space>();
// Ended groups, by name, for the keeper to delete.
const closing = new Map<string, Space>();
// Safari's tabs are listed on this cadence only to notice what the user did
// to agent windows himself; what the harness does sweeps at once (turnEnded,
// and the extension's connect in tools.ts). Every 5 s, it was 12 lists a
// minute while an agent ran (10-21 audit).
const SWEEP_MS = 60_000;
const IDLE_MS = 20 * 60_000;
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

async function identify(space: Space, tab: number): Promise<void> {
  const proof = randomUUID();
  const result = await bridge.tab(tab, "eval", [`(() => { history.replaceState({ ...history.state, safariHarnessSpace: ${JSON.stringify(proof)} }, ""); return true; })()`]).catch(() => null) as { result?: unknown } | null;
  if (result?.result !== true) return;
  space.proof = proof;
  save();
}

// The keeper begins, or is done, making space's window a tab group. The
// extension takes no tab Safari makes in the window meanwhile for a page's
// popup (09-30: a blank one went to an agent, which could neither read nor
// close it; 01a0f14c). A quit Safari hears nothing, and one that cannot
// answer does not hold up the keeper.
async function regrouping(space: Space, on: boolean) {
  if (bridge.connected) await bridge.request("windows.regrouping", [space.window, on]).catch(() => undefined);
}

// Browser window aliases and the original page's history state establish
// ownership independently of a copied address.
async function located(space: Space, tabs?: TabInfo[]): Promise<TabInfo[]> {
  const all = tabs ?? (await listTabs());
  let window = all.some(t => t.windowId === space.window) ? space.window : await bridge.request("windows.resolve", [space.window]).catch(() => null) as number | null;
  if (window === null && space.proof) {
    const pages = all.filter(t => isPage(t, space) && pageAt(t) !== undefined);
    if (pages.length === 1) {
      const result = await bridge.tab(pages[0].id, "eval", ["history.state?.safariHarnessSpace ?? null"]).catch(() => null) as { result?: unknown } | null;
      if (result?.result === space.proof) window = pages[0].windowId ?? null;
    }
  }
  if (window === null) return [];
  if (window !== space.window) {
    space.window = window;
    save();
  }
  const owned = all.filter(t => t.windowId === window);
  const page = owned.find(t => isPage(t, space) && pageAt(t) !== undefined);
  if (!space.proof && page) await identify(space, page.id);
  return owned;
}

function spaceKey(group: string | undefined): string {
  const owner = currentOwner();
  const task = currentTask();
  return task === undefined ? `${owner ?? "daemon"}:${group ?? ""}` : JSON.stringify([owner ?? null, task, group ?? ""]);
}

// The calling agent's window for group, never a new one: on 10-23 each
// open of /agents from an agent made it a window of its own (tools.ts).
export function heldSpace(group?: string): Space | undefined {
  return spaces.get(spaceKey(group));
}

// The window an open by the calling agent goes in, made when it has none
// or the user closed it. A tab list that times out leaves the window as it
// was: on 10-16 an open failed "extension request tabs.list timed out after
// 5000ms" on a Mac too loaded for Safari to list its tabs in 5 s (smoke run
// after the deploy). Only lost, the window an open just found gone, is then
// made anew. A stuck extension's error still fails the open at once.
export async function spaceWindow(group?: string, lost?: Space): Promise<Space> {
  const owner = currentOwner();
  const task = currentTask();
  const key = spaceKey(group);
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
      const w = (await bridge.request("windows.open", [page, size])) as { windowId: number; tabId: number };
      const off = groupsOff();
      const space: Space = { key, id, window: w.windowId, name, size, owner, ...(task === undefined ? {} : { task }), used: Date.now(), group: off ? "plain" : "waiting", ...(off ? { why: off } : {}) };
      spaces.set(key, space);
      watchExit(owner);
      sweepSoon();
      save();
      await identify(space, w.tabId);
      // Safari opens each new window at one place, over the ones before it
      // (place.ts).
      await uncover(w.tabId).catch(() => undefined);
      note("window opened", { name, owner: owner ?? null });
      return space;
    })();
    making.set(key, made);
    made.finally(() => making.delete(key)).catch(() => {});
  }
  return made;
}


type Kept = Space;
let spacesFile: string | undefined;
// the used time the file of windows holds for each, as last written (save)
const written = new WeakMap<Space, number>();
let taskTracked: ((owner: number | undefined) => boolean | undefined) | undefined;
let inspectUntracked = false;

export function loadSpaces(path: string, tracked: (owner: number | undefined) => boolean | undefined): void {
  spacesFile = path;
  taskTracked = tracked;
  inspectUntracked = true;
  let saved: { spaces?: Kept[]; closing?: Kept[]; ended?: Kept[] } = {};
  try {
    saved = JSON.parse(readFileSync(path, "utf8")) as typeof saved;
  } catch {
    // none kept yet
  }
  for (const s of saved.spaces ?? []) {
    spaces.set(s.key, s);
    watchExit(s.owner);
    sweepSoon();
  }
  for (const s of saved.closing ?? []) { closing.set(s.name, s); watchExit(s.owner); }
  for (const s of saved.ended ?? []) { ended.add(s); watchExit(s.owner); }
  sweepSoon();
}

export function inspectUntrackedWindows(): void {
  if (!taskTracked) return;
  inspectUntracked = true;
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
  const kept = (s: Space): Kept => ({ key: s.key, id: s.id, window: s.window, name: s.name, size: s.size, owner: s.owner, ...(s.task === undefined ? {} : { task: s.task }), group: s.group, ...(s.done ? { done: true } : {}), ...(s.used === undefined ? {} : { used: s.used }), ...(s.proof === undefined ? {} : { proof: s.proof }), ...(s.why ? { why: s.why } : {}) });
  try {
    const pending = `${spacesFile}.tmp`;
    writeFileSync(pending, JSON.stringify({ version: 2, spaces: [...spaces.values()].map(kept), closing: [...closing.values()].map(kept), ended: [...ended].map(kept) }), { mode: 0o600 });
    renameSync(pending, spacesFile);
    for (const s of [...spaces.values(), ...closing.values(), ...ended]) if (s.used !== undefined) written.set(s, s.used);
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
      if (s === held) {
        if (a.op !== "grouped") closing.delete(name);
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
// minutes, then every 15: in the daemon log of 09-30 to 10-16 one lost
// window's close failed 69 times in 5.7 min, one try each sweep, each a
// wait in the extension's queue, and a page left after its third try
// stayed open until the daemon started again. A page already gone is
// closed.
const CLOSE_RETRY_MS = [60_000, 120_000, 240_000];
const SLOW_RETRY_MS = 15 * 60_000;
const unclosed = new Map<Space | string, { tries: number; at: number }>();

function failedClose(key: Space | string, name: string, error: string): void {
  const tries = (unclosed.get(key)?.tries ?? 0) + 1;
  const wait = CLOSE_RETRY_MS[tries - 1] ?? SLOW_RETRY_MS;
  unclosed.set(key, { tries, at: Date.now() + wait });
  note("window not closed", { name, error, retryS: wait / 1000 });
}

async function end(space: Space) {
  // once: each sweep ends again a window whose page is still open
  if (spaces.get(space.key) === space) {
    spaces.delete(space.key);
    note("window ended", { name: space.name, owner: space.owner ?? null });
  }
  if (space.group === "grouped" || space.group === "making") {
    closing.set(space.name, space);
    save();
    // A keeper still making the group gets to finish its step: a window
    // closed under it leaves a group the next keeper waits on.
    if (space.group === "making" && (taskTracked?.(space.owner) !== false || keeperRunning())) return;
  }
  ended.add(space);
  save();
  if (!bridge.connected || !space.done) return;
  // A page whose close failed is looked for again only once its next try is
  // due: until then a sweep would list Safari's tabs for nothing.
  const failed = unclosed.get(space);
  if (failed && Date.now() < failed.at) return;
  const inWindow = await located(space);
  if (!space.done || (taskTracked?.(space.owner) !== false && inWindow.some(t => !isPage(t, space)))) return;
  const page = inWindow.find(t => isPage(t, space));
  if (page) {
    try {
      await bridge.request("dialogs", [page.id, { accept: false, text: null }]);
      if (!space.done) return;
      const result = await bridge.request("tabs.close", [page.id], 10000) as { ok?: boolean };
      if (result.ok !== true) return;
      const tracked = taskTracked?.(space.owner);
      let why = "as its agent's turn ended";
      if (tracked === false) why = "as its agent's task ended";
      else if (Date.now() - (space.used ?? 0) >= IDLE_MS) why = "after 20 minutes unused";
      else if (taskTracked && tracked === undefined) why = "as no task record names its agent";
      windowPageClosed(page.id, `with its window, ${why}`, space.owner);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (!why.startsWith("that tab is gone")) {
        failedClose(space, space.name, why);
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
let sweepAgain = false;

// A sweep asked for while one runs runs again after it: the one running may
// have listed Safari before the change that asked.
export function sweep(): Promise<void> {
  if (spaceSweeping) {
    sweepAgain = true;
    return spaceSweeping;
  }
  spaceSweeping = (async () => {
    do {
      sweepAgain = false;
      await sweepOnce();
    } while (sweepAgain);
  })().finally(() => { spaceSweeping = undefined; });
  return spaceSweeping;
}

async function sweepOnce() {
  if (!bridge.connected) return;
  // A window made after this, while Safari lists, is not in the list: it
  // would look empty, and end as one the user closed.
  const known = new Set(spaces.values());
  if (taskTracked) endUntrackedTurns(taskTracked);
  for (const s of [...spaces.values(), ...closing.values(), ...ended]) {
    if (taskTracked?.(s.owner) === false) s.done = true;
  }
  let listed: TabInfo[] | undefined;
  if (inspectUntracked && making.size === 0) {
    listed = await listTabs();
    const registered = new Map([...spaces.values(), ...closing.values(), ...ended].map(s => [s.id, s]));
    for (const tab of listed) {
      if (!tab.url?.startsWith(`${PAGE}?`)) continue;
      const id = new URL(tab.url).searchParams.get("id");
      if (!id) continue;
      const space = registered.get(id);
      if ((!space || (taskTracked?.(space.owner) === false && !(space.group === "making" && keeperRunning()))) && making.size === 0) {
        const key = space ?? `${tab.id}:${id}`;
        const failed = unclosed.get(key);
        if (failed && Date.now() < failed.at) continue;
        try {
          const result = await closeTab(tab.id, space ? "with its window, as its agent's task ended" : "with its window, as no record names it") as { ok?: boolean } | null;
          if (result?.ok === true) unclosed.delete(key);
          else failedClose(key, space?.name ?? "untracked agent status", "Safari did not close the status page");
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          if (why.startsWith("that tab is gone")) unclosed.delete(key);
          else failedClose(key, space?.name ?? "untracked agent status", why);
        }
      }
    }
    inspectUntracked = making.size > 0;
  }
  for (const s of [...spaces.values(), ...closing.values(), ...ended]) {
    if (Date.now() - (s.used ?? 0) >= IDLE_MS) s.done = true;
    if (taskTracked && taskTracked(s.owner) === undefined && !s.done) {
      listed ??= await listTabs();
      const inWindow = await located(s, listed);
      if (!inWindow.some(t => !isPage(t, s))) {
        s.done = true;
        await end(s);
      }
    }
  }
  listed = await stillOpen(listed);
  // A pass with no window to locate, and no ended one whose agent's turn has
  // ended, is the last, and asks Safari nothing: a window that ended before
  // its agent's turn did waits for turnEnded, which sweeps by itself.
  if (spaces.size === 0 && ![...ended].some((s) => s.done)) {
    clearInterval(sweeping);
    sweeping = undefined;
    return;
  }
  for (const s of [...ended]) if (s.done) await end(s);
  const judged = [...spaces.values()].filter((s) => known.has(s));
  if (judged.length === 0) return;
  const tabs = listed ?? await listTabs();
  for (const s of judged) {
    if (spaces.get(s.key) !== s) continue;
    const inWindow = await located(s, tabs);
    if (taskTracked?.(s.owner) === false || inWindow.length === 0 || (s.done && !inWindow.some((t) => !isPage(t, s)))) await end(s);
  }
}

// When each window's task was first seen ended, for the journal's note of
// one that holds nothing but its page five minutes on (safari status
// --journal): on 10-23 ended agents' windows stayed open through restarts,
// and nothing said so. Each window is looked at once, at five minutes.
const STILL_OPEN_MS = 5 * 60_000;
const doneAt = new Map<Space, { at: number; checked?: true }>();

async function stillOpen(listed: TabInfo[] | undefined): Promise<TabInfo[] | undefined> {
  const records = new Set([...spaces.values(), ...closing.values(), ...ended]);
  for (const s of doneAt.keys()) if (!records.has(s) || !s.done) doneAt.delete(s);
  for (const s of records) {
    const since = doneAt.get(s);
    if (!s.done || since?.checked) continue;
    if (!since) {
      doneAt.set(s, { at: Date.now() });
      continue;
    }
    if (Date.now() - since.at < STILL_OPEN_MS) continue;
    since.checked = true;
    listed ??= await listTabs();
    const inWindow = await located(s, listed);
    if (inWindow.length > 0 && inWindow.every((t) => isPage(t, s))) note("agent window whose task ended over 5 min ago is still open", { name: s.name, owner: s.owner ?? null, minutes: Math.floor((Date.now() - since.at) / 60_000) });
  }
  return listed;
}

export function turnResumed(owner: number | undefined, task?: string): void {
  let changed = false;
  for (const s of [...spaces.values(), ...closing.values(), ...ended]) if (matchesTask(s, owner, task)) {
    // used counts in minutes (sweepOnce), so the file is written only once
    // the time it holds for this window is a minute behind
    if (s.done || Date.now() - (written.get(s) ?? 0) >= 60_000) changed = true;
    delete s.done;
    s.used = Date.now();
  }
  if (changed) save();
}

// The runtime admitted cleanup of this owner's disposable tabs (endTurn,
// tools.ts). Its windows can end only when nothing but their marker remains.
export async function turnEnded(owner: number | undefined, task?: string): Promise<void> {
  for (const s of [...spaces.values(), ...closing.values(), ...ended]) if (matchesTask(s, owner, task)) s.done = true;
  save();
  if (spaces.size > 0 || ended.size > 0) sweepSoon();
  if (spaceSweeping) await spaceSweeping;
  await sweep();
}

// The assignment whose window's page carries id, for that page
// (mission.ts): undefined once the window has ended.
export function spaceById(id: string): Pick<Space, "owner" | "task" | "window"> | undefined {
  const space = [...spaces.values()].find((s) => s.id === id);
  if (!space) return undefined;
  return { owner: space.owner, task: space.task, window: space.window };
}

// Whether the window whose page carries id has ended, its page left open
// until the keeper deletes its group or the extension is back (mission.ts).
export function spaceEnded(id: string): boolean {
  return [...closing.values(), ...ended].some((s) => s.id === id);
}

// The agent each window is for, read off the window pages in tabs: a
// Safari that started again gave the windows new ids (restored, tools.ts).
export function ownersByPage(tabs: TabInfo[]): Map<number, Pick<Space, "owner" | "task">> {
  const owners = new Map<number, Pick<Space, "owner" | "task">>();
  for (const t of tabs) {
    const p = pageAt(t);
    const owner = p === undefined ? undefined : spaceById(p.id);
    if (p !== undefined && owner?.owner !== undefined) owners.set(p.window, owner);
  }
  return owners;
}

// The agent windows open now, and whose each is (tabs-view.ts): a tab in
// one is that agent's.
export function windowOwners(task?: string): Map<number, number | undefined> {
  return new Map([...spaces.values()].map((s) => [s.window, task === undefined || s.task === task ? s.owner : undefined]));
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

export type ManagedWindow = { id: string; name: string; owner: number | null; window: number; ended: boolean; tabs: { id: number; title: string; url: string }[] };

export async function managedWindows(listed?: TabInfo[]): Promise<ManagedWindow[]> {
  if (!bridge.connected) return [];
  const tabs = listed ?? await listTabs();
  const registered = new Map([...spaces.values(), ...closing.values(), ...ended].map(s => [s.id, s]));
  const windows: ManagedWindow[] = [];
  for (const s of registered.values()) {
    const owned = await located(s, tabs);
    if (owned.length === 0) continue;
    windows.push({
      id: s.id, name: s.name, owner: s.owner ?? null, window: s.window,
      ended: s.owner !== undefined && !alive(s.owner),
      tabs: owned.filter(t => !isPage(t, s)).map(t => ({ id: t.id, title: t.title ?? "", url: t.url ?? "" })),
    });
  }
  return windows;
}

export async function closeManagedWindow(id: string, why = "from the windows page"): Promise<{ ok: boolean; closed: number; remaining: number }> {
  if (!bridge.connected) throw new Error("Safari is not connected.");
  const s = [...spaces.values(), ...closing.values(), ...ended].find(space => space.id === id);
  if (!s) throw new Error("This window is no longer tracked.");
  const before = await located(s);
  if (before.length === 0) throw new Error("This window is no longer tracked.");
  const window = s.window;
  let closed = 0;
  for (const tab of before) {
    if (isPage(tab, s)) continue;
    const result = await closeTab(tab.id, why) as { ok?: boolean };
    if (result.ok) closed++;
  }
  const remaining = (await listTabs()).filter(t => t.windowId === window);
  if (remaining.some(t => !isPage(t, s))) return { ok: false, closed, remaining: remaining.filter(t => !isPage(t, s)).length };
  const marker = remaining.find(t => isPage(t, s));
  if (marker) {
    const result = await closeTab(marker.id, why) as { ok?: boolean };
    if (!result.ok) return { ok: false, closed, remaining: 1 };
  }
  s.done = true;
  if (s.group === "grouped" || s.group === "making") await end(s);
  else {
    if (spaces.get(s.key) === s) spaces.delete(s.key);
    if (closing.get(s.name) === s) closing.delete(s.name);
    ended.delete(s);
    unclosed.delete(s);
    save();
  }
  return { ok: true, closed, remaining: 0 };
}

// close {window} (tools.ts): a window whose agent has ended, or that no
// task record names, closes with every tab in it, kept pages too, once the
// caller says the user agreed to the question the windows on /agents ask
// (mission.ts). A working agent's window closes as its turn ends.
export async function closeWindow(window: number, confirm: boolean): Promise<unknown> {
  const w = (await managedWindows()).find((m) => m.window === window);
  const s = w && [...spaces.values(), ...closing.values(), ...ended].find((space) => space.id === w.id);
  if (!w || !s) throw new Error(`window ${window} is no agent window the harness tracks; tabs {all: true} gives each tab's windowId`);
  if (taskTracked?.(s.owner) === true) throw new Error(`window ${window} is ${s.owner === undefined ? "the harness's" : `agent ${s.owner}'s`}, which is still working; its tabs close when its turn ends`);
  if (!confirm) {
    return {
      ok: false,
      ask: w.ended ? "Close this window and all its tabs, including kept pages?" : "Close this working window and all its tabs, including kept pages? The task will keep running.",
      name: w.name,
      titles: w.tabs.map((t) => t.title),
      next: `ask the user that; on his yes, close {window: ${window}, confirm: true}`,
    };
  }
  return closeManagedWindow(w.id, "with its window, by a close call");
}
