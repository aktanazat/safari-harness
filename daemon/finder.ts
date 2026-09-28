// upload's find: a Spotlight search of the four folders where the user keeps
// his own files, so an agent can look for "insurance card" instead of
// asking him for a path he already saved. It attaches nothing: the agent
// picks a candidate (asking him when more than one could be right) and
// calls upload again with its path. It never returns a path outside those
// folders, and it reads Spotlight's record of each file (name, kind, date,
// size), never the file: the daemon opening one in iCloud Drive makes
// macOS ask the user whether it may, and the open waits on that prompt in
// one of the daemon's file threads (on 2026-09-28 four hung until he came
// back). Spotlight lists no symlinks, so none leads out of the folders.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, normalize, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// iCloud Drive, Documents, Desktop, and Downloads, and nothing else.
export const FIND_ROOTS = ["Library/Mobile Documents/com~apple~CloudDocs", "Documents", "Desktop", "Downloads"].map((d) => join(homedir(), d));

export type Found = { path: string; name: string; kind: string; modified: string; size: number };
// A Spotlight match as Spotlight records it: its kind ("PDF document"), its
// size (null for a folder), and when its contents last changed (ms).
export type Hit = { path: string; kind: string; size: number | null; modified: number | null };
export type Search = (roots: string[], query: string) => Promise<Hit[]>;

const MAX = 8;
// mdfind prints each match as `path   kMDItemKind = …   kMDItemFSSize = …`,
// these attributes in this order, ended by NUL; one it lacks reads (null).
const ATTRS = ["kMDItemKind", "kMDItemFSSize", "kMDItemContentModificationDate"];

function hitOf(line: string): Hit {
  let rest = line;
  const value: Record<string, string | null> = {};
  for (const attr of ATTRS.toReversed()) {
    const at = rest.lastIndexOf(`   ${attr} = `);
    if (at < 0) continue;
    const v = rest.slice(at + attr.length + 6);
    value[attr] = v === "(null)" ? null : v;
    rest = rest.slice(0, at);
  }
  const size = value.kMDItemFSSize;
  const date = value.kMDItemContentModificationDate;
  return { path: rest, kind: value.kMDItemKind ?? "", size: size == null ? null : Number(size), modified: date == null ? null : Date.parse(date) };
}

const spotlight: Search = async (roots, query) => {
  const args = [...roots.flatMap((r) => ["-onlyin", r]), ...ATTRS.flatMap((a) => ["-attr", a]), "-0", query];
  const { stdout } = await execFileAsync("mdfind", args, { timeout: 15000, maxBuffer: 64 << 20 }).catch((e: { killed?: boolean; stdout?: string }) => {
    if (e.killed) throw new Error("Spotlight did not answer within 15 s");
    // a query it cannot read is reported on stdout: "Failed to create query for '…'."
    const why = String(e.stdout ?? "").trim();
    throw new Error(`Spotlight could not search for that${why ? `: ${why}` : ""}`);
  });
  return stdout.split("\0").filter(Boolean).map(hitOf);
};

// Files named for more of the words come first, then the newest.
export async function findFiles(query: string, opts: { roots?: string[]; search?: Search } = {}): Promise<{ found: Found[]; next: string }> {
  // mdfind takes a leading "-" for an option (-live never returns), and has no "--"
  const q = query.replace(/^[\s-]+/, "").trim();
  if (!q) throw new Error('find needs words to look for, like "insurance card"');
  const roots = opts.roots ?? FIND_ROOTS;
  const want = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const files = new Map<string, { kind: string; size: number; modified: number; score: number }>();
  for (const h of await (opts.search ?? spotlight)(roots, q)) {
    // a path normalize would change (a .., a doubled /) is not a plain path inside a root
    if (h.size === null || normalize(h.path) !== h.path || !roots.some((r) => h.path.startsWith(r + sep))) continue;
    const score = want.filter((w) => basename(h.path).toLowerCase().includes(w)).length;
    files.set(h.path, { kind: h.kind, size: h.size, modified: h.modified ?? 0, score });
  }
  const found = [...files].sort(([, a], [, b]) => b.score - a.score || b.modified - a.modified).slice(0, MAX).map(([path, f]) => ({
    path,
    name: basename(path),
    kind: f.kind,
    modified: new Date(f.modified).toLocaleString("sv").slice(0, 16),
    size: f.size,
  }));
  return {
    found,
    next: found.length
      ? "nothing is attached yet: pick one, asking the user if more than one could be right, then call upload with paths: [its path]"
      : "no file in iCloud Drive, Documents, Desktop, or Downloads matched; try other words, or ask the user where it is",
  };
}
