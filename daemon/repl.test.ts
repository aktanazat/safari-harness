import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplSession } from "./repl.ts";

const BLOCKED = "this page's security policy blocks eval; use snapshot, extract, or data";
const WEBKIT = "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\".";

// A session over a stand-in Safari with one tab, 7, on a page whose policy
// refuses code in its own world; the extension's world runs it. calls holds
// every tool call the session made.
function session(refusal: "thrown" | "returned" = "thrown") {
  const calls: [string, Record<string, unknown>][] = [];
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push([tool, args]);
    if (tool === "open") return { id: 7, url: String(args.url), title: "Example" };
    if (tool === "tabs") return [{ id: 7, url: "https://example.com/", title: "Example" }];
    if (tool === "eval" && args.page && refusal === "thrown") throw new Error(BLOCKED);
    if (tool === "eval" && args.page) return { error: WEBKIT };
    if (tool === "eval") return { result: "extension" };
    return { ok: true };
  };
  return { repl: new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke }), calls };
}

test.each([
  ["after a top-level await", "const t = await Promise.resolve(2)\nreturn t * 21"],
  ["with no await", "const t = 6\nreturn t * 7"],
])("a script's top-level return prints its value, %s", async (_, code) => {
  expect(await session().repl.run(code)).toEqual({ output: "42" });
});

test.each(["thrown", "returned"] as const)("page.evaluate on a page whose policy refuses eval answers from the extension's world (refusal %s)", async (refusal) => {
  const { repl } = session(refusal);
  expect(await repl.run("await openTab('https://example.com')\nawait page.evaluate(() => document.title)")).toEqual({ output: "extension" });
});

test("page.fill types the text into the target it names", async () => {
  const { repl, calls } = session();
  expect(await repl.run("await openTab('https://example.com')\nawait page.fill('#email', 'a@b.c')")).toEqual({ output: "" });
  expect(calls.filter(([tool]) => tool === "type")).toEqual([["type", { tab: 7, ref: "#email", text: "a@b.c" }]]);
});

// The guide gives page.extract(selector), and a selector passed so was
// dropped: the whole page came back as if it were the part asked for.
test("page.extract reads only the part its selector names", async () => {
  const { repl, calls } = session();
  await repl.run("await openTab('https://example.com')\nawait page.extract('h1')");
  expect(calls.filter(([tool]) => tool === "extract")).toEqual([["extract", { tab: 7, selector: "h1" }]]);
});
