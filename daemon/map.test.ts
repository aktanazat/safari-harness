import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect, historyFixture } from "./fake-safari.ts";
import { callTool, formatResult } from "./tools.ts";
import { followPages, mapPages, type Listing, type Page } from "./map.ts";
import { runAs } from "./owner.ts";
import { WAIT_NEEDS } from "./receipt.ts";

// Pages that fail in each way a page can: its tab goes away mid-read, it
// answers with an error, a bot check stands in for it, it never shows what
// a wait asks for (a page that is not there), it gives a wait no answer (a
// Safari too loaded to). CLEARING's check lets the browser through on the
// tab's fourth probe.
const GONE = "https://gone.example/";
const EMPTY = "https://empty.example/";
const WALLED = "https://walled.example/";
const LOST = "https://lost.example/";
const SILENT = "https://silent.example/";
const CLEARING = "https://clearing.example/";
// eBay's error page, as its guide names it (docs/sites/ebay.md); FLAKY's
// goes when it loads again, as eBay's searches' did in the October hunts
// (AkylHunts AH4).
const ERRORED = "https://ebay.com/sch/i.html?_nkw=lamp";
const FLAKY = "https://ebay.com/sch/i.html?_nkw=desk";
// A page not found that answers a load with HTTP 200 and a fetch with 404,
// as moved pages did on 10-23 (K4).
const MISSING = "https://missing.example/";
// Words no page shows, for a wait.
const ABSENT = "Sold out";
// Google's results pages (K12); CAPTCHA's goes to Google's reCAPTCHA page.
const SEARCH = "https://www.google.com/search?q=";
const CAPTCHA = `${SEARCH}captcha`;

// Pages whose read takes 31.5 s, as each of six Yelp pages' eval did on
// 09-30 (01a0f031).
const SLOW = "https://slow.example/";
const SLOW_MS = 31_500;

// A listing (a search's results) and its links in its order, as eval reads
// them: two items, a help page, an item on another site, one on www, and
// the first two again, one with a #fragment.
const LISTING = "https://shop.example/search?q=lamp";
const LISTED = ["https://shop.example/item/1", "https://shop.example/help", "https://shop.example/item/2#reviews", "https://other.example/item/4", "https://www.shop.example/item/3", "https://shop.example/item/2", "https://shop.example/item/1"];
// A listing over three pages of three items, each page linking the next,
// as eval reads them.
const PAGED = "https://shop.example/c?page=";
// An address Safari saves as a file (a CSV), and one whose load never
// begins in a tab that shows a page.
const FILE = "https://files.example/prices.csv";
const PRICES = "item,price\nlamp,40\n";
const UNLOADED = "https://unloaded.example/";

// A stand-in extension. Each open makes a tab in the window it names; the
// first open's window is made with its own page (tab 900). Reads answer at
// once, a SLOW page's after SLOW_MS, or, while holding, when the test lets
// them. A wait is answered at once, found on every page but LOST, and for
// ABSENT on none, except SILENT's, held. Waits and reads are noted in
// order, and each load (an open, a goto) with its time. FILE shows no
// page: an open of it leaves its tab blank and a goto keeps the tab's page,
// each answering that it is a file. A goto of UNLOADED answers the page
// its tab had.
const tabs = new Map<number, { id: number; windowId: unknown; url: string; title: string }>();
const opened: number[] = [];
const closed: number[] = [];
const readUrls: string[] = [];
const asked: string[] = [];
const held: (() => void)[] = [];
// SILENT's waits, answered when the test lets them
const unanswered: (() => void)[] = [];
let holding = false;
let stuck: string | undefined;
let nextTab = 0;
const probes = new Map<number, number>();
const loaded: [string, number][] = [];

const evaluate = historyFixture();
function read(tab: number, op: string): { value?: unknown; error?: string } {
  const url = tabs.get(tab)?.url ?? "";
  readUrls.push(url);
  asked.push(`read ${url}`);
  if (url === GONE) return { error: "no tab" };
  if (url === EMPTY) return { value: { error: "no content root" } };
  if (url === LISTING) return { value: { ok: true, result: { links: LISTED, next: null } } };
  if (url.startsWith(PAGED)) {
    const n = Number(url.slice(PAGED.length));
    return { value: { ok: true, result: { links: [1, 2, 3].map((k) => `https://shop.example/p/${3 * n - 3 + k}`), next: n < 3 ? `${PAGED}${n + 1}` : null } } };
  }
  if (op === "eval") return { value: { ok: true, result: { cards: 2 } } };
  if (op === "fetch") return { value: { status: url === MISSING ? 404 : 200, url, type: "text/html", text: `body of ${url}`, truncated: false } };
  if (url === MISSING) return { value: { url, title: "Page Not Found", text: "Page Not Found\nThe page you asked for has moved.", truncated: false } };
  return { value: { url, title: "Page", text: `text of ${url}`, truncated: false } };
}

// A load of url, noted; the title it shows: FLAKY's first is its error page.
function load(url: string): string {
  const first = !loaded.some(([u]) => u === url);
  loaded.push([url, performance.now()]);
  return url === LOST || url === MISSING ? "Page Not Found" : url === ERRORED || (url === FLAKY && first) ? "Error Page | eBay" : "Page";
}

function answer(op: string, args: unknown[]): { value?: unknown; error?: string } {
  if (op === "windows.open") {
    tabs.set(900, { id: 900, windowId: 1, url: String(args[0]), title: load(String(args[0])) });
    return { value: { windowId: 1, tabId: 900 } };
  }
  if (op === "tabs.list") return { value: [...tabs.values()] };
  if (op === "tabs.open") {
    const url = String(args[0]);
    const title = load(url);
    const tab = url === FILE ? { id: ++nextTab, windowId: args[2], url: "", title: "" } : { id: ++nextTab, windowId: args[2], url, title };
    tabs.set(tab.id, tab);
    opened.push(tab.id);
    return { value: url === FILE ? { ...tab, url, file: "download" } : tab };
  }
  if (op === "tabs.navigate") {
    const tab = tabs.get(Number(args[0]));
    const url = String(args[1]);
    if (!tab) return { error: "no tab" };
    if (url === UNLOADED) return { value: tab };
    const title = load(url);
    if (url === FILE) return { value: { ...tab, url, file: "download" } };
    Object.assign(tab, { url, title });
    return { value: tab };
  }
  if (op === "fetchFile") return { value: { name: "", type: "text/csv", size: PRICES.length, disposition: "attachment; filename=prices.csv", url: String(args[0]), status: 200, data: Buffer.from(PRICES).toString("base64") } };
  if (op === "tabs.close") {
    const tab = Number(args[0]);
    if (tabs.get(tab)?.url === stuck) return { error: "a sheet on the tab kept Safari from closing it" };
    tabs.delete(tab);
    closed.push(tab);
    return { value: { ok: true } };
  }
  if (op === "probe") {
    const tab = Number(args[0]);
    const url = tabs.get(tab)?.url;
    const seen = (probes.get(tab) ?? 0) + 1;
    probes.set(tab, seen);
    const walled = url === WALLED || (url === CLEARING && seen <= 3);
    if (url === CAPTCHA) return { value: [{ frame: 0, url: "https://www.google.com/sorry/index", title: "", text: "", markers: [], answered: [], frames: [] }] };
    return { value: walled ? [{ frame: 0, url, title: "Just a moment...", text: "", markers: [], answered: [], frames: [] }] : url === CLEARING ? [{ frame: 0, url, title: "Page", text: "", markers: [], answered: [], frames: [] }] : [] };
  }
  return { value: { ok: true } };
}

connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const reply = (r: { value?: unknown; error?: string }) => bridge.handleMessage(JSON.stringify({ id, ...r }));
    if (op !== "relay") return reply(answer(op, args));
    if (Number(args[0]) === 900 && args[1] === "eval") {
      const result = evaluate(900, (args[2] as string[])[0]);
      return reply({ value: { ok: true, result } });
    }
    if (args[1] === "wait") {
      const url = tabs.get(Number(args[0]))?.url ?? "";
      const [selector, want] = args[2] as [string | null, { text?: string }];
      asked.push(`wait ${url} for ${want.text ?? selector}`);
      if (url === SILENT) return void unanswered.push(() => reply({ value: { found: true } }));
      return reply({ value: { found: url !== LOST && want.text !== ABSENT } });
    }
    if (args[1] === "waitStop") return reply({ value: { ok: true } });
    if (holding) held.push(() => reply(read(Number(args[0]), String(args[1]))));
    else if (tabs.get(Number(args[0]))?.url.startsWith(SLOW)) setTimeout(() => reply(read(Number(args[0]), String(args[1]))), SLOW_MS);
    else reply(read(Number(args[0]), String(args[1])));
  },
  close() {},
});

// the answers settle in microtasks, which all run before the next turn
const settled = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  jest.useRealTimers();
});

// A map on the fake clock, which moves on 500 ms at a time once the pages
// have answered all they were asked: open waits on a bot check (challenge.ts).
async function waited<T>(run: Promise<T>): Promise<T> {
  let done = false;
  const end = () => {
    done = true;
  };
  void run.then(end, end);
  while (!done) {
    await settled();
    jest.advanceTimersByTime(500);
  }
  return run;
}

// map as its tool runs it: each page's open, read, and close go through callTool
const map = async (args: Record<string, unknown>) => (await mapPages(args, callTool)).pages;
const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://shop.example/item/${i}`);
const savedPath = (p: Page) => (p.value && typeof p.value === "object" && "saved" in p.value && typeof p.value.saved === "string" ? p.value.saved : "");

// Lets the held reads answer a batch at a time until the map is done, and
// returns how many reads were in flight at each batch.
async function batches(args: Record<string, unknown>): Promise<number[]> {
  holding = true;
  const sizes: number[] = [];
  let done = false;
  const run = map(args).finally(() => (done = true));
  try {
    while (!done) {
      await settled();
      if (held.length > 0) sizes.push(held.length);
      for (const release of held.splice(0)) release();
    }
    await run;
    return sizes;
  } finally {
    holding = false;
  }
}

test("map reads as many pages at once as asked, six when not asked", async () => {
  expect(await batches({ urls: urls(10) })).toEqual([6, 4]);
  expect(await batches({ urls: urls(5), concurrency: 2 })).toEqual([2, 2, 1]);
});

// Each page at once is a tab in the user's Safari and a page's load on his
// machine; asking for more does not get more.
test("map never reads more than six pages at once", async () => {
  expect(await batches({ urls: urls(10), concurrency: 9 })).toEqual([6, 4]);
});

test("a page that fails is reported in its place, and the others are still read", async () => {
  const pages = await map({ urls: ["https://shop.example/a", GONE, EMPTY, "https://shop.example/b"] });
  expect(pages.map((p) => [p.url, p.ok])).toEqual([["https://shop.example/a", true], [GONE, false], [EMPTY, false], ["https://shop.example/b", true]]);
  expect(pages[3]).toMatchObject({ value: { text: "text of https://shop.example/b" } });
  expect(pages[1]).toMatchObject({ error: "no tab" });
  expect(pages[2]).toMatchObject({ error: "no content root" });
});

// On 10-13 two maps took 30 s each and answered every page "extension
// request tabs.list timed out after 30000ms", without isError, as a map
// that had worked.
test("a map whose every page the extension left unanswered fails as a whole, extension stuck; one page failing on its own still answers the pages", async () => {
  const silent = (tool: string) => (tool === "open" ? Promise.reject(new Error("extension request tabs.list timed out after 5000ms")) : Promise.resolve({ ok: true }));
  const stuck = (tool: string, args: Record<string, unknown>) => (args.url === urls(3)[2] ? Promise.reject(new Error("extension stuck: the Safari extension has answered none of the last 2 tabs.list requests (for 10 s); try again in a minute")) : silent(tool));
  await expect(mapPages({ urls: urls(3) }, stuck)).rejects.toThrow(/^extension stuck: .* none of map's 3 pages \(its tabs\.list requests went unanswered\); map again in a minute/);
  const oneOwn = (tool: string, args: Record<string, unknown>) => (args.url === urls(3)[0] ? Promise.reject(new Error(`Safari could not open ${urls(3)[0]}: the site did not answer`)) : silent(tool));
  expect((await mapPages({ urls: urls(3) }, oneOwn)).pages.map((p) => p.ok)).toEqual([false, false, false]);
});

test("a disconnected batch resumes only unread safe pages and never replays an uncertain action", async () => {
  jest.useFakeTimers();
  const addresses = urls(3);
  const attempts = new Map<string, number>();
  const read: string[] = [];
  const lost = "the Safari extension disconnected before it answered (Safari quit, or the extension reloaded); try again";
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "open") {
      const url = String(args.url);
      const count = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, count);
      if (url === addresses[2] && count === 1) throw new Error(lost);
      return { id: addresses.indexOf(url) + 1, url };
    }
    if (tool === "extract") {
      read.push(addresses[Number(args.tab) - 1]);
      return { text: "read" };
    }
    return { ok: true };
  };
  const safe = await waited(mapPages({ urls: addresses, what: "extract", fresh: true }, call));
  expect(safe.pages.map((page) => [page.url, page.ok])).toEqual(addresses.map((url) => [url, true]));
  expect(read.sort()).toEqual(addresses.slice().sort());
  expect(addresses.map((url) => attempts.get(url))).toEqual([1, 1, 2]);
  expect(safe.urls).toBeUndefined();

  let actions = 0;
  const unsafe = await mapPages({ urls: [addresses[0]], what: "eval", expression: "document.querySelector('button').click()", fresh: true },
    async (tool) => {
      if (tool === "open") return { id: 1, url: addresses[0] };
      if (tool === "eval") { actions++; throw new Error(lost); }
      return { ok: true };
    });
  expect(actions).toBe(1);
  expect(unsafe.pages[0]).toMatchObject({ ok: false, failure: { effect: "possibly_effected" } });
  expect(unsafe.urls).toBeUndefined();
});

test("map keeps a safe read pending through a reconnect, but never retries a first not-connected answer", async () => {
  jest.useFakeTimers();
  const url = urls(1)[0];
  const disconnected = "the Safari extension disconnected before it answered (Safari quit, or the extension reloaded); try again";
  const notConnected = "Safari extension not connected — enable the Safari Harness extension (Safari ▸ Settings ▸ Extensions; turning it on asks for the Mac's password or Touch ID)";
  let opens = 0;
  const recovered = await waited(mapPages({ urls: [url], what: "extract", fresh: true }, async (tool) => {
    if (tool === "open") {
      opens++;
      if (opens < 3) throw new Error(opens === 1 ? disconnected : notConnected);
      return { id: 1, url };
    }
    if (tool === "extract") return { text: "reconnected" };
    return { ok: true };
  }));
  expect(recovered.pages).toMatchObject([{ ok: true, value: { text: "reconnected" } }]);
  expect(opens).toBe(3);
  expect(recovered.urls).toBeUndefined();

  let initialOpens = 0;
  const unavailable = await mapPages({ urls: [url], what: "extract", fresh: true }, async (tool) => {
    if (tool === "open") { initialOpens++; throw new Error(notConnected); }
    return { ok: true };
  });
  expect(unavailable.pages[0]).toMatchObject({ ok: false, error: notConnected });
  expect(initialOpens).toBe(1);
});

// On 10-29 os.html, the longest of 20 python docs pages map read four at a
// time, did not answer in 10 s (baseline).
test("a page that answers nothing in time is read once more after the others, and one that stalls again is given back to map again", async () => {
  const [a, b, c] = urls(3);
  const stall = (url: string) => `the page at ${url} did not answer in 10 s (a dialog open on it, or a page stuck loading, holds it); reload it with goto and retry`;
  const shown = new Map<number, string>();
  const reads: string[] = [];
  let next = 0;
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "open" || tool === "goto") {
      const id = tool === "open" ? ++next : Number(args.tab);
      shown.set(id, String(args.url));
      return { id, url: args.url };
    }
    if (tool === "extract") {
      const url = shown.get(Number(args.tab)) ?? "";
      reads.push(url);
      if (url === c || (url === a && reads.length === 1)) throw new Error(stall(url));
      return { url, text: `text of ${url}` };
    }
    return { ok: true };
  };
  const answer = await mapPages({ urls: [a, b, c], concurrency: 1 }, call);
  expect(reads).toEqual([a, b, c, a, c]);
  expect(answer.pages).toMatchObject([{ url: a, ok: true }, { url: b, ok: true }, { url: c, ok: false, error: `the page at ${c} did not answer in 10 s (a dialog open on it, or a page stuck loading, holds it); map it again` }]);
  expect(answer.urls).toEqual([c]);
});

// Of the 61 map pages answered "not closed" in the 10-29 audit, 48 had met
// a dropped link.
test("a close a dropped link left unanswered is asked again, and its page is not said to be left open", async () => {
  const lost = "the Safari extension disconnected before it answered (Safari quit, or the extension reloaded); try again";
  const closes: number[] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "open") return { id: 1, url: args.url };
    if (tool === "extract") return { text: "read" };
    if (tool === "close") {
      closes.push(Number(args.tab));
      if (closes.length === 1) throw new Error(lost);
    }
    return { ok: true };
  };
  const { pages } = await mapPages({ urls: urls(1) }, call);
  expect(closes).toEqual([1, 1]);
  expect(pages[0]).not.toHaveProperty("closeError");
});

// On 10-23 a map of two leaflet PDFs waited 36 s on each to read nothing
// (SR-7).
test("a PDF page is read whether Safari saves it, which open reads, or shows it in its viewer, which pdf reads", async () => {
  const downloaded = "https://shop.example/leaflet?download=true";
  const shown = "https://shop.example/leaflet.pdf";
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "open") return args.url === downloaded ? { url: args.url, file: "pdf", text: `text of ${args.url}`, note: "the address is a file, read here; the blank tab it opened closed" } : { id: 2, url: args.url };
    if (tool === "extract") throw new Error(`this is a PDF in Safari's viewer, which page reads do not reach: read its text with pdf {do: "read", url: "${shown}"}`);
    if (tool === "pdf") return { url: args.url, text: `text of ${args.url}` };
    return { ok: true };
  };
  const { pages } = await mapPages({ urls: [downloaded, shown] }, call);
  expect(pages).toMatchObject([{ url: downloaded, ok: true, value: { text: `text of ${downloaded}` } }, { url: shown, ok: true, value: { text: `text of ${shown}` } }]);
});

// In the logs through 10-29 agents met the blank tab of an address Safari
// saves as a file 56 times in 41 sessions, each a call more (friction).
test("an address Safari saves as a file is read in the call that loads it, by open, goto, or map, and leaves no blank tab", async () => {
  const before = opened.length;
  const read = await callTool("open", { url: FILE, background: true }, false);
  expect(read).toMatchObject({ url: FILE, type: "text/csv", text: PRICES, file: "download" });
  expect(read).not.toHaveProperty("id");
  const pages = await map({ urls: ["https://shop.example/a", FILE], concurrency: 1 });
  expect(pages[1]).toMatchObject({ url: FILE, ok: true, value: { text: PRICES } });
  const mine = opened.slice(before);
  expect(mine).toHaveLength(2);
  expect(mine.filter((t) => !closed.includes(t))).toEqual([]);
});

// An eval or fetch read carries no title, and an address may have led to a
// page not found.
test("each page carries the title its tab opened with", async () => {
  const pages = await map({ urls: ["https://shop.example/a", LOST], what: "eval", expression: "document.title" });
  expect(pages.map((p) => [p.url, p.title])).toEqual([["https://shop.example/a", "Page"], [LOST, "Page Not Found"]]);
});

// 10-16: a hunt's eBay searches answered "Error Page | eBay", which an
// agent read as no listings (HuntsUsage); in the October hunts the same
// searches loaded when opened again, and two agents wrote loops of their
// own to ask again (AkylHunts AH4).
test("a page that opens as its site's error page is loaded again 2 s and then 5 s later: read once it loads, failed with open's warning if it never does", async () => {
  jest.useFakeTimers();
  readUrls.length = 0;
  const from = loaded.length;
  const [flaky, errored, other] = await waited(map({ urls: [FLAKY, ERRORED, "https://shop.example/a"] }));
  expect(flaky).toMatchObject({ url: FLAKY, ok: true, retried: 1, value: { text: `text of ${FLAKY}` } });
  expect(errored).toMatchObject({ url: ERRORED, ok: false, retried: 2, error: expect.stringContaining("answered with its error page") });
  expect(other).not.toHaveProperty("retried");
  expect(readUrls.toSorted()).toEqual([FLAKY, "https://shop.example/a"].toSorted());
  const [first, second, third] = loaded.slice(from).filter(([url]) => url === ERRORED).map(([, at]) => at);
  expect(second - first).toBeGreaterThanOrEqual(2000);
  expect(third - second).toBeGreaterThanOrEqual(5000);
});

test("every tab map opens is closed, a failed page's and a bot check's included", async () => {
  jest.useFakeTimers();
  const before = opened.length;
  await waited(map({ urls: ["https://shop.example/a", GONE, EMPTY, WALLED] }));
  const mine = opened.slice(before);
  expect(mine.length).toBe(4);
  expect(closed.filter((t) => mine.includes(t)).sort()).toEqual(mine.sort());
  expect([...tabs.keys()]).toEqual([900]);
});

// Until 10-29 each page opened a tab of its own: a map of 20 pages opened
// 20 tabs in a Safari holding 524 (baseline).
test("map opens one tab for each page it reads at once, reads each page in a load of its own, and closes them", async () => {
  const before = opened.length;
  const from = loaded.length;
  const pages = await map({ urls: urls(20), concurrency: 4 });
  expect(pages.map((p) => p.value)).toEqual(urls(20).map((url) => expect.objectContaining({ text: `text of ${url}` })));
  expect(loaded.slice(from).map(([url]) => url).toSorted()).toEqual(urls(20).toSorted());
  const mine = opened.slice(before);
  expect(mine).toHaveLength(4);
  expect(mine.filter((t) => !closed.includes(t))).toEqual([]);
});

// A goto that answers the page its tab showed has not loaded the next one,
// which a read would then take for it.
test("a page whose load never begins in a reader's tab opens in a tab of its own, and is never read as the page before it", async () => {
  const before = opened.length;
  const pages = await map({ urls: ["https://shop.example/a", UNLOADED], concurrency: 1 });
  expect(pages[1]).toMatchObject({ url: UNLOADED, ok: true, value: { text: `text of ${UNLOADED}` } });
  expect(opened.length - before).toBe(2);
});

// Nobody watches these tabs, so a check still up once open has waited on it
// is reported with the step that often gets past it: the page opened in a
// tab, and a wait. In October 28 of 48 runs read "or leave it" as leave it.
test("a bot check is reported on its page and its page is never read", async () => {
  jest.useFakeTimers();
  readUrls.length = 0;
  const pages = await waited(map({ urls: [WALLED, "https://shop.example/a"] }));
  expect(pages[0]).toMatchObject({ url: WALLED, ok: false, challenge: { kind: "cloudflare", where: "page" } });
  expect(pages[1].ok).toBe(true);
  expect(readUrls).toEqual(["https://shop.example/a"]);
});

// egov.uscis.gov's wall let Safari through by itself (09-30).
test("a bot check that lets the browser through is waited out, and its page is read", async () => {
  jest.useFakeTimers();
  const [page] = await waited(map({ urls: [CLEARING] }));
  expect(page).toMatchObject({ url: CLEARING, ok: true, value: { text: `text of ${CLEARING}` } });
  expect(page).not.toHaveProperty("challenge");
});

test("a tab that will not close is reported on its page, and every page still answers", async () => {
  stuck = "https://shop.example/b";
  try {
    const pages = await map({ urls: ["https://shop.example/a", stuck, "https://shop.example/c"] });
    expect(pages.map((p) => p.ok)).toEqual([true, true, true]);
    expect(pages[1].closeError).toContain("kept Safari from closing it");
  } finally {
    // Let it close now, so the harness no longer counts it among its tabs
    // when a later test file reads them.
    const left = [...tabs.values()].filter((t) => t.url === stuck);
    stuck = undefined;
    for (const t of left) await callTool("close", { tab: t.id });
  }
});

// Pages of one site that finish in the same millisecond are named alike.
test("with save, each page's whole output goes to a file of its own in the folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "map-"));
  setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
  try {
    const saved = (await map({ urls: ["https://shop.example/a", "https://shop.example/b"], save: dir })).map(savedPath);
    expect(saved.every((path) => path.startsWith(`${dir}/`))).toBe(true);
    expect(saved.map((path) => readFileSync(path, "utf8"))).toEqual(["text of https://shop.example/a", "text of https://shop.example/b"]);
  } finally {
    setSystemTime();
  }
});

test("map reads up to 20 pages a call and refuses more before opening any", async () => {
  expect((await map({ urls: urls(20) })).every((p) => p.ok)).toBe(true);
  const before = opened.length;
  await expect(map({ urls: urls(21) })).rejects.toThrow("at most 20");
  expect(opened.length).toBe(before);
});

// A page its script draws after it loads reads empty at first: on 01a0e50b
// a map of a dealer's page read no phone numbers until the agent put a
// 2.5 s sleep inside its expression.
test("with wait, each page is read once it shows what wait asks for; one that never does is reported, not read", async () => {
  asked.length = 0;
  const pages = await map({ urls: ["https://shop.example/a", LOST], wait: { text: "Price" }, concurrency: 1 });
  expect(asked).toEqual(["wait https://shop.example/a for Price", "read https://shop.example/a", `wait ${LOST} for Price`]);
  expect(pages[0]).toMatchObject({ ok: true, value: { text: "text of https://shop.example/a" } });
  expect(pages[1]).toMatchObject({ ok: false, error: `it did not show what wait asked for; the tab is at ${LOST} ("Page Not Found")` });
});

// On 10-16, with Safari taking 4 to 13 s a call after a deploy, a wait for
// words a page showed all along answered that it never showed them.
test("with wait, a page that gives the wait no answer in time is not read, is not said to lack what wait asked for, and is waited on once more", async () => {
  asked.length = 0;
  const { pages, urls: left } = await mapPages({ urls: [SILENT], wait: { text: "Price", ms: 100 } }, callTool);
  for (const release of unanswered.splice(0)) release();
  expect(asked).toEqual([`wait ${SILENT} for Price`, `wait ${SILENT} for Price`]);
  expect(pages[0]).toMatchObject({ ok: false, error: expect.stringContaining("no answer in time") });
  expect(pages[0]).not.toMatchObject({ error: expect.stringContaining("did not show") });
  expect(left).toEqual([SILENT]);
});

test("map refuses a wait that asks for nothing before opening any page", async () => {
  const before = opened.length;
  await expect(map({ urls: urls(2), wait: {} })).rejects.toThrow(WAIT_NEEDS);
  await expect(map({ urls: urls(2), wait: "Price" })).rejects.toThrow("wait must be an object");
  expect(opened.length).toBe(before);
});

// A tab opened on a local file (01a0efb9) or on text that is no address
// (01a0f14c passed its JSON args as the address) stayed blank: the read
// then failed with advice to reload it, or open answered as if it worked.
test("an address Safari cannot show fails in its place before a tab opens for it", async () => {
  const before = opened.length;
  const pages = await map({ urls: ["file:///Users/me/page.html", '{"url":"https://shop.example/a"}', "https://shop.example/a"] });
  expect(pages.map((p) => p.ok)).toEqual([false, false, true]);
  expect(opened.length - before).toBe(1);
});

// omp's MCP client ends a call at 60 s: on 09-30 a map of six pages whose
// reads took 31.5 s each, three at once, lost all six there (01a0f031).
test("a map whose pages run long answers within 60 s with the pages it read, names the rest unfinished and gives their addresses to map next, and begins no more", async () => {
  jest.useFakeTimers();
  const before = opened.length;
  const from = loaded.length;
  const slow = Array.from({ length: 9 }, (_, i) => `${SLOW}${i}`);
  const began = performance.now();
  const { pages, urls: left } = await waited(mapPages({ urls: slow, concurrency: 3 }, callTool));
  expect(performance.now() - began).toBeLessThan(60_000);
  expect(pages.map((p) => [p.url, p.ok])).toEqual(slow.map((url, i) => [url, i < 3]));
  expect(pages.slice(3).map((p) => (p.ok ? "read" : p.error))).toEqual(Array(6).fill(expect.stringMatching(/unfinished.*again/)));
  expect(left).toEqual(slow.slice(3));
  // The three still being read go on in the tabs the first three were read
  // in, each closing its tab as it ends; the three not begun never load.
  for (let i = 0; i < 40; i++) {
    await settled();
    jest.advanceTimersByTime(500);
  }
  expect(loaded.slice(from)).toHaveLength(6);
  const mine = opened.slice(before);
  expect(mine.length).toBe(3);
  expect(closed.filter((t) => mine.includes(t)).sort()).toEqual(mine.sort());
});

// A page the answer names unfinished ends after it: with save, its read
// must leave no file that no answer names. Files are written on the real
// clock, so the fake one waits while pages 0-2's are; pages 3-5 then begin,
// to be read after the answer.
test("with save, a map past its time writes a file for each page it answers with, and none for the rest", async () => {
  jest.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "map-"));
  const before = opened.length;
  const from = loaded.length;
  let pages: Page[] = [];
  void map({ urls: Array.from({ length: 6 }, (_, i) => `${SLOW}${i}`), concurrency: 3, save: dir }).then((p) => {
    pages = p;
  });
  const tick = async (ms: number) => {
    for (let t = 0; t < ms; t += 500) {
      await settled();
      jest.advanceTimersByTime(500);
    }
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 10_000 && !done(); i++) await settled();
  };
  await tick(33_000);
  await until(() => loaded.length - from === 6);
  await tick(33_000);
  await until(() => opened.slice(before).every((t) => closed.includes(t)));
  // A file begun after that lands on the real clock.
  jest.useRealTimers();
  await Bun.sleep(100);
  const saved = pages.map(savedPath);
  expect(saved.map((path) => path !== "")).toEqual([true, true, true, false, false, false]);
  expect(readdirSync(dir).filter((name) => name !== "index.json").map((name) => join(dir, name)).sort()).toEqual(saved.slice(0, 3).sort());
});

// In the two weeks of logs before 10-19 an agent copied a map's addresses
// out of the answer before into its next map 165 times, 153 of them a
// listing's: a search, then its results, took two calls.
test("map with follow reads a listing and the pages it links to in one call: matching links to its own site, each once, up to max", async () => {
  readUrls.length = 0;
  const items = ["https://shop.example/item/1", "https://shop.example/item/2", "https://www.shop.example/item/3"];
  const { pages } = (await callTool("map", { urls: [LISTING], follow: { match: "/\\/item\\/\\d+$/" } }, false)) as { pages: Listing[] };
  expect(pages).toMatchObject([{ url: LISTING, ok: true, items: items.map((url) => ({ url, ok: true, value: { text: `text of ${url}` } })) }]);
  expect(pages[0]).not.toHaveProperty("unread");
  expect(readUrls.toSorted()).toEqual([LISTING, ...items].toSorted());
  expect(formatResult({ pages })).toContain(`### ${items[2]} (`);
  readUrls.length = 0;
  const capped = (await followPages({ urls: [LISTING], follow: { match: "/\\/item\\//", max: 2 } }, callTool)).pages;
  expect(capped).toMatchObject([{ ok: true, items: items.slice(0, 2).map((url) => ({ url })), unread: 1 }]);
  expect(readUrls).toHaveLength(3);
});

test("follow's selector is waited for on each listing, and a listing that never shows it fails saying so and leads to no reads", async () => {
  asked.length = 0;
  const [found, lost] = (await followPages({ urls: [LISTING, LOST], follow: { match: "a.item" }, concurrency: 1 }, callTool)).pages;
  const links = ["https://shop.example/item/1", "https://shop.example/help", "https://shop.example/item/2", "https://www.shop.example/item/3"];
  expect(asked).toEqual([`wait ${LISTING} for a.item`, `read ${LISTING}`, `wait ${LOST} for a.item`, ...links.map((url) => `read ${url}`)]);
  expect(found).toMatchObject({ ok: true, items: links.map((url) => ({ url, ok: true })) });
  expect(lost).toMatchObject({
    url: LOST,
    title: "Page Not Found",
    ms: expect.any(Number),
    ok: false,
    error: expect.stringContaining("a.item"),
    failure: { ok: false, code: "not_content", effect: "none", retryable: false, message: expect.stringContaining("a.item") },
  });
  expect(lost).not.toHaveProperty("items");
});

test("map refuses a follow it cannot use before opening a page, and a listing with no matching link fails saying so", async () => {
  const before = opened.length;
  await expect(followPages({ urls: [LISTING], follow: "a.item" }, callTool)).rejects.toThrow('follow must be {"match"');
  await expect(followPages({ urls: [LISTING], follow: { match: "/(/" } }, callTool)).rejects.toThrow("is not a regex");
  await expect(followPages({ urls: [LISTING], follow: { match: "a.item", max: 21 } }, callTool)).rejects.toThrow('"max": 1 to 20');
  expect(opened.length).toBe(before);
  const [none] = (await followPages({ urls: ["https://shop.example/a"], follow: { match: "/\\/item\\//" } }, callTool)).pages;
  expect(none).toMatchObject({ ok: false, error: "no link on it to its own site matched /\\/item\\//" });
  expect(opened.length - before).toBe(1);
});

// On 10-29 a category of 1,019 members over 6 pages read 20, and nothing
// told of its other 5 (completeness).
test("with follow, a listing's next page is read while max wants more links, and the one max leaves unread is named for the next map", async () => {
  const items = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `https://shop.example/p/${from + i}`);
  const all = await followPages({ urls: [`${PAGED}1`], follow: { match: "/\\/p\\//", max: 7 } }, callTool);
  expect(all.pages).toMatchObject([{ url: `${PAGED}1`, ok: true, items: items(1, 7).map((url) => ({ url, ok: true })), unread: 2 }]);
  expect(all.pages[0]).not.toHaveProperty("next");
  expect(all.urls).toEqual(items(8, 9));
  const first = await followPages({ urls: [`${PAGED}1`], follow: { match: "/\\/p\\//", max: 3 } }, callTool);
  expect(first.pages).toMatchObject([{ ok: true, items: items(1, 3).map((url) => ({ url })), next: `${PAGED}2` }]);
  expect(first.urls).toBeUndefined();
  expect(formatResult(first)).toContain(`map {"urls":["${PAGED}2"]} with the same follow`);
});

// On 10-23 saved maps counted three pages not found, three raw 404s, and
// an API's rate limit as read (K4).
test("a page that reads as an error page, or answers an HTTP error, fails, saved or not, with its read beside the error", async () => {
  const answer = await mapPages({ urls: [MISSING, "https://shop.example/a"] }, callTool);
  expect(answer.pages[0]).toMatchObject({ url: MISSING, ok: false, error: expect.stringContaining('an error page, "Page Not Found", not the page asked for'), value: { text: expect.stringContaining("has moved") } });
  expect(formatResult(answer)).toStartWith("2 pages: 1 read, 1 failed\n");
  const [fetched] = await map({ urls: [MISSING], what: "fetch" });
  expect(fetched).toMatchObject({ ok: false, error: expect.stringContaining("an error page (HTTP 404)"), failure: { code: "not_content" } });
  const [saved] = await map({ urls: [MISSING], save: mkdtempSync(join(tmpdir(), "map-")) });
  expect(saved).toMatchObject({ ok: false, value: { pageState: { kind: "error" } } });
  expect(readFileSync(savedPath(saved), "utf8")).toContain("has moved");
});

// In the October hunts an agent read a folder's files to learn which of
// its pages had failed, and keyed its retries on the addresses inside
// eBay's, as its files held only the expression's value (AkylHunts AH5).
test("with save to a folder, map keeps an index.json there of every page, failed ones too, and an eval's file holds the page it came from", async () => {
  const dir = mkdtempSync(join(tmpdir(), "map-"));
  const answer = await mapPages({ urls: [GONE, "https://shop.example/a"], what: "eval", expression: "cards()", save: dir }, callTool);
  const [gone, read] = answer.pages as Page[];
  expect(answer.index).toBe(join(dir, "index.json"));
  expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))).toEqual([
    { url: GONE, title: "Page", ok: false, ms: expect.any(Number), error: gone.ok ? "" : gone.error },
    { url: "https://shop.example/a", title: "Page", ok: true, ms: expect.any(Number), saved: savedPath(read) },
  ]);
  expect(JSON.parse(readFileSync(savedPath(read), "utf8"))).toEqual({ url: "https://shop.example/a", title: "Page", ok: true, ms: read.ms, value: { cards: 2 } });
  await mapPages({ urls: [GONE], what: "eval", expression: "cards()", save: dir }, callTool);
  expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).map((e: { url: string }) => e.url)).toEqual(["https://shop.example/a", GONE]);
});

// An index.json map did not write is the user's: on review one holding
// [{"name":"first"},{"name":"second"}] lost its first entry to a map that
// saved beside it.
test.each([
  ['[{"name":"first"},{"name":"second"}]'],
  ['[{"url":"https://shop.example/a","title":"A"}]'],
  ['[{"url":"https://shop.example/a","ok":true,"ms":1,"notes":"mine"}]'],
  ["[]"],
])("map leaves an index.json it did not write as it is, and says so: %s", async (theirs) => {
  const dir = mkdtempSync(join(tmpdir(), "map-"));
  writeFileSync(join(dir, "index.json"), theirs);
  const answer = await mapPages({ urls: ["https://shop.example/a"], save: dir }, callTool);
  expect({ index: answer.index, note: answer.note, file: readFileSync(join(dir, "index.json"), "utf8") }).toEqual({
    index: undefined,
    note: `no index.json: ${join(dir, "index.json")} is not a map's index, so it was left as it is`,
    file: theirs,
  });
});

// A session's agents, as omp names them (omp/index.ts): its lead [session,
// agent], and each helper [a session of its own, agent, the lead's session].
const taskIn = (session: string, agent: string) => JSON.stringify(agent === "Lead" ? [session, agent] : [`${session}/${agent}`, agent, session]);
const as = (agent: string, args: Record<string, unknown>, pid = process.pid, session = "s1") => runAs(pid, () => waited(mapPages(args, callTool)), taskIn(session, agent));

// On 10-23 a kernel research task's 1526 loads covered 1016 addresses, and
// 297 of them read a page another of its agents had read (K9).
test("a page this task read in the last 10 minutes is answered from that read, saying whose; fresh, another task, or 10 minutes on loads it again", async () => {
  jest.useFakeTimers();
  const page = "https://shop.example/kept";
  readUrls.length = 0;
  await as("Lead", { urls: [page] });
  const again = await as("Helper", { urls: [page, "https://shop.example/new"] });
  expect(again.pages[0]).toMatchObject({ ok: true, ms: 0, from: expect.stringMatching(/^from Lead's read \d+ s ago$/), value: { text: `text of ${page}` } });
  expect(formatResult(again)).toStartWith("2 pages: 2 read, 0 failed; 1 from this task's reads of the last 10 minutes (fresh: true reads them again)\n");
  expect(readUrls).toEqual([page, "https://shop.example/new"]);
  await as("Helper", { urls: [page], fresh: true });
  await as("Other", { urls: [page] }, process.ppid);
  expect(readUrls).toEqual([page, "https://shop.example/new", page, page]);
  setSystemTime(new Date(Date.now() + 11 * 60_000));
  try {
    await as("Helper", { urls: [page] });
  } finally {
    setSystemTime();
  }
  expect(readUrls).toHaveLength(5);
});

// On 10-22 five agents of a shopping task met Yelp's DataDome check six
// times in 2 h 22 min (SR-2).
test("a site that showed this task a bot check is not loaded again, saying who met it; fresh, or another task, loads it", async () => {
  jest.useFakeTimers();
  await as("SacCake", { urls: [WALLED] });
  const before = opened.length;
  const [page] = (await as("Lead", { urls: [`${WALLED}menu`] })).pages;
  expect(page).toMatchObject({ ok: false, challenge: { kind: "cloudflare", where: "page" } });
  expect(opened.length).toBe(before);
  await as("Lead", { urls: [WALLED], fresh: true });
  await as("Other", { urls: [WALLED] }, process.ppid);
  expect(opened.length).toBe(before + 2);
});

// omp can move a process to another session (/new, /resume) within the 10
// minutes; on review a page one session read, and a site that showed it a
// check, reached the next.
test("a page or a site one session read or met is loaded again for another session of the same process", async () => {
  jest.useFakeTimers();
  const page = "https://shop.example/session";
  readUrls.length = 0;
  await as("Lead", { urls: [page] }, process.pid, "s2");
  await as("Lead", { urls: [page] }, process.pid, "s3");
  expect(readUrls).toEqual([page, page]);
  await as("Helper", { urls: [WALLED] }, process.pid, "s2");
  const before = opened.length;
  await as("Lead", { urls: [WALLED] }, process.pid, "s3");
  expect(opened.length).toBe(before + 1);
});

// On 10-22 a map of four Google searches met four reCAPTCHA pages (K12).
test("map loads a search engine's results pages one at a time, 3 s apart, and its other pages without waiting", async () => {
  jest.useFakeTimers();
  const from = loaded.length;
  const searches = ["a", "b", "c"].map((q) => `${SEARCH}${q}`);
  await waited(map({ urls: [...searches, "https://shop.example/c"] }));
  const at = new Map(loaded.slice(from));
  const when = (url: string) => at.get(url) ?? Number.NaN;
  expect(when(searches[1]) - when(searches[0])).toBeGreaterThanOrEqual(3000);
  expect(when(searches[2]) - when(searches[1])).toBeGreaterThanOrEqual(3000);
  expect(when("https://shop.example/c") - when(searches[0])).toBeLessThan(3000);
});

test("once a search of a map meets a bot check, the map loads none of that site's searches after it", async () => {
  jest.useFakeTimers();
  const from = loaded.length;
  const searches = [CAPTCHA, `${SEARCH}d`, `${SEARCH}e`];
  const { pages } = await as("Lead", { urls: searches });
  expect(pages.map((p) => [p.ok, "challenge" in p ? p.challenge?.kind : undefined])).toEqual([[false, "recaptcha"], [false, "recaptcha"], [false, "recaptcha"]]);
  expect(pages[2]).toMatchObject({ error: expect.stringMatching(/^google\.com showed a recaptcha bot check to you \d+ s ago, so it was not loaded again/) });
  expect(loaded.slice(from).map(([url]) => url)).toEqual([CAPTCHA]);
});

// In a shopping task on 10-22 three maps with follow waited for a
// listing's heading on every page they followed, and each ran out its 50 s
// (SR-1).
test("with follow, wait holds each page followed, a note says so when none of them showed it, and the links past max come back as urls", async () => {
  const answer = await followPages({ urls: [LISTING], follow: { match: "/\\/item\\//", max: 2 }, wait: { text: ABSENT } }, callTool);
  expect(answer.pages).toMatchObject([{ url: LISTING, ok: true, items: [{ ok: false }, { ok: false }], unread: 1 }]);
  expect(answer.note).toStartWith("wait holds each page followed, not the listing");
  expect(answer.urls).toEqual(["https://www.shop.example/item/3"]);
  expect(formatResult(answer)).toContain('map them next: {"urls":["https://www.shop.example/item/3"]}');
});

// On 10-23 seven map answers were cut at a reply's 30,000 characters, and
// three of their pages did not show at all (K6).
test("a map answer past a reply's length lists every page first, and gives each a share: a short page whole, a long one cut saying where", async () => {
  const long = `text ${"x".repeat(40_000)}`;
  const pages: Page[] = [
    { url: "https://shop.example/1", ok: true, ms: 5, value: long },
    { url: "https://shop.example/2", ok: true, ms: 5, value: "short" },
    { url: GONE, ok: false, ms: 5, error: "no tab" },
    { url: "https://shop.example/3", ok: true, ms: 5, value: long },
  ];
  const text = formatResult({ pages }, 30_000);
  expect(text.length).toBeLessThanOrEqual(30_000);
  expect(text).toContain(["- https://shop.example/1: read, 40005 characters", "- https://shop.example/2: read, 5 characters", `- ${GONE}: failed: no tab`, "- https://shop.example/3: read, 40005 characters"].join("\n"));
  expect(text).toContain("## https://shop.example/2 (5 ms)\nshort\n\n");
  expect(text.match(/\n…cut at \d+ of 40005 characters/g)).toHaveLength(2);
  expect(text).toContain("## https://shop.example/3 (5 ms)\ntext xxx");
});

// On 10-29 a map's list of pages gave a 237,685-byte page as about 20,000
// characters: the part its read kept, not the page.
test("a map answer past a reply's length gives a page cut at its limit its whole length and the file that holds it", () => {
  const pages: Page[] = [1, 2].map((n) => ({ url: `https://shop.example/${n}`, ok: true, ms: 5, value: { url: `https://shop.example/${n}`, title: "Item", text: `text ${"x".repeat(19_995)}`, truncated: true, total: 237_685, saved: `/saved/item-${n}.txt` } }));
  const text = formatResult({ pages }, 30_000);
  expect(text).toContain("- https://shop.example/1: read, 237685 characters, saved in /saved/item-1.txt\n- https://shop.example/2: read, 237685 characters, saved in /saved/item-2.txt");
  expect(text.match(/\n…cut at \d+ of 237685 characters/g)).toHaveLength(2);
});
