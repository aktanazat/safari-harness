import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import type { DomData, Json, PageGlobals } from "./pagedata.ts";
import { callTool } from "./tools.ts";

// A stand-in extension: each tab's page has the data its markup declares
// (content.js answers "data") and the state in its page globals
// (background.js answers "pageData").
type Page = { dom: DomData; globals?: PageGlobals };
const pages = new Map<number, Page>();
connect({
  send(raw: string) {
    const { id, op, args } = JSON.parse(raw) as { id: string; op: string; args: unknown[] };
    const page = pages.get(Number(args[0]));
    const value = op === "relay" && args[1] === "data" ? page?.dom : op === "pageData" ? (page?.globals ?? {}) : { ok: true };
    bridge.handleMessage(JSON.stringify({ id, value }));
  },
  close() {},
});

let nextTab = 0;
function data(page: Page, o: { pick?: string; max?: number } = {}): Promise<Record<string, unknown>> {
  const tab = ++nextTab;
  pages.set(tab, page);
  return callTool("data", { tab, ...o }) as Promise<Record<string, unknown>>;
}

// A product page: JSON-LD for the product, its meta tags, and the Next.js
// state that holds the whole catalog.
const items = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `Item ${i}`, blurb: "x".repeat(80) }));
const shop: Page = {
  dom: {
    url: "https://shop.example/p/1",
    title: "Shoe",
    jsonld: [{ "@type": "Product", name: "Shoe", offers: { price: "49.50", priceCurrency: "USD" } }],
    meta: { "og:title": "Shoe", description: "A shoe" },
    next: { props: { pageProps: { items } }, page: "/p/[id]", buildId: "b1" },
  },
};
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

test("pick follows dotted keys, [n] items, and quoted keys", async () => {
  expect((await data(shop, { pick: "next.props.pageProps.items[1].name" })).value).toBe("Item 1");
  expect((await data(shop, { pick: "jsonld.0.offers.price" })).value).toBe("49.50");
  const apollo: Page = { dom: { url: "", title: "" }, globals: { values: { apollo: { "Product:1.2": { price: 5 } } } } };
  expect((await data(apollo, { pick: 'apollo["Product:1.2"].price' })).value).toBe(5);
});

test("a pick that is not a path says how one looks", async () => {
  for (const pick of ["", ".next", "next..props", "next.", "next[x]", "next[1", "next[0]props"]) {
    await expect(data(shop, { pick })).rejects.toThrow("a path looks like next.props.items[0].name");
  }
});

test("a pick past the data names the step it could not take and what was there", async () => {
  await expect(data(shop, { pick: "next.props.pageProps.itemz" })).rejects.toThrow('next.props.pageProps has no "itemz"; its keys: items');
  await expect(data(shop, { pick: "next.props.pageProps.items[40]" })).rejects.toThrow("next.props.pageProps.items has no [40]; it is a list of 40");
  await expect(data(shop, { pick: "apollo.ROOT_QUERY" })).rejects.toThrow("this page has no apollo data; it has jsonld, meta, next");
});

test("the whole comes back while it fits in max", async () => {
  const out = await data(shop);
  expect(out.data).toEqual({ jsonld: shop.dom.jsonld, meta: shop.dom.meta, next: shop.dom.next });
  expect(out.more).toBeUndefined();
});

test("past max, the sources that fit come back whole, and the rest by size and keys, with a path to pick", async () => {
  const out = await data(shop, { max: 1000 });
  expect(out.data).toEqual({ jsonld: shop.dom.jsonld, meta: shop.dom.meta });
  expect(out.sources).toContainEqual({ name: "next", bytes: size(shop.dom.next), keys: ["props", "page", "buildId"] });
  expect(out.more).toContain("call again with pick, a path into it such as next.props");
  // two that each fit alone, but not together: the smaller comes back
  const tight = await data(shop, { max: size(shop.dom.jsonld) + size(shop.dom.meta) - 1 });
  expect(tight.data).toEqual({ meta: shop.dom.meta });
  expect(tight.more).toContain(`jsonld (${size(shop.dom.jsonld)} bytes)`);
});

test("a picked part over max comes back as its keys, with a deeper path to pick", async () => {
  const out = await data(shop, { pick: "next.props.pageProps", max: 1000 });
  expect(out).toMatchObject({ pick: "next.props.pageProps", keys: ["items"] });
  expect(out.value).toBeUndefined();
  expect(out.more).toContain("pick deeper, such as next.props.pageProps.items");
});

test("sources come in a fixed order, empty ones left out, and Next.js's own script tag wins over its global", async () => {
  const out = await data({
    dom: { url: "", title: "", jsonld: [], meta: { "og:title": "Tag" }, next: { from: "tag" }, attrs: [{ el: "div#card", "data-product": { sku: 1 } }] },
    globals: { values: { next: { from: "global" }, apollo: { ROOT_QUERY: { a: 1 } }, state: {} } },
  });
  expect(out.sources).toEqual(["meta", "next", "apollo", "attrs"].map((name) => ({ name, bytes: expect.any(Number) })));
  expect(out.data).toMatchObject({ next: { from: "tag" } });
  // a page that removed the tag once it started still has the global
  expect((await data({ dom: { url: "", title: "" }, globals: { values: { next: { from: "global" } } } })).data).toEqual({ next: { from: "global" } });
});

test("values under secret-looking keys stay in the page", async () => {
  const out = await data({
    dom: { url: "", title: "", meta: { "csrf-token": "v-9f2", "og:title": "Shoe" }, next: { props: { pageProps: { csrfToken: "v-9f2", user: { name: "A", passwordHint: "v-9f2" } } } } },
  });
  expect(JSON.stringify(out)).not.toContain("v-9f2");
  expect(out.data).toMatchObject({ meta: { "csrf-token": "[hidden]", "og:title": "Shoe" } });
});

test("Nuxt 3's flat payload comes back as the object it encodes", async () => {
  // as Nuxt writes <script id="__NUXT_DATA__">: devalue's flat form, where
  // numbers in objects and lists are indexes into the list
  const payload: Json = [
    ["ShallowReactive", 1],
    { data: 2, state: 6, once: 8, _errors: 9 },
    ["ShallowReactive", 3],
    { product: 4 },
    { name: 5, price: 10, added: 11, tags: 12, note: -1, self: 4 },
    "Shoe",
    ["Reactive", 7],
    {},
    ["Set"],
    ["Ref", 13],
    49.5,
    ["Date", "2026-09-01T00:00:00.000Z"],
    ["Set", 5],
    null,
  ];
  // Nuxt 3's __NUXT__ holds only its config
  const out = await data({ dom: { url: "", title: "", nuxt: payload }, globals: { values: { nuxt: { config: { app: {} } } } } });
  expect(out.data).toEqual({
    nuxt: {
      data: { product: { name: "Shoe", price: 49.5, added: "2026-09-01T00:00:00.000Z", tags: ["Shoe"], self: "[circular]" } },
      state: {},
      once: [],
      _errors: null,
    },
  });
});

test("a source too big to send is listed by its size, and a pick into it says how to read part of it", async () => {
  const page: Page = { dom: { url: "", title: "", meta: { "og:title": "Shoe" } }, globals: { values: {}, tooBig: { apollo: 9_000_000 } } };
  expect((await data(page)).sources).toContainEqual({ name: "apollo", bytes: 9_000_000, unread: true });
  await expect(data(page, { pick: "apollo.ROOT_QUERY" })).rejects.toThrow("eval with page: true reads part of it");
});
