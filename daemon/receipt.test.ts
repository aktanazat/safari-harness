import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { effectOf, keepRequest, NO_EFFECT, type RawReceipt, site, urlMatch } from "./receipt.ts";
import { callTool } from "./tools.ts";

// An action's receipt (receipt.ts, withReceipt in content.js) and the waits
// that read the page (waitFor in content.js). The page's half runs here
// from content.js itself: the block between its "tested with
// daemon/receipt.test.ts" markers, which carries site, keepRequest, and
// urlMatch with the daemon's bodies, and the settle and text rules.

type Span = { min: number; quiet: number; max: number };
type PageRules = {
  site: typeof site;
  keepRequest: typeof keepRequest;
  urlMatch: typeof urlMatch;
  settleAt: (start: number, last: number, busy: boolean, span: Span) => number;
  shows: (page: string, want: string) => boolean;
};

const CONTENT = readFileSync(join(import.meta.dir, "../extension/content.js"), "utf8");
const begin = CONTENT.indexOf("// ---- tested with daemon/receipt.test.ts: begin ----");
const end = CONTENT.indexOf("// ---- tested with daemon/receipt.test.ts: end ----");
const inPage: PageRules = new Function(`${CONTENT.slice(begin, end)}\nreturn { site, keepRequest, urlMatch, settleAt, shows };`)();

const copies = [["daemon", { site, keepRequest, urlMatch }], ["page", inPage]] as const;

// ---------- which requests a receipt reports ----------

// [method, url, page, kept]
const REQUESTS: [string, string, string, boolean][] = [
  ["POST", "https://shop.example.com/api/order", "https://shop.example.com/cart", true],
  ["GET", "https://api.shop.example.com/cart/items", "https://www.shop.example.com/cart", true],
  ["GET", "https://cdn.other.com/app.js", "https://shop.example.com/cart", false],
  ["GET", "https://static.bbc.co.uk/news.json", "https://www.bbc.co.uk/news", true],
  ["GET", "https://evil.co.uk/news.json", "https://www.bbc.co.uk/news", false],
  ["GET", "http://127.0.0.1:9000/api", "http://127.0.0.1:8080/", true],
  ["GET", "http://127.0.0.2/api", "http://127.0.0.1:8080/", false],
  ["POST", "https://shop.example.com/collect", "https://shop.example.com/cart", false],
  ["GET", "https://shop.example.com/v1/track.gif?u=1", "https://shop.example.com/cart", false],
  ["POST", "https://shop.example.com/g/log", "https://shop.example.com/cart", false],
  ["GET", "https://shop.example.com/Analytics/hit", "https://shop.example.com/cart", false],
  ["GET", "https://shop.example.com/pixel", "https://shop.example.com/cart", false],
  ["POST", "https://shop.example.com/beacon", "https://shop.example.com/cart", false],
  ["DELETE", "https://shop.example.com/track/42", "https://shop.example.com/cart", true],
  ["PUT", "https://shop.example.com/collect", "https://shop.example.com/cart", true],
  ["GET", "https://shop.example.com/login", "https://shop.example.com/cart", true],
  ["GET", "https://shop.example.com/catalog", "https://shop.example.com/cart", true],
  ["GET", "not a url", "https://shop.example.com/cart", false],
];

for (const [where, rules] of copies) {
  test(`${where}: a receipt keeps the page's own requests, less other sites and beacons`, () => {
    for (const [method, url, page, kept] of REQUESTS) expect([method, url, rules.keepRequest({ method, url }, page)]).toEqual([method, url, kept]);
  });

  test(`${where}: a wait's url is a part of the address, or a /regex/ with flags`, () => {
    expect(rules.urlMatch("https://shop.example.com/order/123/done", "/done")).toBe(true);
    expect(rules.urlMatch("https://shop.example.com/cart", "/done")).toBe(false);
    expect(rules.urlMatch("https://shop.example.com/ORDER/123", "/order\\/\\d+/i")).toBe(true);
    expect(rules.urlMatch("https://shop.example.com/ORDER/123", "/order\\/\\d+/")).toBe(false);
    expect(() => rules.urlMatch("", "/(/")).toThrow();
  });
}

// ---------- what a receipt says ----------

const QUIET: RawReceipt = { added: 0, removed: 0, changed: 0, url: null, focus: null, states: [], dialog: null, page: "https://shop.example.com/cart", requests: [], pending: [], errors: [] };

test("a page that did nothing gets none and what to try, word for word", () => {
  expect(effectOf(QUIET)).toEqual({ effect: "none", next: NO_EFFECT });
  expect(NO_EFFECT).toBe("the page did not react; the control may need a real click (real_input), a different target (a child or parent), or the page may be busy");
  // a tab that keeps no request log is judged on the rest
  expect(effectOf({ ...QUIET, requests: null, pending: null })).toEqual({ effect: "none", next: NO_EFFECT });
  // beacons and other sites are no reaction
  expect(effectOf({ ...QUIET, requests: [{ method: "POST", url: "https://shop.example.com/collect", status: 204 }, { method: "GET", url: "https://ads.other.com/x", status: 200 }] }).effect).toBe("none");
});

test("errors the page threw come beside the effect, and do not make one", () => {
  expect(effectOf({ ...QUIET, errors: ["TypeError: x is undefined"] })).toEqual({ effect: "none", next: NO_EFFECT, pageErrors: ["TypeError: x is undefined"] });
  expect(effectOf({ ...QUIET, added: 3, errors: ["boom"] })).toEqual({ effect: { added: 3 }, pageErrors: ["boom"] });
});

test("failed requests lead the net lines, paths without their queries, then the rest, then those still out", () => {
  const got = effectOf({
    ...QUIET,
    requests: [
      { method: "GET", url: "https://shop.example.com/api/cart?token=abc", status: 200 },
      { method: "POST", url: "https://shop.example.com/api/order", status: 500 },
      { method: "GET", url: "https://api.shop.example.com/stock", error: "TypeError: Load failed" },
      { method: "POST", url: "https://shop.example.com/collect", status: 204 },
    ],
    pending: [{ method: "GET", url: "https://shop.example.com/api/list?page=2" }],
  });
  expect(got).toEqual({ effect: { net: ["failed: POST /api/order 500", "failed: GET api.shop.example.com/stock TypeError: Load failed", "GET /api/cart 200", "pending: GET /api/list"] } });
});

test("a receipt lists ten requests and counts the rest", () => {
  const requests = Array.from({ length: 13 }, (_, i) => ({ method: "GET", url: `https://shop.example.com/api/${i}`, status: 200 }));
  expect(effectOf({ ...QUIET, requests })).toEqual({ effect: { net: [...requests.slice(0, 10).map((_, i) => `GET /api/${i} 200`), "and 3 more"] } });
});

test("a control's state change reads as what it is now and no longer is", () => {
  const got = effectOf({
    ...QUIET,
    states: [
      { who: 'button "Menu"', before: ["collapsed", "focused"], after: ["expanded"] },
      { who: 'checkbox "Gift"', before: ["checked"], after: [] },
      { who: 'combobox "Size"', before: ['value="S"'], after: ['value="M"'] },
      { who: 'button "Same"', before: ["focused"], after: [] },
    ],
  });
  expect(got).toEqual({ effect: { states: ['button "Menu": now expanded, no longer collapsed', 'checkbox "Gift": no longer checked', 'combobox "Size": value="S" -> value="M"'] } });
});

test("an address, focus, or dialog alone is an effect", () => {
  expect(effectOf({ ...QUIET, url: "https://shop.example.com/cart#step2" }).effect).toEqual({ url: "https://shop.example.com/cart#step2" });
  expect(effectOf({ ...QUIET, focus: 'textbox "Email"' }).effect).toEqual({ focus: 'textbox "Email"' });
  expect(effectOf({ ...QUIET, dialog: "confirm" }).effect).toEqual({ dialog: "confirm" });
});

// ---------- matching text ----------

test("the page's text matches case and spacing aside", () => {
  const rows: [string, string, boolean][] = [
    ["BMW M240 i xDrive", "M240i", true],
    ["BMW M240\u00a0i", "m240 I", true],
    ["Order\n  placed", "order placed", true],
    ["BMW M340i", "M240i", false],
    ["Payday", "Paid on", false],
  ];
  for (const [page, want, found] of rows) expect([page, want, inPage.shows(page, want)]).toEqual([page, want, found]);
});

// ---------- when a watch of the page ends ----------

// A fake clock walks a millisecond at a time; the page changed at the
// times given, and the watch ends at the first moment settleAt allows.
function endsAt(changes: number[], span: Span, busy = false): number {
  for (let now = 0; ; now++) {
    const last = Math.max(0, ...changes.filter((c) => c <= now));
    if (now >= inPage.settleAt(0, last, busy, span)) return now;
  }
}

const RECEIPT = { min: 300, quiet: 150, max: 800 };
const QUIET_WAIT = { min: 0, quiet: 500, max: Infinity };

test("an action's watch lasts 300 ms at least, 150 ms past the last change, 800 ms at most", () => {
  expect(endsAt([], RECEIPT)).toBe(300);
  expect(endsAt([50], RECEIPT)).toBe(300);
  expect(endsAt([250], RECEIPT)).toBe(400);
  expect(endsAt([250, 350], RECEIPT)).toBe(500);
  // a change after the page held still for 150 ms is too late to count
  expect(endsAt([250, 500], RECEIPT)).toBe(400);
  const storm = Array.from({ length: 50 }, (_, i) => i * 100);
  expect(endsAt(storm, RECEIPT)).toBe(800);
  // a page still waiting on its own site is watched to the end
  expect(endsAt([], RECEIPT, true)).toBe(800);
});

test("a quiet wait ends 500 ms after the page's last change", () => {
  expect(endsAt([], QUIET_WAIT)).toBe(500);
  expect(endsAt([100, 400], QUIET_WAIT)).toBe(900);
  expect(endsAt([100, 400, 1200], QUIET_WAIT)).toBe(900);
});

// ---------- through the tools ----------

// Safari as the daemon sees it: a page op answers from answers[op], and
// each request to the page is noted as [op, args].
function safari(answers: Record<string, (args: unknown[]) => unknown>) {
  const sent: [string, unknown[]][] = [];
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      const value = op === "relay" ? (sent.push([args[1], args[2]]), answers[args[1]]?.(args[2]) ?? { ok: true }) : [];
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  });
  return sent;
}

test("a click answers with its effect, or with where it led and nothing more", async () => {
  safari({ click: () => ({ ok: true, receipt: QUIET }) });
  expect(await callTool("click", { tab: 7, ref: "#b" })).toMatchObject({ ok: true, effect: "none", next: NO_EFFECT });
  safari({ click: () => ({ ok: true, receipt: { ...QUIET, added: 2 } }) });
  const added = await callTool("click", { tab: 7, ref: "#b" });
  expect(added).toMatchObject({ ok: true, effect: { added: 2 } });
  expect(added).not.toHaveProperty("receipt");
  safari({ click: () => ({ ok: true, navigated: { url: "https://shop.example.com/done", title: "Done" }, receipt: QUIET }) });
  const led = await callTool("click", { tab: 7, ref: "#b" });
  expect(led).toMatchObject({ ok: true, navigated: { url: "https://shop.example.com/done" } });
  expect(led).not.toHaveProperty("effect");
  expect(led).not.toHaveProperty("receipt");
});

test("a wait on several texts asks the page for all it wants and says which it saw", async () => {
  const sent = safari({ wait: () => ({ found: true, which: "Declined" }) });
  const got = await callTool("wait", { tab: 7, any: ["Placed", "Declined"], gone: "Loading", url: "/order/", quiet: true, ms: 1000 });
  expect(got).toMatchObject({ ok: true, found: true, which: "Declined" });
  expect(sent[0]).toEqual(["wait", [null, { any: ["Placed", "Declined"], gone: "Loading", url: "/order/", quiet: true }]]);
});

test("a wait refuses what the page could not check", async () => {
  safari({});
  await expect(callTool("wait", { tab: 7 })).rejects.toThrow("wait needs ms, selector, text, any, gone, url, or quiet");
  await expect(callTool("wait", { tab: 7, any: "Placed" })).rejects.toThrow("any must be a list of texts");
  await expect(callTool("wait", { tab: 7, any: [] })).rejects.toThrow("any must be a list of texts");
  await expect(callTool("wait", { tab: 7, url: "/(/" })).rejects.toThrow("is not a valid /regex/");
});

test("a whole-page snapshot of a page with nothing on it yet reads it again", async () => {
  let reads = 0;
  const page = () => (++reads < 3 ? { url: "https://bank.example/", title: "Sign in", nodes: 0, truncated: false, snapshot: "" } : { url: "https://bank.example/", title: "Sign in", nodes: 1, truncated: false, snapshot: '[1] button "Sign in"' });
  safari({ snapshot: page });
  expect(await callTool("snapshot", { tab: 8 })).toMatchObject({ nodes: 1, snapshot: '[1] button "Sign in"' });
  expect(reads).toBe(3);
  // a part of the page is read once: an empty part is an answer
  reads = 0;
  safari({ snapshot: page });
  expect(await callTool("snapshot", { tab: 8, query: "Sign in" })).toMatchObject({ nodes: 0 });
  expect(reads).toBe(1);
});
