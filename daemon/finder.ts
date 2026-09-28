// upload's find: a Spotlight search of the four folders where the user keeps
// his own files, so an agent can look for "insurance card" instead of
// asking him for a path he already saved. It attaches nothing: the agent
// picks a candidate (asking him when more than one could be right) and
// calls upload again with its path. It reads names, kinds, dates, and
// sizes, never a file's contents, and never returns a path outside those
// folders, a symlink that leads out of them included.

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// iCloud Drive, Documents, Desktop, and Downloads, and nothing else.
export const FIND_ROOTS = ["Library/Mobile Documents/com~apple~CloudDocs", "Documents", "Desktop", "Downloads"].map((d) => join(homedir(), d));

export type Found = { path: string; name: string; kind: string; modified: string; size: number };
// A Spotlight match: its path and Spotlight's name for its kind ("PDF document").
export type Hit = { path: string; kind: string };
export type Search = (roots: string[], query: string) => Promise<Hit[]>;

const MAX = 8;
// A common word matches tens of thousands of files ("the" matched 41,299 on
// the owner's Mac), so only the best-named few hundred are looked at on disk.
const LOOKED_AT = 200;
const KIND = "   kMDItemKind = ";

// mdfind prints each match as `path   kMDItemKind = kind`, ended by NUL.
const spotlight: Search = async (roots, query) => {
  const args = [...roots.flatMap((r) => ["-onlyin", r]), "-attr", "kMDItemKind", "-0", query];
  const { stdout } = await execFileAsync("mdfind", args, { timeout: 15000, maxBuffer: 64 << 20 }).catch((e: { killed?: boolean; stdout?: string }) => {
    if (e.killed) throw new Error("Spotlight did not answer within 15 s");
    // a query it cannot read is reported on stdout: "Failed to create query for '…'."
    const why = String(e.stdout ?? "").trim();
    throw new Error(`Spotlight could not search for that${why ? `: ${why}` : ""}`);
  });
  return stdout.split("\0").filter(Boolean).map((line) => {
    const at = line.lastIndexOf(KIND);
    if (at < 0) return { path: line, kind: "" };
    const kind = line.slice(at + KIND.length);
    return { path: line.slice(0, at), kind: kind === "(null)" ? "" : kind };
  });
};

// Files named for more of the words come first, then the newest.
export async function findFiles(query: string, opts: { roots?: string[]; search?: Search } = {}): Promise<{ found: Found[]; next: string }> {
  // mdfind takes a leading "-" for an option (-live never returns), and has no "--"
  const q = query.replace(/^[\s-]+/, "").trim();
  if (!q) throw new Error('find needs words to look for, like "insurance card"');
  const roots = (await Promise.all((opts.roots ?? FIND_ROOTS).map((r) => realpath(r).catch(() => null)))).filter((r) => r !== null);
  const want = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const hits = roots.length ? await (opts.search ?? spotlight)(roots, q) : [];
  const ranked = hits
    .map((h) => ({ ...h, score: want.filter((w) => basename(h.path).toLowerCase().includes(w)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, LOOKED_AT);
  const files = new Map<string, { kind: string; score: number; mtime: number; size: number }>();
  for (const h of ranked) {
    const real = await realpath(h.path).catch(() => null);
    if (real === null || files.has(real) || !roots.some((r) => real.startsWith(r + sep))) continue;
    const st = await stat(real).catch(() => null);
    if (st?.isFile()) files.set(real, { kind: h.kind, score: h.score, mtime: st.mtimeMs, size: st.size });
  }
  const found = [...files].sort(([, a], [, b]) => b.score - a.score || b.mtime - a.mtime).slice(0, MAX).map(([path, f]) => ({
    path,
    name: basename(path),
    kind: f.kind,
    modified: new Date(f.mtime).toLocaleString("sv").slice(0, 16),
    size: f.size,
  }));
  return {
    found,
    next: found.length
      ? "nothing is attached yet: pick one, asking the user if more than one could be right, then call upload with paths: [its path]"
      : "no file in iCloud Drive, Documents, Desktop, or Downloads matched; try other words, or ask the user where it is",
  };
}
