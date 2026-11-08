// An agent's web search: Google through Safari first, Bing when Google's
// turn is far off or Google asks for its human check, and the local page
// store (page-store.ts) for a repeat of a recent query and for pages agents
// already read. Never solves or evades a bot check: once Google shows its
// "unusual traffic" page, every search on the Mac goes to Bing for
// GOOGLE_REST_MS, and the owner is asked only when no engine answers.
//
// On 11-02..08, 1,874 searches took 12.0 s median and 59.7 s at p90, with
// 30.4% failing: every search on the Mac waits for one Google turn 3 s
// after the last, and 54% arrived less than 3 s apart.

import { HarnessError } from "../failures.ts";
import { bingSearch } from "./bing-search.ts";
import { GOOGLE_GAP_MS, googleSearch, HumanCheck, type SearchResult } from "./google-search.ts";
import type { SiteKit } from "./kit.ts";

const GOOGLE = "https://www.google.com";
const BING = "https://www.bing.com";
const BING_GAP_MS = 3000;
// A turn this near is taken; past it the other engine is asked, then both
// again twice as far, so a search takes whichever turn comes first. One
// Google gap: an agent searching alone, one search after another, stays on
// Google, and Bing takes the searches that would queue behind it.
const NEAR_MS = GOOGLE_GAP_MS;
// How long Google rests after its human check.
const GOOGLE_REST_MS = 10 * 60_000;
// A query asked again this soon is answered from the store.
const REPEAT_MS = 10 * 60_000;

export type PageHit = { url: string; title: string; readAt: number; excerpt: string };
export type WebSearch = { engine: "google" | "bing" | "stored"; results: SearchResult[]; notes: string[]; read: PageHit[] };

const limitedUntil = (e: unknown) => (e instanceof HarnessError && e.code === "rate_limited" && e.detail && typeof e.detail === "object" && "resetAt" in e.detail ? Number(e.detail.resetAt) : undefined);
const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  // Google, unless Bing's turn comes first, Google shows its human check or
  // is resting after one, or finds nothing. Results, the engine, and what
  // to tell the agent.
  async function engines(query: string): Promise<{ engine: "google" | "bing"; results: SearchResult[]; notes: string[] }> {
    const notes: string[] = [];
    let googleOpen = true;
    for (let near = NEAR_MS; ; near *= 2) {
      if (googleOpen) {
        let mine = false;
        try {
          mine = await kit.turn(GOOGLE, GOOGLE_GAP_MS, undefined, near);
        } catch (e) {
          const until = limitedUntil(e);
          if (until === undefined) throw e;
          notes.push(`Google is resting after its human check until ${clock(until)}, so Bing answered.`);
          googleOpen = false;
        }
        if (mine) {
          try {
            const results = (await google.search(query, { paced: false })).results;
            if (results.length) return { engine: "google", results, notes };
            notes.push("Google returned no readable results, so Bing answered.");
          } catch (e) {
            if (!(e instanceof HumanCheck)) throw e;
            await kit.invoke("pace", { do: "hold", host: GOOGLE, until: Date.now() + GOOGLE_REST_MS });
            notes.push(`Google asked for its human check, so Bing answered; searches use Bing until ${clock(Date.now() + GOOGLE_REST_MS)}.`);
          }
          googleOpen = false;
        }
      }
      if (await kit.turn(BING, BING_GAP_MS, undefined, googleOpen ? near : undefined)) {
        const results = (await bing.search(query)).results;
        return { engine: "bing", results, notes: googleOpen ? [...notes, "Google was busy with other searches, so Bing answered."] : notes };
      }
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
