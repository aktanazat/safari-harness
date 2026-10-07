// Mission control: what each agent does in Safari, and the user's hand on
// it. Agent windows open behind his (spaces.ts), so he could see neither
// what one was doing nor stop it. Each window's first tab is this file's
// live page for its agent, and /agents lists every agent at work.
//
// Every call goes through watched (main.ts /rpc): it lands in its agent's
// flight record, waits while the user has paused that agent, and fails once
// he has stopped it. A call with no agent process behind it lands under "no
// agent", and nothing holds it. The record is default-deny: an argument
// shows its value only when its name is in SHOWN, and an answer only
// whether it worked, where its tab went, and how many, so nothing the agent
// typed or read (a password, a code, page text) is kept, beyond a tab's
// title and address.
//
// The pages call back from their own origin, which main.ts's check for
// local callers refuses; admitted checks these routes instead. A control
// also needs the secret its page was served with, sent as JSON, which a
// page of another origin cannot send without asking first.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { bridge } from "./bridge.ts";
import { onRaised } from "./front.ts";
import { note } from "./journal.ts";
import { currentOwner, watchOwner } from "./owner.ts";
import { spaceById, spaceEnded } from "./spaces.ts";
import { closeTabsOf, tabsOpenedBy, type TabInfo } from "./tools.ts";

// What a held call answers: each tells the agent what to do next.
const PAUSED = "the user paused this task from its window; wait a minute, then call again";
const STOPPED = "the user stopped this task from its window; stop and tell the user what you had done";

// A paused agent's call waits this long for the user, then fails: well
// inside the time an agent's client waits for an answer.
const HOLD_MS = 90_000;
const KEPT = 200;
const SHOWN_CALLS = 50;
const HOUR = 60 * 60_000;

// One call as the pages show it. ms is set once it answered, with outcome
// or error; held, while it waits for the user to resume its agent.
type Call = {
  t: number;
  tool: string;
  args: string;
  tab?: number;
  held?: true;
  ms?: number;
  outcome?: string;
  error?: string;
  url?: string;
  title?: string;
};

type Hold = "paused" | "driving";
type Status = "working" | "waiting on the user" | "paused" | "user is driving" | "stopped" | "ended";

// raised: the times it brought Safari to the front (front.ts)
type Agent = {
  owner?: number;
  process?: string;
  first: number;
  last: number;
  calls: Call[];
  running: Set<Call>;
  raised: number;
  hold?: Hold;
  stopped?: number;
  ended?: number;
  waiting: Set<() => void>;
  unwatch?: () => void;
};

function fresh(owner?: number): Agent {
  const now = Date.now();
  return { owner, first: now, last: now, calls: [], running: new Set(), raised: 0, waiting: new Set() };
}

const agents = new Map<number, Agent>();
const nobody = fresh();

// The record a new call of owner goes in: a pid the system has given to
// another process since its agent ended starts a new one.
function recordOf(owner: number | undefined): Agent {
  if (owner === undefined) return nobody;
  const had = agents.get(owner);
  return had && had.ended === undefined ? had : track(owner);
}

onRaised(() => {
  const owner = currentOwner();
  recordOf(owner).raised += 1;
  note("safari to front", { owner: owner ?? null });
});

function track(owner: number): Agent {
  prune(Date.now());
  const agent = fresh(owner);
  agents.set(owner, agent);
  agent.unwatch = watchOwner(owner, () => {
    agent.ended = Date.now();
    agent.unwatch = undefined;
  });
  named(agent).catch((e) => console.error(`[safari-harness] no program name for agent ${owner}:`, e instanceof Error ? e.message : e));
  return agent;
}

// Its program (claude, omp, codex, node), which tells two agents apart
// better than a pid does.
async function named(agent: Agent): Promise<void> {
  const ps = Bun.spawn(["ps", "-o", "comm=", "-p", String(agent.owner)], { stdout: "pipe", stderr: "ignore" });
  const path = (await new Response(ps.stdout).text()).trim();
  if (path) agent.process = basename(path);
}

// On /agents: an agent seen within the hour, or one the user holds while
// it runs. Any other record goes.
function listed(a: Agent, now: number): boolean {
  if (a.running.size > 0) return true;
  if (a.ended === undefined && (a.hold !== undefined || a.stopped !== undefined)) return true;
  return a.calls.length > 0 && a.last >= now - HOUR;
}

function prune(now: number) {
  for (const [owner, a] of agents) {
    if (listed(a, now)) continue;
    a.unwatch?.();
    agents.delete(owner);
  }
}

function statusOf(a: Agent): Status {
  if (a.stopped !== undefined) return "stopped";
  if (a.ended !== undefined) return "ended";
  if (a.hold === "driving") return "user is driving";
  if (a.hold === "paused") return "paused";
  for (const c of a.running) if (c.tool === "handoff_wait") return "waiting on the user";
  return "working";
}

// ---------- the gate ----------

// Runs one call of owner's through the user's hold on it, and records it.
export async function watched<T>(owner: number | undefined, tool: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const agent = recordOf(owner);
  const withheld: string[] = [];
  const call: Call = { t: Date.now(), tool: cut(tool, 40), args: cut(argsOf(args, withheld), 300), ...tabOf(args.tab) };
  agent.calls.push(call);
  if (agent.calls.length > KEPT) agent.calls.splice(0, agent.calls.length - KEPT);
  agent.running.add(call);
  agent.last = call.t;
  const began = performance.now();
  let ran = false;
  try {
    if (owner !== undefined) await admit(agent, call);
    ran = true;
    const value = await run();
    Object.assign(call, outcomeOf(tool, value, withheld));
    return value;
  } catch (e) {
    call.error = cut(redact(e instanceof Error ? e.message : String(e), withheld), 300);
    throw e;
  } finally {
    call.ms = Math.round(performance.now() - began);
    agent.running.delete(call);
    agent.last = Date.now();
    // A tab a call in flight opened after the user stopped its agent goes too.
    if (ran && owner !== undefined && agent.stopped !== undefined) closeTabsOf(owner);
  }
}

// A paused agent's call waits for the user, up to HOLD_MS; a stopped
// agent's fails. Calls already in flight when he pressed finish.
async function admit(agent: Agent, call: Call): Promise<void> {
  if (agent.stopped !== undefined) throw new Error(STOPPED);
  if (agent.hold === undefined) return;
  call.held = true;
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, HOLD_MS);
  agent.waiting.add(resolve);
  await promise;
  clearTimeout(timer);
  agent.waiting.delete(resolve);
  delete call.held;
  if (agent.stopped !== undefined) throw new Error(STOPPED);
  if (agent.hold !== undefined) throw new Error(PAUSED);
}

function release(agent: Agent) {
  agent.hold = undefined;
  for (const wake of agent.waiting) wake();
  agent.waiting.clear();
}

// ---------- the record ----------

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function tabOf(tab: unknown): { tab?: number } {
  const id = typeof tab === "number" ? tab : typeof tab === "string" && /^\d+$/.test(tab) ? Number(tab) : undefined;
  return id !== undefined && Number.isSafeInteger(id) ? { tab: id } : {};
}

// Arguments that say what a call did and hold nothing the agent typed or
// read: their values show. Any other shows only its kind and size.
const SHOWN: Record<string, true> = { tab: true, ref: true, do: true, background: true, keep: true, group: true, snapshot: true, x: true, y: true, dx: true, dy: true, ms: true, selector: true, root: true, why: true, what: true, frame: true, site: true, id: true, annotate: true, fullPage: true, diff: true, maxNodes: true, maxBytes: true, method: true, front: true, page: true, append: true, width: true, height: true, away: true };

function argsOf(args: object, withheld: string[]): string {
  return Object.entries(args).map(([k, v]) => `${cut(k, 20)}=${argOf(k, v, withheld)}`).join(" ");
}

function argOf(key: string, v: unknown, withheld: string[]): string {
  if (key === "url" && typeof v === "string") return place(v, withheld);
  if (key === "key" && typeof v === "string") return keyOf(v);
  if (key === "steps" && Array.isArray(v)) return `[${v.map((s) => stepOf(s, withheld)).join("; ")}]`;
  if (!Object.hasOwn(SHOWN, key)) return kindOf(v, withheld);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(cut(v, 60)) : cut(v, 60);
  return kindOf(v, withheld);
}

function stepOf(step: unknown, withheld: string[]): string {
  if (!step || typeof step !== "object" || !("tool" in step) || typeof step.tool !== "string") return kindOf(step, withheld);
  const args = "args" in step && step.args && typeof step.args === "object" ? argsOf(step.args, withheld) : "";
  return args ? `${cut(step.tool, 40)} ${args}` : cut(step.tool, 40);
}

// A value that may hold what the agent typed or read: only its kind and
// size show, and its text is cut out of the call's error too.
function kindOf(v: unknown, withheld: string[]): string {
  collect(v, withheld);
  if (typeof v === "string") return `<${v.length} chars>`;
  if (Array.isArray(v)) return `<${v.length} items>`;
  if (v && typeof v === "object") return `<${Object.keys(v).length} fields>`;
  return `<${v === null ? "null" : typeof v}>`;
}

function collect(v: unknown, withheld: string[]) {
  if (typeof v === "string" || typeof v === "number") {
    const s = String(v);
    if (s.length >= 3) withheld.push(s);
  } else if (v && typeof v === "object") {
    for (const inner of Object.values(v)) collect(inner, withheld);
  }
}

// An address shows its site and path. Its query and fragment (a token, a
// search, an email) show only that they were there, and a scheme other
// than http only itself.
function place(url: string, withheld: string[]): string {
  const u = URL.parse(url);
  if (!u) return kindOf(url, withheld);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    collect(url, withheld);
    return `${u.protocol}…`;
  }
  const rest = u.search + u.hash;
  for (const part of [rest, u.username, u.password]) collect(part, withheld);
  return `${cut(u.origin + u.pathname, 120)}${rest ? "?…" : ""}`;
}

// A named key or a shortcut shows; a character alone, or with shift, is
// typing (press, one key at a time).
function keyOf(key: string): string {
  const parts = key.split("+");
  const combo = parts.length > 1 && parts.at(-1) !== "";
  const main = combo ? (parts.at(-1) ?? "") : key;
  const shortcut = combo && parts.slice(0, -1).some((m) => m.trim().toLowerCase() !== "shift");
  return shortcut || [...main].length > 1 ? cut(key, 30) : `<${[...main].length} char>`;
}

function redact(text: string, withheld: string[]): string {
  return [...withheld].sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join("…"), text);
}

// What an answer says, as the pages show it: whether it worked, where its
// tab went, and how many; never a value or text it read.
function outcomeOf(tool: string, value: unknown, withheld: string[]): Pick<Call, "outcome" | "tab" | "url" | "title"> {
  if (value === undefined || value === null) return { outcome: "done" };
  if (typeof value === "boolean") return { outcome: String(value) };
  if (typeof value === "string") return { outcome: `text, ${value.length} chars` };
  if (typeof value !== "object") return { outcome: typeof value };
  if (Array.isArray(value)) return { outcome: `${value.length} items` };
  const o = value as Record<string, unknown>;
  const went: object = o.navigated && typeof o.navigated === "object" ? o.navigated : o;
  return {
    outcome: cut(said(o, withheld).join(", ") || "done", 300),
    ...(tool === "open" && typeof o.id === "number" ? { tab: o.id } : {}),
    ...("url" in went && typeof went.url === "string" ? { url: place(went.url, []) } : {}),
    ...("title" in went && typeof went.title === "string" && went.title ? { title: cut(went.title, 120) } : {}),
  };
}

function said(o: Record<string, unknown>, withheld: string[]): string[] {
  const parts: string[] = [];
  if (o.ok === true) parts.push("ok");
  if (typeof o.found === "boolean") parts.push(o.found ? "found" : "not found");
  if (typeof o.done === "boolean") parts.push(o.done ? "done" : "not done");
  if (typeof o.status === "number") parts.push(`status ${o.status}`);
  if (typeof o.waitedMs === "number") parts.push(`waited ${Math.round(o.waitedMs / 1000)} s`);
  if (o.navigated) parts.push("navigated");
  const opened = o.newTab && typeof o.newTab === "object" && "id" in o.newTab ? o.newTab.id : undefined;
  if (typeof opened === "number") parts.push(`opened tab ${opened}`);
  if (o.challenge) parts.push("bot check");
  if (Array.isArray(o.steps)) parts.push(...stepsOf(o.steps, o.notRun, withheld));
  return parts;
}

// A run's steps: how many ran, the one that failed, and how many never ran.
function stepsOf(steps: unknown[], notRun: unknown, withheld: string[]): string[] {
  const parts = [`${steps.length} step${steps.length === 1 ? "" : "s"}`];
  for (const s of steps) {
    if (!s || typeof s !== "object" || !("error" in s) || typeof s.error !== "string") continue;
    const which = "tool" in s && typeof s.tool === "string" ? ` (${s.tool})` : "";
    parts.push(`step ${"step" in s ? String(s.step) : "?"}${which} failed: ${redact(s.error, withheld)}`);
  }
  if (typeof notRun === "number" && notRun > 0) parts.push(`${notRun} not run`);
  return parts;
}

// ---------- what the pages read ----------

type Summary = { owner: number | null; process: string | null; status: Status; since: number; active: number; raised: number; controls: boolean };
// /agents.json, and what safari agents prints. tabs: those the agent opened
// that are open, in its windows or not.
export type Overview = { now: number; agents: (Summary & { last: Call | null; tasks: { id: string; name: string }[]; tabs: number | null })[] };

function summaryOf(a: Agent): Summary {
  const status = statusOf(a);
  return {
    owner: a.owner ?? null,
    process: a.process ?? null,
    status,
    since: a.first,
    active: a.last,
    raised: a.raised,
    controls: a.owner !== undefined && status !== "stopped" && status !== "ended",
  };
}

// Safari's tabs, only while the extension is there: a page's poll must
// never start a Safari the user quit (socket in bridge.ts).
async function tabList(): Promise<TabInfo[] | undefined> {
  if (!bridge.connected) return undefined;
  return (await bridge.request("tabs.list", [], 5000).catch(() => undefined)) as TabInfo[] | undefined;
}

// An agent window's page, by its address (spaceWindow in spaces.ts).
function pageOf(url: string | undefined): { id: string; name: string } | undefined {
  const u = url === undefined ? null : URL.parse(url);
  const id = u?.pathname === "/space" ? u.searchParams.get("id") : null;
  return u && id ? { id, name: u.searchParams.get("name") ?? "agent" } : undefined;
}

type Window = { id: string; name: string; owner?: number; window: number };

// The agent windows open now, found by their pages. A copy of a page the
// user opened in a window of his own is not one.
function windowsIn(tabs: TabInfo[]): Window[] {
  return tabs.flatMap((t) => {
    const page = pageOf(t.url);
    const space = page && spaceById(page.id);
    return page && space && t.windowId === space.window ? [{ ...page, ...space }] : [];
  });
}

const inWindows = (tabs: TabInfo[], windows: Set<number>) => tabs.filter((t) => t.windowId !== undefined && windows.has(t.windowId) && !pageOf(t.url));

async function spaceState(url: URL): Promise<Response> {
  const now = Date.now();
  const id = url.searchParams.get("id") ?? "";
  const space = spaceById(id);
  if (!space) return json({ now, agent: null, tabs: null, ended: spaceEnded(id) });
  const agent = space.owner === undefined ? nobody : (agents.get(space.owner) ?? track(space.owner));
  const tabs = await tabList();
  return json({
    now,
    agent: { ...summaryOf(agent), calls: agent.calls.slice(-SHOWN_CALLS).reverse() },
    tabs: tabs ? inWindows(tabs, new Set([space.window])).map((t) => ({ id: t.id, title: cut(t.title ?? "", 120), url: t.url ? place(t.url, []) : "", active: t.active === true })) : null,
  });
}

async function overview(): Promise<Overview> {
  const now = Date.now();
  prune(now);
  const tabs = await tabList();
  const windows = tabs ? windowsIn(tabs) : [];
  const rows = [...agents.values(), nobody].filter((a) => listed(a, now)).map((a) => {
    const mine = windows.filter((w) => w.owner === a.owner);
    return {
      ...summaryOf(a),
      last: a.calls.at(-1) ?? null,
      tasks: mine.map((w) => ({ id: w.id, name: w.name })),
      // On 10-07 an agent showed 0 tabs while one it opened sat in a window
      // apart from its own.
      tabs: tabs ? tabsOpenedBy(a.owner) : null,
    };
  });
  // Agents at work first, then those stopped or ended, each newest first:
  // a row stays put while its agent works, so its buttons never move under
  // the user's pointer.
  const over = (s: Status) => s === "stopped" || s === "ended";
  return { now, agents: rows.sort((x, y) => Number(over(x.status)) - Number(over(y.status)) || y.since - x.since) };
}

const json = (v: unknown) => Response.json(v, { headers: { "cache-control": "no-store" } });

// ---------- the controls ----------

const ACTIONS = ["pause", "resume", "stop", "drive", "giveback"] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (a: unknown): a is Action => typeof a === "string" && (ACTIONS as readonly string[]).includes(a);

const KEY = randomBytes(32);
const secretOf = (scope: string) => createHmac("sha256", KEY).update(scope).digest("base64url");

function matches(given: unknown, scope: string): boolean {
  if (typeof given !== "string") return false;
  const [got, want] = [Buffer.from(given), Buffer.from(secretOf(scope))];
  return got.length === want.length && timingSafeEqual(got, want);
}

const problem = (status: number, error: string) => Response.json({ ok: false, error }, { status });

async function bodyOf(req: Request): Promise<Record<string, unknown> | undefined> {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return undefined;
  const v: unknown = await req.json().catch(() => undefined);
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

async function spaceControl(req: Request): Promise<Response> {
  const body = await bodyOf(req);
  if (!body) return problem(400, "send JSON: {id, secret, action}");
  const id = typeof body.id === "string" ? body.id : "";
  if (!matches(body.secret, `space:${id}`)) return problem(403, "not this window's page");
  const space = spaceById(id);
  if (!space) return problem(409, "the harness restarted after this window opened, so it no longer knows its agent");
  return control(space.owner, body.action, "its window", space.window);
}

async function agentsControl(req: Request): Promise<Response> {
  const body = await bodyOf(req);
  if (!body) return problem(400, "send JSON: {owner, secret, action}");
  if (!matches(body.secret, "agents")) return problem(403, "not the agents page");
  const owner = typeof body.owner === "number" && agents.has(body.owner) ? body.owner : undefined;
  if (owner === undefined) return problem(404, "no such agent");
  return control(owner, body.action, "the agents page");
}

async function control(owner: number | undefined, action: unknown, from: string, window?: number): Promise<Response> {
  if (!isAction(action)) return problem(400, `action is one of ${ACTIONS.join(", ")}`);
  if (owner === undefined) return problem(409, "calls with no agent behind them cannot be paused or stopped");
  const agent = agents.get(owner) ?? track(owner);
  if (agent.ended !== undefined) return problem(409, "this agent has ended");
  if (agent.stopped !== undefined) return problem(409, "this agent is stopped");
  switch (action) {
    case "pause":
      agent.hold = "paused";
      note("agent paused", { owner, from });
      break;
    case "drive": {
      agent.hold = "driving";
      const tab = await raise(agent, window);
      note("user drives", { owner, from, ...(tab === undefined ? {} : { tab }) });
      return Response.json({ ok: true, status: statusOf(agent), tab: tab ?? null });
    }
    case "resume":
    case "giveback": {
      const was = agent.hold;
      if (was === undefined) break;
      release(agent);
      note(was === "driving" ? "user gave back" : "agent resumed", { owner, from });
      break;
    }
    case "stop":
      agent.stopped = Date.now();
      release(agent);
      closeTabsOf(owner);
      note("agent stopped", { owner, from });
      break;
  }
  return Response.json({ ok: true, status: statusOf(agent) });
}

// The tab the user takes over: the one the agent used last among the tabs
// of its windows (or of the window whose page he pressed), else the last
// one there. Safari brings it to the front of its window.
async function raise(agent: Agent, window: number | undefined): Promise<number | undefined> {
  const tabs = await tabList();
  if (!tabs) return undefined;
  const windows = new Set(window === undefined ? windowsIn(tabs).filter((w) => w.owner === agent.owner).map((w) => w.window) : [window]);
  const mine = inWindows(tabs, windows);
  const tab = agent.calls.findLast((c) => c.tab !== undefined && mine.some((t) => t.id === c.tab))?.tab ?? mine.at(-1)?.id;
  if (tab === undefined) return undefined;
  try {
    await bridge.request("tabs.activate", [tab], 10_000);
    return tab;
  } catch (e) {
    console.error(`[safari-harness] could not show tab ${tab} for the user to drive:`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

// ---------- the pages ----------

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: oklch(98.5% 0.004 90);
  --text: oklch(23% 0.01 90);
  --muted: oklch(45% 0.012 90);
  --line: oklch(89% 0.008 90);
  --hover: oklch(95% 0.006 90);
  --hold: oklch(45% 0.11 240);
  --go: oklch(45% 0.1 150);
  --ask: oklch(49% 0.11 65);
  --stop: oklch(50% 0.17 27);
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(19% 0.006 90);
    --text: oklch(94% 0.006 90);
    --muted: oklch(73% 0.01 90);
    --line: oklch(31% 0.008 90);
    --hover: oklch(25% 0.008 90);
    --hold: oklch(79% 0.09 240);
    --go: oklch(79% 0.11 150);
    --ask: oklch(83% 0.11 75);
    --stop: oklch(73% 0.15 27);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { max-width: 58rem; padding: 2.5rem clamp(1rem, 4vw, 2.5rem) 4rem; }
h1 { margin: 0; font-size: 1.7rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.015em; text-wrap: balance; overflow-wrap: anywhere; }
h2 { margin: 2.5rem 0 0.4rem; color: var(--muted); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; }
p { margin: 0; }
header p { margin-top: 0.3rem; color: var(--muted); text-wrap: pretty; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.5rem; margin-top: 1.75rem; }
.status { font-size: 1.1rem; font-weight: 650; }
.go { color: var(--go); }
.ask { color: var(--ask); }
.hold { color: var(--hold); }
.end { color: var(--muted); }
.controls { display: flex; flex-wrap: wrap; gap: 0.5rem; }
button { min-height: 2.1rem; padding: 0.3rem 0.95rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--text); font: inherit; font-size: 0.9rem; font-weight: 550; cursor: pointer; transition: background-color 0.15s ease-out, border-color 0.15s ease-out, color 0.15s ease-out; }
button:hover { background: var(--hover); border-color: var(--muted); }
button:active { background: var(--line); }
button:focus-visible, a:focus-visible { outline: 2px solid var(--hold); outline-offset: 2px; }
button:disabled { opacity: 0.55; cursor: default; }
button.primary { background: var(--text); border-color: var(--text); color: var(--bg); }
button.primary:hover { background: var(--muted); border-color: var(--muted); }
button.stop:hover, button.stop[data-armed="1"] { border-color: var(--stop); color: var(--stop); }
@media (pointer: coarse) { button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
.note { min-height: 1.5em; margin-top: 0.75rem; color: var(--muted); }
ul, ol { margin: 0; padding: 0; list-style: none; }
.rows > li { padding: 0.6rem 0; border-top: 1px solid var(--line); }
.rows > li:last-child { border-bottom: 1px solid var(--line); }
.tab { display: grid; }
.tab .title { overflow: hidden; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.url, .where { color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
.call { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) auto; gap: 0.15rem 1rem; align-items: baseline; }
.when, .took { color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
.when { grid-row: 1; grid-column: 1; }
.took { grid-row: 1; grid-column: 3; }
.what, .out, .where { grid-column: 2; }
.what { font-family: var(--mono); font-size: 0.82rem; overflow-wrap: anywhere; }
.tool { font-weight: 700; }
.args { color: var(--muted); }
.failed .out { color: var(--stop); }
.running .out, .held .out { color: var(--ask); }
.empty { color: var(--muted); }
.foot { margin-top: 2.5rem; color: var(--muted); font-size: 0.85rem; }
.agents > li { padding: 1.25rem 0; border-top: 1px solid var(--line); }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 1rem; }
.agents h2 { margin: 0; color: var(--text); font-size: 1.05rem; font-weight: 650; letter-spacing: 0; text-transform: none; }
.facts, .tasks, .last { margin-top: 0.3rem; }
.facts { color: var(--muted); }
.last { color: var(--muted); font-family: var(--mono); font-size: 0.82rem; overflow-wrap: anywhere; }
.agents .controls { margin-top: 0.8rem; }
[hidden] { display: none !important; }
a { color: var(--hold); text-underline-offset: 0.15em; }
`;

// Static, so the page's CSP names it by hash; what it shows comes from the
// JSON routes and goes in as text, never as markup.
const SCRIPT = String.raw`
"use strict";
{
  const data = document.body.dataset;
  const overview = data.kind === "agents";
  const byId = (id) => document.getElementById(id);
  const LABEL = { pause: "Pause", resume: "Resume", drive: "Let me drive", giveback: "Give back", stop: "Stop" };
  const SAY = { working: "Working", "waiting on the user": "Waiting on you", paused: "Paused", "user is driving": "You are driving", stopped: "Stopped", ended: "Ended" };
  const TONE = { working: "go", "waiting on the user": "ask", paused: "hold", "user is driving": "hold", stopped: "end", ended: "end" };
  const DONE = {
    pause: () => "Paused. Its next call waits for you; after a minute and a half it is told to try again later.",
    resume: () => "Resumed.",
    drive: (out) => out.tab === null ? "Paused. It has no tab open to hand you." : "Paused, with its tab in front. Give it back when you are done.",
    giveback: () => "Given back. It carries on.",
    stop: () => "Stopped. Its tabs close, and its calls fail from now on.",
  };
  const ARMING = "Press again to stop it. Its tabs close, and its calls fail from now on.";
  let timer = 0;
  let loading = false;
  let again = false;
  let offline = false;
  let armed = "";
  let arming = 0;

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function say(text) {
    setText(byId("note"), text);
  }

  function span(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return "under a minute";
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  function clock(t) {
    return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function who(a) {
    if (a.owner === null) return "Calls with no agent behind them";
    return "Agent " + a.owner + (a.process ? " (" + a.process + ")" : "");
  }

  function raised(a) {
    return a.raised === 0 ? "" : "brought Safari to the front " + a.raised + (a.raised === 1 ? " time" : " times");
  }

  function actionsOf(a) {
    if (!a.controls) return [];
    if (a.status === "paused") return ["resume", "drive", "stop"];
    if (a.status === "user is driving") return ["giveback", "stop"];
    return ["pause", "drive", "stop"];
  }

  function buttons(a, target, prefix) {
    return actionsOf(a).map((action) => {
      const key = prefix + action;
      const primary = action === "pause" || action === "resume" || action === "giveback";
      const b = make("button", primary ? "primary" : action === "stop" ? "stop" : "", LABEL[action]);
      b.type = "button";
      b.dataset.key = key;
      if (action === "stop" && armed === key) {
        b.dataset.armed = "1";
        b.textContent = "Stop for good?";
      }
      b.addEventListener("click", () => press(b, key, target, action));
      return b;
    });
  }

  // Puts an armed Stop back to asking once, in place: a redraw under the
  // second press would lose it.
  function unarm() {
    const b = armed ? document.querySelector('[data-key="' + CSS.escape(armed) + '"]') : null;
    armed = "";
    if (!(b instanceof HTMLElement)) return;
    delete b.dataset.armed;
    b.textContent = LABEL.stop;
  }

  // Stop takes a second press within 4 s: it cannot be taken back.
  function press(button, key, target, action) {
    if (action === "stop" && armed !== key) {
      unarm();
      armed = key;
      const n = ++arming;
      button.dataset.armed = "1";
      button.textContent = "Stop for good?";
      say(ARMING);
      setTimeout(() => {
        if (arming !== n || armed !== key) return;
        unarm();
        if (byId("note").textContent === ARMING) say("");
      }, 4000);
      return;
    }
    unarm();
    send(button, target, action);
  }

  async function send(button, target, action) {
    button.disabled = true;
    try {
      const res = await fetch(overview ? "/agents/control" : "/space/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ secret: data.secret, action: action }, target)),
      });
      const out = await res.json().catch(() => ({}));
      say(res.ok ? DONE[action](out) : out.error || "The harness refused that.");
    } catch {
      say("The harness is not answering.");
    }
    button.disabled = false;
    poll();
  }

  function tabRow(t) {
    const li = make("li", "tab");
    li.append(make("span", "title", t.title || "Untitled"), make("span", "url", t.url));
    return li;
  }

  function callRow(c) {
    const state = c.held ? "held" : c.ms === undefined ? "running" : c.error ? "failed" : "done";
    const li = make("li", "call " + state);
    const when = make("time", "when", clock(c.t));
    when.dateTime = new Date(c.t).toISOString();
    const what = make("div", "what");
    what.append(make("span", "tool", c.tool), " ", make("span", "args", c.args));
    const result = c.held ? "Waiting for you to resume it" : c.ms === undefined ? "Running" : c.error || c.outcome || "done";
    li.append(when, what, make("div", "out", result));
    if (c.title || c.url) li.append(make("div", "where", [c.title, c.url].filter(Boolean).join(" · ")));
    if (c.ms !== undefined) li.append(make("span", "took", c.ms < 1000 ? c.ms + " ms" : (c.ms / 1000).toFixed(1) + " s"));
    return li;
  }

  // What each part of the page last showed: a poll redraws a part only when
  // that changed, so a press that spans a poll lands on the button it began
  // on, and a selection in the record survives.
  const drawn = new WeakMap();
  function draw(el, sig, children) {
    if (drawn.get(el) === sig) return;
    drawn.set(el, sig);
    el.replaceChildren(...children());
  }

  function renderSpace(s) {
    const status = byId("status");
    const a = s.agent;
    if (!a) {
      status.className = "status end";
      setText(status, s.ended ? "Ended" : "Not tracked");
      setText(byId("who"), s.ended ? "This task has ended. Its window closes on its own." : "The harness restarted after this window opened, so it no longer knows its agent.");
      draw(byId("controls"), "", () => []);
      const gone = s.ended ? "Not shown once the task has ended." : "Unknown.";
      draw(byId("tabs"), gone, () => [make("li", "empty", gone)]);
      draw(byId("calls"), gone, () => [make("li", "empty", gone)]);
      return;
    }
    status.className = "status " + (TONE[a.status] || "go");
    setText(status, SAY[a.status] || a.status);
    const over = a.status === "stopped" || a.status === "ended";
    setText(byId("who"), a.owner === null ? who(a) + ": nothing can pause them." : who(a) + (over ? ", worked for " + span(a.active - a.since) : ", at work for " + span(s.now - a.since)) + (raised(a) ? ", " + raised(a) : ""));
    draw(byId("controls"), actionsOf(a).join(), () => buttons(a, { id: data.id }, ""));
    draw(byId("tabs"), JSON.stringify(s.tabs), () => (!s.tabs ? [make("li", "empty", "Safari is not connected.")] : s.tabs.length ? s.tabs.map(tabRow) : [make("li", "empty", "None besides this page.")]));
    draw(byId("calls"), JSON.stringify(a.calls), () => (a.calls.length ? a.calls.map(callRow) : [make("li", "empty", "No calls yet.")]));
  }

  // One row per agent, kept across polls with its parts changed in place,
  // so its links and buttons stay put while it works.
  const rows = new Map();
  const none = make("li", "empty", "No agent has used Safari in the last hour.");

  function agentRow(a, now) {
    const key = String(a.owner);
    let row = rows.get(key);
    if (!row) {
      row = { li: make("li", "agent"), head: make("div", "head"), facts: make("p", "facts"), tasks: make("p", "tasks"), last: make("p", "last"), controls: make("div", "controls") };
      row.li.append(row.head, row.facts, row.tasks, row.last, row.controls);
      rows.set(key, row);
    }
    draw(row.head, who(a) + "|" + a.status, () => [make("h2", "", who(a)), make("span", "status " + (TONE[a.status] || "go"), SAY[a.status] || a.status)]);
    setText(row.facts, (a.tabs === null ? "" : a.tabs + (a.tabs === 1 ? " tab · " : " tabs · ")) + (raised(a) ? raised(a) + " · " : "") + "last seen " + span(now - a.active) + " ago");
    row.tasks.hidden = !a.tasks.length;
    draw(row.tasks, JSON.stringify(a.tasks), () => a.tasks.flatMap((t, i) => {
      const link = make("a", "", t.name);
      link.href = "/space?id=" + encodeURIComponent(t.id) + "&name=" + encodeURIComponent(t.name);
      return i ? [", ", link] : [link];
    }));
    const c = a.last;
    row.last.hidden = !c;
    setText(row.last, c ? clock(c.t) + "  " + c.tool + " " + c.args + "  " + (c.held ? "waiting for you" : c.ms === undefined ? "running" : c.error || c.outcome || "done") : "");
    row.controls.hidden = !a.controls;
    draw(row.controls, actionsOf(a).join(), () => buttons(a, { owner: a.owner }, key + ":"));
    return row.li;
  }

  function renderAgents(o) {
    const list = byId("agents");
    const shown = new Set(o.agents.map((a) => String(a.owner)));
    for (const key of rows.keys()) if (!shown.has(key)) rows.delete(key);
    const next = o.agents.length ? o.agents.map((a) => agentRow(a, o.now)) : [none];
    // Moves rows only when the list itself changed.
    if (next.length !== list.children.length || next.some((li, i) => list.children[i] !== li)) list.replaceChildren(...next);
  }

  // Polls only while the page shows: a window behind his asks nothing.
  async function poll() {
    clearTimeout(timer);
    if (document.visibilityState !== "visible") return;
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const res = await fetch(overview ? "/agents.json" : "/space/state?id=" + encodeURIComponent(data.id || ""), { cache: "no-store" });
      if (!res.ok) throw new Error("status " + res.status);
      const state = await res.json();
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined;
      if (overview) renderAgents(state);
      else renderSpace(state);
      const back = focused ? document.querySelector('[data-key="' + CSS.escape(focused) + '"]') : null;
      if (back) back.focus();
      if (offline) say("");
      offline = false;
    } catch {
      offline = true;
      say("The harness is not answering. This page tries again every few seconds.");
    }
    loading = false;
    if (document.visibilityState !== "visible") return;
    timer = setTimeout(poll, again ? 0 : 2000);
    again = false;
  }

  document.addEventListener("visibilitychange", poll);
  poll();
}
`;

const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; script-src ${hash(SCRIPT)}; style-src ${hash(STYLE)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

// title and attrs arrive escaped.
function page(title: string, attrs: string, body: string): Response {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${STYLE}</style></head><body ${attrs}><main>${body}</main><script>${SCRIPT}</script></body></html>`;
  return new Response(doc, { headers: HEADERS });
}

// The page an agent window opens on, titled with its assignment's name,
// which labels the window for the user (and adopt in background.js finds).
function spacePage(url: URL): Response {
  const id = url.searchParams.get("id") ?? "";
  const name = html(url.searchParams.get("name") ?? "agent");
  return page(name, `data-kind="space" data-id="${html(id)}" data-secret="${secretOf(`space:${id}`)}"`, [
    `<header><h1>${name}</h1><p id="who"></p></header>`,
    `<div class="bar"><p id="status" class="status" aria-live="polite">Loading</p><div id="controls" class="controls"></div></div>`,
    `<p id="note" class="note" aria-live="polite"></p>`,
    `<h2>Tabs in this window</h2><ul id="tabs" class="rows"></ul>`,
    `<h2>What it did</h2><ol id="calls" class="rows"></ol>`,
    `<p class="foot">This window holds the tabs of this task. It closes when the task ends.</p>`,
  ].join(""));
}

// ---------- routes ----------

// Web pages can reach localhost too. These routes answer local programs
// (no Origin, like /rpc) and this server's own pages: same origin, under a
// loopback name, which a DNS name rebound to 127.0.0.1 is not.
function admitted(req: Request, url: URL): boolean {
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) return false;
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || (site === "none" && req.method === "GET");
}

function refused(req: Request, url: URL): Response {
  console.log(`[safari-harness] refused ${req.method} ${url.pathname} for ${url.host}, origin ${req.headers.get("origin") ?? "(none)"}, site ${req.headers.get("sec-fetch-site") ?? "(none)"}`);
  return new Response("forbidden", { status: 403 });
}

const ROUTES: Record<string, (req: Request, url: URL) => Response | Promise<Response>> = {
  "GET /space": (_req, url) => spacePage(url),
  "GET /space/state": (_req, url) => spaceState(url),
  "POST /space/control": (req) => spaceControl(req),
  "GET /agents": () => page("Agents in Safari", `data-kind="agents" data-secret="${secretOf("agents")}"`, [
    `<header><h1>Agents in Safari</h1><p>Every agent that used Safari in the last hour.</p></header>`,
    `<p id="note" class="note" aria-live="polite"></p>`,
    `<ul id="agents" class="agents"></ul>`,
  ].join("")),
  "GET /agents.json": async () => json(await overview()),
  "POST /agents/control": (req) => agentsControl(req),
};

// The answer to one of this file's routes; undefined for any other request.
export async function missionRoute(req: Request, url: URL): Promise<Response | undefined> {
  const route = ROUTES[`${req.method} ${url.pathname}`];
  if (!route) return undefined;
  if (!admitted(req, url)) return refused(req, url);
  return route(req, url);
}
