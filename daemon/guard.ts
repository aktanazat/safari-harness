// Calls a model wrote, checked and watched.
//
// Forgiving arguments: a near miss of a name (browsing-history for
// browsing_history, value for select's option) runs, with a note saying
// what was used, and a name no tool takes fails in the same call with the
// nearest real one instead of being ignored. On 01a0da2f two run steps
// failed on go for do and value for option; on 01a0e50b an agent searched
// Messages with query instead of text.
//
// The loop guard: an agent that makes one call over and over and gets the
// same answer each time is stopped with a next step, and one that sleeps
// in a loop is told to wait on the page instead. On 01a0e20a an agent slept
// 98 times, 829 s in all.
//
// Calls the harness makes itself (the REPL's locators, the tab group
// keeper, the site kits) poll on purpose and name their options exactly,
// so neither applies to them.

import { AsyncLocalStorage } from "node:async_hooks";
import { acts } from "./lanes.ts";
import { READS } from "./map.ts";
import { currentOwner } from "./owner.ts";
import { waitsOnPage } from "./receipt.ts";
import type { Tool } from "./tools.ts";

// Names as a model may write them: in another case, or with - or _ between
// the words (browsing-history, max_bytes).
const squash = (name: string) => name.toLowerCase().replace(/[-_]/g, "");

// The one of names that name means: itself, or itself written another way.
export function nameIn(names: string[], name: string): string | undefined {
  return names.includes(name) ? name : names.find((n) => squash(n) === squash(name));
}

// Names models reach for that the tools spell otherwise. Each is taken only
// by a tool that has the second name and not the first: history's do,
// select's option, imessage_search's text. action, code, note, mode, and
// js each failed a call in the 09-27 to 09-29 logs.
const ALIASES: [string, string][] = [["go", "do"], ["action", "do"], ["value", "option"], ["query", "text"], ["code", "expression"], ["js", "expression"], ["note", "fact"], ["mode", "what"]];

// Tools that take the options of the tools they run: map gives each page's
// read the options map does not take itself (map.ts).
const PASSES: Record<string, string[]> = { map: READS };

export type Checked = { tool: string; args: Record<string, unknown>; notes: string[] };

// The tool and arguments a call means. A model's call may name either in
// another way, and each one taken so is noted; a name the tool does not
// take fails the call. Calls the harness makes itself are taken as written.
export function checkCall(tools: Record<string, Tool>, name: string, given: Record<string, unknown>, model: boolean): Checked {
  const names = Object.keys(tools);
  const tool = model ? nameIn(names, name) : Object.hasOwn(tools, name) ? name : undefined;
  if (tool === undefined) {
    const listed = names.filter((n) => !tools[n].hidden);
    const near = nearest(name, listed);
    throw new Error(`unknown tool ${name}; ${near ? `did you mean ${near}? ` : ""}tools: ${listed.join(", ")}`);
  }
  if (!model) return { tool, args: given, notes: [] };
  const notes = tool === name ? [] : [`used ${tool} for ${name}`];
  const params = Object.keys(tools[tool].params);
  const takes = (t: string) => [...Object.keys(tools[t].params), ...Object.keys(tools[t].unlisted ?? {})];
  const known = [...takes(tool), ...(PASSES[tool] ?? []).flatMap(takes)];
  const aliases = ALIASES.filter(([alias, real]) => params.includes(real) && !known.includes(alias));
  const args: Record<string, unknown> = {};
  const from: Record<string, string> = {};
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined) continue;
    // A run gives every step the tab its open step made, whether or not
    // the step's tool takes one.
    const real = nameIn(known, key) ?? aliases.find(([alias]) => alias === key)?.[1] ?? (key === "tab" ? key : undefined);
    if (real === undefined) {
      const near = nearest(key, [...params, ...aliases.map(([alias]) => alias)]);
      throw new Error(`unknown parameter ${key} for ${tool}${near ? `; did you mean ${near}?` : ""} (params: ${params.join(", ") || "none"})`);
    }
    if (Object.hasOwn(args, real)) throw new Error(`${from[real]} and ${key} both name ${real} for ${tool}; pass one`);
    if (real !== key) notes.push(`used ${real} for ${key}`);
    args[real] = value;
    from[real] = key;
  }
  return { tool, args, notes };
}

// The one of names a slip away from name: at most two letters added,
// dropped, or changed, and fewer than it has.
function nearest(name: string, names: string[]): string | undefined {
  let best: string | undefined;
  let least = 3;
  for (const n of names) {
    const d = distance(squash(name), squash(n));
    if (d < least && d < n.length) {
      best = n;
      least = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// A result with a line for the model beside it: a note on how its call was
// taken, or a hint at a better next call. A result that already has one
// keeps it after the new one.
export function beside(result: unknown, key: "note" | "hint", text: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { [key]: text, value: result };
  const had = key in result ? result[key] : undefined;
  if (had === undefined) return { ...result, [key]: text };
  return typeof had === "string" ? { ...result, [key]: `${text}; ${had}` } : { [key]: text, value: result };
}

// Whether the call running now is a model's: its own, or a step of its run.
const byModel = new AsyncLocalStorage<boolean>();
export const fromModel = () => byModel.getStore() === true;

// Runs a checked call, and for a model's, watches it for loops and adds
// the notes its check made.
export async function guard(call: Checked, model: boolean, run: () => Promise<unknown>): Promise<unknown> {
  const owner = model ? currentOwner() : undefined;
  const result = await byModel.run(model, () => (owner === undefined ? run() : watch(call, owner, run)));
  return call.notes.length ? beside(result, "note", call.notes.join("; ")) : result;
}

// The sixth call in a row with the same arguments and the same answer, in
// 3 minutes, fails: five is past any polling that works, and a page that
// changes gives a new answer, which starts the count again.
const REPEATS = 6;
const REPEAT_MS = 3 * 60_000;
// Sleeps past a minute in 10 minutes get a hint to wait on the page.
const SLEEP_BUDGET_MS = 60_000;
const SLEEP_MS = 10 * 60_000;

type Streak = { outcome: string; times: number[] };
// Each owner's streaks, by call, and the last action it took. A new action
// (the next field typed, another button) is progress, so the checks after
// it count again from one; the same action again is part of the loop.
type Watch = { act: string | undefined; at: number; calls: Map<string, Streak> };
const watches = new Map<number, Watch>();
const sleeps = new Map<number, { at: number; ms: number }[]>();

// Tools never stopped: wait and handoff are how an agent waits for a page
// or the user, and a run's steps are watched one by one.
const UNWATCHED = new Set(["run", "wait", "handoff_wait"]);
// Reads whose answer is the page itself.
const PAGE_READS = new Set(["snapshot", "extract", "info"]);

async function watch({ tool, args }: Checked, owner: number, run: () => Promise<unknown>): Promise<unknown> {
  const now = Date.now();
  sweep(now);
  if (tool === "wait") return slept(owner, args, now, await run());
  if (UNWATCHED.has(tool)) return run();
  const key = `${tool} ${Bun.hash(stable(args))}`;
  const seen = watches.get(owner) ?? { act: undefined, at: now, calls: new Map<string, Streak>() };
  watches.set(owner, seen);
  seen.at = now;
  // An action's answer says it ran, not what the page did, so the same
  // answer from one is no sign of a loop; the same error is.
  const acting = acts(tool, args);
  if (acting && seen.act !== key) {
    seen.act = key;
    seen.calls.clear();
  }
  let result: unknown;
  try {
    result = await run();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (repeat(seen.calls, key, `error ${error}`, now) >= REPEATS) throw new Error(`${called(tool, args)} and got the same error (${error}); trying again will not change it: try another way, or tell the user`);
    throw e;
  }
  const times = repeat(seen.calls, key, acting ? "acted" : `value ${Bun.hash(stable(result))}`, now);
  if (acting || times < REPEATS) return result;
  throw new Error(PAGE_READS.has(tool)
    ? `${called(tool, args)} and got the same page; the page is not changing: act, wait on text, or tell the user`
    : `${called(tool, args)} and got the same answer; nothing is changing: act, wait on text, or tell the user`);
}

function called(tool: string, args: Record<string, unknown>): string {
  return `you called ${tool}${args.tab === undefined ? "" : ` on tab ${String(args.tab)}`} ${REPEATS - 1} times`;
}

// How many calls in a row, this one included, had this outcome.
function repeat(calls: Map<string, Streak>, key: string, outcome: string, now: number): number {
  const last = calls.get(key);
  const times = last && last.outcome === outcome ? last.times.filter((t) => now - t < REPEAT_MS).slice(1 - REPEATS) : [];
  times.push(now);
  calls.set(key, { outcome, times });
  return times.length;
}

// A wait with only ms names nothing the agent waits for. Its time counts
// toward the owner's budget; past it, the answer carries the hint.
function slept(owner: number, args: Record<string, unknown>, start: number, result: unknown): unknown {
  if (waitsOnPage(args)) return result;
  const now = Date.now();
  const recent = (sleeps.get(owner) ?? []).filter((s) => now - s.at < SLEEP_MS);
  recent.push({ at: now, ms: now - start });
  sleeps.set(owner, recent);
  const total = recent.reduce((sum, s) => sum + s.ms, 0);
  if (total <= SLEEP_BUDGET_MS) return result;
  return beside(result, "hint", `you slept ${Math.round(total / 1000)} s in the last 10 minutes; wait with text or selector instead: it returns as soon as the page shows it`);
}

// Forgets streaks and sleeps too old to count.
function sweep(now: number) {
  for (const [owner, seen] of watches) {
    if (now - seen.at >= REPEAT_MS) watches.delete(owner);
    else for (const [key, s] of seen.calls) if (now - s.times[s.times.length - 1] >= REPEAT_MS) seen.calls.delete(key);
  }
  for (const [owner, list] of sleeps) if (list.every((s) => now - s.at >= SLEEP_MS)) sleeps.delete(owner);
}

// JSON with every object's keys in order, so equal values hash the same.
function stable(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v)) ?? "undefined";
}
