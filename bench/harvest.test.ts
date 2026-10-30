import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runner } from "./bench.ts";

// content.js's extract in real WebKit, sent as background.js sends it, on
// pages whose lists hold a known number of items: a plain read must say
// it left some, and expand or scroll must bring back nearly all of them.
const address = (page: string) => pathToFileURL(join(import.meta.dir, "fixtures", page)).href;

async function replies(page: string, steps: Record<string, unknown>[], query = ""): Promise<unknown[]> {
  const url = address(page) + query;
  const requests = [{ load: url, frames: 0 }, ...steps];
  const proc = Bun.spawn([runner, join(import.meta.dir, "..", "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(requests.map((request) => JSON.stringify(request) + "\n").join(""));
  proc.stdin.end();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`the WebKit bench exited ${code}: ${err.trim()}`);
  const [loaded, ...answers] = out.trim().split("\n").map((line) => JSON.parse(line) as unknown);
  expect(loaded).toMatchObject({ url });
  return answers;
}

type Read = { value: { text: string; harvested?: string; incomplete?: { reason: string; hint: string } } };

const LISTS = [
  { page: "load-more.html", item: "Comment", total: 300, option: "expand" },
  { page: "infinite-scroll.html", item: "Post", total: 300, option: "scroll" },
  { page: "virtual-list.html", item: "Member", total: 1000, option: "scroll" },
] as const;

describe.skipIf(!runner)("whole lists in real WebKit", () => {
  test.each(LISTS)("$page: a plain read is flagged incomplete, and $option reads at least 98 in 100 of its $total items", async ({ page, item, total, option }) => {
    const [plain, whole, after] = await replies(page, [
      { op: "extract", args: [{ maxBytes: 200_000 }] },
      { op: "extract", args: [{ [option]: true, maxBytes: 200_000, ms: 25_000 }], timeout: 40_000 },
      { pageEval: "({ url: location.href, used: document.body.dataset.used ?? '' })" },
    ]) as [Read, Read, { value: { url: string; used: string } }];
    expect(plain.value.incomplete?.hint).toContain(`${option}: true`);
    const found = new Set(whole.value.text.match(new RegExp(`\\b${item} \\d+\\b`, "g")));
    expect(found.size).toBeGreaterThanOrEqual(Math.ceil(total * 0.98));
    expect(whole.value.harvested).toContain(`${found.size.toLocaleString("en-US")} items`);
    expect(whole.value.incomplete).toBeUndefined();
    // the link and the submit button named like Load more stay unclicked
    expect(after.value).toEqual({ url: address(page), used: "" });
  }, 60_000);

  test("a Load more that expand cannot click stays in incomplete, with why", async () => {
    const [read] = await replies("load-more.html", [{ op: "extract", args: [{ expand: true, maxBytes: 200_000, ms: 25_000 }], timeout: 40_000 }], "?cover") as [Read];
    expect(read.value.incomplete?.reason).toMatch(/"Load more".*covered by/);
  }, 60_000);

  test("a feed scrolled to an end that still declares more posts stays in incomplete", async () => {
    const [read] = await replies("infinite-scroll.html", [{ op: "extract", args: [{ scroll: true, maxBytes: 200_000, ms: 25_000 }], timeout: 40_000 }], "?stall=100") as [Read];
    expect(read.value.harvested).toContain("stopped: nothing new");
    expect(read.value.incomplete?.hint).toContain("scroll: true");
  }, 60_000);

  test("scroll gathers a feed that declares no size, not a block of more but shorter lines above it", async () => {
    const [read] = await replies("infinite-scroll.html", [{ op: "extract", args: [{ scroll: true, maxBytes: 200_000, ms: 25_000 }], timeout: 40_000 }], "?plain") as [Read];
    const found = new Set(read.value.text.match(/\bPost \d+\b/g));
    expect(found.size).toBeGreaterThanOrEqual(294);
    expect(read.value.harvested).toContain(`${found.size} items`);
  }, 60_000);

  test("scroll begun before the page draws its feed gathers the feed, not the links drawn first", async () => {
    const [read] = await replies("infinite-scroll.html", [{ op: "extract", args: [{ scroll: true, maxBytes: 200_000, ms: 25_000 }], timeout: 40_000 }], "?late=2000") as [Read];
    const found = new Set(read.value.text.match(/\bPost \d+\b/g));
    expect(found.size).toBeGreaterThanOrEqual(294);
    expect(read.value.harvested).toContain(`${found.size} items`);
  }, 60_000);

  test("a scroll its page slows answers within its time, with what it gathered", async () => {
    // Each scroll keeps the page busy 3 s, as a heavy page does in a loaded
    // tab: a step begun just before the time ran out would answer past it.
    // On 10-30 an X profile's scroll answered past the 40 s extract waited
    // and lost all it had gathered.
    const [read] = await replies("infinite-scroll.html", [{ op: "extract", args: [{ scroll: true, maxBytes: 200_000, ms: 4000 }], timeout: 5000 }], "?slow=3000") as [Read];
    const found = new Set(read.value.text.match(/\bPost \d+\b/g));
    expect(found.size).toBeGreaterThanOrEqual(20);
    expect(read.value.harvested).toContain(`${found.size} items, stopped: out of time, and extract again goes on from here`);
  }, 60_000);

  test("a gatherStop ends a gather running in the page", async () => {
    // Each load takes 600 ms, so the stop comes a click or two in. The page
    // runs on WebKit's own clock, which no fake reaches: left alone, the
    // gather has all 300 about 3 s in, so the count 4 s on shows whether it
    // stopped.
    const [, stop, count] = await replies("load-more.html", [
      { op: "extract", args: [{ expand: true, maxBytes: 200_000, ms: 25_000 }], timeout: 1000 },
      { op: "gatherStop" },
      { pageEval: "const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, 4000); await promise; return document.querySelectorAll('.comment').length;" },
    ], "?delay=600") as [unknown, { value: unknown }, { value: number }];
    expect(stop.value).toEqual({ ok: true });
    expect(count.value).toBeGreaterThan(30);
    expect(count.value).toBeLessThan(300);
  }, 60_000);

  test("Show more toggles over text already on the page each count once they open", async () => {
    const [read] = await replies("toggles.html", [{ op: "extract", args: [{ expand: true, ms: 25_000 }], timeout: 40_000 }]) as [Read];
    expect(read.value.harvested).toContain("expanded 6 times");
    expect(read.value.harvested).toContain("stopped: none left");
  }, 60_000);

  test("the repl's harvest returns each member of a virtualized list once", async () => {
    const [list] = await replies("virtual-list.html", [{ op: "harvest", args: [{ ms: 25_000 }], timeout: 40_000 }]) as [{ value: { items: { text: string }[] } }];
    const names = list.value.items.map((item) => /^Member \d+/.exec(item.text)?.[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(980);
  }, 60_000);

  test("a long article read whole is not flagged incomplete", async () => {
    const [read] = await replies("long-article.html", [{ op: "extract", args: [{ maxBytes: 200_000 }] }]) as [Read];
    expect(read.value.text).toContain("Paragraph 80.");
    expect(read.value.incomplete).toBeUndefined();
  }, 30_000);
});
