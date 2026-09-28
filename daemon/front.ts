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
export async function input(args: string[], timeout = 10000): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(INPUT, args, { timeout });
    return JSON.parse(stdout);
  } catch (e) {
    const stderr = typeof e === "object" && e !== null && "stderr" in e ? String(e.stderr).trim() : "";
    throw new Error(`input ${args[0]} failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  }
}

export type TabOps = { tabs(): Promise<TabInfo[]>; activate(tab: number): Promise<unknown> };

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
// an error would invite a retry that repeats it.
export async function show(tab: number, ops: TabOps): Promise<() => Promise<void>> {
  const [bundleId, tabs] = await Promise.all([frontApp(), ops.tabs()]);
  const target = tabs.find((t) => t.id === tab);
  if (!target) throw new Error(`no tab ${tab}`);
  const back = [tabs.find((t) => t.windowId === target.windowId && t.active && t.id !== tab), tabs.find((t) => t.front && t.windowId !== target.windowId)];
  const giveBack = async () => {
    for (const t of back) if (t) await ops.activate(t.id).catch(() => {});
    if (bundleId && bundleId !== SAFARI) await input(["activate", bundleId]).catch(() => {});
  };
  try {
    await ops.activate(tab);
    await input(["activate", SAFARI]);
  } catch (e) {
    await giveBack();
    throw e;
  }
  return giveBack;
}

export async function inFront<T>(tab: number, ops: TabOps, act: () => Promise<T>): Promise<T> {
  const giveBack = await show(tab, ops);
  try {
    return await act();
  } finally {
    await giveBack();
  }
}
