import { afterAll, expect, jest, test } from "bun:test";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { missionRoute, watched } from "./mission.ts";
import { runAs } from "./owner.ts";
import { callTool } from "./tools.ts";

type Tab = { id: number; url: string; title: string; windowId: number; active: boolean };

// Safari with the user's window 1, counting the times it is asked for every tab.
function safari() {
  const tabs = new Map<number, Tab>([[1, { id: 1, url: "https://his.example/", title: "His page", windowId: 1, active: true }]]);
  let next = 100;
  let lists = 0;
  const ops: Record<string, (args: unknown[]) => unknown> = {
    "tabs.list": () => {
      lists++;
      return [...tabs.values()];
    },
    "tabs.open": ([url, background, windowId]) => {
      const t = { id: next++, url: String(url), title: "A page", windowId: windowId as number, active: !background };
      tabs.set(t.id, t);
      return t;
    },
    "windows.open": ([url]) => {
      const t = { id: next++, url: String(url), title: "", windowId: next++, active: true };
      tabs.set(t.id, t);
      return { windowId: t.windowId, tabId: t.id };
    },
    "windows.resolve": ([id]) => ([...tabs.values()].some((t) => t.windowId === id) ? id : null),
    "tabs.close": ([id]) => {
      tabs.delete(id as number);
      return { ok: true };
    },
    dialogs: () => ({ ok: true }),
    probe: () => [],
    relay: ([tab]) => {
      const t = tabs.get(tab as number);
      if (!t) throw new Error(`no tab ${tab}`);
      return { url: t.url, title: t.title };
    },
  };
  const sock: ExtSocket = {
    send(data) {
      const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
      if (id === undefined) return;
      const run = ops[op];
      let reply: { value: unknown } | { error: string };
      try {
        reply = run ? { value: run(args) } : { error: `this fake has no ${op}` };
      } catch (e) {
        reply = { error: e instanceof Error ? e.message : String(e) };
      }
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
    },
    close() {},
  };
  connect(sock);
  return { tabs, lists: () => lists };
}

const agent = Bun.spawn(["sleep", "600"]);
afterAll(() => {
  agent.kill();
  jest.useRealTimers();
});

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

// A run on the fake clock, which moves on 500 ms at a time once Safari has
// answered all it was asked.
async function waited<T>(run: Promise<T>): Promise<T> {
  let done = false;
  const end = () => {
    done = true;
  };
  void run.then(end, end);
  while (!done) {
    await settled();
    jest.advanceTimersByTime(500);
  }
  return run;
}

// An open by the agent, and the request its window's page polls with.
async function opened(s: { tabs: Map<number, Tab> }, url: string) {
  const args = { url, background: true };
  const tab = await waited(watched(agent.pid, "open", args, () => runAs(agent.pid, () => callTool("open", args)))) as { id: number };
  const windowId = s.tabs.get(tab.id)!.windowId;
  const page = new URL([...s.tabs.values()].find((t) => t.windowId === windowId && t.url.includes("/space?"))!.url);
  return { id: tab.id, state: new Request(`${page.origin}/space/state?id=${page.searchParams.get("id")}`) };
}

type Shown = { tabs: { id: number }[] | null };

async function shown(state: Request) {
  const page = await (await missionRoute(state, new URL(state.url))).json() as Shown;
  return page.tabs?.map((t) => t.id);
}

// 10-21 audit: idle, the daemon asked Safari for every tab about 43 times a
// minute: each agent window's page every 2 s it showed, and the window
// sweep every 5 s while any agent ran.
test("an idle agent's window, its page polling every 2 s, has Safari list its tabs at most 8 times a minute", async () => {
  jest.useFakeTimers();
  const s = safari();
  const { id, state } = await opened(s, "https://a.example/");
  const before = s.lists();
  let ids: number[] | undefined;
  for (let i = 0; i < 30; i++) {
    jest.advanceTimersByTime(2000);
    await settled();
    ids = await shown(state);
    await settled();
  }
  expect(s.lists() - before).toBeLessThanOrEqual(8);
  expect(ids).toEqual([id]);
});

test("a tab its agent opens shows on its window's page at the page's next poll", async () => {
  jest.useFakeTimers();
  const s = safari();
  const first = await opened(s, "https://b.example/1");
  expect(await shown(first.state)).toEqual([first.id]);
  const second = await opened(s, "https://b.example/2");
  expect(await shown(first.state)).toEqual([first.id, second.id]);
});
