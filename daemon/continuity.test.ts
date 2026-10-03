import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { callTool, endTurn, formatResult, loadTabs } from "./tools.ts";

// A stand-in extension: open hands out tabs 201, 202, ...; a page op
// answers from the tab it reached, which is noted, as is each close.
const reached: number[] = [];
const closed: number[] = [];
let onClose = () => {};
let nextTab = 200;
function answer(op: string, args: unknown[]): unknown {
  if (op === "windows.open") return { windowId: 1, tabId: 900 };
  if (op === "tabs.open") return { id: ++nextTab, windowId: args[2] };
  if (op === "tabs.list" || op === "probe") return [];
  if (op === "tabs.close") {
    closed.push(Number(args[0]));
    onClose();
  }
  if (op !== "relay") return { ok: true };
  reached.push(Number(args[0]));
  if (args[1] === "snapshot") return { url: "https://a.example/", title: "A", nodes: 1, truncated: false, snapshot: "- heading \"A\"" };
  return { ok: true, url: "https://a.example/" };
}
const ext = {
  send(raw: string) {
    const { id, op, args } = JSON.parse(raw) as { id: string; op: string; args: unknown[] };
    bridge.handleMessage(JSON.stringify({ id, value: answer(op, args) }));
  },
  close() {},
};
connect(ext);
const file = join(mkdtempSync(join(tmpdir(), "continuity-")), "tabs.json");
loadTabs(file);
const owners = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, number | null>;
// what background.js sends when Safari swaps a tab, or a page opens one
const fromExtension = (event: Record<string, unknown>) => bridge.handleMessage(JSON.stringify({ op: "tab", ...event }));

const agent = Bun.spawn(["sleep", "60"]);
// Once the agent exits, the daemon closes its tabs and stops watching it; a
// watch left running would outlive this file and its timer.
afterAll(async () => {
  const mine = Object.entries(owners()).filter(([, owner]) => owner === agent.pid).map(([tab]) => Number(tab));
  const { promise, resolve } = Promise.withResolvers<void>();
  onClose = () => { if (mine.every((tab) => closed.includes(tab))) resolve(); };
  onClose();
  agent.kill();
  await promise;
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

test("a snapshot's text form carries its news above the page", async () => {
  const old = await open();
  fromExtension({ kind: "replaced", from: old, to: 253 });
  const [news, header] = formatResult(await as("snapshot", { tab: old })).split("\n");
  expect(news).toMatch(new RegExp(`\\b${old}\\b.*\\b253\\b`));
  expect(header).toBe("# A — https://a.example/ (1 nodes)");
});

test("once the extension connects again, an old id is the tab Safari gives it now", async () => {
  const old = await open();
  fromExtension({ kind: "replaced", from: old, to: 254 });
  // Its socket closes and it connects again; connections are told apart by
  // the millisecond they began.
  bridge.detach(ext);
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
  const { promise, resolve } = Promise.withResolvers<void>();
  onClose = () => { if (mine.every((tab) => closed.includes(tab))) resolve(); };
  onClose();
  endTurn(agent.pid);
  await promise;
  expect({ lines, closed: closed.filter((tab) => tab >= 270 && tab <= 272) }).toEqual({
    lines: [270, 271, 272].map((tab) => expect.stringMatching(new RegExp(`\\b${tab}\\b.*\\bstays open for the user\\b`))),
    closed: [],
  });
});

// real_input's calls to the daemon between the steps of its action opt out,
// so the news waits for the call that answers the agent (input.ts).
test("a call that opts out of news leaves the agent's popup for its next call", async () => {
  const opener = await open();
  fromExtension({ kind: "popup", tab: 280, opener, url: "https://login.example/" });
  expect(await runAs(agent.pid, () => callTool("info", { tab: opener }, false, false))).not.toHaveProperty("popup");
  expect(await as("info", { tab: opener })).toMatchObject({ popup: { tab: 280, url: "https://login.example/" } });
});
