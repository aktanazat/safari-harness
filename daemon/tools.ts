// Tool registry: the aside-style verbs, implemented over the bridge.
// Every consumer (CLI, MCP server, agent loop, CDP shim) calls these.

import { bridge } from "./bridge.ts";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export async function snapshot(opts: { tab?: number; root?: string; maxNodes?: number } = {}) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "snapshot", [{ root: opts.root, maxNodes: opts.maxNodes }]);
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

export async function wait(opts: { tab?: number; ms: number }) {
  const tab = await resolveTab(opts.tab);
  return relay(tab, "wait", [num(opts.ms, "ms")], num(opts.ms, "ms") + 10000);
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

export async function screenshot(opts: { tab?: number; out?: string } = {}) {
  const tab = await resolveTab(opts.tab);
  const tabs = await listTabs();
  const t = tabs.find((x) => x.id === tab);
  if (t && t.windowId !== undefined) {
    await bridge.request("windows.focus", [t.windowId]);
  }
  const { stdout } = await execFileAsync(WINSHOT, [], { timeout: 5000 });
  const winId = stdout.trim().split("\n")[0];
  if (!winId) throw new Error("no Safari window found to capture");
  const out = opts.out ?? join(await mkdtemp(join(tmpdir(), "safari-shot-")), "shot.png");
  await execFileAsync("screencapture", ["-x", "-o", "-l", winId, out], { timeout: 10000 });
  await writeFile(out + ".json", JSON.stringify({ tab, windowId: Number(winId) }));
  return { path: out };
}

export const TOOLS: Record<string, { desc: string; args: string; run: (a: Record<string, unknown>) => Promise<unknown> }> = {
  tabs: { desc: "list Safari tabs", args: "", run: () => listTabs() },
  open: { desc: "open a URL in a new tab", args: "url, background?", run: (a) => openTab(str(a.url, "url"), !!a.background) },
  close: { desc: "close a tab", args: "tab", run: (a) => closeTab(num(a.tab, "tab")) },
  goto: { desc: "navigate a tab to a URL", args: "tab?, url", run: async (a) => navigate(await resolveTab(a.tab as number | undefined), str(a.url, "url")) },
  activate: { desc: "focus a tab", args: "tab", run: (a) => activateTab(num(a.tab, "tab")) },
  snapshot: { desc: "aria snapshot with [ref]s for clicking/typing", args: "tab?, root?, maxNodes?", run: (a) => snapshot(a as { tab?: number; root?: string; maxNodes?: number }) },
  click: { desc: "click element by snapshot ref (or x/y)", args: "tab?, ref?|x?, y?", run: (a) => click(a as { tab?: number; ref?: string; x?: number; y?: number }) },
  type: { desc: "type text into element by ref", args: "tab?, ref, text, append?", run: (a) => type(a as { tab?: number; ref: string; text: string; append?: boolean }) },
  press: { desc: "press a key (Enter, Tab, Escape…)", args: "tab?, ref?, key", run: (a) => press(a as { tab?: number; ref?: string; key: string }) },
  scroll: { desc: "scroll the page", args: "tab?, dx?, dy?", run: (a) => scroll(a as { tab?: number; dx?: number; dy?: number }) },
  eval: { desc: "evaluate a JS expression in the page, returns JSON", args: "tab?, expression", run: (a) => evaluate({ tab: a.tab as number | undefined, expression: str(a.expression, "expression") }) },
  extract: { desc: "extract readable text from the page", args: "tab?, selector?, maxBytes?", run: (a) => extract(a as { tab?: number; selector?: string; maxBytes?: number }) },
  info: { desc: "url/title/scroll of a tab", args: "tab?", run: (a) => tabInfo({ tab: a.tab as number | undefined }) },
  wait: { desc: "wait milliseconds", args: "tab?, ms", run: (a) => wait({ tab: a.tab as number | undefined, ms: num(a.ms, "ms") }) },
  net_start: { desc: "start capturing fetch/XHR", args: "tab?", run: (a) => netStart({ tab: a.tab as number | undefined }) },
  net_stop: { desc: "stop capturing fetch/XHR", args: "tab?", run: (a) => netStop({ tab: a.tab as number | undefined }) },
  net_read: { desc: "read captured requests", args: "tab?", run: (a) => netRead({ tab: a.tab as number | undefined }) },
  console_start: { desc: "start capturing console", args: "tab?", run: (a) => consoleStart({ tab: a.tab as number | undefined }) },
  console_read: { desc: "read captured console", args: "tab?", run: (a) => consoleRead({ tab: a.tab as number | undefined }) },
  cookies: { desc: "cookies for the page URL", args: "tab?, url?", run: (a) => cookies({ tab: a.tab as number | undefined, url: a.url as string | undefined }) },
  shot: { desc: "screenshot the Safari window, returns a PNG path", args: "tab?, out?", run: (a) => screenshot({ tab: a.tab as number | undefined, out: a.out as string | undefined }) },
};

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  return tool.run(args);
}
