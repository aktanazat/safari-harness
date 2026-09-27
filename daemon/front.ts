// Putting a tab on screen for the length of one action: its window shows the
// tab, Safari comes to the front, the action runs, and then the user gets
// back the tab and the app they had in front. Real input needs it because
// events land on whatever is on screen; `wait` with front needs it because
// some pages stall until they are visible. scripts/input's front and
// activate need no Accessibility permission, so both the caller and the
// launchd daemon can run them; each passes its own way of reaching tabs.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TabInfo } from "./tools.ts";

const execFileAsync = promisify(execFile);
const INPUT = join(import.meta.dir, "..", "scripts", "input");
const SAFARI = "com.apple.Safari";

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

// Restoring is best effort: act has already happened, and an error here
// would invite a retry that repeats it.
export async function inFront<T>(tab: number, ops: TabOps, act: () => Promise<T>): Promise<T> {
  const { bundleId } = (await input(["front"])) as { bundleId: string };
  const tabs = await ops.tabs();
  const target = tabs.find((t) => t.id === tab);
  if (!target) throw new Error(`no tab ${tab}`);
  const previous = tabs.find((t) => t.windowId === target.windowId && t.active && t.id !== tab);
  try {
    await ops.activate(tab);
    await input(["activate", SAFARI]);
    return await act();
  } finally {
    if (previous) await ops.activate(previous.id).catch(() => {});
    if (bundleId && bundleId !== SAFARI) await input(["activate", bundleId]).catch(() => {});
  }
}
