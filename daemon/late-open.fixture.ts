import { jest } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool, endTurn, loadTabs } from "./tools.ts";
import { runAs } from "./owner.ts";
import { files } from "./groups.ts";

const [directory, mode, who] = process.argv.slice(2);
const owner = Number(who);
const task = `late-${mode}`;
const file = join(directory, "tabs.json");
Object.assign(files, { queue: join(directory, "groups.json"), off: join(directory, "off.json"), keeper: join(directory, "keeper.pid"), log: join(directory, "keeper.log") });
writeFileSync(files.off, JSON.stringify({ why: "isolated late-open fixture" }));
type SavedTab = { owner?: number | null; task?: string; url?: string; done?: true };
const savedTabs = () => {
  const saved: { tabs: Record<string, SavedTab> } = JSON.parse(readFileSync(file, "utf8"));
  return saved.tabs;
};
const settled = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};
let socket: ExtSocket;
let result: Record<string, unknown>;
jest.useFakeTimers();
loadTabs(file);

if (mode === "retry" || mode === "stale-list") {
  const olderListing = mode === "stale-list";
  const tab = 970001;
  let openId = "";
  let listId = "";
  let listed = false;
  let present = true;
  let closes = 0;
  const ext: ExtSocket = {
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      if (op === "tabs.open") { openId = id; return; }
      if (op === "tabs.list" && olderListing && !listed) {
        listed = true;
        listId = id;
        return;
      }
      if (op === "tabs.close" && args[0] === tab) {
        if (++closes === 1) {
          bridge.handleMessage(JSON.stringify({ id, error: `Safari did not close tab ${tab}` }), ext);
          return;
        }
        present = false;
      }
      const value = op === "tabs.list" ? present ? [{ id: tab, url: "https://late.example/", windowId: 17 }] : [] : { ok: true };
      bridge.handleMessage(JSON.stringify({ id, value }), ext);
    },
    close() {},
  };
  socket = ext;
  connect(ext);
  await settled();
  const sweeping = olderListing ? endTurn(999999) : Promise.resolve();
  await settled();
  const failed = runAs(owner, () => bridge.request("tabs.open", ["https://late.example/", true, 17, true], 5), task).catch((e: unknown) => e);
  await settled();
  jest.advanceTimersByTime(5);
  const failure = await failed;
  bridge.handleMessage(JSON.stringify({ id: openId, value: { id: tab, url: "https://late.example/", windowId: 17 } }), ext);
  if (olderListing) bridge.handleMessage(JSON.stringify({ id: listId, value: [] }), ext);
  await sweeping;
  await settled();
  const beforeRetry = { page: present, saved: savedTabs()[tab] ?? null };
  jest.advanceTimersByTime(60_000);
  await endTurn(999999);
  await settled();
  result = {
    timeout: failure instanceof Error ? failure.message : null,
    beforeRetry,
    afterRetry: { page: present, tracked: Object.hasOwn(savedTabs(), tab) },
  };
} else if (mode === "blocked-list" || mode === "reconnect") {
  const tab = 970100;
  const pages = new Map<number, { id: number; url: string; windowId: number }>();
  let openId = "";
  let late = false;
  let blockLists = false;
  let blockedList = false;
  let listSettled = false;
  let closes = 0;
  const ext: ExtSocket = {
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      if (op === "tabs.open" && late) { openId = id; return; }
      if (op === "tabs.list" && blockLists) { blockedList = true; return; }
      if (op === "tabs.close") {
        if (args[0] === tab && ++closes === 1 && mode === "reconnect") {
          bridge.handleMessage(JSON.stringify({ id, error: `Safari did not close tab ${tab}` }), ext);
          return;
        }
        pages.delete(Number(args[0]));
      }
      if (op === "windows.open") pages.set(970200, { id: 970200, url: String(args[0]), windowId: 17 });
      if (op === "tabs.open") pages.set(970099, { id: 970099, url: String(args[0]), windowId: 17 });
      const value = op === "windows.open" ? { windowId: 17, tabId: 970200 }
        : op === "tabs.open" ? pages.get(970099)
        : op === "tabs.list" ? [...pages.values()]
        : op === "probe" ? [] : { ok: true };
      bridge.handleMessage(JSON.stringify({ id, value }), ext);
    },
    close() {},
  };
  socket = ext;
  connect(ext);
  await runAs(owner, () => callTool("open", { url: "https://normal.example/", background: true }), task);
  late = true;
  const failed = runAs(owner, () => bridge.request("tabs.open", ["https://late.example/", true, 17, true], 5), task).catch((e: unknown) => e);
  await settled();
  jest.advanceTimersByTime(5);
  const failure = await failed;
  blockLists = mode === "blocked-list";
  if (blockLists) {
    void bridge.request("tabs.list").then(() => { listSettled = true; }, () => { listSettled = true; });
    await settled();
  }
  pages.set(tab, { id: tab, url: "https://late.example/", windowId: 17 });
  bridge.handleMessage(JSON.stringify({ id: openId, value: pages.get(tab) }), ext);
  await settled();
  const beforeRetry = { page: pages.has(tab), saved: savedTabs()[tab] ?? null };
  if (mode === "reconnect") {
    bridge.detach(ext);
    jest.advanceTimersByTime(60_000);
    connect(ext);
    await endTurn(999999);
    await settled();
  }
  result = {
    timeout: failure instanceof Error ? failure.message : null,
    beforeRetry,
    listing: { requested: blockedList, settled: listSettled },
    afterRetry: { page: pages.has(tab), tracked: Object.hasOwn(savedTabs(), tab) },
  };
} else {
  throw new Error(`unknown late-open fixture mode: ${mode}`);
}

console.log(JSON.stringify(result));
bridge.detach(socket);
process.exit(0);
