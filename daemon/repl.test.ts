import { afterEach, expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { ReplSession } from "./repl.ts";
import { callTool } from "./tools.ts";
import { BrowserMemory } from "./browser-memory.ts";

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
    if (tool === "tabs") return { tabs: [{ id: 7, url: "https://example.com/", title: "Example" }] };
    if (tool === "eval" && args.page && refusal === "thrown") throw new Error(BLOCKED);
    if (tool === "eval" && args.page) return { error: WEBKIT };
    if (tool === "eval") return { result: "extension" };
    if (tool === "snapshot") return { url: "https://example.com", title: "Example", snapshot: 'heading "Example"', truncated: false };
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

// On 10-16 `const page = await openTab(url)` failed with "undefined is not
// an object (evaluating 'page.evaluate')": the transpiler hoists the
// declaration to `var page`, which read undefined over a global accessor.
test.each(["const", "let", "var"])("a script that declares page with %s over openTab's page uses it, and the next script still has it", async (decl) => {
  const { repl } = session();
  expect(await repl.run(`${decl} page = await openTab('https://example.com')\nawait page.evaluate(() => document.title)`)).toEqual({ output: "extension" });
  expect(await repl.run("page.url()")).toEqual({ output: "https://example.com/" });
});

// x is the X site global, and `const x = ...` read undefined the same way.
test("a script that declares a site global's name has its own value, in that script and the next", async () => {
  const { repl } = session();
  expect(await repl.run("const x = 5\nx")).toEqual({ output: "5" });
  expect(await repl.run("x * 2")).toEqual({ output: "10" });
});

// On 10-19 a paginated fetch began `let cursor;` and started from the cursor
// the previous call left, mid-list: the transpiler hoists the declaration to
// `var cursor`, and a var declared again keeps its value.
test.each(["let", "var"])("a script that declares a name with %s and no value starts it undefined, whatever an earlier script left in it", async (decl) => {
  const { repl } = session();
  await repl.run(`${decl} x = 5`);
  expect(await repl.run(`${decl} x; x`)).toEqual({ output: "" });
});


const saved: string[] = [];
afterEach(() => {
  for (const path of saved.splice(0)) rmSync(path, { force: true });
});

// On 10-14 two runs reading a site's bundle printed 30 KB of minified source.
test("a run's output past 10 000 characters is saved whole, and the result keeps its head and the file's path", async () => {
  const r = await session().repl.run("console.log('a'.repeat(6_000))\nconsole.log('b'.repeat(6_000))");
  const path = /the whole output is in (\S+): grep it/.exec(r.output)?.[1];
  if (path) saved.push(path);
  expect(r.output).toStartWith(`${"a".repeat(2_000)}\n…cut at 2000 of 12001 characters`);
  expect(readFileSync(String(path), "utf8")).toBe(`${"a".repeat(6_000)}\n${"b".repeat(6_000)}`);
});

// On 10-22 a failed script's answer began with a page's whole snapshot,
// its error at the end.
test("a failed run's output past 8 lines is cut to them, the whole saved", async () => {
  const r = await session().repl.run("for (let i = 0; i < 20; i++) console.log(`line ${i}`)\nthrow new Error('boom')");
  const path = /the whole is in (\S+)$/.exec(r.output)?.[1];
  if (path) saved.push(path);
  expect(r.output.split("\n").slice(0, 9)).toEqual([...Array.from({ length: 8 }, (_, i) => `line ${i}`), `…12 more lines of output before the error; the whole is in ${path}`]);
  expect(readFileSync(String(path), "utf8").split("\n")).toHaveLength(20);
  expect(r.error).toStartWith("Error: boom");
});

// On 10-22 getTab(745000) failed "getTab is not defined", and
// researchFinalTab.snapshot() "is not a function".
test.each([
  ["a global", "getTab(745000)", "hint: did you mean getTabs?"],
  ["a page's method", "await openTab('https://example.com')\nawait page.screenshoot()", "hint: did you mean page.screenshot()?"],
  ["a page's method on what is not a page", "const row = { id: 7 }\nawait row.snapshot()", "hint: row is not a page; openTab(url) or attachBrowserTab(id) gives one, with snapshot()"],
])("a name a script got wrong, %s, gets its nearest", async (_, code, hint) => {
  expect((await session().repl.run(code)).error).toEndWith(hint);
});

test("page.snapshot reads the page as snapshot(page) does", async () => {
  const { repl } = session();
  expect(await repl.run("await openTab('https://example.com')\nconst snap = await page.snapshot()\nsnap.tree")).toEqual({ output: "title: Example\nurl: https://example.com\nheading \"Example\"" });
});

test("page.fill types the text into the target it names", async () => {
  const { repl, calls } = session();
  await repl.run("await openTab('https://example.com')\nawait page.fill('#email', 'a@b.c')");
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


// Repeated sleep guidance must not turn one result into many hint lines.
test("a script with repeated sleep guidance prints one hint line", async () => {
  jest.useFakeTimers();
  // A page that never goes quiet, on a Safari slow to answer: its waits
  // hold 30 s, then 40 s, then 70 s.
  const holds = [30_000, 40_000, 70_000];
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      if (op === "relay" && args[1] === "wait") jest.advanceTimersByTime(holds.shift() ?? 30_000);
      queueMicrotask(() => bridge.handleMessage(JSON.stringify(op === "relay" ? { id, value: { found: true } } : { id, error: `no ${op} here` })));
    },
    close() {},
  });
  const owner = 110;
  const invoke = async (tool: string, args: Record<string, unknown>, model?: boolean): Promise<unknown> => {
    if (tool === "open") return { id: 7, url: String(args.url), title: "Example" };
    if (tool === "wait") return runAs(owner, () => callTool(tool, args, model));
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  await runAs(owner, () => callTool("wait", { tab: 7, ms: 30_000 }, true));
  const result = await repl.run("await openTab('https://example.com')\nfor (let i = 0; i < 2; i++) await page.waitForTimeout(30_000)");
  expect(result.output.split("\n").filter((line) => line.trim().length > 0)).toEqual([expect.stringMatching(/^hint: \S/)]);
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
    if (tool === "tabs") return { tabs: [{ id: 7, url: "https://apply.example.edu/apply/frm", title: "Awards" }] };
    if (tool === "info") return { url: "https://apply.example.edu/apply/frm?ebbbc633-1226", title: "Awards and Honors", ready: "complete" };
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  expect(await repl.run("const p = await attachBrowserTab(7)\np.url()")).toEqual({ output: "https://apply.example.edu/apply/frm?ebbbc633-1226" });
});

// On 10-05 a page attached from the user's tab began each later script at
// the tab list's cut address, its query gone.
test("a page attached from a tab this session did not open keeps its full address in the next script", async () => {
  const invoke = async (tool: string): Promise<unknown> => {
    if (tool === "tabs") return { tabs: [{ id: 7, url: "https://apply.example.edu/apply/frm", title: "Awards" }] };
    if (tool === "info") return { url: "https://apply.example.edu/apply/frm?ebbbc633-1226", title: "Awards and Honors", ready: "complete" };
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  await repl.run("await attachBrowserTab(7)");
  expect(await repl.run("page.url()")).toEqual({ output: "https://apply.example.edu/apply/frm?ebbbc633-1226" });
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
  ["page.waitForChange", "await page.waitForChange()"],
])("after %s, page.url() is where the page is, though the wait's answer gave no address", async (_, wait) => {
  const repl = answering({
    wait: { ok: true, found: true, waitedMs: 120 },
    element: true,
    info: { url: CONFIRMED, title: "Confirmation - Multimodal Agent Workflows", ready: "complete" },
  });
  expect(await repl.run(`await openTab(${JSON.stringify(REGISTER)})\n${wait}\npage.url()`)).toEqual({ output: CONFIRMED });
});


// On 10-16, with Safari slow after a deploy, a wait on example.com, which
// showed its words all along, read as a miss.
test("a waitForSelector the page gave no answer says whether it appeared is unknown, not that it did not appear", async () => {
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === "open") return { id: 7, url: String(args.url), title: "Example" };
    if (tool === "wait") return { ok: false, found: false, unanswered: true, waitedMs: 2000 };
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  const { error } = await repl.run("await openTab('https://example.com')\nawait page.waitForSelector('h1', { timeout: 1000 })");
  expect(error).toContain("the page gave no answer in time (Safari or the page is slow), so whether h1 appeared within 1 s is unknown; wait for it again");
});

// A script after a click or a scroll can rarely name the text to come, so
// it slept: in the two weeks of logs before 10-19, 1,935 s past the sleep
// budget in 19 sessions, whose hint said to wait on text or a selector.
test("page.waitForChange waits for lines the page did not have, as wait's changed does, and returns them", async () => {
  const asked: Record<string, unknown>[] = [];
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === "open") return { id: 7, url: String(args.url), title: "Example" };
    if (tool === "tabs") return { tabs: [{ id: 7, url: "https://example.com/", title: "Example" }] };
    if (tool !== "wait") return { ok: true };
    asked.push(args);
    return args.ms === 1000 ? { ok: false, found: false, waitedMs: 1000 } : { ok: true, found: true, waitedMs: 400, added: ["Result one", "Result two"] };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  expect(await repl.run("await openTab('https://example.com')\nawait page.click('More')\nconst lines = await page.waitForChange()\nlines.join(' | ')")).toEqual({ output: "Result one | Result two" });
  expect((await repl.run("await page.waitForChange({ timeout: 1000 })")).error).toContain("nothing new appeared within 1 s");
  expect(asked).toEqual([{ tab: 7, changed: true, ms: 10_000 }, { tab: 7, changed: true, ms: 1000 }]);
});

// In the two weeks of logs before 10-19, three scripts took a locator's nth
// match and one its last, which locators lacked. The page counts matches
// (matchesOf in content.js), so each locator names its place in its target.
test("a locator's nth, last, and all name each match by its place, and allTextContents reads every match in one call", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push([tool, args]);
    if (tool === "open") return { id: 7, url: String(args.url), title: "Booking" };
    if (tool === "element" && args.what === "count") return 3;
    if (tool === "element" && args.what === "texts") return ["9 am", "Noon", "5 pm"];
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  const script = [
    "await openTab('https://example.com')",
    "const slots = page.locator('input[type=radio]')",
    "await slots.nth(2).click()",
    "await slots.last().click()",
    "const all = await slots.all()",
    "const texts = await slots.allTextContents()",
    "all.map((s) => s.target).join(', ') + ': ' + texts.join(', ')",
  ];
  expect(await repl.run(script.join("\n"))).toEqual({ output: "input[type=radio] >> nth=0, input[type=radio] >> nth=1, input[type=radio] >> nth=2: 9 am, Noon, 5 pm" });
  expect(calls.filter(([tool]) => tool === "click")).toEqual([
    ["click", { tab: 7, ref: "input[type=radio] >> nth=2" }],
    ["click", { tab: 7, ref: "input[type=radio] >> nth=-1" }],
  ]);
  expect(calls.filter(([tool]) => tool === "element").map(([, a]) => a.what)).toEqual(["count", "texts"]);
});

// On 10-05 a script waited with page.waitForFunction for a button to show.
test("page.waitForFunction runs the function in the page until it returns something truthy, and returns that", async () => {
  let looks = 0;
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === "open") return { id: 7, url: String(args.url), title: "Tires" };
    if (tool === "tabs") return { tabs: [{ id: 7, url: "https://example.com/", title: "Tires" }] };
    if (tool === "eval") return { result: ++looks < 3 ? false : args.expression };
    return { ok: true };
  };
  const repl = new ReplSession("test", { cwd: mkdtempSync(join(tmpdir(), "repl-test-")), invoke });
  await repl.run("await openTab('https://example.com')\nawait page.waitForFunction((label) => document.body.innerText.includes(label), 'See price')");
  expect(looks).toBe(3);
  looks = -1e9;
  expect((await repl.run("await page.waitForFunction(() => false, undefined, { timeout: 1000 })")).error).toContain("the function returned nothing truthy within 1 s");
});

// 5 of the 8 "Bun is not defined" in the two weeks of logs before 10-19 came
// from Bun.write, which scripts reach for to save a page's text.
test("Bun.write writes a file, its relative path from the session's folder as fs's are, and returns the bytes written", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "repl-test-"));
  const repl = new ReplSession("test", { cwd, invoke: async () => ({ ok: true }) });
  expect(await repl.run("await Bun.write('notes/today.md', 'héllo')")).toEqual({ output: "6" });
  expect(readFileSync(join(cwd, "notes", "today.md"), "utf8")).toBe("héllo");
});

// 10-22: a script that saved its results with Bun.write had no way to read
// them back in its next run; Bun.file was not defined.
test("Bun.file reads a file by its path from the session's folder, as text or JSON, and says whether one exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "repl-test-"));
  mkdirSync(join(cwd, "data"));
  writeFileSync(join(cwd, "data", "people.json"), '{"found":7}');
  const repl = new ReplSession("test", { cwd, invoke: async () => ({ ok: true }) });
  expect(await repl.run("(await Bun.file('data/people.json').json()).found")).toEqual({ output: "7" });
  expect(await repl.run("(await Bun.file('data/people.json').text()).length")).toEqual({ output: "11" });
  expect(await repl.run("await Bun.file('data/missing.json').exists()")).toEqual({ output: "false" });
});

test("imessage.search passes the chat it keeps to the search tool", async () => {
  const { repl, calls } = session();
  await repl.run("await imessage.search('lunch', { chat: 'Mom' })");
  expect(calls.filter(([tool]) => tool === "imessage_search")).toEqual([["imessage_search", { text: "lunch", chat: "Mom" }]]);
});

test("a REPL snapshot preserves its read receipt so the same caller can save after closing the source tab", async () => {
  const directory = mkdtempSync(join(tmpdir(), "repl-research-"));
  const memory = new BrowserMemory({ directory: join(directory, "memory") });
  memory.configure({ researchEnabled: true });
  const source = { url: "https://example.com/research", title: "Public report", body: "The public report describes lithium battery recycling.", partial: true };
  const receipt = memory.holdResearch(source, 123);
  if (!receipt) throw new Error("expected a held source read");
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === "open") return { id: 7, url: source.url, title: source.title };
    if (tool === "snapshot") return { ...source, snapshot: '- text "The public report describes lithium battery recycling."', memoryReceipt: receipt };
    if (tool === "save_source") return { page: memory.saveResearch(String(args.receipt), 123, String(args.reason)) };
    return { ok: true };
  };
  const repl = new ReplSession("research", { cwd: directory, invoke });
  try {
    const result = await repl.run("const sourceTab=await openTab('https://example.com/research'); const read=await snapshot(sourceTab); await closeTab(sourceTab); await saveSource(read.memoryReceipt.id,'Used the public report.');");
    expect(result.error).toBeUndefined();
    expect(memory.list().pages).toMatchObject([{ observation: "agent_research", url: source.url, partial: true, scope: "public" }]);
  } finally {
    await repl.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
