// Per-tab lanes: one acting call at a time on a tab. Two callers driving
// one tab at once undo each other: on 01a0e20a two script runs collided on
// a tab, costing 54 s and a 26 s rerun. An acting call takes its tab's lane
// for as long as it runs; another acting call on that tab waits its turn,
// up to 10 s, then fails naming the holder. Reads never wait, and neither
// do wait and handoff, which only watch the page. A run takes no lane of
// its own, so its steps take theirs one at a time.

import { AsyncLocalStorage } from "node:async_hooks";
import { currentOwner, processName } from "./owner.ts";

// Longer than an action takes, shorter than a page load: a caller behind a
// goto or an upload hears who holds the tab instead of waiting it out.
const WAIT_MS = 10_000;

const always = () => true;

const ACTING: Record<string, (a: Record<string, unknown>) => boolean> = {
  click: always,
  type: always,
  press: always,
  select: always,
  hover: always,
  goto: always,
  history: always,
  upload: (a) => a.find === undefined,
  // read: a site kit's request that only reads (Slack's history goes out
  // as a POST from its page) and so can run twice: it takes no lane, and
  // losing its answer holds no retry (mission.ts checkAction). On 11-04 a
  // lost answer to one blocked every Slack read after it (MineSessionD-7).
  eval: (a) => a.read !== true,
  fetch: (a) => {
    if (a.read === true) return false;
    const method = String(a.method ?? "GET").toUpperCase();
    return a.body !== undefined || (method !== "GET" && method !== "HEAD");
  },
  scroll: always,
  login_fill: always,
  card_fill: always,
  autofill: always,
  passwords: (a) => a.do === "fill" || a.do === "code" || a.do === "change" || a.do === "change-type",
  dialog: (a) => a.do === "accept" || a.do === "dismiss",
  react: (a) => a.do === "enable" || a.do === "disable",
  site_actions: (a) => a.do === "enable" || a.do === "disable" || a.do === "call",
  video: always,
  native_preflight: always,
};

// Whether a call changes its tab's page.
export const acts = (tool: string, args: Record<string, unknown>) => Object.hasOwn(ACTING, tool) && ACTING[tool](args);

const EXTRA_EFFECTS: Record<string, true> = { real_input: true, close: true, window: true, activate: true, select_tab: true, type_mark: true, press_mark: true, replay: true };

export function affectsPage(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "native_preflight" && args.expected !== undefined || tool === "video" && (args.do === undefined || args.do === "inspect")) return false;
  // A download clicks only by ref alone; by url, or of the file its tab
  // shows, it fetches (download in tools.ts). On 11-05 a url's save into a
  // folder failed EISDIR, and its retry with a file path was refused as a
  // repeat of an action that may have happened (MineSessionE-4).
  if (tool === "download") return args.ref !== undefined && args.url === undefined && args.urls === undefined;
  return acts(tool, args) || Object.hasOwn(EXTRA_EFFECTS, tool) || tool === "cookies" && (args.do === "set" || args.do === "clear");
}

type Holder = { tool: string; owner: number | undefined; since: number };
type Turn = { tool: string; owner: number | undefined; go: () => void };
type Lane = { holder: Holder; waiting: Turn[] };

const lanes = new Map<number, Lane>();
const heldLanes = new AsyncLocalStorage<{ tab: number; lane: Lane; active: boolean; owner: number | undefined }[]>();

// Each tab's acting calls, by owner, in order of arrival: those still out,
// and while a read of the tab is out, those that ended since. A read sees
// the actions its own agent sent before or alongside it. On 11-08 a type
// of "20" and a snapshot sent together on a billing page ran snapshot
// first; it showed the old 25 and the agent concluded the typing was
// ignored.
type Action = { tool: string; owner: number | undefined; seq: number; ended: boolean; done: Promise<void> };
const actions = new Map<number, Action[]>();
const readers = new Map<number, number>();
let arrivals = 0;

// The reads that wait for their agent's actions on the tab, and are asked
// again when one arrives while they run.
const ORDERED_READS: Record<string, true> = { snapshot: true, extract: true, eval: true, data: true, element: true, info: true };

function forgetEnded(tab: number) {
  if (readers.has(tab)) return;
  const out = (actions.get(tab) ?? []).filter((a) => !a.ended);
  if (out.length) actions.set(tab, out);
  else actions.delete(tab);
}

// What a call waited on for its turn: a lane here, its agent's last turn
// ending (tools.ts callTool), the daemon restarting (rpc.ts). order names
// a call of the same agent that took the tab first, however short the wait.
type Queue = { ms: number; on: string[]; order?: string };
const queues = new AsyncLocalStorage<Queue>();

// Runs a call that arrived at arrived, which before waited for on, and
// notes its waits in its answer (withQueued).
export async function queuing(arrived: number, run: () => Promise<unknown>, before = 0, on = ""): Promise<unknown> {
  const queue: Queue = { ms: before, on: before > 0 ? [on] : [] };
  return withQueued(await queues.run(queue, run), queue.ms, queue.on.join(", "), arrived, queue.order);
}

// A call that waited a second or more for its turn says how long, on what,
// and when it arrived, in a note every answer's text shows: on 10-22 three
// calls sent together each took 64 s, one a wait whose answer said 48 ms,
// and nothing told where the time went. An answer that is not an object
// (a list, a text) keeps its shape.
export function withQueued(result: unknown, ms: number, on: string, arrived: number, order?: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const notes = [
    ...(order === undefined ? [] : [order]),
    ...(ms < 1000 ? [] : [`this call waited ${Math.round(ms / 1000)} s for its turn (${on}), from ${new Date(arrived).toISOString().slice(11, 19)} UTC`]),
  ];
  if (!notes.length) return result;
  const text = notes.join("; ");
  const had = "note" in result ? result.note : undefined;
  return { ...result, note: had === undefined ? text : `${String(had)}; ${text}` };
}

// Runs a call, in its tab's lane when it acts, after the acting calls
// already queued on that tab. A tab that does not resolve gets no lane:
// the tool reports its own error.
export async function inLane<T>(tool: string, args: Record<string, unknown>, resolve: (tab: unknown) => Promise<number>, run: () => Promise<T>): Promise<T> {
  // extract's expand and scroll, and the repl's harvest, click and scroll
  // the page as they read it: they take its lane, as acting calls do, yet
  // stay reads for everything affectsPage decides.
  const gathers = tool === "harvest" || (tool === "extract" && (args.expand === true || args.scroll === true));
  if (!acts(tool, args) && !gathers) return Object.hasOwn(ORDERED_READS, tool) ? afterActions(tool, args, resolve, run) : run();
  const tab = await resolve(args.tab).catch(() => undefined);
  if (tab === undefined) return run();
  const inherited = heldLanes.getStore() ?? [];
  const held = inherited.find((held) => held.active && held.tab === tab && held.lane === lanes.get(tab) && held.owner === currentOwner());
  if (held) return run();
  const owner = currentOwner();
  const { promise: done, resolve: finish } = Promise.withResolvers<void>();
  const action: Action = { tool, owner, seq: ++arrivals, ended: false, done };
  actions.set(tab, [...(actions.get(tab) ?? []), action]);
  try {
    const asked = Date.now();
    const before = lanes.get(tab)?.holder;
    const lane = await enter(tab, tool, owner);
    const queue = queues.getStore();
    if (queue && before !== undefined) {
      queue.ms += Date.now() - asked;
      queue.on.push(`tab ${tab}'s ${before.tool}`);
      if (owner !== undefined && before.owner === owner) queue.order = `ran after this agent's ${before.tool} on tab ${tab}, which arrived first; that ${before.tool} saw the page before this ${tool}`;
    }
    const scope = { tab, lane, active: true, owner };
    try {
      return await heldLanes.run([...inherited, scope], run);
    } finally {
      scope.active = false;
      leave(tab, lane);
    }
  } finally {
    action.ended = true;
    finish();
    forgetEnded(tab);
  }
}

// A read waits for the acting calls its own agent already sent on the tab,
// and one that arrives while the read waits or runs makes it run again once
// that action ends, so the answer shows the page after both. Other agents'
// reads never wait, nor does a read of the front tab, which would cost a
// listing of Safari's tabs to name. An action still out after ORDER_WAIT_MS
// (a click that waits for a page) is named in the answer instead.
const ORDER_WAIT_MS = 10_000;

async function ended(list: Action[]): Promise<boolean> {
  const { promise: late, resolve } = Promise.withResolvers<false>();
  const timer = setTimeout(() => resolve(false), ORDER_WAIT_MS);
  try {
    return await Promise.race([Promise.all(list.map((a) => a.done)).then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function afterActions<T>(tool: string, args: Record<string, unknown>, resolve: (tab: unknown) => Promise<number>, run: () => Promise<T>): Promise<T> {
  const owner = currentOwner();
  if (owner === undefined || !/^\d+$/.test(String(args.tab))) return run();
  const tab = await resolve(args.tab).catch(() => undefined);
  if (tab === undefined || (heldLanes.getStore() ?? []).some((held) => held.active && held.tab === tab)) return run();
  const mine = () => (actions.get(tab) ?? []).filter((a) => a.owner === owner);
  const names = (list: Action[]) => [...new Set(list.map((a) => a.tool))].join(" and ");
  const ahead = mine().filter((a) => !a.ended);
  const asked = arrivals;
  const notes: string[] = [];
  readers.set(tab, (readers.get(tab) ?? 0) + 1);
  let answer: T;
  try {
    if (ahead.length && !(await ended(ahead))) notes.push(`this agent's ${names(ahead)} on tab ${tab} was still running when this ${tool} answered`);
    answer = await run();
    const alongside = mine().filter((a) => a.seq > asked);
    if (alongside.length) {
      if (await ended(alongside)) {
        answer = await run();
        notes.push(`read again after this agent's ${names(alongside)} on tab ${tab}, which arrived while it ran`);
      } else notes.push(`this agent's ${names(alongside)} on tab ${tab} arrived while this ${tool} ran and was still running when it answered`);
    }
  } finally {
    const left = (readers.get(tab) ?? 1) - 1;
    if (left > 0) readers.set(tab, left);
    else readers.delete(tab);
    forgetEnded(tab);
  }
  return notes.length ? (withQueued(answer, 0, "", Date.now(), notes.join("; ")) as T) : answer;
}

function enter(tab: number, tool: string, owner: number | undefined): Promise<Lane> {
  const lane = lanes.get(tab);
  if (!lane) {
    const taken: Lane = { holder: { tool, owner, since: Date.now() }, waiting: [] };
    lanes.set(tab, taken);
    return Promise.resolve(taken);
  }
  const { promise, resolve, reject } = Promise.withResolvers<Lane>();
  const turn: Turn = {
    tool,
    owner,
    go: () => {
      clearTimeout(timer);
      resolve(lane);
    },
  };
  lane.waiting.push(turn);
  const timer = setTimeout(() => {
    lane.waiting.splice(lane.waiting.indexOf(turn), 1);
    busy(tab, lane.holder).then(reject, reject);
  }, WAIT_MS);
  return promise;
}

// The lane passes to the next call in line, or is gone.
function leave(tab: number, lane: Lane) {
  const next = lane.waiting.shift();
  if (!next) {
    lanes.delete(tab);
    return;
  }
  lane.holder = { tool: next.tool, owner: next.owner, since: Date.now() };
  next.go();
}

async function busy(tab: number, holder: Holder): Promise<Error> {
  const name = holder.owner === undefined ? undefined : await processName(holder.owner);
  const who = holder.owner === undefined ? "an unknown caller" : name ? `${name} pid ${holder.owner}` : `pid ${holder.owner}`;
  const held = Math.round((Date.now() - holder.since) / 1000);
  return new Error(`tab ${tab} is busy with ${holder.tool} from ${who} for ${held} s; wait or use your own tab`);
}
