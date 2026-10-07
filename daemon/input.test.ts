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
// through Safari's accessibility tree, and sets a field's text there, and
// nothing comes forward. Where that cannot serve, the tab comes to the
// front, once the user pauses, and the real mouse and keys act. The
// caller's RPC calls go straight to the daemon's tools; Safari, the page,
// and the helper are fakes.

const GHOSTTY = "com.mitchellh.ghostty";

// Safari's answer to press_mark, the errors the page threw by press_done,
// the helper's answer to press and to setvalue, the page area of Safari's
// front window, what the page did on each scripted click, in order
// (withReceipt in extension/content.js; nothing by default), the tab it
// opens on a real click, which the daemon queues for the agent
// (continuity.ts), the app the user brings forward while the helper types,
// a field that garbles keys typed fast or at any pace (a card mask), the
// lines a chat shows after text is sent, and a user who never pauses.
type Page = {
  picker?: boolean;
  press?: { pressed: boolean; why?: string };
  set?: { set: boolean; why?: string };
  errors?: string[];
  area?: { x: number; y: number; width: number; height: number };
  clicked?: Record<string, unknown>[];
  popup?: { tab: number; url: string };
  takeover?: string;
  garble?: "fast" | "always";
  reply?: string[];
  busy?: boolean;
};
type Mac = {
  app: string;
  // helper commands, and what Safari was asked of its tabs and pages, in order
  helper: string[][];
  // text the helper typed or set, in order
  typed: (string | undefined)[];
  asked: string[];
  // the text of the field typed into; a Return sends it, as a chat does
  field: string;
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
  // the field's text as typing began (append), and whether Cmd+A selected it
  let before = "";
  let selected = false;
  const show = (id: number) => {
    const windowId = tabs.find((t) => t.id === id)!.windowId;
    for (const t of tabs) if (t.windowId === windowId) t.active = t.id === id;
    return windowId;
  };
  const m: Mac = { app: GHOSTTY, helper: [], typed: [], asked: [], field: "", shows: (windowId) => tabs.find((t) => t.windowId === windowId && t.active)?.id };
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
      if (dom === "typeMark") {
        before = args[2][2] ? m.field : "";
        return answer({ mark: "__sh_type_t", width: 1247, height: 870, boxes: false });
      }
      if (dom === "typeField") return answer(args[2][3] ? { sent: m.field === "" } : { kept: m.field === before + args[2][2], focused: true });
      if (dom === "wait") return answer(page.reply ? { found: true, added: page.reply } : { found: false });
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
    if (args[0] === "idle") return { idle: !page.busy, waitedMs: 0 };
    if (args[0] === "setvalue") {
      m.typed.push(stdin);
      if (page.set) return page.set;
      m.field = stdin ?? "";
      return { set: true };
    }
    if (args[0] === "key") {
      selected = args[1] === "cmd+a";
      if (args[1] === "Enter") m.field = "";
    }
    if (args[0] === "type") {
      m.typed.push(stdin);
      if (page.takeover) m.app = page.takeover;
      const garbled = page.garble === "always" || (page.garble === "fast" && args[1] === "--gap");
      const text = garbled ? [...(stdin ?? "")].reverse().join("") : stdin ?? "";
      m.field = selected ? text : m.field + text;
      selected = false;
    }
    if (args[0] === "front") return { bundleId: m.app };
    if (args[0] === "activate") m.app = args[1];
    if (args[0] === "press") {
      m.pressedIn = m.shows(2);
      const pressed = page.press ?? { pressed: true };
      // a chat's Send button takes the text out of its field
      if (pressed.pressed) m.field = "";
      return pressed;
    }
    if (args[0] === "webarea") return page.area ?? { x: 0, y: 100, width: 1200, height: 800 };
    if (args[0] === "click") {
      // the helper's closing F20, which the page counts
      marks++;
      selected = false;
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

test("real typing types exact Unicode and inner line breaks through stdin, not arguments, after Cmd+A unless append; a line break at the end presses Return", async () => {
  const m = mac();
  const text = " Zoë 李𐐷\ne\u0301\tline two\r\n";
  const appended = " suite\n";
  await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#name", text });
  await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#name", text: appended, append: true });
  expect(m.helper.filter((c) => ["click", "key", "type"].includes(c[0])).map((c) => (c[0] === "key" ? `key ${c[1]}` : c[0]))).toEqual(["click", "key cmd+a", "type", "key Enter", "click", "type", "key Enter"]);
  expect({ args: run(m, "type"), stdin: m.typed }).toEqual({ args: [["type"], ["type"]], stdin: [" Zoë 李𐐷\ne\u0301\tline two", " suite"] });
});

test("a user who brings another app forward while real input types keeps it: nothing is raised over it after", async () => {
  const slack = "com.tinyspeck.slackmacgap";
  const m = mac({ takeover: slack, set: { set: false, why: "the element is not in Safari's accessibility tree" } });
  await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#name", text: "hi stone" });
  expect(m.app).toBe(slack);
});

// On 10-07 a 200-letter reply held the user's screen 15 s as real keys,
// and macOS autocorrect sent "resham" as "gresham" while the call said ok.
test("text typed at a field's ref goes in from behind: no app or window comes forward, no key is pressed, and the field holds the text exactly", async () => {
  const m = mac();
  expect(await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#name", text: "resham" })).toEqual({ ok: true, background: true, kept: true });
  expect({ field: m.field, app: m.app, keys: m.helper.filter((c) => ["activate", "click", "key", "type"].includes(c[0])) }).toEqual({ field: "resham", app: GHOSTTY, keys: [] });
});

test("where the field cannot take text from behind, real keys type it fast and it is checked: text that came out wrong is typed again at the slow pace", async () => {
  const m = mac({ set: { set: false, why: "Safari does not let the field's text be set" }, garble: "fast" });
  expect(await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#card", text: "4242 4242" })).toEqual({ ok: true, kept: true });
  expect({ field: m.field, last: run(m, "type").at(-1) }).toEqual({ field: "4242 4242", last: ["type"] });
});

// A Philips support chat took 4 or 5 calls a reply, and 160 waits of
// 30 s each, 33 minutes of them (10-07).
test("text ending in a line break is sent in one call: the answer says the page took it and carries the reply", async () => {
  const m = mac({ reply: ["Agent: thanks, checking your order now"] });
  expect(await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#chat", text: "order 1234 arrived broken\n", reply: 60000 })).toEqual({
    ok: true,
    background: true,
    sent: true,
    reply: ["Agent: thanks, checking your order now"],
  });
  expect({ field: m.field, enters: m.helper.filter((c) => c[0] === "key" && c[1] === "Enter").length, app: m.app }).toEqual({ field: "", enters: 1, app: GHOSTTY });
});

test("with send, the page's Send button is clicked from behind as well: the whole reply goes out with nothing coming forward and no key pressed", async () => {
  const m = mac({ reply: ["Agent: a new blade ships today"] });
  expect(await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#chat", text: "the blade broke after a week", send: "#send", reply: 60000 })).toEqual({
    ok: true,
    background: true,
    sent: true,
    reply: ["Agent: a new blade ships today"],
  });
  expect({ field: m.field, app: m.app, real: m.helper.filter((c) => ["activate", "click", "key", "type"].includes(c[0])) }).toEqual({ field: "", app: GHOSTTY, real: [] });
});

test("text that comes out wrong at every pace is never sent: no Return is pressed, and the answer says so", async () => {
  const m = mac({ set: { set: false, why: "Safari does not let the field's text be set" }, garble: "always" });
  expect(await INPUT_TOOLS.real_input.run({ tab: 21, do: "type", ref: "#chat", text: "hi resham\n" })).toMatchObject({ ok: true, kept: false, sent: false });
  expect(m.helper.filter((c) => c[0] === "key" && c[1] === "Enter")).toEqual([]);
});

// On 10-07 Safari came in front about 30 times in 30 minutes over the
// terminal the user was typing in.
test("while the user keeps typing, the tab stays behind his app and no key is sent", async () => {
  const m = mac({ busy: true });
  await expect(INPUT_TOOLS.real_input.run({ tab: 21, do: "key", key: "Enter" })).rejects.toThrow(/kept typing/);
  expect({ app: m.app, acted: m.helper.filter((c) => ["activate", "key"].includes(c[0])), shown: m.asked.filter((a) => a.startsWith("tabs.activate")) }).toEqual({ app: GHOSTTY, acted: [], shown: [] });
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
  expect({ scripted: scripted(m), real: m.helper.filter((c) => ["press", "setvalue", "click", "key", "type"].includes(c[0])).map((c) => c[0]) }).toEqual({ scripted: [], real: ["press", "setvalue"] });
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
  expect(m.helper.filter((c) => ["press", "setvalue", "click", "key", "type"].includes(c[0])).map((c) => c[0])).toEqual(["press", "setvalue"]);
  expect(m.typed).toEqual(["Ada"]);
});

// On 10-04 three runs named their tab once, beside steps, and each failed
// on its first step for want of one (01a1088c, 01a104d2, 01a0ffea).
test("a run's own tab goes to each step that names none, whether a model or the harness runs it", async () => {
  const m = mac();
  const steps = [{ tool: "click", args: { ref: "#go" } }, { tool: "type", args: { ref: "#name", text: "Ada" } }];
  expect(await invoke("run", { tab: 20, steps }, true)).toMatchObject({ notRun: 0 });
  expect(await invoke("run", { tab: 20, steps })).toMatchObject({ notRun: 0 });
  expect(scripted(m)).toEqual(["click 20", "type 20", "click 20", "type 20"]);
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
