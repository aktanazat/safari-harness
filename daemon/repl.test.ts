import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { ReplSession } from "./repl.ts";
import { callTool } from "./tools.ts";

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

// 10-02: an emailed code typed from a script waited 30 s for a text
// message, its source dropped; and a day picker's option 15 was clicked as
// ref 15, the page's language menu.
test("locator.type passes where its {{code}} comes from to the type tool", async () => {
  const { repl, calls } = session();
  await repl.run("await openTab('https://example.com')\nawait page.locator('10').type('{{code}}', { secret: 'page', from: 9 })");
  expect(calls.filter(([tool]) => tool === "type")).toEqual([["type", { tab: 7, ref: "10", text: "{{code}}", append: true, secret: "page", from: 9 }]]);
});

test("a getByRole name of digits names that text, not the ref of that number", async () => {
  const { repl, calls } = session();
  await repl.run("await openTab('https://example.com')\nawait page.getByRole('option', { name: '15' }).click()");
  expect(calls.filter(([tool]) => tool === "click")).toEqual([["click", { tab: 7, ref: "text=15" }]]);
});

// The guide gives page.extract(selector), and a selector passed so was
// dropped: the whole page came back as if it were the part asked for.
test("page.extract reads only the part its selector names", async () => {
  const { repl, calls } = session();
  await repl.run("await openTab('https://example.com')\nawait page.extract('h1')");
  expect(calls.filter(([tool]) => tool === "extract")).toEqual([["extract", { tab: 7, selector: "h1" }]]);
});

afterEach(() => jest.useRealTimers());

// On 09-30 scripts slept 161 s in 46 page.waitForTimeout calls, where the
// wait tool's hint to wait on the page never reached them. Here the waits
// run in the daemon's tools, over a page that never goes quiet, so each
// holds all of its ms; the agent's own wait tool calls count too.
test("page.waitForTimeout counts toward the agent's sleep budget, and past it the script's output carries the wait tool's hint", async () => {
  jest.useFakeTimers();
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      if (op === "relay" && args[1] === "wait") jest.advanceTimersByTime(30_000);
      queueMicrotask(() => bridge.handleMessage(JSON.stringify(op === "relay" ? { id, value: { found: true } } : { id, error: `no ${op} here` })));
    },
    close() {},
  });
  const owner = 109;
  const invoke = async (tool: string, args: Record<string, unknown>, model?: boolean): Promise<unknown> => {
    if (tool === "open") return { id: 7, url: String(args.url), title: "Example" };
    if (tool === "tabs") return [{ id: 7, url: "https://example.com/", title: "Example" }];
    if (tool === "wait") return runAs(owner, () => callTool(tool, args, model));
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  expect(await runAs(owner, () => callTool("wait", { tab: 7, ms: 30_000 }, true))).not.toHaveProperty("hint");
  expect(await repl.run("await openTab('https://example.com')\nawait page.waitForTimeout(30_000)")).toEqual({ output: "" });
  expect((await repl.run("await page.waitForTimeout(30_000)")).output).toMatch(/^hint: you slept 90 s\b.*\bwait with text or selector\b/);
});

// On 09-30 (01a0f14c) waitForURL('**/apply/frm?<id>') ran out its 30 s on
// that very address: the glob was read as text the url must contain.
test.each([
  ["** crosses slashes", "**/apply/frm?ebbbc633-1226", true],
  ["* stops at a slash", "*/apply/frm?ebbbc633-1226", false],
  ["the glob covers the whole url", "**/apply/frm", false],
  ["{} gives choices and * the rest of a part", "https://apply.example.edu/apply/{form,frm}?*", true],
  ["text without a wildcard is still enough when the url contains it", "/apply/frm?ebbbc633", true],
])("page.waitForURL with a string: %s", async (_, pattern, met) => {
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === "open") return { id: 7, url: String(args.url), title: "Awards and Honors" };
    if (tool === "info") return { url: "https://apply.example.edu/apply/frm?ebbbc633-1226", title: "Awards and Honors", ready: "complete" };
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  const r = await repl.run(`await openTab('https://apply.example.edu/apply/frm?ebbbc633-1226')\nawait page.waitForURL(${JSON.stringify(pattern)}, { timeout: 300 })`);
  expect(r.error ?? "").toMatch(met ? /^$/ : /did not match/);
});

// On 09-30 (01a0f14c) a named session attached a tab its agent had opened:
// the tab list, which cuts a tab not the caller's to origin and path, gave
// page.url() without the query the page's own info carried.
test("attachBrowserTab starts page.url() at the tab's full address, query included", async () => {
  const invoke = async (tool: string): Promise<unknown> => {
    if (tool === "tabs") return [{ id: 7, url: "https://apply.example.edu/apply/frm", title: "Awards" }];
    if (tool === "info") return { url: "https://apply.example.edu/apply/frm?ebbbc633-1226", title: "Awards and Honors", ready: "complete" };
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  expect(await repl.run("const p = await attachBrowserTab(7)\np.url()")).toEqual({ output: "https://apply.example.edu/apply/frm?ebbbc633-1226" });
});

// On 10-01 and 10-02 three scripts failed with a bare "BuildMessage:
// Unterminated string literal": in each, a \n in a quoted string had become
// a line break.
test("a script with a string left open fails naming the line it is on", async () => {
  const { repl } = session();
  const r = await repl.run("const a = 1\nconst s = 'one\ntwo'");
  expect(r.error).toStartWith("SyntaxError: Unterminated string literal (line 2, column 11): const s = 'one\n");
});
