// Per-tab lanes: one acting call at a time on a tab. Two callers driving
// one tab at once undo each other: on 01a0e20a two script runs collided on
// a tab, costing 54 s and a 26 s rerun. An acting call takes its tab's lane
// for as long as it runs; another acting call on that tab waits its turn,
// up to 10 s, then fails naming the holder. Reads never wait, and neither
// do wait and handoff, which only watch the page. A run takes no lane of
// its own, so its steps take theirs one at a time.

import { currentOwner, processName } from "./owner.ts";

// Longer than an action takes, shorter than a page load: a caller behind a
// goto or an upload hears who holds the tab instead of waiting it out.
const WAIT_MS = 10_000;

const always = () => true;

// The tools that change a page, and the steps of three that sometimes do
// (upload's find only lists files).
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
  scroll: always,
  login_fill: always,
  card_fill: always,
  autofill: always,
  passwords: (a) => a.do === "fill" || a.do === "code",
  dialog: (a) => a.do === "accept" || a.do === "dismiss",
};

// Whether a call changes its tab's page.
export const acts = (tool: string, args: Record<string, unknown>) => Object.hasOwn(ACTING, tool) && ACTING[tool](args);

type Holder = { tool: string; owner: number | undefined; since: number };
type Turn = { tool: string; owner: number | undefined; go: () => void };
type Lane = { holder: Holder; waiting: Turn[] };

const lanes = new Map<number, Lane>();

// Runs a call, in its tab's lane when it acts, after the acting calls
// already queued on that tab. A tab that does not resolve gets no lane:
// the tool reports its own error.
export async function inLane<T>(tool: string, args: Record<string, unknown>, resolve: (tab: unknown) => Promise<number>, run: () => Promise<T>): Promise<T> {
  if (!acts(tool, args)) return run();
  const tab = await resolve(args.tab).catch(() => undefined);
  if (tab === undefined) return run();
  const lane = await enter(tab, tool, currentOwner());
  try {
    return await run();
  } finally {
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
