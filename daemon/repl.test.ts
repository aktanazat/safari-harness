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

// A script's actions dropped the next step their answers carried (what to
// try when the page ignored or refused a click), so on 10-02 an agent
// scripting TikTok's sign-up saw none of it.
test("a script's action that came back with a next step prints it as a hint, once", async () => {
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === "open") return { id: 7, url: String(args.url), title: "Sign up" };
    if (tool === "click") return { ok: true, effect: { added: 1 }, next: "do this step once with real_input" };
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  expect(await repl.run("await openTab('https://example.com')\nawait page.click('#next')\nawait page.click('#next')")).toEqual({ output: "hint: do this step once with real_input" });
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

// Addresses of an AWS event sign-up on 10-05: the event's link went to
// Cvent's sign-on, which sent the tab on to AWS's sign-in; after it came
// Cvent's form, whose Submit moved the page within its document to the
// confirmation.
const EVENT = "https://events.builder.aws.com/YxNrnq";
const SIGN_ON = "https://login.app.cvent.com/en-US/sign-on?transferId=1cb7926e";
const SIGN_IN = "https://us-east-1.signin.aws/platform/d-9067642ac7/login?workflowStateHandle=4203ba48";
const REGISTER = "https://events.builder.aws.com/event/74dc7afc/register?eventId=74dc7afc";
const CONFIRMED = "https://events.builder.aws.com/event/74dc7afc/confirmation?eventId=74dc7afc";

// A session whose tools answer as answers gives; open answers with the
// address asked for, and any other tool with { ok: true }.
function answering(answers: Record<string, unknown>) {
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool in answers) return answers[tool];
    if (tool === "open") return { id: 7, url: String(args.url), title: "AWS Builder Loft" };
    return { ok: true };
  };
  return new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
}

test.each([
  ["it loaded another page", SIGN_ON, "await page.click('Continue')", { click: { ok: true, navigated: { url: SIGN_IN, title: "Amazon Web Services" } } }, SIGN_IN],
  ["it moved the page within its document", REGISTER, "await page.click('Submit')", { click: { ok: true, effect: { url: CONFIRMED, changed: 3 } } }, CONFIRMED],
  ["a script it ran in the page loaded another page", SIGN_ON, "await page.evaluate(() => document.forms[0].submit())", { eval: { result: null, navigated: { url: SIGN_IN, title: "Amazon Web Services" } } }, SIGN_IN],
])("page.url() is the address an action's answer says the page went to: %s", async (_, start, step, answers, address) => {
  expect(await answering(answers).run(`await openTab(${JSON.stringify(start)})\n${step}\npage.url()`)).toEqual({ output: address });
});

// On 10-05 goto answered with Cvent's sign-on, the first page it loaded,
// and the page went on to AWS's sign-in.
test.each([
  ["a snapshot of the page", "await snapshot(page)", { snapshot: { url: SIGN_IN, title: "Amazon Web Services", snapshot: "", truncated: false } }],
  ["an extract of the page", "await page.extract()", { extract: { url: SIGN_IN, title: "Amazon Web Services", text: "" } }],
  ["a waitForSelector that missed", "await page.waitForSelector('#email', { timeout: 100 }).catch(() => {})", { wait: { ok: true, found: false, waitedMs: 100, url: SIGN_IN, title: "Amazon Web Services" } }],
])("after a goto, page.url() is the address %s gave", async (_, step, answers) => {
  const repl = answering({ goto: { url: SIGN_ON, title: "Login" }, ...answers });
  expect(await repl.run(`await openTab(${JSON.stringify(EVENT)})\nawait page.goto(${JSON.stringify(EVENT)})\n${step}\npage.url()`)).toEqual({ output: SIGN_IN });
});

// On 10-05 three scripts printed page.url() after page.waitForTimeout and
// got where the page had been: Cvent's sign-on after a goto, AWS's sign-in
// after its Continue, and the form after its Submit, while a snapshot
// right after showed AWS's sign-in, the form, and the confirmation. A
// wait's answer says nothing of where the tab is.
test.each([
  ["page.waitForTimeout", "await page.waitForTimeout(10_000)"],
  ["page.waitForSelector", "await page.waitForSelector('h1')"],
  ["locator.waitFor", "await page.locator('h1').waitFor()"],
])("after %s, page.url() is where the page is, though the wait's answer gave no address", async (_, wait) => {
  const repl = answering({
    wait: { ok: true, found: true, waitedMs: 120 },
    element: true,
    info: { url: CONFIRMED, title: "Confirmation - Multimodal Agent Workflows", ready: "complete" },
  });
  expect(await repl.run(`await openTab(${JSON.stringify(REGISTER)})\n${wait}\npage.url()`)).toEqual({ output: CONFIRMED });
});

// On 10-01 and 10-02 three scripts failed with a bare "BuildMessage:
// Unterminated string literal": in each, a \n in a quoted string had become
// a line break.
test("a script with a string left open fails naming the line it is on", async () => {
  const { repl } = session();
  const r = await repl.run("const a = 1\nconst s = 'one\ntwo'");
  expect(r.error).toStartWith("SyntaxError: Unterminated string literal (line 2, column 11): const s = 'one\n");
});
