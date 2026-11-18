// An agent's web search: Google through Safari first, Bing when Google's
// line is long or Google asks for its human check, and the local page
// store (page-store.ts) for a repeat of a recent query and for pages agents
// already read. Never solves or evades a bot check: once Google shows its
// "unusual traffic" page, every search on the Mac goes to Bing for
// GOOGLE_REST_MS, and the owner is asked only when no engine answers.
//
// On 11-02..08, 1,874 searches took 12.0 s median and 59.7 s at p90, with
// 30.4% failing: every search on the Mac waits for one Google turn 3 s
// after the last, and 54% arrived less than 3 s apart. On 11-18 32 agents
// asked 4 to 6 searches at a time, about 40 a minute fit through both
// engines, and searches waited up to 7.7 minutes: a search that would wait
// past MAX_WAIT_MS on both is now told at once when to search again.

import { HarnessError } from "../failures.ts";
import { SEARCH_GAP_MS } from "../pace.ts";
import { bingSearch } from "./bing-search.ts";
import { GOOGLE_REST_MS, googleSearch, HumanCheck, SearchBusy, type SearchResult } from "./google-search.ts";
import type { SiteKit } from "./kit.ts";

// The first wait asked of each engine's line; past it the other engine is
// asked, then both again twice as long, so a search takes whichever load
// starts first. One gap: an agent searching alone, one search after
// another, stays on Google, and Bing takes the searches that would queue
// behind it.
const NEAR_MS = SEARCH_GAP_MS;
// The longest a search waits for its load to start: some MCP clients end a
// call at 60 s, and the load and its read take seconds more.
const MAX_WAIT_MS = 45_000;
// A query asked again this soon is answered from the store.
const REPEAT_MS = 10 * 60_000;

export type PageHit = { url: string; title: string; readAt: number; excerpt: string };
export type WebSearch = { engine: "google" | "bing" | "stored"; results: SearchResult[]; notes: string[]; read: PageHit[] };

const limitedUntil = (e: unknown) => (e instanceof HarnessError && e.code === "rate_limited" && e.detail && typeof e.detail === "object" && "resetAt" in e.detail ? Number(e.detail.resetAt) : undefined);
const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// No engine could start the search within MAX_WAIT_MS: when the soonest one
// may, and what to do meanwhile. Safari not loading results pages at all
// is named apart from a long line.
function busyError(busy: SearchBusy[]): HarnessError {
  const resetAt = Math.min(...busy.map((b) => b.at));
  const s = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  const stalled = busy.find((b) => b.stalled !== undefined)?.stalled;
  const why = stalled === undefined
    ? `Google and Bing each load one results page every ${SEARCH_GAP_MS / 1000} s for every agent on this Mac, and their lines are full until ${clock(resetAt)}`
    : `Safari has loaded no results page since ${clock(stalled)} (it is overloaded or stuck)`;
  return new HarnessError("rate_limited", `web search is busy: ${why}. Search again in ${s} s; meanwhile read addresses you already know with read, or search inside a site with its own search page (safari guide reference research).`, { detail: { host: "web search", resetAt } });
}

type Stored = { engine: string; results: SearchResult[]; at: number };

// The results the store kept for query, no older than maxAge ms. The store
// is a help, never a gate: when it fails the search goes on without it.
async function searched(kit: SiteKit, query: string, maxAge: number): Promise<Stored | undefined> {
  const r = await kit.invoke("pages", { do: "searched", query, maxAge }).catch(() => undefined);
  return r && typeof r === "object" && "results" in r && Array.isArray(r.results) && "at" in r && typeof r.at === "number" && "engine" in r && typeof r.engine === "string" ? { engine: r.engine, results: r.results, at: r.at } : undefined;
}

// Pages agents already read that have every word of query.
async function readBefore(kit: SiteKit, query: string): Promise<PageHit[]> {
  const r = await kit.invoke("pages", { do: "find", query, limit: 3 }).catch(() => undefined);
  return r && typeof r === "object" && "pages" in r && Array.isArray(r.pages) ? r.pages : [];
}

export function webSearch(kit: SiteKit) {
  const google = googleSearch(kit);
  const bing = bingSearch(kit);

  // Google, unless Bing's load starts first, Google shows its human check
  // or is resting after one, or finds nothing. Results, the engine, and
  // what to tell the agent; when neither engine starts it within
  // MAX_WAIT_MS of the ask, a rate_limited error that says when to search
  // again.
  async function engines(query: string): Promise<{ engine: "google" | "bing"; results: SearchResult[]; notes: string[] }> {
    const notes: string[] = [];
    const busy: SearchBusy[] = [];
    let googleOpen = true;
    const deadline = Date.now() + MAX_WAIT_MS;
    for (let step = NEAR_MS; ; step *= 2) {
      if (googleOpen) {
        try {
          const { results } = await google.search(query, { maxWait: Math.max(0, Math.min(step, deadline - Date.now())) });
          if (results.length) return { engine: "google", results, notes };
          notes.push("Google returned no readable results, so Bing answered.");
          googleOpen = false;
        } catch (e) {
          if (e instanceof SearchBusy) busy.push(e);
          else {
            const until = limitedUntil(e);
            if (until !== undefined) notes.push(`Google is resting after its human check until ${clock(until)}, so Bing answered.`);
            else if (e instanceof HumanCheck) notes.push(`Google asked for its human check, so Bing answered; searches use Bing until ${clock(Date.now() + GOOGLE_REST_MS)}.`);
            else throw e;
            googleOpen = false;
          }
        }
      }
      try {
        const { results } = await bing.search(query, { maxWait: Math.max(0, Math.min(step, deadline - Date.now())) });
        return { engine: "bing", results, notes: googleOpen ? [...notes, "Google was busy with other searches, so Bing answered."] : notes };
      } catch (e) {
        if (!(e instanceof SearchBusy)) throw e;
        busy.push(e);
      }
      if (step >= MAX_WAIT_MS) throw busyError(busy);
    }
  }

  return {
    async search(query: string, opts: { limit?: number } = {}): Promise<WebSearch> {
      const q = query.trim();
      if (!q) throw new Error("search needs a query");
      const limit = opts.limit ?? 10;
      const [repeat, local] = await Promise.all([searched(kit, q, REPEAT_MS), readBefore(kit, q)]);
      if (repeat) return { engine: "stored", results: repeat.results.slice(0, limit), notes: [`The same search ran at ${clock(repeat.at)} (${repeat.engine}); these are its results.`], read: local };
      try {
        const found = await engines(q);
        await kit.invoke("pages", { do: "save_search", query: q, engine: found.engine, results: found.results }).catch(() => undefined);
        return { ...found, results: found.results.slice(0, limit), read: local };
      } catch (e) {
        const stored = await searched(kit, q, 30 * 86_400_000);
        if (stored) return { engine: "stored", results: stored.results.slice(0, limit), notes: [`No engine answered (${message(e)}); these are the results the same search got on ${new Date(stored.at).toISOString().slice(0, 10)}.`], read: local };
        if (local.length) return { engine: "stored", results: [], notes: [`No engine answered (${message(e)}); below are pages agents already read that match.`], read: local };
        throw e;
      }
    },
  };
}
