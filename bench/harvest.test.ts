import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runner } from "./bench.ts";

// content.js's extract in real WebKit, sent as background.js sends it, on
// pages whose lists hold a known number of items: a plain read must say
// it left some, and expand or scroll must bring back nearly all of them.
const address = (page: string) => pathToFileURL(join(import.meta.dir, "fixtures", page)).href;

async function replies(page: string, steps: Record<string, unknown>[]): Promise<unknown[]> {
  const requests = [{ load: address(page), frames: 0 }, ...steps];
  const proc = Bun.spawn([runner, join(import.meta.dir, "..", "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(requests.map((request) => JSON.stringify(request) + "\n").join(""));
  proc.stdin.end();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`the WebKit bench exited ${code}: ${err.trim()}`);
  const [loaded, ...answers] = out.trim().split("\n").map((line) => JSON.parse(line) as unknown);
  expect(loaded).toMatchObject({ url: address(page) });
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
      { op: "extract", args: [{ [option]: true, maxBytes: 200_000 }], timeout: 40_000 },
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

  test("the repl's harvest returns each member of a virtualized list once", async () => {
    const [list] = await replies("virtual-list.html", [{ op: "harvest", args: [{}], timeout: 40_000 }]) as [{ value: { items: { text: string }[] } }];
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
