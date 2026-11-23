// The LocalStorage only agents' pages wrote, swept from Safari's website
// data. Before a page opens in a site with no cookies, WebKit reads the
// LocalStorage of every origin on disk (NetworkProcess::
// hasLocalStorageOrCookies). With 4,850 origins there, nearly all from
// agents' browsing, each such navigation waited 650-1,300 ms before its
// request went out, and 54-85 ms once they were gone (11-23). Runs in the
// caller, which can read Safari's History.db and container.

import { readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { userHosts } from "./safari-history.ts";

const DATA = join(homedir(), "Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default");
const STAMP = join(homedir(), ".local/share/safari-harness/storage-sweep");
const WEEK_MS = 7 * 86_400_000;
// An origin used this recently may still have a page open, whose files
// WebKit holds, or be a site he signed in to in an agent's tab (a
// handoff), whose loads count as the agent's. The loads the daemon keeps
// (loads.ts) reach back twice this, so a weekly sweep sees every origin
// left this long.
const IDLE_MS = WEEK_MS;

// The host of an origin folder's top origin. WebKit writes a ClientOrigin
// as the top origin, then the client origin, each a protocol and a host as
// a 32-bit length and an 8-bit flag (1 for Latin-1, 0 for UTF-16), then an
// optional port.
export function topHost(file: Buffer): string | undefined {
  let at = 0;
  const text = () => {
    const length = file.readUInt32LE(at);
    const latin1 = file[at + 4] === 1;
    at += 5;
    const end = at + (latin1 ? length : length * 2);
    if (end > file.length) throw new RangeError("origin file cut short");
    const s = file.toString(latin1 ? "latin1" : "utf16le", at, end);
    at = end;
    return s;
  };
  try {
    text();
    return text().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

// A host's site, near enough to keep every origin of a site he uses: its
// last two labels, or an address whole.
const siteOf = (host: string) => (/^[\d.]+$|:/.test(host) ? host : host.split(".").slice(-2).join("."));

export type SweepResult = { removed: number; kept: number };

// Removes each origin folder that holds only LocalStorage, untouched for
// IDLE_MS, whose top site the user never visited himself.
export function sweepAgentStorage(opts: { dryRun?: boolean; now?: number; data?: string; hosts?: Set<string> } = {}): SweepResult {
  const now = opts.now ?? Date.now();
  const data = opts.data ?? DATA;
  const sites = new Set([...(opts.hosts ?? userHosts())].map(siteOf));
  const result: SweepResult = { removed: 0, kept: 0 };
  // Beside the buckets of origin folders sits WebKit's salt file.
  for (const entry of readdirSync(data, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const bucket = entry.name;
    const folders = readdirSync(join(data, bucket), { withFileTypes: true });
    let left = folders.length;
    for (const folder of folders) {
      const dir = join(data, bucket, folder.name);
      const storage = join(dir, "LocalStorage");
      const only = folder.isDirectory() && readdirSync(dir).sort().join() === "LocalStorage,origin";
      const host = only ? topHost(readFileSync(join(dir, "origin"))) : undefined;
      // WebKit touches the origin file as a page opens the origin's storage.
      const written = host === undefined ? now : Math.max(statSync(join(dir, "origin")).mtimeMs, statSync(storage).mtimeMs, ...readdirSync(storage).map((f) => statSync(join(storage, f)).mtimeMs));
      if (host === undefined || sites.has(siteOf(host)) || now - written < IDLE_MS) {
        result.kept++;
        continue;
      }
      if (!opts.dryRun) rmSync(dir, { recursive: true, force: true });
      result.removed++;
      left--;
    }
    // A folder WebKit made in the bucket since it was listed stays.
    if (left === 0 && !opts.dryRun) {
      try {
        rmdirSync(join(data, bucket));
      } catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "ENOTEMPTY")) throw e;
      }
    }
  }
  return result;
}

// The sweep, once a week at most, for a session starting (omp/index.ts).
export function weeklySweep(now = Date.now()): SweepResult | undefined {
  let last = 0;
  try {
    last = statSync(STAMP).mtimeMs;
  } catch {
    // never swept
  }
  if (now - last < WEEK_MS) return undefined;
  const result = sweepAgentStorage({ now });
  writeFileSync(STAMP, JSON.stringify({ at: new Date(now).toISOString(), ...result }) + "\n");
  return result;
}
