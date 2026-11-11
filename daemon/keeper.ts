// The tab group keeper: it makes an agent window (spaces.ts) that holds
// several of its agent's tabs a Safari tab group named for its task once the
// user has left the keyboard and mouse alone, and deletes the group when the
// task ends. It runs from the agent's
// terminal, whose Accessibility permission the steps need and the daemon
// lacks: call.ts starts it, detached, after an open whose window is to be a
// group or is one, and one keeper at a time does the work (the helper's
// lock). It asks the daemon what to do through the hidden space tool, and
// exits once no window waits or is a group and the queue holds nothing it
// may still delete.
//
// groups.ts decides every step on Safari's controls; here, besides, his
// front app is read before and after each: a step that ends with Safari in
// front turns group work off and gives him his app back.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { alive, changeQueue, check, deleteGroup, deletesOff, files, groupsOff, guarded, makeGroup, readQueue, startHelper, turnOff, type Answer, type Gate, type Helper, type Outcome } from "./groups.ts";
import { trimLog } from "./journal.ts";
import { rpc } from "./rpc.ts";

// A window as the space tool's state lists it; tabs, the extension's count
// of them in it, only while Safari runs.
export type SpaceState = { name: string; width: number; height: number; tabs?: number; group: "waiting" | "making" | "grouped" | "plain"; ended: boolean; owner?: number };
export type Daemon = (op: string, args?: Record<string, unknown>) => Promise<unknown>;
type Log = (line: string) => void;

const LOOP_MS = 3000;
// A group a delete left queued is tried again this long after, and not
// before, so a failing step does not open Safari's menus every pass. On
// 10-07 each group so left went at a later keeper's first try, but the
// keeper of a running agent's groups never tried again: agent 8780's stood
// in his sidebar for hours.
const RETRY_MS = 10 * 60_000;
// A delete that waits (the user came back, a tab opening) goes again this
// long after, then twice as long each time it waits again, up to RETRY_MS.
// Before, a wait went again the next pass, and said nothing: on 11-06 16
// ended groups waited so every 3 s for days, with no line in keeper.log.
const WAIT_MS = 30_000;
// After this many deletes from a window opened for it fail, an exited
// agent's group whose own window is gone is the user's: on 11-06 18 such
// groups stood in the daemon's records since 11-02.
const SCRATCH_TRIES = 3;
// A raise begun this long before a step can land after its first look.
const RAISE_MS = 2000;
const SAFARI = "com.apple.Safari";
const INPUT = join(import.meta.dir, "..", "scripts", "input");

const stop = (why: string): Outcome => ({ done: false, why, wait: false });

// The window on screen: the one Safari window of its size, holding as many
// tabs as the extension counts in it. Another count (a tab opening
// meanwhile) waits. Safari draws no tab bar for a plain window of one tab,
// where the helper counts none: a window opened to delete from (scratch)
// holds only its page, and every delete from one waited (11-06).
async function windowOf(h: Helper, s: { width: number; height: number; tabs?: number }): Promise<number | Outcome> {
  const found = (await h("find", { width: s.width, height: s.height })) as Answer & { window?: number };
  if (!found.ok || found.window === undefined) return stop(found.error ?? "its window is not on screen");
  const state = (await h("state", { window: found.window })) as Answer & { tabs?: number };
  const tabs = state.tabs === 0 && s.tabs === 1 ? 1 : state.tabs;
  if (tabs !== s.tabs) return { done: false, why: `the window of its size holds ${state.tabs} tabs, not ${s.tabs}`, wait: true };
  return found.window;
}

// A step on Safari's controls, with his front app read before and after.
// Safari in front after it is the step's doing, unless someone else
// brought it forward meanwhile: the user (the step posts no keys or mouse,
// so he touched them), or an agent's call for him (activate, a handoff).
// Then it stays in front for him. Nor is it when his app quit meanwhile,
// its own quit giving Safari the front (11-11). deletes: whether the flag
// it raises then stops deletes too, or makes only.
async function step(h: Helper, daemon: Daemon, what: string, log: Log, run: () => Promise<Outcome>, deletes = true): Promise<Outcome> {
  const since = Date.now();
  const before = (await h("gate")) as Answer & Gate;
  const outcome = await run();
  const after = (await h("gate")) as Answer & Gate;
  log(`${what}: ${outcome.done ? "done" : outcome.why}; front app ${before.front}, then ${after.front}`);
  if (after.front === before.front || after.front !== SAFARI) return outcome;
  if (after.idleMs <= Date.now() - since) return outcome;
  const raised = (await daemon("raised")) as { at: number };
  if (raised.at >= since - RAISE_MS) return outcome;
  if (await ended(before.frontPid)) {
    log(`${what}: ${before.front} quit meanwhile`);
    return outcome;
  }
  turnOff(`Safari came to the front while ${what}`, deletes);
  spawnSync(INPUT, ["activate", before.front]);
  // A step done stays done: on 10-22 agent 42229's group, deleted, was
  // left queued as if it were still there.
  return outcome.done ? outcome : { ...outcome, ...stop(groupsOff()!) };
}

// An app that quits gives up the front about 30 ms before its process
// ends (11-11), so the process is given 500 ms to end; a real steal waits
// that long for its flag. An ended process its parent has not waited for
// still answers kill(pid, 0), so ps reads its state.
async function ended(pid: number): Promise<boolean> {
  if (!pid) return false;
  const gone = () => /^(Z|$)/.test(spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
  for (let waited = 0; waited < 500 && !gone(); waited += 50) await Bun.sleep(50);
  return gone();
}

// A waiting window becomes its task's group. The daemon holds the window
// open from making until the outcome is told, since its agent may exit
// meanwhile. Its queue entry goes in first, so a keeper stopped midway
// leaves the group queued.
async function convert(h: Helper, daemon: Daemon, s: SpaceState, log: Log): Promise<boolean> {
  const window = await windowOf(h, s);
  let outcome = window;
  if (typeof window === "number") {
    // It ended since the state was read: there is nothing to make.
    if (!((await daemon("making", { name: s.name })) as { ok: boolean }).ok) return false;
    changeQueue((q) => {
      q[s.name] = { owner: s.owner, since: Date.now() };
    });
    outcome = await step(h, daemon, `making ${s.name}`, log, () => makeGroup(h, window, s.name), false);
    // No group was made, unless group work turned off on the way.
    if (!outcome.done && !groupsOff()) changeQueue((q) => delete q[s.name]);
  }
  if (typeof outcome === "number") return true;
  // A group a failed make left stays queued: its window goes on as a
  // group's, so its record waits, as a group's, for the delete. Told plain,
  // agent 41120's window 6 and agent 22996's became groups no keeper could
  // delete (10-27, 10-29).
  if (outcome.done || outcome.left) await daemon("grouped", { name: s.name });
  else if (outcome.wait) await daemon("waiting", { name: s.name });
  else await daemon("plain", { name: s.name, why: outcome.why });
  return outcome.done || outcome.wait;
}

// Deletes the group from window's sidebar, then closes the window: its own,
// or a scratch one, closed after every try. Whether to try again next pass:
// never, since what is left goes in given. A group holding pages is the
// user's, and leaves the queue; one whose step waits goes again after its
// wait (WAIT_MS on); anything else leaves the group queued, for RETRY_MS.
// An exited agent's group a scratch window failed SCRATCH_TRIES times is
// the user's.
async function deleteFrom(h: Helper, daemon: Daemon, s: SpaceState, window: number | Outcome, scratch: boolean, given: Given, log: Log): Promise<boolean> {
  const { name } = s;
  const outcome = typeof window === "number" ? await step(h, daemon, `deleting ${name}`, log, () => deleteGroup(h, window, name)) : window;
  if (typeof window === "number" && (outcome.done || scratch)) await h("close", { window });
  const had = given.get(name);
  const scratches = (had?.scratches ?? 0) + (scratch ? 1 : 0);
  const leave = !outcome.done && !outcome.pages && scratch && scratches >= SCRATCH_TRIES && (s.owner === undefined || !alive(s.owner));
  if (outcome.done || outcome.pages || leave) {
    if (!outcome.done) log(`left ${name} to the user: ${leave ? `its agent exited, its window is gone, and ${scratches} deletes from a window opened for it failed; the last: ` : ""}${outcome.why}`);
    await daemon("gone", { name });
    changeQueue((q) => delete q[name]);
    given.delete(name);
    return false;
  }
  if (outcome.wait) {
    const waits = (had?.waits ?? 0) + 1;
    if (waits === 1) log(`${name} waits: ${outcome.why}`);
    given.set(name, { at: Date.now(), held: false, waits, scratches });
    return false;
  }
  log(`left ${name} queued: ${outcome.why}`);
  given.set(name, { at: Date.now(), held: false, scratches });
  return false;
}

// A group whose own window is gone goes from a window opened for it.
async function fromScratch(h: Helper, daemon: Daemon, s: SpaceState, given: Given, log: Log): Promise<boolean> {
  const scratch = (await daemon("scratch")) as SpaceState & { ok: boolean };
  if (!scratch.ok) return true;
  return deleteFrom(h, daemon, s, await windowOf(h, scratch), true, given, log);
}

// An ended task's group: the tabs for the user leave its window, then the
// group goes with the page, from a window opened for it when its own is
// gone. A tab that would not leave keeps the group, and it stays queued.
// pass: this keeper pass, whose releases share one list of Safari's tabs.
async function clear(h: Helper, daemon: Daemon, s: SpaceState, pass: string, given: Given, log: Log): Promise<boolean> {
  const { name } = s;
  const released = (await daemon("release", { name, pass })) as { ok: boolean; tabs?: number; left?: number; width?: number; height?: number };
  if (!released.ok) return true;
  if (released.left) {
    log(`left ${name} queued: ${released.left} of its tabs would not move out`);
    given.set(name, { at: Date.now(), held: true });
    return false;
  }
  if (!released.tabs || released.width === undefined || released.height === undefined) return fromScratch(h, daemon, s, given, log);
  return deleteFrom(h, daemon, s, await windowOf(h, { width: released.width, height: released.height, tabs: released.tabs }), false, given, log);
}

// One look at the windows and the queue; whether there is more to watch.
// given: when this keeper last left each group queued, which it tries
// again once its wait is over: RETRY_MS, or after waits waits a shorter
// one; held: a tab of his would not leave it, and only the next keeper
// tries again (on 11-06 one keeper retried two such groups every 10 min
// for 17 hours); scratches: how many deletes from a scratch window failed.
export type Given = Map<string, { at: number; held: boolean; waits?: number; scratches?: number }>;
const retrying = (given: Given) => [...given.values()].some((g) => !g.held);
const due = (g: { at: number; held: boolean; waits?: number }, now: number) => !g.held && now - g.at >= (g.waits ? Math.min(WAIT_MS * 2 ** (g.waits - 1), RETRY_MS) : RETRY_MS);
export async function pass(h: Helper, daemon: Daemon, given: Given, log: Log): Promise<boolean> {
  const now = Date.now();
  const id = randomUUID();
  const { connected, spaces } = (await daemon("state", { pass: id })) as { connected: boolean; spaces: SpaceState[] };
  const queue = Object.entries(readQueue());
  const known = new Set(spaces.map((s) => s.name));
  // Queued groups the daemon no longer knows, their agents exited: their
  // tabs are unseen, so the daemon refuses them, and they are the user's.
  // Kept queued, two (10-27, 10-29) stood in his sidebar for days while
  // every pass asked for them again.
  const running = (owner?: number) => owner !== undefined && alive(owner);
  for (const [name, e] of queue) {
    if (known.has(name) || running(e.owner)) continue;
    log(`left ${name} to the user: the daemon has no window for it, so its tabs are unseen`);
    changeQueue((q) => delete q[name]);
  }
  const watching = spaces.some((s) => !s.ended && s.group === "grouped") || queue.some(([name, e]) => !known.has(name) && running(e.owner));
  // A group the daemon no longer lists as ended is none of this keeper's.
  for (const name of given.keys()) if (!spaces.some((s) => s.ended && s.name === name)) given.delete(name);
  // A live window still making is a stopped keeper's: this one tells each
  // outcome before its pass ends.
  const todo = [...spaces.filter((s) => { const g = given.get(s.name); return s.ended && (!g || due(g, now)); }), ...spaces.filter((s) => !s.ended && (s.group === "waiting" || s.group === "making"))];
  // A group a failed delete left queued is tried again by this keeper, as
  // no other starts until an agent opens a window: on 10-30 window 5 waited
  // 55 min. One his tab holds waits for the next keeper: he may keep that
  // tab for days.
  if (todo.length === 0) return watching || retrying(given);
  // Asking a quit Safari anything would start it again.
  if (!connected) return true;
  const gate = await check(h);
  if ("done" in gate) {
    if (gate.wait) return true;
    // No permission, or no helper: windows stay plain and say why, and
    // groups stay queued.
    for (const s of todo) if (!s.ended) await daemon("plain", { name: s.name, why: gate.why });
    return false;
  }
  // Off, a waiting window stays plain and says why, and a stopped keeper's
  // making one is looked at, as it may be a group already; ended groups
  // still go unless the flag stops deletes too.
  let more = watching;
  for (const s of todo) {
    const off = groupsOff();
    if (s.ended) {
      if (!deletesOff()) more = (await clear(h, daemon, s, id, given, log)) || more;
    } else if (off && s.group === "waiting") await daemon("plain", { name: s.name, why: off });
    else more = (await convert(h, daemon, s, log)) || more;
  }
  return more || retrying(given);
}

if (import.meta.main) {
  // a few lines a day on 10-21; a log that only grows still fills a disk
  trimLog(files.log, 1000);
  const { helper, stop: stopHelper } = startHelper();
  const log: Log = (line) => {
    mkdirSync(dirname(files.log), { recursive: true });
    appendFileSync(files.log, `${new Date().toISOString()} ${line}\n`);
  };
  const daemon: Daemon = (op, args = {}) => rpc("space", { ...args, op });
  const given: Given = new Map();
  const locked = await helper("lock", { ms: 0 });
  try {
    if (locked.ok) {
      writeFileSync(files.keeper, String(process.pid));
      const h = guarded(helper);
      while (await pass(h, daemon, given, log)) await Bun.sleep(LOOP_MS);
    } else if (!(await helper("gate")).ok) {
      // No helper to lock with: one pass tells each waiting window why.
      await pass(helper, daemon, given, log);
    }
  } catch (e) {
    log(`stopped: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (locked.ok) rmSync(files.keeper, { force: true });
    stopHelper();
  }
}
