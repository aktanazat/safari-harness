import { afterAll, expect, jest, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bridge, type ExtSocket } from "./bridge.ts";
import { recordReplaced } from "./continuity.ts";
import { connect } from "./fake-safari.ts";
import { saveCapture, verifyEvidence } from "./evidence.ts";
import { failureOf, HarnessError } from "./failures.ts";
import * as front from "./front.ts";
import { admitNativeAction, finishNativeAction, missionCall, missionRoute, watched, type Overview } from "./mission.ts";
import { runAs, watchOwner } from "./owner.ts";
import { passwords } from "./passwords.ts";
import { callTool, endTurn } from "./tools.ts";
import * as tools from "./tools.ts";

type Tab = { id: number; url: string; title: string; windowId: number; active: boolean };

// Safari as the extension reports it, with the user's window 1 open. Its
// pages answer as content.js does: type says what it typed, and a field
// that is gone makes the error repeat the text.
function safari() {
  const tabs = new Map<number, Tab>([[1, { id: 1, url: "https://his.example/", title: "His page", windowId: 1, active: true }]]);
  const closing = new Map<number, () => void>();
  const effects: { tab: number; ref: unknown }[] = [];
  const changed = new Set<number>();
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
    dialogs: () => ({ ok: true }),
    probe: () => [],
    relay: ([tab, op, args]) => {
      const t = tabs.get(tab as number);
      if (!t) throw new Error(`no tab ${tab}`);
      if (op === "click" || op === "type" || op === "press") changed.add(Number(tab));
      if (op === "snapshot") return { url: t.url, title: t.title, snapshot: "[1] button Continue", truncated: false };
      if (op === "extract") return { url: t.url, title: t.title, text: "Continue to the next page", truncated: false };
      if (op === "click") { effects.push({ tab: Number(tab), ref: (args as unknown[])[0] }); return { ok: true }; }
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
  return { tabs, closed, effects, changed, ops };
}

// One Safari for the whole file: every agent's tabs close as this file
// ends, at the cleanup its runtime admits, and must find the Safari they
// were opened in.
const s = safari();

const spawned: { pid: number; kill(): void; exited: Promise<number> }[] = [];
const fixtureTabs = new Set<number>();

// An agent process, to call as and then end.
function agent() {
  const p = Bun.spawn(["sleep", "60"]);
  spawned.push(p);
  return p;
}

afterAll(async () => {
  for (const p of spawned) p.kill();
  await Promise.all(spawned.map((p) => p.exited));
  for (const tab of fixtureTabs) if (s.tabs.has(tab)) await tools.closeTab(tab, "the test explicitly closed its own retained page");
  for (const p of spawned) await endTurn(p.pid);
  await Promise.all([...s.tabs.values()].filter((t) => t.windowId !== 1).map((t) => s.closed(t.id)));
  await Promise.all(spawned.map((p) => new Promise<void>((resolve) => watchOwner(p.pid, resolve))));
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
  fixtureTabs.add(t.id);
  return t.id;
}

async function ask(url: string, init?: RequestInit, route: typeof missionRoute = missionRoute): Promise<Response> {
  const req = new Request(url, init);
  const res = await route(req, new URL(req.url));
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

// A stop is not cleanup authority (6fc219a): the stopped agent's tabs wait,
// like every agent's, for the cleanup its runtime admits as the turn the
// stop ends.
test("a stopped agent's next call fails with the stop message, and its tabs close at its admitted cleanup, not at the stop, while another agent's stay", async () => {
  const [a, b] = [agent(), agent()];
  const aTab = await open(a.pid, "https://a.example/");
  const bTab = await open(b.pid, "https://b.example/");
  expect((await press(pageOf(aTab), "stop")).status).toBe(200);
  await expect(call(a.pid, "info", { tab: aTab })).rejects.toThrow("the user stopped this task from its window; stop and tell the user what you had done");
  await settled();
  expect(s.tabs.has(aTab)).toBe(true);
  await endTurn(a.pid);
  expect(s.tabs.has(aTab)).toBe(false);
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
  // A page typed in is a form in progress, which no cleanup closes: only
  // its agent's own close does.
  await call(a.pid, "close", { tab });
});

const listed = async (owner: number) => ((await (await ask("http://127.0.0.1:37334/agents.json")).json()) as Overview).agents.find((a) => a.owner === owner);

// 10-07: Safari came in front about 30 times in 30 minutes over the
// terminal he typed in, and no record said for which agent.
test("each agent's record counts the times it brought Safari to the front, and another agent's does not", async () => {
  const raised = spyOn(front, "input").mockResolvedValue({});
  try {
    const [a, b] = [agent(), agent()];
    const tab = await open(a.pid, "https://a.example/");
    await open(b.pid, "https://b.example/");
    await call(a.pid, "activate", { tab });
    await call(a.pid, "activate", { tab });
    expect([(await listed(a.pid))?.raised, (await listed(b.pid))?.raised]).toEqual([2, 0]);
    expect(raised.mock.calls.filter(([args]) => args[0] === "activate")).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

// 10-07: an agent showed 0 tabs while a tab it opened sat in a window apart
// from its own.
test("an agent's tab count takes in the tabs it opened outside its window", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://a.example/1");
  await open(a.pid, "https://a.example/2");
  s.tabs.get(tab)!.windowId = 7;
  expect((await listed(a.pid))?.tabs).toBe(2);
});

const observedCall = <T>(owner: number, tool: string, args: Record<string, unknown>, run: (pinned: Record<string, unknown>) => Promise<T>) => watched(owner, tool, args, () => runAs(owner, () => missionCall(tool, args, run)));
const native = (owner: number, args: Record<string, unknown>) => watched(owner, "action_admit", args, () => runAs(owner, () => admitNativeAction(args)));
const fullView = { snapshot: "[1] button Continue", truncated: false };

test.each(["change", "change-type"])("password changes queued during takeover require a fresh view before %s writes", async (operation) => {
  const a = agent();
  const tab = await open(a.pid, "https://password-change.example/");
  const page = pageOf(tab);
  const effects: string[] = [];
  const save = spyOn(passwords, "change").mockImplementation(async () => {
    effects.push("vault update");
    return { username: "fixture-user", site: "password-change.example" };
  });
  const fill = spyOn(passwords, "typeChange").mockImplementation(async () => {
    effects.push("form update");
    return { filled: ["new password"], username: "fixture-user", site: "password-change.example", saved: true };
  });
  try {
    expect((await press(page, "drive")).status).toBe(200);
    const queued = call(a.pid, "passwords", { tab, do: operation }).then(() => "changed", (error: unknown) => failureOf(error).code);
    await settled();
    expect(effects).toEqual([]);
    expect((await press(page, "giveback")).status).toBe(200);
    expect(await queued).toBe("stale_view");
    expect(effects).toEqual([]);
    await call(a.pid, "snapshot", { tab });
    await call(a.pid, "passwords", { tab, do: operation });
    expect(effects).toEqual([operation === "change" ? "vault update" : "form update"]);
  } finally {
    fill.mockRestore();
    save.mockRestore();
    await call(a.pid, "snapshot", { tab });
    await call(a.pid, "close", { tab });
  }
});

test("a click queued in the tab's real dispatch lane cannot act after giveback until that tab is observed", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://queued.example/");
  const other = await open(a.pid, "https://other.example/");
  s.tabs.get(other)!.windowId = 1;
  const page = pageOf(tab);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<{ ok: true }>();
  const original = bridge.tab.bind(bridge);
  let sent = 0;
  const relay = spyOn(bridge, "tab").mockImplementation(async (...args) => {
    if (args[0] === tab && args[1] === "click") {
      s.changed.add(tab);
      sent++;
      if (sent === 1) { entered.resolve(); return finish.promise; }
    }
    return original(...args);
  });
  try {
    const first = call(a.pid, "click", { tab, ref: "first" });
    await entered.promise;
    const queued = call(a.pid, "click", { tab, ref: "queued" }).then(() => "acted", (e: unknown) => failureOf(e).code);
    await settled();
    expect((await press(page, "drive")).status).toBe(200);
    expect((await press(page, "giveback")).status).toBe(200);
    finish.resolve({ ok: true });
    await first;
    expect(await queued).toBe("stale_view");
    expect(sent).toBe(1);
    await expect(call(a.pid, "click", { tab: other, ref: "other" })).rejects.toMatchObject({ code: "stale_view" });
    await call(a.pid, "snapshot", { tab: other });
    await call(a.pid, "click", { tab: other, ref: "other" });
    expect(await call(a.pid, "info", { tab })).toMatchObject({ url: "https://queued.example/" });
    await expect(call(a.pid, "click", { tab, ref: "queued" })).rejects.toMatchObject({ code: "stale_view" });
    await call(a.pid, "snapshot", { tab });
    await call(a.pid, "click", { tab, ref: "queued" });
    expect(sent).toBe(2);
  } finally {
    finish.resolve({ ok: true });
    relay.mockRestore();
  }
});

test("a click already waiting at takeover is held after giveback, and a late pre-takeover read cannot clear it", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://late.example/");
  const page = pageOf(tab);
  const reading = Promise.withResolvers<void>();
  const late = Promise.withResolvers<typeof fullView>();
  const read = observedCall(a.pid, "snapshot", { tab }, async () => { reading.resolve(); return late.promise; });
  await reading.promise;
  expect((await press(page, "drive")).status).toBe(200);
  const before = s.effects.length;
  const held = call(a.pid, "click", { tab, ref: "old" }).then(() => "acted", (e: unknown) => failureOf(e).code);
  await settled();
  expect((await press(page, "giveback")).status).toBe(200);
  late.resolve(fullView);
  await read;
  expect(await held).toBe("stale_view");
  expect(s.effects).toHaveLength(before);
  await call(a.pid, "snapshot", { tab });
  await call(a.pid, "click", { tab, ref: "fresh" });
  expect(s.effects.at(-1)).toEqual({ tab, ref: "fresh" });
});

test.each([
  { tool: "snapshot", args: { query: "Continue" }, value: fullView },
  { tool: "snapshot", args: { root: "main" }, value: fullView },
  { tool: "snapshot", args: { interactive: true }, value: fullView },
  { tool: "snapshot", args: { diff: true }, value: fullView },
  { tool: "snapshot", args: { maxNodes: 1 }, value: fullView },
  { tool: "extract", args: { maxBytes: 10 }, value: { text: "Continue", truncated: false } },
  { tool: "snapshot", args: {}, value: { ...fullView, truncated: true } },
  { tool: "extract", args: { selector: "main" }, value: { text: "Continue" } },
  { tool: "extract", args: { as: "table" }, value: { tables: [] } },
  { tool: "data", args: {}, value: { meta: { title: "Continue" } } },
])("a partial $tool result does not release old target assumptions", async ({ tool, args, value }) => {
  const a = agent();
  const tab = await open(a.pid, "https://partial.example/");
  const page = pageOf(tab);
  await press(page, "drive");
  await press(page, "giveback");
  await observedCall(a.pid, tool, { ...args, tab }, async () => value);
  await expect(call(a.pid, "click", { tab, ref: "old" })).rejects.toMatchObject({ code: "stale_view" });
  await observedCall(a.pid, "extract", { tab }, async () => ({ text: "The full page now offers Continue", truncated: false }));
  await call(a.pid, "click", { tab, ref: "new" });
});

test("reading a different tab cannot release the tab the user changed", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://changed.example/");
  const other = await open(a.pid, "https://unrelated.example/");
  await call(a.pid, "info", { tab });
  await press(pageOf(tab), "drive");
  await press(pageOf(tab), "giveback");
  await call(a.pid, "snapshot", { tab: other });
  await expect(call(a.pid, "click", { tab, ref: "old" })).rejects.toMatchObject({ code: "stale_view" });
  await call(a.pid, "click", { tab: other, ref: "safe" });
});

test("an uncertain identical action is blocked until observation, without blocking another target or deterministic validation retries", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://uncertain.example/");
  let sent = 0;
  const action = () => observedCall(a.pid, "click", { tab, ref: 9 }, async () => { sent++; throw new HarnessError("timeout", "reply lost after dispatch"); });
  await expect(action()).rejects.toMatchObject({ code: "timeout", effect: "possibly_effected" });
  await expect(observedCall(a.pid, "click", { ref: "9", tab, snapshot: true, x: 20, y: 30, ignored: "not part of the action" }, async () => { sent++; return { ok: true }; })).rejects.toMatchObject({ code: "effect_unknown", effect: "none" });
  for (const noWaitAfter of [false, true]) {
    await expect(observedCall(a.pid, "click", { tab, ref: 9, noWaitAfter }, async () => { sent++; return { ok: true }; })).rejects.toMatchObject({ code: "effect_unknown", effect: "none" });
  }
  expect(sent).toBe(1);
  await call(a.pid, "click", { tab, ref: "different" });
  await expect(call(a.pid, "click", { tab })).rejects.toMatchObject({ code: "invalid_argument", effect: "none" });
  await expect(call(a.pid, "click", { tab })).rejects.toMatchObject({ code: "invalid_argument", effect: "none" });
  await call(a.pid, "snapshot", { tab });
  await expect(action()).rejects.toMatchObject({ code: "timeout" });
  expect(sent).toBe(2);
});

test("each nested run step is checked separately after giveback", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://run-changed.example/");
  const other = await open(a.pid, "https://run-other.example/");
  await call(a.pid, "info", { tab });
  await press(pageOf(tab), "drive");
  await press(pageOf(tab), "giveback");
  const before = s.effects.length;
  await call(a.pid, "snapshot", { tab: other });
  const result = await call(a.pid, "run", { steps: [
    { tool: "click", args: { tab: other, ref: "allowed" } },
    { tool: "click", args: { tab, ref: "stale" } },
    { tool: "click", args: { tab: other, ref: "not-run" } },
  ] });
  expect(result).toMatchObject({ steps: [{ value: expect.anything() }, { failure: { code: "stale_view" } }], notRun: 1 });
  expect(s.effects.slice(before)).toEqual([{ tab: other, ref: "allowed" }]);
});

test("native input permits pin the owner and remain uncertain until completion; reads in flight cannot clear an unfinished permit", async () => {
  const [a, b] = [agent(), agent()];
  const tab = await open(a.pid, "https://native.example/");
  const permit = await native(a.pid, { tab });
  const pending = await (await ask(`http://127.0.0.1:37334/agents/history.json?id=${(await listed(a.pid))!.id}`)).json();
  expect(pending.missions[0].calls.at(-1)).toMatchObject({ tool: "real_input", outcome: "running" });
  await call(a.pid, "snapshot", { tab });
  await expect(native(a.pid, { tab })).rejects.toMatchObject({ code: "effect_unknown", retryable: false });
  await expect(runAs(b.pid, () => finishNativeAction(tab, permit.permit, false))).rejects.toMatchObject({ code: "invalid_argument" });
  await runAs(a.pid, () => finishNativeAction(tab, permit.permit, true));
  await expect(native(a.pid, { tab })).rejects.toMatchObject({ code: "effect_unknown" });
  await call(a.pid, "snapshot", { tab });
  const next = await native(a.pid, { tab });
  await runAs(a.pid, () => finishNativeAction(tab, next.permit, false));
  await expect(runAs(a.pid, () => finishNativeAction(tab, next.permit, false))).rejects.toMatchObject({ code: "invalid_argument" });
});

test("old pages and late stopped-call cleanup cannot control a later mission at the same owner number", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://ended.example/");
  const page = pageOf(tab);
  const old = await listed(a.pid);
  const oldWindow = /data-secret="([^"]+)"/.exec(await (await ask(page.href)).text())?.[1];
  const oldPage = /data-secret="([^"]+)"/.exec(await (await ask(`${page.origin}/agents`)).text())?.[1];
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<{ url: string }>();
  const closing = spyOn(tools, "closeTabsOf");
  const pending = observedCall(a.pid, "info", { tab }, async () => { entered.resolve(); return late.promise; });
  try {
    await entered.promise;
    expect((await press(page, "stop")).status).toBe(200);
    expect(closing).toHaveBeenCalledTimes(1);
    a.kill();
    await a.exited;
    const ended = Promise.withResolvers<void>();
    watchOwner(a.pid, ended.resolve);
    await ended.promise;
    await observedCall(a.pid, "info", { tab }, async () => ({ url: "https://later.example/" }));
    expect((await listed(a.pid))?.id).not.toBe(old?.id);
    late.resolve({ url: "https://ended.example/" });
    await pending;
    expect(closing).toHaveBeenCalledTimes(1);
    expect((await press(page, "stop", { secret: oldWindow })).status).toBe(409);
    const res = await ask(`${page.origin}/agents/control`, { method: "POST", headers: { "content-type": "application/json", origin: page.origin }, body: JSON.stringify({ owner: a.pid, secret: oldPage, action: "stop" }) });
    expect(res.status).toBe(403);
    const retained = await (await ask(`${page.origin}/agents/history.json?id=${old?.id}`)).json();
    expect(retained.missions[0]).toMatchObject({ id: old?.id, controls: false, status: "stopped" });
  } finally {
    late.resolve({ url: "https://ended.example/" });
    await pending;
    closing.mockRestore();
  }
});

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("action pictures are off by default, use the protected screenshot API when enabled, and are served only from retained verified records", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://pictures.example/?token=not-for-history");
  const page = pageOf(tab);
  const roots = new Set<string>();
  let receipt: string | undefined;
  const capture = spyOn(tools, "screenshot").mockImplementation(async (opts) => {
    if (!opts.out) throw new Error("missing private output");
    roots.add(dirname(dirname(opts.out)));
    const saved = await saveCapture({ data: PIXEL, source: { url: "https://pictures.example/?token=not-for-history", title: "A page", capturedAt: new Date().toISOString(), width: 1, height: 1, viewport: { width: 1, height: 1, devicePixelRatio: 1 }, privacy: { masked: 1 } } }, opts.out);
    receipt = saved.evidence.path;
    return saved;
  });
  try {
    await call(a.pid, "click", { tab, ref: "first" });
    expect(capture).not.toHaveBeenCalled();
    expect((await press(page, "pictures_on")).status).toBe(200);
    await call(a.pid, "click", { tab, ref: "second" });
    expect(capture).toHaveBeenCalledTimes(1);
    const id = (await listed(a.pid))!.id;
    const saved = await (await ask(`${page.origin}/agents/history.json?id=${id}`)).json();
    const picture = saved.missions[0].calls.find((c: { picture?: unknown }) => c.picture)?.picture;
    expect(picture).toMatchObject({ capture: { width: 1, height: 1, masked: 1, url: "https://pictures.example" } });
    expect(JSON.stringify(saved)).not.toContain("not-for-history");
    expect(JSON.stringify(saved)).not.toContain(".png.evidence");
    const image = await ask(`${page.origin}/agents/picture?id=${id}&picture=${picture.id}`);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(PIXEL, "base64"));
    expect((await ask(`${page.origin}/agents/picture?id=${id}&picture=${randomUUID()}`)).status).toBe(404);
    expect((await ask(`${page.origin}/agents/picture?id=${id}&picture=${picture.id}&path=/etc/passwd`)).headers.get("content-type")).toBe("image/png");
    expect((await ask(`${page.origin}/agents/picture?id=${id}&picture=${picture.id}`, { headers: { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    if (!receipt) throw new Error("saved picture receipt missing");
    writeFileSync((await verifyEvidence(receipt)).path, "modified image");
    expect((await ask(`${page.origin}/agents/picture?id=${id}&picture=${picture.id}`)).status).toBe(410);
    await press(page, "pictures_off");
    await call(a.pid, "click", { tab, ref: "third" });
    expect(capture).toHaveBeenCalledTimes(1);
  } finally {
    capture.mockRestore();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("a refused action picture is an explicit nonsecret gap and never retries or fails the action", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://private-picture.example/");
  const page = pageOf(tab);
  const capture = spyOn(tools, "screenshot").mockRejectedValue(new HarnessError("privacy", "secret page text must not become a reason"));
  try {
    await press(page, "pictures_on");
    const before = s.effects.length;
    expect(await call(a.pid, "click", { tab, ref: "once" })).toMatchObject({ ok: true });
    expect(s.effects.slice(before)).toEqual([{ tab, ref: "once" }]);
    const saved = await (await ask(`${page.origin}/agents/history.json?id=${(await listed(a.pid))!.id}`)).json();
    expect(saved.missions[0].calls.at(-1)).toMatchObject({ outcome: "done", picture: { missing: "privacy guard refused capture" } });
    expect(JSON.stringify(saved)).not.toContain("secret page text");
  } finally {
    capture.mockRestore();
  }
});

test.each(["drive", "pause", "stop"])("native completion bookkeeping never waits on %s or clears a takeover observation hold", async (action) => {
  const a = agent();
  const tab = await open(a.pid, "https://finishing.example/");
  const page = pageOf(tab);
  const permit = await native(a.pid, { tab });
  expect((await press(page, action)).status).toBe(200);
  let completed = false;
  const finish = call(a.pid, "action_finish", { tab, permit: permit.permit, uncertain: false }).then(() => { completed = true; });
  try {
    await settled();
    expect(completed).toBe(true);
  } finally {
    if (action !== "stop") await press(page, "giveback");
    await finish;
  }
  if (action === "drive") await expect(call(a.pid, "click", { tab, ref: "old" })).rejects.toMatchObject({ code: "stale_view" });
});

test("uncertainty and native permits follow Safari's replacement tab without becoming repeatable", async () => {
  const a = agent();
  const [old, current, next] = [1_001_000, 1_001_001, 1_001_002];
  let sent = 0;
  await expect(observedCall(a.pid, "click", { tab: old, ref: "submit" }, async () => { sent++; throw new HarnessError("timeout", "reply lost"); })).rejects.toMatchObject({ code: "timeout" });
  recordReplaced(old, current);
  await expect(observedCall(a.pid, "click", { tab: current, ref: "submit" }, async () => { sent++; })).rejects.toMatchObject({ code: "effect_unknown" });
  expect(sent).toBe(1);
  await observedCall(a.pid, "snapshot", { tab: current }, async () => fullView);
  const permit = await native(a.pid, { tab: current });
  recordReplaced(current, next);
  await runAs(a.pid, () => finishNativeAction(current, permit.permit, false));
  await expect(observedCall(a.pid, "click", { tab: next, ref: "submit" }, async () => { sent++; })).rejects.toMatchObject({ code: "effect_unknown" });
  await observedCall(a.pid, "snapshot", { tab: next }, async () => fullView);
  await observedCall(a.pid, "click", { tab: old, ref: "submit" }, async () => { sent++; });
  expect(sent).toBe(2);
});

test("native stills are captured only on completion and an uncertain delivery records an honest gap", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://native-picture.example/");
  const page = pageOf(tab);
  const roots = new Set<string>();
  const capture = spyOn(tools, "screenshot").mockImplementation(async (opts) => {
    if (!opts.out) throw new Error("missing private output");
    roots.add(dirname(dirname(opts.out)));
    return saveCapture({ data: PIXEL, source: { url: "https://native-picture.example/", title: "A page", capturedAt: new Date().toISOString(), width: 1, height: 1, viewport: { width: 1, height: 1, devicePixelRatio: 1 }, privacy: { masked: 0 } } }, opts.out);
  });
  try {
    await press(page, "pictures_on");
    const permit = await native(a.pid, { tab });
    expect(capture).not.toHaveBeenCalled();
    await runAs(a.pid, () => finishNativeAction(tab, permit.permit, false));
    expect(capture).toHaveBeenCalledTimes(1);
    const unsure = await native(a.pid, { tab });
    await runAs(a.pid, () => finishNativeAction(tab, unsure.permit, true));
    expect(capture).toHaveBeenCalledTimes(1);
    const saved = await (await ask(`${page.origin}/agents/history.json?id=${(await listed(a.pid))!.id}`)).json();
    expect(saved.missions[0].calls.at(-1)).toMatchObject({ tool: "real_input", outcome: "failed", code: "effect_unknown", picture: { missing: "action result is unknown" } });
    await call(a.pid, "snapshot", { tab });
    const canceled = await native(a.pid, { tab });
    await press(page, "pictures_off");
    await runAs(a.pid, () => finishNativeAction(tab, canceled.permit, false));
    const stopped = await (await ask(`${page.origin}/agents/history.json?id=${(await listed(a.pid))!.id}`)).json();
    expect(stopped.missions[0].calls.at(-1)).toMatchObject({ outcome: "done", picture: { missing: "picture saving stopped" } });
    expect(capture).toHaveBeenCalledTimes(1);
  } finally {
    capture.mockRestore();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("giveback cannot release a queued click while its takeover is still choosing the affected tab", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://taking.example/");
  const page = pageOf(tab);
  const entered = Promise.withResolvers<void>();
  const listing = Promise.withResolvers<Tab[]>();
  const original = bridge.request.bind(bridge);
  let blocked = false;
  const request = spyOn(bridge, "request").mockImplementation(async (...args) => {
    if (args[0] === "tabs.list" && !blocked) { blocked = true; entered.resolve(); return listing.promise; }
    return original(...args);
  });
  const taking = press(page, "drive");
  try {
    await entered.promise;
    const giving = press(page, "giveback");
    const before = s.effects.length;
    const queued = call(a.pid, "click", { tab, ref: "old" }).then(() => "acted", (e: unknown) => failureOf(e).code);
    await settled();
    expect(s.effects).toHaveLength(before);
    listing.resolve([...s.tabs.values()]);
    expect((await taking).status).toBe(200);
    expect((await giving).status).toBe(200);
    expect(await queued).toBe("stale_view");
  } finally {
    listing.resolve([...s.tabs.values()]);
    await taking;
    request.mockRestore();
  }
});

test("a dispatched cookies mutation with an unknown result cannot repeat, while a cookies read remains usable", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://cookies.example/");
  const args = { tab, do: "set", cookies: [{ name: "fixture-cookie", value: "fixture-value" }] };
  let sent = 0;
  const mutate = () => observedCall(a.pid, "cookies", args, async () => { sent++; throw new Error("reply lost after mutation"); });
  await expect(mutate()).rejects.toThrow("reply lost after mutation");
  await expect(mutate()).rejects.toMatchObject({ code: "effect_unknown", effect: "none" });
  expect(sent).toBe(1);
  expect(await observedCall(a.pid, "cookies", { tab }, async () => [])).toEqual([]);
  await call(a.pid, "snapshot", { tab });
  await expect(mutate()).rejects.toThrow("reply lost after mutation");
  expect(sent).toBe(2);
});

test("a replay can observe first after giveback, but its individual effect cannot skip the tab hold", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://replay.example/");
  const page = pageOf(tab);
  await press(page, "drive");
  await press(page, "giveback");
  let sent = 0;
  await expect(observedCall(a.pid, "replay", { tab, name: "fixture" }, async () => observedCall(a.pid, "click", { tab, ref: "old" }, async () => { sent++; }))).rejects.toMatchObject({ code: "stale_view" });
  expect(sent).toBe(0);
  await observedCall(a.pid, "replay", { tab, name: "fixture" }, async () => {
    await observedCall(a.pid, "snapshot", { tab }, async () => fullView);
    await observedCall(a.pid, "click", { tab, ref: "new" }, async () => { sent++; });
  });
  expect(sent).toBe(1);
});

test("internal resource calls do not create mission controls or uncertainty holds from runAs alone", async () => {
  const a = agent();
  const tab = (await runAs(a.pid, () => callTool("open", { url: "https://internal.example/", background: true }))) as { id: number };
  fixtureTabs.add(tab.id);
  const relay = spyOn(bridge, "tab");
  const input = spyOn(front, "input").mockResolvedValue({});
  try {
    for (let i = 0; i < 2; i++) await expect(runAs(a.pid, () => callTool("type", { tab: tab.id, ref: "gone", text: "fixture" }))).rejects.toThrow("could not type");
    expect(relay.mock.calls.filter(([id, op]) => id === tab.id && op === "type")).toHaveLength(2);
    await runAs(a.pid, () => callTool("activate", { tab: tab.id }));
    expect(await listed(a.pid)).toBeUndefined();
    await expect(runAs(a.pid, () => admitNativeAction({ tab: tab.id }))).rejects.toMatchObject({ code: "unavailable", effect: "none" });
    await expect(runAs(a.pid, () => finishNativeAction(tab.id, "not-a-permit", false))).rejects.toMatchObject({ code: "invalid_argument" });
    expect(await listed(a.pid)).toBeUndefined();
  } finally {
    relay.mockRestore();
    input.mockRestore();
  }
});

test("passive calls keep their own tab resolution while actions and full observations pin the exact tab", async () => {
  const a = agent();
  const request = spyOn(bridge, "request");
  try {
    for (const [tool, args] of [
      ["wait", { tab: "front", text: "Continue", ms: 100 }],
      ["info", { tab: "front" }],
      ["snapshot", { tab: "front", query: "button" }],
    ] as const) {
      await observedCall(a.pid, tool, args, async (pinned) => {
        expect(pinned.tab).toBe("front");
        return { ok: true };
      });
    }
    expect(request.mock.calls.filter(([op]) => op === "tabs.list")).toHaveLength(0);
    const [old, current] = [1_002_000, 1_002_001];
    recordReplaced(old, current);
    for (const tool of ["click", "snapshot"]) {
      await observedCall(a.pid, tool, { tab: old }, async (pinned) => {
        expect(pinned.tab).toBe(current);
        return fullView;
      });
    }
  } finally {
    request.mockRestore();
  }
});

test("an old snapshot finishing after tab replacement cannot clear the replacement's observation hold", async () => {
  const a = agent();
  const [old, current] = [1_003_000, 1_003_001];
  let sent = 0;
  await expect(observedCall(a.pid, "click", { tab: old, ref: "submit" }, async () => { sent++; throw new HarnessError("timeout", "reply lost"); })).rejects.toMatchObject({ code: "timeout" });
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<typeof fullView>();
  const reading = observedCall(a.pid, "snapshot", { tab: old }, async () => { entered.resolve(); return answer.promise; });
  try {
    await entered.promise;
    recordReplaced(old, current);
    answer.resolve(fullView);
    await reading;
    await expect(observedCall(a.pid, "click", { tab: current, ref: "submit" }, async () => { sent++; })).rejects.toMatchObject({ code: "effect_unknown" });
    expect(sent).toBe(1);
    await observedCall(a.pid, "snapshot", { tab: current }, async () => fullView);
    await observedCall(a.pid, "click", { tab: old, ref: "submit" }, async () => { sent++; });
    expect(sent).toBe(2);
  } finally {
    answer.resolve(fullView);
    await reading;
  }
});

test("a nested mission call resolves its owner inside runAs instead of borrowing the outer mission", async () => {
  const [a, b] = [agent(), agent()];
  const tab = await open(b.pid, "https://nested-owner.example/");
  await press(pageOf(tab), "drive");
  await press(pageOf(tab), "giveback");
  let sent = 0;
  const nested = () => observedCall(a.pid, "run", {}, async () => runAs(b.pid, () => missionCall("click", { tab, ref: "submit" }, async () => { sent++; return { ok: true }; })));
  await expect(nested()).rejects.toMatchObject({ code: "stale_view" });
  expect(sent).toBe(0);
  await call(b.pid, "snapshot", { tab });
  await expect(nested()).resolves.toMatchObject({ ok: true });
  expect(sent).toBe(1);
});

test("giveback protects a task tab whose already-running open finishes during takeover", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://takeover.example/first");
  const page = pageOf(tab);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const request = bridge.request.bind(bridge);
  const relay = spyOn(bridge, "request").mockImplementation(async (...args) => {
    if (args[0] === "tabs.open" && args[1]?.[0] === "https://takeover.example/late") {
      entered.resolve();
      await finish.promise;
    }
    return request(...args);
  });
  const opening = open(a.pid, "https://takeover.example/late");
  try {
    await entered.promise;
    await press(page, "drive");
    finish.resolve();
    const late = await opening;
    await press(page, "giveback");
    await expect(call(a.pid, "click", { tab: late, ref: "submit" })).rejects.toMatchObject({ code: "stale_view" });
    await call(a.pid, "snapshot", { tab: late });
    await call(a.pid, "click", { tab: late, ref: "submit" });
    expect(s.effects.at(-1)).toEqual({ tab: late, ref: "submit" });
  } finally {
    finish.resolve();
    relay.mockRestore();
    await press(page, "giveback");
    await opening;
  }
});

async function resourceTab(owner: number, url: string): Promise<number> {
  const tab = await runAs(owner, () => callTool("open", { url, background: true })) as { id: number };
  fixtureTabs.add(tab.id);
  return tab.id;
}

async function registeredWindow(tab: number, route: typeof missionRoute = missionRoute): Promise<NonNullable<Overview["windows"]>[number]> {
  const id = pageOf(tab).searchParams.get("id");
  const overview = await (await ask("http://127.0.0.1:37334/agents.json", undefined, route)).json() as Overview;
  const window = overview.windows?.find((window) => window.id === id);
  if (!window) throw new Error(`no registered window for tab ${tab}`);
  return window;
}

async function closeRegisteredWindow(window: { id: string; closeSecret: string }, change: { origin?: string; site?: string } = {}, route: typeof missionRoute = missionRoute): Promise<Response> {
  return ask("http://127.0.0.1:37334/agents/windows/close", {
    method: "POST",
    headers: { "content-type": "application/json", origin: change.origin ?? "http://127.0.0.1:37334", "sec-fetch-site": change.site ?? "same-origin" },
    body: JSON.stringify({ id: window.id, secret: window.closeSecret }),
  }, route);
}

test("registered windows remain listed with their page titles and redacted addresses when their agent has no mission record", async () => {
  const a = agent();
  const tab = await resourceTab(a.pid, "https://payment.example/confirmation?token=not-for-the-list#receipt");
  s.tabs.get(tab)!.title = "Asylum payment";
  const page = pageOf(tab);
  const window = await registeredWindow(tab);
  expect(await listed(a.pid)).toBeUndefined();
  expect(window).toMatchObject({
    id: page.searchParams.get("id"),
    name: page.searchParams.get("name"),
    owner: a.pid,
    ended: false,
    tabs: [{ id: tab, title: "Asylum payment", url: "https://payment.example/confirmation?…" }],
  });
  expect(window.tabs).toHaveLength(1);
  expect(JSON.stringify(window)).not.toContain("not-for-the-list");
});

test("a mission restart keeps registered windows visible but refuses an earlier page's close token", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://restart.example/");
  const before = await registeredWindow(tab);
  // This tests a module restart: a static import shares the old agents and
  // secret. Keep the shared fake's front listener while loading a fresh one.
  const listener = spyOn(front, "onRaised").mockImplementation(() => {});
  let route: typeof missionRoute;
  try {
    route = (await import(`./mission.ts?windows-restart-${randomUUID()}`)).missionRoute;
  } finally {
    listener.mockRestore();
  }
  const overview = await (await ask("http://127.0.0.1:37334/agents.json", undefined, route)).json() as Overview;
  expect(overview.agents.find((agent) => agent.owner === a.pid)).toBeUndefined();
  expect(overview.windows?.find((window) => window.id === before.id)).toMatchObject({
    id: before.id, name: before.name, owner: a.pid, tabs: [{ id: tab, url: "https://restart.example/" }],
  });
  expect((await closeRegisteredWindow(before, {}, route)).status).toBe(403);
  expect(s.tabs.has(tab)).toBe(true);
});

test("an authorized close removes only the selected registered window and its kept pages without needing an agent record", async () => {
  const [a, b] = [agent(), agent()];
  const tab = await resourceTab(a.pid, "https://kept-window.example/");
  await runAs(a.pid, () => callTool("keep", { tab }));
  const other = await open(b.pid, "https://other-window.example/");
  const window = await registeredWindow(tab);
  expect(await listed(a.pid)).toBeUndefined();
  const response = await closeRegisteredWindow(window);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, closed: 1, remaining: 0 });
  expect([...s.tabs.values()].filter((tab) => tab.windowId === window.window)).toEqual([]);
  expect(s.tabs.has(other)).toBe(true);
  expect(s.tabs.get(1)?.title).toBe("His page");
  const overview = await (await ask("http://127.0.0.1:37334/agents.json")).json() as Overview;
  expect(overview.windows?.find((remaining) => remaining.id === window.id)).toBeUndefined();
});

test.each(["guess", "another window", "another origin", "cross-site"] as const)("closing a registered window with %s authority is refused without changing any tabs", async (authority) => {
  const [a, b] = [agent(), agent()];
  const tab = await resourceTab(a.pid, "https://protected-window.example/");
  const other = await resourceTab(b.pid, "https://different-window.example/");
  const window = await registeredWindow(tab);
  const elsewhere = await registeredWindow(other);
  const before = [...s.tabs.values()];
  const secret = authority === "guess" ? "a-guess" : authority === "another window" ? elsewhere.closeSecret : window.closeSecret;
  const response = await closeRegisteredWindow({ id: window.id, closeSecret: secret }, {
    ...(authority === "another origin" ? { origin: "https://evil.example" } : {}),
    ...(authority === "cross-site" ? { site: "cross-site" } : {}),
  });
  expect(response.status).toBe(403);
  expect([...s.tabs.values()]).toEqual(before);
});

test("a window page without a registration cannot authorize closing a user's window", async () => {
  const id = randomUUID();
  const marker = 1_004_000;
  s.tabs.set(marker, { id: marker, title: "Copied page", url: `http://127.0.0.1:37334/space?id=${id}&name=copied&size=1100x800`, windowId: 1, active: false });
  try {
    const before = [...s.tabs.values()];
    const response = await closeRegisteredWindow({ id, closeSecret: "a-guess" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: "this window is no longer registered; reload the agents page" });
    expect([...s.tabs.values()]).toEqual(before);
  } finally {
    s.tabs.delete(marker);
  }
});

test("failed Safari listings leave task controls usable and mark only windows unavailable", async () => {
  const a = agent();
  const tab = await open(a.pid, "https://busy-safari.example/");
  const page = pageOf(tab);
  const list = s.ops["tabs.list"];
  s.ops["tabs.list"] = () => { throw new Error("Safari did not answer its tab listing"); };
  try {
    const response = await ask("http://127.0.0.1:37334/agents.json");
    expect(response.status).toBe(200);
    const overview = await response.json() as Overview;
    expect(overview.windows).toBeNull();
    expect(overview.agents.find(agent => agent.owner === a.pid)?.status).toBe("working");
    expect((await press(page, "pause")).status).toBe(200);
    const paused = await (await ask("http://127.0.0.1:37334/agents.json")).json() as Overview;
    expect(paused.agents.find(agent => agent.owner === a.pid)?.status).toBe("paused");
  } finally {
    s.ops["tabs.list"] = list;
  }
});
