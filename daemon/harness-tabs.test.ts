import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs, watchOwner } from "./owner.ts";
import { ReplSession } from "./repl.ts";
import { callTool, endTurn, loadTabs } from "./tools.ts";

// A stand-in extension: open hands out tabs 1, 2, 3...; a click in tab 1
// opens tab 100; every close succeeds and is noted, except that the tab the
// user has in front stays when the close is for a tab left idle. The tab
// list is showing, and a call to a closed tab fails as the extension's does.
const closes: unknown[][] = [];
const gone = new Set<number>();
let showing: { id: number; url: string }[] = [];
let nextTab = 0;
let nextWindow = 0;
let hisFront: number | undefined;
let onClose = () => {};
function answer(op: string, args: unknown[]): unknown {
  if (op === "windows.open") return { windowId: ++nextWindow, tabId: 900 + nextWindow };
  if (op === "tabs.open") return { id: ++nextTab, windowId: args[2] };
  if (op === "tabs.list") return showing;
  if (op === "probe") return [];
  if (op === "relay" && args[0] === 1 && args[1] === "click") return { ok: true, newTab: { id: 100 } };
  if (op === "tabs.close" && args[1] === "idle" && args[0] === hisFront) return { ok: false, front: true };
  return { ok: true };
}
const ext = {
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const value = answer(op, args);
    if (op === "tabs.close" && !(typeof value === "object" && value !== null && "front" in value)) gone.add(Number(args[0]));
    bridge.handleMessage(JSON.stringify(op === "relay" && gone.has(Number(args[0])) ? { id, error: "that tab is gone: it was closed at the end of your turn, after 20 minutes unused, or by the user" } : { id, value }));
    if (op === "tabs.close") {
      closes.push(args);
      onClose();
    }
  },
  close() {},
};
connect(ext);

// The daemon's own closes take only a tab the harness owns: "owned" for an
// agent gone, "idle" for a tab it is done with, which spares one the user
// has in front.
function closedAs(only: string, tabs: number[]): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  onClose = () => { if (tabs.every((t) => closes.some(([tab, how]) => tab === t && how === only))) resolve(); };
  onClose();
  return promise;
}
const closesAs = (only: string) => closes.filter(([, how]) => how === only).map(([tab]) => Number(tab)).sort((a, b) => a - b);
// the answers settle in microtasks, which all run before the next turn
const settled = () => new Promise((resolve) => setImmediate(resolve));

// Before, the daemon kept its tab owners in memory: after a restart, the
// tabs of an agent that had exited stayed open for good.
test("a restarted daemon closes the tabs of an agent that exited meanwhile, and only those", async () => {
  const exited = Bun.spawnSync(["true"]).pid;
  const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
  writeFileSync(file, JSON.stringify({ 11: exited, 12: process.pid }));
  loadTabs(file);
  await closedAs("owned", [11]);
  await settled();
  expect(closesAs("owned")).toEqual([11]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ 12: process.pid });
});

// An agent that is done need not spend a turn on close. One it asked to
// keep is the user's.
test("an agent's tabs, and tabs they open, close once it exits; kept ones stay", async () => {
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
  await closedAs("owned", [1, 2, 4, 100]);
  await settled();
  expect(closesAs("owned")).toEqual([1, 2, 4, 11, 100]);
});

// Tabs an agent left open as it handed the turn back to the user piled up
// in his Safari until it exited. One it kept waits on his answer; one he is
// looking at stays until he leaves it.
test("when an agent's turn ends its tabs close, except one it kept, one the user has in front, and another agent's", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
  loadTabs(file);
  const [agent, other] = [Bun.spawn(["sleep", "60"]), Bun.spawn(["sleep", "60"])];
  // the tab the stand-in handed out last is the one just opened
  const open = async (who: number, args: Record<string, unknown> = {}) => {
    await runAs(who, () => callTool("open", { url: "https://example.com/", ...args }));
    return nextTab;
  };
  const done = [await open(agent.pid, { background: true }), await open(agent.pid)];
  const kept = await open(agent.pid, { background: true });
  await runAs(agent.pid, () => callTool("keep", { tab: kept }));
  hisFront = await open(agent.pid, { background: true });
  const others = await open(other.pid, { background: true });
  endTurn(agent.pid);
  await closedAs("idle", [...done, hisFront]);
  await settled();
  expect(closesAs("idle")).toEqual([...done, hisFront].sort((a, b) => a - b));
  const owners = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
  expect(owners).toMatchObject({ [hisFront]: agent.pid, [others]: other.pid });
  expect(owners).not.toContainAnyKeys([...done, kept].map(String));
  agent.kill();
  other.kill();
  await closedAs("owned", [hisFront, others]);
});

// 10-02: a repl session that ended after 30 minutes unused closed the
// TikTok sign-up its agent had kept for the user from the CLI.
test("a repl session's end closes the tabs it opened, but not one kept for the user", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  const invoke = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
  const repl = new ReplSession("kept", { cwd: mkdtempSync(join(tmpdir(), "repl-kept-")), invoke });
  await repl.run("await openTab('https://example.com/')\nawait openTab('https://example.com/')");
  const [done, kept] = repl.tabs.map((p) => p.id);
  await invoke("keep", { tab: kept });
  const before = closes.length;
  await repl.close();
  expect(closes.slice(before).filter(([tab]) => tab === done || tab === kept)).toEqual([[done]]);
  agent.kill();
});

// Late in September a chat tab closed while its agent waited 50 minutes on
// a subagent, and "that tab is gone" alone cost it 10 turns to recover.
test("a call to a tab the harness closed says why and when, and what the tab showed", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  await runAs(agent.pid, () => callTool("open", { url: "https://chat.example/c/1", background: true }));
  const tab = nextTab;
  showing = [{ id: tab, url: "https://chat.example/c/1" }];
  endTurn(agent.pid);
  await closedAs("idle", [tab]);
  await settled();
  showing = [];
  const later = runAs(agent.pid, () => callTool("extract", { tab }));
  await expect(later).rejects.toThrow(new RegExp(`^that tab is gone: tab ${tab} was closed as its agent's turn ended at .+ \\(it showed https://chat\\.example/c/1\\); open it again$`));
  agent.kill();
});

// From 09-26 to 10-05, 194 of 729 opens went to a site the same agent had
// opened earlier in its turn; on 10-05 one held tirerack.com in two tabs.
test("an open on a site where the agent already has a tab names that tab, and never another agent's", async () => {
  const [agent, other] = [Bun.spawn(["sleep", "60"]), Bun.spawn(["sleep", "60"])];
  const opened: number[] = [];
  const open = async (who: number, url: string) => {
    const { hint } = (await runAs(who, () => callTool("open", { url, background: true }))) as { hint?: string };
    opened.push(nextTab);
    showing.push({ id: nextTab, url });
    return hint;
  };
  await open(agent.pid, "https://shop.example/a");
  const mine = nextTab;
  await open(other.pid, "https://news.example/");
  expect(await open(agent.pid, "https://shop.example/b")).toContain(`tab ${mine} on shop.example`);
  expect(await open(agent.pid, "https://news.example/today")).toBeUndefined();
  agent.kill();
  other.kill();
  await closedAs("owned", opened);
  showing = [];
});

// He quit Safari: a sweep that asked it anything would start it again. An
// exited agent's tab then waits, unasked, for the extension to come back.
test("a sweep asks nothing of Safari while its extension is gone", async () => {
  bridge.detach(ext);
  const request = bridge.request;
  const asked: unknown[] = [];
  bridge.request = (...args: Parameters<typeof request>) => {
    asked.push(args[0]);
    return request.apply(bridge, args);
  };
  try {
    const [exited, marker] = [Bun.spawnSync(["true"]).pid, Bun.spawnSync(["true"]).pid];
    const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
    writeFileSync(file, JSON.stringify({ 31: exited }));
    loadTabs(file);
    // one owner sweep calls the watches in turn: the tab's came first
    await new Promise<void>((resolve) => { const stop = watchOwner(marker, () => { stop(); resolve(); }); });
    expect(asked).toEqual([]);
  } finally {
    bridge.request = request;
    connect(ext);
  }
});
