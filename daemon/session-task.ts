// The task of an omp session's shell commands. omp keeps each command's
// text as written and gives the command its session's id (PI_SESSION_ID,
// since omp 18.12.4). Before the command runs, the omp extension leaves the
// session's task here (omp/index.ts), and the calls the command makes, by
// the CLI, scripts or REPL code, carry it (rpc.ts). Before (10-24), the
// extension wrapped every command in a SAFARI_HARNESS_TASK assignment,
// which transcripts, job labels and the commands agents copied carried.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".local", "share", "safari-harness", "tasks");
// A session's file stays a week after it was written; a session still
// running writes it again at its next command.
const KEPT_MS = 7 * 24 * 60 * 60_000;

export function sessionTask(session = process.env.PI_SESSION_ID): string | undefined {
  if (!session) return undefined;
  try {
    return readFileSync(join(DIR, session), "utf8") || undefined;
  } catch {
    return undefined;
  }
}

export function setSessionTask(session: string, task: string): void {
  if (sessionTask(session) === task) return;
  const file = join(DIR, session);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${file}.${process.pid}`, task);
  renameSync(`${file}.${process.pid}`, file);
  void prune();
}

async function prune(): Promise<void> {
  const before = Date.now() - KEPT_MS;
  const names = await readdir(DIR).catch(() => []);
  await Promise.all(names.map(async (name) => {
    const path = join(DIR, name);
    // another session's prune can take a file first
    const s = await stat(path).catch(() => undefined);
    if (s && s.mtimeMs < before) await unlink(path).catch(() => {});
  }));
}
