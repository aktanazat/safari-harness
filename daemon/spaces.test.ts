import { expect, test } from "bun:test";
import { bridge, type ExtSocket } from "./bridge.ts";
import { runAs } from "./owner.ts";
import { openTab } from "./tools.ts";

type Tab = { id: number; url: string; windowId: number; active: boolean };

// Safari as the extension reports it, with the user's window 1 open.
function safari() {
  const tabs = new Map<number, Tab>([[1, { id: 1, url: "https://his.example/", windowId: 1, active: true }]]);
  const closed: number[] = [];
  let next = 100;
  const ops: Record<string, (args: unknown[]) => unknown> = {
    "tabs.list": () => [...tabs.values()],
    "tabs.open": ([url, background, windowId]) => {
      const t = { id: next++, url: String(url), windowId: typeof windowId === "number" ? windowId : 1, active: !background };
      tabs.set(t.id, t);
      return t;
    },
    "windows.open": ([url]) => {
      const t = { id: next++, url: String(url), windowId: next++, active: true };
      tabs.set(t.id, t);
      return { windowId: t.windowId, tabId: t.id };
    },
    "tabs.close": ([id]) => {
      tabs.delete(id as number);
      closed.push(id as number);
      return { ok: true };
    },
  };
  const sock: ExtSocket = {
    send(data) {
      const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
      if (id !== undefined) queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value: ops[op](args) })));
    },
    close() {},
  };
  bridge.attach(sock);
  return { tabs, closed };
}

// An agent process, to open tabs for and then end.
const agent = () => Bun.spawn(["sleep", "60"]);

// A window closes up when owner.ts sees its agent's process gone, which it
// checks against the kernel once a second; there is no clock to fake there,
// so this polls for the result.
async function until(ok: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

test("each agent's tabs open in a window of its own, never the user's, and a task's later tabs join its window", async () => {
  safari();
  const [a, b] = [agent(), agent()];
  const a1 = await runAs(a.pid, () => openTab("https://a.example/1", true));
  const a2 = await runAs(a.pid, () => openTab("https://a.example/2", true));
  const b1 = await runAs(b.pid, () => openTab("https://b.example/1", true));
  const b2 = await runAs(b.pid, () => openTab("https://b.example/2", true, "research"));
  expect([a1, a2, b1, b2].map((t) => t.windowId)).not.toContain(1);
  expect(a2.windowId).toBe(a1.windowId);
  expect(b1.windowId).not.toBe(a1.windowId);
  expect(b2.windowId).not.toBe(b1.windowId);
  a.kill();
  b.kill();
});

test("when an agent exits its window's blank tab closes, and a tab it opened for the user stays", async () => {
  const s = safari();
  const c = agent();
  const his = await runAs(c.pid, () => openTab("https://hotel.example/booking", false));
  const blank = [...s.tabs.values()].find((t) => t.windowId === his.windowId && t.url === "about:blank")!;
  c.kill();
  await until(() => s.closed.includes(blank.id));
  expect(s.tabs.has(his.id)).toBe(true);
  expect(s.closed).not.toContain(his.id);
});

test("an agent whose window the user closed gets a new one on its next open", async () => {
  const s = safari();
  const d = agent();
  const first = await runAs(d.pid, () => openTab("https://d.example/1", true));
  for (const t of [...s.tabs.values()]) if (t.windowId === first.windowId) s.tabs.delete(t.id);
  const next = await runAs(d.pid, () => openTab("https://d.example/2", true));
  expect(next.windowId).not.toBe(first.windowId);
  expect(next.windowId).not.toBe(1);
  d.kill();
});
