import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as phone from "./phone.ts";
import * as daemonRpc from "./rpc.ts";
import * as telegram from "./telegram.ts";
import { history, lastValue, runWatch, type Watch } from "./watch.ts";

// A watch routine reads one value off a page on a schedule, with no model,
// and alerts the user's phone when it changes. Safari and Telegram are
// fakes: the daemon's tools answer from one page, which may show a check or
// a sign-in form instead of the value, and an alert is only recorded.

const WATCH: Watch = { url: "https://shop.example/item", how: "selector", what: ".stock" };
type Page = { value?: string; check?: true; signIn?: true };

let page: Page = {};
let dir = "";
let texts: string[] = [];
let opened: Record<string, unknown>[] = [];
let closed: unknown[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "safari-watch-"));
  page = {};
  texts = [];
  opened = [];
  closed = [];
  spyOn(phone, "dataFile").mockImplementation((name) => join(dir, name));
  spyOn(telegram, "sendTelegram").mockImplementation(async (line) => void texts.push(line));
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => {
    if (tool === "open") {
      opened.push(args);
      return { id: 9, url: args.url, title: "Item", ...(page.check ? { challenge: { kind: "cloudflare", where: "page" } } : {}) };
    }
    if (tool === "close") return void closed.push(args.tab);
    if (tool === "wait") return { ok: true, found: page.value !== undefined, waitedMs: 0 };
    if (tool === "extract") return { url: WATCH.url, title: "Item", text: page.value, truncated: false };
    if (tool === "eval") return { result: page.value ?? null };
    if (tool === "login_form" && page.signIn) return { site: "shop.example", frame: 0, username: true, password: true };
    throw new Error(`the page has no ${tool}`);
  });
});
afterEach(() => {
  mock.restore();
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

test("a watch alerts only when the value changes: its first run records it without an alert, and every run closes the tab it opened", async () => {
  page = { value: "3 left" };
  await runWatch("stock", WATCH);
  await runWatch("stock", WATCH);
  expect(texts).toEqual([]);
  page = { value: "2 left" };
  await runWatch("stock", WATCH);
  await runWatch("stock", WATCH);
  expect(texts).toEqual(["stock: 3 left -> 2 left (https://shop.example/item)"]);
  expect(lastValue("stock")).toBe("2 left");
  // in the background, never left open
  expect(opened).toEqual(Array(4).fill(expect.objectContaining({ background: true })));
  expect(closed).toEqual([9, 9, 9, 9]);
});

test.each([
  ["a check", { check: true }],
  ["a sign-in page", { signIn: true }],
] as const)("a watched page that shows %s alerts him about it at most once a day, and keeps the value it last read", async (wall, shown) => {
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
  const line = `stock needs you: shop.example shows ${wall}`;
  expect(texts).toEqual([line, line, line, "stock: 3 left -> 2 left (https://shop.example/item)"]);
});

// On 10-23 the alert command was missing, and nothing said so (HD-5).
test("a change the user could not be told about is noted with why, and the next run tells him", async () => {
  page = { value: "3 left" };
  await runWatch("stock", WATCH);
  page = { value: "2 left" };
  spyOn(telegram, "sendTelegram").mockImplementationOnce(async () => {
    throw new Error("the phone alert is off: tell is missing");
  });
  expect(await runWatch("stock", WATCH)).toEqual({ code: 1, note: "changed: 3 left -> 2 left; the user was not told: the phone alert is off: tell is missing" });
  expect(await runWatch("stock", WATCH)).toEqual({ code: 0, note: "changed: 3 left -> 2 left; alerted the user" });
  expect(texts).toEqual(["stock: 3 left -> 2 left (https://shop.example/item)"]);
});

test("a price watch alerts once when the price falls below every price in its series, and not on a rise or a return to an old price", async () => {
  const PRICE: Watch = { ...WATCH, what: ".price", kind: "price" };
  for (const value of ["$1,299.00", "$1,299.00", "$1,349.00", "$1,199.00", "$1,199.00", "$1,249.00", "$1,199.00"]) {
    page = { value };
    await runWatch("laptop", PRICE);
  }
  expect(texts).toEqual(["laptop: price dropped to $1,199.00, below $1,299.00, the lowest of the last 3 readings (https://shop.example/item)"]);
});

test("a price watch reads each price whole or not at all: a rise in a three-place fuel price is no drop, and a price it cannot read whole is none", async () => {
  const GAS: Watch = { ...WATCH, what: ".price", kind: "price" };
  for (const value of ["$3.459", "$4.059"]) {
    page = { value };
    await runWatch("gas", GAS);
  }
  page = { value: "1.299,00 €" };
  expect(await runWatch("gas", GAS)).toEqual({ code: 1, note: "no price in 1.299,00 €" });
  expect(texts).toEqual([]);
  expect(history("gas", "price").map((r) => r.price)).toEqual(["$3.459", "$4.059", undefined]);
});

test("a price watch takes no crossed-out or 'was' price for a drop: a sale badge on an unchanged price alerts no one", async () => {
  const PRICE: Watch = { ...WATCH, what: ".price", kind: "price" };
  for (const value of ["$79.99", "Was $129.99 Now $79.99", "$79.99 List: $99.99 Save $20.00 (20% off)", "Compare at $49.00 $79.99"]) {
    page = { value };
    await runWatch("shoes", PRICE);
  }
  expect(texts).toEqual([]);
  expect(history("shoes", "price").map((r) => r.price)).toEqual(["$79.99", "$79.99", "$79.99", "$79.99"]);
});

test("an availability watch alerts with the slot's text the first time one opens after none, and again only after none again", async () => {
  const SLOTS: Watch = { ...WATCH, what: ".slot", kind: "availability" };
  for (const value of ["No appointments available", "None available.", "Tue Nov 18, 3:00 PM", "Tue Nov 18, 3:00 PM; Wed Nov 19, 9:00 AM", undefined, "Fri Nov 21, 1:00 PM"]) {
    page = { value };
    expect(await runWatch("dmv", SLOTS)).toMatchObject({ code: 0 });
  }
  expect(texts).toEqual([
    "dmv: open now: Tue Nov 18, 3:00 PM (https://shop.example/item)",
    "dmv: open now: Fri Nov 21, 1:00 PM (https://shop.example/item)",
  ]);
});

test("a watch keeps its last 100 readings, oldest first, in a file only the user can read", async () => {
  // an hour apart, so each change's alert stays under the 6 an hour
  const start = Date.UTC(2026, 10, 1);
  for (let i = 1; i <= 105; i++) {
    setSystemTime(start + i * 3_600_000);
    page = { value: `${i} left` };
    await runWatch("stock", WATCH);
  }
  const series = history("stock");
  expect(series).toHaveLength(100);
  expect([series[0].value, series[99].value]).toEqual(["6 left", "105 left"]);
  expect(statSync(join(dir, "state/stock.json")).mode & 0o777).toBe(0o600);
});
