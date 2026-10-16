import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { callTool, endTurn, loadTabs } from "./tools.ts";

// Safari as a turn's end sees it: it lists listed; a close is noted and
// fails or closes as closing says; a call to a tab finds it gone, as the
// extension says of a closed one.
let listed: { id: number; url: string; windowId: number }[] = [];
let closing: "fails" | "closes" = "closes";
const closes: number[] = [];
function safari() {
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      if (op === "tabs.close") closes.push(Number(args[0]));
      const reply = op === "tabs.close" && closing === "fails" ? { error: "Safari did not answer in 20 s" }
        : op === "tabs.list" ? { value: listed }
        : op === "relay" ? { error: "that tab is gone: it was closed at the end of your turn, after 20 minutes unused, or by the user" }
        : { value: { ok: true } };
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
    },
    close() {},
  });
}
afterEach(() => setSystemTime());

// The harness holds tab for owner, showing url, as a daemon that started
// again reads it from its file.
function holds(tab: number, owner: number, url?: string) {
  const file = join(mkdtempSync(join(tmpdir(), "tools-close-")), "tabs.json");
  writeFileSync(file, JSON.stringify({ version: 2, tabs: { [tab]: { owner, used: Date.now(), ...(url === undefined ? {} : { url }) } } }));
  loadTabs(file);
}

// On 10-13 the daemon logged 69 failed closes in 5.7 minutes, every sweep
// asking again (DaemonLogs).
test("a turn-end close that threw is tried again 1, 2, then 4 minutes on, then not again until its agent calls again", async () => {
  safari();
  closing = "fails";
  closes.length = 0;
  listed = [];
  const agent = Bun.spawn(["sleep", "60"]);
  holds(4401, agent.pid);
  const start = Date.now();
  const closesAt = async (minutes: number) => {
    setSystemTime(new Date(start + minutes * 60_000));
    await endTurn(agent.pid);
    return closes.length;
  };
  const tries = [];
  for (const minutes of [0, 0.9, 1, 2.9, 3, 6.9, 7, 60]) tries.push(await closesAt(minutes));
  expect(tries).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  await runAs(agent.pid, () => callTool("tabs", {}));
  closing = "closes";
  expect(await closesAt(60)).toBe(5);
  expect(closes.every((tab) => tab === 4401)).toBe(true);
  expect(await endTurn(agent.pid)).toMatchObject({ closed: 0, retained: 0 });
  agent.kill();
});

// On 10-16 no eBay, Depop, or Grailed search could open again after Safari
// lost its tab: its query counted as a secret (HuntsUsage).
test("a tab closed as its turn ended keeps its search, query and all, as what it showed", async () => {
  safari();
  closing = "closes";
  const [agent, other] = [Bun.spawn(["sleep", "60"]), Bun.spawn(["sleep", "60"])];
  const search = "https://www.ebay.com/sch/i.html?_nkw=arcteryx+beta&_sop=15";
  holds(4501, agent.pid, search);
  listed = [{ id: 4501, url: search, windowId: 1 }];
  expect(await endTurn(agent.pid)).toMatchObject({ closed: 1 });
  listed = [];
  await expect(runAs(other.pid, () => callTool("extract", { tab: 4501 }))).rejects.toThrow(`(it showed ${search})`);
  agent.kill();
  other.kill();
});
