// What a task's agents read and met, for the task's later loads: map's
// pages read in the last 10 minutes, and the bot checks sites showed. A
// task is a session of the agent process its calls come from (owner.ts):
// a lead and the helpers it started share one, and nothing it read passes
// to another session or process; only a check that does not clear by
// itself is kept for every task, by host alone (walls). On 10-23 a kernel
// research task's 1526 loads covered 1016 addresses, and 297 of them read
// a page another of its agents had read (K9); on 10-22 five agents of a
// shopping task met Yelp's DataDome check six times in 2 h 22 min (SR-2).

import { passesByItself, type Challenge } from "./challenge.ts";
import { currentOwner, currentTask, watchOwner } from "./owner.ts";
import { site } from "./receipt.ts";

export const KEEP_MS = 10 * 60_000;
// The characters of the values kept, every task's together; the oldest go
// first past it.
const MAX_CHARS = 32_000_000;

type Kept = { owner: number; at: number; task?: string };
const reads = new Map<string, Kept & { value: unknown; chars: number }>();
const checks = new Map<string, Kept & { challenge: Challenge }>();
// Every task's together, by host, naming no agent and no page: a check
// that does not clear by itself in Safari, as any agent's open or map met
// it. osha.gov's showed 34 times in 27 sessions, 25 of them one lead's
// helpers on 10-28, and Google's reCAPTCHA 21 times in 13 (SafariFriction).
const walls = new Map<string, { at: number; challenge: Challenge }>();
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

// The key of what a task keeps: its process, its session, and parts. omp
// names a task [session, agent], and a helper's [its own session, agent,
// its lead's session] (omp/index.ts); another program's task is a session
// of its own.
function keyOf(pid: number, ...parts: string[]): string {
  const task = currentTask();
  let session = task ?? null;
  try {
    const named: unknown = task === undefined ? undefined : JSON.parse(task);
    if (Array.isArray(named) && typeof named[0] === "string") session = typeof named[2] === "string" ? named[2] : named[0];
  } catch {}
  return JSON.stringify([pid, session, ...parts]);
}

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 120 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

// Which of the task's agents it was, as omp names a task [session, agent,
// …] (omp/index.ts), and how long ago.
function by(kept: Kept): { who: string; when: string } {
  const when = ago(kept.at);
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
  const key = keyOf(pid, read, url);
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
  const key = keyOf(pid, read, url);
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
  if (!host || challenge === undefined || challenge?.where === "box") return;
  const wall = host.replace(/^www\./, "");
  if (challenge === null) walls.delete(wall);
  else if (!passesByItself(challenge)) walls.set(wall, { at: Date.now(), challenge });
  if (pid === undefined) return;
  const key = keyOf(pid, site(host));
  if (challenge === null) checks.delete(key);
  else checks.set(key, { owner: pid, at: Date.now(), task: currentTask(), challenge });
}

// Why url is not loaded again: its site showed this task a check in the
// last KEEP_MS, or its host showed any task one that stays (walled).
export function checked(url: string): { error: string; challenge: Challenge } | undefined {
  const pid = owner();
  const host = URL.parse(url)?.hostname;
  if (pid === undefined || !host) return walled(url);
  const key = keyOf(pid, site(host));
  const check = checks.get(key);
  if (!check) return walled(url);
  if (Date.now() - check.at > KEEP_MS) {
    checks.delete(key);
    return walled(url);
  }
  const { who, when } = by(check);
  const { kind, where } = check.challenge;
  const error = where === "block"
    ? `${site(host)} turned the browser away (${kind}) for ${who} ${when}, so it was not loaded again; the user cannot clear that either: skip it`
    : `${site(host)} showed ${kind === "other" ? "a bot check" : `a ${kind} bot check`} to ${who} ${when}, so it was not loaded again: open it in a tab and wait a few seconds, since many checks clear on their own in Safari; if it remains, use another permitted source or report that the page is unavailable; fresh: true loads it anyway`;
  return { error, challenge: check.challenge };
}

// Why url is not loaded again: its host showed some agent a check that does
// not clear by itself in the last KEEP_MS (met). Such a check waits for a
// person, so another load only meets it again.
export function walled(url: string): { error: string; challenge: Challenge } | undefined {
  const host = URL.parse(url)?.hostname.replace(/^www\./, "");
  const wall = host === undefined ? undefined : walls.get(host);
  if (host === undefined || !wall) return undefined;
  if (Date.now() - wall.at > KEEP_MS) {
    walls.delete(host);
    return undefined;
  }
  const { kind, where } = wall.challenge;
  const error = where === "block"
    ? `${host} turned this browser away (${kind}) ${ago(wall.at)}, so it was not loaded again; the user cannot clear that either: skip it`
    : `${host} showed this browser ${kind === "other" ? "a bot check" : `a ${kind} bot check`} ${ago(wall.at)}, so it was not loaded again: that check does not clear by waiting; use another permitted source (web_search for a search) or report that the page is unavailable; fresh: true loads it anyway`;
  return { error, challenge: wall.challenge };
}
