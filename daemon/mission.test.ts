import { afterAll, expect, jest, test } from "bun:test";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { missionRoute, watched } from "./mission.ts";
import { runAs } from "./owner.ts";
import { callTool } from "./tools.ts";

type Tab = { id: number; url: string; title: string; windowId: number; active: boolean };

// Safari as the extension reports it, with the user's window 1 open. Its
// pages answer as content.js does: type says what it typed, and a field
// that is gone makes the error repeat the text.
function safari() {
  const tabs = new Map<number, Tab>([[1, { id: 1, url: "https://his.example/", title: "His page", windowId: 1, active: true }]]);
  const closing = new Map<number, () => void>();
  let next = 100;
  const ops: Record<string, (args: unknown[]) => unknown> = {
    "tabs.list": () => [...tabs.values()],
    "tabs.open": ([url, background, windowId]) => {
      const t = { id: next++, url: String(url), title: "A page", windowId: typeof windowId === "number" ? windowId : 1, active: !background };
      tabs.set(t.id, t);
      return t;
    },
    "windows.open": ([url]) => {
      const t = { id: next++, url: String(url), title: "", windowId: next++, active: true };
      tabs.set(t.id, t);
      return { windowId: t.windowId, tabId: t.id };
    },
    "windows.resolve": ([id]) => ([...tabs.values()].some((t) => t.windowId === id) ? id : null),
    "tabs.activate": ([id]) => {
      const raised = tabs.get(id as number);
      for (const t of tabs.values()) if (raised && t.windowId === raised.windowId) t.active = t === raised;
      return { ok: true };
    },
    "tabs.close": ([id]) => {
      tabs.delete(id as number);
      closing.get(id as number)?.();
      return { ok: true };
    },
    probe: () => [],
    relay: ([tab, op, args]) => {
      const t = tabs.get(tab as number);
      if (!t) throw new Error(`no tab ${tab}`);
      if (op !== "type") return { url: t.url, title: t.title };
      const [ref, text] = args as [string, string];
      if (ref === "gone") throw new Error(`could not type "${text}": no element ${ref}`);
      return { ok: true, value: text };
    },
  };
  const answer = (op: string, args: unknown[]) => {
    const run = ops[op];
    if (!run) return { error: `this fake has no ${op}` };
    try {
      return { value: run(args) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const sock: ExtSocket = {
    send(data) {
      const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
      if (id !== undefined) queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...answer(op, args) })));
    },
    close() {},
  };
  connect(sock);
  // Settles once the harness has closed tab (it closes an agent's tabs from
  // a sweep of its own, not within the call that asked).
  const closed = (tab: number) => {
    if (!tabs.has(tab)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    closing.set(tab, resolve);
    return promise;
  };
  return { tabs, closed };
}

// One Safari for the whole file: a tab of an agent that has ended closes a
// second later, and must find the Safari it was opened in.
const s = safari();

const spawned: { kill(): void; exited: Promise<number> }[] = [];

// An agent process, to call as and then end.
function agent() {
  const p = Bun.spawn(["sleep", "60"]);
  spawned.push(p);
  return p;
}

// Once its agent exits, owner.ts sees it on its once-a-second check of the
// kernel, and the harness closes that agent's tabs and window; no fake
// clock reaches a check that already runs. The files after this one share
// that check and reuse these tab ids, so this one ends when all is closed.
afterAll(async () => {
  for (const p of spawned) p.kill();
  await Promise.all(spawned.map((p) => p.exited));
  await Promise.all([...s.tabs.values()].filter((t) => t.windowId !== 1).map((t) => s.closed(t.id)));
});

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

// A call the way /rpc in main.ts makes it.
const call = (owner: number, tool: string, args: Record<string, unknown>) => watched(owner, tool, args, () => runAs(owner, () => callTool(tool, args)));

async function open(owner: number, url: string): Promise<number> {
  const t = (await call(owner, "open", { url, background: true })) as { id: number };
  return t.id;
}

async function ask(url: string, init?: RequestInit): Promise<Response> {
  const req = new Request(url, init);
  const res = await missionRoute(req, new URL(req.url));
  if (!res) throw new Error(`no mission route for ${url}`);
  return res;
}

// The page of the window a tab opened in, where the user watches and holds
// that tab's agent.
function pageOf(tab: number): URL {
  const window = s.tabs.get(tab)?.windowId;
  const page = [...s.tabs.values()].find((t) => t.windowId === window && t.url.includes("/space?"));
  if (!page) throw new Error(`no page in the window of tab ${tab}`);
  return new URL(page.url);
}

type Shown = { agent: { status: string; calls: { tool: string; args: string; held?: boolean }[] } };
const shown = async (page: URL) => (await (await ask(`${page.origin}/space/state?id=${page.searchParams.get("id")}`)).json()) as Shown;

// What a button on the page sends: the secret the page was served with,
// from the page's own origin. Each change is what a page of another site,
// or a guess, could send instead.
async function press(page: URL, action: string, change: { secret?: string; origin?: string; site?: string; host?: string } = {}): Promise<Response> {
  const html = await (await ask(page.href)).text();
  const url = new URL("/space/control", page);
  if (change.host) url.hostname = change.host;
  return ask(url.href, {
    method: "POST",
    headers: { "content-type": "application/json", origin: change.origin ?? url.origin, "sec-fetch-site": change.site ?? "same-origin" },
    body: JSON.stringify({ id: page.searchParams.get("id"), secret: change.secret ?? /data-secret="([^"]+)"/.exec(html)?.[1], action }),
  });
}

test("a paused agent's next call waits until the user resumes it, while another agent's calls run", async () => {
  const [a, b] = [agent(), agent()];
  const aTab = await open(a.pid, "https://a.example/");
  const bTab = await open(b.pid, "https://b.example/");
  const page = pageOf(aTab);
  expect((await press(page, "pause")).status).toBe(200);

  let answered = false;
  const held = call(a.pid, "info", { tab: aTab }).finally(() => { answered = true; });
  expect(await call(b.pid, "info", { tab: bTab })).toMatchObject({ url: "https://b.example/" });
  // Asked first, over the same path, a's call would have answered first.
  expect(answered).toBe(false);
  expect((await shown(page)).agent.calls[0]).toMatchObject({ tool: "info", held: true });

  expect((await press(page, "resume")).status).toBe(200);
  expect(await held).toMatchObject({ url: "https://a.example/" });
});

test("a call held for a minute and a half fails with the pause message", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://a.example/");
  expect((await press(pageOf(tab), "pause")).status).toBe(200);
  jest.useFakeTimers();
  try {
    let failure = "";
    void call(a.pid, "info", { tab }).catch((e: unknown) => { failure = e instanceof Error ? e.message : String(e); });
    jest.advanceTimersByTime(89_999);
    await settled();
    expect(failure).toBe("");
    jest.advanceTimersByTime(1);
    await settled();
    expect(failure).toBe("the user paused this task from its window; wait a minute, then call again");
  } finally {
    jest.useRealTimers();
  }
});

test("a stopped agent's next call fails with the stop message and its tabs close, while another agent's stay", async () => {
  const [a, b] = [agent(), agent()];
  const aTab = await open(a.pid, "https://a.example/");
  const bTab = await open(b.pid, "https://b.example/");
  const gone = s.closed(aTab);
  expect((await press(pageOf(aTab), "stop")).status).toBe(200);
  await gone;
  await expect(call(a.pid, "info", { tab: aTab })).rejects.toThrow("the user stopped this task from its window; stop and tell the user what you had done");
  expect(s.tabs.has(bTab)).toBe(true);
  expect(await call(b.pid, "info", { tab: bTab })).toMatchObject({ url: "https://b.example/" });
});

test("let me drive brings the agent's last tab to the front and holds its calls until the user gives it back", async () => {
  const a = agent();
  const first = await open(a.pid, "https://a.example/1");
  const second = await open(a.pid, "https://a.example/2");
  await call(a.pid, "info", { tab: first });
  const page = pageOf(first);
  expect(await (await press(page, "drive")).json()).toMatchObject({ ok: true, tab: first });
  expect(s.tabs.get(first)?.active).toBe(true);
  expect(s.tabs.get(second)?.active).toBe(false);

  const held = call(a.pid, "info", { tab: second });
  const now = (await shown(page)).agent;
  expect(now.status).toBe("user is driving");
  expect(now.calls[0]).toMatchObject({ tool: "info", held: true });

  expect((await press(page, "giveback")).status).toBe(200);
  expect(await held).toMatchObject({ url: "https://a.example/2" });
});

test("a control without its page's secret, or from another site, is refused and leaves the agent working", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://a.example/");
  const page = pageOf(tab);
  expect((await press(page, "stop", { secret: "a-guess" })).status).toBe(403);
  expect((await press(page, "stop", { origin: "https://evil.example" })).status).toBe(403);
  expect((await press(page, "stop", { site: "cross-site" })).status).toBe(403);
  // A site that points its own name at 127.0.0.1 is same-origin to itself.
  expect((await press(page, "stop", { host: "rebound.example" })).status).toBe(403);
  expect(await call(a.pid, "info", { tab })).toMatchObject({ url: "https://a.example/" });
  expect((await shown(page)).agent.status).toBe("working");
});

test("what an agent types appears neither in its record nor in the pages' JSON, even when an error repeats it", async () => {
  const a = agent();
  // made up for this test, shaped like a password
  const typed = "hunter2-Correct-Horse";
  const tab = await open(a.pid, "https://a.example/login");
  await call(a.pid, "type", { tab, ref: "e5", text: typed });
  await expect(call(a.pid, "type", { tab, ref: "gone", text: typed })).rejects.toThrow(typed);
  // A key pressed alone is typing too, as with a code entered a digit at a time.
  await call(a.pid, "press", { tab, key: "q" });
  const page = pageOf(tab);
  const record = (await shown(page)).agent.calls;
  expect(record.map((c) => c.tool)).toEqual(["press", "type", "type", "open"]);
  expect(record[0].args).not.toContain("q");
  const everything = JSON.stringify(record) + (await (await ask(`${page.origin}/agents.json`)).text());
  expect(everything).not.toContain(typed);
});
