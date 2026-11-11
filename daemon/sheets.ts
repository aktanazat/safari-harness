// A print sheet a frame of a page raised stays on its agent window once the
// harness has closed that tab (lookForSheet in spaces.ts). The daemon has
// no Accessibility permission to cancel it; the terminal an agent runs in
// does, so the agent's caller cancels it, after a close (call.ts) and as
// its turn ends (omp/index.ts). Only a print sheet on the one Safari
// window of the agent window's size goes (scripts/spaces cancelPrint): any
// other sheet stays, and so does a window whose size another shares. A
// look the helper could not make (no permission, Safari not running) is
// left for the next caller.
import { startHelper, type Helper } from "./groups.ts";
import type { Daemon } from "./keeper.ts";
import { quietly, rpc } from "./rpc.ts";

type Look = { id: string; width: number; height: number; look: number };

export async function cancelSheets(daemon: Daemon, start: () => { helper: Helper; stop: () => void }): Promise<void> {
  const { windows } = (await daemon("sheets")) as { windows: Look[] };
  if (windows.length === 0) return;
  const { helper, stop } = start();
  try {
    for (const w of windows) {
      const a = await helper("cancelPrint", { width: w.width, height: w.height });
      if (a.ok) await daemon("looked", { id: w.id, look: w.look, cancelled: a.cancelled === true });
    }
  } finally {
    stop();
  }
}

// Another Mac's Safari is that Mac's to look at. The daemon's answers here
// leave the agent's news (continuity.ts) to its own next call.
export function cancelLeftSheets(): Promise<void> {
  if (process.env.SAFARI_HARNESS_REMOTE) return Promise.resolve();
  return cancelSheets((op, args) => quietly(() => rpc("space", { ...args, op })), startHelper);
}
