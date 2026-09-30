// Tool registry: the aside-style verbs, implemented over the bridge.
// Every consumer (CLI, MCP server, agent loop, CDP shim) calls these.

import { bridge } from "./bridge.ts";
import { loginForm, passwords } from "./passwords.ts";
import { challengeOf, type Challenge } from "./challenge.ts";
import { followTab, queuePopup, recordRenumbered, recordReplaced, splitNews, withTabNews } from "./continuity.ts";
import { note } from "./journal.ts";
import { pageData } from "./pagedata.ts";
import { frontApp, inFront, notify, raiseSafari, SAFARI, show } from "./front.ts";
import { renderPdf, pdfText } from "./pdf.ts";
import { findFiles } from "./finder.ts";
import { watchDownloads } from "./downloads.ts";
import { asExpression } from "./statements.ts";
import { unanswered } from "./unanswered.ts";
import { spaceNote, spaceTool, spaceWindow, windowOwners, type SpaceNote } from "./spaces.ts";
import { currentOwner, watchOwner } from "./owner.ts";
import { filledOf, navigatedOf } from "./navigated.ts";
import { addressedNote, shieldExtract, shieldSnapshot, type Shielded } from "./injection.ts";
import { firstNotes, learn, readerFor } from "./notes.ts";
import { saveOutput, targetOf, withLimit, type SaveKind } from "./save.ts";
import { mapPages, MAP_MAX_URLS, type Page } from "./map.ts";
import { beside, checkCall, fromModel, guard } from "./guard.ts";
import { acts, inLane } from "./lanes.ts";
import { urlMatch, WAIT_NEEDS, waitsOnPage, withEffect } from "./receipt.ts";
import { redacted } from "./redact.ts";
import { tabsView } from "./tabs-view.ts";
import { recordingsTool } from "./recordings.ts";
import { replay } from "./replay.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile, mkdtemp, mkdir, readdir } from "node:fs/promises";
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
  return (await bridge.request("tabs.list")) as TabInfo[];
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

// Every tab opens in a window of the calling agent's own (spaces.ts), which
// the result names. The extension answers an owned tab's dialogs, keeps it
// running while hidden, and lets the daemon close it (background.js).
export async function openTab(url: string, background = false, group?: string, owned = background): Promise<TabInfo & { space: SpaceNote }> {
  const space = await spaceWindow(group);
  const t = (await bridge.request("tabs.open", [str(url, "url"), background, space.window, owned])) as TabInfo;
  return { ...t, space: spaceNote(space) };
}

// A native sheet on the tab (a sign-in or permission prompt) or an
// off-screen window can keep Safari from closing it; the extension tries
// for 15 s and says so. This limit is only for an extension that never
// answers.
export async function closeTab(tab: number): Promise<unknown> {
  const id = followTab(num(tab, "tab"));
  const res = await bridge.request("tabs.close", [id], 20000);
  forget(id);
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
// acted: an action has changed the page since it loaded (revived).
type HarnessTab = { owner?: number; used: number; orphan?: true; closing?: true; acted?: true };
const harnessTabs = new Map<number, HarnessTab>();
const watches = new Map<number, () => void>();
let tabsFile: string | undefined;
let sweeper: Timer | undefined;

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
  harnessTabs.set(tab, { owner, used: Date.now() });
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
// it is done with its tabs, as if it had left them for IDLE_MS. Before,
// they stayed open until it exited or left them for 20 minutes; his order
// of 09-28 is to close a tab once it has served its purpose.
export function endTurn(owner: number): void {
  for (const t of harnessTabs.values()) if (t.owner === owner) t.used = 0;
  void sweep();
}

// A tab the user is to see or answer outlives its agent's turn and its
// exit, as one opened with keep does. The extension still answers its
// dialogs, so the agent can go on in it once he has answered.
export function keepTab(tab: number): { ok: true } {
  forget(followTab(tab));
  return { ok: true };
}

async function sweep() {
  // Timer work never starts Safari: once the user quits it, only a caller's
  // own call may (socket in bridge.ts). The next sweep tries again.
  if (!bridge.connected) return;
  const idle = Date.now() - IDLE_MS;
  await Promise.all([...harnessTabs].filter(([, t]) => !t.closing && (t.orphan || t.used < idle)).map(async ([tab, t]) => {
    t.closing = true;
    try {
      const res = (await bridge.request("tabs.close", [tab, t.orphan ? "owned" : "idle"], 20000)) as { front?: true } | null;
      if (res?.front) t.used = Date.now();
      else forget(tab);
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
// is (action); one the user's own tabs open stays his.
bridge.onTab = (e) => {
  if (e.kind === "replaced") {
    recordReplaced(e.from, e.to);
    if (moveKept(e.from, e.to)) save();
    note("replaced", { from: e.from, to: e.to });
    return;
  }
  if (e.kind === "renumbered") {
    recordRenumbered(e.tabs);
    // The reloaded extension no longer knows which tabs the harness owns
    // (it lists them in session storage, which Safari empties), so it would
    // refuse their closes at a turn's end, an exit, or 20 idle minutes,
    // answer none of their dialogs, log none of their requests, and leave
    // their popups the user's. Telling it how to answer a tab's dialogs
    // owns the tab again (background.js), with the answer a tab opens
    // with. A tab reported again, as the extension connects again, has
    // moved here already and keeps what its agent has set since.
    let owned = false;
    for (const [from, to] of e.tabs) {
      if (!moveKept(from, to)) continue;
      owned = true;
      void bridge.request("dialogs", [to, { accept: false, text: null }]).catch(() => {});
    }
    if (owned) save();
    note("renumbered", { tabs: Object.fromEntries(e.tabs) });
    return;
  }
  const from = harnessTabs.get(e.opener);
  if (!from) return;
  own(e.tab, from.owner);
  if (from.owner !== undefined) queuePopup(from.owner, { tab: e.tab, url: e.url });
  note("popup", { tab: e.tab, opener: e.opener });
};

// Says whether the tab is one the harness opened.
function moveKept(from: number, to: number): boolean {
  move(lastSnapshot, from, to);
  move(handoffs, from, to);
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
  return (await bridge.request("tabs.navigate", [num(tab, "tab"), str(url, "url")])) as TabInfo;
}

export async function activateTab(tab: number): Promise<unknown> {
  return bridge.request("tabs.activate", [num(tab, "tab")]);
}

// The tab shows in its window, and the window and Safari come to the front:
// the user sees the tab.
async function showTab(tab: number): Promise<unknown> {
  const res = await activateTab(tab);
  await raiseSafari();
  return res;
}

// open, goto, snapshot, and a missed wait say when the tab shows a bot check
// (challenge.ts): the agent hands it to the user with handoff. A result still
// coming has its probe sent beside it.
async function withChallenge<T extends object>(result: T | Promise<T>, tab: number): Promise<T> {
  const [r, challenge] = await Promise.all([result, challengeOf(tab)]);
  return challenge ? { ...r, challenge } : r;
}

// open, goto, and snapshot also carry what agents have learned about the
// site, on the first result on it for each agent (notes.ts).
function withNotes<T extends object>(result: T): T {
  const notes = firstNotes("url" in result ? result.url : undefined);
  return notes ? { ...result, notes } : result;
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
  const snap = shieldSnapshot(await withChallenge(relay(tab, "snapshot", [{ root: opts.root, query: opts.query, maxNodes: opts.maxNodes, showHidden: !!opts.showHidden }]) as Promise<Snapshot>, tab));
  if (opts.root !== undefined || opts.query !== undefined) return snap;
  const before = lastSnapshot.get(tab);
  lastSnapshot.set(tab, snap.snapshot);
  if (!opts.diff || before === undefined) return snap;
  return { ...snap, snapshot: lineDiff(before.split("\n"), snap.snapshot.split("\n")) || "(no change)" };
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
  const answer = await relay(tab, "type", [opts.ref, text, { append: !!opts.append, secret: opts.secret === true }]);
  if (!answer || typeof answer !== "object" || !("ok" in answer)) return answer;
  return { ...Object.fromEntries(Object.entries(answer).filter(([k]) => k !== "value")), typed: `${text.length} chars` };
}

export async function press(opts: { tab?: number; ref?: number | string; key: string }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "press", [opts.ref ?? null, str(opts.key, "key")]);
}

export async function scroll(opts: { tab?: number; dx?: number; dy?: number }) {
  const tab = await resolveTab(opts.tab);
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
// nothing; the agent calls again with the path it picked.
export async function upload(opts: { tab?: number; ref?: number | string; paths?: string[]; find?: string }) {
  const tab = await resolveTab(opts.tab);
  if (opts.find !== undefined) return findFiles(str(opts.find, "find"));
  if (!Array.isArray(opts.paths) || opts.paths.length === 0) throw new Error("upload needs paths: [\"/abs/file\", ...], or find: \"words\" to look for the file");
  const files = await Promise.all(opts.paths.map(async (p) => {
    const f = Bun.file(str(p, "path"));
    if (!(await f.exists())) throw new Error(`no such file: ${p}`);
    return { name: basename(p), type: f.type, data: Buffer.from(await f.arrayBuffer()).toString("base64") };
  }));
  return relay(tab, "upload", [opts.ref ?? null, files], 60000);
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
  const inPage = () => bridge.request("evalPage", [tab, code, Number(frame)], 30000).catch((e: unknown) => {
    throw e instanceof Error && EVAL_REFUSED.test(e.message) ? new Error(EVAL_BLOCKED) : e;
  });
  const answer = opts.page ? inPage() : bridge.tab(tab, "eval", [code], 30000, Number(frame)).catch((e: unknown) => {
    if (e instanceof Error && e.message === EVAL_BLOCKED) return inPage();
    throw e;
  });
  return answer.catch(async (e: unknown) => { throw await unanswered(e); });
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
  const page = (await relay(tab, "extract", [{ selector: opts.selector, query: opts.query, maxBytes: opts.maxBytes, as: opts.as }])) as Extract | { tables: unknown[] };
  // as: "table" answers rows, not text
  return "text" in page ? shieldExtract(page) : page;
}

export async function tabInfo(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "tabInfo");
}

// Waits until the page shows what the wait asks for (ms is then the
// timeout, max 30000): a selector or text, the first of several texts (any;
// which says which), text gone, an address (url: a part of it, or
// /regex/), or a page that made no change for 500 ms with no request to its
// own site still out (quiet). Text matches case and spacing aside. The page
// reports the moment it sees it (waitFor in content.js); the time limit is
// kept here, because Safari stops a content script's timers in a hidden
// tab. The answer at the limit does not wait for the page: a page still
// loading, or too busy to answer, would otherwise hold the call past its
// limit. A miss says where the tab is: often a redirect (signed out, sent
// to the home page). A wait with only ms ends once the page is quiet, ms at
// most: it slept all of it, and in the car and insurance searches of late
// September such sleeps held agents about 9 minutes. A page that cannot be
// watched still gets its ms, as a sleep did. On screen (front), it holds
// the tab there all of ms: what it waits on is an animation, which a quiet
// page does not rule out.
export async function wait(opts: { tab?: number; ms?: number; selector?: string; text?: string; any?: string[]; gone?: string; url?: string; quiet?: boolean; front?: boolean }) {
  const tab = await resolveTab(opts.tab);
  const named = waitsOnPage(opts);
  if (!named && opts.ms === undefined) throw new Error(WAIT_NEEDS);
  const limit = Math.min(opts.ms === undefined ? 10000 : num(opts.ms, "ms"), 30000);
  if (!named && opts.front) {
    await Bun.sleep(limit);
    return { ok: true };
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
  const spec = { text: opts.text, any: opts.any, gone: opts.gone, url: opts.url, quiet: opts.quiet === true || !named };
  const seen = relay(tab, "wait", [opts.selector ?? null, spec], limit + 5000) as Promise<{ found: boolean; which?: string }>;
  // A page that answers only after the limit (it navigated, and the new page
  // began the wait again) still holds a wait: end that one too.
  seen.catch(stop);
  const timeUp = Promise.withResolvers<{ found: boolean; which?: string }>();
  const timer = setTimeout(() => { stop(); timeUp.resolve({ found: false }); }, limit);
  try {
    if (!named) {
      await Promise.race([seen.catch(() => timeUp.promise), timeUp.promise]);
      return { ok: true, waitedMs: Date.now() - start };
    }
    const { found, which } = await Promise.race([seen, timeUp.promise]);
    const waitedMs = Date.now() - start;
    if (found) return which === undefined ? { ok: true, found, waitedMs } : { ok: true, found, waitedMs, which };
    const now = (await listTabs()).find((t) => t.id === tab);
    return withChallenge({ ok: true, found, waitedMs, url: now?.url, title: now?.title }, tab);
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
// check seen, the page has moved on: if they are still on the tab, they get
// back the tab and app they had in front. A block ends a handoff (no one can
// clear it), and so do 5 minutes with no call waiting. Once over, it answers
// only the calls that carry its id (the caller's own later slices, which may
// come after it ends), so they do not start another.
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

async function watchHandoff(tab: number, why: string, h: Handoff) {
  const gone = new Error("that tab is gone: it was closed; find it with tabs");
  try {
    const [tabs, initial] = await Promise.all([listTabs(), challengeOf(tab)]);
    const first = tabs.find((t) => t.id === tab);
    if (!first) throw gone;
    if (initial?.where === "block") throw new Error(blocked(initial));
    h.now = { url: first.url, title: first.title, ...(initial ? { challenge: initial } : {}) };
    const giveBack = await show(tab, { tabs: listTabs, activate: activateTab });
    notify(why);
    h.begun.resolve();
    // the first check the page answered with; null until it answers
    let seen = initial;
    while (h.waiting > 0 || Date.now() - h.calledAt < HANDOFF_IDLE_MS) {
      await Bun.sleep(1000);
      const [tabs, challenge] = await Promise.all([listTabs(), challengeOf(tab)]);
      // Safari may have swapped the tab for another (continuity.ts)
      tab = followTab(tab);
      const now = tabs.find((t) => t.id === tab);
      if (!now) throw gone;
      if (challenge?.where === "block") throw new Error(blocked(challenge));
      if (seen === null) seen = challenge;
      h.now = { url: now.url, title: now.title, ...(challenge ? { challenge } : {}) };
      if (challenge === undefined && (seen !== undefined || now.url !== first.url)) {
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
async function handoffWait(tab: number, why: string, o: { ms: number; away: boolean; alerted?: string; id?: number }) {
  let h = handoffs.get(tab);
  if (h && (h.done || h.error !== undefined) && h.id !== o.id) h = undefined;
  const joined = h !== undefined;
  if (!h) {
    for (const [t, x] of handoffs) if (Date.now() - x.calledAt > HANDOFF_IDLE_MS && x.waiting === 0 && (x.done || x.error !== undefined)) handoffs.delete(t);
    h = { id: ++handoffCount, start: Date.now(), begun: Promise.withResolvers(), over: Promise.withResolvers(), now: {}, done: false, waiting: 0, calledAt: Date.now() };
    handoffs.set(tab, h);
    void watchHandoff(tab, why, h);
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

export async function netRead(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "netRead");
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

function nameOf(f: FilePayload, fallbackUrl: string): string {
  const fromHeader = f.disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(f.disposition)?.[1] : undefined;
  let name = f.name || (fromHeader ? decodeURIComponent(fromHeader) : "");
  if (!name) {
    try { name = decodeURIComponent(basename(new URL(f.url ?? fallbackUrl).pathname)); } catch { name = ""; }
  }
  name = name.replace(/[/\\:\0]/g, "_").replace(/^\.+/, "").trim();
  return name || "download";
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

async function saveFile(f: FilePayload, url: string, out?: string) {
  const path = out ?? await freePath(DOWNLOADS, nameOf(f, url));
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
// fetch when the page may not read that site), or the file a ref's link or
// button downloads. Saved in ~/Downloads unless out says where.
export async function download(opts: { tab?: number; ref?: string; url?: string; out?: string }) {
  const tab = await resolveTab(opts.tab);
  if (opts.url !== undefined) {
    const url = str(opts.url, "url");
    // A page that navigates while it fetches answers where it went instead.
    const inPage = await relay(tab, "fetchFile", [url, ""], 120000).catch(() => null);
    const f = isFile(inPage) ? inPage : (await bridge.request("fetchFile", [url], 120000)) as FilePayload;
    return saveFile(f, url, opts.out);
  }
  if (opts.ref === undefined) throw new Error("download needs ref or url");
  const ref = String(opts.ref);
  // A file the server sends after the click is saved by Safari itself, never
  // handed to the page; on a tab the harness opened it is found in
  // ~/Downloads instead (downloads.ts).
  const saved = harnessTabs.has(tab) ? await watchDownloads(DOWNLOADS) : null;
  const stop = setTimeout(() => { relay(tab, "downloadStop", [ref]).catch(() => {}); }, 10000);
  try {
    const f = await relay(tab, "download", [ref], 120000);
    return saveFile(isFile(f) ? f : await fileAfterClick(f), "", opts.out);
  } catch (e) {
    const got = saved ? await saved() : {};
    if (!got.downloaded && !got.downloading) throw e;
    return got;
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
  return renderPdf(html, url, out);
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
const SAVE: Param = { description: "true, or an absolute file path: write the whole output there; returns its path, size, and first 500 characters" };

// With `snapshot: true` an action also returns the page it led to, saving
// the agent a separate snapshot call.
async function withPage(result: unknown, tab: number, want: unknown): Promise<unknown> {
  if (!want) return result;
  const opened = (result as { newTab?: { id: number } } | null)?.newTab?.id;
  const page = (await relay(opened ?? tab, "snapshot", [{}])) as Snapshot;
  return { ...(result as object), page: shieldSnapshot(page) };
}

function action(run: (a: Record<string, unknown> & { tab: number }) => Promise<unknown>) {
  return async (a: Record<string, unknown>) => {
    const tab = await resolveTab(a.tab);
    // A click, a key, or an option answers with what it did to the page.
    const result = withEffect(await run({ ...a, tab }));
    const opened = (result as { newTab?: { id: number } } | null)?.newTab?.id;
    const from = harnessTabs.get(tab);
    if (opened !== undefined && from) own(opened, from.owner);
    return withPage(result, tab, a.snapshot);
  };
}

// save on a read writes its whole output to a file and answers with the
// file's path, size, and first 500 characters (save.ts). The target is
// checked first, so a bad one sends the page no request.
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

export const TOOLS: Record<string, Tool> = {
  run: {
    desc: 'Run several of these tools in one call, in order, stopping at the first error; each call saved is a model turn saved. A step without tab uses the tab an earlier open step made. Open, read, and close in one call: [{"tool":"open","args":{"url":"https://example.com","background":true}},{"tool":"extract"},{"tool":"close"}]',
    params: { steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] }, description: "{tool, args} objects; args as that tool takes them" } },
    required: ["steps"],
    run: (a) => runSteps(a.steps),
  },
  tabs: {
    desc: "List your tabs, the user's front tab, and a count of his others.",
    params: { host: { type: "string", description: "list his tabs on this site" }, all: { type: "boolean", description: "list every tab" } },
    run: async (a) => tabsView(await listTabs(), new Map([...harnessTabs].map(([id, t]) => [id, t.owner])), a),
  },
  open: {
    desc: 'Open a URL in a new tab and wait until it is readable. Returns the tab id: pass it as tab to every later call. tab "front" is the user\'s own front tab, for when he asks about his page.',
    params: { url: { type: "string", description: "address to open" }, background: { type: "boolean", description: "keep the user's current tab in front" }, group: { type: "string", description: "task name: its tabs get a window of their own" }, keep: { type: "boolean", description: "leave it open for the user" }, snapshot: PAGE },
    required: ["url"],
    run: async (a) => {
      // A kept tab is the user's to close; one kept in front also shows him
      // its dialogs.
      const t = await openTab(str(a.url, "url"), !!a.background, a.group === undefined ? undefined : str(a.group, "group"), !!a.background || !a.keep);
      if (!a.keep) own(t.id, currentOwner());
      return withPage(withNotes(await withChallenge(t, t.id)), t.id, a.snapshot);
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
  close: { desc: "Close a tab you opened.", params: { tab: OWN_TAB }, required: ["tab"], run: (a) => closeTab(num(a.tab, "tab")) },
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
    run: action(async (a) => withNotes(await withChallenge(await navigate(a.tab, str(a.url, "url")), a.tab))),
  },
  activate: { desc: "Bring a tab, its window, and Safari to the front.", params: { tab: OWN_TAB }, required: ["tab"], run: (a) => showTab(num(a.tab, "tab")) },
  snapshot: {
    desc: "Page outline with [ref]s for click, type, select, and hover, embedded frames included (refs like f3:12). Refs outlast redraws; snapshot again to see what an action changed.",
    params: {
      tab: TAB,
      query: { type: "string", description: "only lines containing this text" },
      root: { type: "string", description: "CSS selector of the region to read" },
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
    desc: "Set a field's text by ref; replaces it unless append. Never returns the text. {{code}} in text types a code texted to the user, unseen; with secret \"page\", the code tab from shows.",
    params: { tab: TAB, ref: REF, text: { type: "string", description: "text to enter" }, append: { type: "boolean", description: "keep the existing text" }, secret: { type: "string", enum: ["sms", "page", "passwords"], description: "code source: his texts, tab from (an opened email), or Apple Passwords" }, from: { type: "number", description: "tab showing the code, for secret page" }, snapshot: PAGE },
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
    desc: "Attach local files to a file input. ref may be the upload area; omit it when the page has one file input. find lists the user's matching files to pick from; it attaches nothing.",
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
    required: ["tab"],
    run: (a) => scroll(a as { tab?: number; dx?: number; dy?: number }),
  },
  eval: {
    desc: "Run JS in the page and return its last value as JSON; statements and await work. Sees the DOM; with page: true, also the page's script variables. To read a fact, extract with query: a selector you remember may be gone. Helpers: sh.q, sh.qa (shadow roots too), sh.text, sh.jsonld, sh.wait. The page must answer within 30 s: split long loops across calls.",
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
    desc: "Save the file a ref's link or button downloads, or a url, into ~/Downloads; returns its path.",
    params: { tab: TAB, ref: REF, url: { type: "string", description: "instead of ref" }, out: { type: "string", description: "path to write" } },
    required: ["tab"],
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
    desc: "Wait until the page shows text or a CSS selector, one of any (which), no more gone text, a url, or goes quiet; ms is the timeout (default 10000, max 30000). With only ms it is no sleep: it ends once the page goes quiet, ms at most. Text ignores case and spaces. Returns found.",
    params: {
      tab: TAB,
      text: { type: "string", description: "visible text" },
      selector: { type: "string", description: "CSS selector" },
      any: { type: "array", items: { type: "string" }, description: "texts; the first shown ends it" },
      gone: { type: "string", description: "text to disappear" },
      url: { type: "string", description: "part of the URL, or /regex/" },
      quiet: { type: "boolean", description: "no change, and no request to its site, for 0.5 s" },
      ms: { type: "number", description: "timeout" },
      front: { type: "boolean", description: "keep the tab on screen meanwhile" },
    },
    required: ["tab"],
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
  // names the handoff the caller's earlier call started or joined.
  handoff_wait: {
    desc: "Start or join the tab's handoff and wait up to ms for the user.",
    params: {
      tab: TAB,
      why: { type: "string", description: "for the notice" },
      ms: { type: "number", description: "max 110000" },
      away: { type: "boolean", description: "the user is away from the Mac" },
      alerted: { type: "string", description: "how the alert to the user's phone went" },
      id: { type: "number", description: "the handoff an earlier call returned" },
    },
    required: ["tab", "why", "ms"],
    hidden: true,
    run: async (a) => handoffWait(await resolveTab(a.tab), str(a.why, "why"), { ms: num(a.ms, "ms"), away: a.away === true, ...(a.alerted === undefined ? {} : { alerted: str(a.alerted, "alerted") }), ...(a.id === undefined ? {} : { id: num(a.id, "id") }) }),
  },
  net: {
    desc: "The page's fetch/XHR requests since it began loading, in every frame: url, method, status, time, and the start of a text or JSON body. start clears the list; stop ends it.",
    params: { tab: TAB, do: { type: "string", enum: ["start", "read", "stop"], description: "default read" } },
    required: ["tab"],
    run: (a) => capture({ start: netStart, read: netRead, stop: netStop }, a),
  },
  console: {
    desc: "Record the page's console messages: start, then read.",
    params: { tab: TAB, do: { type: "string", enum: ["start", "read"], description: "default read" } },
    required: ["tab"],
    run: (a) => capture({ start: consoleStart, read: consoleRead }, a),
  },
  cookies: {
    desc: "Cookies for the tab's site. Values are secrets: never repeat them. do: set adds one (not HttpOnly).",
    params: { tab: TAB, url: { type: "string", description: "another site's URL" }, do: { type: "string", enum: ["read", "set"], description: "default read" }, name: { type: "string", description: "to set" }, value: { type: "string", description: "to set" } },
    unlisted: { domain: { type: "string", description: "to set" }, path: { type: "string", description: "to set" }, expires: { type: "number", description: "to set, seconds since 1970" } },
    required: ["tab"],
    run: (a) => a.do === "set"
      ? setCookie(a as { tab?: number; url?: string; name: string; value: string })
      : cookies({ tab: a.tab as number | undefined, url: a.url as string | undefined }),
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
  // errors the page threw from the mark on, a list and no object, so news
  // of a tab the press opened waits for the agent's next call (withTabNews).
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
    run: async (a) => filledOf(
      await bridge.tab(num(a.tab, "tab"), "fillLogin", [str(a.site, "site"), a.username ?? null, a.password ?? null], 30000, a.frame === undefined ? 0 : num(a.frame, "frame")),
      [...(a.username ? ["username"] : []), ...(a.password ? ["password"] : [])],
      "login",
    ),
  },
  passwords: {
    desc: "Sign in with the user's Apple Passwords; you never see a password. fill enters the saved login for the tab's site into its sign-in form, code its saved verification code, logins lists saved usernames. change saves a new strong password for the login and types it into the page's new-password fields; submit the form yourself. A site stating password rules: set them as the field's passwordrules first. setup-code gives the authenticator QR code in view to the Passwords app; then code confirms it. Locked, these first pair: he approves with Touch ID and types the Mac's code into a prompt there; you get paired or why not. Call done when finished; status says why it is locked.",
    params: { do: { type: "string", enum: ["pair", "unlock", "status", "done", "logins", "fill", "code", "change", "setup-code"], description: "step" }, code: { type: "string", description: "the 6 digits the user reads off the Mac" }, tab: TAB, username: { type: "string", description: "which saved login, when there are several" }, site: { type: "string", description: "change: host the login is saved for, if not the page's" } },
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
};

export function inputSchema(tool: Tool) {
  return { type: "object", properties: tool.params, ...(tool.required ? { required: tool.required } : {}) };
}

type Snapshot = Shielded & { url: string; title: string; nodes: number; truncated: boolean; snapshot: string; challenge?: Challenge; notes?: string };
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
      const notes = v.notes ? `${v.notes}\n` : "";
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
      if (v.notRun) lines.push(`stopped: the ${v.notRun} later step${v.notRun === 1 ? "" : "s"} did not run`);
      return lines.join("\n");
    }
    // map: each page under its address, as its read prints alone
    if (Array.isArray(v.pages)) {
      return v.pages.map((p) => {
        const notes = [`${p.ms} ms`, ...(p.challenge ? [`challenge: ${JSON.stringify(p.challenge)}`] : []), ...(p.closeError ? [`not closed: ${p.closeError}`] : [])];
        return `## ${p.url} (${notes.join("; ")})\n${p.ok ? formatResult(p.value) : `error: ${p.error}`}`;
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
// answer has the secrets in its addresses cut (redact.ts).
export async function callTool(name: string, args: Record<string, unknown> = {}, model = fromModel()): Promise<unknown> {
  const call = checkCall(TOOLS, name, args, model);
  return redacted(await guard(call, model, () => inLane(call.tool, call.args, resolveTab, () => withTabNews(call.args.tab, () => revived(call.tool, call.args)))));
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
    if (mine && tool !== "eval" && acts(tool, args)) mine.acted = tool === "goto" || navigatedOf(result) ? undefined : true;
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

// run: several tools in one call, so an agent can open, act, read, and close
// without a model turn between steps. A step without tab uses the tab the
// latest open step made. Later steps usually depend on earlier ones, so the
// first error stops the run, except that close steps still run: a failed run
// must not leave its tab behind. call runs one step: here, the daemon's own
// tools; in a caller (call.ts), any tool, wherever it runs.
export async function runSteps(steps: unknown, call: (tool: string, args: Record<string, unknown>) => Promise<unknown> = callTool): Promise<Steps> {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('run needs steps: [{"tool": "open", "args": {"url": "…"}}, …]');
  const done: Step[] = [];
  let opened: number | undefined;
  let failed = false;
  for (const [i, raw] of (steps as unknown[]).entries()) {
    let tool = "?";
    try {
      const step = stepOf(raw);
      tool = step.tool;
      if (failed && tool !== "close") continue;
      const value = await call(tool, opened === undefined || step.args.tab !== undefined ? step.args : { ...step.args, tab: opened });
      if (tool === "open" && value && typeof value === "object" && "id" in value && typeof value.id === "number") opened = value.id;
      done.push({ step: i + 1, tool, value });
    } catch (e) {
      if (failed && tool !== "close") continue;
      done.push({ step: i + 1, tool, error: e instanceof Error ? e.message : String(e) });
      failed = true;
    }
  }
  return { steps: done, notRun: steps.length - done.length };
}
