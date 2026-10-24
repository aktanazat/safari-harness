import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge, type TabEvent } from "./bridge.ts";
import { connect, historyFixture } from "./fake-safari.ts";
import { runAs, watchOwner } from "./owner.ts";
import { callTool, endTurn, formatResult, loadTabs } from "./tools.ts";

// A stand-in extension: open hands out tabs 201, 202, ...; a page op
// answers from the tab it reached, which is noted, as is each close.
const reached: number[] = [];
const closed: number[] = [];
const tabs = new Map<number, { id: number; url: string; windowId: number }>();
const history = historyFixture();
let nextWindow = 0;
let nextMarker = 900;
let nextTab = 200;
function answer(op: string, args: unknown[]): unknown {
  if (op === "windows.open") {
    const tab = { id: ++nextMarker, url: String(args[0]), windowId: ++nextWindow };
    tabs.set(tab.id, tab);
    return { windowId: tab.windowId, tabId: tab.id };
  }
  if (op === "windows.resolve") return [...tabs.values()].some((tab) => tab.windowId === args[0]) ? args[0] : null;
  if (op === "tabs.open") {
    const tab = { id: ++nextTab, url: String(args[0]), windowId: Number(args[2]) };
    tabs.set(tab.id, tab);
    return tab;
  }
  if (op === "tabs.list") return [...tabs.values()];
  if (op === "probe") return [];
  if (op === "tabs.close") {
    const tab = Number(args[0]);
    if (!tabs.delete(tab)) throw new Error("that tab is gone");
    closed.push(tab);
  }
  if (op !== "relay") return { ok: true };
  const tab = tabs.get(Number(args[0]));
  if (!tab) throw new Error("that tab is gone");
  if (args[1] === "eval" && new URL(tab.url).pathname === "/space") {
    return { ok: true, result: history(tab.id, String((args[2] as unknown[])[0])) };
  }
  reached.push(tab.id);
  if (args[1] === "snapshot") return { url: tab.url, title: "A", nodes: 1, truncated: false, snapshot: "- heading \"A\"" };
  return { ok: true, url: tab.url };
}
const ext = {
  send(raw: string) {
    const { id, op, args } = JSON.parse(raw) as { id: string; op: string; args: unknown[] };
    try {
      bridge.handleMessage(JSON.stringify({ id, value: answer(op, args) }));
    } catch (error) {
      bridge.handleMessage(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
    }
  },
  close() {},
};
connect(ext);
const file = join(mkdtempSync(join(tmpdir(), "continuity-")), "tabs.json");
loadTabs(file);
const owners = () => Object.fromEntries(Object.entries(JSON.parse(readFileSync(file, "utf8")).tabs as Record<string, { owner: number | null }>).map(([tab, t]) => [tab, t.owner]));
// what background.js sends when Safari swaps a tab, or a page opens one
const fromExtension = (event: Exclude<TabEvent, { kind: "renumbered" }>) => {
  if (event.kind === "replaced") {
    const tab = tabs.get(event.from)!;
    tabs.delete(event.from);
    tabs.set(event.to, { ...tab, id: event.to });
  } else {
    const opener = tabs.get(event.opener)!;
    tabs.set(event.tab, { id: event.tab, url: event.url, windowId: opener.windowId });
  }
  bridge.handleMessage(JSON.stringify({ op: "tab", ...event }));
};

const agent = Bun.spawn(["sleep", "60"]);
// Exit alone is not task authority. The fixture explicitly admits cleanup
// before it releases its owned resources.
afterAll(async () => {
  try {
    const receipt = await endTurn(agent.pid);
    expect(receipt.failed).toBe(0);
  } finally {
    agent.kill();
    await agent.exited;
  }
});
const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
// the tab the stand-in handed out last is the one just opened
const open = async (background = true, keep = false) => {
  await as("open", { url: "https://a.example/", background, keep });
  return nextTab;
};

test("a call with a replaced tab's old id reaches its newest tab and says so, and the newest id keeps the owner", async () => {
  const old = await open();
  fromExtension({ kind: "replaced", from: old, to: 250 });
  fromExtension({ kind: "replaced", from: 250, to: 251 });
  expect(await as("info", { tab: old })).toMatchObject({ replaced: { from: old, to: 251 } });
  expect(reached.at(-1)).toBe(251);
  expect(owners()).toMatchObject({ 251: agent.pid });
  expect(owners()).not.toContainKeys([String(old), "250"]);
});

test("close with a replaced tab's old id closes its new tab and forgets it", async () => {
  const old = await open();
  fromExtension({ kind: "replaced", from: old, to: 252 });
  await as("close", { tab: old });
  expect(closed.at(-1)).toBe(252);
  expect(owners()).not.toContainKey("252");
});


test("once the extension connects again, an old id is the tab Safari gives it now", async () => {
  const old = await open();
  fromExtension({ kind: "replaced", from: old, to: 254 });
  // Its socket closes and it connects again; connections are told apart by
  // the millisecond they began.
  bridge.detach(ext);
  tabs.set(old, { id: old, url: "https://a.example/", windowId: ++nextWindow });
  for (const began = Date.now(); Date.now() === began; );
  connect(ext);
  expect(await as("info", { tab: old })).not.toHaveProperty("replaced");
  expect(reached.at(-1)).toBe(old);
});

test("a popup an agent's tab opens on its own is that agent's, and its next result, only, says so", async () => {
  const opener = await open();
  fromExtension({ kind: "popup", tab: 260, opener, url: "https://login.example/" });
  expect(owners()).toMatchObject({ 260: agent.pid });
  // another agent's call does not hear of it
  expect(await runAs(process.pid, () => callTool("info", { tab: opener }))).not.toHaveProperty("popup");
  expect(await as("info", { tab: opener })).toMatchObject({ popup: { tab: 260, url: "https://login.example/" } });
  expect(await as("info", { tab: opener })).not.toHaveProperty("popup");
});

// On 10-02 an agent kept a TikTok sign-up for the user. Before, a popup a
// kept tab opened was reported to no one, that agent included.
test("popups from a tab an agent kept, and theirs, reach that agent's next results as the user's, and stay open as its turn ends", async () => {
  const kept = await open();
  await as("keep", { tab: kept });
  const keptAtOpen = await open(true, true);
  fromExtension({ kind: "popup", tab: 270, opener: kept, url: "https://accounts.example/" });
  fromExtension({ kind: "popup", tab: 271, opener: 270, url: "https://accounts.example/passkey" });
  fromExtension({ kind: "popup", tab: 272, opener: keptAtOpen, url: "https://pay.example/" });
  const news = async () => formatResult(await as("info", { tab: kept })).split("\n")[0];
  const lines = [await news(), await news(), await news()];
  const mine = Object.entries(owners()).filter(([, owner]) => owner === agent.pid).map(([tab]) => Number(tab));
  const receipt = await endTurn(agent.pid);
  expect(receipt).toMatchObject({ closed: mine.length, retained: 0, failed: 0 });
  expect(closed).toEqual(expect.arrayContaining(mine));
  expect([...tabs.keys()]).toEqual(expect.arrayContaining([kept, keptAtOpen, 270, 271, 272]));
  expect({ lines, closed: closed.filter((tab) => tab >= 270 && tab <= 272) }).toEqual({
    lines: [270, 271, 272].map((tab) => expect.stringMatching(new RegExp(`\\b${tab}\\b.*\\bstays open for the user\\b`))),
    closed: [],
  });
});

// A pid comes back as another process's: a popup its agent's page opened
// after the agent's last call went, before, to that later process's call.
test("a popup its agent exited without hearing of is news to no later caller with that agent's pid", async () => {
  const gone = Bun.spawn(["sleep", "60"]);
  await runAs(gone.pid, () => callTool("open", { url: "https://a.example/", background: true }));
  fromExtension({ kind: "popup", tab: 290, opener: nextTab, url: "https://login.example/" });
  gone.kill();
  await gone.exited;
  // owner.ts looks for exits once a second, and calls the daemon's watch first
  const { promise: seen, resolve } = Promise.withResolvers<void>();
  watchOwner(gone.pid, resolve);
  await seen;
  const later = await open();
  expect(await runAs(gone.pid, () => callTool("info", { tab: later }))).not.toHaveProperty("popup");
});

// real_input's calls to the daemon between the steps of its action opt out,
// so the news waits for the call that answers the agent (input.ts).
test("a call that opts out of news leaves the agent's popup for its next call", async () => {
  const opener = await open();
  fromExtension({ kind: "popup", tab: 280, opener, url: "https://login.example/" });
  expect(await runAs(agent.pid, () => callTool("info", { tab: opener }, false, false))).not.toHaveProperty("popup");
  expect(await as("info", { tab: opener })).toMatchObject({ popup: { tab: 280, url: "https://login.example/" } });
});
