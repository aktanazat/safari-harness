import { expect, test } from "bun:test";
import type { Invoke } from "../call.ts";
import { bingSearch } from "./bing-search.ts";
import { SiteKit } from "./kit.ts";

// Bing as Safari shows it: a site: query gets unrelated pages, any other
// query the pages below, from the site asked for and from elsewhere.
function bing() {
  const asked: string[] = [];
  const send: Invoke = async (tool, args) => {
    if (tool !== "search_page") throw new Error(`no ${tool} here`);
    const url = new URL(String(args.url));
    const q = url.searchParams.get("q") ?? "";
    asked.push(q);
    const results = q.includes("site:")
      ? [{ title: "Microsoft account", url: "https://account.microsoft.com/account", snippet: "" }]
      : [
          { title: "Limits", url: "https://openrouter.ai/docs/api_reference/limits", snippet: "" },
          { title: "Pricing", url: "https://openrouter.ai/pricing", snippet: "" },
          { title: "OpenRouter 429 fixes", url: "https://markaicode.com/errors/openrouter", snippet: "" },
        ];
    return { url: url.href, captcha: false, results };
  };
  return { asked, search: bingSearch(new SiteKit(send)) };
}

test("a site: search asks Bing for the host as words and keeps only that site's pages under its path", async () => {
  const { asked, search } = bing();
  expect(await search.search('site:openrouter.ai/docs "429" rate')).toEqual({
    query: 'site:openrouter.ai/docs "429" rate',
    start: 0,
    results: [{ title: "Limits", url: "https://openrouter.ai/docs/api_reference/limits", snippet: "" }],
  });
  expect(asked).toEqual(['openrouter.ai "429" rate']);
});
