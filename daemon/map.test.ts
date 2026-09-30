import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool } from "./tools.ts";
import { mapPages, type Page } from "./map.ts";
import { WAIT_NEEDS } from "./receipt.ts";

// Pages that fail in each way a page can: its tab goes away mid-read, it
// answers with an error, a bot check stands in for it, it never shows what
// a wait asks for (a page that is not there). CLEARING's check lets the
// browser through on the tab's fourth probe.
const GONE = "https://gone.example/";
const EMPTY = "https://empty.example/";
const WALLED = "https://walled.example/";
const LOST = "https://lost.example/";
const CLEARING = "https://clearing.example/";

// Pages whose read takes 31.5 s, as each of six Yelp pages' eval did on
// 09-30 (01a0f031).
const SLOW = "https://slow.example/";
const SLOW_MS = 31_500;

// A stand-in extension. Each open makes a tab in the window it names; the
// first open's window is made with its own page (tab 900). Reads answer at
// once, a SLOW page's after SLOW_MS, or, while holding, when the test lets
// them. A wait is answered at once, found on every page but LOST. Waits and
// reads are noted in order.
const tabs = new Map<number, { id: number; windowId: unknown; url: string; title: string }>();
const opened: number[] = [];
const closed: number[] = [];
const readUrls: string[] = [];
const asked: string[] = [];
const held: (() => void)[] = [];
let holding = false;
let stuck: string | undefined;
let nextTab = 0;
const probes = new Map<number, number>();

function read(tab: number): { value?: unknown; error?: string } {
  const url = tabs.get(tab)?.url ?? "";
  readUrls.push(url);
  asked.push(`read ${url}`);
  if (url === GONE) return { error: "no tab" };
  if (url === EMPTY) return { value: { error: "no content root" } };
  return { value: { url, title: "Page", text: `text of ${url}`, truncated: false } };
}

function answer(op: string, args: unknown[]): { value?: unknown; error?: string } {
  if (op === "windows.open") {
    tabs.set(900, { id: 900, windowId: 1, url: String(args[0]), title: "Page" });
    return { value: { windowId: 1, tabId: 900 } };
  }
  if (op === "tabs.list") return { value: [...tabs.values()] };
  if (op === "tabs.open") {
    const tab = { id: ++nextTab, windowId: args[2], url: String(args[0]), title: args[0] === LOST ? "Page Not Found" : "Page" };
    tabs.set(tab.id, tab);
    opened.push(tab.id);
    return { value: tab };
  }
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
    return { value: walled ? [{ frame: 0, url, title: "Just a moment...", text: "", markers: [], answered: [], frames: [] }] : url === CLEARING ? [{ frame: 0, url, title: "Page", text: "", markers: [], answered: [], frames: [] }] : [] };
  }
  return { value: { ok: true } };
}

connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const reply = (r: { value?: unknown; error?: string }) => bridge.handleMessage(JSON.stringify({ id, ...r }));
    if (op !== "relay") return reply(answer(op, args));
    if (args[1] === "wait") {
      const url = tabs.get(Number(args[0]))?.url ?? "";
      const [, want] = args[2] as [unknown, { text?: string }];
      asked.push(`wait ${url} for ${want.text}`);
      return reply({ value: { found: url !== LOST } });
    }
    if (holding) held.push(() => reply(read(Number(args[0]))));
    else if (tabs.get(Number(args[0]))?.url.startsWith(SLOW)) setTimeout(() => reply(read(Number(args[0]))), SLOW_MS);
    else reply(read(Number(args[0])));
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
const savedPath = (p: Page) => (p.ok && p.value && typeof p.value === "object" && "saved" in p.value && typeof p.value.saved === "string" ? p.value.saved : "");

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

test("map reads as many pages at once as asked, four when not asked", async () => {
  expect(await batches({ urls: urls(10) })).toEqual([4, 4, 2]);
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

// An eval or fetch read carries no title, and an address may have led to a
// page not found.
test("each page carries the title its tab opened with", async () => {
  const pages = await map({ urls: ["https://shop.example/a", LOST], what: "eval", expression: "document.title" });
  expect(pages.map((p) => [p.url, p.title])).toEqual([["https://shop.example/a", "Page"], [LOST, "Page Not Found"]]);
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

// Nobody watches these tabs, so a check still up once open has waited on it
// is reported: the agent decides whether to open that page and hand it to
// the user.
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
test("a map whose pages run long answers within 60 s with the pages it read, names the rest unfinished, and begins no more", async () => {
  jest.useFakeTimers();
  const before = opened.length;
  const slow = Array.from({ length: 9 }, (_, i) => `${SLOW}${i}`);
  const began = performance.now();
  const pages = await waited(map({ urls: slow, concurrency: 3 }));
  expect(performance.now() - began).toBeLessThan(60_000);
  expect(pages.map((p) => [p.url, p.ok])).toEqual(slow.map((url, i) => [url, i < 3]));
  expect(pages.slice(3).map((p) => (p.ok ? "read" : p.error))).toEqual(Array(6).fill(expect.stringMatching(/unfinished.*again/)));
  // The three still being read go on, each closing its tab as it ends; the
  // three not begun never open.
  for (let i = 0; i < 40; i++) {
    await settled();
    jest.advanceTimersByTime(500);
  }
  const mine = opened.slice(before);
  expect(mine.length).toBe(6);
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
  await until(() => opened.length - before === 6);
  await tick(33_000);
  await until(() => opened.slice(before).every((t) => closed.includes(t)));
  // A file begun after that lands on the real clock.
  jest.useRealTimers();
  await Bun.sleep(100);
  const saved = pages.map(savedPath);
  expect(saved.map((path) => path !== "")).toEqual([true, true, true, false, false, false]);
  expect(readdirSync(dir).map((name) => join(dir, name)).sort()).toEqual(saved.slice(0, 3).sort());
});
