import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as phone from "../daemon/phone.ts";
import * as daemonRpc from "../daemon/rpc.ts";
import { history, runWatch } from "../daemon/watch.ts";
import { runner } from "./bench.ts";

// A price watch with --selector reads the element's text in the page, past
// a sale's crossed-out "was" price. The daemon's eval runs here in real
// WebKit with the shipping content.js, on a page of common price layouts.
const page = pathToFileURL(join(import.meta.dir, "fixtures", "watch-price.html")).href;

async function evalInPage(expression: unknown): Promise<unknown> {
  const proc = Bun.spawn([runner, join(import.meta.dir, "..", "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(`${JSON.stringify({ load: page, frames: 0 })}\n${JSON.stringify({ op: "eval", args: [expression] })}\n`);
  proc.stdin.end();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`the bench exited ${code}: ${err.trim()}`);
  const [, answer] = out.trim().split("\n").map((l) => JSON.parse(l) as { value?: unknown });
  return answer.value;
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "safari-watch-price-"));
  spyOn(phone, "dataFile").mockImplementation((name) => join(dir, name));
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => {
    if (tool === "open") return { id: 9, url: args.url };
    if (tool === "close") return undefined;
    if (tool === "wait") return { ok: true, found: true };
    if (tool === "eval") return evalInPage(args.expression);
    throw new Error(`the page has no ${tool}`);
  });
});
afterEach(() => {
  mock.restore();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!runner)("a price watch's read in real WebKit", () => {
  test.each([
    ["a span with a line through it", ".struck", "$79.99"],
    ["del", ".del", "$64.50"],
    ["s, beside a hidden price", ".s-hidden", "$1,299.00"],
    ["del whose line is drawn by its own rule", ".del-restyled", "$74.00"],
    ["a price split across spans", ".split", "$79.49"],
    ["cents in sup", ".sup", "$1,299.99"],
  ])("takes the price, not the crossed-out one, from %s", async (_layout, selector, price) => {
    await runWatch("item", { url: "https://shop.example/item", how: "selector", what: selector, kind: "price" });
    expect(history("item", "price").map((r) => r.price)).toEqual([price]);
  }, 20_000);
});
