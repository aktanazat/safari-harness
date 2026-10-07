// Putting a tab on screen: its window shows the tab, Safari comes to the
// front, and afterwards the user gets back the tab and the app they had in
// front. Real input needs it for the length of one action because events
// land on whatever is on screen; `wait` with front needs it because some
// pages stall until they are visible; handoff needs it until the user has
// done what the tab waits on. scripts/input's front and activate need no
// Accessibility permission, so both the caller and the launchd daemon can
// run them; each passes its own way of reaching tabs.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TabInfo } from "./tools.ts";

const execFileAsync = promisify(execFile);
const INPUT = join(import.meta.dir, "..", "scripts", "input");
export const SAFARI = "com.apple.Safari";

// Runs the helper and parses its one JSON line; failures carry its stderr.
// Typed text goes on stdin, unchanged and without an added newline: cards
// use this path too, and process arguments expose their digits (09-30).
export async function input(args: string[], timeout = 10000, stdin?: string): Promise<unknown> {
  try {
    const running = execFileAsync(INPUT, args, { timeout });
    running.child.stdin?.end(stdin);
    const { stdout } = await running;
    return JSON.parse(stdout);
  } catch (e) {
    const stderr = typeof e === "object" && e !== null && "stderr" in e ? String(e.stderr).trim() : "";
    throw new Error(`input ${args[0]} failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  }
}

export type TabOps = { tabs(): Promise<TabInfo[]>; activate(tab: number): Promise<unknown> };

// When this process last brought Safari to the front for a call (activate,
// a handoff). The daemon's answers the tab group keeper (the space tool):
// Safari in front after one of its steps is then no fault of the step.
let raisedAt = 0;
export const lastRaised = () => raisedAt;

// Who hears of each time: the daemon's flight records (mission.ts) count it
// for the agent of the call. On 10-07 Safari came in front about 30 times
// in 30 minutes over his terminal, and no record said for whom. Real input
// raises Safari in its caller's process and through the daemon's activate,
// so the daemon hears each time once.
let heard: () => void = () => {};
export function onRaised(listener: () => void): void {
  heard = listener;
}

export async function raiseSafari(): Promise<void> {
  raisedAt = Date.now();
  heard();
  await input(["activate", SAFARI]);
}

// The bundle id of the app in front.
export async function frontApp(): Promise<string | undefined> {
  const r = await input(["front"]);
  return r && typeof r === "object" && "bundleId" in r && typeof r.bundleId === "string" ? r.bundleId : undefined;
}

// A macOS notification from the harness. text goes in as an argument, so
// none of it is read as script.
export function notify(text: string): void {
  Bun.spawn(["osascript", "-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "Safari Harness"', "-e", "end run", text], { stdout: "ignore", stderr: "ignore" });
}

// Shows the tab and returns what gives the user back what they had in
// front: the tab its window showed, their front window, and their app.
// Giving back is best effort: what the tab was shown for has happened, and
// an error would invite a retry that repeats it. A user who brought another
// app forward meanwhile keeps it: on 10-07 he went back to his terminal
// mid-reply, and giving back raised Safari again before his app.
export async function show(tab: number, ops: TabOps): Promise<() => Promise<void>> {
  const [bundleId, tabs] = await Promise.all([frontApp(), ops.tabs()]);
  const target = tabs.find((t) => t.id === tab);
  if (!target) throw new Error(`no tab ${tab}`);
  const back = [tabs.find((t) => t.windowId === target.windowId && t.active && t.id !== tab), tabs.find((t) => t.front && t.windowId !== target.windowId)];
  const giveBack = async () => {
    if ((await frontApp().catch(() => undefined)) !== SAFARI) return;
    for (const t of back) if (t) await ops.activate(t.id).catch(() => {});
    if (bundleId && bundleId !== SAFARI) await input(["activate", bundleId]).catch(() => {});
  };
  try {
    await ops.activate(tab);
    await raiseSafari();
  } catch (e) {
    await giveBack();
    throw e;
  }
  return giveBack;
}

// Real input and wait with front put the tab on screen only once the user
// has let go of every key and button for a second (idle in
// scripts/input.swift), waiting 10 s at most: on 10-07 Safari came in front
// about 30 times in 30 minutes over the terminal he was typing in. Still
// busy after that, he keeps his screen and nothing is done. A handoff,
// which asks him to act, shows the tab at once.
const PAUSE_MS = 1000;
const PAUSE_MAX_MS = 10000;

export async function inFront<T>(tab: number, ops: TabOps, act: () => Promise<T>): Promise<T> {
  const paused = await input(["idle", String(PAUSE_MS), String(PAUSE_MAX_MS)], PAUSE_MAX_MS + 5000);
  if (!(paused && typeof paused === "object" && "idle" in paused && paused.idle === true)) {
    throw new Error(`the user kept typing or clicking for ${PAUSE_MAX_MS / 1000} s, so the tab stayed behind his app and nothing was done; try again in a moment`);
  }
  const giveBack = await show(tab, ops);
  try {
    return await act();
  } finally {
    await giveBack();
  }
}
