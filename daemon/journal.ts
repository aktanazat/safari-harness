// The daemon's journal: what happened to it and when, for whoever asks why
// a call failed or the extension went away. A bounded list of timestamped
// events (start and stop, extension connects and disconnects, requests the
// extension never answered, pages it had to re-inject); /health shows the
// latest, so `safari status` does. The daemon keeps it in a file beside its
// log, so it survives restarts; anywhere else (tests) it stays in memory.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JournalEvent = { t: string; kind: string } & Record<string, unknown>;

// 200 held three minutes of a storm, which notes about one event a second,
// and storms ran 5 to 29 minutes (10-08 to 10-16): their starts were gone
// by the time anyone looked.
const MAX = 2000;
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

// A storm notes about one event a second, nearly all one timeout again and
// again (DaemonLogs): an event alike to the one before it (its kind and
// fields, times and count aside) joins it, n counting them, since when the
// first came, t when the latest did.
function alike(a: JournalEvent, b: JournalEvent): boolean {
  const fields = (e: JournalEvent) => JSON.stringify(Object.entries(e).filter(([k]) => k !== "t" && k !== "n" && k !== "since"));
  return fields(a) === fields(b);
}

function joined(run: JournalEvent, e: JournalEvent): JournalEvent {
  const n = typeof e.n === "number" ? e.n : (typeof run.n === "number" ? run.n : 1) + 1;
  return { ...e, n, since: typeof run.since === "string" ? run.since : run.t };
}

// Loads the events an earlier daemon left in path and appends new ones to
// it. Returns the earlier events, oldest first.
export function openJournal(path: string): JournalEvent[] {
  mkdirSync(dirname(path), { recursive: true });
  const earlier: JournalEvent[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isEvent(v)) continue;
      // each event of a run was written as it joined
      const last = earlier.at(-1);
      if (last && alike(last, v)) earlier[earlier.length - 1] = joined(last, v);
      else earlier.push(v);
    }
  } catch {
    // no journal yet
  }
  const kept = earlier.slice(-MAX);
  file = path;
  events = [...kept, ...events].slice(-MAX);
  rewrite(path);
  return kept;
}

export function note(kind: string, fields: Record<string, unknown> = {}): void {
  const fresh: JournalEvent = { t: new Date().toISOString(), kind, ...fields };
  const last = events.at(-1);
  const e = last && alike(last, fresh) ? joined(last, fresh) : fresh;
  if (e === fresh) events.push(e);
  else events[events.length - 1] = e;
  if (events.length > MAX) events = events.slice(-MAX);
  if (!file) return;
  // The log says the first of a run, and again each time it doubles.
  const n = typeof e.n === "number" ? e.n : 1;
  if ((n & (n - 1)) === 0) console.log(`[safari-harness] ${kind}`, Object.keys(fields).length ? JSON.stringify(fields) : "", ...(n > 1 ? [`(${n} alike since ${String(e.since)})`] : []));
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

// Keeps a log's last max lines. It is rewritten in place: launchd holds the
// daemon's log open for appending, so the daemon's next line lands after
// them, where a copy renamed over it would leave the daemon writing to a
// file no longer there.
export function trimLog(path: string, max: number): void {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return; // no log yet
  }
  // the last is what follows the final newline
  if (lines.length - 1 > max) writeFileSync(path, lines.slice(-max - 1).join("\n"));
}
