import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { invoke } from "./call.ts";
import { queuePopup } from "./continuity.ts";
import { connect } from "./fake-safari.ts";
import * as front from "./front.ts";
import { INPUT_TOOLS } from "./input.ts";
import { runAs } from "./owner.ts";
import * as daemonRpc from "./rpc.ts";
import * as spaces from "./spaces.ts";
import { callTool } from "./tools.ts";

// real_input clicks a tab that is not in front by pressing the element
// through Safari's accessibility tree, and nothing comes forward. Where a
// press cannot serve, the tab comes to the front and the real mouse clicks.
// The caller's RPC calls go straight to the daemon's tools; Safari, the
// page, and the helper are fakes.

const GHOSTTY = "com.mitchellh.ghostty";

// Safari's answer to press_mark, the errors the page threw by press_done,
// the helper's answer to press, the page area of Safari's front window,
// what the page did on each scripted click, in order (withReceipt in
// extension/content.js; nothing by default), and the tab it opens on a real
// click, which the daemon queues for the agent (continuity.ts).
type Page = { picker?: boolean; press?: { pressed: boolean; why?: string }; errors?: string[]; area?: { x: number; y: number; width: number; height: number }; clicked?: Record<string, unknown>[]; popup?: { tab: number; url: string } };
type Mac = {
  app: string;
  // helper commands, and what Safari was asked of its tabs and pages, in order
  helper: string[][];
  typed: (string | undefined)[];
  asked: string[];
  // the tab agent window 2 showed when the helper pressed
  pressedIn?: number;
  shows(windowId: number): number | undefined;
};

// Ghostty is in front. The user's window 1, Safari's front window, shows his
// tab 3, with his tab 4 behind it. Agent window 2 shows its own page, tab
// 20, with the agent's tab 21 behind it, on a subdomain of court.example.
// Showing a tab sets it active in its window; activating one also makes its
// window Safari's front window.
function mac(page: Page = {}): Mac {
  const tabs = [
    { id: 3, windowId: 1, active: true, url: "https://example.com/" },
    { id: 4, windowId: 1, active: false, url: "https://example.com/" },
    { id: 20, windowId: 2, active: true, url: "https://other.example/" },
    { id: 21, windowId: 2, active: false, url: "https://portal.court.example/case" },
  ];
  let frontWindow = 1;
  let marks = 0;
  const show = (id: number) => {
    const windowId = tabs.find((t) => t.id === id)!.windowId;
    for (const t of tabs) if (t.windowId === windowId) t.active = t.id === id;
    return windowId;
  };
  const m: Mac = { app: GHOSTTY, helper: [], typed: [], asked: [], shows: (windowId) => tabs.find((t) => t.windowId === windowId && t.active)?.id };
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      const answer = (value: unknown) => queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
      if (op === "tabs.list") return answer(tabs.map((t) => ({ ...t, ...(t.windowId === 1 && t.active ? { front: true } : {}), ...(t.windowId === frontWindow && t.active ? { shown: true } : {}) })));
      m.asked.push(`${op === "relay" ? args[1] : op} ${args[0]}`);
      if (op === "tabs.select") return (show(args[0]), answer({ ok: true }));
      if (op === "tabs.activate") return ((frontWindow = show(args[0])), answer({ ok: true }));
      const dom = op === "relay" ? args[1] : undefined;
      if (dom === "pressMark") return answer(page.picker ? { picker: true } : { mark: "__sh_press_t", width: 1247, height: 870 });
      if (dom === "pressDone") return answer(page.errors ?? []);
      if (dom === "locate") return answer({ x: 100, y: 50, width: 80, height: 20, innerWidth: 1200, innerHeight: 800 });
      if (dom === "tabInfo") return answer({ url: "https://example.com/", title: "Page", viewport: { w: 1200, h: 800 } });
      if (dom === "eval") return answer({ result: { marks, focus: true } });
      if (dom === "click") return answer({ ok: true, receipt: { ...QUIET, ...page.clicked?.shift() } });
      if (dom === "type") return answer({ ok: true, kept: true });
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, error: `no ${op} here` })));
    },
    close() {},
  });
  spyOn(front, "input").mockImplementation(async (args, _timeout, stdin) => {
    m.helper.push(args);
    if (args[0] === "type") m.typed.push(stdin);
    if (args[0] === "front") return { bundleId: m.app };
    if (args[0] === "activate") m.app = args[1];
    if (args[0] === "press") {
      m.pressedIn = m.shows(2);
      return page.press ?? { pressed: true };
    }
    if (args[0] === "webarea") return page.area ?? { x: 0, y: 100, width: 1200, height: 800 };
    if (args[0] === "click") {
      // the helper's closing F20, which the page counts
      marks++;
      if (page.popup) queuePopup(process.pid, page.popup);
    }
    return {};
  });
  spyOn(spaces, "windowOwners").mockImplementation(() => new Map([[2, 7]]));
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => callTool(tool, args, undefined, daemonRpc.takesNews()));
  return m;
}

// Sites marked for real input live in a notes directory of each test's own
// (notes.ts).
const notesBefore = process.env.SAFARI_HARNESS_NOTES;
let notes = "";
beforeEach(() => {
  notes = mkdtempSync(join(tmpdir(), "real-input-"));
  process.env.SAFARI_HARNESS_NOTES = notes;
});
afterEach(() => {
  mock.restore();
  rmSync(notes, { recursive: true, force: true });
});
afterAll(() => {
  if (notesBefore === undefined) delete process.env.SAFARI_HARNESS_NOTES;
  else process.env.SAFARI_HARNESS_NOTES = notesBefore;
});

// A scripted click's receipt from a page that showed nothing.
const QUIET = { added: 0, removed: 0, changed: 0, url: null, focus: null, states: [], dialog: null, page: "https://other.example/", requests: [], pending: [], errors: [] };

const click = (tab: number, more: Record<string, unknown> = {}) => INPUT_TOOLS.real_input.run({ tab, do: "click", ref: "#go", ...more });
const mark = (site: string, real: boolean) => runAs(process.pid, () => callTool("learn", { site, real }));
const scripted = (m: Mac) => m.asked.filter((a) => /^(click|type) /.test(a));
const run = (m: Mac, verb: string) => m.helper.filter((c) => c[0] === verb);

test("a single click on a tab behind is pressed where it is: the answer says so, and no app or window comes forward", async () => {
  const m = mac();
  expect(await click(21)).toEqual({ ok: true, background: true });
  expect(run(m, "press")).toEqual([["press", "__sh_press_t", "1247", "870"]]);
  expect({ app: m.app, activated: run(m, "activate"), asked: m.asked.filter((a) => a.startsWith("tabs.activate")) }).toEqual({ app: GHOSTTY, activated: [], asked: [] });
});

test("a tab behind another in its agent window is shown there for the press, and the window shows its own tab again after", async () => {
  const m = mac();
  await click(21);
  expect({ pressedIn: m.pressedIn, after: m.shows(2) }).toEqual({ pressedIn: 21, after: 20 });
});

test.each([[{ pressed: true }], [{ pressed: false, why: "Safari offers no press on the element" }]])("the page gets its mark taken off, pressed or not (%j)", async (press) => {
  const m = mac({ press });
  await click(21);
  expect(m.asked.filter((a) => a.startsWith("press"))).toEqual(["pressMark 21", "pressDone 21"]);
});

test("where Safari offers no press, the tab comes to the front and the real mouse clicks", async () => {
  const m = mac({ press: { pressed: false, why: "Safari offers no press on the element" } });
  expect(await click(21)).toEqual({ ok: true, at: { x: 140, y: 160 } });
  expect(run(m, "click")).toEqual([["click", "140", "160", "--count", "1", "--button", "left"]]);
});

test("a select, a date or color input, or a file input's label takes the real mouse, with no press tried", async () => {
  const m = mac({ picker: true });
  expect(await click(21)).toEqual({ ok: true, at: { x: 140, y: 160 } });
  expect(run(m, "press")).toEqual([]);
});

test.each([[{ count: 2 }, ["--count", "2", "--button", "left"]], [{ button: "right" }, ["--count", "1", "--button", "right"]]])(
  "%j takes the real mouse, with no press tried: presses in a row are single clicks, and the right button's menu opens on screen",
  async (more, flags) => {
    const m = mac();
    expect(await click(21, more)).toEqual({ ok: true, at: { x: 140, y: 160 } });
    expect({ marked: m.asked.filter((a) => a.startsWith("pressMark")), clicks: run(m, "click") }).toEqual({ marked: [], clicks: [["click", "140", "160", ...flags]] });
  },
);

test("a tab behind another in one of the user's windows is not shown there behind his back: the real mouse clicks it", async () => {
  const m = mac();
  expect(await click(4)).toEqual({ ok: true, at: { x: 140, y: 160 } });
  expect({ selected: m.asked.filter((a) => a.startsWith("tabs.select")), pressed: run(m, "press") }).toEqual({ selected: [], pressed: [] });
});

test("the tab Safari shows while it is the app in front takes the real mouse: activate first, and a page gets pointer events", async () => {
  const m = mac();
  m.app = front.SAFARI;
  expect(await click(3)).toEqual({ ok: true, at: { x: 140, y: 160 } });
  expect(m.asked.filter((a) => a.startsWith("pressMark"))).toEqual([]);
});

test("the real mouse clicks where the tab's page is: negative points on a display above the main one, and nothing where Safari's front window shows a page of another shape", async () => {
  const page: Page = { area: { x: 29, y: -1340, width: 1200, height: 800 } };
  const m = mac(page);
  expect(await click(21, { count: 2 })).toEqual({ ok: true, at: { x: 169, y: -1280 } });
  page.area = { x: 29, y: -1340, width: 1600, height: 800 };
  await expect(click(21, { count: 2 })).rejects.toThrow();
  expect(run(m, "click")).toEqual([["click", "169", "-1280", "--count", "2", "--button", "left"]]);
});

test("x and y are a point of the tab's viewport in CSS px, as click takes them: the real mouse clicks it at the page's zoom, and a point outside the viewport gets nothing clicked", async () => {
  const m = mac({ area: { x: 0, y: 100, width: 1800, height: 1200 } });
  expect(await invoke("real_input", { tab: 21, do: "click", x: 358, y: 542 }, true)).toEqual({ ok: true, at: { x: 537, y: 913 } });
  await expect(invoke("real_input", { tab: 21, do: "click", x: 1250, y: 542 }, true)).rejects.toThrow();
  expect({ marked: m.asked.filter((a) => a.startsWith("pressMark")), clicks: run(m, "click") }).toEqual({ marked: [], clicks: [["click", "537", "913", "--count", "1", "--button", "left"]] });
});

test("a press the page refused for want of focus answers with its error and a next step: Safari in front and a real click, or the user", async () => {
  const error = "unhandled rejection: The document is not focused.";
  mac({ errors: [error] });
  const { next, ...rest } = (await click(21)) as { next?: string };
  expect({ rest, tools: ["activate", "real_input", "handoff"].filter((t) => new RegExp(`\\b${t}\\b`).test(next ?? "")) }).toEqual({
    rest: { ok: true, background: true, pageErrors: [error] },
    tools: ["activate", "real_input", "handoff"],
  });
});

test("real typing replaces the field before typing exact Unicode and newlines through stdin, not arguments; append skips Cmd+A", async () => {
  const m = mac();
  const text = " Zoë 李𐐷\ne\u0301\tline two\r\n";
  const appended = " suite\n";
  await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#name", text });
  await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#name", text: appended, append: true });
  expect(m.helper.filter((c) => ["click", "key", "type"].includes(c[0])).map((c) => (c[0] === "key" ? `key ${c[1]}` : c[0]))).toEqual(["click", "key cmd+a", "type", "click", "type"]);
  expect({ args: run(m, "type"), stdin: m.typed }).toEqual({ args: [["type"], ["type"]], stdin: [text, appended] });
});

// Exercise front.input's actual pipe into a child process, without posting
// keys to the user's Mac. The helper reports its arguments separately from
// its stdin so text exposed on the command line cannot pass this check.
test.each([" Zoë 李𐐷\ne\u0301\tline two\r\n", ""])("the native input transport keeps %j exact on stdin and out of process arguments", async (text) => {
  mkdirSync(join(notes, "daemon"));
  mkdirSync(join(notes, "scripts"));
  copyFileSync(join(import.meta.dir, "front.ts"), join(notes, "daemon", "front.ts"));
  writeFileSync(join(notes, "scripts", "input"), `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst text = await Bun.stdin.text();\nconsole.log(JSON.stringify({ args, text }));\n`, { mode: 0o700 });
  writeFileSync(join(notes, "transport.ts"), 'import { input } from "./daemon/front.ts";\nconst text = await Bun.stdin.text();\nconsole.log(JSON.stringify(await input(["type"], 1000, text)));\n');
  const proc = Bun.spawn([process.execPath, join(notes, "transport.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    proc.stdin.write(text);
    proc.stdin.end();
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out)).toEqual({ args: ["type"], text });
  } finally {
    if (proc.exitCode === null) {
      proc.kill();
      await proc.exited;
    }
  }
});

// EOIR's Submit and egov.uscis.gov's Check Status ignored scripted clicks,
// and my.uscis.gov kept no scripted text, where real input worked (09-30).
test("on a site marked for real input, a model's click on a ref is pressed for real and never scripted, on its subdomains too; the harness's own clicks, and a model's once unmarked, stay scripted", async () => {
  const m = mac();
  await mark("court.example", true);
  expect(await invoke("click", { tab: 21, ref: "#submit" }, true)).toMatchObject({ ok: true, background: true, note: expect.stringContaining("court.example") });
  expect({ pressed: run(m, "press").length, scripted: scripted(m) }).toEqual({ pressed: 1, scripted: [] });
  await invoke("click", { tab: 21, ref: "#submit" });
  await mark("court.example", false);
  await invoke("click", { tab: 21, ref: "#submit" }, true);
  expect({ pressed: run(m, "press").length, scripted: scripted(m) }).toEqual({ pressed: 1, scripted: ["click 21", "click 21"] });
});

// A click the page seemed to ignore may still have sent a form: effect
// "none" cannot see a request to another site, or a handler slower than
// the receipt (receipt.ts). A real click after it could send it twice.
test("on a site not marked, a model's click is scripted alone: one the page ignored answers effect none, one that acted its effect, and no real press or click follows either", async () => {
  const m = mac({ clicked: [{}, { added: 2 }] });
  await mark("court.example", true);
  expect(await invoke("click", { tab: 20, ref: "#go" }, true)).toMatchObject({ ok: true, effect: "none" });
  expect(await invoke("click", { tab: 20, ref: "#go" }, true)).toMatchObject({ ok: true, effect: { added: 2 } });
  expect({ scripted: scripted(m), real: [...run(m, "press"), ...run(m, "click")] }).toEqual({ scripted: ["click 20", "click 20"], real: [] });
});

test("a run with real: true sends its clicks and typing on refs as real input, with nothing scripted", async () => {
  const m = mac();
  await invoke("run", { real: true, steps: [{ tool: "click", args: { tab: 20, ref: "#name" } }, { tool: "type", args: { tab: 20, ref: "#name", text: "Ada" } }] }, true);
  expect({ scripted: scripted(m), real: m.helper.filter((c) => ["press", "click", "key", "type"].includes(c[0])).map((c) => c[0]) }).toEqual({ scripted: [], real: ["press", "click", "key", "type"] });
});

test("a model run without real honors a marked site for click and type, leaves other sites scripted, and an internal run stays scripted", async () => {
  const m = mac();
  await mark("court.example", true);
  const steps = [
    { tool: "click", args: { tab: 21, ref: "#name" } },
    { tool: "type", args: { ref: "#name", text: "Ada" } },
    { tool: "click", args: { tab: 20, ref: "#go" } },
  ];
  expect(await invoke("run", { steps }, true)).toMatchObject({
    steps: [{ value: { ok: true, background: true } }, { value: { ok: true } }, { value: { effect: "none" } }],
    notRun: 0,
  });
  expect(scripted(m)).toEqual(["click 20"]);
  expect(await invoke("run", { steps })).toMatchObject({
    steps: [{ value: { effect: "none" } }, { value: { kept: true } }, { value: { effect: "none" } }],
    notRun: 0,
  });
  expect(scripted(m)).toEqual(["click 20", "click 21", "type 21", "click 20"]);
  expect(m.helper.filter((c) => ["press", "click", "key", "type"].includes(c[0])).map((c) => c[0])).toEqual(["press", "click", "key", "type"]);
  expect(m.typed).toEqual(["Ada"]);
});

test("a caller run checks later arguments before sending any real input", async () => {
  const m = mac();
  const result = await invoke("run", { steps: [
    { tool: "real-input", args: { tab: 21, action: "click", ref: "#submit" } },
    { tool: "press", args: { tab: 21 } },
  ] }, true);
  expect(result).toMatchObject({ steps: [{ step: 2, tool: "press", error: expect.any(String) }], notRun: 1 });
  expect({ helper: m.helper, page: m.asked }).toEqual({ helper: [], page: [] });
});

// A sign-in button opens its window as the real mouse clicks it. Before,
// the daemon calls real_input made after the click took that news and
// dropped it, so the agent never heard of the window.
test("a real click's answer carries the tab its action opened", async () => {
  mac({ popup: { tab: 22, url: "https://accounts.example/" } });
  expect(await runAs(process.pid, () => invoke("real_input", { tab: 21, do: "click", ref: "#go", count: 2 }, true))).toEqual({ ok: true, at: { x: 140, y: 160 }, popup: { tab: 22, url: "https://accounts.example/" } });
});
