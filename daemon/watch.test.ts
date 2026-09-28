import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as imessage from "./imessage.ts";
import * as phone from "./phone.ts";
import * as daemonRpc from "./rpc.ts";
import { lastValue, runWatch, type Watch } from "./watch.ts";

// A watch routine reads one value off a page on a schedule, with no model,
// and texts the user's phone when it changes. Safari and Messages are fakes:
// the daemon's tools answer from one page, which may show a check or a
// sign-in form instead of the value, and a text is only recorded.

const OWN = "+15550100000";
const WATCH: Watch = { url: "https://shop.example/item", how: "selector", what: ".stock", to: OWN };
type Page = { value?: string; check?: true; signIn?: true };

let page: Page = {};
let dir = "";
let texts: [string, string][] = [];
let opened: Record<string, unknown>[] = [];
let closed: unknown[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "safari-watch-"));
  page = {};
  texts = [];
  opened = [];
  closed = [];
  spyOn(phone, "dataFile").mockImplementation((name) => join(dir, name));
  spyOn(imessage, "textOwnNumber").mockImplementation(async (to, line) => void texts.push([to, line]));
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => {
    if (tool === "open") {
      opened.push(args);
      return { id: 9, url: args.url, title: "Item", ...(page.check ? { challenge: { kind: "cloudflare", where: "page" } } : {}) };
    }
    if (tool === "close") return void closed.push(args.tab);
    if (tool === "wait") return { ok: true, found: page.value !== undefined, waitedMs: 0 };
    if (tool === "extract") return { url: WATCH.url, title: "Item", text: page.value, truncated: false };
    if (tool === "login_form" && page.signIn) return { site: "shop.example", frame: 0, username: true, password: true };
    throw new Error(`the page has no ${tool}`);
  });
});
afterEach(() => {
  mock.restore();
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

test("a watch texts only when the value changes: its first run records it without a text, and every run closes the tab it opened", async () => {
  page = { value: "3 left" };
  await runWatch("stock", WATCH);
  await runWatch("stock", WATCH);
  expect(texts).toEqual([]);
  page = { value: "2 left" };
  await runWatch("stock", WATCH);
  await runWatch("stock", WATCH);
  expect(texts).toEqual([[OWN, "stock: 3 left -> 2 left (https://shop.example/item)"]]);
  expect(lastValue("stock")).toBe("2 left");
  // in the background, never left open
  expect(opened).toEqual(Array(4).fill(expect.objectContaining({ background: true })));
  expect(closed).toEqual([9, 9, 9, 9]);
});

test.each([
  ["a check", { check: true }],
  ["a sign-in page", { signIn: true }],
] as const)("a watched page that shows %s texts him about it at most once a day, and keeps the value it last read", async (wall, shown) => {
  const start = Date.UTC(2026, 8, 28, 12);
  setSystemTime(start);
  page = { value: "3 left" };
  await runWatch("stock", WATCH);
  page = { ...shown };
  for (const hours of [1, 2, 24, 25, 49]) {
    setSystemTime(start + hours * 3_600_000);
    expect(await runWatch("stock", WATCH)).toMatchObject({ code: 1 });
  }
  page = { value: "2 left" };
  setSystemTime(start + 50 * 3_600_000);
  await runWatch("stock", WATCH);
  const line: [string, string] = [OWN, `stock needs you: shop.example shows ${wall}`];
  expect(texts).toEqual([line, line, line, [OWN, "stock: 3 left -> 2 left (https://shop.example/item)"]]);
});
