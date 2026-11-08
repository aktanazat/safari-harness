import { expect, test } from "bun:test";
import type { Invoke } from "../call.ts";
import { PACE_TOOL } from "../pace.ts";
import { SiteKit } from "./kit.ts";
import { webSearch } from "./web-search.ts";

// Safari as the kit sees it: the Google tab shows Google's "unusual
// traffic" page and the Bing tab Bing's results; pace is the daemon's own
// (pace.ts) and the page store is empty. Records the host of each page load.
function safari() {
  const loaded: string[] = [];
  const tabs = new Map<number, string>();
  const send: Invoke = async (tool, args) => {
    if (tool === "pace") return PACE_TOOL.run(args);
    if (tool === "pages") return args.do === "find" ? { pages: [] } : args.do === "searched" ? null : { ok: true };
    if (tool === "open" || tool === "goto") {
      const id = tool === "open" ? tabs.size + 1 : Number(args.tab);
      tabs.set(id, String(args.url));
      loaded.push(new URL(String(args.url)).hostname);
      return { id };
    }
    if (tool === "eval") {
      const url = new URL(tabs.get(Number(args.tab)) ?? "");
      return { result: url.hostname === "www.google.com" ? { url: "https://www.google.com/sorry/index", captcha: true, results: [], next: null } : { url: url.href, captcha: false, results: [{ title: "Keel Infrastructure", url: "https://example.com/keel", snippet: "Bitfarms is now Keel Infrastructure." }] } };
    }
    throw new Error(`no ${tool} here`);
  };
  return { loaded, kit: new SiteKit(send) };
}

// The owner's order of 11-08: no solving Google's check; make it rare and
// fall back. A search that meets it is answered by Bing, and while Google
// rests no search asks it again.
test("Google's human check sends the search to Bing and says so; later searches skip Google while it rests", async () => {
  const { loaded, kit } = safari();
  const search = webSearch(kit);
  expect(await search.search("Bitfarms renamed Keel Infrastructure")).toMatchObject({
    engine: "bing",
    results: [{ url: "https://example.com/keel" }],
    notes: [expect.stringMatching(/^Google asked for its human check, so Bing answered; searches use Bing until /)],
  });
  expect(await search.search("Keel Infrastructure ticker")).toMatchObject({
    engine: "bing",
    notes: [expect.stringMatching(/^Google is resting after its human check until /)],
  });
  expect(loaded).toEqual(["www.google.com", "www.bing.com", "www.bing.com"]);
});
