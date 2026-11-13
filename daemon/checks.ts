// What open and goto learn of a site's bot check, kept with its site notes
// (notes.ts), and how the next visit, any agent's, applies it by itself:
// - a site that turned the browser away for a visit too soon after the one
//   before gets its next visit spaced out to the gap that got through, or
//   twice the gap that did not, up to PACE_MS;
// - a check that let Safari through by itself is waited on as long as it
//   took, up to PASS_MS, and one that waiting never cleared is not waited
//   on, and handoff calls the user at once.
// The harness never answers a check: these only choose when to load a page
// and how long to wait on one.

import { PASS_MS, passesByItself, SETTLE_MS, settledChallenge, type Challenge } from "./challenge.ts";
import { checkLearned, learnCheck, pageHost, type CheckLearned } from "./notes.ts";

// reflex-gate on 11-12 turned away visits 7 to 30 s after the one before
// and let through every one 40 s or more after it.
export const PACE_MS = 60_000;
const PACE_MIN_MS = 20_000;
// waiting is given up on a check after it failed this many visits running
const VAIN = 2;

// When each host was last visited, and the gap before each tab's visit.
const visits = new Map<string, number>();
const gaps = new Map<number, number>();

const today = () => new Date().toLocaleDateString("sv");
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

// The gap a site learned to need between visits; undefined for none.
function spacing(c: CheckLearned | undefined): number | undefined {
  if (c?.blockedGapMs === undefined) return undefined;
  return Math.min(PACE_MS, c.passedGapMs ?? Math.max(PACE_MIN_MS, 2 * c.blockedGapMs));
}

// A site whose blocks came from visits too close together: its block is
// spaced out (paced), not a wall to skip (reads.ts walled).
export const paces = (url: string) => spacing(checkLearned(url)) !== undefined;

// A check that waiting has not cleared on this site.
export function waitsInVain(url: unknown): boolean {
  const c = checkLearned(url);
  return c !== undefined && c.clearedMs === undefined && (c.waitFailed ?? 0) >= VAIN;
}

// Called as a visit to url starts: waits out the gap the site needs since
// the last visit, and answers that visit's gap and a note when it waited.
export async function paced(url: string): Promise<{ gap?: number; note?: string }> {
  const host = pageHost(url);
  if (host === undefined) return {};
  const last = visits.get(host);
  const need = spacing(checkLearned(url));
  let note: string | undefined;
  if (last !== undefined && need !== undefined) {
    const wait = need - (Date.now() - last);
    if (wait > 0) {
      await Bun.sleep(wait);
      note = `waited ${seconds(wait)} before loading: ${host} turned away visits that came too soon after the last (learned bot check)`;
    }
  }
  const now = Date.now();
  visits.set(host, now);
  return { ...(last === undefined ? {} : { gap: now - last }), ...(note ? { note } : {}) };
}

type Seen = { challenge: Challenge | null | undefined; signal?: string; waitedOn?: number; waited: number };

function learnt(url: string, gap: number | undefined, s: Seen): void {
  learnCheck(url, (was) => {
    const c = s.challenge;
    if (c === null) return was;
    if (c === undefined || c.where === "box") {
      if (was === undefined) return undefined;
      const next = { ...was };
      if (s.waitedOn !== undefined && c === undefined) next.clearedMs = Math.max(was.clearedMs ?? 0, s.waitedOn);
      if (c === undefined && gap !== undefined && was.blockedGapMs !== undefined && gap > was.blockedGapMs && (was.passedGapMs === undefined || gap < was.passedGapMs)) next.passedGapMs = gap;
      return next;
    }
    const next: CheckLearned = { ...was, kind: c.kind, where: c.where, signal: s.signal ?? was?.signal ?? "unnamed", last: today() };
    if (c.where === "block" && gap !== undefined) {
      next.blockedGapMs = Math.max(was?.blockedGapMs ?? 0, gap);
      if (next.passedGapMs !== undefined && next.passedGapMs <= next.blockedGapMs) delete next.passedGapMs;
    }
    if (passesByItself(c) && s.waited > 0) next.waitFailed = (was?.waitFailed ?? 0) + 1;
    return next;
  });
}

// open and goto's wait on a check that lets the browser through
// (settledChallenge), as long as the site learned it takes, then learning
// what it showed. gap is the visit's, from paced.
export async function settledVisit(tab: number, url: string, gap: number | undefined) {
  if (gap === undefined) gaps.delete(tab);
  else gaps.set(tab, gap);
  const was = checkLearned(url);
  const vain = waitsInVain(url);
  const waited = was?.clearedMs !== undefined ? Math.min(PASS_MS, Math.max(SETTLE_MS, was.clearedMs + 2000)) : vain ? 0 : SETTLE_MS;
  const s = await settledChallenge(tab, waited);
  const page = s.top?.url ?? url;
  learnt(page, gap, { ...s, waited });
  const note = vain && s.challenge && passesByItself(s.challenge) ? `not waited on: waiting never cleared this check on ${pageHost(page)} (learned bot check); hand it to the user` : undefined;
  return { ...s, ...(note ? { note } : {}) };
}

// A check a later read of the tab showed (snapshot, a missed wait): a block
// there is learned against the gap before the tab's visit.
export function seenLater(tab: number, url: string | undefined, found: { challenge: Challenge; signal: string } | null | undefined): void {
  if (!url || !found || found.challenge.where !== "block") return;
  learnt(url, gaps.get(tab), { ...found, waited: 0 });
}

// How a handoff on a page of url ended: the check let Safari through by
// itself waitedMs into the handoff, after open or goto had waited
// SETTLE_MS on it, or a person cleared it.
export function handedOff(url: string, byItself: boolean, waitedMs: number): void {
  learnCheck(url, (was) => {
    if (was === undefined) return undefined;
    return byItself ? { ...was, clearedMs: Math.max(was.clearedMs ?? 0, SETTLE_MS + waitedMs) } : { ...was, person: (was.person ?? 0) + 1 };
  });
}
