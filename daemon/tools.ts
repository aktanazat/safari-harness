// Tool registry: the aside-style verbs, implemented over the bridge.
// Every consumer (CLI, MCP server, agent loop, CDP shim) calls these.

import { bridge } from "./bridge.ts";
import { loginForm, passwords } from "./passwords.ts";
import { challengeOf, type Challenge } from "./challenge.ts";
import { frontApp, inFront, input, notify, SAFARI, show } from "./front.ts";
import { renderPdf, pdfText } from "./pdf.ts";
import { asExpression } from "./statements.ts";
import { spaceWindow } from "./spaces.ts";
import { currentOwner, watchOwner } from "./owner.ts";
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
  const mine = harnessTabs.get(id);
  if (mine) mine.used = Date.now();
  return id;
}

// Every tab opens in a window of the calling agent's own (spaces.ts).
export async function openTab(url: string, background = false, group?: string): Promise<TabInfo> {
  const window = await spaceWindow(group);
  return (await bridge.request("tabs.open", [str(url, "url"), background, window])) as TabInfo;
}

// A native sheet on the tab (a sign-in or permission prompt) or an
// off-screen window can keep Safari from closing it; the extension tries
// for 15 s and says so. This limit is only for an extension that never
// answers.
export async function closeTab(tab: number): Promise<unknown> {
  const id = num(tab, "tab");
  const res = await bridge.request("tabs.close", [id], 20000);
  forget(id);
  return res;
}

// A background tab an agent opens closes once that agent exits (owner.ts),
// or once it sits untouched for IDLE_MS while the user does not have it in
// front; keep leaves it open. Tabs a click opens from one inherit its
// owner. The list is kept in a file, so a restarted daemon still closes
// them, and the extension closes only a tab the harness owns, so an id
// Safari has given another tab since is left alone. A tab it cannot close
// now (not connected, a sheet) is tried again each minute.
const IDLE_MS = 20 * 60_000;
type HarnessTab = { owner?: number; used: number; orphan?: true; closing?: true };
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

// The user stopped owner from its window (mission.ts): its background tabs
// close now, as they would once it exits.
export function closeTabsOf(owner: number): void {
  watches.get(owner)?.();
  orphan(owner);
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
  await input(["activate", SAFARI]);
  return res;
}

// open, goto, snapshot, and a missed wait say when the tab shows a bot check
// (challenge.ts): the agent hands it to the user with handoff. A result still
// coming has its probe sent beside it.
async function withChallenge<T extends object>(result: T | Promise<T>, tab: number): Promise<T> {
  const [r, challenge] = await Promise.all([result, challengeOf(tab)]);
  return challenge ? { ...r, challenge } : r;
}

// The latest whole-page snapshot of each tab, for diff.
const lastSnapshot = new Map<number, string>();

export async function snapshot(opts: { tab?: number; root?: string; query?: string; maxNodes?: number; diff?: boolean; showHidden?: boolean } = {}) {
  const tab = await resolveTab(opts.tab);
  // The bot-check probe goes out with the snapshot request: sent after its
  // answer, it added 5 of the 14 ms a snapshot of cnn.com took.
  const snap = await withChallenge(relay(tab, "snapshot", [{ root: opts.root, query: opts.query, maxNodes: opts.maxNodes, showHidden: !!opts.showHidden }]) as Promise<Snapshot>, tab);
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

export async function type(opts: { tab?: number; ref: number | string; text: string; append?: boolean }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "type", [opts.ref, str(opts.text, "text"), { append: !!opts.append }]);
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

export async function upload(opts: { tab?: number; ref?: number | string; paths: string[] }) {
  const tab = await resolveTab(opts.tab);
  if (!Array.isArray(opts.paths) || opts.paths.length === 0) throw new Error("upload needs paths: [\"/abs/file\", ...]");
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
// Trusted Types still runs it; one whose security policy forbids eval
// outright refuses it.
export async function evaluate(opts: { tab?: number; expression: string; page?: boolean }) {
  const tab = await resolveTab(opts.tab);
  const [, frame = "0", source] = /^(?:f(\d+):)?([\s\S]*)$/.exec(str(opts.expression, "expression"))!;
  const code = asExpression(source);
  if (opts.page) return bridge.request("evalPage", [tab, code, Number(frame)], 30000);
  return bridge.tab(tab, "eval", [code], 30000, Number(frame));
}

export async function extract(opts: { tab?: number; selector?: string; query?: string; maxBytes?: number }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "extract", [{ selector: opts.selector, query: opts.query, maxBytes: opts.maxBytes }]);
}

export async function tabInfo(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "tabInfo");
}

// Sleep for ms, or, given a selector or text, wait until it is present (ms is
// then the timeout, max 30000). The page reports the change the moment it
// happens (waitFor in content.js); the time limit is kept here, because
// Safari stops a content script's timers in a hidden tab. The answer at the
// limit does not wait for the page: a page still loading, or too busy to
// answer, would otherwise hold the call past its limit. A miss says where
// the tab is: often a redirect (signed out, sent to the home page).
export async function wait(opts: { tab?: number; ms?: number; selector?: string; text?: string }) {
  const tab = await resolveTab(opts.tab);
  const until = opts.selector !== undefined || opts.text !== undefined;
  if (!until && opts.ms === undefined) throw new Error("wait needs ms, selector, or text");
  const limit = Math.min(opts.ms === undefined ? 10000 : num(opts.ms, "ms"), 30000);
  if (!until) {
    await Bun.sleep(limit);
    return { ok: true };
  }
  const start = Date.now();
  const stop = () => { relay(tab, "waitStop").catch(() => {}); };
  const seen = relay(tab, "wait", [opts.selector ?? null, opts.text ?? null], limit + 5000) as Promise<{ found: boolean }>;
  // A page that answers only after the limit (it navigated, and the new page
  // began the wait again) still holds a wait: end that one too.
  seen.catch(stop);
  const timeUp = Promise.withResolvers<{ found: boolean }>();
  const timer = setTimeout(() => { stop(); timeUp.resolve({ found: false }); }, limit);
  try {
    const { found } = await Promise.race([seen, timeUp.promise]);
    const waitedMs = Date.now() - start;
    if (found) return { ok: true, found, waitedMs };
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
  // how the text to the user's phone went: one per handoff
  texted?: string;
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
// text them (text: true) and returns at once; it reports how that went as
// texted, so no other call sends one.
async function handoffWait(tab: number, why: string, o: { ms: number; away: boolean; texted?: string; id?: number }) {
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
  if (o.texted !== undefined) session.texted = o.texted;
  let timer: Timer | undefined;
  try {
    await session.begun.promise;
    const text = o.away && session.texted === undefined && !session.done && session.error === undefined;
    if (text) session.texted = "sending";
    else if (o.ms > 0) await Promise.race([session.over.promise, new Promise<void>((r) => { timer = setTimeout(r, Math.min(o.ms, 110000)); })]);
    if (session.error !== undefined) throw new Error(session.error);
    return { id: session.id, done: session.done, waitedMs: Date.now() - session.start, ...session.now, ...(joined ? { joined } : {}), ...(session.texted ? { texted: session.texted } : {}), ...(text ? { text } : {}) };
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
  return relay(tab, "fetch", [str(opts.url, "url"), { method: opts.method, headers: opts.headers, body: opts.body, maxBytes: opts.maxBytes, base64: !!opts.base64 }], 60000);
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

// A file by url, fetched with the page's cookies (the extension's own
// fetch when the page may not read that site), or the file a ref's link or
// button downloads. Saved in ~/Downloads unless out says where.
export async function download(opts: { tab?: number; ref?: string; url?: string; out?: string }) {
  const tab = await resolveTab(opts.tab);
  if (opts.url !== undefined) {
    const url = str(opts.url, "url");
    const f = (await relay(tab, "fetchFile", [url, ""], 120000).catch(() => bridge.request("fetchFile", [url], 120000))) as FilePayload;
    return saveFile(f, url, opts.out);
  }
  if (opts.ref === undefined) throw new Error("download needs ref or url");
  const ref = String(opts.ref);
  const stop = setTimeout(() => { relay(tab, "downloadStop", [ref]).catch(() => {}); }, 10000);
  try {
    const f = (await relay(tab, "download", [ref], 120000)) as FilePayload;
    return saveFile(f, "", opts.out);
  } finally {
    clearTimeout(stop);
  }
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
  const page = (await relay(tab, "eval", ["({ html: document.documentElement.outerHTML, url: location.href, title: document.title })"])) as { result: { html: string; url: string; title: string } };
  const { html, url, title } = page.result;
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
  type?: "string" | "number" | "boolean" | "array";
  description: string;
  enum?: string[];
  items?: { type: "string" } | { type: "object"; properties: Record<string, { type: "string" | "object" }>; required: string[] };
};
export type Tool = {
  desc: string;
  params: Record<string, Param>;
  required?: string[];
  // reached by name over RPC, never listed to a model (the real-input tools use it)
  hidden?: true;
  run: (a: Record<string, unknown>) => Promise<unknown>;
};

export const TAB: Param = { description: 'tab id from open, or "front"' };
// close, activate, and window act only on a tab the agent opened
const OWN_TAB: Param = { type: "number", description: "tab id from open" };
export const REF: Param = { description: "snapshot ref, CSS selector, or visible text" };
const PAGE: Param = { type: "boolean", description: "also return the page after the action" };

// With `snapshot: true` an action also returns the page it led to, saving
// the agent a separate snapshot call.
async function withPage(result: unknown, tab: number, want: unknown): Promise<unknown> {
  if (!want) return result;
  const opened = (result as { newTab?: { id: number } } | null)?.newTab?.id;
  return { ...(result as object), page: await relay(opened ?? tab, "snapshot", [{}]) };
}

function action(run: (a: Record<string, unknown> & { tab: number }) => Promise<unknown>) {
  return async (a: Record<string, unknown>) => {
    const tab = await resolveTab(a.tab);
    const result = await run({ ...a, tab });
    const opened = (result as { newTab?: { id: number } } | null)?.newTab?.id;
    const from = harnessTabs.get(tab);
    if (opened !== undefined && from) own(opened, from.owner);
    return withPage(result, tab, a.snapshot);
  };
}

// net and console take do: start, read (the default), or stop.
type Capture = (o: { tab?: number }) => Promise<unknown>;
function capture(ops: Record<string, Capture>, a: Record<string, unknown>): Promise<unknown> {
  const key = a.do === undefined ? "read" : String(a.do);
  if (!Object.hasOwn(ops, key)) throw new Error(`do must be ${Object.keys(ops).join(", ")}`);
  return ops[key]({ tab: a.tab as number | undefined });
}

// passwords: pair, unlock, status, and done take no tab; logins, fill, and
// code act on the tab's own site. Each agent session holds the pairing until
// it calls done or exits, and the pairing ends a few minutes after the last.
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
    default:
      throw new Error("do must be pair, unlock, status, done, logins, fill, or code");
  }
}

export const TOOLS: Record<string, Tool> = {
  run: {
    desc: 'Run several of these tools in one call, in order, stopping at the first error; each call saved is a model turn saved. A step without tab uses the tab an earlier open step made. Open, read, and close in one call: [{"tool":"open","args":{"url":"https://example.com","background":true}},{"tool":"extract"},{"tool":"close"}]',
    params: { steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] }, description: "{tool, args} objects; args as that tool takes them" } },
    required: ["steps"],
    run: (a) => runSteps(a.steps),
  },
  tabs: { desc: "List tabs: id, url, title, and which is in front.", params: {}, run: () => listTabs() },
  open: {
    desc: 'Open a URL in a new tab and wait until it is readable. Returns the tab id: pass it as tab to every later call. tab "front" is the user\'s own front tab, for when he asks about his page.',
    params: { url: { type: "string", description: "address to open" }, background: { type: "boolean", description: "keep the user's current tab in front" }, group: { type: "string", description: "task name: its tabs get a window of their own" }, keep: { type: "boolean", description: "leave it open after you exit" }, snapshot: PAGE },
    required: ["url"],
    run: async (a) => {
      const t = await openTab(str(a.url, "url"), !!a.background, a.group === undefined ? undefined : str(a.group, "group"));
      // a tab opened in front is the user's to close
      if (a.background && !a.keep) own(t.id, currentOwner());
      return withPage(await withChallenge(t, t.id), t.id, a.snapshot);
    },
  },
  close: { desc: "Close a tab you opened.", params: { tab: OWN_TAB }, required: ["tab"], run: (a) => closeTab(num(a.tab, "tab")) },
  goto: {
    desc: "Load a URL in a tab and wait until it is readable.",
    params: { tab: TAB, url: { type: "string", description: "address to load" }, snapshot: PAGE },
    required: ["tab", "url"],
    run: action(async (a) => withChallenge(await navigate(a.tab, str(a.url, "url")), a.tab)),
  },
  activate: { desc: "Bring a tab, its window, and Safari to the front.", params: { tab: OWN_TAB }, required: ["tab"], run: (a) => showTab(num(a.tab, "tab")) },
  snapshot: {
    desc: "Page outline with [ref]s for click, type, select, and hover, embedded frames included (refs like f3:12). Refs expire when the page changes: snapshot again after acting.",
    params: {
      tab: TAB,
      query: { type: "string", description: "only lines containing this text" },
      root: { type: "string", description: "CSS selector of the region to read" },
      maxNodes: { type: "number", description: "line limit, default 600" },
      diff: { type: "boolean", description: "only lines changed since this tab's last snapshot" },
    },
    required: ["tab"],
    run: (a) => snapshot(a as { tab?: number; root?: string; query?: string; maxNodes?: number; diff?: boolean; showHidden?: boolean }),
  },
  click: {
    desc: "Click a ref (or x/y). Reports navigated, or newTab if a tab opened (yours to close).",
    params: { tab: TAB, ref: REF, x: { type: "number", description: "page x, without ref" }, y: { type: "number", description: "page y, without ref" }, snapshot: PAGE },
    required: ["tab"],
    run: action((a) => click(a as { tab: number; ref?: string; x?: number; y?: number })),
  },
  type: {
    desc: "Set a field's text by ref; replaces it unless append.",
    params: { tab: TAB, ref: REF, text: { type: "string", description: "text to enter" }, append: { type: "boolean", description: "keep the existing text" }, snapshot: PAGE },
    required: ["tab", "ref", "text"],
    run: action((a) => type(a as { tab: number; ref: string; text: string; append?: boolean })),
  },
  press: {
    desc: "Press a key (Enter, Tab, Escape, ArrowDown) or combo (Cmd+K) on a ref or the focused element. Enter in a field submits its form.",
    params: { tab: TAB, ref: REF, key: { type: "string", description: "key name" }, snapshot: PAGE },
    required: ["tab", "key"],
    run: action((a) => press(a as { tab: number; ref?: string; key: string })),
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
    desc: "Attach local files to a file input. ref may be the upload area; omit it when the page has one file input.",
    params: { tab: TAB, ref: REF, paths: { type: "array", items: { type: "string" }, description: "absolute file paths" }, snapshot: PAGE },
    required: ["tab", "paths"],
    run: action((a) => upload(a as { tab: number; ref?: string; paths: string[] })),
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
    desc: "Run JS in the page and return its last value as JSON; statements and await work. Sees the DOM; with page: true, also the page's script variables. To read a fact, extract with query: a selector you remember may be gone.",
    params: { tab: TAB, expression: { type: "string", description: "JS code" }, page: { type: "boolean", description: "run in the page's own world" } },
    required: ["tab", "expression"],
    run: (a) => evaluate({ tab: a.tab as number | undefined, expression: str(a.expression, "expression"), page: !!a.page }),
  },
  fetch: {
    desc: "Request a URL with the page's cookies; returns status, type, and text.",
    params: { tab: TAB, url: { type: "string", description: "address" }, method: { type: "string", description: "default GET" }, body: { type: "string", description: "request body" }, maxBytes: { type: "number", description: "default 50000" } },
    required: ["tab", "url"],
    run: (a) => pageFetch(a as { tab?: number; url: string; method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number; base64?: boolean }),
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
    params: { tab: TAB, selector: { type: "string", description: "CSS selector to read" }, query: { type: "string", description: "only lines containing this text, from the whole page" }, maxBytes: { type: "number", description: "default 20000" } },
    required: ["tab"],
    run: (a) => extract(a as { tab?: number; selector?: string; query?: string; maxBytes?: number }),
  },
  info: { desc: "URL, title, load state, and scroll position of a tab.", params: { tab: TAB }, required: ["tab"], run: (a) => tabInfo({ tab: a.tab as number | undefined }) },
  wait: {
    desc: "Wait until text or a CSS selector is on the page (ms is the timeout: default 10000, max 30000), or with only ms, sleep. Returns found.",
    params: { tab: TAB, text: { type: "string", description: "visible text" }, selector: { type: "string", description: "CSS selector" }, ms: { type: "number", description: "timeout, or sleep length" }, front: { type: "boolean", description: "keep the tab on screen meanwhile" } },
    required: ["tab"],
    run: async (a) => {
      const o = { ...(a as { ms?: number; selector?: string; text?: string; front?: boolean }), tab: await resolveTab(a.tab) };
      return o.front ? inFront(o.tab, { tabs: listTabs, activate: activateTab }, () => wait(o)) : wait(o);
    },
  },
  // The daemon's half of handoff (handoff.ts runs in the caller). away says
  // the caller found the user away; texted reports how its text went; id
  // names the handoff the caller's earlier call started or joined.
  handoff_wait: {
    desc: "Start or join the tab's handoff and wait up to ms for the user.",
    params: {
      tab: TAB,
      why: { type: "string", description: "for the notice" },
      ms: { type: "number", description: "max 110000" },
      away: { type: "boolean", description: "the user is away from the Mac" },
      texted: { type: "string", description: "how the text to the user's phone went" },
      id: { type: "number", description: "the handoff an earlier call returned" },
    },
    required: ["tab", "why", "ms"],
    hidden: true,
    run: async (a) => handoffWait(await resolveTab(a.tab), str(a.why, "why"), { ms: num(a.ms, "ms"), away: a.away === true, ...(a.texted === undefined ? {} : { texted: str(a.texted, "texted") }), ...(a.id === undefined ? {} : { id: num(a.id, "id") }) }),
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
    run: (a) => pdf(a as { tab?: number; do?: string; path?: string; out?: string }),
  },
  window: {
    desc: "Put a tab in its own window of this size, e.g. a phone-width page.",
    params: { tab: OWN_TAB, width: { type: "number", description: "points" }, height: { type: "number", description: "points" } },
    required: ["tab", "width", "height"],
    run: (a) => viewport(a as { tab: number; width: number; height: number }),
  },
  locate: {
    desc: "An element's box in the top page's viewport, scrolled into view.",
    params: { tab: TAB, ref: REF },
    required: ["ref"],
    hidden: true,
    // A tab just brought to the front may not have drawn yet; a real click
    // before it has lands on the tab shown before.
    run: async (a) => {
      const tab = await resolveTab(a.tab);
      await relay(tab, "painted", [], 3000).catch(() => {});
      return relay(tab, "locate", [str(String(a.ref), "ref")]);
    },
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
  // login was saved for.
  login_fill: {
    desc: "Fill a login into the tab's sign-in form, only while the tab is on site.",
    params: { tab: TAB, frame: { type: "number", description: "frame from login_form" }, site: { type: "string", description: "hostname" }, username: { type: "string", description: "username" }, password: { type: "string", description: "password" } },
    required: ["tab", "site"],
    hidden: true,
    run: async (a) => bridge.tab(num(a.tab, "tab"), "fillLogin", [str(a.site, "site"), a.username ?? null, a.password ?? null], 30000, a.frame === undefined ? 0 : num(a.frame, "frame")),
  },
  passwords: {
    desc: "Sign in with the user's Apple Passwords; you never see a password. fill enters the saved login for the tab's site into its sign-in form, code its saved verification code, logins lists saved usernames. Locked, these first ask the user for Touch ID and pair (as pair does); if one answers codeShown, ask the user for the 6-digit code on their Mac and call unlock with it. Call done when finished; status says why it is locked.",
    params: { do: { type: "string", enum: ["pair", "unlock", "status", "done", "logins", "fill", "code"], description: "step" }, code: { type: "string", description: "the 6 digits the user reads off the Mac" }, tab: TAB, username: { type: "string", description: "which saved login, when there are several" } },
    required: ["do"],
    run: applePasswords,
  },
};

export function inputSchema(tool: Tool) {
  return { type: "object", properties: tool.params, ...(tool.required ? { required: tool.required } : {}) };
}

type Snapshot = { url: string; title: string; nodes: number; truncated: boolean; snapshot: string; challenge?: Challenge };
type Extract = { url: string; title: string; text: string };

// One text form for every consumer (CLI, MCP, agent loop): trees and page
// text stay readable instead of arriving as escaped JSON strings.
export function formatResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Partial<Snapshot & Extract & Steps> & { page?: unknown };
    if (typeof v.snapshot === "string") {
      const note = v.truncated ? "; truncated: narrow with query or root" : "";
      const check = v.challenge ? `challenge: ${JSON.stringify(v.challenge)}\n` : "";
      return `# ${v.title} — ${v.url} (${v.nodes} nodes${note})\n${check}${v.snapshot}`;
    }
    if (typeof v.text === "string") {
      if (typeof v.title === "string") return `# ${v.title} — ${v.url}\n\n${v.text}`;
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
  }
  return JSON.stringify(value, null, 1);
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool ${name}; tools: ${Object.keys(TOOLS).filter((k) => !TOOLS[k].hidden).join(", ")}`);
  return tool.run(args);
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
