import { expect, setSystemTime, test } from "bun:test";
import type { Invoke } from "../call.ts";
import { PACE_TOOL } from "../pace.ts";
import { searchKey } from "../page-store.ts";
import { SiteKit } from "./kit.ts";
import { webSearch } from "./web-search.ts";

const TEN = Array.from({ length: 10 }, (_, i) => ({ title: `Keel ${i}`, url: `https://example.com/keel/${i}`, snippet: "Bitfarms is now Keel Infrastructure." }));

// Safari as the kit sees it: Google answers with its "unusual traffic"
// page while google.blocked is set, else ten results; Bing answers with
// one. pace is the daemon's own (pace.ts) and pages the given store, by
// default one that keeps the searches it is given. Records the host of
// each page load.
function safari(pages?: (args: Record<string, unknown>) => unknown) {
  const loaded: string[] = [];
  const google = { blocked: true };
  const tabs = new Map<number, string>();
  const saved = new Map<string, { engine: string; results: unknown[]; at: number }>();
  const store = pages ?? ((args: Record<string, unknown>) => {
    if (args.do === "find") return { pages: [] };
    if (args.do === "searched") return saved.get(searchKey(String(args.query))) ?? null;
    if (args.do === "save_search") saved.set(searchKey(String(args.query)), { engine: String(args.engine), results: args.results as unknown[], at: Date.now() });
    return { ok: true };
  });
  const land = (raw: string) => {
    const url = new URL(raw);
    loaded.push(url.hostname);
    return url.hostname === "www.google.com" && google.blocked ? `https://www.google.com/sorry/index?continue=${encodeURIComponent(raw)}` : raw;
  };
  const send: Invoke = async (tool, args) => {
    if (tool === "pace") return PACE_TOOL.run(args);
    if (tool === "pages") return store(args);
    if (tool === "open" || tool === "goto") {
      const id = tool === "open" ? tabs.size + 1 : Number(args.tab);
      tabs.set(id, land(String(args.url)));
      return { id };
    }
    if (tool === "eval") {
      const url = new URL(tabs.get(Number(args.tab)) ?? "");
      if (url.hostname === "www.bing.com") return { result: { url: url.href, captcha: false, results: [{ title: "Keel Infrastructure", url: "https://example.com/keel", snippet: "Bitfarms is now Keel Infrastructure." }] } };
      const sorry = url.pathname.startsWith("/sorry");
      return { result: { url: url.href, captcha: sorry, results: sorry ? [] : TEN, next: null } };
    }
    throw new Error(`no ${tool} here`);
  };
  return { loaded, google, kit: new SiteKit(send) };
}

// Each test runs hours after the last on the clock pace.ts reads, so no
// Google turn or rest of one carries into the next.
let hours = 0;
async function later(run: () => Promise<void>) {
  setSystemTime(new Date(Date.now() + ++hours * 3_600_000));
  try {
    await run();
  } finally {
    setSystemTime();
  }
}

// The owner's order of 11-08: no solving Google's check; make it rare and
// fall back. A search that meets it is answered by Bing, and while Google
// rests no search asks it again.
test("Google's human check sends the search to Bing and says so; later searches skip Google while it rests", () => later(async () => {
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
}));

// The omp override keeps one kit per agent task across searches, so its
// Google tab still shows the check an earlier search met.
test("after the rest, a kit whose Google tab still shows an earlier check asks Google again", () => later(async () => {
  const { loaded, google, kit } = safari();
  await webSearch(kit).search("Bitfarms renamed Keel Infrastructure");
  google.blocked = false;
  setSystemTime(new Date(Date.now() + 11 * 60_000));
  expect(await webSearch(kit).search("Keel Infrastructure ticker")).toMatchObject({ engine: "google", notes: [] });
  expect(loaded).toEqual(["www.google.com", "www.bing.com", "www.google.com"]);
}));

test("a repeat search gets the whole page the first one fetched, whatever its limit", () => later(async () => {
  const { google, kit } = safari();
  google.blocked = false;
  expect((await webSearch(kit).search("Keel Infrastructure", { limit: 3 })).results).toHaveLength(3);
  expect(await webSearch(kit).search("Keel Infrastructure", { limit: 10 })).toMatchObject({ engine: "stored", results: TEN });
}));

test("a failing page store leaves the search to the engines", () => later(async () => {
  const { google, kit } = safari(() => {
    throw new Error("database disk image is malformed");
  });
  google.blocked = false;
  expect(await webSearch(kit).search("Keel Infrastructure")).toMatchObject({ engine: "google", results: TEN, read: [] });
}));
