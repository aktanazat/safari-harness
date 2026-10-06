// Tool registry: the aside-style verbs, implemented over the bridge.
// Every consumer (CLI, MCP server, agent loop, CDP shim) calls these.

import { bridge } from "./bridge.ts";
import { localTime, loginForm, passwords } from "./passwords.ts";
import { challengeOf, settledChallenge, type Challenge } from "./challenge.ts";
import { followTab, queuePopup, recordRenumbered, recordReplaced, splitNews, withTabNews } from "./continuity.ts";
import { note } from "./journal.ts";
import { pageData } from "./pagedata.ts";
import { frontApp, inFront, input, notify, raiseSafari, SAFARI, show } from "./front.ts";
import { renderPdf, pdfText } from "./pdf.ts";
import { findFiles } from "./finder.ts";
import { watchDownloads } from "./downloads.ts";
import { asExpression } from "./statements.ts";
import { unanswered, unopened } from "./unanswered.ts";
import { ownersByPage, spaceNote, spaceTool, spaceWindow, turnEnded, windowOwners, type Space, type SpaceNote } from "./spaces.ts";
import { currentOwner, watchOwner } from "./owner.ts";
import { filledOf, navigatedOf, newTabOf } from "./navigated.ts";
import { addressedNote, shieldExtract, shieldSnapshot, type Shielded } from "./injection.ts";
import { firstNotes, learn, pageHost, readerFor, realInputSite, realInputSites } from "./notes.ts";
import { guideFor } from "./site-guides.ts";
import { saveOutput, targetOf, withLimit, type SaveKind } from "./save.ts";
import { mapPages, MAP_MAX_URLS, type Page } from "./map.ts";
import { beside, checkCall, checkStep, fromModel, guard, type Checked } from "./guard.ts";
import { acts, inLane } from "./lanes.ts";
import { site, urlMatch, WAIT_NEEDS, waitsOnPage, withEffect } from "./receipt.ts";
import { keepSecret, redacted, redactUrl, tabSecrets } from "./redact.ts";
import { tabsView } from "./tabs-view.ts";
import { recordingsTool } from "./recordings.ts";
import { replay } from "./replay.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, writeFile, mkdtemp, mkdir, readdir, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

// front: the active tab of the window the user had in front last; shown: the
// active tab of the window Safari shows in front, agent windows included
export type TabInfo = { id: number; url?: string; title?: string; active?: boolean; windowId?: number; front?: boolean; shown?: boolean };

type Relay = (tabId: number, op: string, args?: unknown[], timeoutMs?: number) => Promise<unknown>;
const relay: Relay = (tabId, op, args = [], timeoutMs) => bridge.tab(tabId, op, args, timeoutMs);

function num(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}

export async function listTabs(): Promise<TabInfo[]> {
  const tabs = (await bridge.request("tabs.list")) as TabInfo[];
  sighted(tabs);
  return tabs;
}

// A page tool's tab: the id open returned, or "front", the tab the user has
// in front, named on purpose. A call without one is an error, never a read
// of his front tab: on 09-28 an agent that left it out read his MyChart
// page. Tools that run in the caller pass their own way to list tabs.
export async function resolveTab(tab: unknown, tabs: () => Promise<TabInfo[]> = listTabs): Promise<number> {
  if (tab === undefined || tab === null) throw new Error('tab is required: the id open returned (CLI --tab <id>), or "front" for the tab the user has in front (CLI --tab front)');
  if (tab === "front") {
    const front = (await tabs()).find((t) => t.front);
    if (!front) throw new Error("Safari has no front tab");
    return front.id;
  }
  const id = typeof tab === "number" ? tab : Number(tab);
  if (!Number.isFinite(id)) throw new Error('tab must be a tab id from open, or "front"');
  // a tab Safari swapped for another is reached under its new id
  const now = followTab(id);
  const mine = harnessTabs.get(now);
  if (mine) mine.used = Date.now();
  return now;
}

// An address Safari shows as a page the harness can read. Safari opens no
// local file for the extension, and a tab opened on text that is no address
// stays blank: 01a0efb9's file:// page failed with advice to reload it, and
// 01a0f14c's JSON args, passed as the address, opened as if they worked.
function webAddress(url: unknown): string {
  const s = str(url, "url");
  const protocol = URL.parse(s)?.protocol;
  if (protocol === "http:" || protocol === "https:" || s === "about:blank") return s;
  if (protocol === "file:") throw new Error("Safari opens no local file for the harness: serve its folder over http (python3 -m http.server -d <folder> <port>) and open http://127.0.0.1:<port>/ (Safari fails to open localhost here)");
  throw new Error(`${s.slice(0, 80) || "an empty url"} is not a web address; give a whole one, like https://example.com`);
}

// Every tab opens in a window of the calling agent's own (spaces.ts), which
// the result names. The extension answers an owned tab's dialogs, keeps it
// running while hidden, and lets the daemon close it (background.js).
export async function openTab(url: string, background = false, group?: string, owned = background): Promise<TabInfo & { space: SpaceNote }> {
  const address = webAddress(url);
  return openIn(await spaceWindow(group), address, background, owned);
}

async function openIn(space: Space, address: string, background: boolean, owned: boolean): Promise<TabInfo & { space: SpaceNote }> {
  const t = (await bridge.request("tabs.open", [address, background, space.window, owned])) as TabInfo;
  return { ...t, space: spaceNote(space) };
}

// The calling agent's other tabs on the site of the address it just opened
// in tab, as a hint to go on in one of them. From 09-26 to 10-05, 194 of
// 729 opens went to a site the same agent had opened earlier in its turn;
// on 10-05 one agent had tirerack.com open in two of the 14 tabs of its
// tire research. Safari is asked for the list only while the agent holds
// another tab. A model's open goes to such a tab itself (reuseTab), so only
// a script's open hears this.
async function alsoOn(tab: number, url: string): Promise<string | undefined> {
  const owner = currentOwner();
  const host = pageHost(webAddress(url));
  const others = [...harnessTabs].filter(([id, t]) => id !== tab && t.owner === owner && !t.site);
  if (owner === undefined || host === undefined || others.length === 0) return undefined;
  const ids = new Set(others.map(([id]) => id));
  const had = (await listTabs().catch((): TabInfo[] => [])).filter((t) => ids.has(t.id) && pageHost(t.url) === host).map((t) => t.id);
  if (had.length === 0) return undefined;
  return `you already had ${had.length === 1 ? "tab" : "tabs"} ${had.join(", ")} on ${host}: next time goto a tab you have rather than open another, and close one you are done with`;
}

// A model's open on a site where its agent has a tab loads in that tab, in
// place of its page, unless it asks for new: true: the hint above did not
// stop one agent's tire research of 10-05 from holding tirerack.com in two
// of its 17 tabs. Only a tab the agent alone works in, in the window the
// open goes to, is taken: never one kept for the user, a site global's,
// one he has in front, or one an action changed since it loaded (a form in
// progress). Of several, the one used longest ago goes, and a tab being
// loaded is claimed, so two opens at once take two tabs. Scripts, map, and
// replay call as no model (repl.ts, map.ts, replay.ts): each of their
// opens gets a tab of its own, but for a script's open of an address its
// session opened in an earlier call, which may take a tab named in again.
const reusing = new Set<number>();

async function reuseTab(address: string, space: Space, among?: Set<number>): Promise<{ tab: TabInfo & { space: SpaceNote }; was: string } | undefined> {
  const owner = currentOwner();
  const host = pageHost(address);
  const free = (id: number) => {
    const t = harnessTabs.get(id);
    return t !== undefined && t.owner === owner && !t.site && !t.acted && !t.closing && !reusing.has(id) && (among === undefined || among.has(id));
  };
  if (owner === undefined || host === undefined || ![...harnessTabs.keys()].some(free)) return undefined;
  const fits = (await listTabs().catch((): TabInfo[] => [])).filter((t): t is TabInfo & { url: string } => free(t.id) && t.windowId === space.window && !t.front && pageHost(t.url) === host);
  const used = (t: TabInfo) => harnessTabs.get(t.id)?.used ?? 0;
  const pick = fits.sort((x, y) => used(x) - used(y))[0];
  if (pick === undefined) return undefined;
  reusing.add(pick.id);
  try {
    const t = await inLane("goto", { tab: pick.id }, resolveTab, () => navigate(pick.id, address));
    return { tab: { ...t, space: spaceNote(space) }, was: pick.url };
  } finally {
    reusing.delete(pick.id);
  }
}

// A native sheet on the tab (a sign-in or permission prompt) or an
// off-screen window can keep Safari from closing it; the extension tries
// for 15 s and says so. This limit is only for an extension that never
// answers.
export async function closeTab(tab: number, why = "by a close call"): Promise<unknown> {
  const id = followTab(num(tab, "tab"));
  const res = await bridge.request("tabs.close", [id], 20000);
  forget(id);
  recordClosed(id, why);
  return res;
}

// A tab an agent opens closes when the agent hands its turn back to the
// user (endTurn), once it exits (owner.ts), or once it sits untouched for
// IDLE_MS; a turn's end and IDLE_MS spare a tab the user has in front. keep
// leaves a tab open for him. Tabs a click opens from one inherit its
// owner. The list is kept in a file, so a restarted daemon still closes
// them, and the extension closes only a tab the harness owns, so an id
// Safari has given another tab since is left alone. A tab it cannot close
// now (not connected, a sheet) is tried again each minute.
const IDLE_MS = 20 * 60_000;
// acted: an action has changed the page since it loaded (revived). site: a
// repl site global's own tab (sites/kit.ts), whose page its calls need: an
// agent is never sent to go on in it. url: the page it showed when the
// daemon last listed, opened, or loaded it; seen: the extension connection
// it was last listed or made on (bridge.extensionInfo), for a Safari that
// started again (restored).
type HarnessTab = { owner?: number; used: number; orphan?: true; closing?: true; acted?: true; site?: true; url?: string; seen?: number };
const harnessTabs = new Map<number, HarnessTab>();
const watches = new Map<number, () => void>();
let tabsFile: string | undefined;
let sweeper: Timer | undefined;

// Each tab the harness closed of late, with why, when, and what it showed,
// for a later call that names it (goneWhy). Late in September a chat tab
// closed while its agent waited 50 minutes on a subagent, and "that tab is
// gone" alone sent it after an extension restart: 10 turns to recover.
type Closed = { why: string; at: number; url?: string };
const closedTabs = new Map<number, Closed>();
const CLOSED_KEPT = 500;

function recordClosed(tab: number, why: string, url?: string) {
  // what was typed there as a secret goes with it (redact.ts)
  tabSecrets.delete(tab);
  closedTabs.delete(tab);
  closedTabs.set(tab, { why, at: Date.now(), ...(url === undefined ? {} : { url }) });
  // a Map keeps its keys in the order they went in, the oldest first
  if (closedTabs.size > CLOSED_KEPT) closedTabs.delete(closedTabs.keys().next().value!);
}

// The daemon names the file once, as it starts.
export function loadTabs(path: string): void {
  tabsFile = path;
  mkdirSync(dirname(path), { recursive: true });
  let saved: Record<string, number | null> = {};
  try {
    saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, number | null>;
  } catch {
    // none kept yet
  }
  for (const [tab, owner] of Object.entries(saved)) remember(Number(tab), owner ?? undefined);
}

function own(tab: number, owner: number | undefined) {
  remember(tab, owner);
  save();
}

function remember(tab: number, owner: number | undefined) {
  harnessTabs.set(tab, { owner, used: Date.now(), seen: bridge.extensionInfo?.connectedAt });
  if (owner !== undefined && !watches.has(owner)) watches.set(owner, watchOwner(owner, () => orphan(owner)));
  sweeper ??= setInterval(sweep, 60_000);
  sweeper.unref();
}

function orphan(owner: number) {
  watches.delete(owner);
  for (const t of harnessTabs.values()) if (t.owner === owner) t.orphan = true;
  void sweep();
}

// The user stopped owner from its window (mission.ts): its tabs close now,
// as they would once it exits.
export function closeTabsOf(owner: number): void {
  watches.get(owner)?.();
  orphan(owner);
}

// owner handed its turn back to the user (main.ts, told by omp/index.ts):
// it is done with its tabs, as if it had left them for IDLE_MS, and its
// window goes once they have (spaces.ts). Before, they stayed open until
// it exited or left them for 20 minutes; his order of 09-28 is to close a
// tab once it has served its purpose.
export function endTurn(owner: number): void {
  for (const t of harnessTabs.values()) if (t.owner === owner) t.used = 0;
  turnEnded(owner);
  void sweep();
}

// A tab the user is to see or answer outlives its agent's turn and its
// exit, as one opened with keep does. The extension still answers its
// dialogs, so the agent can go on in it once he has answered, and the
// agent hears of the popups it opens (keepers).
export function keepTab(tab: number): { ok: true } {
  const id = followTab(tab);
  forget(id);
  const keeper = currentOwner();
  if (keeper !== undefined) keptBy(id, keeper);
  return { ok: true };
}

// The agent that kept each tab, and each popup those open, until it exits.
// Before, a popup a kept tab opened was reported to no one, the agent that
// kept it included; on 10-02 one kept a TikTok sign-up for the user.
const keepers = new Map<number, number>();
const keeperWatches = new Map<number, () => void>();

function keptBy(tab: number, keeper: number) {
  keepers.set(tab, keeper);
  if (keeperWatches.has(keeper)) return;
  keeperWatches.set(keeper, watchOwner(keeper, () => {
    keeperWatches.delete(keeper);
    for (const [kept, k] of keepers) if (k === keeper) keepers.delete(kept);
  }));
}

async function sweep() {
  // Timer work never starts Safari: once the user quits it, only a caller's
  // own call may (socket in bridge.ts). The next sweep tries again. Each
  // sweep lists the tabs, which notes what they show and finds those a
  // Safari that started again restored (sighted).
  if (!bridge.connected) return;
  const listed = await listTabs().catch((): TabInfo[] => []);
  const idle = Date.now() - IDLE_MS;
  const due = [...harnessTabs].filter(([, t]) => !t.closing && (t.orphan || t.used < idle));
  if (due.length === 0) return;
  for (const [, t] of due) t.closing = true;
  // what each showed, for a later call that names it (closedTabs)
  const shown = new Map(listed.map((t) => [t.id, t.url]));
  await Promise.all(due.map(async ([tab, t]) => {
    try {
      const res = (await bridge.request("tabs.close", [tab, t.orphan ? "owned" : "idle"], 20000)) as { front?: true } | null;
      if (res?.front) t.used = Date.now();
      else {
        forget(tab);
        // endTurn marks the tabs it is done with as used at 0
        recordClosed(tab, t.orphan ? "once its agent exited or was stopped" : t.used === 0 ? "as its agent's turn ended" : "after 20 minutes unused", shown.get(tab));
      }
    } catch (e) {
      console.error(`[safari-harness] closing tab ${tab} failed:`, e instanceof Error ? e.message : e);
    } finally {
      delete t.closing;
    }
  }));
}

function forget(tab: number) {
  const t = harnessTabs.get(tab);
  if (!t) return;
  harnessTabs.delete(tab);
  if (t.owner !== undefined && ![...harnessTabs.values()].some((o) => o.owner === t.owner)) {
    watches.get(t.owner)?.();
    watches.delete(t.owner);
  }
  if (harnessTabs.size === 0) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
  save();
}

function save() {
  if (!tabsFile) return;
  try {
    writeFileSync(tabsFile, JSON.stringify(Object.fromEntries([...harnessTabs].map(([tab, t]) => [tab, t.owner ?? null]))));
  } catch (e) {
    console.error("[safari-harness] tab list not written:", e instanceof Error ? e.message : e);
  }
}

// ---------- tabs that change id, and popups (continuity.ts) ----------
// What the daemon keeps per tab follows a tab Safari swapped for another,
// and every tab once a reloaded extension says their new ids. A popup an
// agent's tab opened on its own is that agent's, as a tab its click opens
// is (action); one the user's own tabs open stays his. So does one a tab
// kept for him opens, and the agent that kept it hears of it (keepers).
bridge.onTab = (e) => {
  if (e.kind === "replaced") {
    recordReplaced(e.from, e.to);
    if (moveKept(e.from, e.to)) save();
    note("replaced", { from: e.from, to: e.to });
    return;
  }
  if (e.kind === "renumbered") {
    renumber(e.tabs, "renumbered");
    return;
  }
  const from = harnessTabs.get(e.opener);
  const keeper = keepers.get(e.opener);
  if (from) {
    own(e.tab, from.owner);
    if (from.owner !== undefined) queuePopup(from.owner, { tab: e.tab, url: e.url });
  } else if (keeper !== undefined) {
    keptBy(e.tab, keeper);
    queuePopup(keeper, { tab: e.tab, url: e.url, kept: true });
  } else return;
  note("popup", { tab: e.tab, opener: e.opener });
};

// A Safari that started again restored its tabs under new ids (sighted):
// they are found as the extension connects, while their agents still run
// and their windows still say whose they are. An agent that exits first
// takes its window's record with it (spaces.ts).
bridge.onConnect = () => {
  if (harnessTabs.size > 0) void listTabs().catch(() => {});
};

// Old tab ids and their tabs' ids now: what the daemon keeps per tab, and
// the ids agents hold, follow the tabs (continuity.ts). A reloaded
// extension, or a Safari that started again, no longer knows which tabs
// the harness owns (it lists them in session storage, which Safari
// empties), so it would refuse their closes at a turn's end, an exit, or
// 20 idle minutes, answer none of their dialogs, log none of their
// requests, and leave their popups the user's. Telling it how to answer a
// tab's dialogs owns the tab again (background.js), with the answer a tab
// opens with. A tab reported again, as the extension connects again, has
// moved here already and keeps what its agent has set since.
function renumber(tabs: Map<number, number>, kind: "renumbered" | "restored"): void {
  recordRenumbered(tabs);
  let owned = false;
  for (const [from, to] of tabs) {
    if (!moveKept(from, to)) continue;
    owned = true;
    void bridge.request("dialogs", [to, { accept: false, text: null }]).catch(() => {});
  }
  if (owned) save();
  note(kind, { tabs: Object.fromEntries(tabs) });
}

// What each harness tab shows, from a list of Safari's tabs. A tab the
// list lacks, last seen on an earlier connection of the extension, was
// lost to a Safari that started again; so was one whose id the list gives
// a tab showing another page, as Safari may hand an old id to another tab.
function sighted(tabs: TabInfo[]): void {
  const now = bridge.extensionInfo?.connectedAt;
  const listed = new Map(tabs.map((t) => [t.id, t]));
  const lost: [number, HarnessTab][] = [];
  for (const [id, t] of harnessTabs) {
    const shown = listed.get(id);
    if (shown && (t.seen === now || t.url === undefined || shown.url === t.url)) {
      t.url = shown.url;
      t.seen = now;
    } else if (t.seen !== now && t.owner !== undefined && t.url !== undefined && !t.closing) lost.push([id, t]);
  }
  if (lost.length > 0) restored(lost, tabs);
}

// A Safari that starts again (a crash, an update) restores its windows
// with every tab under a new id, and nothing told the daemon which is
// which: on 10-05 three restarts left one agent's tabs behind each time,
// never closed, in windows that read as the user's, 22 of them by the
// afternoon. An agent's window is known by its page (spaces.ts), and in it
// a lost tab by the page it showed: a restored tab no one holds that shows
// it is that tab, unless more show it than were lost (one kept for the
// user among them), when they all stay his.
function restored(lost: [number, HarnessTab][], tabs: TabInfo[]): void {
  const owners = ownersByPage(tabs);
  const free = new Map<string, number[]>();
  for (const t of tabs) {
    const owner = t.windowId === undefined ? undefined : owners.get(t.windowId);
    if (owner === undefined || t.url === undefined || harnessTabs.has(t.id) || keepers.has(t.id)) continue;
    const key = `${owner} ${t.url}`;
    free.set(key, [...(free.get(key) ?? []), t.id]);
  }
  const was = new Map<string, number[]>();
  for (const [id, t] of lost) {
    const key = `${t.owner} ${t.url}`;
    was.set(key, [...(was.get(key) ?? []), id]);
  }
  const moved = new Map<number, number>();
  const order = (x: number, y: number) => x - y;
  for (const [key, olds] of was) {
    const now = free.get(key) ?? [];
    if (now.length === 0 || now.length > olds.length) continue;
    olds.sort(order);
    for (const [i, to] of now.toSorted(order).entries()) moved.set(olds[i], to);
  }
  if (moved.size > 0) renumber(moved, "restored");
}

// Says whether the tab is one the harness opened.
function moveKept(from: number, to: number): boolean {
  move(lastSnapshot, from, to);
  move(handoffs, from, to);
  move(tabSecrets, from, to);
  move(keepers, from, to);
  return move(harnessTabs, from, to);
}

function move<V>(map: Map<number, V>, from: number, to: number): boolean {
  const v = map.get(from);
  if (v === undefined) return false;
  map.delete(from);
  map.set(to, v);
  return true;
}

export async function navigate(tab: number, url: string): Promise<TabInfo> {
  const t = (await bridge.request("tabs.navigate", [num(tab, "tab"), webAddress(url)])) as TabInfo;
  const mine = harnessTabs.get(t.id);
  if (mine && t.url !== undefined) mine.url = t.url;
  return t;
}

export async function activateTab(tab: number): Promise<unknown> {
  return bridge.request("tabs.activate", [num(tab, "tab")]);
}

// The tab shows in its window, and the window and Safari come to the front:
// the user sees the tab. An agent window comes onto the main display too,
// and stays there: Safari puts agent windows where it likes (on 09-30 all
// of them at -1410, on a display above the main one), and on 09-28
// GitHub's Authorize stayed disabled in one off the main display until
// `window`, then `activate`. His own windows stay where he put them.
async function showTab(tab: number): Promise<unknown> {
  const shown = (await activateTab(tab)) as { windowId: number; width: number; height: number };
  await raiseSafari();
  if (!windowOwners().has(shown.windowId)) return { ok: true };
  return { ok: true, window: await ontoMainDisplay(tab, shown) };
}

type Rect = { x: number; y: number; width: number; height: number };

// Moves an agent window, found by its size (scripts/input window), inside
// the part of the main display the menu bar and Dock leave free: no further
// than that takes, and at its own size, by which its keeper finds it
// (spaces.ts); a window of no size gets 1000 by 800. Safari counts left and
// top from the top-left of the screen the window is on. Answers where the
// window is, in global points from the main display's top-left.
async function ontoMainDisplay(tab: number, size: { width: number; height: number }): Promise<Rect> {
  const { window: w, screen, visible: v } = (await input(["window", String(size.width), String(size.height)])) as Record<"window" | "screen" | "visible", Rect>;
  const width = w.width || 1000;
  const height = w.height || 800;
  const x = Math.max(v.x, Math.min(w.x, v.x + v.width - width));
  const y = Math.max(v.y, Math.min(w.y, v.y + v.height - height));
  if (x !== w.x || y !== w.y || width !== w.width || height !== w.height) {
    await bridge.request("tabs.activate", [tab, { left: x - screen.x, top: y - screen.y, width, height }]);
  }
  return { x, y, width, height };
}

// snapshot and a missed wait say when the tab shows a bot check
// (challenge.ts), as open and goto do: the agent hands it to the user with
// handoff. A result still coming has its probe sent beside it.
async function withChallenge<T extends object>(result: T | Promise<T>, tab: number): Promise<T> {
  const [r, challenge] = await Promise.all([result, challengeOf(tab)]);
  return challenge ? { ...r, challenge } : r;
}

// open and goto wait out a Cloudflare check that lets the browser through
// (settledChallenge), and then answer with the page behind it.
async function afterWall(t: TabInfo, tab: number): Promise<object> {
  const { challenge, top } = await settledChallenge(tab);
  const { title: _, ...rest } = t;
  const page = top ? { ...rest, url: top.url, ...(top.title ? { title: top.title } : {}) } : t;
  return challenge ? { ...page, challenge } : page;
}

// open, goto, and snapshot also carry what agents have learned about the
// site: on the first result on it for each agent (notes.ts), and again on a
// page not found, which a note may explain. The first result on a host
// with a bundled guide names it (site-guides.ts). Both go before the window's
// details (space), which run long: on 09-29 an agent cut an open of
// Robinhood at 400 bytes (head -c) and lost its note that the Gold Card is
// app-only, then opened three pages not found that did not repeat it.
const NOT_FOUND = /\bnot found\b|\b404\b/i;
function withNotes(result: object): object {
  const title = "title" in result && typeof result.title === "string" ? result.title : "";
  const url = "url" in result && typeof result.url === "string" ? result.url : undefined;
  const { notes, first } = firstNotes(url, NOT_FOUND.test(title));
  const slug = first && url !== undefined ? guideFor(url) : undefined;
  if (notes === undefined && slug === undefined) return result;
  const { space, ...rest }: { space?: unknown } = result;
  return { ...rest, ...(slug === undefined ? {} : { guide: `safari guide ${slug}` }), ...(notes === undefined ? {} : { notes }), ...(space === undefined ? {} : { space }) };
}

// The latest whole-page snapshot of each tab, for diff.
const lastSnapshot = new Map<number, string>();

export async function snapshot(opts: { tab?: number; root?: string; query?: string; maxNodes?: number; diff?: boolean; showHidden?: boolean } = {}) {
  const tab = await resolveTab(opts.tab);
  // The bot-check probe goes out with the snapshot request: sent after its
  // answer, it added 5 of the 14 ms a snapshot of cnn.com took. A page still
  // drawing is read once: its own snapshot waits for it (snapshot in
  // content.js), and a second wait here doubled the time a blank page took
  // to answer.
  const read = (root: string | undefined) => withChallenge(relay(tab, "snapshot", [{ root, query: opts.query, maxNodes: opts.maxNodes, showHidden: !!opts.showHidden }]) as Promise<Snapshot>, tab);
  const { page, missed } = await narrowed("root", opts.root, read);
  const snap = shieldSnapshot(page);
  if (missed) return { ...snap, note: missed };
  if (opts.root !== undefined || opts.query !== undefined) return snap;
  const before = lastSnapshot.get(tab);
  lastSnapshot.set(tab, snap.snapshot);
  if (!opts.diff || before === undefined) return snap;
  return { ...snap, snapshot: lineDiff(before.split("\n"), snap.snapshot.split("\n")) || "(no change)" };
}

// A root or selector that matches nothing in any frame reads the whole
// page instead, and says so: on 10-04 three reads named a root or selector
// "main" a page did not have, and two next calls read it without one.
async function narrowed<T>(option: "root" | "selector", value: string | undefined, read: (value: string | undefined) => Promise<T>): Promise<{ page: T; missed?: string }> {
  try {
    return { page: await read(value) };
  } catch (e) {
    if (value === undefined || !(e instanceof Error) || !e.message.startsWith(`nothing on the page matches ${option} `)) throw e;
    return { page: await read(undefined), missed: `nothing on the page matches ${option} "${value}", so this is the whole page` };
  }
}

// The lines only in `a` ("- ") and only in `b` ("+ "), in page order, from
// their longest common subsequence.
export function lineDiff(a: string[], b: string[]): string {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; }
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  return out.join("\n");
}

export async function click(opts: { tab?: number; ref?: number | string; x?: number; y?: number }) {
  const tab = await resolveTab(opts.tab);
  if (opts.ref !== undefined) return relay(tab, "click", [opts.ref]);
  if (opts.x !== undefined && opts.y !== undefined) return relay(tab, "clickAt", [num(opts.x, "x"), num(opts.y, "y")]);
  throw new Error("click needs ref or x+y");
}

// The page's answer says whether the field kept the text, never the text:
// an agent's own typing, or a code the caller filled in (secret.ts), stays
// out of the transcript. An extension Safari has not reloaded since still
// sends the value, so it is dropped here too.
export async function type(opts: { tab?: number; ref: number | string; text: string; append?: boolean; secret?: unknown }) {
  const tab = await resolveTab(opts.tab);
  const text = str(opts.text, "text");
  if (typeof opts.secret === "string" || text.includes("{{code}}")) throw new Error("a code is filled in by the safari CLI or MCP tools, not over the daemon's port: call type through them");
  // the tab's answers have it cut after the page moves on too (redact.ts)
  if (opts.secret === true) keepSecret(tab, text);
  const answer = await relay(tab, "type", [opts.ref, text, { append: !!opts.append, secret: opts.secret === true }]);
  if (!answer || typeof answer !== "object" || !("ok" in answer)) return answer;
  return { ...Object.fromEntries(Object.entries(answer).filter(([k]) => k !== "value")), typed: `${text.length} chars` };
}

export async function press(opts: { tab?: number; ref?: number | string; key: string }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "press", [opts.ref ?? null, str(opts.key, "key")]);
}

// A ref scrolls its element to the middle of the view: on 09-29 an agent
// called scroll with a ref to bring a control into sight.
export async function scroll(opts: { tab?: number; ref?: number | string; dx?: number; dy?: number }) {
  const tab = await resolveTab(opts.tab);
  if (opts.ref !== undefined) {
    await relay(tab, "locate", [String(opts.ref)]);
    return { ok: true };
  }
  const dy = opts.dy ?? (opts.dx ? 0 : 600);
  return relay(tab, "scroll", [opts.dx ?? 0, dy]);
}

export async function select(opts: { tab?: number; ref: number | string; option: string }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "select", [opts.ref, str(opts.option, "option")]);
}

export async function hover(opts: { tab?: number; ref: number | string }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "hover", [opts.ref]);
}

// find looks for the file in his own folders (finder.ts) and attaches
// nothing; the agent calls again with the path it picked. A ref that holds
// no file input, on a page with only one, gives the files to that one: on
// 09-29 an agent named the upload area and was told to call again without
// the ref. On a page with none or several, the error says both.
export async function upload(opts: { tab?: number; ref?: number | string; paths?: string[]; find?: string }) {
  const tab = await resolveTab(opts.tab);
  if (opts.find !== undefined) return findFiles(str(opts.find, "find"));
  if (!Array.isArray(opts.paths) || opts.paths.length === 0) throw new Error("upload needs paths: [\"/abs/file\", ...], or find: \"words\" to look for the file");
  const files = await Promise.all(opts.paths.map(async (p) => {
    const f = Bun.file(str(p, "path"));
    if (!(await f.exists())) throw new Error(`no such file: ${p}`);
    return { name: basename(p), type: f.type, data: Buffer.from(await f.arrayBuffer()).toString("base64") };
  }));
  const at = opts.ref ?? null;
  return relay(tab, "upload", [at, files], 60000).catch(async (e: unknown) => {
    if (at === null || !(e instanceof Error) || !e.message.startsWith("no file input at that ref")) throw e;
    const only = await relay(tab, "upload", [null, files], 60000).catch((again: unknown) => {
      throw new Error(`no file input at that ref, and the ${again instanceof Error ? again.message : String(again)}`);
    });
    return beside(only, "note", "no file input at that ref, so the page's only one took the files");
  });
}

const HISTORY = new Set(["back", "forward", "reload"]);

export async function history(opts: { tab?: number; do: string }) {
  const tab = await resolveTab(opts.tab);
  if (!HISTORY.has(opts.do)) throw new Error("do must be back, forward, or reload");
  return relay(tab, "history", [opts.do]);
}

// Statements work too, and a top-level await: statements.ts makes them one
// expression that returns the last one's value. A leading "f3:", the prefix
// of an embedded frame's refs, runs it in that frame. page: true runs it in
// the page's own world, where its script variables are. A page that demands
// Trusted Types still runs it. A page whose security policy forbids eval
// refuses it in the extension's world before any of it runs (content.js),
// so it runs in the page's world instead, once; where that refuses too, the
// error says to read the page another way.
const EVAL_BLOCKED = "this page's security policy blocks eval; use snapshot, extract, or data";
const EVAL_REFUSED = /unsafe-eval|Content Security Policy/i;

export async function evaluate(opts: { tab?: number; expression: string; page?: boolean }) {
  const tab = await resolveTab(opts.tab);
  const [, frame = "0", source] = /^(?:f(\d+):)?([\s\S]*)$/.exec(str(opts.expression, "expression"))!;
  const code = asExpression(source);
  // The extension gets eval's limit too, and answers first, as through
  // bridge.tab: code past it is told so, not that the request timed out.
  const inPage = () => bridge.request("evalPage", [tab, code, Number(frame), 30000], 32000).catch((e: unknown) => {
    throw e instanceof Error && EVAL_REFUSED.test(e.message) ? new Error(EVAL_BLOCKED) : e;
  });
  const answer = opts.page ? inPage() : bridge.tab(tab, "eval", [code], 30000, Number(frame)).catch((e: unknown) => {
    if (e instanceof Error && e.message === EVAL_BLOCKED) return inPage();
    throw e;
  });
  // eval's own world gets no animation frame while its tab is hidden: the
  // ticks that keep a harness tab's page running drive only the page's
  // callbacks (dialogs.js). On 10-04 an eval that awaited one ran its full
  // 30 s (01a104d2), and one did on 09-27 (01a0e20a).
  return answer.catch(async (e: unknown) => {
    if (!opts.page && e instanceof Error && e.message.startsWith("your code ran past") && code.includes("requestAnimationFrame")) throw new Error(`${e.message}. eval's requestAnimationFrame never fires while the tab is hidden; use setTimeout`);
    throw await unanswered(e);
  });
}

// eval {reader} runs the script an agent saved for the tab's site, or a
// site above it (learn), in the world it was saved for.
async function runReader(tab: number | undefined, name: string) {
  const id = await resolveTab(tab);
  const { url } = (await relay(id, "tabInfo")) as { url?: string };
  const reader = readerFor(url ?? "", name);
  return evaluate({ tab: id, expression: reader.expression, page: reader.page });
}

// as: "table" reads the page's tables and repeated card lists as rows.
export async function extract(opts: { tab?: number; selector?: string; query?: string; maxBytes?: number; as?: string }) {
  const tab = await resolveTab(opts.tab);
  const strict = "strict_selector" in opts && opts.strict_selector === true;
  const read = (selector: string | undefined) => relay(tab, "extract", [{ selector, query: opts.query, maxBytes: opts.maxBytes, as: opts.as, strict_selector: strict }]) as Promise<Extract | { tables: unknown[] }>;
  // a secret's source must match exactly, never the whole page
  const { page, missed } = strict ? { page: await read(opts.selector) } : await narrowed("selector", opts.selector, read);
  // as: "table" answers rows, not text
  const out = "text" in page ? shieldExtract(page) : page;
  return missed ? { ...out, note: missed } : out;
}

export async function tabInfo(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "tabInfo");
}

// What the page answers a wait with (waitFor in content.js): already, that
// what it waited for held as it began; added, the lines new since the last
// look of a changed wait; meanwhile, what changed during a missed wait.
type Seen = { found: boolean; which?: string; already?: boolean; added?: string[]; hint?: string; meanwhile?: string[] };

// A text wait the page never met. Late in September agents waited on words
// no page shows ("zzqq1" to "zzqq48") to sleep, 15 minutes of it.
const NEVER_SHOWN = "the page never showed those words; open and goto already wait for the page, and words it cannot show only make a sleep: wait on words a snapshot showed";

// A changed wait with no new lines yet. The page keeps its last look, so
// the next call still catches a reply that comes in between.
const NOTHING_NEW = "no new lines yet; call wait with changed again, and a reply that comes in between still counts";

// Let a stopped page send its change summary, without letting a page held
// by navigation or a dialog hold the caller indefinitely (USCIS, 09-30).
const STOPPED_MS = 1000;

// Waits until the page shows what the wait asks for (ms is then the
// timeout, max 30000): a selector or text, the first of several texts (any;
// which says which), text gone, an address (url: a part of it, or
// /regex/), or a page that made no change for 500 ms with no request to its
// own site still out (quiet). Text matches case and spacing aside. The page
// reports the moment it sees it (waitFor in content.js); the time limit is
// kept here, because Safari stops a content script's timers in a hidden
// tab. At the limit the page gets at most a second to report what changed.
// A miss also says where the tab is: often a redirect (signed out, sent
// to the home page). A wait with only ms ends once the page is quiet, ms at
// most: it slept all of it, and in the car and insurance searches of late
// September such sleeps held agents about 9 minutes. A page that cannot be
// watched still gets its ms, as a sleep did. On screen (front), it holds
// the tab there all of ms: what it waits on is an animation, which a quiet
// page does not rule out.
export async function wait(opts: { tab?: number; ms?: number; selector?: string; text?: string; any?: string[]; gone?: string; url?: string; quiet?: boolean; changed?: boolean; front?: boolean; look?: string; after?: string }) {
  const tab = await resolveTab(opts.tab);
  if (opts.look !== undefined) return relay(tab, "wait", [null, { look: opts.look }]);
  const named = waitsOnPage(opts);
  if (!named && opts.ms === undefined) throw new Error(WAIT_NEEDS);
  const asked = opts.ms === undefined ? 10000 : num(opts.ms, "ms");
  const limit = Math.min(asked, 30000);
  // A wait cut to the limit says so: its answer at 30 s is not all of the
  // 60000 ms an agent asked for.
  const cut = asked > limit ? { note: "ms is at most 30000: call wait again to wait longer" } : {};
  if (!named && opts.front) {
    await Bun.sleep(limit);
    return { ok: true, ...cut };
  }
  if (opts.any !== undefined && !(Array.isArray(opts.any) && opts.any.length > 0 && opts.any.every((t) => typeof t === "string"))) throw new Error("any must be a list of texts");
  if (opts.url !== undefined) {
    const url = str(opts.url, "url");
    try {
      urlMatch("", url);
    } catch (e) {
      throw new Error(`url ${url} is not a valid /regex/: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const start = Date.now();
  const stop = () => { relay(tab, "waitStop").catch(() => {}); };
  const spec = { text: opts.text, any: opts.any, gone: opts.gone, url: opts.url, quiet: opts.quiet === true || !named, ...(opts.changed === true ? { changed: true } : {}), ...(opts.after === undefined ? {} : { after: opts.after }) };
  const seen = relay(tab, "wait", [opts.selector ?? null, spec], limit + 5000) as Promise<Seen>;
  // A page that answers only after the limit (it navigated, and the new page
  // began the wait again) still holds a wait: end that one too.
  seen.catch(stop);
  const timeUp = Promise.withResolvers<Seen>();
  let late = false;
  let timer = setTimeout(() => {
    late = true;
    stop();
    if (named) timer = setTimeout(() => timeUp.resolve({ found: false }), STOPPED_MS);
    else timeUp.resolve({ found: false });
  }, limit);
  try {
    if (!named) {
      await Promise.race([seen.catch(() => timeUp.promise), timeUp.promise]);
      return { ok: true, waitedMs: Date.now() - start, ...cut };
    }
    const { found: met, which, already, added, hint, meanwhile } = await Promise.race([seen.catch((e) => { if (late) return timeUp.promise; throw e; }), timeUp.promise]);
    const found = met && !late;
    const waitedMs = Date.now() - start;
    if (found) return { ok: true, found, waitedMs, ...(which === undefined ? {} : { which }), ...(already ? { already } : {}), ...(added === undefined ? {} : { added }), ...(hint === undefined ? {} : { hint }) };
    const now = (await listTabs()).find((t) => t.id === tab);
    const words = (opts.text !== undefined || opts.any !== undefined) && opts.selector === undefined && opts.gone === undefined && opts.url === undefined && opts.quiet !== true && opts.changed !== true;
    const missed = opts.after === undefined ? NEVER_SHOWN : "none of those words appeared after the preceding action; meanwhile says what changed while waiting";
    const hints = [hint, words ? missed : undefined, opts.changed === true ? NOTHING_NEW : undefined].filter((h) => h !== undefined);
    return withChallenge({ ok: true, found, waitedMs, url: now?.url, title: now?.title, ...(meanwhile === undefined ? {} : { meanwhile }), ...(hints.length === 0 ? {} : { hint: hints.join("; ") }), ...cut }, tab);
  } finally {
    clearTimeout(timer);
  }
}

// Hands the tab to the user for a step only they can take: a bot check, or a
// passkey or Touch ID prompt. This is the daemon's half of handoff; the
// caller's (handoff.ts) texts the user's phone when they are away. A tab has
// one handoff at a time, watched here once a second: the first call brings
// the tab to the front and posts a notification that says why, and a later
// call joins it with no second notice, so the wait can outlast one tool call
// (about 2 minutes). The user is done when the check is gone or, with no
// check seen, the page has moved on; given until, once the page shows that
// text instead, for a step that leaves the address as it was (on 09-29 a
// GEICO card form and a Touch ID prompt each held a handoff to its 110 s).
// Text the page shows already is refused, since it would end the handoff at
// once. If they are still on the tab, they get back the tab and app they had
// in front. A block ends a handoff (no one can clear it), and so do 5
// minutes with no call waiting. Once over, it answers only the calls that
// carry its id (the caller's own later slices, which may come after it
// ends), so they do not start another.
type Handoff = {
  id: number;
  start: number;
  // settled once the tab is in front with the notice up, or the handoff failed
  begun: PromiseWithResolvers<void>;
  over: PromiseWithResolvers<void>;
  // the tab as last seen
  now: { url?: string; title?: string; challenge?: Challenge };
  done: boolean;
  error?: string;
  // how the alert to the user's phone went: one per handoff
  alerted?: string;
  waiting: number;
  calledAt: number;
};
const handoffs = new Map<number, Handoff>();
const HANDOFF_IDLE_MS = 5 * 60_000;
let handoffCount = 0;

const blocked = (c: Challenge) => `${c.kind} turned this browser away: the page is a block, not a check, so no one can clear it. Try later or another way in.`;

async function watchHandoff(tab: number, why: string, h: Handoff, until?: string) {
  const gone = new Error("that tab is gone: it was closed; find it with tabs");
  try {
    // A look for until's text takes up to a second; a page that cannot
    // answer (it is loading) does not show it yet.
    const [tabs, initial, before] = await Promise.all([listTabs(), challengeOf(tab), until !== undefined && wait({ tab, text: until, ms: 1000 }).then((r) => r.found === true, () => false)]);
    const first = tabs.find((t) => t.id === tab);
    if (!first) throw gone;
    if (initial?.where === "block") throw new Error(blocked(initial));
    if (before) throw new Error(`the page already shows "${until}": give until text it shows only once the user is done`);
    h.now = { url: first.url, title: first.title, ...(initial ? { challenge: initial } : {}) };
    const giveBack = await show(tab, { tabs: listTabs, activate: activateTab });
    notify(why);
    h.begun.resolve();
    // the first check the page answered with; null until it answers
    let seen = initial;
    while (h.waiting > 0 || Date.now() - h.calledAt < HANDOFF_IDLE_MS) {
      const [, met] = await Promise.all([Bun.sleep(1000), until !== undefined && wait({ tab, text: until, ms: 1000 }).then((r) => r.found === true, () => false)]);
      const [tabs, challenge] = await Promise.all([listTabs(), challengeOf(tab)]);
      // Safari may have swapped the tab for another (continuity.ts)
      tab = followTab(tab);
      const now = tabs.find((t) => t.id === tab);
      if (!now) throw gone;
      if (challenge?.where === "block") throw new Error(blocked(challenge));
      if (seen === null) seen = challenge;
      h.now = { url: now.url, title: now.title, ...(challenge ? { challenge } : {}) };
      if (until === undefined ? challenge === undefined && (seen !== undefined || now.url !== first.url) : met) {
        h.done = true;
        // gone elsewhere, they have taken back what they wanted themselves;
        // the tab sits in an agent window, which never holds the front tab
        if (now.shown && (await frontApp().catch(() => undefined)) === SAFARI) await giveBack();
        return;
      }
    }
  } catch (e) {
    h.error = e instanceof Error ? e.message : String(e);
  } finally {
    // one that ran out of callers leaves nothing to answer
    if (handoffs.get(tab) === h && !h.done && h.error === undefined) handoffs.delete(tab);
    h.begun.resolve();
    h.over.resolve();
  }
}

// Starts or joins the tab's handoff and waits up to ms for it to end. The
// first call that finds the user away (as the caller measured) is told to
// alert them (alert: true) and returns at once; it reports how that went as
// alerted, so no other call sends one.
async function handoffWait(tab: number, why: string, o: { ms: number; away: boolean; alerted?: string; id?: number; until?: string }) {
  let h = handoffs.get(tab);
  if (h && (h.done || h.error !== undefined) && h.id !== o.id) h = undefined;
  const joined = h !== undefined;
  if (!h) {
    for (const [t, x] of handoffs) if (Date.now() - x.calledAt > HANDOFF_IDLE_MS && x.waiting === 0 && (x.done || x.error !== undefined)) handoffs.delete(t);
    h = { id: ++handoffCount, start: Date.now(), begun: Promise.withResolvers(), over: Promise.withResolvers(), now: {}, done: false, waiting: 0, calledAt: Date.now() };
    handoffs.set(tab, h);
    void watchHandoff(tab, why, h, o.until);
  }
  const session = h;
  session.waiting++;
  if (o.alerted !== undefined) session.alerted = o.alerted;
  let timer: Timer | undefined;
  try {
    await session.begun.promise;
    const alert = o.away && session.alerted === undefined && !session.done && session.error === undefined;
    if (alert) session.alerted = "sending";
    else if (o.ms > 0) await Promise.race([session.over.promise, new Promise<void>((r) => { timer = setTimeout(r, Math.min(o.ms, 110000)); })]);
    if (session.error !== undefined) throw new Error(session.error);
    return { id: session.id, done: session.done, waitedMs: Date.now() - session.start, ...session.now, ...(joined ? { joined } : {}), ...(session.alerted ? { alerted: session.alerted } : {}), ...(alert ? { alert } : {}) };
  } finally {
    clearTimeout(timer);
    session.waiting--;
    session.calledAt = Date.now();
  }
}

export async function netStart(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "net", [true]);
}

export async function netStop(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "net", [false]);
}

// The requests the page made, or with url only those whose address has
// that part, each with its index in the whole list, which body takes.
export async function netRead(opts: { tab?: number; url?: string } = {}) {
  const tab = await resolveTab(opts.tab);
  const read = (await relay(tab, "netRead")) as { entries: { url: string }[] };
  const { url } = opts;
  if (url === undefined) return read;
  return { entries: read.entries.flatMap((e, index) => (e.url.includes(url) ? [{ index, ...e }] : [])) };
}

// One request's whole body, as the page's world keeps it (dialogs.js):
// body is the request's place in the list read gives (from its end when
// below 0), or part of its url, naming the latest request with it. To read
// a server action's answer whole, an agent patched the page's fetch
// through eval (USCIS, 09-30).
export async function netBody(opts: { tab?: number; body: unknown; do?: unknown }) {
  if (opts.do !== undefined && opts.do !== "read") throw new Error("body goes with do: read");
  const which = opts.body;
  if (typeof which !== "number" && typeof which !== "string") throw new Error("body is a request's index in the list, or part of its url");
  const tab = await resolveTab(opts.tab);
  const { entries } = (await relay(tab, "netRead")) as { entries: { url: string; t: number; frame?: number; body?: string }[] };
  const byIndex = typeof which === "number" || /^-?\d+$/.test(which);
  const entry = byIndex ? entries.at(Number(which)) : entries.findLast((e) => e.url.includes(String(which)));
  if (!entry) throw new Error(byIndex ? `no request at ${which}: the list has ${entries.length}` : `no request in the list has ${which} in its url`);
  const kept = (await bridge.tab(tab, "netBody", [{ url: entry.url, t: entry.t }], undefined, entry.frame)) as { text: string; truncated: boolean; arriving: boolean };
  const note = kept.truncated ? `the body runs past ${kept.text.length} characters; this is its start` : kept.arriving ? "the body is still arriving; this is what came so far" : undefined;
  const { body: _, ...request } = entry;
  return { ...request, text: kept.text, ...(note === undefined ? {} : { note }) };
}

export async function consoleStart(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "console", [true]);
}

export async function consoleRead(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "consoleRead");
}

export async function cookies(opts: { tab?: number; url?: string } = {}) {
  const tab = await resolveTab(opts.tab);
  const info = (await relay(tab, "tabInfo")) as { url?: string };
  return bridge.request("cookies", [opts.url ?? info.url ?? ""]);
}

// Sets one cookie for the tab's site (or url). Safari will not set an
// HttpOnly cookie from an extension. Its cookie API stores a cookie at once
// but hands it to the open page late or not until a later load (5 of 6
// tries unseen by the page after 1.5 s), so a cookie for the tab's own site
// goes in through the page, the way the site's own script sets one.
export async function setCookie(opts: { tab?: number; url?: string; name: string; value: string; domain?: string; path?: string; expires?: number }) {
  const tab = await resolveTab(opts.tab);
  const page = ((await relay(tab, "tabInfo")) as { url?: string }).url;
  const url = opts.url ?? page;
  if (!url || !/^https?:/.test(url)) throw new Error("set needs a web page or a url");
  const name = str(opts.name, "name");
  const value = str(opts.value, "value");
  const path = opts.path ?? "/";
  const expires = opts.expires === undefined ? undefined : num(opts.expires, "expires");
  const secure = url.startsWith("https:");
  if (page && /^https?:/.test(page) && new URL(url).origin === new URL(page).origin) {
    if (/[;\s]/.test(`${name}${value}`) || name.includes("=")) throw new Error("a cookie name or value cannot hold ;, =, or spaces");
    const attrs = [`${name}=${value}`, `path=${path}`];
    if (opts.domain !== undefined) attrs.push(`domain=${opts.domain}`);
    if (expires !== undefined) attrs.push(`expires=${new Date(expires * 1000).toUTCString()}`);
    if (secure) attrs.push("secure");
    await relay(tab, "eval", [`document.cookie = ${JSON.stringify(attrs.join("; "))}`], 30000);
    return { ok: true, name, domain: opts.domain ?? new URL(url).hostname, path };
  }
  const cookie: Record<string, unknown> = { url, name, value, path, secure };
  if (opts.domain !== undefined) cookie.domain = opts.domain;
  if (expires !== undefined) cookie.expirationDate = expires;
  return bridge.request("cookies.set", [cookie]);
}

// Makes Safari forget one site, so a sign-up can start over: every cookie
// of the site and its subdomains, the storage of each origin it reaches,
// and the caller's tabs there. On 10-02 an agent made TikTok forget a
// failed sign-up in Settings > Privacy > Manage Website Data, a row at a
// time, while the site's open tabs set its cookies again. Safari gives an
// extension no browsingData, so a page of each origin empties its own
// storage: the caller's tabs on the site, then one opened on the address's
// origin, the bare site, and www. The cookies go last, once no page of the
// caller's is left there to set them again. A tab of the user's on the
// site stops it: it would sign him out there, and his page would set the
// cookies again.
export async function clearSite(opts: { tab?: unknown; url?: string }) {
  // the extension's tabInfo answer; a url names the site without a tab
  const info = opts.url === undefined ? ((await relay(await resolveTab(opts.tab), "tabInfo")) as { url?: string }) : undefined;
  const address = URL.parse(opts.url ?? info?.url ?? "");
  if (!address || !/^https?:$/.test(address.protocol)) throw new Error("clear needs a web page or a url, like https://tiktok.com");
  const domain = site(address.hostname);
  const onSite = (url?: string) => {
    const host = URL.parse(url ?? "")?.hostname;
    return host === domain || !!host?.endsWith(`.${domain}`);
  };
  const tabs = (await listTabs()).filter((t) => onSite(t.url));
  const me = currentOwner();
  const mine = tabs.filter((t) => harnessTabs.has(t.id) && harnessTabs.get(t.id)?.owner === me);
  // A tab kept for the user is his, though it stays in the agent's window
  // until its turn ends; tabsView shows a caller with no agent behind it
  // every tab on the site.
  const kept = tabs.filter((t) => keepers.has(t.id));
  const his = [...kept, ...(await tabsView(tabs, new Map([...harnessTabs].map(([id, t]) => [id, t.owner])), { host: domain }))
    .filter((t): t is TabInfo => typeof t !== "string" && !mine.some((m) => m.id === t.id) && !kept.some((k) => k.id === t.id))];
  if (his.length > 0) throw new Error(`${domain} is open in the user's tabs: ${his.map((t) => `tab ${t.id} ${URL.parse(t.url ?? "")?.origin}`).join(", ")}. A clear would sign him out there, and his pages would set its cookies again: ask him to close them, then clear again`);
  const why = `by a cookies clear of ${domain}`;
  // before the pages below delete the cookies their scripts read
  const before = (await bridge.request("cookies.count", [domain])) as number;
  const reached: Reached = { cleared: new Set(), notReached: [] };
  for (const t of mine) await emptyIn(t.id, t.url, reached);
  for (const origin of new Set([address.origin, `https://${domain}`, `https://www.${domain}`])) {
    if (!reached.cleared.has(origin)) await emptyThrough(origin, onSite, reached, why);
  }
  for (const t of mine) await closeTab(t.id, why);
  const jar = (await bridge.request("cookies.clear", [domain], 30000)) as { left: number };
  return { site: domain, cookiesBefore: before, cookiesLeft: jar.left, originsCleared: [...reached.cleared], ...(reached.notReached.length > 0 ? { notReached: reached.notReached } : {}), tabsClosed: mine.map((t) => t.id) };
}

// The origins a clear emptied, and each it could not, with why.
type Reached = { cleared: Set<string>; notReached: string[] };

async function emptyIn(tab: number, url: string | undefined, reached: Reached): Promise<void> {
  try {
    // the extension's storage.clear answer
    const page = (await bridge.request("storage.clear", [tab], 30000)) as { origin: string };
    reached.cleared.add(page.origin);
  } catch (e) {
    reached.notReached.push(`${URL.parse(url ?? "")?.origin}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Opens origin's /robots.txt in a background tab, where none of the site's
// scripts run to fill its storage again, empties the page it lands on when
// that is on the site, and closes it. A bare site that sends its pages to
// www is not reached.
async function emptyThrough(origin: string, onSite: (url?: string) => boolean, reached: Reached, why: string): Promise<void> {
  const page = await openTab(`${origin}/robots.txt`, true).catch((e: unknown) => {
    reached.notReached.push(`${origin}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!page) return;
  // the sweep closes it should the daemon stop before this does
  own(page.id, currentOwner());
  try {
    const landed = URL.parse(page.url ?? "")?.origin;
    if (landed !== origin) reached.notReached.push(`${origin}: its page went to ${landed}`);
    if (landed !== undefined && onSite(page.url) && !reached.cleared.has(landed)) await emptyIn(page.id, page.url, reached);
  } finally {
    await closeTab(page.id, why);
  }
}

export async function pageFetch(opts: { tab?: number; url: string; method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number; base64?: boolean }) {
  const tab = await resolveTab(opts.tab);
  const url = str(opts.url, "url");
  return relay(tab, "fetch", [url, { method: opts.method, headers: opts.headers, body: opts.body, maxBytes: opts.maxBytes, base64: !!opts.base64 }], 60000)
    .catch(async (e: unknown) => { throw await unanswered(e, url); });
}

async function scratchFile(prefix: string, name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), prefix)), name);
}

type ShotOpts = { ref?: string; annotate?: boolean; fullPage?: boolean };

// What the tab shows, as base64 PNG (Safari's own capture: no window
// chrome, no screen-recording permission). ref crops to one element;
// annotate draws the snapshot's refs on the page for the capture; fullPage
// scrolls and stitches (sticky headers repeat).
export async function captureTab(tab: number, opts: ShotOpts = {}) {
  return (await bridge.request("shot", [tab, { ref: opts.ref, annotate: !!opts.annotate, fullPage: !!opts.fullPage }], 60000)) as { data: string; screens?: number; cut?: boolean };
}

export async function screenshot(opts: ShotOpts & { tab?: number; out?: string } = {}) {
  const r = await captureTab(await resolveTab(opts.tab), opts);
  const out = opts.out ?? await scratchFile("safari-shot-", "shot.png");
  await writeFile(out, Buffer.from(r.data, "base64"));
  return { path: out, ...(r.screens ? { screens: r.screens } : {}), ...(r.cut ? { cut: "page longer than 12 screens; the rest is not in the image" } : {}) };
}

// ---------- downloads ----------
type FilePayload = { name: string; type: string; size: number; data: string; disposition?: string | null; url?: string };

const DOWNLOADS = join(homedir(), "Downloads");

// A saved file's name: the one the link or server gave, else the last part
// of its address. A web page without .html is named for its title, and a
// PDF without .pdf gets it: on 09-29 GEICO's page was saved as
// "edgecustomer.geico.com" and a PDF as "download".
function nameOf(f: FilePayload, fallbackUrl: string): string {
  const fromHeader = f.disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(f.disposition)?.[1] : undefined;
  let name = f.name || (fromHeader ? decodeURIComponent(fromHeader) : "");
  if (!name) {
    try { name = decodeURIComponent(basename(new URL(f.url ?? fallbackUrl).pathname)); } catch { name = ""; }
  }
  name = name.replace(/[/\\:\0]/g, "_").replace(/^\.+/, "").trim() || "download";
  if (/^text\/html\b/i.test(f.type) && !/\.html?$/i.test(name)) return `${titleOf(f) || name}.html`;
  if (/^application\/pdf\b/i.test(f.type) && !/\.pdf$/i.test(name)) return `${name}.pdf`;
  return name;
}

// A page's <title> as a file name: its letters and digits, dashes between.
// The title sits in the page's head, well within its first 48 KB.
function titleOf(f: FilePayload): string {
  const head = Buffer.from(f.data.slice(0, 65536), "base64").toString("utf8");
  const title = /<title[^>]*>([^<]*)</i.exec(head)?.[1] ?? "";
  return title.replace(/&[#\w]+;/g, " ").replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 80).replace(/^-+|-+$/g, "");
}

// A path in dir for name that does not overwrite anything: "a.pdf", "a (1).pdf", ...
async function freePath(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const taken = new Set(await readdir(dir));
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; taken.has(candidate); i++) candidate = `${stem} (${i})${ext}`;
  return join(dir, candidate);
}

async function saveFile(f: FilePayload, url: string, out: string | undefined, folder: string) {
  const path = out ?? await freePath(folder, nameOf(f, url));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(f.data, "base64"));
  return { path, name: basename(path), size: f.size, type: f.type };
}

const isFile = (f: unknown): f is FilePayload => !!f && typeof f === "object" && "data" in f && typeof f.data === "string";

// A click that took the page elsewhere answers where it went, not a file.
// Safari shows some files itself (a PDF, an image), so that address may be
// the file; a page there means the click opened a page, or began a download
// of the site's own, which Safari saves in ~/Downloads.
async function fileAfterClick(res: unknown): Promise<FilePayload> {
  const to = navigatedOf(res);
  if (!to) throw new Error("the page answered no file");
  const f = (await bridge.request("fetchFile", [to.url], 120000)) as FilePayload;
  if (/^text\/html\b/i.test(f.type)) throw new Error(`the click went to the page ${to.url}, not a file; a download the site started itself is saved in ~/Downloads`);
  return f;
}

// A file by url, fetched with the page's cookies (the extension's own
// fetch when the page may not read that site, or when no tab is given), the
// file a ref's link or button downloads, or with only a tab, the file the
// tab shows (a PDF in Safari's viewer). Saved in folder (~/Downloads, where
// Safari saves too) unless out says where.
export async function download(opts: { tab?: number; ref?: string; url?: string; out?: string }, folder = DOWNLOADS) {
  if (opts.tab === undefined && opts.url !== undefined) {
    const url = str(opts.url, "url");
    return saveFile((await bridge.request("fetchFile", [url], 120000)) as FilePayload, url, opts.out, folder);
  }
  const tab = await resolveTab(opts.tab);
  if (opts.url !== undefined || opts.ref === undefined) {
    const url = opts.url === undefined ? ((await listTabs()).find((t) => t.id === tab)?.url ?? "") : str(opts.url, "url");
    // A page that navigates while it fetches answers where it went instead.
    const inPage = await relay(tab, "fetchFile", [url, ""], 120000).catch(() => null);
    const f = isFile(inPage) ? inPage : (await bridge.request("fetchFile", [url], 120000)) as FilePayload;
    return saveFile(f, url, opts.out, folder);
  }
  const ref = String(opts.ref);
  // A file the server sends after the click is saved by Safari itself, never
  // handed to the page; on a tab the harness opened it is found in
  // folder instead (downloads.ts).
  const saved = harnessTabs.has(tab) ? await watchDownloads(folder) : null;
  const stop = setTimeout(() => { relay(tab, "downloadStop", [ref]).catch(() => {}); }, 10000);
  try {
    const f = await relay(tab, "download", [ref], 120000);
    return saveFile(isFile(f) ? f : await fileAfterClick(f), "", opts.out, folder);
  } catch (e) {
    const got = saved ? await saved() : {};
    // A file Safari saved itself is answered as saveFile answers one, and
    // put at out: on 10-01 the REPL's saveAs found no path in the bare
    // list and failed ("src must be a string").
    const file = got.downloaded?.[0];
    if (file) {
      const path = opts.out ?? file.path;
      if (path !== file.path) {
        await mkdir(dirname(path), { recursive: true });
        await copyFile(file.path, path);
        await unlink(file.path);
      }
      return { path, name: basename(path), size: file.bytes, type: "" };
    }
    if (got.downloading) throw new Error(`Safari was still saving ${got.downloading.join(", ")} after 30 s; the file lands there when it is done`);
    throw e;
  } finally {
    clearTimeout(stop);
  }
}

// A click or key on a tab the harness opened reports the files Safari saved
// to ~/Downloads while it ran (downloads.ts). The user's own tabs are never
// watched, so none of his downloads is claimed.
function watched(run: (a: Record<string, unknown> & { tab: number }) => Promise<unknown>) {
  return async (a: Record<string, unknown> & { tab: number }) => {
    if (!harnessTabs.has(a.tab)) return run(a);
    const saved = await watchDownloads(DOWNLOADS);
    const result = await run(a);
    return { ...(result as object), ...(await saved()) };
  };
}

// ---------- PDF ----------
// save prints the page (its current HTML, against its own address) to a
// PDF; read gives a PDF's text: a local path, or the PDF the tab shows.
export async function pdf(opts: { tab?: number; do?: string; path?: string; out?: string; maxBytes?: number }) {
  if (opts.do === "read") {
    if (opts.path !== undefined) return pdfText(str(opts.path, "path"), opts.maxBytes);
    const tab = await resolveTab(opts.tab);
    const url = ((await listTabs()).find((t) => t.id === tab)?.url) ?? "";
    const f = (await bridge.request("fetchFile", [url], 120000)) as FilePayload;
    const file = await scratchFile("safari-pdf-", "page.pdf");
    await writeFile(file, Buffer.from(f.data, "base64"));
    return { url, ...(await pdfText(file, opts.maxBytes)) };
  }
  if (opts.do !== undefined && opts.do !== "save") throw new Error("do must be save or read");
  const tab = await resolveTab(opts.tab);
  // Reading the page is an eval, which a page that navigates meanwhile
  // answers with where it went instead: the new page is read once more.
  const read = async () => {
    // the expression builds result; an answer without it navigated
    const answer = (await relay(tab, "eval", ["({ html: document.documentElement.outerHTML, url: location.href, title: document.title })"])) as { result?: { html: string; url: string; title: string } };
    return answer.result;
  };
  const page = (await read()) ?? (await read());
  if (!page) throw new Error("the page kept navigating while it was read; save it once it settles");
  const { html, url, title } = page;
  const out = opts.out ?? await scratchFile("safari-pdf-", `${(title || "page").replace(/[/\\:\0]/g, "_").slice(0, 80)}.pdf`);
  // Its first line says what the PDF shows: on 09-29 GEICO's page printed
  // twice as its notice that the browser was too old, and the answer, a
  // path and a page count, did not say so.
  const saved = await renderPdf(html, url, out);
  const firstLine = (await pdfText(saved.path, 2000)).text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return firstLine === undefined ? saved : { ...saved, firstLine: firstLine.slice(0, 200) };
}

export async function viewport(opts: { tab: number; width: number; height: number }) {
  return bridge.request("window", [num(opts.tab, "tab"), { width: num(opts.width, "width"), height: num(opts.height, "height") }]);
}

export async function dialogs(opts: { tab?: number; do?: string; text?: string }) {
  const tab = await resolveTab(opts.tab);
  const act = opts.do ?? "read";
  if (act !== "read" && act !== "accept" && act !== "dismiss") throw new Error("do must be read, accept, or dismiss");
  const policy = act === "read" ? null : { accept: act === "accept", text: opts.text ?? null };
  return bridge.request("dialogs", [tab, policy]);
}

type Param = {
  type?: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: { type: "string" } | { type: "object"; properties: Record<string, { type: "string" | "object" }>; required: string[] };
};
export type Tool = {
  desc: string;
  params: Record<string, Param>;
  // options the tool reads that its listing leaves out, to keep the listing
  // short: a call and the CLI may still pass them (guard.ts, cli/safari.ts)
  unlisted?: Record<string, Param>;
  required?: string[];
  // reached by name over RPC, never listed to a model (the real-input tools use it)
  hidden?: true;
  run: (a: Record<string, unknown>) => Promise<unknown>;
};

export const TAB: Param = { description: 'tab id from open, or "front"' };
// close, activate, and window act only on a tab the agent opened
const OWN_TAB: Param = { type: "number", description: "tab id from open" };
export const REF: Param = { description: "snapshot ref, CSS selector, or visible text" };
// A point of the tab's viewport in CSS px, as the page's clientX and
// clientY count it: click's x and y, and real_input's (input.ts).
export const X: Param = { type: "number", description: "page x, without ref" };
export const Y: Param = { type: "number", description: "page y, without ref" };
const PAGE: Param = { type: "boolean", description: "also return the page after the action" };
const SAVE: Param = { description: "true, or an absolute path for the whole output; returns its path, size, and first 500 characters" };

// With `snapshot: true` an action also returns the page it led to, saving
// the agent a separate snapshot call.
async function withPage(result: unknown, tab: number, want: unknown): Promise<unknown> {
  if (!want) return result;
  const opened = newTabOf(result)?.id;
  const page = (await relay(opened ?? tab, "snapshot", [{}])) as Snapshot;
  return { ...(result as object), page: shieldSnapshot(page) };
}

function action(run: (a: Record<string, unknown> & { tab: number }) => Promise<unknown>) {
  return async (a: Record<string, unknown>) => {
    const tab = await resolveTab(a.tab);
    // A click, a key, or an option answers with what it did to the page.
    const result = withEffect(await run({ ...a, tab }));
    const opened = newTabOf(result);
    const from = harnessTabs.get(tab);
    if (opened && from) own(opened.id, from.owner);
    return withPage(result, tab, a.snapshot);
  };
}

// save on a read writes its whole output to a file and answers with the
// file's path, the page's address, and the output's size and first 500
// characters (save.ts). The target is checked first, so a bad one sends the
// page no request.
function saving(kind: SaveKind, run: (a: Record<string, unknown>) => Promise<unknown>) {
  return async (a: Record<string, unknown>) => {
    if (a.save === undefined || a.save === false) return run(a);
    const target = targetOf(a.save, "file");
    const tab = await resolveTab(a.tab);
    return saveOutput(kind, await run({ ...withLimit(kind, a), tab }), target, async () => (await listTabs()).find((t) => t.id === tab)?.url ?? "");
  };
}

// net and console take do: start, read (the default), or stop.
type Capture = (o: { tab?: number }) => Promise<unknown>;
function capture(ops: Record<string, Capture>, a: Record<string, unknown>): Promise<unknown> {
  const key = a.do === undefined ? "read" : String(a.do);
  if (!Object.hasOwn(ops, key)) throw new Error(`do must be ${Object.keys(ops).join(", ")}`);
  return ops[key]({ tab: a.tab as number | undefined });
}

// passwords: pair, unlock, status, and done take no tab; logins, fill,
// code, and change act on the tab's own site. Each agent session holds the
// pairing until it calls done or exits, and the pairing ends a few minutes
// after the last.
async function applePasswords(a: Record<string, unknown>): Promise<unknown> {
  switch (a.do) {
    case "pair": {
      const paired = await passwords.pair();
      return "codeShown" in paired ? { ...paired, next: 'ask the user for the 6-digit code on their Mac, then call passwords with do: "unlock" and code' } : paired;
    }
    case "unlock":
      return passwords.unlock(str(a.code, "code"));
    case "status":
      return passwords.status();
    case "done":
      return passwords.done();
    case "logins":
      return passwords.loginsFor(await resolveTab(a.tab));
    case "fill":
      return passwords.fill(await resolveTab(a.tab), a.username === undefined ? undefined : str(a.username, "username"));
    case "code":
      return passwords.fillCode(await resolveTab(a.tab), a.username === undefined ? undefined : str(a.username, "username"));
    case "change":
      return passwords.change(await resolveTab(a.tab), a.username === undefined ? undefined : str(a.username, "username"), a.site === undefined ? undefined : str(a.site, "site"));
    // The halves of change the caller runs around the helper's window
    // (fill.ts); not in the tool's enum.
    case "change-type":
      return passwords.typeChange(await resolveTab(a.tab));
    case "change-drop":
      return passwords.dropChange(await resolveTab(a.tab));
    case "setup-code": {
      const tab = await resolveTab(a.tab);
      const url = (await listTabs()).find((t) => t.id === tab)?.url;
      if (!url) throw new Error("the tab has no address to set a code up for");
      return passwords.setUpCode(new URL(url).hostname, Buffer.from((await captureTab(tab)).data, "base64"));
    }
    default:
      throw new Error("do must be pair, unlock, status, done, logins, fill, code, change, or setup-code");
  }
}

// What of a card is cut from a tab's answers once it is filled in: its
// number as sent and as pages group it (4-4-4-4, American Express's
// 4-6-5), and its security code.
function cardSecrets(card: Record<string, unknown>): string[] {
  const number = typeof card.number === "string" ? card.number : "";
  const groups = number.length === 15 ? [number.slice(0, 4), number.slice(4, 10), number.slice(10)] : (number.match(/.{1,4}/g) ?? []);
  return [number, groups.join(" "), groups.join("-"), typeof card.csc === "string" ? card.csc : ""].filter((s) => s !== "");
}

export const TOOLS: Record<string, Tool> = {
  run: {
    desc: 'Check all steps, then run in order until an error. A text wait after an action counts new lines only. Missing tab uses the latest opened or named tab. Example: [{"tool":"open","args":{"url":"https://example.com"}},{"tool":"extract"},{"tool":"close"}]',
    params: { steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] }, description: "{tool, args} objects; args as that tool takes them" } },
    required: ["steps"],
    // real: true sends the steps' click and type on a ref as real input;
    // such a run goes step by step from the caller (call.ts).
    unlisted: { real: { type: "boolean", description: "clicks and typing on refs go as real input" } },
    run: (a) => runSteps(a.steps, callTool, undefined, a.tab),
  },
  tabs: {
    desc: "List your tabs, the user's front tab, and a count of his others.",
    params: { host: { type: "string", description: "list his tabs on this site" }, all: { type: "boolean", description: "list every tab" } },
    run: async (a) => tabsView(await listTabs(), new Map([...harnessTabs].map(([id, t]) => [id, t.owner])), a),
  },
  open: {
    desc: 'Open a URL and wait until it is readable; pass its id as tab to later calls. tab "front": the user\'s front tab, when he asks about it.',
    params: { url: { type: "string", description: "address" }, background: { type: "boolean", description: "keep the current tab in front" }, group: { type: "string", description: "task name: a window of its own" }, keep: { type: "boolean", description: "leave it open for the user" }, new: { type: "boolean", description: "else your tab on its site is reused" }, snapshot: PAGE },
    unlisted: { site: { type: "boolean", description: "a repl site global's own tab" }, again: { type: "array", items: { type: "number" }, description: "a script's tabs its session opened on this address in an earlier call (repl.ts)" } },
    required: ["url"],
    run: async (a) => {
      const address = webAddress(a.url);
      const space = await spaceWindow(a.group === undefined ? undefined : str(a.group, "group"));
      const again = Array.isArray(a.again) ? new Set(a.again.map((x) => num(x, "again"))) : undefined;
      const reused = (fromModel() || again !== undefined) && a.new !== true && !a.keep && a.site !== true ? await reuseTab(address, space, again) : undefined;
      if (reused) {
        const { tab: t, was } = reused;
        const result = await withPage(withNotes(await afterWall(t, t.id)), t.id, a.snapshot);
        return beside(result, "note", `loaded in your tab ${t.id} on ${pageHost(address)}, in place of ${redactUrl(was)}; new: true opens a second tab`);
      }
      // A kept tab is the user's to close; one kept in front also shows him
      // its dialogs.
      const t = await openIn(space, address, !!a.background, !!a.background || !a.keep);
      if (a.keep) keepTab(t.id);
      else own(t.id, currentOwner());
      const result = await withPage(withNotes(await afterWall(t, t.id)), t.id, a.snapshot);
      const held = harnessTabs.get(t.id);
      if (held) held.url = t.url;
      if (a.site === true && held) held.site = true;
      const had = a.site === true || fromModel() ? undefined : await alsoOn(t.id, address);
      return had === undefined ? result : beside(result, "hint", had);
    },
  },
  // Agent windows and their tab groups, for the keeper (keeper.ts).
  space: {
    desc: "Agent windows and their tab groups, for the tab group keeper.",
    params: { op: { type: "string", description: "state, making, grouped, plain, waiting, release, gone, scratch, or raised" }, name: { type: "string", description: "the window's name" }, why: { type: "string", description: "why it stays plain" } },
    required: ["op"],
    hidden: true,
    run: spaceTool,
  },
  // held: close it only while the harness still holds it. A repl session
  // closes the tabs it opened so as it ends (repl.ts): one kept for the user
  // since is his. On 10-02 a session that ended after 30 minutes unused
  // closed the sign-up its agent had kept.
  close: {
    desc: "Close a tab you opened.",
    params: { tab: OWN_TAB },
    unlisted: { held: { type: "boolean", description: "only while the harness holds it: a kept tab stays" } },
    required: ["tab"],
    run: async (a) => (a.held === true && !harnessTabs.has(followTab(num(a.tab, "tab"))) ? { ok: true, kept: true } : closeTab(num(a.tab, "tab"))),
  },
  keep: {
    desc: "Leave a tab you opened open for the user when your turn ends: a page he asked to see, or a form waiting on his answer. Your other tabs close then.",
    params: { tab: OWN_TAB },
    required: ["tab"],
    run: async (a) => keepTab(num(a.tab, "tab")),
  },
  goto: {
    desc: "Load a URL in a tab and wait until it is readable.",
    params: { tab: TAB, url: { type: "string", description: "address to load" }, snapshot: PAGE },
    required: ["tab", "url"],
    run: action(async (a) => withNotes(await afterWall(await navigate(a.tab, str(a.url, "url")), a.tab))),
  },
  activate: { desc: "Put a tab's window in front, on screen; it stays.", params: { tab: OWN_TAB }, required: ["tab"], run: (a) => showTab(num(a.tab, "tab")) },
  snapshot: {
    desc: "Page outline with [ref]s for click, type, select, and hover, embedded frames included (refs like f3:12). Refs outlast redraws; snapshot again to see what an action changed.",
    params: {
      tab: TAB,
      query: { type: "string", description: "only lines containing this text" },
      root: { type: "string", description: "CSS selector or ref of the region" },
      maxNodes: { type: "number", description: "line limit, default 600" },
      diff: { type: "boolean", description: "only lines changed since this tab's last snapshot" },
      save: SAVE,
    },
    unlisted: { showHidden: { type: "boolean", description: "include text the page hides (the injection shield drops it)" } },
    required: ["tab"],
    run: saving("snapshot", async (a) => withNotes(await snapshot(a as { tab?: number; root?: string; query?: string; maxNodes?: number; diff?: boolean; showHidden?: boolean }))),
  },
  click: {
    desc: "Click a ref (or x/y). Reports navigated, newTab if a tab opened (yours to close), or its effect on the page.",
    params: { tab: TAB, ref: REF, x: X, y: Y, snapshot: PAGE },
    required: ["tab"],
    run: action(watched((a) => click(a as { tab: number; ref?: string; x?: number; y?: number }))),
  },
  type: {
    desc: "Set ref's text; append keeps it. Never returns text. {{code}} fills unseen codes; secret page reads from, scoped by from_selector.",
    params: { tab: TAB, ref: REF, text: { type: "string", description: "text to enter" }, append: { type: "boolean", description: "keep the existing text" }, secret: { type: "string", enum: ["sms", "page", "passwords"], description: "code source: sms, page, or passwords" }, from: { type: "number", description: "source tab for secret page" }, from_selector: { type: "string", description: "CSS selecting one email for secret page" }, snapshot: PAGE },
    required: ["tab", "ref", "text"],
    run: action((a) => type(a as { tab: number; ref: string; text: string; append?: boolean; secret?: unknown })),
  },
  press: {
    desc: "Press a key (Enter, Tab, Escape, ArrowDown) or combo (Cmd+K) on a ref or the focused element. Enter in a field submits its form.",
    params: { tab: TAB, ref: REF, key: { type: "string", description: "key name" }, snapshot: PAGE },
    required: ["tab", "key"],
    run: action(watched((a) => press(a as { tab: number; ref?: string; key: string }))),
  },
  select: {
    desc: "Choose a dropdown option by label or value; an unknown option returns the list.",
    params: { tab: TAB, ref: REF, option: { type: "string", description: "option label or value" }, snapshot: PAGE },
    required: ["tab", "ref", "option"],
    run: action((a) => select(a as { tab: number; ref: string; option: string })),
  },
  hover: {
    desc: "Hover a ref, for menus that open on mouse-over (not ones driven only by CSS :hover).",
    params: { tab: TAB, ref: REF, snapshot: PAGE },
    required: ["tab", "ref"],
    run: action((a) => hover(a as { tab: number; ref: string })),
  },
  upload: {
    desc: "Attach local files to a file input; ref may be the upload area. find lists the user's matching files to pick from; it attaches nothing.",
    params: { tab: TAB, ref: REF, paths: { type: "array", items: { type: "string" }, description: "absolute file paths" }, find: { type: "string", description: "words to search his files for" }, snapshot: PAGE },
    required: ["tab"],
    run: action((a) => upload(a as { tab: number; ref?: string; paths?: string[]; find?: string })),
  },
  history: {
    desc: "Go back, go forward, or reload.",
    params: { tab: TAB, do: { type: "string", enum: ["back", "forward", "reload"], description: "which" }, snapshot: PAGE },
    required: ["tab", "do"],
    run: action((a) => history(a as { tab: number; do: string })),
  },
  scroll: {
    desc: "Scroll the page. Rarely needed: snapshots include off-screen elements.",
    params: { tab: TAB, dx: { type: "number", description: "pixels right" }, dy: { type: "number", description: "pixels down, default 600" } },
    unlisted: { ref: REF },
    required: ["tab"],
    run: (a) => scroll(a as { tab?: number; ref?: string; dx?: number; dy?: number }),
  },
  eval: {
    desc: "Run JS in the page and return its last value as JSON; statements and await work. Sees the DOM; with page: true, also the page's script variables. To read a fact, use extract {query}: a selector you remember may be gone. Helpers: sh.q, sh.qa (shadow roots too), sh.text, sh.jsonld, sh.scripts, sh.wait. Your code must end within 30 s: split long loops across calls.",
    params: { tab: TAB, expression: { type: "string", description: "JS code" }, page: { type: "boolean", description: "run in the page's own world" }, reader: { type: "string", description: "a script saved with learn, instead" }, save: SAVE },
    required: ["tab"],
    run: saving("eval", (a) => {
      if (a.reader === undefined) {
        if (a.expression === undefined) throw new Error("eval needs expression, or reader: a script saved with learn");
        return evaluate({ tab: a.tab as number | undefined, expression: str(a.expression, "expression"), page: !!a.page });
      }
      if (a.expression !== undefined) throw new Error("give expression or reader, not both");
      return runReader(a.tab as number | undefined, str(a.reader, "reader"));
    }),
  },
  fetch: {
    desc: "Request a URL with the page's cookies; returns status, type, and text.",
    params: { tab: TAB, url: { type: "string", description: "address" }, method: { type: "string", description: "default GET" }, body: { type: "string", description: "request body" }, maxBytes: { type: "number", description: "default 50000" }, save: SAVE },
    unlisted: { headers: { type: "object", description: "request headers" }, base64: { type: "boolean", description: "body as base64" } },
    required: ["tab", "url"],
    run: saving("fetch", (a) => pageFetch(a as { tab?: number; url: string; method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number; base64?: boolean })),
  },
  download: {
    desc: "Save the file a ref's link or button downloads, a url (tab optional), or the file tab shows, into ~/Downloads; returns its path.",
    params: { tab: TAB, ref: REF, url: { type: "string", description: "instead of ref" }, out: { type: "string", description: "path; /tmp/… for files you only read" } },
    run: (a) => download(a as { tab?: number; ref?: string; url?: string; out?: string }),
  },
  dialog: {
    desc: "Alerts, confirms, and prompts come back with the action that raised them; confirm and prompt are dismissed unless you accept. read lists recent ones.",
    params: { tab: TAB, do: { type: "string", enum: ["read", "accept", "dismiss"], description: "accept or dismiss from now on" }, text: { type: "string", description: "prompt answer" } },
    required: ["tab"],
    run: (a) => dialogs(a as { tab?: number; do?: string; text?: string }),
  },
  extract: {
    desc: "Readable text of the main content (or a CSS selector), for long pages.",
    params: { tab: TAB, selector: { type: "string", description: "CSS selector to read" }, query: { type: "string", description: "only lines containing this text, from the whole page" }, maxBytes: { type: "number", description: "default 20000" }, as: { type: "string", enum: ["text", "table"], description: "table: tables and card lists as JSON rows" }, save: SAVE },
    unlisted: { strict_selector: { type: "boolean", description: "internal secret source: selector must match exactly one element" } },
    required: ["tab"],
    run: saving("extract", (a) => extract(a as { tab?: number; selector?: string; query?: string; maxBytes?: number; as?: string })),
  },
  map: {
    desc: `Read up to ${MAP_MAX_URLS} pages at once, each in a background tab that closes after: extract (default), snapshot, eval, or fetch. A failed page or a bot check is reported in its place; the rest go on.`,
    params: {
      urls: { type: "array", items: { type: "string" }, description: "addresses" },
      what: { type: "string", enum: ["extract", "snapshot", "eval", "fetch"], description: "default extract" },
      wait: { type: "object", description: 'before each read, as wait takes it: {"text":"…"}' },
      expression: { type: "string", description: "JS, for eval (or reader)" },
      selector: { type: "string", description: "for extract" },
      query: { type: "string", description: "only lines containing this" },
      as: { type: "string", enum: ["text", "table"], description: "for extract" },
      concurrency: { type: "number", description: "default 4, max 6" },
      save: { description: "true, or an absolute folder: a file per page" },
    },
    required: ["urls"],
    // The model's map call was checked (guard.ts); its opens, waits, reads,
    // and closes are the harness's, and pass each read the options map has.
    run: (a) => mapPages(a, (tool, args) => callTool(tool, args, false)),
  },
  info: { desc: "URL, title, load state, and scroll position of a tab.", params: { tab: TAB }, required: ["tab"], run: (a) => tabInfo({ tab: a.tab as number | undefined }) },
  wait: {
    desc: "Wait for text (body or title), a selector, any text (which), gone body text, url, new lines (changed), or quiet. ms: timeout, default 10000, max 30000; only ms: ends once quiet. A miss says what changed.",
    params: {
      tab: TAB,
      text: { type: "string", description: "visible text" },
      selector: { type: "string", description: "CSS selector" },
      any: { type: "array", items: { type: "string" }, description: "texts; the first shown ends it" },
      gone: { type: "string", description: "text to disappear" },
      url: { type: "string", description: "part of the URL, or /regex/" },
      quiet: { type: "boolean", description: "no change or request to its site for 0.5 s" },
      changed: { type: "boolean", description: "new lines since last look (added)" },
      ms: { type: "number", description: "timeout" },
      front: { type: "boolean", description: "keep the tab on screen meanwhile" },
    },
    required: ["tab"],
    unlisted: { look: { type: "string", description: "run's token for the look before an action" }, after: { type: "string", description: "match words new since the run's look" } },
    run: async (a) => {
      const o = { ...(a as Parameters<typeof wait>[0] & { front?: boolean }), tab: await resolveTab(a.tab) };
      return o.front ? inFront(o.tab, { tabs: listTabs, activate: activateTab }, () => wait(o)) : wait(o);
    },
  },
  data: {
    desc: "The page's own data as JSON: JSON-LD, meta, microdata, framework state (Next.js, Nuxt, Apollo). Past max, sources come as keys; pick a path into one.",
    params: { tab: TAB, pick: { type: "string", description: "e.g. next.props.pageProps" }, max: { type: "number", description: "bytes, default 20000" } },
    required: ["tab"],
    run: async (a) => pageData(await resolveTab(a.tab), { pick: a.pick === undefined ? undefined : str(a.pick, "pick"), max: a.max === undefined ? undefined : num(a.max, "max") }),
  },
  // The daemon's half of handoff (handoff.ts runs in the caller). away says
  // the caller found the user away; alerted reports how its alert went; id
  // names the handoff the caller's earlier call started or joined; until,
  // from the call that starts it, is the text that shows once they are done.
  handoff_wait: {
    desc: "Start or join the tab's handoff and wait up to ms for the user.",
    params: {
      tab: TAB,
      why: { type: "string", description: "for the notice" },
      ms: { type: "number", description: "max 110000" },
      away: { type: "boolean", description: "the user is away from the Mac" },
      alerted: { type: "string", description: "how the alert to the user's phone went" },
      id: { type: "number", description: "the handoff an earlier call returned" },
      until: { type: "string", description: "text the page shows once the user is done" },
    },
    required: ["tab", "why", "ms"],
    hidden: true,
    run: async (a) => handoffWait(await resolveTab(a.tab), str(a.why, "why"), { ms: num(a.ms, "ms"), away: a.away === true, ...(a.alerted === undefined ? {} : { alerted: str(a.alerted, "alerted") }), ...(a.id === undefined ? {} : { id: num(a.id, "id") }), ...(a.until === undefined ? {} : { until: str(a.until, "until") }) }),
  },
  net: {
    desc: "Fetch/XHR requests since page load, in all frames, each with its body's start. start clears; stop ends.",
    params: { tab: TAB, do: { type: "string", enum: ["start", "read", "stop"], description: "default read" }, url: { type: "string", description: "only those with this in their url" }, body: { description: "index or url part: its whole body" } },
    required: ["tab"],
    run: (a) => {
      if (a.body !== undefined) return netBody({ tab: a.tab as number | undefined, body: a.body, do: a.do });
      if (a.url === undefined) return capture({ start: netStart, read: netRead, stop: netStop }, a);
      if (a.do !== undefined && a.do !== "read") throw new Error("url goes with do: read");
      return netRead({ tab: a.tab as number | undefined, url: str(a.url, "url") });
    },
  },
  console: {
    desc: "Record the page's console messages: start, then read.",
    params: { tab: TAB, do: { type: "string", enum: ["start", "read"], description: "default read" } },
    required: ["tab"],
    run: (a) => capture({ start: consoleStart, read: consoleRead }, a),
  },
  cookies: {
    desc: "Cookies for the tab's site. Values are secrets: never repeat them. do: set adds one (not HttpOnly); clear wipes the site, signing the user out.",
    params: { tab: TAB, url: { type: "string", description: "another site's URL" }, do: { type: "string", enum: ["read", "set", "clear"] }, name: { type: "string", description: "to set" }, value: { type: "string", description: "to set" } },
    unlisted: { domain: { type: "string", description: "to set" }, path: { type: "string", description: "to set" }, expires: { type: "number", description: "to set, seconds since 1970" } },
    required: ["tab"],
    run: (a) => {
      if (a.do === "set") return setCookie(a as { tab?: number; url?: string; name: string; value: string });
      if (a.do === "clear") return clearSite({ tab: a.tab, url: a.url as string | undefined });
      return cookies({ tab: a.tab as number | undefined, url: a.url as string | undefined });
    },
  },
  shot: {
    desc: "Screenshot the tab's page; returns a PNG path. ref crops to it; annotate labels refs; fullPage stitches the whole page.",
    params: { tab: TAB, ref: REF, annotate: { type: "boolean", description: "draw ref labels" }, fullPage: { type: "boolean", description: "whole page" }, out: { type: "string", description: "PNG path" } },
    required: ["tab"],
    run: (a) => screenshot(a as { tab?: number; ref?: string; annotate?: boolean; fullPage?: boolean; out?: string }),
  },
  pdf: {
    desc: "save prints the page to PDF; read returns a PDF's text (path, or the tab's PDF).",
    params: { tab: TAB, do: { type: "string", enum: ["save", "read"], description: "default save" }, path: { type: "string", description: "PDF to read" }, out: { type: "string", description: "PDF path" } },
    unlisted: { maxBytes: { type: "number", description: "text limit for read" } },
    run: (a) => pdf(a as { tab?: number; do?: string; path?: string; out?: string }),
  },
  window: {
    desc: "Put a tab in its own window of this size, e.g. a phone-width page.",
    params: { tab: OWN_TAB, width: { type: "number", description: "points" }, height: { type: "number", description: "points" } },
    required: ["tab", "width", "height"],
    run: (a) => viewport(a as { tab: number; width: number; height: number }),
  },
  // For real_input's real mouse (input.ts): a point comes back as a box of
  // no size, with the top viewport's size as an element's box has it.
  locate: {
    desc: "An element's box in the top page's viewport, scrolled into view, or a point of it; with the viewport's size.",
    params: { tab: TAB, ref: REF, x: X, y: Y },
    hidden: true,
    // A tab just brought to the front may not have drawn yet; a real click
    // before it has lands on the tab shown before.
    run: async (a) => {
      const tab = await resolveTab(a.tab);
      await relay(tab, "painted", [], 3000).catch(() => {});
      if (a.ref !== undefined) return relay(tab, "locate", [str(String(a.ref), "ref")]);
      const { viewport } = (await relay(tab, "tabInfo")) as { viewport?: { w: number; h: number } };
      return { x: num(a.x, "x"), y: num(a.y, "y"), width: 0, height: 0, innerWidth: viewport?.w, innerHeight: viewport?.h };
    },
  },
  // The id a tab has now, for the tools that run in the caller (input.ts):
  // the daemon alone hears the new id a deploy gave a tab the agent still
  // calls by its old one (continuity.ts), and the answer then carries
  // replaced.
  resolve_tab: {
    desc: "The id a tab has now, for an id from before Safari gave it a new one, or \"front\".",
    params: { tab: TAB },
    required: ["tab"],
    hidden: true,
    run: async (a) => ({ tab: await resolveTab(a.tab) }),
  },
  // The site marked for real input (learn {site, real: true}; notes.ts)
  // that a tab's page is on, or null: the caller asks before it sends a
  // model's click or type on a ref (call.ts). The tabs are listed only once
  // a site is marked.
  real_site: {
    desc: "The site marked for real input that a tab's page is on, or null.",
    params: { tab: TAB },
    required: ["tab"],
    hidden: true,
    run: async (a) => {
      const marked = realInputSites();
      if (marked.size === 0) return null;
      const tab = await resolveTab(a.tab);
      return realInputSite((await listTabs()).find((t) => t.id === tab)?.url, marked) ?? null;
    },
  },
  // real_input's click on a tab not in front (input.ts) goes through
  // Safari's accessibility tree, which holds only the tab each window
  // shows. This shows a tab in its agent window and leaves the window where
  // it is. A window of the user's own keeps showing the tab he chose: the
  // answer is false, and the click takes the real mouse.
  select_tab: {
    desc: "Show a tab in its agent window, leaving the window where it is.",
    params: { tab: { type: "number", description: "tab id" } },
    required: ["tab"],
    hidden: true,
    run: async (a) => {
      const tab = num(a.tab, "tab");
      const windowId = (await listTabs()).find((t) => t.id === tab)?.windowId;
      if (windowId === undefined || !windowOwners().has(windowId)) return false;
      await bridge.request("tabs.select", [tab]);
      return true;
    },
  },
  // Nothing but the caller's news of its tabs (withTabNews adds it to this
  // empty answer), for a call that ran in the caller (call.ts).
  news: {
    desc: "The caller's news of its tabs: a new id for the tab it named, and a tab its page opened.",
    params: { tab: TAB },
    hidden: true,
    run: async () => ({}),
  },
  // The element marked for the helper's press, and its window's size
  // (pressMark in content.js).
  press_mark: {
    desc: "Mark an element for a press through Safari's accessibility tree.",
    params: { tab: TAB, ref: REF },
    required: ["tab", "ref"],
    hidden: true,
    run: async (a) => relay(await resolveTab(a.tab), "pressMark", [str(String(a.ref), "ref")]),
  },
  // Unmarked once the press has reached it, or after ms. The answer is the
  // errors the page threw from the mark on; news of a tab the press opened
  // comes in real_input's answer (input.ts).
  press_done: {
    desc: "Unmark an element once the press has reached it, or after ms; list the errors the page threw since the mark.",
    params: { tab: TAB, ref: REF, mark: { type: "string", description: "from press_mark" }, ms: { type: "number", description: "longest wait for the press" } },
    required: ["tab", "ref", "mark", "ms"],
    hidden: true,
    run: async (a) => relay(await resolveTab(a.tab), "pressDone", [str(String(a.ref), "ref"), str(a.mark, "mark"), num(a.ms, "ms")], 2000),
  },
  // One fact about an element (text, inner HTML, value, attribute, box,
  // count), for the REPL's locators.
  element: {
    desc: "One fact about the element a ref, selector, or text names.",
    params: { tab: TAB, ref: REF, what: { type: "string", enum: ["text", "innerText", "html", "value", "checked", "attr", "box", "count", "visible"], description: "which fact" }, name: { type: "string", description: "attribute name, for attr" } },
    required: ["ref", "what"],
    hidden: true,
    run: async (a) => {
      const tab = await resolveTab(a.tab);
      const res = (await relay(tab, "element", [str(String(a.ref), "ref"), str(a.what, "what"), a.name ?? null])) as { value: unknown };
      return res.value;
    },
  },
  // The page's empty address fields, filled from values keyed by
  // autocomplete token that the caller read from the user's Contacts card.
  autofill: {
    desc: "Fill the page's empty address fields from values keyed by autocomplete token.",
    params: { tab: TAB, values: { description: "autocomplete token to value" }, root: { type: "string", description: "CSS selector of the form" } },
    required: ["values"],
    hidden: true,
    run: async (a) => relay(await resolveTab(a.tab), "fillAddress", [a.values, a.root ?? null]),
  },
  // Where a login goes: the frame holding the tab's sign-in form and that
  // frame's own site. Bitwarden's fill reads it, and so does a live check.
  login_form: {
    desc: "The frame holding the tab's sign-in form, and that frame's site.",
    params: { tab: TAB },
    required: ["tab"],
    hidden: true,
    run: (a) => loginForm(num(a.tab, "tab")),
  },
  // A login the caller read from a password manager (Bitwarden), filled
  // into the frame login_form named, only while it is on the site the
  // login was saved for. It answers which fields got it, and where the page
  // went when the form submitted itself.
  login_fill: {
    desc: "Fill a login into the tab's sign-in form, only while the tab is on site.",
    params: { tab: TAB, frame: { type: "number", description: "frame from login_form" }, site: { type: "string", description: "hostname" }, username: { type: "string", description: "username" }, password: { type: "string", description: "password" } },
    required: ["tab", "site"],
    hidden: true,
    run: async (a) => {
      const tab = num(a.tab, "tab");
      keepSecret(tab, a.password);
      return filledOf(
        await bridge.tab(tab, "fillLogin", [str(a.site, "site"), a.username ?? null, a.password ?? null], 30000, a.frame === undefined ? 0 : num(a.frame, "frame")),
        [...(a.username ? ["username"] : []), ...(a.password ? ["password"] : [])],
        "login",
      );
    },
  },
  // Where a card goes: each frame of the tab holding card fields, with its
  // origin and which fields it holds, never a value (cardForm in
  // content.js). The caller sends a card only to a frame on a site it
  // trusts with one (cards.ts).
  card_form: {
    desc: "The tab's frames holding card fields, each with its origin and fields.",
    params: { tab: TAB },
    required: ["tab"],
    hidden: true,
    run: async (a) => {
      const frames = await bridge.request("probe", [num(a.tab, "tab"), "card"]);
      return Array.isArray(frames) ? frames : [];
    },
  },
  // A card the caller read from the user's keychain (cards.ts), filled
  // into one frame card_form named, only while that frame is on site. Its
  // number and security code are cut from the tab's answers from then on.
  // It answers which fields took it, and the refs of those that did not.
  card_fill: {
    desc: "Fill a card into a frame's card fields, only while the frame is on site.",
    params: { tab: TAB, frame: { type: "number", description: "frame from card_form" }, site: { type: "string", description: "hostname" }, card: { description: "number, month, year, csc, name, zip" } },
    required: ["tab", "site", "card"],
    hidden: true,
    run: async (a) => {
      const tab = num(a.tab, "tab");
      const card = a.card && typeof a.card === "object" ? Object.fromEntries(Object.entries(a.card)) : {};
      const secrets = cardSecrets(card);
      keepSecret(tab, ...secrets);
      return bridge.tab(tab, "fillCard", [str(a.site, "site"), card, secrets], 30000, a.frame === undefined ? 0 : num(a.frame, "frame"));
    },
  },
  passwords: {
    desc: "Use Apple Passwords and cards without revealing secrets; never ask for them. fill signs in, code fills 2FA, logins lists usernames. change saves then fills a strong password; shared website entries are refused; you submit. Set field passwordrules first. setup-code saves the visible authenticator QR; code confirms. Locked calls ask Touch ID and read the pairing code automatically, or prompt on the Mac if unreadable. Retry clears dismissed approval. cards lists, card-fill fills, card-save asks on the Mac. done releases access; status explains locking.",
    params: { do: { type: "string", enum: ["pair", "unlock", "status", "done", "logins", "fill", "code", "change", "setup-code", "cards", "card-save", "card-fill", "card-rm"], description: "step" }, code: { type: "string", description: "6 digits off the Mac" }, tab: TAB, username: { type: "string", description: "which login, if several" }, site: { type: "string", description: "change: login's host if not the page's" }, card: { type: "string", description: "label or last 4" } },
    // what card-save saves, when the user gave the card in chat
    unlisted: { number: { type: "string", description: "card number" }, exp: { type: "string", description: "MM/YY" }, cvc: { type: "string", description: "security code" }, name: { type: "string", description: "name on the card" }, zip: { type: "string", description: "billing ZIP" } },
    required: ["do"],
    run: applePasswords,
  },
  learn: {
    desc: "Save a site fact for later agents: a flow's steps, a control that loads late, which account owns what. Never a secret. Only site: list its notes and readers; forget: n removes one. reader + expression saves a script for eval {reader}.",
    params: {
      site: { type: "string", description: "host or address" },
      fact: { type: "string", description: "max 300 chars" },
      forget: { description: "note number, or reader name" },
      reader: { type: "string", description: "script name" },
      expression: { type: "string", description: "the reader's JS" },
      page: { type: "boolean", description: "reader runs in the page's own world" },
    },
    // true marks the site for real input, false unmarks it (notes.ts); the
    // CLI passes it as text, --real true.
    unlisted: { real: { description: "true marks the site for real input; false unmarks it" } },
    required: ["site"],
    run: learn,
  },
  replay: {
    desc: "Replay a task the user recorded with the toolbar button, in a background tab. Returns value (the last text it read) or the step that failed.",
    params: { name: { type: "string", description: "from recordings" }, tab: TAB, vars: { description: "text to enter instead, by field name or label" } },
    required: ["name"],
    // Its steps are the harness's, as map's are: looking for a target
    // again while the page draws is no loop (guard.ts).
    run: (a) => replay(a, (tool, args) => callTool(tool, args, false)),
  },
  recordings: {
    desc: "Tasks the user recorded with the toolbar button: list, show, or rm.",
    params: { do: { type: "string", enum: ["list", "show", "rm"], description: "default list" }, name: { type: "string", description: "for show and rm" } },
    run: recordingsTool,
  },
  // The elements that look like a replay step's target, each with a ref.
  lookalikes: {
    desc: "Elements that look like a fingerprint's target, with refs.",
    params: { tab: TAB, target: { description: "fingerprint" } },
    required: ["tab", "target"],
    hidden: true,
    run: async (a) => relay(await resolveTab(a.tab), "lookalikes", [a.target]),
  },
  // What the caller typed into the tab as a secret, as the code it fills in
  // for {{code}} (secret.ts), or with the real keyboard: the tab's answers
  // have it cut (redact.ts).
  keep_secret: {
    desc: "Cut texts typed as secrets from the tab's answers.",
    params: { tab: TAB, texts: { type: "array", items: { type: "string" }, description: "the secrets" } },
    required: ["tab", "texts"],
    hidden: true,
    run: async (a) => {
      if (!Array.isArray(a.texts)) throw new Error("texts must be a list");
      keepSecret(await resolveTab(a.tab), ...a.texts);
      return { ok: true };
    },
  },
};

export function inputSchema(tool: Tool) {
  return { type: "object", properties: tool.params, ...(tool.required ? { required: tool.required } : {}) };
}

type Snapshot = Shielded & { url: string; title: string; nodes: number; truncated: boolean; snapshot: string; challenge?: Challenge; guide?: string; notes?: string };
type Extract = Shielded & { url: string; title: string; text: string };

// One text form for every consumer (CLI, MCP, agent loop): trees and page
// text stay readable instead of arriving as escaped JSON strings.
export function formatResult(value: unknown): string {
  // A note or hint beside a result (guard.ts) goes on a line of its own after it.
  if (value && typeof value === "object" && !Array.isArray(value) && ("note" in value || "hint" in value)) {
    const { note, hint, ...rest }: { note?: unknown; hint?: unknown } = value;
    const body = Object.keys(rest).length === 1 && "value" in rest ? formatResult(rest.value) : formatResult(rest);
    return [body, ...(note === undefined ? [] : [`note: ${String(note)}`]), ...(hint === undefined ? [] : [`hint: ${String(hint)}`])].join("\n");
  }
  if (typeof value === "string") return value;
  const news = value && typeof value === "object" ? splitNews(value) : null;
  if (news) return `${news.line}\n${formatResult(news.rest)}`;
  if (value && typeof value === "object") {
    const v = value as Partial<Snapshot & Extract & Steps> & { page?: unknown; pages?: Page[]; tables?: unknown[] };
    const warn = v.addressedToAI ? `${addressedNote(v.addressedToAI)}\n` : "";
    if (typeof v.snapshot === "string") {
      const note = v.truncated ? "; truncated: narrow with query or root" : "";
      const check = v.challenge ? `challenge: ${JSON.stringify(v.challenge)}\n` : "";
      const notes = `${v.guide ? `guide: ${v.guide}\n` : ""}${v.notes ? `${v.notes}\n` : ""}`;
      return `# ${v.title} — ${v.url} (${v.nodes} nodes${note})\n${check}${warn}${notes}${v.snapshot}`;
    }
    if (typeof v.text === "string") {
      if (typeof v.title === "string") return `# ${v.title} — ${v.url}\n${warn}\n${v.text}`;
      // fetch and pdf read: their other fields, then the text as it is
      const { text, ...rest } = v;
      return `${JSON.stringify(rest)}\n\n${text}`;
    }
    if (v.page !== undefined) {
      const { page, ...rest } = v;
      return `${JSON.stringify(rest)}\n\n${formatResult(page)}`;
    }
    if (Array.isArray(v.steps)) {
      const lines = v.steps.map((s) => `[${s.step} ${s.tool}] ${s.error === undefined ? formatResult(s.value) : `error: ${s.error}`}`);
      if (v.notRun) lines.push(`stopped: the ${v.notRun} other step${v.notRun === 1 ? "" : "s"} did not run`);
      return lines.join("\n");
    }
    // map: each page under its title and address, as its read prints alone;
    // a read that prints its own title (extract, snapshot) is not given it twice
    if (Array.isArray(v.pages)) {
      return v.pages.map((p) => {
        const notes = [`${p.ms} ms`, ...(p.challenge ? [`challenge: ${JSON.stringify(p.challenge)}`] : []), ...(p.closeError ? [`not closed: ${p.closeError}`] : [])];
        const titled = p.ok && !!p.value && typeof p.value === "object" && "title" in p.value;
        return `## ${p.title && !titled ? `${p.title} — ` : ""}${p.url} (${notes.join("; ")})\n${p.ok ? formatResult(p.value) : `error: ${p.error}`}`;
      }).join("\n\n");
    }
    // extract as table: each table as one line of JSON
    if (Array.isArray(v.tables)) {
      const note = v.truncated ? "\n…truncated: narrow with selector or query" : "";
      return `# ${v.title} — ${v.url}\n\n${v.tables.map((t) => JSON.stringify(t)).join("\n")}${note}`;
    }
  }
  return JSON.stringify(value, null, 1);
}

// A model's call (its own, or a step of its run) is checked and watched
// (guard.ts); an acting call waits its turn on the tab (lanes.ts). Every
// answer has the secrets in its addresses cut (redact.ts). A call with news
// false leaves its caller's news (continuity.ts) to a later call, as
// real_input's steps do (input.ts).
export async function callTool(name: string, args: Record<string, unknown> = {}, model = fromModel(), news = true): Promise<unknown> {
  const call = checkCall(TOOLS, name, args, model);
  try {
    return redacted(await guard(call, model, () => inLane(call.tool, call.args, resolveTab, () => (news ? withTabNews(call.args.tab, () => revived(call.tool, call.args)) : revived(call.tool, call.args)))));
  } catch (e) {
    throw await unopened(goneWhy(e, call.args.tab));
  }
}

// The extension knows only that a tab is gone; one the harness closed
// itself is named with why, when, and what it showed (closedTabs).
function goneWhy(e: unknown, tab: unknown): unknown {
  const closed = e instanceof Error && e.message.startsWith("that tab is gone") ? closedTabs.get(followTab(Number(tab))) : undefined;
  if (!closed) return e;
  const showed = closed.url ? ` (it showed ${redactUrl(closed.url)})` : "";
  return new Error(`that tab is gone: tab ${tab} was closed ${closed.why} at ${localTime(new Date(closed.at))}${showed}; open it again`);
}

// A page an agent opened that stops answering (a dialog holds it, or it is
// stuck loading) is loaded again and the read asked once more, as the error
// tells the agent to do: in the car and insurance searches of late
// September, agents spent 31 turns doing it by hand. Only a page no action
// has changed since it loaded is loaded again, since that undoes the
// action; an eval counts as a read here, as nearly every one is.
const ASKED_AGAIN: Record<string, true> = { snapshot: true, extract: true, eval: true, data: true, info: true, wait: true, fetch: true };
const HELD = /did not answer.*; reload it with goto and retry$/;

async function revived(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const tab = followTab(Number(args.tab));
  try {
    const result = await TOOLS[tool].run(args);
    // A goto, or an action that led to another page, leaves a fresh page.
    const mine = harnessTabs.get(tab);
    const went = navigatedOf(result)?.url;
    if (mine && went !== undefined) mine.url = went;
    if (mine && tool !== "eval" && acts(tool, args)) mine.acted = tool === "goto" || went !== undefined ? undefined : true;
    return result;
  } catch (e) {
    const mine = harnessTabs.get(tab);
    if (!Object.hasOwn(ASKED_AGAIN, tool) || !mine || mine.acted || !(e instanceof Error) || !HELD.test(e.message)) throw e;
    const url = (await listTabs()).find((t) => t.id === tab)?.url;
    if (!url?.startsWith("http")) throw e;
    await navigate(tab, url);
    return beside(await TOOLS[tool].run(args), "note", "the page did not answer, so it was loaded again first");
  }
}

type Step = { step: number; tool: string; value?: unknown; error?: string };
type Steps = { steps: Step[]; notRun: number };

function stepOf(step: unknown): { tool: string; args: Record<string, unknown> } {
  if (!step || typeof step !== "object" || !("tool" in step) || typeof step.tool !== "string") throw new Error('each step needs a tool: {"tool": "open", "args": {…}}');
  const args = "args" in step && step.args && typeof step.args === "object" ? step.args : {};
  return { tool: step.tool, args: args as Record<string, unknown> };
}

// close and keep steps look after the run's tabs, so they still run after a
// failure: a failed run must not leave its tab behind, nor close one the
// user is to keep (on 09-29 a close that failed skipped the keep after it).
const TIDY: Record<string, true> = { close: true, keep: true };

// run: several tools in one call, so an agent can open, act, read, and close
// without a model turn between steps. A step without tab uses the tab the
// run's latest open made, else the last tab a step named, else the run's
// own tab, if the run has not closed it: on 09-29 an eval after a goto
// failed for want of one, and on 10-04 three runs that named their tab
// once, beside steps, failed on their first step for want of it. A step
// that names a tab the run did not open says so: a run opened CarMax as tab
// 723049, read tab 718331 (his Gmail), and the agent reported Gmail's text
// as CarMax's, three times. A step that names a tab the run closed fails
// with the step that closed it. Later steps usually depend on earlier ones,
// so the first error stops the run, but for close and keep. call runs one
// step: here, the daemon's own tools; in a caller (call.ts), any tool,
// wherever it runs, but for repl, which runs in its own session
// (mcp-tools.ts, safari repl): on 09-29 an agent put repl in a run twice and
// was offered replay.
export async function runSteps(steps: unknown, call: (tool: string, args: Record<string, unknown>) => Promise<unknown> = callTool, check: (tool: string, args: Record<string, unknown>) => Checked = (t, a) => checkStep(TOOLS, t, a), tab?: unknown): Promise<Steps> {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('run needs steps: [{"tool": "open", "args": {"url": "…"}}, …]');
  // Catch a bad later step before an earlier one submits a form (09-30).
  const planned: { tool: string; args: Record<string, unknown>; checked: Checked }[] = [];
  for (const [i, raw] of steps.entries()) {
    let tool = "?";
    try {
      const step = stepOf(raw);
      tool = step.tool;
      if (tool.toLowerCase() === "repl") throw new Error("repl is its own call, not a run step: call repl {code} (in a shell, safari repl) apart from the run");
      planned.push({ ...step, checked: check(tool, step.args) });
    } catch (e) {
      return { steps: [{ step: i + 1, tool, error: e instanceof Error ? e.message : String(e) }], notRun: steps.length - 1 };
    }
  }
  const done: Step[] = [];
  const opened: number[] = [];
  // each tab a close step shut, with that step's number
  const closed = new Map<string, number>();
  let named = tab;
  let failed = false;
  for (const [i, step] of planned.entries()) {
    let tool = "?";
    try {
      tool = step.tool;
      if (failed && !Object.hasOwn(TIDY, tool)) continue;
      named = step.args.tab ?? named;
      const live = (t: unknown) => t !== undefined && !closed.has(String(t));
      const tab = step.args.tab ?? opened.findLast(live) ?? (live(named) ? named : undefined);
      const shut = step.args.tab === undefined ? undefined : closed.get(String(step.args.tab));
      if (shut !== undefined) throw new Error(`tab ${tab} was closed in step ${shut}; name a tab still open, or open the page again`);
      const next = planned[i + 1];
      const acting = acts(step.checked.tool, step.checked.args) || step.checked.tool === "real_input";
      if (acting && next?.checked.tool === "wait" && (next.checked.args.text !== undefined || next.checked.args.any !== undefined) && String(next.args.tab ?? tab) === String(tab)) {
        // Look before the action, in every frame: a wait on EOIR's old
        // heading otherwise claimed Submit had worked (09-30).
        const token = crypto.randomUUID();
        await call("wait", { tab, look: token });
        next.args = { ...next.args, after: token };
      }
      let value = await call(tool, tab === undefined ? step.args : { ...step.args, tab });
      if (step.checked.tool === "wait" && step.args.after !== undefined && value && typeof value === "object" && "found" in value && value.found === false) {
        const meanwhile = "meanwhile" in value && Array.isArray(value.meanwhile) ? value.meanwhile.join("; ") : "";
        throw new Error(`no new matching text appeared after the preceding action${meanwhile ? `; ${meanwhile}` : ""}`);
      }
      if (tool === "open" && value && typeof value === "object" && "id" in value && typeof value.id === "number") opened.push(value.id);
      if (tool === "close" && tab !== undefined) closed.set(String(tab), i + 1);
      if (step.args.tab !== undefined && opened.length > 0 && !Object.hasOwn(TIDY, tool) && !opened.some((id) => String(id) === String(step.args.tab))) value = beside(value, "note", `tab ${step.args.tab} is not one this run opened (${opened.join(", ")})`);
      done.push({ step: i + 1, tool, value });
    } catch (e) {
      if (failed && !Object.hasOwn(TIDY, tool)) continue;
      done.push({ step: i + 1, tool, error: e instanceof Error ? e.message : String(e) });
      failed = true;
    }
  }
  return { steps: done, notRun: steps.length - done.length };
}
