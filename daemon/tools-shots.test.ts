import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool } from "./tools.ts";

// A stand-in Safari that keeps what a shot would show: each tab's address
// and each window's width. A shot's PNG bytes name the two, so a file says
// which page it caught at which width. A window opens at 1000 wide with its
// own page. A load of DOWN fails. Opens, shots, and closes are noted in
// order, by tab.
const HOME = "https://shop.example/";
const CART = "https://shop.example/cart";
const DOWN = "https://down.example/";
const DOWN_ERROR = "the page did not load within 30 s";

const tabs = new Map<number, { id: number; windowId: number; url: string; title: string }>();
const windowWidth = new Map<number, number>();
const tabEvents: string[] = [];
let nextId = 700;

function answer(op: string, args: unknown[]): { value?: unknown; error?: string } {
  if (op === "windows.open") {
    const windowId = ++nextId;
    const page = { id: ++nextId, windowId, url: String(args[0]), title: "Page" };
    tabs.set(page.id, page);
    windowWidth.set(windowId, 1000);
    return { value: { windowId, tabId: page.id } };
  }
  if (op === "windows.resolve") return { value: null };
  if (op === "tabs.list") return { value: [...tabs.values()] };
  if (op === "tabs.open") {
    const tab = { id: ++nextId, windowId: Number(args[2]), url: String(args[0]), title: "Page" };
    tabs.set(tab.id, tab);
    tabEvents.push(`open ${tab.id}${args[3] === true ? " owned" : ""}`);
    return { value: tab };
  }
  const tab = tabs.get(Number(args[0]));
  if (op === "window") {
    if (!tab) return { error: "no tab" };
    const { width, height } = args[1] as { width: number; height: number };
    windowWidth.set(tab.windowId, width);
    return { value: { windowId: tab.windowId, size: { width, height } } };
  }
  if (op === "tabs.navigate") {
    if (!tab) return { error: "no tab" };
    if (args[1] === DOWN) return { error: DOWN_ERROR };
    tab.url = String(args[1]);
    return { value: tab };
  }
  if (op === "shot") {
    if (!tab) return { error: "no tab" };
    tabEvents.push(`shot ${tab.id}`);
    return { value: { data: Buffer.from(`${tab.url} at ${windowWidth.get(tab.windowId)}`).toString("base64") } };
  }
  if (op === "tabs.close") {
    tabs.delete(Number(args[0]));
    tabEvents.push(`close ${Number(args[0])}`);
    return { value: { ok: true } };
  }
  // a relay: the quiet wait is met at once
  if (op === "relay") return { value: args[1] === "wait" ? { found: true } : { ok: true } };
  return { value: { ok: true } };
}

beforeEach(() => {
  tabEvents.length = 0;
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      const reply = answer(op, args);
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
    },
    close() {},
  });
});

// A folder that does not exist yet, two levels below a fresh one.
const freshOut = () => join(mkdtempSync(join(tmpdir(), "tools-shots-")), "evidence", "run-1");

type Shot = { url: string; width: number; path?: string; error?: string };

// What each file shows, read back from disk.
const shown = (files: Shot[]) => files.map((f) => ({ url: f.url, width: f.width, shows: f.path === undefined ? f.error : readFileSync(f.path, "utf8") }));

// A 99point agent took its before-and-after shots by hand: 45 shot calls
// and 47 resizes for 14 pages at two widths (S99PartA).
test("shots of 2 addresses at 2 widths writes 4 PNGs into a folder it makes, each the page at its width", async () => {
  const out = freshOut();
  const r = (await callTool("shots", { urls: [HOME, CART], widths: [390, 1440], out })) as { ok?: boolean; files: Shot[] };
  expect(r.ok).toBeUndefined();
  expect(new Set(r.files.map((f) => f.path)).size).toBe(4);
  expect(r.files.every((f) => f.path !== undefined && dirname(f.path) === out)).toBe(true);
  expect(shown(r.files).sort((a, b) => `${a.url} ${a.width}`.localeCompare(`${b.url} ${b.width}`))).toEqual([
    { url: HOME, width: 1440, shows: `${HOME} at 1440` },
    { url: HOME, width: 390, shows: `${HOME} at 390` },
    { url: CART, width: 1440, shows: `${CART} at 1440` },
    { url: CART, width: 390, shows: `${CART} at 390` },
  ]);
});

test("shots works in one tab of the harness's own, closed once its last shot is taken", async () => {
  await callTool("shots", { urls: [HOME, CART], widths: [390, 1440], out: freshOut() });
  const tab = /^open (\d+) owned$/.exec(tabEvents[0] ?? "")?.[1];
  expect(tabEvents).toEqual([`open ${tab} owned`, `shot ${tab}`, `shot ${tab}`, `shot ${tab}`, `shot ${tab}`, `close ${tab}`]);
  expect(tabs.has(Number(tab))).toBe(false);
});

test("a page that fails to load is a miss in its place at each width, and the other pages are still shot", async () => {
  const r = (await callTool("shots", { urls: [DOWN, HOME], widths: [390, 1440], out: freshOut() })) as { ok?: boolean; files: Shot[] };
  expect(r.ok).toBe(false);
  expect(shown(r.files)).toEqual([
    { url: DOWN, width: 390, shows: DOWN_ERROR },
    { url: HOME, width: 390, shows: `${HOME} at 390` },
    { url: DOWN, width: 1440, shows: DOWN_ERROR },
    { url: HOME, width: 1440, shows: `${HOME} at 1440` },
  ]);
});
