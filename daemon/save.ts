
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { withPageState } from "./page-state.ts";

export const SAVED_DIR = join(homedir(), ".local/share/safari-harness/saved");
const HEAD_CHARS = 500;
// Saved reads hold page text, signed-in sites' too: the saved folder keeps
// a week of them.
const KEPT_MS = 7 * 24 * 60 * 60_000;

export type SaveKind = "extract" | "snapshot" | "eval" | "fetch" | "authenticated_read";

// A file at this path, or a new file in this folder, named for the page's
// host and the time.
export type Target = { path: string } | { dir: string };

// A saved read goes to a file, not into a model's context, so it is read
// far past the limit a reply keeps to. The ceiling is one message between
// the extension and the daemon: Bun's server drops the extension's
// connection at a message over 16 MB, and a character can take 3 bytes.
const LIMITS: Record<SaveKind, Record<string, number>> = {
  extract: { maxBytes: 2_000_000 },
  fetch: { maxBytes: 2_000_000 },
  authenticated_read: { maxBytes: 2_000_000 },
  snapshot: { maxNodes: 10_000 },
  eval: {},
};

// The read's arguments with its limit raised, unless the caller set one.
export function withLimit(kind: SaveKind, args: Record<string, unknown>): Record<string, unknown> {
  const raised = { ...args };
  for (const [name, value] of Object.entries(LIMITS[kind])) raised[name] ??= value;
  return raised;
}

// save: true for the saved folder, or an absolute path: a relative one would
// be taken from the daemon's folder, not the caller's. map takes a folder,
// the other reads a file.
export function targetOf(save: unknown, as: "file" | "folder"): Target {
  if (save === true) return { dir: SAVED_DIR };
  if (typeof save !== "string" || !isAbsolute(save)) throw new Error(`save must be true or an absolute ${as} path`);
  return as === "file" ? { path: save } : { dir: save };
}

type File = { body: string | Uint8Array; ext: string };

function fileOf(kind: SaveKind, r: Record<string, unknown>): File {
  if (kind === "authenticated_read" && typeof r.content === "string") return { body: r.content, ext: r.format === "raw" ? extOf(r.type) : "txt" };
  if (kind === "snapshot" && r.update !== undefined) return { body: JSON.stringify(r, null, 1), ext: "json" };
  if (kind === "snapshot" && typeof r.snapshot === "string") return { body: r.snapshot, ext: "txt" };
  if (kind === "extract" && typeof r.text === "string") return { body: r.text, ext: "txt" };
  if (kind === "fetch" && typeof r.text === "string") return { body: r.text, ext: extOf(r.type) };
  if (kind === "fetch" && typeof r.data === "string") return { body: Buffer.from(r.data, "base64"), ext: "bin" };
  if (kind === "eval") return typeof r.result === "string" ? { body: r.result, ext: "txt" } : { body: JSON.stringify(r.result ?? null, null, 1), ext: "json" };
  return { body: JSON.stringify(r, null, 1), ext: "json" };
}

// A fetched body's file type, from its content type.
function extOf(type: unknown): string {
  const t = typeof type === "string" ? type : "";
  if (/json/i.test(t)) return "json";
  if (/html/i.test(t)) return "html";
  return "txt";
}

function hostOf(url: string): string {
  return (URL.canParse(url) && new URL(url).hostname) || "page";
}

async function write(target: Target, url: string, file: File): Promise<string> {
  if ("path" in target) {
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, file.body, { mode: 0o600 });
    return target.path;
  }
  await mkdir(target.dir, { recursive: true });
  const stem = `${hostOf(url)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  // Reads of one site that finish in the same millisecond (map) each get a
  // file: "wx" refuses a name already taken, and the next number is tried.
  for (let n = 1; ; n++) {
    const path = join(target.dir, `${stem}${n === 1 ? "" : `-${n}`}.${file.ext}`);
    try {
      await writeFile(path, file.body, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
      continue;
    }
    if (target.dir === SAVED_DIR) await pruneSaved();
    return path;
  }
}

// Deletes the reads saved to the saved folder over a week ago, as another
// is saved and as the daemon starts. A folder the caller named stays as it is.
export async function pruneSaved(): Promise<void> {
  const names = await readdir(SAVED_DIR).catch(() => []);
  const before = Date.now() - KEPT_MS;
  await Promise.all(names.map(async (name) => {
    const path = join(SAVED_DIR, name);
    // another save's prune can take a file first
    const s = await stat(path).catch(() => undefined);
    if (s && s.mtimeMs < before) await unlink(path).catch(() => {});
  }));
}

// An answer longer than a reply keeps (mcp-tools.ts), whole, in the saved
// folder; returns its path.
export function saveAnswer(text: string): Promise<string> {
  return write({ dir: SAVED_DIR }, "", { body: text, ext: "txt" });
}

// The read's result, written to target. An error the page answered with is
// no output: it comes back as it is, and nothing is written. A result cut
// short even at the raised limit says so, and a bot-check note stays. The
// answer says which page was read, as the read's own did: pageUrl gives the
// address of a read whose result carries none (eval), and names its file.
// It keeps the page's status, content type, and state (page-state.ts;
// partial, a read of part of the page): on 10-23 saved reads of three pages
// not found and of an API's rate limit answered like any other (K4).
export async function saveOutput(kind: SaveKind, result: unknown, target: Target, pageUrl: () => Promise<string>, partial = false): Promise<unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string") return r;
  const { pageState } = withPageState(kind, r, { partial }) as { pageState?: unknown };
  const file = fileOf(kind, r);
  const url = typeof r.url === "string" ? r.url : await pageUrl();
  const saved = await write(target, url, file);
  const text = typeof file.body === "string" ? file.body : "";
  return {
    saved,
    ...(url ? { url } : {}),
    ...(typeof r.status === "number" ? { status: r.status } : {}),
    ...(typeof r.type === "string" ? { type: r.type } : {}),
    bytes: typeof file.body === "string" ? Buffer.byteLength(file.body) : file.body.byteLength,
    head: text.slice(0, HEAD_CHARS),
    ...(kind === "authenticated_read" ? { source: r.source, auth: r.auth, format: r.format, requestedUrl: r.requestedUrl, tab: r.tab } : {}),
    ...(r.truncated === true ? { truncated: true } : {}),
    ...(r.challenge ? { challenge: r.challenge } : {}),
    ...(pageState ? { pageState } : {}),
    ...(r.memoryReceipt ? { memoryReceipt: r.memoryReceipt } : {}),
    ...(typeof r.memoryWarning === "string" ? { memoryWarning: r.memoryWarning } : {}),
  };
}

// A folder's index.json: each page a map saved there, or failed to, by
// address; a later map's entry for an address takes the place of the
// earlier. One map writes it at a time. A file there that map did not
// write is the user's, and is left as it is.
type IndexEntry = { url: string; finalUrl?: string; title?: string; ok: boolean; status?: number; ms: number; saved?: string; error?: string };
const INDEX_FIELDS: Record<keyof IndexEntry, true> = { url: true, finalUrl: true, title: true, ok: true, status: true, ms: true, saved: true, error: true };
const indexing = new Map<string, Promise<string>>();
export function writeIndex(dir: string, entries: IndexEntry[]): Promise<string> {
  const path = join(dir, "index.json");
  const written = (indexing.get(path) ?? Promise.resolve(path)).catch(() => path).then(async () => {
    const text = await readFile(path, "utf8").catch((e: unknown) => {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
      throw e;
    });
    const before = text === undefined ? [] : mapIndex(text);
    if (!before) throw new Error(`${path} is not a map's index, so it was left as it is`);
    const byUrl = new Map(before.map((entry) => [entry.url, entry]));
    for (const entry of entries) {
      byUrl.delete(entry.url);
      byUrl.set(entry.url, entry);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify([...byUrl.values()], null, 1));
    return path;
  });
  indexing.set(path, written);
  void written.finally(() => {
    if (indexing.get(path) === written) indexing.delete(path);
  }).catch(() => {});
  return written;
}

// The entries of an index.json map wrote: never empty, and each with map's
// url, ok and ms and no field map does not write.
function mapIndex(text: string): IndexEntry[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Array.isArray(value) && value.length > 0 && value.every(isIndexEntry) ? value : undefined;
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.url === "string" && typeof entry.ok === "boolean" && typeof entry.ms === "number" && Object.keys(entry).every((key) => Object.hasOwn(INDEX_FIELDS, key));
}
