// Google Search for the REPL: the organic results of a query, read off
// the results page loaded in a background tab of the kit's own, so Google
// sees the owner's normal Safari session. Google flags bursts of queries:
// searches run one at a time, a few seconds apart, and a query that lands
// on its "unusual traffic" page throws, since only the owner can pass that
// check, in Safari.

import type { SiteKit } from "./kit.ts";

const ORIGIN = "https://www.google.com";
const PAGE_SIZE = 10;

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchPage = { query: string; start: number; results: SearchResult[]; nextStart?: number };

type Collected = { url: string; captcha: boolean; results: SearchResult[]; next: string | null };

// Runs in the results page. Organic results carry data-rpos; the title is
// the h3 inside a link; the snippet is the block's text after the title
// and source lines, minus Google's own "Read more" and "Missing: …"
// notes. Class names churn, so none are used.
const COLLECT = `(() => {
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
    async search(query: string, opts: { limit?: number; start?: number } = {}): Promise<SearchPage> {
      const q = query.trim();
      if (!q) throw new Error("search needs a query");
      const start = Math.max(0, Math.floor(opts.start ?? 0));
      const limit = opts.limit ?? PAGE_SIZE;
      const tab = await kit.tab(ORIGIN);
      await kit.pace("google-search", 3000);
      const url = `${ORIGIN}/search?q=${encodeURIComponent(q)}${start ? `&start=${start}` : ""}`;
      await kit.invoke("goto", { tab, url });
      const got = await kit.eval<Collected>(ORIGIN, COLLECT);
      if (got.captcha) throw new Error(`google search is asking for a human check (its "unusual traffic" page) at ${got.url}; the owner has to pass it in Safari, in the tab the helper opened, then search again`);
      const nextStart = got.next ? Number(new URL(got.next).searchParams.get("start")) : NaN;
      return { query: q, start, results: got.results.slice(0, limit), ...(Number.isFinite(nextStart) ? { nextStart } : {}) };
    },
  };
}
