// Files Safari saves to ~/Downloads while an agent's action runs on a tab
// the harness opened. Safari gives its extensions no downloads API, so this
// compares the folder's names before and after the action. It reports paths
// and sizes, never contents. It never claims a name that was there when the
// action began, nor the end of a download of the user's already under way.
// Two agents acting at the same moment can each see the other's file.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Safari writes a download into "name.ext.download", a folder that becomes
// name.ext when the download finishes.
const PART = ".download";
const WAIT_MS = 30_000;
const POLL_MS = 250;

export type Downloads = { downloaded?: { path: string; bytes: number }[]; downloading?: string[] };
export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

// Starts watching dir. The function it returns, called once the action has
// ended, waits up to 30 s for the downloads that began meanwhile to finish,
// and reports them: finished files as downloaded, the rest by the path each
// will have as downloading, nothing ({}) when there were none.
export async function watchDownloads(dir: string, clock: Clock = { now: Date.now, sleep: Bun.sleep }): Promise<() => Promise<Downloads>> {
  const before = await readdir(dir).then((names) => new Set(names), () => null);
  // In a folder it could not read first, every name would look new.
  if (before === null) return async () => ({});
  // Hidden files are the Finder's (.DS_Store), never a download.
  const fresh = async () => (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith(".") && !before.has(n) && !before.has(n + PART));
  return async () => {
    const deadline = clock.now() + WAIT_MS;
    let names = await fresh();
    while (names.some((n) => n.endsWith(PART)) && clock.now() < deadline) {
      await clock.sleep(POLL_MS);
      names = await fresh();
    }
    const downloaded: { path: string; bytes: number }[] = [];
    const downloading: string[] = [];
    for (const n of names) {
      const path = join(dir, n);
      if (n.endsWith(PART)) {
        downloading.push(path.slice(0, -PART.length));
        continue;
      }
      const st = await stat(path).catch(() => null);
      if (st?.isFile()) downloaded.push({ path, bytes: st.size });
    }
    return { ...(downloaded.length ? { downloaded } : {}), ...(downloading.length ? { downloading } : {}) };
  };
}
