import { expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool } from "./tools.ts";
import { mapPages, type Page } from "./map.ts";

// Pages that fail in each way a page can: its tab goes away mid-read, it
// answers with an error, a bot check stands in for it.
const GONE = "https://gone.example/";
const EMPTY = "https://empty.example/";
const WALLED = "https://walled.example/";

// A stand-in extension. Each open makes a tab in the window it names; the
// first open's window is made with its own page (tab 900). Reads answer at
// once, or, while holding, when the test lets them.
const tabs = new Map<number, { id: number; windowId: unknown; url: string }>();
const opened: number[] = [];
const closed: number[] = [];
const readUrls: string[] = [];
const held: (() => void)[] = [];
let holding = false;
let stuck: string | undefined;
let nextTab = 0;

function read(tab: number): { value?: unknown; error?: string } {
  const url = tabs.get(tab)?.url ?? "";
  readUrls.push(url);
  if (url === GONE) return { error: "no tab" };
  if (url === EMPTY) return { value: { error: "no content root" } };
  return { value: { url, title: "Page", text: `text of ${url}`, truncated: false } };
}

function answer(op: string, args: unknown[]): { value?: unknown; error?: string } {
  if (op === "windows.open") {
    tabs.set(900, { id: 900, windowId: 1, url: String(args[0]) });
    return { value: { windowId: 1, tabId: 900 } };
  }
  if (op === "tabs.list") return { value: [...tabs.values()] };
  if (op === "tabs.open") {
    const tab = { id: ++nextTab, windowId: args[2], url: String(args[0]) };
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
    const url = tabs.get(Number(args[0]))?.url;
    return { value: url === WALLED ? [{ frame: 0, url, title: "Just a moment...", text: "", markers: [], answered: [], frames: [] }] : [] };
  }
  return { value: { ok: true } };
}

connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const reply = (r: { value?: unknown; error?: string }) => bridge.handleMessage(JSON.stringify({ id, ...r }));
    if (op !== "relay") return reply(answer(op, args));
    if (holding) held.push(() => reply(read(Number(args[0]))));
    else reply(read(Number(args[0])));
  },
  close() {},
});

// the answers settle in microtasks, which all run before the next turn
const settled = () => new Promise((resolve) => setImmediate(resolve));
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

test("every tab map opens is closed, a failed page's and a bot check's included", async () => {
  const before = opened.length;
  await map({ urls: ["https://shop.example/a", GONE, EMPTY, WALLED] });
  const mine = opened.slice(before);
  expect(mine.length).toBe(4);
  expect(closed.filter((t) => mine.includes(t)).sort()).toEqual(mine.sort());
  expect([...tabs.keys()]).toEqual([900]);
});

// Nobody watches these tabs, so a check is not waited on: the agent decides
// whether to open that page and hand it to the user.
test("a bot check is reported on its page and its page is never read", async () => {
  readUrls.length = 0;
  const pages = await map({ urls: [WALLED, "https://shop.example/a"] });
  expect(pages[0]).toMatchObject({ url: WALLED, ok: false, challenge: { kind: "cloudflare", where: "page" } });
  expect(pages[1].ok).toBe(true);
  expect(readUrls).toEqual(["https://shop.example/a"]);
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
