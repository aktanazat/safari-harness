// cookies with do: "clear" makes Safari forget one site, so a sign-up can
// start over (clearSite in tools.ts). On 10-02 an agent made TikTok forget
// a failed sign-up in Safari's settings, a row at a time, while the site's
// open tabs set its cookies again.

import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { callTool } from "./tools.ts";

// A stand-in extension. showing is Safari's tab list: the user's tabs in his
// window 7000, and the tabs the harness opens, from 1, in the agent's. A page
// opened on the bare site lands on www, as tiktok.com's does. sent lists the
// requests in order.
type Shown = { id: number; url: string; windowId: number };
const sent: { op: string; args: unknown[] }[] = [];
let showing: Shown[] = [];
let nextTab = 0;
let nextWindow = 0;
function answer(op: string, args: unknown[]): unknown {
  if (op === "windows.open") return { windowId: ++nextWindow, tabId: 900 + nextWindow };
  if (op === "tabs.open") {
    const tab = { id: ++nextTab, url: String(args[0]).replace(/^https:\/\/tiktok\.com\//, "https://www.tiktok.com/"), windowId: Number(args[2]) };
    showing.push(tab);
    return tab;
  }
  if (op === "tabs.list") return showing;
  if (op === "tabs.close") {
    showing = showing.filter((t) => t.id !== args[0]);
    return { ok: true };
  }
  if (op === "relay" && args[1] === "tabInfo") return { url: showing.find((t) => t.id === args[0])?.url };
  if (op === "storage.clear") return { origin: new URL(showing.find((t) => t.id === args[0])?.url ?? "").origin };
  if (op === "cookies.clear") return { removed: 5, left: 0 };
  if (op === "probe") return [];
  return { ok: true };
}
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    sent.push({ op, args });
    bridge.handleMessage(JSON.stringify({ id, value: answer(op, args) }));
  },
  close() {},
});

// What changes Safari: a page opened or closed, storage or cookies cleared.
const CHANGES = ["tabs.open", "tabs.close", "storage.clear", "cookies.clear"];
const changes = () => sent.map((m) => m.op).filter((op) => CHANGES.includes(op));

async function opened(agent: number, url: string): Promise<number> {
  await runAs(agent, () => callTool("open", { url, background: true }));
  return nextTab;
}

// A clear would sign the user out of the site in his own tabs, and his open
// pages would set its cookies again at once.
test("a clear is refused while the user has the site open, naming each of his tabs by id and origin, and changes nothing", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  showing = [
    { id: 7001, url: "https://www.tiktok.com/foryou?lang=en", windowId: 7000 },
    { id: 7002, url: "https://m.tiktok.com/v/1", windowId: 7000 },
    { id: 7003, url: "https://example.com/", windowId: 7000 },
  ];
  sent.length = 0;
  await expect(runAs(agent.pid, () => callTool("cookies", { do: "clear", url: "https://www.tiktok.com/signup" }))).rejects.toThrow("tab 7001 https://www.tiktok.com, tab 7002 https://m.tiktok.com");
  expect(changes()).toEqual([]);
  agent.kill();
});

test("a clear closes the agent's tabs on the site, and only those, and says which", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  showing = [{ id: 7003, url: "https://example.com/", windowId: 7000 }];
  const signup = await opened(agent.pid, "https://www.tiktok.com/signup");
  const help = await opened(agent.pid, "https://support.tiktok.com/en");
  const elsewhere = await opened(agent.pid, "https://example.com/");
  const answer = (await runAs(agent.pid, () => callTool("cookies", { do: "clear", tab: signup }))) as { tabsClosed?: number[] };
  expect(answer.tabsClosed).toEqual([signup, help]);
  expect(showing.map((t) => t.id)).toEqual([7003, elsewhere]);
  await runAs(agent.pid, () => callTool("close", { tab: elsewhere }));
  agent.kill();
});

test("a clear says what it did: cookies removed and left, origins emptied, and those it could not reach", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  showing = [];
  const tab = await opened(agent.pid, "https://m.tiktok.com/signup");
  expect(await runAs(agent.pid, () => callTool("cookies", { do: "clear", tab }))).toMatchObject({
    site: "tiktok.com",
    cookiesRemoved: 5,
    cookiesLeft: 0,
    originsCleared: ["https://m.tiktok.com", "https://www.tiktok.com"],
    notReached: ["https://tiktok.com: its page went to https://www.tiktok.com"],
    tabsClosed: [tab],
  });
  agent.kill();
});

// A page that loads, or closes, can set the site's cookies again.
test("a clear removes the cookies last, after every page it opened or closed", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  showing = [];
  const tab = await opened(agent.pid, "https://www.tiktok.com/signup");
  sent.length = 0;
  await runAs(agent.pid, () => callTool("cookies", { do: "clear", tab }));
  expect(changes().at(-1)).toBe("cookies.clear");
  expect(changes()).toContain("tabs.close");
  agent.kill();
});
