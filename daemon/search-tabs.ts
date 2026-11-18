// The tab each web search engine's results load in (sites/web-search.ts,
// and the REPL's googleSearch): one per engine for every agent, the
// daemon's own, in a window of its own. Before, each agent task's kit
// opened a tab, often in a new window, and the task's turn end closed it:
// from the 11-09 deploy to 11-11, 111 of 186 results pages loaded in a new
// tab, Google's at 1.1 s median against 0.7 s in a tab already open, and on
// 11-02..08 opening or moving tabs and windows failed 159 searches. A load
// whose answer was lost no longer holds back the next search's load of the
// same page either: this reads, so the repeat-action guard (mission.ts) has
// nothing to refuse.
//
// Searches of one engine take its tab in turn. A tab gone, one whose page
// stopped answering, and one cut off as the extension restarted are put
// aside and the search asked once more in a new tab: reading a results
// page changes nothing, so it can run twice. One last seen before the
// extension connected again is put aside unclosed (heldSearchTab in
// tools.ts). A new tab opens at the results asked for, never the engine's
// home page first: on 11-08 Google's home page was 1,732 of 10,654 loads in
// 6 days, each one no search needed. The tab closes once no search has
// used it for IDLE_MS (sweepOnce in tools.ts).
//
// Each load takes the engine's turn in the pacer (pace.ts) as it starts,
// so loads stay SEARCH_GAP_MS apart however long the line before them
// stood still. Turns used to be taken as each search was asked, so on
// 11-18, after Safari answered nothing for 3.6 minutes, the searches whose
// turns came due meanwhile loaded back to back, 40 Google results pages
// under 2.5 s apart, and Google showed its check two minutes later. A
// search that can go elsewhere (web search) gives maxWait: one that would
// start later than that, or wait behind a load Safari is not answering, is
// told when to ask again instead (busy). On 11-18 32 agents' searches
// waited up to 7.7 minutes in line, 174 of 235 over a minute.

import { challengeOf } from "./challenge.ts";
import { HarnessError, rateLimited } from "./failures.ts";
import { nextTurn, SEARCH_GAP_MS, turn, turnAt } from "./pace.ts";
import { met } from "./reads.ts";
import { closeTab, evaluate, heldSearchTab, navigate, openSearchTab, resolveTab } from "./tools.ts";

// Each engine's host, and the read that collects its results page, loaded
// as the engine is first searched: every CLI call and MCP server loads
// this file, and the site modules are the repl's (startup.test.ts).
const READS: Record<string, () => Promise<{ COLLECT: string }>> = {
  "www.google.com": () => import("./sites/google-search.ts"),
  "www.bing.com": () => import("./sites/bing-search.ts"),
};

// Whether url is a page a search loads on its engine's site: its results,
// or its robot check. Another page there (Google's travel or shopping
// pages) may hold a form the user typed in.
export function onSearchEngine(url: string | undefined): boolean {
  const u = url === undefined ? null : URL.parse(url);
  return u !== null && Object.hasOwn(READS, u.hostname) && (u.pathname === "/search" || u.pathname.startsWith("/sorry/"));
}

// A failure of the tab, not of the search: the tab is gone, its page
// stopped answering (background.js), or the extension's link went down
// mid-call (bridge.ts).
const SPENT = /^that tab is gone|did not answer.*; reload it with goto and retry$|^the Safari extension (?:disconnected|restarted) before it answered/;

// A failure of Safari, not of the page: the extension answered nothing in
// time (bridge.ts).
const UNANSWERED = /^extension request \S+ timed out after|^extension stuck:/;
// A results page loads in about a second; one still loading this long
// means Safari is not answering it. On 11-18 each load gave up after 52 s.
const STALL_MS = 15_000;
// When a search turned away by a stall is told to come back.
const STALL_RETRY_MS = 60_000;
// A load this long may have been held by Safari and sent only as it
// answered. Of 2,179 results pages loaded 11-14..18 the slowest took
// 2.4 s; a load slowed short of this keeps the engine's pace.
const HELD_MS = 2 * SEARCH_GAP_MS;

// waiting: searches queued and not yet loading; loading: since when the
// current load runs; stalled: since when Safari answered none of this
// engine's loads, and when that was found.
type Engine = { tab?: number; queue: Promise<unknown>; waiting: number; loading?: number; stalled?: { since: number; found: number } };
const engines = new Map<string, Engine>();

// A search not queued: when to ask again, and since when Safari has not
// answered this engine's loads, when that is why.
export type Busy = { busy: { at: number; stalled?: number } };

// Since when Safari has not answered this engine's loads: one timed out
// and none answered since, or the one loading now has run past STALL_MS.
function stalledSince(engine: Engine, now: number): number | undefined {
  return engine.stalled?.since ?? (engine.loading !== undefined && now - engine.loading > STALL_MS ? engine.loading : undefined);
}

// What the engine's read collected from url, a results page of Google or
// Bing, loaded in that engine's tab. With maxWait, busy instead when its
// load has not started maxWait ms after it was asked, would not, or would
// wait behind a load Safari is not answering; with a stall, one search at
// a time is let through to learn whether Safari answers again.
export async function searchPage(url: string, maxWait?: number): Promise<unknown> {
  const u = URL.parse(url);
  const read = u && u.protocol === "https:" && u.port === "" && !u.username && !u.password && u.pathname === "/search" && Object.hasOwn(READS, u.hostname) ? READS[u.hostname] : undefined;
  if (!u || read === undefined) throw new HarnessError("invalid_argument", "url must be a results page of Google or Bing: https://www.google.com/search?q=… or https://www.bing.com/search?q=…");
  const engine = engines.get(u.hostname) ?? { queue: Promise.resolve(), waiting: 0 };
  engines.set(u.hostname, engine);
  const asked = Date.now();
  const busy = (now: number): Busy => {
    const stalled = stalledSince(engine, now);
    return stalled === undefined ? { busy: { at: nextTurn(u.hostname) + engine.waiting * SEARCH_GAP_MS } } : { busy: { at: now + STALL_RETRY_MS, stalled } };
  };
  if (maxWait !== undefined) {
    if (stalledSince(engine, asked) !== undefined && (engine.waiting > 0 || engine.loading !== undefined)) return busy(asked);
    if (nextTurn(u.hostname) + engine.waiting * SEARCH_GAP_MS - asked > maxWait) return busy(asked);
  }
  engine.waiting++;
  // A load ahead of it may hang for the extension's whole limit (52 s on
  // 11-18), so a search with maxWait leaves the line when it runs out.
  let left: Busy | undefined;
  const late = Promise.withResolvers<Busy>();
  const timer = maxWait === undefined ? undefined : setTimeout(() => {
    engine.waiting--;
    left = busy(Date.now());
    late.resolve(left);
  }, asked + maxWait - Date.now());
  const loaded = engine.queue.then(async () => {
    if (left) return left;
    clearTimeout(timer);
    engine.waiting--;
    if (maxWait !== undefined && engine.stalled !== undefined && asked < engine.stalled.found) return busy(Date.now());
    const t = turn(u.hostname, SEARCH_GAP_MS);
    // A hold that began while it waited (Google's check met by the search
    // before it): one that can go elsewhere is told when the hold ends.
    if ("resetAt" in t) {
      if (maxWait !== undefined) return { busy: { at: t.resetAt } } satisfies Busy;
      throw rateLimited(t.host, t.resetAt, t.guessed);
    }
    if (t.at > Date.now()) await Bun.sleep(t.at - Date.now());
    const since = Date.now();
    engine.loading = since;
    try {
      const result = await load(engine, url, (await read()).COLLECT);
      engine.stalled = undefined;
      return result;
    } catch (e) {
      if (e instanceof Error && UNANSWERED.test(e.message)) engine.stalled ??= { since, found: Date.now() };
      throw e;
    } finally {
      engine.loading = undefined;
      // Safari may have sent a load it held only as it answered: the next
      // one waits a gap from then.
      if (Date.now() - since > HELD_MS) turnAt(u.hostname, SEARCH_GAP_MS);
    }
  });
  engine.queue = loaded.catch(() => {});
  return timer === undefined ? loaded : Promise.race([loaded, late.promise]);
}

async function load(engine: Engine, url: string, read: string): Promise<unknown> {
  for (let again = false; ; again = true) {
    const held = engine.tab === undefined ? undefined : heldSearchTab(engine.tab);
    try {
      engine.tab = held === undefined ? await openSearchTab(url) : (await navigate(await resolveTab(held), url)).id;
      const { result } = (await evaluate({ tab: engine.tab, expression: read })) as { result: { url: string; captcha: boolean } };
      // a check a model's open of the engine meets next, or none (reads.ts)
      met(result.url, result.captcha ? await challengeOf(engine.tab) : null);
      return result;
    } catch (e) {
      if (again || !(e instanceof Error && SPENT.test(e.message))) throw e;
      // closed as an idle tab is, unless the user has it in front or has
      // typed in it
      const spent = engine.tab === undefined ? undefined : heldSearchTab(engine.tab);
      if (spent !== undefined) void closeTab(spent, "as it stopped answering searches", "idle").catch(() => {});
      engine.tab = undefined;
    }
  }
}
