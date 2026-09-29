import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool } from "./tools.ts";

// A stand-in extension: open hands out tabs 701, 702...; the user's own
// front tab is 700. A page set held stops answering, as a page a dialog
// holds or one stuck loading does, until it loads again. Each load is noted.
const HIS = 700;
const pages = new Map<number, { url: string; held: boolean }>([[HIS, { url: "https://his.example/", held: false }]]);
const loads: string[] = [];
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
    pages.set(id, { url: String(args[1]), held: false });
    loads.push(String(args[1]));
    return { value: { id, url: String(args[1]), title: "Page" } };
  }
  if (op === "tabs.close") {
    pages.delete(Number(args[0]));
    return { value: { ok: true } };
  }
  if (op === "probe") return { value: [] };
  if (op !== "relay") return { value: { ok: true } };
  const page = pages.get(Number(args[0]));
  if (!page) return { error: "no tab" };
  if (page.held) return { error: `the page at ${page.url} did not answer; reload it with goto and retry` };
  if (args[1] === "extract") return { value: { url: page.url, title: "Page", text: `text of ${page.url}`, truncated: false } };
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

const hold = (tab: number) => {
  const page = pages.get(tab);
  if (page) page.held = true;
};
const open = async (url: string) => {
  const t = await callTool("open", { url, background: true });
  if (!t || typeof t !== "object" || !("id" in t) || typeof t.id !== "number") throw new Error("open gave no tab");
  return t.id;
};

// On 01a0e50b pages stopped answering 27 times in one car search, and each
// time the agent loaded the page again and asked again: a turn and a goto.
test("a read of a page that stopped answering loads it again and reads it once more", async () => {
  const tab = await open("https://dealer.example/car/1");
  loads.length = 0;
  hold(tab);
  expect(await callTool("extract", { tab })).toMatchObject({ text: "text of https://dealer.example/car/1", note: expect.stringContaining("loaded again") });
  expect(loads).toEqual(["https://dealer.example/car/1"]);
  await callTool("close", { tab });
});

// Loading the page again would undo what the agent did to it: a form half
// filled is empty again.
test("a page an action changed since it loaded is left to the agent, and a goto makes it fresh again", async () => {
  const tab = await open("https://insurer.example/quote");
  await callTool("click", { tab, ref: "Next" });
  loads.length = 0;
  hold(tab);
  await expect(callTool("extract", { tab })).rejects.toThrow("did not answer");
  expect(loads).toEqual([]);
  await callTool("goto", { tab, url: "https://insurer.example/start" });
  hold(tab);
  expect(await callTool("extract", { tab })).toMatchObject({ text: "text of https://insurer.example/start" });
  expect(loads).toEqual(["https://insurer.example/start", "https://insurer.example/start"]);
  await callTool("close", { tab });
});

test("the user's own tab is never loaded again, named as front or by its id", async () => {
  loads.length = 0;
  hold(HIS);
  await expect(callTool("extract", { tab: "front" })).rejects.toThrow("did not answer");
  await expect(callTool("extract", { tab: HIS })).rejects.toThrow("did not answer");
  expect(loads).toEqual([]);
});
