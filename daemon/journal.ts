// The daemon's journal: what happened to it and when, for whoever asks why
// a call failed or the extension went away. A bounded list of timestamped
// events (start and stop, extension connects and disconnects, requests the
// extension never answered, pages it had to re-inject); /health shows the
// latest, so `safari status` does. The daemon keeps it in a file beside its
// log, so it survives restarts; anywhere else (tests) it stays in memory.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JournalEvent = { t: string; kind: string } & Record<string, unknown>;

const MAX = 200;
let events: JournalEvent[] = [];
let file: string | undefined;
let appended = 0;

function isEvent(v: unknown): v is JournalEvent {
  return !!v && typeof v === "object" && "t" in v && typeof v.t === "string" && "kind" in v && typeof v.kind === "string";
}

// The file holds the latest MAX events and fewer than MAX more: it starts
// over from the latest MAX when a daemon opens it and after every MAX
// appends, so it stays bounded however often the daemon restarts.
function rewrite(path: string) {
  writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  appended = 0;
}

// Loads the events an earlier daemon left in path and appends new ones to
// it. Returns the earlier events, oldest first.
export function openJournal(path: string): JournalEvent[] {
  mkdirSync(dirname(path), { recursive: true });
  let earlier: JournalEvent[] = [];
  try {
    earlier = readFileSync(path, "utf8").split("\n").flatMap((line) => {
      try {
        const v: unknown = JSON.parse(line);
        return isEvent(v) ? [v] : [];
      } catch {
        return [];
      }
    }).slice(-MAX);
  } catch {
    // no journal yet
  }
  file = path;
  events = [...earlier, ...events].slice(-MAX);
  rewrite(path);
  return earlier;
}

export function note(kind: string, fields: Record<string, unknown> = {}): void {
  const e: JournalEvent = { t: new Date().toISOString(), kind, ...fields };
  events.push(e);
  if (events.length > MAX) events = events.slice(-MAX);
  if (!file) return;
  console.log(`[safari-harness] ${kind}`, Object.keys(fields).length ? JSON.stringify(fields) : "");
  // The bridge notes as it connects and fails requests: a journal it cannot
  // write (its folder deleted, the disk full) must not stop either.
  try {
    if (++appended < MAX) appendFileSync(file, `${JSON.stringify(e)}\n`);
    else rewrite(file);
  } catch (err) {
    console.error("[safari-harness] journal not written:", err instanceof Error ? err.message : err);
  }
}

export function recent(n = 20): JournalEvent[] {
  return events.slice(-n);
}
