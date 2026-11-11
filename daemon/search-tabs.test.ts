import { afterAll, expect, setSystemTime, test } from "bun:test";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { watched } from "./mission.ts";
import { runAs, watchOwner } from "./owner.ts";
import { bingSearch, COLLECT as BING } from "./sites/bing-search.ts";
import { COLLECT as GOOGLE, googleSearch } from "./sites/google-search.ts";
import { SiteKit } from "./sites/kit.ts";
import { callTool, endTurn } from "./tools.ts";

type Tab = { id: number; url: string; windowId: number };
const USER_WINDOW = 1_000_001;
// Each engine's read of its results page (search-tabs.ts).
const READS: Record<string, string> = { "www.google.com": GOOGLE, "www.bing.com": BING };
// The results a results page for q shows.
const results = (q: string) => Array.from({ length: 10 }, (_, i) => ({ title: `${q} ${i}`, url: `https://example.com/keel/${i}`, snippet: "Bitfarms is now Keel Infrastructure." }));
const atGoogle = (tabs: Map<number, Tab>) => [...tabs.values()].filter((t) => t.url.startsWith("https://www.google.com/"));

// A Safari that started again with the tabs in open, by default the
// user's one; the tabs and windows the harness opens are numbered from
// first. A results page read with its engine's read shows the results for
// its query, with another nothing. Safari refuses to close a Google one
// for idleness, as on 11-11: the extension cannot read one of its frames
// for unsent forms; and a page of his.example, where the user has typed
// text he has not sent. listed adds to what Safari lists of a tab
// (shown: it shows the tab in front; partial: it did not say in time
// which tab it shows), and Safari keeps such a tab at a close for
// idleness, as the user's. The page of a tab in hung answers nothing, as
// one a dialog holds. An op in lose goes unanswered once, as the
// extension's link drops and comes back.
function safari(first: number, ...open: Tab[]) {
  const tabs = new Map<number, Tab>((open.length > 0 ? open : [{ id: 1, url: "https://his.example/", windowId: USER_WINDOW }]).map((t) => [t.id, t]));
  const opened: string[] = [];
  const lose = new Set<string>();
  const listed = new Map<number, object>();
  const hung = new Set<number>();
  let next = first;
  const gone = (id: unknown) => new Error(`that tab is gone: Safari has had no tab ${String(id)}`);
  const ops: Record<string, (args: unknown[]) => unknown> = {
    "tabs.list": () => [...tabs.values()].map((t) => ({ ...t, ...listed.get(t.id) })),
    "tabs.open": ([url, , windowId]) => {
      const t = { id: next++, url: String(url), windowId: Number(windowId) };
      tabs.set(t.id, t);
      return t;
    },
    "windows.open": ([url]) => {
      const t = { id: next++, url: String(url), windowId: next++ };
      tabs.set(t.id, t);
      return { windowId: t.windowId, tabId: t.id };
    },
    "windows.resolve": ([id]) => ([...tabs.values()].some((t) => t.windowId === id) ? id : null),
    "tabs.navigate": ([id, url]) => {
      const t = tabs.get(Number(id));
      if (!t) throw gone(id);
      t.url = String(url);
      return t;
    },
    "tabs.close": ([id, only]) => {
      const t = tabs.get(Number(id));
      if (!t) throw gone(id);
      if (only === "idle" && listed.has(t.id)) return { ok: false, front: true };
      if (only === "idle" && t.url.startsWith("https://www.google.com/")) return { ok: false, protected: "unreadable" };
      if (only === "idle" && t.url.startsWith("https://his.example/")) return { ok: false, protected: "form" };
      tabs.delete(t.id);
      return { ok: true };
    },
    dialogs: () => ({ ok: true }),
    probe: () => [],
    relay: ([id, op, args]) => {
      const t = tabs.get(Number(id));
      if (!t) throw gone(id);
      if (hung.has(t.id)) throw new Error(`the page at ${t.url} did not answer in 10 s (a dialog open on it, or a page stuck loading, holds it); reload it with goto and retry`);
      if (op !== "eval") return { url: t.url, title: "" };
      const page = new URL(t.url);
      const read = READS[page.hostname];
      const q = read !== undefined && Array.isArray(args) && String(args[0]).includes(read) ? page.searchParams.get("q") : null;
      return { ok: true, result: { url: t.url, captcha: false, results: q === null ? [] : results(q), next: null } };
    },
  };
  const socket = (): ExtSocket => ({
    send(data) {
      const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
      if (id === undefined) return;
      if (op === "tabs.open" || op === "windows.open") opened.push(op);
      if (lose.delete(op)) {
        queueMicrotask(() => {
          setSystemTime(new Date(Date.now() + 1000));
          connect(socket());
        });
        return;
      }
      const run = ops[op];
      let answer: object;
      try {
        answer = run ? { value: run(args) } : { error: `this fake has no ${op}` };
      } catch (e) {
        answer = { error: e instanceof Error ? e.message : String(e) };
      }
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...answer })));
    },
    close() {},
  });
  connect(socket());
  return { tabs, opened, lose, listed, hung };
}

// An agent process, to call as.
const agent = Bun.spawn(["sleep", "60"]);
afterAll(async () => {
  agent.kill();
  await agent.exited;
  const { promise, resolve } = Promise.withResolvers<void>();
  watchOwner(agent.pid, resolve);
  await promise;
});

// A site kit as an agent's task calls it, each call the way /rpc in
// main.ts makes it.
function kit(task = JSON.stringify(["session", "agent"])) {
  return new SiteKit((tool, args) => watched(agent.pid, tool, args, () => runAs(agent.pid, () => callTool(tool, args, false, true), task)));
}

function google(task?: string) {
  const search = googleSearch(kit(task));
  return (query: string) => search.search(query, { paced: false });
}

// Each test runs hours after the last on a still clock, so each Safari
// connects at a time of its own (reconnectedSince in tools.ts).
let hours = 0;
async function later(run: () => Promise<void>) {
  setSystemTime(new Date(Date.now() + ++hours * 3_600_000));
  try {
    await run();
  } finally {
    setSystemTime();
  }
}

// On 11-02..08, 93 searches were refused as repeats of a page load whose
// answer was lost (browser-research.md).
test("a search asked again after its page loads lost their answers is answered, not refused as a repeat", () => later(async () => {
  const s = safari(2000);
  const search = google();
  await search("Bitfarms renamed Keel Infrastructure");
  s.lose.add("tabs.navigate");
  s.lose.add("tabs.open");
  await search("Keel Infrastructure ticker").catch(() => undefined);
  expect(await search("Keel Infrastructure ticker")).toMatchObject({ results: results("Keel Infrastructure ticker") });
}));

// On 11-02..08, 58 searches failed as the extension restarted mid-search.
test("a search whose page load lost its answer is answered from a new tab", () => later(async () => {
  const s = safari(3000);
  const search = google();
  await search("Bitfarms renamed Keel Infrastructure");
  s.lose.add("tabs.navigate");
  expect(await search("Keel Infrastructure ticker")).toMatchObject({ results: results("Keel Infrastructure ticker") });
}));

// From the 11-09 deploy to 11-11, 111 of 186 results pages loaded in a new
// tab: each agent task opened its own, and its turn end closed it.
test("searches from different agent tasks, across their turn ends, load in one Google tab", () => later(async () => {
  const s = safari(4000);
  for (const name of ["a", "b", "c"]) {
    const task = JSON.stringify(["session", name]);
    await google(task)(`Keel Infrastructure ${name}`);
    await endTurn(agent.pid, undefined, task);
  }
  expect(s.opened).toEqual(["windows.open", "tabs.open"]);
}));

// One loaded while another's page is read would answer that one with its
// results.
test("searches of one engine asked at once each get their own query's results", () => later(async () => {
  safari(5000);
  await google()("Bitfarms renamed Keel Infrastructure");
  const [a, b] = await Promise.all([google(JSON.stringify(["session", "a"]))("Keel Infrastructure ticker"), google(JSON.stringify(["session", "b"]))("Keel Infrastructure miners")]);
  expect([a.results, b.results]).toEqual([results("Keel Infrastructure ticker"), results("Keel Infrastructure miners")]);
}));

test("a Bing search reads Bing's results page", () => later(async () => {
  safari(6000);
  expect(await bingSearch(kit()).search("Keel Infrastructure")).toMatchObject({ results: results("Keel Infrastructure") });
}));

test("after Safari starts again, no search loads in or closes the user's tab that has its old tab's id and page", () => later(async () => {
  const before = safari(7000);
  await google()("Bitfarms renamed Keel Infrastructure");
  const [old] = atGoogle(before.tabs);
  setSystemTime(new Date(Date.now() + 60_000));
  const his = { ...old, windowId: USER_WINDOW };
  const after = safari(8000, { ...his });
  await google()("Keel Infrastructure ticker");
  setSystemTime(new Date(Date.now() + 21 * 60_000));
  await endTurn(agent.pid);
  expect(after.tabs.get(his.id)).toEqual(his);
}));

// Safari restores its windows under new ids as it starts again, the
// harness's web search window with its Google tab among them.
test("a search tab Safari restores as it starts again closes once unused for 20 minutes", () => later(async () => {
  const before = safari(9000);
  await google()("Bitfarms renamed Keel Infrastructure");
  setSystemTime(new Date(Date.now() + 60_000));
  const after = safari(10_000, ...[...before.tabs.values()].map((t) => ({ ...t, id: t.id + 500, windowId: t.windowId + 500 })));
  await google()("Keel Infrastructure ticker");
  setSystemTime(new Date(Date.now() + 21 * 60_000));
  await endTurn(agent.pid);
  expect(atGoogle(after.tabs)).toEqual([]);
}));

test("a Google tab no search used for 20 minutes closes, though Safari refuses its page a close for idleness", () => later(async () => {
  const s = safari(11_000);
  await google()("Bitfarms renamed Keel Infrastructure");
  setSystemTime(new Date(Date.now() + 21 * 60_000));
  await endTurn(agent.pid);
  expect(atGoogle(s.tabs)).toEqual([]);
}));

// The human check's message sends the user to this tab (google-search.ts).
// A list too slow to say which tab Safari shows counts it as the user's,
// as the extension does (inFront in background.js).
test.each([
  ["shows it in front", { active: true, shown: true }],
  ["does not say in time what it shows in front", { partial: "windows.getLastFocused" }],
])("a Google tab no search used for 20 minutes stays open while Safari %s", (_, listing) => later(async () => {
  const s = safari(12_000);
  await google()("Bitfarms renamed Keel Infrastructure");
  const held = atGoogle(s.tabs);
  for (const t of held) s.listed.set(t.id, listing);
  setSystemTime(new Date(Date.now() + 21 * 60_000));
  await endTurn(agent.pid);
  expect(atGoogle(s.tabs)).toEqual(held);
}));

test("a Google tab whose page stops answering a search stays open while Safari shows it in front", () => later(async () => {
  const s = safari(13_000);
  await google()("Bitfarms renamed Keel Infrastructure");
  const [held] = atGoogle(s.tabs);
  s.listed.set(held.id, { active: true, shown: true });
  s.hung.add(held.id);
  expect(await google()("Keel Infrastructure ticker")).toMatchObject({ results: results("Keel Infrastructure ticker") });
  expect(s.tabs.get(held.id)).toBe(held);
}));

test("a search tab the user took to a site where he typed stays open past 20 minutes unused", () => later(async () => {
  const s = safari(14_000);
  await google()("Bitfarms renamed Keel Infrastructure");
  const [held] = atGoogle(s.tabs);
  held.url = "https://his.example/apply";
  setSystemTime(new Date(Date.now() + 21 * 60_000));
  await endTurn(agent.pid);
  expect(s.tabs.get(held.id)).toBe(held);
}));
