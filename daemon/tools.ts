// Tool registry: the aside-style verbs, implemented over the bridge.
// Every consumer (CLI, MCP server, agent loop, CDP shim) calls these.

import { bridge } from "./bridge.ts";
import { fill, loginsFor, passwords } from "./passwords.ts";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TabInfo = { id: number; url?: string; title?: string; active?: boolean; windowId?: number };

type Relay = (tabId: number, op: string, args?: unknown[], timeoutMs?: number) => Promise<unknown>;
const relay: Relay = (tabId, op, args = [], timeoutMs) => bridge.tab(tabId, op, args, timeoutMs);

function num(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}

export async function listTabs(): Promise<TabInfo[]> {
  return (await bridge.request("tabs.list")) as TabInfo[];
}

export async function resolveTab(tab?: number): Promise<number> {
  if (tab !== undefined && tab !== null) return num(tab, "tab");
  const tabs = await listTabs();
  const active = tabs.find((t) => t.active) ?? tabs[0];
  if (!active) throw new Error("no tabs open in Safari");
  return active.id;
}

export async function openTab(url: string, background = false): Promise<TabInfo> {
  return (await bridge.request("tabs.open", [str(url, "url"), background])) as TabInfo;
}

export async function closeTab(tab: number): Promise<unknown> {
  return bridge.request("tabs.close", [num(tab, "tab")]);
}

export async function navigate(tab: number, url: string): Promise<TabInfo> {
  return (await bridge.request("tabs.navigate", [num(tab, "tab"), str(url, "url")])) as TabInfo;
}

export async function activateTab(tab: number): Promise<unknown> {
  return bridge.request("tabs.activate", [num(tab, "tab")]);
}

export async function snapshot(opts: { tab?: number; root?: string; query?: string; maxNodes?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "snapshot", [{ root: opts.root, query: opts.query, maxNodes: opts.maxNodes }]);
}

export async function click(opts: { tab?: number; ref?: number | string; x?: number; y?: number }) {
  const tab = await resolveTab(opts.tab);
  if (opts.ref !== undefined) return relay(tab, "click", [opts.ref]);
  if (opts.x !== undefined && opts.y !== undefined) return relay(tab, "clickAt", [num(opts.x, "x"), num(opts.y, "y")]);
  throw new Error("click needs ref or x+y");
}

export async function type(opts: { tab?: number; ref: number | string; text: string; append?: boolean }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "type", [opts.ref, str(opts.text, "text"), { append: !!opts.append }]);
}

export async function press(opts: { tab?: number; ref?: number | string; key: string }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "press", [opts.ref ?? null, str(opts.key, "key")]);
}

export async function scroll(opts: { tab?: number; dx?: number; dy?: number }) {
  const tab = await resolveTab(opts.tab);
  const dy = opts.dy ?? (opts.dx ? 0 : 600);
  return relay(tab, "scroll", [opts.dx ?? 0, dy]);
}

export async function select(opts: { tab?: number; ref: number | string; option: string }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "select", [opts.ref, str(opts.option, "option")]);
}

export async function hover(opts: { tab?: number; ref: number | string }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "hover", [opts.ref]);
}

export async function upload(opts: { tab?: number; ref?: number | string; paths: string[] }) {
  const tab = await resolveTab(opts.tab);
  if (!Array.isArray(opts.paths) || opts.paths.length === 0) throw new Error("upload needs paths: [\"/abs/file\", ...]");
  const files = await Promise.all(opts.paths.map(async (p) => {
    const f = Bun.file(str(p, "path"));
    if (!(await f.exists())) throw new Error(`no such file: ${p}`);
    return { name: basename(p), type: f.type, data: Buffer.from(await f.arrayBuffer()).toString("base64") };
  }));
  return relay(tab, "upload", [opts.ref ?? null, files], 60000);
}

const HISTORY = new Set(["back", "forward", "reload"]);

export async function history(opts: { tab?: number; go: string }) {
  const tab = await resolveTab(opts.tab);
  if (!HISTORY.has(opts.go)) throw new Error("go must be back, forward, or reload");
  return relay(tab, "history", [opts.go]);
}

export async function evaluate(opts: { tab?: number; expression: string }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "eval", [str(opts.expression, "expression")], 30000);
}

export async function extract(opts: { tab?: number; selector?: string; query?: string; maxBytes?: number }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "extract", [{ selector: opts.selector, query: opts.query, maxBytes: opts.maxBytes }]);
}

export async function tabInfo(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "tabInfo");
}

// Sleep for ms, or, given a selector or text, wait until it is present (ms is
// then the timeout, max 30000). The page reports the change the moment it
// happens (waitFor in content.js); the time limit is kept here, because
// Safari stops a content script's timers in a hidden tab.
export async function wait(opts: { tab?: number; ms?: number; selector?: string; text?: string }) {
  const tab = await resolveTab(opts.tab);
  const until = opts.selector !== undefined || opts.text !== undefined;
  if (!until && opts.ms === undefined) throw new Error("wait needs ms, selector, or text");
  const limit = Math.min(opts.ms === undefined ? 10000 : num(opts.ms, "ms"), 30000);
  if (!until) {
    await Bun.sleep(limit);
    return { ok: true };
  }
  const start = Date.now();
  const stop = setTimeout(() => { relay(tab, "waitStop").catch(() => {}); }, limit);
  try {
    const { found } = (await relay(tab, "wait", [opts.selector ?? null, opts.text ?? null], limit + 5000)) as { found: boolean };
    return { ok: true, found, waitedMs: Date.now() - start };
  } finally {
    clearTimeout(stop);
  }
}

export async function netStart(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "net", [true]);
}

export async function netStop(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "net", [false]);
}

export async function netRead(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "netRead");
}

export async function consoleStart(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "console", [true]);
}

export async function consoleRead(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "consoleRead");
}

export async function cookies(opts: { tab?: number; url?: string } = {}) {
  const tab = await resolveTab(opts.tab);
  const info = (await relay(tab, "tabInfo")) as { url?: string };
  return bridge.request("cookies", [opts.url ?? info.url ?? ""]);
}

// screenshot: Safari exposes no capture API to web extensions, so grab the
// Safari window itself via screencapture, located by CGWindowID.
const WINSHOT = join(import.meta.dir, "..", "scripts", "winshot");

// The capture shows whatever tab is in front, so bring the requested tab to
// the front, wait until it has painted, capture, then give the window back
// the tab that was showing before.
export async function screenshot(opts: { tab?: number; out?: string } = {}) {
  const tab = await resolveTab(opts.tab);
  const tabs = await listTabs();
  const t = tabs.find((x) => x.id === tab);
  if (!t) throw new Error(`no tab ${tab}`);
  const previous = tabs.find((x) => x.windowId === t.windowId && x.active && x.id !== tab);
  await activateTab(tab);
  try {
    await relay(tab, "painted", [], 3000);
    const { stdout } = await execFileAsync(WINSHOT, [], { timeout: 5000 });
    const winId = stdout.trim().split("\n")[0];
    if (!winId) throw new Error("no Safari window found to capture");
    const out = opts.out ?? join(await mkdtemp(join(tmpdir(), "safari-shot-")), "shot.png");
    await execFileAsync("screencapture", ["-x", "-o", "-l", winId, out], { timeout: 10000 });
    await writeFile(out + ".json", JSON.stringify({ tab, windowId: Number(winId) }));
    return { path: out };
  } finally {
    if (previous) await activateTab(previous.id);
  }
}

type Param = {
  type?: "string" | "number" | "boolean" | "array";
  description: string;
  enum?: string[];
  items?: { type: "string" } | { type: "object"; properties: Record<string, { type: "string" | "object" }>; required: string[] };
};
export type Tool = {
  desc: string;
  params: Record<string, Param>;
  required?: string[];
  run: (a: Record<string, unknown>) => Promise<unknown>;
};

const TAB: Param = { type: "number", description: "tab id from open" };
const REF: Param = { description: "snapshot ref, CSS selector, or visible text" };
const PAGE: Param = { type: "boolean", description: "also return the page after the action" };

// With `snapshot: true` an action also returns the page it led to, saving
// the agent a separate snapshot call.
async function withPage(result: unknown, tab: number, want: unknown): Promise<unknown> {
  if (!want) return result;
  const opened = (result as { newTab?: { id: number } } | null)?.newTab?.id;
  return { ...(result as object), page: await relay(opened ?? tab, "snapshot", [{}]) };
}

function action(run: (a: Record<string, unknown> & { tab: number }) => Promise<unknown>) {
  return async (a: Record<string, unknown>) => {
    const tab = await resolveTab(a.tab as number | undefined);
    return withPage(await run({ ...a, tab }), tab, a.snapshot);
  };
}

// net and console take do: start, read (the default), or stop.
type Capture = (o: { tab?: number }) => Promise<unknown>;
function capture(ops: Record<string, Capture>, a: Record<string, unknown>): Promise<unknown> {
  const key = a.do === undefined ? "read" : String(a.do);
  if (!Object.hasOwn(ops, key)) throw new Error(`do must be ${Object.keys(ops).join(", ")}`);
  return ops[key]({ tab: a.tab as number | undefined });
}

// passwords: pair and unlock take no tab; logins and fill act on the tab's
// own site.
async function applePasswords(a: Record<string, unknown>): Promise<unknown> {
  switch (a.do) {
    case "pair":
      await passwords.pair();
      return { codeShown: true, next: 'ask the user for the 6-digit code on their Mac, then call passwords with do: "unlock" and code' };
    case "unlock":
      return passwords.unlock(str(a.code, "code"));
    case "logins":
      return loginsFor(await resolveTab(a.tab as number | undefined));
    case "fill":
      return fill(await resolveTab(a.tab as number | undefined), a.username === undefined ? undefined : str(a.username, "username"));
    case "lock":
      return passwords.lock();
    default:
      throw new Error("do must be pair, unlock, logins, fill, or lock");
  }
}

export const TOOLS: Record<string, Tool> = {
  run: {
    desc: 'Run several of these tools in one call, in order, stopping at the first error; each call saved is a model turn saved. A step without tab uses the tab an earlier open step made. Open, read, and close in one call: [{"tool":"open","args":{"url":"https://example.com","background":true}},{"tool":"extract"},{"tool":"close"}]',
    params: { steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] }, description: "{tool, args} objects; args as that tool takes them" } },
    required: ["steps"],
    run: (a) => runSteps(a.steps),
  },
  tabs: { desc: "List tabs: id, url, title, and which is in front.", params: {}, run: () => listTabs() },
  open: {
    desc: "Open a URL in a new tab and wait until it is readable. Returns the tab id: pass it as tab to later calls (a call without tab acts on the user's front tab).",
    params: { url: { type: "string", description: "address to open" }, background: { type: "boolean", description: "keep the user's current tab in front" }, snapshot: PAGE },
    required: ["url"],
    run: async (a) => {
      const t = await openTab(str(a.url, "url"), !!a.background);
      return withPage(t, t.id, a.snapshot);
    },
  },
  close: { desc: "Close a tab you opened.", params: { tab: TAB }, required: ["tab"], run: (a) => closeTab(num(a.tab, "tab")) },
  goto: {
    desc: "Load a URL in a tab and wait until it is readable.",
    params: { tab: TAB, url: { type: "string", description: "address to load" }, snapshot: PAGE },
    required: ["url"],
    run: action((a) => navigate(a.tab, str(a.url, "url"))),
  },
  activate: { desc: "Bring a tab to the front.", params: { tab: TAB }, required: ["tab"], run: (a) => activateTab(num(a.tab, "tab")) },
  snapshot: {
    desc: "Page outline with [ref]s for click, type, select, and hover. Refs expire when the page changes: snapshot again after acting.",
    params: {
      tab: TAB,
      query: { type: "string", description: "only lines containing this text" },
      root: { type: "string", description: "CSS selector of the region to read" },
      maxNodes: { type: "number", description: "line limit, default 600" },
    },
    run: (a) => snapshot(a as { tab?: number; root?: string; query?: string; maxNodes?: number }),
  },
  click: {
    desc: "Click a ref (or x/y). Reports navigated, or newTab if a tab opened (yours to close).",
    params: { tab: TAB, ref: REF, x: { type: "number", description: "page x, without ref" }, y: { type: "number", description: "page y, without ref" }, snapshot: PAGE },
    run: action((a) => click(a as { tab: number; ref?: string; x?: number; y?: number })),
  },
  type: {
    desc: "Set a field's text by ref; replaces it unless append.",
    params: { tab: TAB, ref: REF, text: { type: "string", description: "text to enter" }, append: { type: "boolean", description: "keep the existing text" }, snapshot: PAGE },
    required: ["ref", "text"],
    run: action((a) => type(a as { tab: number; ref: string; text: string; append?: boolean })),
  },
  press: {
    desc: "Press a key (Enter, Tab, Escape, ArrowDown) or combo (Cmd+K) on a ref or the focused element. Enter in a field submits its form.",
    params: { tab: TAB, ref: REF, key: { type: "string", description: "key name" }, snapshot: PAGE },
    required: ["key"],
    run: action((a) => press(a as { tab: number; ref?: string; key: string })),
  },
  select: {
    desc: "Choose a dropdown option by label or value; an unknown option returns the list.",
    params: { tab: TAB, ref: REF, option: { type: "string", description: "option label or value" }, snapshot: PAGE },
    required: ["ref", "option"],
    run: action((a) => select(a as { tab: number; ref: string; option: string })),
  },
  hover: {
    desc: "Hover a ref, for menus that open on mouse-over (not ones driven only by CSS :hover).",
    params: { tab: TAB, ref: REF, snapshot: PAGE },
    required: ["ref"],
    run: action((a) => hover(a as { tab: number; ref: string })),
  },
  upload: {
    desc: "Attach local files to a file input. ref may be the upload area; omit it when the page has one file input.",
    params: { tab: TAB, ref: REF, paths: { type: "array", items: { type: "string" }, description: "absolute file paths" }, snapshot: PAGE },
    required: ["paths"],
    run: action((a) => upload(a as { tab: number; ref?: string; paths: string[] })),
  },
  history: {
    desc: "Go back, go forward, or reload.",
    params: { tab: TAB, go: { type: "string", enum: ["back", "forward", "reload"], description: "direction" }, snapshot: PAGE },
    required: ["go"],
    run: action((a) => history(a as { tab: number; go: string })),
  },
  scroll: {
    desc: "Scroll the page. Rarely needed: snapshots include off-screen elements.",
    params: { tab: TAB, dx: { type: "number", description: "pixels right" }, dy: { type: "number", description: "pixels down, default 600" } },
    run: (a) => scroll(a as { tab?: number; dx?: number; dy?: number }),
  },
  eval: {
    desc: "Run a JS expression in the page and return its JSON value; a promise is awaited. Sees the DOM, not the page's script variables.",
    params: { tab: TAB, expression: { type: "string", description: "JS expression" } },
    required: ["expression"],
    run: (a) => evaluate({ tab: a.tab as number | undefined, expression: str(a.expression, "expression") }),
  },
  extract: {
    desc: "Readable text of the main content (or a CSS selector), for long pages.",
    params: { tab: TAB, selector: { type: "string", description: "CSS selector to read" }, query: { type: "string", description: "only lines containing this text, from the whole page" }, maxBytes: { type: "number", description: "default 20000" } },
    run: (a) => extract(a as { tab?: number; selector?: string; query?: string; maxBytes?: number }),
  },
  info: { desc: "URL, title, load state, and scroll position of a tab.", params: { tab: TAB }, run: (a) => tabInfo({ tab: a.tab as number | undefined }) },
  wait: {
    desc: "Wait until text or a CSS selector is on the page (ms is the timeout: default 10000, max 30000), or with only ms, sleep. Returns found.",
    params: { tab: TAB, text: { type: "string", description: "visible text" }, selector: { type: "string", description: "CSS selector" }, ms: { type: "number", description: "timeout, or sleep length" } },
    run: (a) => wait(a as { tab?: number; ms?: number; selector?: string; text?: string }),
  },
  net: {
    desc: "Record the page's fetch/XHR requests: start, then read (url, method, status, time); stop ends it.",
    params: { tab: TAB, do: { type: "string", enum: ["start", "read", "stop"], description: "default read" } },
    run: (a) => capture({ start: netStart, read: netRead, stop: netStop }, a),
  },
  console: {
    desc: "Record the page's console messages: start, then read.",
    params: { tab: TAB, do: { type: "string", enum: ["start", "read"], description: "default read" } },
    run: (a) => capture({ start: consoleStart, read: consoleRead }, a),
  },
  cookies: {
    desc: "Cookies for the tab's site. Values are secrets: never repeat them.",
    params: { tab: TAB, url: { type: "string", description: "another site's URL" } },
    run: (a) => cookies({ tab: a.tab as number | undefined, url: a.url as string | undefined }),
  },
  shot: {
    desc: "Screenshot the Safari window showing this tab; returns a PNG path. Brings the tab to the front for a moment.",
    params: { tab: TAB, out: { type: "string", description: "PNG path to write" } },
    run: (a) => screenshot({ tab: a.tab as number | undefined, out: a.out as string | undefined }),
  },
  passwords: {
    desc: "Sign in with the user's Apple Passwords. pair shows a 6-digit code on the Mac: ask the user for it, then unlock with code. fill enters the saved login for the tab's site into its sign-in form after the user approves with Touch ID; you never see the password. logins lists saved usernames; lock ends access.",
    params: { do: { type: "string", enum: ["pair", "unlock", "logins", "fill", "lock"], description: "step" }, code: { type: "string", description: "the 6 digits the user reads off the Mac" }, tab: TAB, username: { type: "string", description: "which saved login, when there are several" } },
    required: ["do"],
    run: applePasswords,
  },
};

export function inputSchema(tool: Tool) {
  return { type: "object", properties: tool.params, ...(tool.required ? { required: tool.required } : {}) };
}

type Snapshot = { url: string; title: string; nodes: number; truncated: boolean; snapshot: string };
type Extract = { url: string; title: string; text: string };

// One text form for every consumer (CLI, MCP, agent loop): trees and page
// text stay readable instead of arriving as escaped JSON strings.
export function formatResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Partial<Snapshot & Extract & Steps> & { page?: unknown };
    if (typeof v.snapshot === "string") {
      const note = v.truncated ? "; truncated: narrow with query or root" : "";
      return `# ${v.title} — ${v.url} (${v.nodes} nodes${note})\n${v.snapshot}`;
    }
    if (typeof v.text === "string" && typeof v.url === "string") return `# ${v.title} — ${v.url}\n\n${v.text}`;
    if (v.page !== undefined) {
      const { page, ...rest } = v;
      return `${JSON.stringify(rest)}\n\n${formatResult(page)}`;
    }
    if (Array.isArray(v.steps)) {
      const lines = v.steps.map((s) => `[${s.step} ${s.tool}] ${s.error === undefined ? formatResult(s.value) : `error: ${s.error}`}`);
      if (v.notRun) lines.push(`stopped: the ${v.notRun} later step${v.notRun === 1 ? "" : "s"} did not run`);
      return lines.join("\n");
    }
  }
  return JSON.stringify(value, null, 1);
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  return tool.run(args);
}

type Step = { step: number; tool: string; value?: unknown; error?: string };
type Steps = { steps: Step[]; notRun: number };

function stepOf(step: unknown): { tool: string; args: Record<string, unknown> } {
  if (!step || typeof step !== "object" || !("tool" in step) || typeof step.tool !== "string") throw new Error('each step needs a tool: {"tool": "open", "args": {…}}');
  const args = "args" in step && step.args && typeof step.args === "object" ? step.args : {};
  return { tool: step.tool, args: args as Record<string, unknown> };
}

// run: several tools in one call, so an agent can open, act, read, and close
// without a model turn between steps. A step without tab uses the tab the
// latest open step made. Later steps usually depend on earlier ones, so the
// first error stops the run, except that close steps still run: a failed run
// must not leave its tab behind.
async function runSteps(steps: unknown): Promise<Steps> {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('run needs steps: [{"tool": "open", "args": {"url": "…"}}, …]');
  const done: Step[] = [];
  let opened: number | undefined;
  let failed = false;
  for (const [i, raw] of (steps as unknown[]).entries()) {
    let tool = "?";
    try {
      const step = stepOf(raw);
      tool = step.tool;
      if (failed && tool !== "close") continue;
      const value = await callTool(tool, opened === undefined || step.args.tab !== undefined ? step.args : { ...step.args, tab: opened });
      if (tool === "open" && value && typeof value === "object" && "id" in value && typeof value.id === "number") opened = value.id;
      done.push({ step: i + 1, tool, value });
    } catch (e) {
      if (failed && tool !== "close") continue;
      done.push({ step: i + 1, tool, error: e instanceof Error ? e.message : String(e) });
      failed = true;
    }
  }
  return { steps: done, notRun: steps.length - done.length };
}
