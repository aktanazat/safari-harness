import { afterAll, expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs, watchOwner } from "./owner.ts";
import { callTool, endTurn } from "./tools.ts";

// A stand-in extension: open hands out tabs 701, 702...; the user's own
// front tab is 700. A page set held stops answering, as a page a dialog
// holds or one stuck loading does, until it loads again. Each load is noted.
// An address in walledLoads loads behind Cloudflare's wall, which lets the
// browser through after two looks at it.
const HIS = 700;
const pages = new Map<number, { url: string; held: boolean; wall?: number }>([[HIS, { url: "https://his.example/", held: false }]]);
const loads: string[] = [];
const walledLoads = new Set<string>();
let nextTab = HIS;

function answer(op: string, args: unknown[]): { value?: unknown; error?: string } {
  if (op === "windows.open") return { value: { windowId: 70, tabId: 799 } };
  if (op === "tabs.open") {
    const id = ++nextTab;
    pages.set(id, { url: String(args[0]), held: false });
    return { value: { id, windowId: args[2], url: String(args[0]) } };
  }
  if (op === "tabs.list") return { value: [...pages].map(([id, p]) => ({ id, url: p.url, title: "Page", front: id === HIS })) };
  if (op === "tabs.navigate") {
    const id = Number(args[0]);
    pages.set(id, { url: String(args[1]), held: false, ...(walledLoads.has(String(args[1])) ? { wall: 2 } : {}) });
    loads.push(String(args[1]));
    return { value: { id, url: String(args[1]), title: "Page" } };
  }
  if (op === "tabs.close") {
    pages.delete(Number(args[0]));
    return { value: { ok: true } };
  }
  if (op === "probe") {
    const page = pages.get(Number(args[0]));
    if (page?.wall === undefined) return { value: [] };
    const walled = page.wall > 0;
    if (walled) page.wall--;
    return { value: [{ frame: 0, url: page.url, title: walled ? "Just a moment..." : "Page", text: "", markers: [], answered: [], frames: [] }] };
  }
  if (op !== "relay") return { value: { ok: true } };
  const page = pages.get(Number(args[0]));
  if (!page) return { error: "no tab" };
  if (page.held) return { error: `the page at ${page.url} did not answer; reload it with goto and retry` };
  if (args[1] === "extract") return { value: { url: page.url, title: "Page", text: page.wall ? "Checking your browser" : `text of ${page.url}`, truncated: false } };
  return { value: { ok: true } };
}

connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const reply = answer(op, args);
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
  },
  close() {},
});

// The calls run as an agent whose turn ends with the file, so the window
// its tabs open in closes then: a window no turn's end can close stays
// watched, and its sweep asked later files' Safari for its tabs. The agent
// then exits, and the file waits until the daemon has seen it go, so no
// watch on it outlasts the file (owner.test.ts runs watches on a fake clock).
const agent = Bun.spawn(["sleep", "60"]);
const call = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
afterAll(async () => {
  await endTurn(agent.pid);
  agent.kill();
  await agent.exited;
  await new Promise<void>((gone) => watchOwner(agent.pid, gone));
});

const hold = (tab: number) => {
  const page = pages.get(tab);
  if (page) page.held = true;
};
const open = async (url: string) => {
  const t = await call("open", { url, background: true });
  if (!t || typeof t !== "object" || !("id" in t) || typeof t.id !== "number") throw new Error("open gave no tab");
  return t.id;
};

// On 01a0e50b pages stopped answering 27 times in one car search, and each
// time the agent loaded the page again and asked again: a turn and a goto.
test("a read of a page that stopped answering loads it again and reads it once more", async () => {
  const tab = await open("https://dealer.example/car/1");
  loads.length = 0;
  hold(tab);
  expect(await call("extract", { tab })).toMatchObject({ text: "text of https://dealer.example/car/1", note: expect.stringContaining("loaded again") });
  expect(loads).toEqual(["https://dealer.example/car/1"]);
  await call("close", { tab });
});

// The read asked again reads what a goto would have answered: a wall that
// lets the browser through is waited out, not read as the page.
test("a page that loads again behind a check that clears by itself is read once the check is gone", async () => {
  const url = "https://parts.example/item/7";
  const tab = await open(url);
  walledLoads.add(url);
  hold(tab);
  expect(await call("extract", { tab })).toMatchObject({ text: `text of ${url}`, note: expect.stringContaining("loaded again") });
  walledLoads.delete(url);
  await call("close", { tab });
});

// Loading the page again would undo what the agent did to it: a form half
// filled is empty again.
test("a page an action changed since it loaded is left to the agent, and a goto makes it fresh again", async () => {
  const tab = await open("https://insurer.example/quote");
  await call("click", { tab, ref: "Next" });
  loads.length = 0;
  hold(tab);
  await expect(call("extract", { tab })).rejects.toThrow("did not answer");
  expect(loads).toEqual([]);
  await call("goto", { tab, url: "https://insurer.example/start" });
  hold(tab);
  expect(await call("extract", { tab })).toMatchObject({ text: "text of https://insurer.example/start" });
  expect(loads).toEqual(["https://insurer.example/start", "https://insurer.example/start"]);
  await call("close", { tab });
});

test("the user's own tab is never loaded again, named as front or by its id", async () => {
  loads.length = 0;
  hold(HIS);
  await expect(call("extract", { tab: "front" })).rejects.toThrow("did not answer");
  await expect(call("extract", { tab: HIS })).rejects.toThrow("did not answer");
  expect(loads).toEqual([]);
});
