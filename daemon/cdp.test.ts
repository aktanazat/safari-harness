import { afterAll, expect, jest, test } from "bun:test";
import { bridge, type ExtSocket } from "./bridge.ts";
import { handleCdp, stopAllPumps } from "./cdp.ts";
import { connect } from "./fake-safari.ts";

// The extension, as a CDP client's page monitor reads a tab's console: a
// tab the user closed is gone, and a hung page never answers.
const reads: number[] = [];
const gone = new Set<number>();
const hung = new Set<number>();
const sock: ExtSocket = {
  send(data) {
    const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
    if (id === undefined) return;
    const tab = Number(args[0]);
    if (op === "relay" && args[1] === "consoleRead") reads.push(tab);
    if (hung.has(tab)) return;
    const reply = gone.has(tab) ? { error: "that tab is gone: Safari knows no tab by that id" } : { value: { entries: [] } };
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
  },
  close() {},
};
connect(sock);
afterAll(() => {
  stopAllPumps();
  jest.useRealTimers();
});

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

// The monitor reads every 800 ms.
async function ticks(n: number) {
  for (let i = 0; i < n; i++) {
    jest.advanceTimersByTime(800);
    await settled();
  }
}

const readsOf = (tab: number) => reads.filter((t) => t === tab).length;

// 10-21 audit: a monitor went on asking a closed tab for its console every
// 800 ms for as long as its client stayed connected.
test("a page monitor stops asking a tab for its console once the tab is gone", async () => {
  jest.useFakeTimers();
  await handleCdp(() => {}, { id: 1, method: "Runtime.enable" }, { kind: "page", tabId: 7, connId: 1 });
  await ticks(3);
  gone.add(7);
  const before = readsOf(7);
  await ticks(12);
  expect(readsOf(7) - before).toBe(1);
});

// A read the page leaves unanswered waits up to 32 s (bridge.tab); a read
// each 800 ms meanwhile piled up behind it.
test("a page monitor asks a hung page nothing more until its last read is answered", async () => {
  jest.useFakeTimers();
  hung.add(8);
  await handleCdp(() => {}, { id: 1, method: "Runtime.enable" }, { kind: "page", tabId: 8, connId: 2 });
  await ticks(10);
  expect(readsOf(8)).toBe(1);
});
