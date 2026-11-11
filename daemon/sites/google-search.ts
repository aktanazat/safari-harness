// Google Search for the REPL and web search: the organic results of a
// query, read off the results page the daemon loads in its own tab for
// Google (search-tabs.ts), so Google sees the owner's normal Safari
// session. Google flags bursts of queries: searches run one at a time, a
// few seconds apart, and a query that lands on its "unusual traffic" page
// throws, since only the owner can pass that check, in Safari.

import type { SiteKit } from "./kit.ts";

const ORIGIN = "https://www.google.com";
const PAGE_SIZE = 10;
// A search's turn starts at least this long after the one before it, from
// any agent or session (pace.ts).
export const GOOGLE_GAP_MS = 3000;
// How long every Google search, from any agent or session, rests after one
// meets its human check: the check shows in the one Google tab they all
// load in (search-tabs.ts), where the owner passes it.
export const GOOGLE_REST_MS = 10 * 60_000;

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchPage = { query: string; start: number; results: SearchResult[]; nextStart?: number };

// Google's "unusual traffic" page, which only the owner can pass, in Safari.
export class HumanCheck extends Error {
  constructor(readonly url: string) {
    super(`google search is asking for a human check (its "unusual traffic" page) at ${url}; the owner has to pass it in Safari, in the Google tab of the harness's web search window, and every Google search rests 10 minutes meanwhile`);
  }
}

type Collected = { url: string; captcha: boolean; results: SearchResult[]; next: string | null };

// Runs in the results page (search-tabs.ts). Organic results carry
// data-rpos; the title is the h3 inside a link; the snippet is the block's
// text after the title and source lines, minus Google's own "Read more"
// and "Missing: …" notes. Class names churn, so none are used.
export const COLLECT = `(() => {
  const out = { url: location.href, captcha: location.pathname.startsWith("/sorry") || /unusual traffic/i.test(document.body.innerText), results: [], next: null };
  const seen = new Set();
  for (const block of document.querySelectorAll("#rso div[data-rpos], #search div[data-rpos]")) {
    if (block.parentElement.closest("div[data-rpos]")) continue;
    const h3 = block.querySelector("h3");
    const link = h3 && h3.closest("a[href]");
    if (!link || !/^https?:/.test(link.href) || seen.has(link.href)) continue;
    seen.add(link.href);
    const lines = block.innerText.split("\\n").map((l) => l.trim()).filter(Boolean);
    const title = h3.innerText.trim();
    const after = lines.indexOf(title);
    const snippet = lines.slice(after + 1).filter((l) => !/^https?:\\/\\//.test(l) && !l.startsWith(link.hostname) && l.length > 24 && !/^\\d+ days? ago$/.test(l) && !/^Missing: /.test(l)).map((l) => l.replace(/\\s*Read more$/, "")).join(" ").slice(0, 600);
    out.results.push({ title, url: link.href, snippet });
  }
  const next = document.querySelector("a#pnnext");
  out.next = next ? next.href : null;
  return out;
})()`;

export function googleSearch(kit: SiteKit) {
  return {
    // One page of organic results for query; start is Google's page
    // offset (0, 10, 20, ...) and nextStart in the answer is the start of
    // the page after it, when there is one. limit caps the results kept.
    // paced: false when the caller has taken Google's turn (web-search.ts).
    async search(query: string, opts: { limit?: number; start?: number; paced?: boolean } = {}): Promise<SearchPage> {
      const q = query.trim();
      if (!q) throw new Error("search needs a query");
      const start = Math.max(0, Math.floor(opts.start ?? 0));
      const limit = opts.limit ?? PAGE_SIZE;
      const url = `${ORIGIN}/search?q=${encodeURIComponent(q)}${start ? `&start=${start}` : ""}`;
      if (opts.paced !== false) await kit.turn(ORIGIN, GOOGLE_GAP_MS);
      const got = (await kit.invoke("search_page", { url })) as Collected;
      if (got.captcha) {
        await kit.invoke("pace", { do: "hold", host: ORIGIN, until: Date.now() + GOOGLE_REST_MS });
        throw new HumanCheck(got.url);
      }
      const nextStart = got.next ? Number(new URL(got.next).searchParams.get("start")) : NaN;
      return { query: q, start, results: got.results.slice(0, limit), ...(Number.isFinite(nextStart) ? { nextStart } : {}) };
    },
  };
}
