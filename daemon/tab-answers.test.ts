// What a call on a tab answers when the tab is not what the agent expects:
// closed already, or showing its site's error page.
//
// On 10-16 `safari close 5203` failed "that tab is gone" after the repl had
// closed the tab, and a hunt's eBay searches answered "Error Page | eBay",
// which open returned as a page like any other (HuntsUsage).

import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { callTool, endTurn } from "./tools.ts";

// A stand-in extension. showing is Safari's tab list; a tab it no longer
// has answers as the extension's own "that tab is gone" does.
type Shown = { id: number; url: string; title: string; windowId: number };
let showing: Shown[] = [];
let nextTab = 7100;
let nextWindow = 7100;
const GONE = "that tab is gone: the harness closed it 0 s ago; find it with tabs, or open it again";

function answer(op: string, args: unknown[]): { value: unknown } | { error: string } {
  if (op === "windows.open") {
    const page = { id: 9100 + ++nextWindow, url: String(args[0]), title: "agent window", windowId: nextWindow };
    showing.push(page);
    return { value: { windowId: page.windowId, tabId: page.id } };
  }
  if (op === "tabs.open") {
    const url = String(args[0]);
    const tab = { id: ++nextTab, url, title: url.includes("ebay.com") ? "Error Page | eBay" : "Example Domain", windowId: Number(args[2]) };
    showing.push(tab);
    return { value: tab };
  }
  if (op === "tabs.list") return { value: showing };
  const row = showing.find((t) => t.id === Number(args[0]));
  if (op === "tabs.close") {
    if (!row) return { error: GONE };
    showing = showing.filter((t) => t !== row);
    return { value: { ok: true } };
  }
  if (op === "relay" && !row) return { error: GONE };
  if (op === "relay" && args[1] === "tabInfo") return { value: { url: row?.url, title: row?.title } };
  if (op === "relay" && args[1] === "probe") return { value: [] };
  return { value: { ok: true } };
}
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    bridge.handleMessage(JSON.stringify({ id, ...answer(op, args) }));
  },
  close() {},
});

test("a close of a tab the harness closed already answers ok at once, saying when it closed", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  await runAs(agent.pid, () => callTool("open", { url: "https://example.com/", background: true }));
  const tab = nextTab;
  await runAs(agent.pid, () => callTool("close", { tab }));
  const again = await runAs(agent.pid, () => callTool("close", { tab }));
  expect(again).toMatchObject({ ok: true, already: expect.stringMatching(new RegExp(`^tab ${tab} was closed by a close call at .+`)) });
  agent.kill();
});

test("open answers a page its site's guide names as the error page as not ok, and names the guide", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  const errored = await runAs(agent.pid, () => callTool("open", { url: "https://www.ebay.com/sch/i.html?_nkw=jacket", background: true }));
  const erroredTab = nextTab;
  expect(errored).toMatchObject({ ok: false, warning: expect.stringContaining('answered with its error page ("Error Page | eBay"), not the page asked for; safari guide ebay says what to try') });
  const fine = await runAs(agent.pid, () => callTool("open", { url: "https://example.com/", background: true, new: true }));
  expect(fine).not.toMatchObject({ ok: false });
  // the tabs close here, so no later file's cleanup of exited agents meets them
  for (const tab of [erroredTab, nextTab]) await runAs(agent.pid, () => callTool("close", { tab }));
  agent.kill();
});

// On 10-23 an agent was told "a tab you need past your turn must be kept
// with keep" of tab 284602, the page of a window another agent's ended
// task had held: nothing said whose it was.
test("a call on the page of another agent's ended window names that agent and that the window closed", async () => {
  const [mine, theirs] = [Bun.spawn(["sleep", "60"]), Bun.spawn(["sleep", "60"])];
  const opened = await runAs(theirs.pid, () => callTool("open", { url: "https://example.com/window", background: true })) as { windowId: number };
  const page = showing.find((t) => t.windowId === opened.windowId && t.url.includes("/space?"))!;
  await endTurn(theirs.pid);
  await expect(runAs(mine.pid, () => callTool("snapshot", { tab: page.id }))).rejects.toThrow(`that tab is gone: agent ${theirs.pid}'s tab ${page.id} was closed with its window, as its agent's turn ended at `);
  mine.kill();
  theirs.kill();
});
