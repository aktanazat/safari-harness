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
// used it for 20 minutes (sweepOnce in tools.ts).

import { challengeOf } from "./challenge.ts";
import { HarnessError } from "./failures.ts";
import { met } from "./reads.ts";
import { COLLECT as BING } from "./sites/bing-search.ts";
import { COLLECT as GOOGLE } from "./sites/google-search.ts";
import { closeTab, evaluate, heldSearchTab, navigate, openSearchTab, resolveTab } from "./tools.ts";

// Each engine's host, and the read that collects its results page.
const READS: Record<string, string> = { "www.google.com": GOOGLE, "www.bing.com": BING };

// A failure of the tab, not of the search: the tab is gone, its page
// stopped answering (background.js), or the extension's link went down
// mid-call (bridge.ts).
const SPENT = /^that tab is gone|did not answer.*; reload it with goto and retry$|^the Safari extension (?:disconnected|restarted) before it answered/;

type Engine = { tab?: number; queue: Promise<unknown> };
const engines = new Map<string, Engine>();

// What the engine's read collected from url, a results page of Google or
// Bing, loaded in that engine's tab.
export async function searchPage(url: string): Promise<unknown> {
  const u = URL.parse(url);
  const read = u && u.protocol === "https:" && u.port === "" && !u.username && !u.password && u.pathname === "/search" && Object.hasOwn(READS, u.hostname) ? READS[u.hostname] : undefined;
  if (!u || read === undefined) throw new HarnessError("invalid_argument", "url must be a results page of Google or Bing: https://www.google.com/search?q=… or https://www.bing.com/search?q=…");
  const engine = engines.get(u.hostname) ?? { queue: Promise.resolve() };
  engines.set(u.hostname, engine);
  const loaded = engine.queue.then(() => load(engine, url, read));
  engine.queue = loaded.catch(() => {});
  return loaded;
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
