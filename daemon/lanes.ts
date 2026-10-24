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
  eval: always,
  fetch: (a) => {
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

const EXTRA_EFFECTS: Record<string, true> = { real_input: true, close: true, window: true, activate: true, select_tab: true, type_mark: true, press_mark: true, replay: true, download: true };

export function affectsPage(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "native_preflight" && args.expected !== undefined || tool === "video" && (args.do === undefined || args.do === "inspect")) return false;
  return acts(tool, args) || Object.hasOwn(EXTRA_EFFECTS, tool) || tool === "cookies" && (args.do === "set" || args.do === "clear");
}

type Holder = { tool: string; owner: number | undefined; since: number };
type Turn = { tool: string; owner: number | undefined; go: () => void };
type Lane = { holder: Holder; waiting: Turn[] };

const lanes = new Map<number, Lane>();
const heldLanes = new AsyncLocalStorage<{ tab: number; lane: Lane; active: boolean; owner: number | undefined }[]>();

// What a call waited on for its turn: a lane here, its agent's last turn
// ending (tools.ts callTool), the daemon restarting (rpc.ts).
type Queue = { ms: number; on: string[] };
const queues = new AsyncLocalStorage<Queue>();

// Runs a call that arrived at arrived, which before waited for on, and
// notes its waits in its answer (withQueued).
export async function queuing(arrived: number, run: () => Promise<unknown>, before = 0, on = ""): Promise<unknown> {
  const queue: Queue = { ms: before, on: before > 0 ? [on] : [] };
  return withQueued(await queues.run(queue, run), queue.ms, queue.on.join(", "), arrived);
}

// A call that waited a second or more for its turn says how long, on what,
// and when it arrived, in a note every answer's text shows: on 10-22 three
// calls sent together each took 64 s, one a wait whose answer said 48 ms,
// and nothing told where the time went. An answer that is not an object
// (a list, a text) keeps its shape.
export function withQueued(result: unknown, ms: number, on: string, arrived: number): unknown {
  if (ms < 1000 || !result || typeof result !== "object" || Array.isArray(result)) return result;
  const text = `this call waited ${Math.round(ms / 1000)} s for its turn (${on}), from ${new Date(arrived).toISOString().slice(11, 19)} UTC`;
  const had = "note" in result ? result.note : undefined;
  return { ...result, note: had === undefined ? text : `${String(had)}; ${text}` };
}

// Runs a call, in its tab's lane when it acts, after the acting calls
// already queued on that tab. A tab that does not resolve gets no lane:
// the tool reports its own error.
export async function inLane<T>(tool: string, args: Record<string, unknown>, resolve: (tab: unknown) => Promise<number>, run: () => Promise<T>): Promise<T> {
  if (!acts(tool, args)) return run();
  const tab = await resolve(args.tab).catch(() => undefined);
  if (tab === undefined) return run();
  const inherited = heldLanes.getStore() ?? [];
  const held = inherited.find((held) => held.active && held.tab === tab && held.lane === lanes.get(tab) && held.owner === currentOwner());
  if (held) return run();
  const asked = Date.now();
  const before = lanes.get(tab)?.holder.tool;
  const lane = await enter(tab, tool, currentOwner());
  const queue = queues.getStore();
  if (queue && before !== undefined) {
    queue.ms += Date.now() - asked;
    queue.on.push(`tab ${tab}'s ${before}`);
  }
  const scope = { tab, lane, active: true, owner: currentOwner() };
  try {
    return await heldLanes.run([...inherited, scope], run);
  } finally {
    scope.active = false;
    leave(tab, lane);
  }
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
