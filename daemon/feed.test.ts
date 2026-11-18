import { expect, test } from "bun:test";
import { feedPages, type FeedDeps, type NetEntry } from "./feed.ts";

const PAGE = "https://shop.example/widgets";
const rows = (from: number) => Array.from({ length: 3 }, (_, i) => ({ id: from + i, name: `Widget number ${from + i}` }));
const reply = (from: number) => JSON.stringify({ items: rows(from) });
const shown = [...rows(1), ...rows(4)].map((row) => row.name).join("\n");

// A shop whose page asked for two pages of its list, at the addresses
// given; fetches answer the next page and are recorded.
function shop(first: string, second: string) {
  const fetched: string[] = [];
  const entries: NetEntry[] = [
    { url: first, method: "GET", kind: "fetch", status: 200, t: 1, body: reply(1) },
    { url: second, method: "GET", kind: "fetch", status: 200, t: 2, body: reply(4) },
  ];
  const deps: FeedDeps = {
    entries: async () => entries,
    body: async (_tab, e) => ({ text: e.body ?? "", truncated: false, arriving: false }),
    pageUrl: async () => PAGE,
    pageText: async () => shown,
    scroll: async () => undefined,
    fetch: async (_tab, url) => {
      fetched.push(url);
      return { status: 200, url, type: "application/json", text: reply(7 + 3 * (fetched.length - 1)) };
    },
    save: async () => "/dev/null",
    sleep: async () => {},
  };
  return { deps, fetched };
}

test("net pages asks for the next page changing only the pager key", async () => {
  const { deps, fetched } = shop("https://shop.example/api/items?page=1&brand=nike&inStock=1", "https://shop.example/api/items?page=2&brand=nike&inStock=1");
  await feedPages(1, { pages: 1 }, deps);
  expect(fetched.map((url) => Object.fromEntries(new URL(url).searchParams))).toEqual([{ page: "3", brand: "nike", inStock: "1" }]);
});

test.each([
  ["an endpoint that marks what it lists as seen", "https://shop.example/api/items?page=1&markSeen=1", "https://shop.example/api/items?page=2&markSeen=1"],
  ["a signed address", "https://shop.example/api/items?page=1&sig=abc123", "https://shop.example/api/items?page=2&sig=abc123"],
  ["an address the net log cut short", `https://shop.example/api/items?ids=${"x".repeat(480)}&page=1…`, `https://shop.example/api/items?ids=${"x".repeat(480)}&page=2…`],
])("net pages never asks again for %s", async (_name, first, second) => {
  const { deps, fetched } = shop(first, second);
  await expect(feedPages(1, { pages: 1 }, deps)).rejects.toThrow(/none of the JSON the page fetched holds rows the page shows/);
  expect(fetched).toEqual([]);
});
