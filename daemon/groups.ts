// Safari tab groups for agent windows: each task's tabs in a group of its
// own, named for it (his ask of 09-28). Safari gives extensions and
// AppleScript no tab groups, so scripts/spaces works the agent window's own
// sidebar through Accessibility, in the background, with Safari never
// activated; this file decides every step, and keeper.ts when to take one.
// Three rules hold throughout.
//
// He is away from the keys: a menu Safari opens draws over his app and
// takes what he types while it is open. A step that opens one goes ahead
// only once he has left the keyboard and mouse alone IDLE_MS, the screen
// unlocked and Safari behind, and stops if his front app has changed since
// the step began.
//
// A menu never stays open: every dismissal is read back within 500 ms,
// with one more Escape if the menu is still there (scripts/spaces.swift).
// If it still is, group work stops for good (the flag in files.off), and
// every later window stays plain, until someone who has looked removes it.
//
// Never guess which group: the sidebar's menu serves its selected row, so a
// delete goes ahead only with the one group of that exact name selected
// alone, the menu a group's, and a confirm sheet (a group with open tabs
// gets one) naming that group in full: agent-sweep is a prefix of
// agent-sweep-4. Anything else ends the menu, and the group stays queued.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export type Answer = Record<string, unknown> & { ok: boolean; error?: string; closed?: boolean };
export type Helper = (op: string, args?: Record<string, unknown>) => Promise<Answer>;
export type Gate = { idleMs: number; locked: boolean; front: string; safariActive: boolean; trusted: boolean };
type Row = { kind: string; name?: string; selected: boolean };
type Item = { id: string; title: string; enabled: boolean };
type Sheet = { text: string[]; buttons: string[] };
// why: what stopped it; wait: whether a later try may go (the user was at
// the keys), rather than one that would fail again.
export type Outcome = { done: true } | { done: false; why: string; wait: boolean };

// How long he has left the keyboard and mouse alone before a menu opens
// (Main's rule of 09-28).
export const IDLE_MS = 30_000;
// Safari selects a group's front tab a moment after the window shows it.
const SETTLE_MS = 600;
const DELETE = "DeleteTabGroupMenuItem";
const RENAME = "RenameTabGroupMenuItem";
// The item of the menu for a window's own tabs that makes them a group:
// "New Tab Group with This Tab" for one tab (measured 09-28), "with 2 Tabs"
// for more (measured 09-29). Safari gives it no id of its own.
const NEW_WITH = /^New Tab Group with (This Tab|\d+ Tabs?)$/;

export const HELPER = join(import.meta.dir, "..", "scripts", "spaces");

const STATE = join(homedir(), ".local", "share", "safari-harness");
// The group queue, the off flag, the running keeper's pid, and its log;
// tests point them elsewhere.
export const files = {
  queue: join(STATE, "groups.json"),
  off: join(STATE, "groups-off.json"),
  keeper: join(STATE, "keeper.pid"),
  log: join(STATE, "keeper.log"),
};

// scripts/spaces serve: answers come back one per line, in request order.
export function startHelper(path = HELPER): { helper: Helper; stop: () => void } {
  const child = spawn(path, ["serve"], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting: ((a: Answer) => void)[] = [];
  let failed: string | undefined;
  const fail = (why: string) => {
    failed ??= why;
    for (const resolve of waiting.splice(0)) resolve({ ok: false, error: failed });
  };
  child.on("error", (e) => fail("code" in e && e.code === "ENOENT" ? "the tab group helper is not built (bun run helpers)" : e.message));
  child.on("exit", (code) => fail(`the tab group helper exited with ${code}`));
  child.stdin.on("error", (e) => fail(e.message));
  createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.(JSON.parse(line) as Answer));
  const helper: Helper = (op, args = {}) => {
    if (failed) return Promise.resolve({ ok: false, error: failed });
    const { promise, resolve } = Promise.withResolvers<Answer>();
    waiting.push(resolve);
    child.stdin.write(`${JSON.stringify({ ...args, op })}\n`);
    return promise;
  };
  return { helper, stop: () => child.stdin.end() };
}

// Why group work is off, if it is.
export function groupsOff(): string | undefined {
  try {
    const { why } = JSON.parse(readFileSync(files.off, "utf8")) as { why: string };
    return `tab groups are off: ${why} (remove ${files.off} to turn them back on)`;
  } catch {
    return undefined;
  }
}

export function turnOff(why: string) {
  mkdirSync(dirname(files.off), { recursive: true });
  writeFileSync(files.off, JSON.stringify({ why: `${why} at ${new Date().toISOString()}` }));
}

// The helper, with the rule for a menu that stayed open: the flag goes up,
// and the step fails.
export function guarded(h: Helper): Helper {
  return async (op, args) => {
    const a = await h(op, args);
    if (a.closed !== false) return a;
    turnOff(`Safari's menu stayed open after ${op}`);
    return { ...a, ok: false, error: groupsOff() };
  };
}

// Why group work waits now, or undefined when it may go ahead.
export function waitWhy(g: Gate): string | undefined {
  if (g.locked) return "the screen is locked";
  if (g.safariActive) return "Safari is in front";
  if (g.idleMs < IDLE_MS) return "the user is at the keyboard or mouse";
  return undefined;
}

const stop = (why: string): Outcome => ({ done: false, why, wait: false });
const later = (why: string): Outcome => ({ done: false, why, wait: true });

// The gate when group work may go ahead now, else why not: off, no
// permission, the user at the keys, or his front app no longer front.
export async function check(h: Helper, front?: string): Promise<Gate | Outcome> {
  const off = groupsOff();
  if (off) return stop(off);
  const g = (await h("gate")) as Answer & Gate;
  if (!g.ok) return stop(g.error ?? "the tab group helper failed");
  if (!g.trusted) return stop("the terminal the agent runs in has no Accessibility permission");
  if (front !== undefined && g.front !== front) return later(`the front app changed from ${front} to ${g.front}`);
  const why = waitWhy(g);
  return why === undefined ? g : later(why);
}

// The group a confirm sheet asks about: the text inside its first quotes.
export function quotedName(text: string[]): string | undefined {
  for (const line of text) {
    const m = /[“"]([^”"]*)[”"]/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

async function readRows(h: Helper, window: number): Promise<Row[] | Outcome> {
  const a = (await h("rows", { window })) as Answer & { rows?: Row[] };
  return a.ok ? (a.rows ?? []) : stop(a.error ?? "the sidebar could not be read");
}

// Selects the one row that matches alone, selecting it again while Safari
// moves the selection (it selects a group's front tab as it shows it).
async function selectAlone(h: Helper, window: number, matches: (r: Row) => boolean, what: string): Promise<Outcome | undefined> {
  for (let tries = 0; ; tries++) {
    const rows = await readRows(h, window);
    if (!Array.isArray(rows)) return rows;
    const count = rows.filter(matches).length;
    if (count !== 1) return stop(`the sidebar has ${count} rows for ${what}`);
    const selected = rows.filter((r) => r.selected);
    if (selected.length === 1 && matches(selected[0])) return undefined;
    if (tries === 3) return stop(`the sidebar would not keep ${what} selected alone`);
    const a = await h("select", { window, index: rows.findIndex(matches) });
    if (!a.ok) return stop(a.error ?? "the row could not be selected");
    await Bun.sleep(SETTLE_MS);
  }
}

// Opens the sidebar's menu for the row selectAlone left selected, the gate
// read again first; the items, or why not, the menu then already ended.
async function openMenu(h: Helper, window: number, front: string): Promise<Item[] | Outcome> {
  const gate = await check(h, front);
  if ("done" in gate) return gate;
  const menu = (await h("menu", { window, minIdleMs: IDLE_MS, front })) as Answer & { items?: Item[] };
  return menu.ok ? (menu.items ?? []) : later(menu.error ?? "the sidebar's menu did not open");
}

// Ends the open menu for a reason: the outcome, unless the menu stayed.
async function refuse(h: Helper, window: number, outcome: Outcome): Promise<Outcome> {
  const a = await h("dismiss", { window });
  return a.ok ? outcome : stop(a.error ?? "the menu could not be ended");
}

// Deletes the tab group named name from the sidebar of window (a
// CGWindowID), which then shows its own tabs. done once no group of that
// name is left.
export async function deleteGroup(h: Helper, window: number, name: string): Promise<Outcome> {
  const start = await check(h);
  if ("done" in start) return start;
  const shown = await h("sidebar", { window, show: true });
  if (!shown.ok) return stop(shown.error ?? "the sidebar did not show");
  const isTarget = (r: Row) => r.kind === "group" && r.name === name;
  const rows = await readRows(h, window);
  if (!Array.isArray(rows)) return rows;
  if (!rows.some(isTarget)) return { done: true };
  const unselected = await selectAlone(h, window, isTarget, name);
  if (unselected) return unselected;
  const items = await openMenu(h, window, start.front);
  if (!Array.isArray(items)) return items;
  const ids = items.map((i) => i.id);
  if (!ids.includes(DELETE) || !ids.includes(RENAME)) return refuse(h, window, stop("the sidebar's menu was not a tab group's"));
  // The menu is the one for the row selected as it opened: still the group?
  const now = await readRows(h, window);
  if (!Array.isArray(now) || now.filter((r) => r.selected).length !== 1 || !now.some((r) => r.selected && isTarget(r))) return refuse(h, window, stop(`the selection moved off ${name}`));
  const pressed = (await h("press", { window, id: DELETE })) as Answer & { sheet?: Sheet | null };
  if (!pressed.ok) return stop(pressed.error ?? "Delete Tab Group could not be pressed");
  // A group with open tabs asks first; one without goes at once, the
  // selection having been its only check.
  if (pressed.sheet) {
    const asked = quotedName(pressed.sheet.text);
    if (asked !== name || !pressed.sheet.buttons.includes("Delete")) return refuse(h, window, stop(asked === undefined ? "the confirm sheet named no group" : `the confirm sheet asked about ${asked}`));
    const confirmed = await h("confirm", { window, button: "Delete" });
    if (!confirmed.ok) return refuse(h, window, stop(confirmed.error ?? "the confirm sheet took no answer"));
  }
  for (let i = 0; i < 20; i++) {
    const after = await readRows(h, window);
    if (Array.isArray(after) && !after.some(isTarget)) return { done: true };
    await Bun.sleep(100);
  }
  return stop(`${name} was still in the sidebar after its delete`);
}

// Makes all of window's own tabs a new tab group named name, which the
// window then shows, with its sidebar hidden. A group of that name already
// there (a task's last one, still to be deleted) makes it wait.
export async function makeGroup(h: Helper, window: number, name: string): Promise<Outcome> {
  const start = await check(h);
  if ("done" in start) return start;
  // A keeper stopped after making it left it made.
  const was = (await h("state", { window })) as Answer & { shown?: string | null };
  if (was.shown === name) return { done: true };
  const shown = await h("sidebar", { window, show: true });
  if (!shown.ok) return stop(shown.error ?? "the sidebar did not show");
  const rows = await readRows(h, window);
  if (!Array.isArray(rows)) return rows;
  if (rows.some((r) => r.kind === "group" && r.name === name)) return later(`a tab group named ${name} is still there`);
  const isLocal = (r: Row) => r.kind === "local";
  const unselected = await selectAlone(h, window, isLocal, "the window's own tabs");
  if (unselected) return unselected;
  const items = await openMenu(h, window, start.front);
  if (!Array.isArray(items)) return items;
  const make = items.find((i) => NEW_WITH.test(i.title) && i.enabled);
  if (!make || items.some((i) => i.id === DELETE)) return refuse(h, window, stop("the menu for the window's tabs had no New Tab Group with them"));
  const pressed = await h("press", { window, title: make.title });
  if (!pressed.ok) return stop(pressed.error ?? "New Tab Group could not be pressed");
  const named = (await h("name", { window, name })) as Answer & { named?: string | null };
  const hidden = await h("sidebar", { window, show: false });
  const state = (await h("state", { window })) as Answer & { shown?: string | null };
  if (named.ok && hidden.ok && state.shown === name) return { done: true };
  // The group is made but not as named: it is deleted by the name Safari
  // gave it, which no other group may have. One that stays, or whose name
  // is not known, turns group work off until a person has looked.
  const made = state.shown || named.named || undefined;
  const why = named.ok ? `the window shows ${made ?? "no group"}, not ${name}` : (named.error ?? "the new group took no name");
  const undone = made === undefined ? undefined : await deleteGroup(h, window, made);
  if (undone?.done) return stop(why);
  turnOff(`${why}, and its new group ${made ?? ""} is left${undone ? ` (${undone.why})` : ""}`);
  return stop(groupsOff()!);
}

// ---------- the queue ----------

// Groups made and not yet deleted, by name, with the agent each was for.
// Only the keeper that holds the helper's lock changes it.
export type Entry = { owner?: number; since: number };

export function readQueue(): Record<string, Entry> {
  try {
    return JSON.parse(readFileSync(files.queue, "utf8")) as Record<string, Entry>;
  } catch {
    return {};
  }
}

export function changeQueue(change: (q: Record<string, Entry>) => void) {
  const q = readQueue();
  change(q);
  mkdirSync(dirname(files.queue), { recursive: true });
  writeFileSync(`${files.queue}.${process.pid}`, JSON.stringify(q));
  renameSync(`${files.queue}.${process.pid}`, files.queue);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

// Whether a keeper runs, by the pid it wrote as it took the lock.
export function keeperRunning(): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(files.keeper, "utf8"));
  } catch {
    return false;
  }
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}
