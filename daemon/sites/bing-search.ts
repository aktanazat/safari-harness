// Bing Search for the REPL and web search: the organic results of a query,
// read off the results page the daemon loads in its own tab for Bing
// (search-tabs.ts), as google-search.ts reads Google's. On 11-08 Bing gave
// a useful result on 18 of 20 real agent queries (Google 16) with no bot
// check in 51 loads, so web-search.ts sends a search here when Google's
// turn is far off or Google asks for its human check.

import type { SiteKit } from "./kit.ts";
import type { SearchPage } from "./google-search.ts";

const ORIGIN = "https://www.bing.com";
const PAGE_SIZE = 10;
const SITE = /(^|\s)site:(\S+)/gi;

function onSite(url: string, site: string): boolean {
  const u = URL.parse(url);
  if (!u) return false;
  const slash = site.indexOf("/");
  const host = slash < 0 ? site : site.slice(0, slash);
  const path = slash < 0 ? "" : site.slice(slash);
  const h = u.hostname.toLowerCase();
  return (h === host || h.endsWith(`.${host}`)) && u.pathname.startsWith(path);
}

type Collected = { url: string; captcha: boolean; results: { title: string; url: string; snippet: string }[] };

// Runs in the results page (search-tabs.ts). Bing streams its organic
// results in after the page is readable: the read waits for the pager (the
// list's end), or for the count to hold 1.5 s, 6 s at most. Result links go
// through Bing's /ck/a redirect, whose u parameter is "a1" and the address
// in base64url.
export const COLLECT = `(async () => {
  const until = Date.now() + 6000;
  let last = -1, since = Date.now();
  while (Date.now() < until) {
    if (document.querySelector("#b_results > li.b_pag, #b_results > li.b_no")) break;
    const n = document.querySelectorAll("#b_results > li.b_algo").length;
    if (n !== last) { last = n; since = Date.now(); }
    else if (n > 0 && Date.now() - since > 1500) break;
    await (typeof sh === "undefined" ? new Promise((r) => setTimeout(r, 150)) : sh.wait(150));
  }
  const text = document.body ? document.body.innerText : "";
  const out = { url: location.href, captcha: !!document.querySelector("#b_captcha, .b_captcha") || /One last step|solve the challenge below|verify you are a human/i.test(text), results: [] };
  const seen = new Set();
  for (const li of document.querySelectorAll("#b_results > li.b_algo")) {
    const a = li.querySelector("h2 a[href]");
    if (!a) continue;
    let href = a.href;
    const u = URL.parse(href);
    if (u && /(^|\\.)bing\\.com$/.test(u.hostname) && u.pathname.startsWith("/ck/a")) {
      const enc = u.searchParams.get("u");
      if (enc && enc.startsWith("a1")) {
        let b = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        while (b.length % 4) b += "=";
        try { href = new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))); } catch {}
      }
    }
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    const title = a.innerText.trim();
    const lines = li.innerText.split("\\n").map((l) => l.trim()).filter(Boolean);
    const after = lines.indexOf(title);
    const snippet = lines.slice(after + 1).filter((l) => l !== title && !/^https?:\\/\\//.test(l) && !l.includes(" › ") && l.length > 24).join(" ").slice(0, 600);
    out.results.push({ title, url: href, snippet });
  }
  return out;
})()`;

export function bingSearch(kit: SiteKit) {
  return {
    // One page of organic results for query; limit caps the results kept.
    // The caller has taken Bing's turn (web-search.ts).
    async search(query: string, opts: { limit?: number } = {}): Promise<SearchPage> {
      const asked = query.trim();
      if (!asked) throw new Error("search needs a query");
      // Bing in Safari answers any site: query with unrelated pages (11-08:
      // dictionary and Microsoft account pages for site:github.com), so the
      // host goes in as words and the results are kept to the site here.
      const sites = [...asked.matchAll(SITE)].map((m) => m[2].toLowerCase().replace(/^https?:\/\//, ""));
      const q = asked.replace(SITE, (_, space: string, site: string) => `${space}${site.replace(/^https?:\/\//, "").split("/")[0]}`);
      const url = `${ORIGIN}/search?q=${encodeURIComponent(q)}`;
      const got = (await kit.invoke("search_page", { url })) as Collected;
      if (got.captcha) throw new Error(`bing search is asking for a human check at ${got.url}`);
      const results = sites.length ? got.results.filter((r) => sites.some((site) => onSite(r.url, site))) : got.results;
      return { query: asked, start: 0, results: results.slice(0, opts.limit ?? PAGE_SIZE) };
    },
  };
}
