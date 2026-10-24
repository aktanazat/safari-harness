// What a task's agents read and met, for the task's later loads: map's
// pages read in the last 10 minutes, and the bot checks sites showed. A
// task is the agent process its calls come from (owner.ts): a lead and its
// helpers share one, and nothing passes between tasks. On 10-23 a kernel
// research task's 1526 loads covered 1016 addresses, and 297 of them read
// a page another of its agents had read (K9); on 10-22 five agents of a
// shopping task met Yelp's DataDome check six times in 2 h 22 min (SR-2).

import type { Challenge } from "./challenge.ts";
import { currentOwner, currentTask, watchOwner } from "./owner.ts";
import { site } from "./receipt.ts";

export const KEEP_MS = 10 * 60_000;
// The characters of the values kept, every task's together; the oldest go
// first past it.
const MAX_CHARS = 32_000_000;

type Kept = { owner: number; at: number; task?: string };
const reads = new Map<string, Kept & { value: unknown; chars: number }>();
const checks = new Map<string, Kept & { challenge: Challenge }>();
let chars = 0;
const watched = new Set<number>();

function owner(): number | undefined {
  const pid = currentOwner();
  if (pid === undefined || watched.has(pid)) return pid;
  watched.add(pid);
  watchOwner(pid, () => {
    watched.delete(pid);
    for (const [key, read] of reads) if (read.owner === pid) drop(key);
    for (const [key, check] of checks) if (check.owner === pid) checks.delete(key);
  });
  return pid;
}

function drop(key: string) {
  const read = reads.get(key);
  if (!read) return;
  reads.delete(key);
  chars -= read.chars;
}

// Which of the task's agents it was, as omp names a task [session, agent]
// (omp/index.ts), and how long ago.
function by(kept: Kept): { who: string; when: string } {
  const s = Math.round((Date.now() - kept.at) / 1000);
  const when = s < 120 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  if (kept.task !== undefined && kept.task === currentTask()) return { who: "you", when };
  let agent: unknown;
  try {
    agent = kept.task === undefined ? undefined : (JSON.parse(kept.task) as unknown[])[1];
  } catch {}
  return { who: typeof agent === "string" ? agent : "another agent", when };
}

// A page as read (the read and its arguments) answered it at url, and
// whose read it was; undefined unless this task read it in the last
// KEEP_MS.
export function recall(read: string, url: string): { value: unknown; from: string } | undefined {
  const pid = owner();
  if (pid === undefined) return undefined;
  const key = JSON.stringify([pid, read, url]);
  const kept = reads.get(key);
  if (!kept) return undefined;
  if (Date.now() - kept.at > KEEP_MS) {
    drop(key);
    return undefined;
  }
  const { who, when } = by(kept);
  return { value: kept.value, from: `from ${who === "you" ? "your" : `${who}'s`} read ${when}` };
}

export function keep(read: string, url: string, value: unknown) {
  const pid = owner();
  if (pid === undefined) return;
  const size = JSON.stringify(value).length;
  if (size > MAX_CHARS) return;
  const key = JSON.stringify([pid, read, url]);
  drop(key);
  reads.set(key, { owner: pid, at: Date.now(), task: currentTask(), value, chars: size });
  chars += size;
  for (const old of reads.keys()) {
    if (chars <= MAX_CHARS) break;
    drop(old);
  }
}

// A check that stood in for a page of url's site, or turned the browser
// away, as an open or a goto of this task met it (tools.ts); a page of the
// site that loads with none ends it.
export function met(url: string, challenge: Challenge | null | undefined) {
  const pid = owner();
  const host = URL.parse(url)?.hostname;
  if (pid === undefined || !host || challenge === undefined || challenge?.where === "box") return;
  const key = JSON.stringify([pid, site(host)]);
  if (challenge === null) checks.delete(key);
  else checks.set(key, { owner: pid, at: Date.now(), task: currentTask(), challenge });
}

// Why url is not loaded again: its site showed this task a check in the
// last KEEP_MS.
export function checked(url: string): { error: string; challenge: Challenge } | undefined {
  const pid = owner();
  const host = URL.parse(url)?.hostname;
  if (pid === undefined || !host) return undefined;
  const key = JSON.stringify([pid, site(host)]);
  const check = checks.get(key);
  if (!check) return undefined;
  if (Date.now() - check.at > KEEP_MS) {
    checks.delete(key);
    return undefined;
  }
  const { who, when } = by(check);
  const { kind, where } = check.challenge;
  const error = where === "block"
    ? `${site(host)} turned the browser away (${kind}) for ${who} ${when}, so it was not loaded again; the user cannot clear that either: skip it`
    : `${site(host)} showed ${kind === "other" ? "a bot check" : `a ${kind} bot check`} to ${who} ${when}, so it was not loaded again: hand it to the user once (open it, then handoff), or skip it; fresh: true loads it anyway`;
  return { error, challenge: check.challenge };
}
