import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { runAs } from "./owner.ts";
import { callTool, loadTabs } from "./tools.ts";

// A stand-in extension: open hands out tabs 1, 2, 3...; a click in tab 1
// opens tab 100; every close succeeds and is noted.
const closes: unknown[][] = [];
let nextTab = 0;
let nextWindow = 0;
let onClose = () => {};
function answer(op: string, args: unknown[]): unknown {
  if (op === "windows.open") return { windowId: ++nextWindow, tabId: 900 + nextWindow };
  if (op === "tabs.open") return { id: ++nextTab, windowId: args[2] };
  if (op === "tabs.list" || op === "probe") return [];
  if (op === "relay" && args[0] === 1 && args[1] === "click") return { ok: true, newTab: { id: 100 } };
  return { ok: true };
}
bridge.attach({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    bridge.handleMessage(JSON.stringify({ id, value: answer(op, args) }));
    if (op === "tabs.close") {
      closes.push(args);
      onClose();
    }
  },
  close() {},
});

// The daemon's own closes say "owned": the extension then closes a tab only
// if the harness owns it.
function closedOwned(tabs: number[]): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  onClose = () => { if (tabs.every((t) => closes.some(([tab, only]) => tab === t && only === "owned"))) resolve(); };
  onClose();
  return promise;
}
const ownedCloses = () => closes.filter(([, only]) => only === "owned").map(([tab]) => tab).sort((a, b) => Number(a) - Number(b));
// the answers settle in microtasks, which all run before the next turn
const settled = () => new Promise((resolve) => setImmediate(resolve));

// Before, the daemon kept its tab owners in memory: after a restart, the
// tabs of an agent that had exited stayed open for good.
test("a restarted daemon closes the tabs of an agent that exited meanwhile, and only those", async () => {
  const exited = Bun.spawnSync(["true"]).pid;
  const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
  writeFileSync(file, JSON.stringify({ 11: exited, 12: process.pid }));
  loadTabs(file);
  await closedOwned([11]);
  await settled();
  expect(ownedCloses()).toEqual([11]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ 12: process.pid });
});

// An agent that is done need not spend a turn on close; the user never saw
// these tabs. One it opened in front, or asked to keep, is his.
test("an agent's background tabs, and tabs they open, close once it exits; front and kept ones stay", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
  await as("open", { url: "https://example.com/", background: true }); // tab 1
  await as("click", { tab: 1, ref: "Elsewhere" }); // opens tab 100
  await as("open", { url: "https://example.com/" }); // tab 2, in front
  await as("open", { url: "https://example.com/", background: true, keep: true }); // tab 3
  await as("run", { steps: [{ tool: "open", args: { url: "https://example.com/", background: true } }] }); // tab 4
  await as("open", { url: "https://example.com/", background: true }); // tab 5
  await as("close", { tab: 5 });
  agent.kill();
  await closedOwned([1, 4, 100]);
  await settled();
  expect(ownedCloses()).toEqual([1, 4, 11, 100]);
});
