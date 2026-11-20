// The agent screen companion (macos-harness native/agent-screen) touches
// displays-changed in its folder, ~/.agent-display, after every display
// change: an unplug, a wake or a restarted Agents display. macOS may then
// have moved the user's Safari windows onto the Agents display, which the
// companion leaves to this daemon (displaysChanged in spaces.ts). With no
// such folder there is no companion and nothing to watch.

import { watch } from "node:fs";

export const DISPLAYS_CHANGED = "displays-changed";

// Calls changed when the companion touches the file; the closer stops the
// watch. Undefined when dir does not exist.
export function watchDisplayChanges(dir: string, changed: () => void): (() => void) | undefined {
  try {
    const watcher = watch(dir, (_, name) => {
      if (name === DISPLAYS_CHANGED) changed();
    });
    watcher.unref();
    return () => watcher.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
