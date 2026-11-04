// The pages agents' tabs load, so browsing_history can tell the user's
// visits from theirs: Safari's History.db records both alike. On 09-30 its
// four days of history held 2,350 visits to example.com, the page the live
// checks open, and 338 to the daemon's own pages, and browsing_history
// gave them back as his. It runs in the caller (safari-history.ts), not in
// the daemon, so the daemon keeps the loads in a file for it to read.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataFile } from "./phone.ts";
import { redactUrl } from "./redact.ts";

// A load: when Safari began loading until it reported the address (ms since
// 1970), and the addresses it went through, as addressKey gives them.
export type Load = { from: number; to: number; urls: string[] };

// Agents loaded at least 1,877 pages on 09-28 (example.com and the daemon's
// pages alone), so the file keeps several days of loads, in 2 MB or so.
const MAX = 10_000;

let file: string | undefined;
let appended = 0;

// The file the daemon on port keeps them in, beside its tabs (main.ts).
export function loadsFile(port: number | string): string {
  return dataFile(`loads-${port}.jsonl`);
}

// An address as a load and a visit both give it: parsed, so
// https://Example.com is https://example.com/ as Safari writes it; without
// its fragment, which a page's script can change after the load, and Safari
// records that as a visit too; and with its secrets cut (redact.ts), so the
// file keeps none.
export function addressKey(url: string): string {
  const u = URL.parse(url);
  if (u) u.hash = "";
  return redactUrl(u?.href ?? url);
}

// The file holds the latest MAX loads and fewer than MAX more: it starts
// over from the latest MAX when a daemon opens it and after every MAX
// appends, as the journal does. The new file takes the old one's place in
// one rename, so browsing_history, reading it from another process, never
// finds it half written.
function rewrite(path: string) {
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-MAX);
  } catch {
    // no loads yet
  }
  writeFileSync(`${path}.new`, lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  renameSync(`${path}.new`, path);
  appended = 0;
}

// Keeps the loads an earlier daemon noted in path, and notes new ones there.
export function openLoads(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  file = path;
  rewrite(path);
}

// Notes a load the extension saw in an owned tab. Tool results do not also
// note it: each page is recorded once, even when no tool caused its load.
// Until the daemon opens the file (main.ts), nothing is noted.
export function noteLoad(load: { from: number; to: number; urls: (string | undefined)[] }): void {
  if (!file) return;
  const urls = [...new Set(load.urls.filter((url): url is string => !!url).map(addressKey))];
  if (urls.length === 0) return;
  // The page has loaded by now: a file the daemon cannot write (its folder
  // deleted, the disk full) must not fail the call, as the journal's must
  // not stop the bridge.
  try {
    appendFileSync(file, `${JSON.stringify({ from: load.from, to: load.to, urls })}\n`);
    if (++appended >= MAX) rewrite(file);
  } catch (err) {
    console.error("[safari-harness] load not noted:", err instanceof Error ? err.message : err);
  }
}

// The loads noted in path that ended at since (ms) or later; none when no
// daemon has noted one. A line the daemon was still writing is skipped.
export function readLoads(path: string, since: number): Load[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
  return text.split("\n").flatMap((line) => {
    try {
      const load = JSON.parse(line) as Load;
      return load.to >= since ? [load] : [];
    } catch {
      return [];
    }
  });
}
