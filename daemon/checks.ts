// What open and goto learn of a site's bot check, kept with its site notes
// (notes.ts), and how the next visit, any agent's, applies it by itself:
// - a site whose own gate (not a vendor's firewall) turned the browser away
//   for a visit too soon after the one before gets its next visit spaced
//   out to the gap that got through, or twice the gap that did not, up to
//   PACE_MS; a visit whose turn is further off than the pacer's WAIT_MS
//   fails at once with it;
// - a check that let Safari through by itself is waited on as long as it
//   took, up to PASS_MS, and handoff calls the user at once on one that
//   waiting never cleared.
// The harness never answers a check: these only choose when to load a page
// and how long to wait on one.

import { PASS_MS, passesByItself, SETTLE_MS, settledChallenge, type Challenge } from "./challenge.ts";
import { checkLearned, learnCheck, pageHost, type CheckLearned } from "./notes.ts";
import { WAIT_MS } from "./pace.ts";

// reflex-gate on 11-12 turned away visits 7 to 30 s after the one before
// and let through every one 40 s or more after it.
export const PACE_MS = 60_000;
const PACE_MIN_MS = 20_000;
// waiting is given up on a check after it failed this many visits running
const VAIN = 2;

// When each host's last visit started, and each tab's visit: its host and
// the gap since the visit to that host before it.
const visits = new Map<string, number>();
const gaps = new Map<number, { host: string; gap: number }>();

const today = () => new Date().toLocaleDateString("sv");
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

// The gap a site learned to need between visits; undefined for none.
function spacing(c: CheckLearned | undefined): number | undefined {
  if (c?.blockedGapMs === undefined) return undefined;
  return Math.min(PACE_MS, c.passedGapMs ?? Math.max(PACE_MIN_MS, 2 * c.blockedGapMs));
}

// A site whose blocks came from visits too close together: its block is
// spaced out (paced), not a wall to skip (reads.ts met).
export const paces = (url: string) => spacing(checkLearned(url)) !== undefined;

// A check that waiting has not cleared on this site.
export function waitsInVain(url: unknown): boolean {
  const c = checkLearned(url);
  return c !== undefined && c.clearedMs === undefined && (c.waitFailed ?? 0) >= VAIN;
}

// Called as a visit to url starts: takes the site's next turn, the gap it
// learned to need after the last visit, before waiting for it, so visits
// asked for at once (a map, two agents) are spaced too. Answers the visit's
// gap and a note when it waited; a turn more than WAIT_MS off is not taken.
export async function paced(url: string): Promise<{ gap?: number; note?: string }> {
  const host = pageHost(url);
  if (host === undefined) return {};
  const last = visits.get(host);
  const need = spacing(checkLearned(url));
  const now = Date.now();
  const start = last !== undefined && need !== undefined ? Math.max(now, last + need) : now;
  const wait = start - now;
  if (wait > WAIT_MS) throw new Error(`not loaded: ${host} turned away visits that came too soon after the last (learned bot check), and its next turn is in ${seconds(wait)}: visit it then`);
  visits.set(host, start);
  if (wait > 0) await Bun.sleep(wait);
  const note = wait > 0 ? `waited ${seconds(wait)} before loading: ${host} turned away visits that came too soon after the last (learned bot check)` : undefined;
  return { ...(last === undefined ? {} : { gap: start - last }), ...(note ? { note } : {}) };
}

type Seen = { challenge: Challenge | null | undefined; signal?: string; waitedOn?: number };

// What a visit gap ms after the one before showed. A block that came
// PACE_MS or more after the last visit, or that a vendor's firewall served,
// is not one of pacing: the site turns the browser away however far apart
// its visits are, and stays a wall (reads.ts met). Any other answer is a
// visit that got through.
function learnt(url: string, gap: number | undefined, s: Seen): void {
  learnCheck(url, (was) => {
    const c = s.challenge;
    if (c === null) return was;
    const next: CheckLearned | undefined = c === undefined || c.where === "box" ? (was === undefined ? undefined : { ...was }) : { ...was, kind: c.kind, where: c.where, signal: s.signal ?? was?.signal ?? "unnamed", last: today() };
    if (next === undefined) return undefined;
    if (s.waitedOn !== undefined && c === undefined) next.clearedMs = Math.max(was?.clearedMs ?? 0, s.waitedOn);
    if (gap === undefined) return next;
    if (c?.where === "block") {
      if (gap >= PACE_MS || c.kind !== "other") {
        delete next.blockedGapMs;
        delete next.passedGapMs;
        return next;
      }
      next.blockedGapMs = Math.max(was?.blockedGapMs ?? 0, gap);
      if (next.passedGapMs !== undefined && next.passedGapMs <= next.blockedGapMs) delete next.passedGapMs;
    } else if (next.blockedGapMs !== undefined && gap > next.blockedGapMs && (next.passedGapMs === undefined || gap < next.passedGapMs)) next.passedGapMs = gap;
    return next;
  });
}

// open and goto's wait on a check that lets the browser through
// (settledChallenge), as long as the site learned it takes, then learning
// what it showed. gap is the visit's, from paced.
export async function settledVisit(tab: number, url: string, gap: number | undefined) {
  const host = pageHost(url);
  if (gap === undefined || host === undefined) gaps.delete(tab);
  else gaps.set(tab, { host, gap });
  const was = checkLearned(url);
  const vain = waitsInVain(url);
  const waited = was?.clearedMs !== undefined ? Math.min(PASS_MS, Math.max(SETTLE_MS, was.clearedMs + 2000)) : SETTLE_MS;
  const s = await settledChallenge(tab, waited);
  const page = s.top?.url ?? url;
  learnt(page, pageHost(page) === host ? gap : undefined, s);
  const note = vain && s.challenge && passesByItself(s.challenge) ? `waiting has not cleared this check on ${pageHost(page)} before (learned bot check); hand it to the user` : undefined;
  return { ...s, ...(note ? { note } : {}) };
}

// A check a later read of the tab showed (snapshot, a missed wait): a block
// there is learned against the gap before the tab's visit, when it is of
// the site that visit loaded.
export function seenLater(tab: number, url: string | undefined, found: { challenge: Challenge; signal: string } | null | undefined): void {
  if (!url || !found || found.challenge.where !== "block") return;
  const visit = gaps.get(tab);
  learnt(url, visit?.host === pageHost(url) ? visit?.gap : undefined, found);
}

// How a handoff on a page of url went: the check let Safari through by
// itself waitedMs into it, after open or goto had waited SETTLE_MS on it;
// it stayed through handoff's PASS_MS wait; or a person cleared it.
export function handedOff(url: string, how: "itself" | "stayed" | "person", waitedMs: number): void {
  learnCheck(url, (was) => {
    if (was === undefined) return undefined;
    if (how === "itself") return { ...was, clearedMs: Math.max(was.clearedMs ?? 0, SETTLE_MS + waitedMs) };
    return how === "stayed" ? { ...was, waitFailed: (was.waitFailed ?? 0) + 1 } : { ...was, person: (was.person ?? 0) + 1 };
  });
}
