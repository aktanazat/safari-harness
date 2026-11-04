import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { callTool, endTurn, loadTabs } from "./tools.ts";

// Safari as a turn's end sees it: it lists listed; a close is noted and
// fails, is refused (an idle one, of a page the extension cannot read), or
// closes as closing says; a call to a tab finds it gone, as the extension
// says of a closed one.
let listed: { id: number; url: string; windowId: number }[] = [];
let closing: "fails" | "refuses" | "closes" = "closes";
const closes: number[] = [];
function safari() {
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      if (op === "tabs.close") {
        const tab = Number(args[0]);
        closes.push(tab);
        if (closing === "closes") listed = listed.filter((page) => page.id !== tab);
      }
      const reply = op === "tabs.close" && closing === "fails" ? { error: "Safari did not answer in 20 s" }
        : op === "tabs.close" && closing === "refuses" ? { value: { ok: false, protected: "unreadable" } }
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

// A sweep that sees no agent's turn end, as the 60 s sweeper's.
const sweepAt = (when: number) => {
  setSystemTime(new Date(when));
  return endTurn(Bun.spawnSync(["true"]).pid);
};

// On 10-13 the daemon logged 69 failed closes in 5.7 minutes, every sweep
// asking again (DaemonLogs); on 10-29 the extension had answered 19,614
// closes and opened 626 tabs in 14 hours (/health), as a refused close was
// asked again at every sweep.
test.each([{ answer: "fails", tab: 4401 }, { answer: "refuses", tab: 4402 }] as const)("an idle tab's close that $answer goes again 1, 2, 4, then every 15 minutes on, until Safari no longer shows the tab", async ({ answer, tab }) => {
  safari();
  closing = answer;
  closes.length = 0;
  listed = [{ id: tab, url: "https://a.example/", windowId: 1 }];
  const agent = Bun.spawn(["sleep", "60"]);
  try {
    holds(tab, agent.pid);
    const idle = Date.now() + 21 * 60_000;
    const tries = [];
    for (const minutes of [0, 0.9, 1, 2.9, 3, 6.9, 7, 21.9, 22, 36.9, 37]) {
      await sweepAt(idle + minutes * 60_000);
      tries.push(closes.length);
    }
    expect(tries).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
    listed = [];
    for (const minutes of [52, 67, 120]) await sweepAt(idle + minutes * 60_000);
    expect(closes).toEqual([tab, tab, tab, tab, tab, tab]);
  } finally {
    agent.kill();
    await agent.exited;
  }
});

// A refusal is the extension's for an idle close only: it closes a tab at
// its turn's end, and the wait a refusal set is not owed then.
test("a tab whose idle close was refused closes as soon as its agent's turn ends", async () => {
  safari();
  closing = "refuses";
  listed = [{ id: 4403, url: "https://a.example/", windowId: 1 }];
  const agent = Bun.spawn(["sleep", "60"]);
  try {
    holds(4403, agent.pid);
    const idle = Date.now() + 21 * 60_000;
    await sweepAt(idle);
    closing = "closes";
    setSystemTime(new Date(idle + 10_000));
    expect(await endTurn(agent.pid)).toMatchObject({ closed: 1, retained: 0 });
  } finally {
    agent.kill();
    await agent.exited;
  }
});

// On 10-16 no eBay, Depop, or Grailed search could open again after Safari
// lost its tab: its query counted as a secret (HuntsUsage).
test("a tab closed as its turn ended keeps its search, query and all, as what it showed", async () => {
  safari();
  closing = "closes";
  const [agent, other] = [Bun.spawn(["sleep", "60"]), Bun.spawn(["sleep", "60"])];
  try {
    const search = "https://www.ebay.com/sch/i.html?_nkw=arcteryx+beta&_sop=15";
    holds(4501, agent.pid, search);
    listed = [{ id: 4501, url: search, windowId: 1 }];
    expect(await endTurn(agent.pid)).toMatchObject({ closed: 1 });
    await expect(runAs(other.pid, () => callTool("extract", { tab: 4501 }))).rejects.toThrow(`(it showed ${search})`);
  } finally {
    agent.kill();
    other.kill();
    await Promise.all([agent.exited, other.exited]);
  }
});
