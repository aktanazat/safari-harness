// save: a read (extract, snapshot, eval, fetch) writes its whole output to a
// file and answers with only the file's path, its size, and its first 500
// characters. A long page then costs a model a few lines of context instead
// of its whole text, and it is read past the limit a reply is cut at; the
// agent reads the parts it needs from the file.

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const SAVED_DIR = join(homedir(), ".local/share/safari-harness/saved");
const HEAD_CHARS = 500;

export type SaveKind = "extract" | "snapshot" | "eval" | "fetch";

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

// What each read writes: extract its text (its tables as JSON), snapshot its
// outline, fetch the body as sent, eval its value (a string as it is).
function fileOf(kind: SaveKind, r: Record<string, unknown>): File {
  if (kind === "snapshot" && typeof r.snapshot === "string") return { body: r.snapshot, ext: "txt" };
  if (kind === "extract" && typeof r.text === "string") return { body: r.text, ext: "txt" };
  if (kind === "fetch" && typeof r.text === "string") return { body: r.text, ext: extOf(r.type) };
  if (kind === "fetch" && typeof r.data === "string") return { body: Buffer.from(r.data, "base64"), ext: "bin" };
  if (kind === "eval") return typeof r.result === "string" ? { body: r.result, ext: "txt" } : { body: JSON.stringify(r.result, null, 1), ext: "json" };
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
    await writeFile(target.path, file.body);
    return target.path;
  }
  await mkdir(target.dir, { recursive: true });
  const stem = `${hostOf(url)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  // Reads of one site that finish in the same millisecond (map) each get a
  // file: "wx" refuses a name already taken, and the next number is tried.
  for (let n = 1; ; n++) {
    const path = join(target.dir, `${stem}${n === 1 ? "" : `-${n}`}.${file.ext}`);
    try {
      await writeFile(path, file.body, { flag: "wx" });
      return path;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
}

// The read's result, written to target. An error the page answered with is
// no output: it comes back as it is, and nothing is written. A result cut
// short even at the raised limit says so, and a bot-check note stays.
// pageUrl names the file of a read whose result carries no address (eval).
export async function saveOutput(kind: SaveKind, result: unknown, target: Target, pageUrl: () => Promise<string>): Promise<unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string") return r;
  const file = fileOf(kind, r);
  const url = typeof r.url === "string" ? r.url : "dir" in target ? await pageUrl() : "";
  const saved = await write(target, url, file);
  const text = typeof file.body === "string" ? file.body : "";
  return {
    saved,
    bytes: typeof file.body === "string" ? Buffer.byteLength(file.body) : file.body.byteLength,
    head: text.slice(0, HEAD_CHARS),
    ...(r.truncated === true ? { truncated: true } : {}),
    ...(r.challenge ? { challenge: r.challenge } : {}),
  };
}
