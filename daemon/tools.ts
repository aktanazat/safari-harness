// Tool registry: the aside-style verbs, implemented over the bridge.
// Every consumer (CLI, MCP server, agent loop, CDP shim) calls these.

import { bridge } from "./bridge.ts";
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

export async function extract(opts: { tab?: number; selector?: string; maxBytes?: number }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "extract", [{ selector: opts.selector, maxBytes: opts.maxBytes }]);
}

export async function tabInfo(opts: { tab?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "tabInfo");
}

export async function wait(opts: { tab?: number; ms?: number; selector?: string; text?: string }) {
  const tab = await resolveTab(opts.tab);
  const until = opts.selector !== undefined || opts.text !== undefined;
  if (!until && opts.ms === undefined) throw new Error("wait needs ms, selector, or text");
  const ms = opts.ms === undefined ? 10000 : num(opts.ms, "ms");
  return relay(tab, "wait", [ms, opts.selector ?? null, opts.text ?? null], ms + 10000);
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
  items?: { type: "string" };
};
type Tool = {
  desc: string;
  params: Record<string, Param>;
  required?: string[];
  run: (a: Record<string, unknown>) => Promise<unknown>;
};

const TAB: Param = { type: "number", description: "tab id from open or tabs; omit for the front tab, which is usually the user's" };
const REF: Param = { description: "element ref from the latest snapshot, e.g. 12" };
const PAGE: Param = { type: "boolean", description: "also return the resulting page as a snapshot (of the new tab, if the action opened one)" };

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

export const TOOLS: Record<string, Tool> = {
  tabs: { desc: "List Safari tabs: id, url, title, and which is in front.", params: {}, run: () => listTabs() },
  open: {
    desc: "Open a URL in a new tab and wait until it is readable. Returns the tab id: pass it as tab to every later call, and close the tab when done.",
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
    desc: "Read the page as an outline of elements with [ref]s for click, type, select, and hover. Refs last until the page changes: take a new snapshot after acting. Link URLs are shortened.",
    params: {
      tab: TAB,
      query: { type: "string", description: "return only lines containing this text, e.g. a button label" },
      root: { type: "string", description: "CSS selector: read only this region, e.g. a dialog" },
      maxNodes: { type: "number", description: "line limit, default 600" },
    },
    run: (a) => snapshot(a as { tab?: number; root?: string; query?: string; maxNodes?: number }),
  },
  click: {
    desc: "Click an element by ref (or at x/y). Reports navigated if the page changed, or newTab if a tab opened; a newTab is yours to close.",
    params: { tab: TAB, ref: REF, x: { type: "number", description: "page x, only without ref" }, y: { type: "number", description: "page y, only without ref" }, snapshot: PAGE },
    run: action((a) => click(a as { tab: number; ref?: string; x?: number; y?: number })),
  },
  type: {
    desc: "Set the text of a field by ref; replaces its text unless append.",
    params: { tab: TAB, ref: REF, text: { type: "string", description: "text to enter" }, append: { type: "boolean", description: "add to the existing text" }, snapshot: PAGE },
    required: ["ref", "text"],
    run: action((a) => type(a as { tab: number; ref: string; text: string; append?: boolean })),
  },
  press: {
    desc: "Press a key (Enter, Tab, Escape, ArrowDown…) on an element by ref, or on the focused element. Enter in a field submits its form.",
    params: { tab: TAB, ref: REF, key: { type: "string", description: "key name" }, snapshot: PAGE },
    required: ["key"],
    run: action((a) => press(a as { tab: number; ref?: string; key: string })),
  },
  select: {
    desc: "Choose an option in a dropdown (<select>) by its label or value. An unknown option returns the list of options.",
    params: { tab: TAB, ref: REF, option: { type: "string", description: "option label or value" }, snapshot: PAGE },
    required: ["ref", "option"],
    run: action((a) => select(a as { tab: number; ref: string; option: string })),
  },
  hover: {
    desc: "Move the pointer over an element by ref, for menus that open on hover. Menus driven purely by CSS :hover do not respond.",
    params: { tab: TAB, ref: REF, snapshot: PAGE },
    required: ["ref"],
    run: action((a) => hover(a as { tab: number; ref: string })),
  },
  upload: {
    desc: "Attach local files to a file input. ref may be the upload area; omit it when the page has a single file input.",
    params: { tab: TAB, ref: REF, paths: { type: "array", items: { type: "string" }, description: "absolute file paths" }, snapshot: PAGE },
    required: ["paths"],
    run: action((a) => upload(a as { tab: number; ref?: string; paths: string[] })),
  },
  history: {
    desc: "Go back, go forward, or reload the page.",
    params: { tab: TAB, go: { type: "string", enum: ["back", "forward", "reload"], description: "direction" }, snapshot: PAGE },
    required: ["go"],
    run: action((a) => history(a as { tab: number; go: string })),
  },
  scroll: {
    desc: "Scroll the page. Snapshots already include off-screen elements; scroll only to make a page load more.",
    params: { tab: TAB, dx: { type: "number", description: "pixels right" }, dy: { type: "number", description: "pixels down, default 600" } },
    run: (a) => scroll(a as { tab?: number; dx?: number; dy?: number }),
  },
  eval: {
    desc: "Run a JavaScript expression in the page and return its JSON value. It sees the DOM but not the page's own script variables.",
    params: { tab: TAB, expression: { type: "string", description: "a JS expression; a promise is awaited" } },
    required: ["expression"],
    run: (a) => evaluate({ tab: a.tab as number | undefined, expression: str(a.expression, "expression") }),
  },
  extract: {
    desc: "Readable text of the page's main content (or of a CSS selector), for reading long pages.",
    params: { tab: TAB, selector: { type: "string", description: "CSS selector to read" }, maxBytes: { type: "number", description: "default 20000" } },
    run: (a) => extract(a as { tab?: number; selector?: string; maxBytes?: number }),
  },
  info: { desc: "URL, title, load state, and scroll position of a tab.", params: { tab: TAB }, run: (a) => tabInfo({ tab: a.tab as number | undefined }) },
  wait: {
    desc: "Wait until text and/or a CSS selector is on the page (ms is the timeout: default 10000, max 30000), or with only ms, sleep. Returns found.",
    params: { tab: TAB, text: { type: "string", description: "visible text to wait for" }, selector: { type: "string", description: "CSS selector to wait for" }, ms: { type: "number", description: "timeout, or sleep length" } },
    run: (a) => wait(a as { tab?: number; ms?: number; selector?: string; text?: string }),
  },
  net_start: { desc: "Start recording the page's fetch/XHR requests.", params: { tab: TAB }, run: (a) => netStart({ tab: a.tab as number | undefined }) },
  net_stop: { desc: "Stop recording requests.", params: { tab: TAB }, run: (a) => netStop({ tab: a.tab as number | undefined }) },
  net_read: { desc: "Requests recorded since net_start: url, method, status, time.", params: { tab: TAB }, run: (a) => netRead({ tab: a.tab as number | undefined }) },
  console_start: { desc: "Start recording the page's console messages.", params: { tab: TAB }, run: (a) => consoleStart({ tab: a.tab as number | undefined }) },
  console_read: { desc: "Console messages recorded since console_start.", params: { tab: TAB }, run: (a) => consoleRead({ tab: a.tab as number | undefined }) },
  cookies: {
    desc: "Cookies for the tab's site. Values are secrets: never repeat them.",
    params: { tab: TAB, url: { type: "string", description: "another site's URL" } },
    run: (a) => cookies({ tab: a.tab as number | undefined, url: a.url as string | undefined }),
  },
  shot: {
    desc: "Screenshot the Safari window showing this tab; returns a PNG path. Briefly brings the tab to the front, then restores the user's tab.",
    params: { tab: TAB, out: { type: "string", description: "PNG path to write" } },
    run: (a) => screenshot({ tab: a.tab as number | undefined, out: a.out as string | undefined }),
  },
};

export function inputSchema(tool: Tool) {
  return { type: "object", properties: tool.params, required: tool.required ?? [] };
}

type Snapshot = { url: string; title: string; nodes: number; truncated: boolean; snapshot: string };
type Extract = { url: string; title: string; text: string };

// One text form for every consumer (CLI, MCP, agent loop): trees and page
// text stay readable instead of arriving as escaped JSON strings.
export function formatResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Partial<Snapshot & Extract> & { page?: unknown };
    if (typeof v.snapshot === "string") {
      const note = v.truncated ? "; truncated: narrow with query or root" : "";
      return `# ${v.title} — ${v.url} (${v.nodes} nodes${note})\n${v.snapshot}`;
    }
    if (typeof v.text === "string" && typeof v.url === "string") return `# ${v.title} — ${v.url}\n\n${v.text}`;
    if (v.page !== undefined) {
      const { page, ...rest } = v;
      return `${JSON.stringify(rest)}\n\n${formatResult(page)}`;
    }
  }
  return JSON.stringify(value, null, 1);
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  return tool.run(args);
}
