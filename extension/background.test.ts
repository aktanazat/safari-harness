// background.js takes each page request from the daemon to the content
// script in the tab. These tests load it under a fake extension API and a
// fake daemon socket and record every trip a request makes to the page, so
// what a request costs, and the rules for pages that change under it, are
// checked without Safari.

import { expect, test } from "bun:test";

const SOURCE = await Bun.file(new URL("./background.js", import.meta.url)).text();

type Msg = { __safariHarness?: number; id: string; op: string; args?: unknown[] };
type Reply = { id: string; value?: unknown; error?: string };
type Answer = { value?: unknown; error?: string };
type Sender = { tab: { id: number; windowId: number }; frameId: number };
type Inject = { target: { tabId: number }; func?: (...args: unknown[]) => unknown; args?: unknown[]; files?: string[] };

// Every promise chain the fakes start runs out before an immediate callback.
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

// Safari leaves a request unsettled while a dialog holds its page, and when
// its page unloads mid-request.
const never = () => Promise.withResolvers<never>().promise;

class Hook<A extends unknown[]> {
  readonly listeners = new Set<(...args: A) => unknown>();
  addListener(f: (...args: A) => unknown) { this.listeners.add(f); }
  removeListener(f: (...args: A) => unknown) { this.listeners.delete(f); }
  fire(...args: A) { for (const f of [...this.listeners]) f(...args); }
}

// Timers run only when a test moves the clock on, so no request times out by
// accident, and one that should does so at a known time.
class Clock {
  now = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  setTimeout = (fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
    this.timers.set(++this.seq, { at: this.now + Math.max(0, ms), run: () => fn(...args) });
    return this.seq;
  };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  // Runs each timer due within ms, in order, with the work each one starts.
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      await settle();
      const [due] = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at);
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].run();
    }
    this.now = end;
    await settle();
  }
}

// One document in a tab. world is what the extension's injected functions
// see as window there; a world made before this load of the extension keeps
// messaging that reaches no one (live false). ran lists the requests its
// copy of content.js ran, and does answers each; a held document (a dialog
// open on it) answers nothing.
class Doc {
  readonly world: Record<string, unknown> = {};
  readonly listeners: ((m: Msg) => Promise<Reply> | undefined)[] = [];
  readonly ran: string[] = [];
  held = false;
  does: (op: string) => unknown = () => ({ url: this.url });
  constructor(readonly url: string, readonly live = true) {}
}

type Tab = { id: number; doc: Doc };

async function start() {
  const clock = new Clock();
  const trips: string[] = [];
  const tabs = new Map<number, Tab>();
  const onMessage = new Hook<[unknown, Sender]>();
  const onUpdated = new Hook<[number, { status: string }]>();
  const hook = () => new Hook<unknown[]>();
  const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const tabOf = (id: number) => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`Tab '${id}' was not found`);
    return tab;
  };

  // What content.js does as it starts: take the page's claim unless another
  // copy holds it, answer through __safariHarnessRun, and, where its world's
  // messaging reaches this load, answer messages and report in.
  function copyIn(tab: Tab, doc: Doc, report = true) {
    const w = doc.world;
    if (w.__safariHarnessInjected) return;
    const claim = {};
    w.__safariHarnessInjected = claim;
    const answer = async (m: Msg): Promise<Reply> => {
      if (m.op === "ping") return { id: m.id, value: true };
      doc.ran.push(m.op);
      // content.js sends a failure it reports as { error } as an error
      const value = await doc.does(m.op);
      return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? { id: m.id, error: value.error } : { id: m.id, value };
    };
    w.__safariHarnessRun = (m: Msg) => (w.__safariHarnessInjected === claim ? answer(m) : null);
    if (!doc.live) return;
    doc.listeners.push((m) => (m.__safariHarness === 1 && w.__safariHarnessInjected === claim ? answer(m) : undefined));
    if (report) onMessage.fire({ __safariHarnessReady: 1 }, { tab: { id: tab.id, windowId: 1 }, frameId: 0 });
  }

  const browser = {
    runtime: { onMessage, onInstalled: hook(), onStartup: hook(), onConnect: hook() },
    tabs: {
      onUpdated,
      onRemoved: hook(),
      onCreated: hook(),
      onAttached: hook(),
      onReplaced: hook(),
      get: async (id: number) => ({ id, windowId: 1, url: tabOf(id).doc.url, title: "", status: "complete", active: false }),
      query: async () => [],
      // A message no copy took settles undefined; one to a held page, never.
      sendMessage: (id: number, m: Msg) => {
        const doc = tabOf(id).doc;
        trips.push(`message ${m.op}`);
        if (doc.held) return never();
        for (const listener of doc.listeners) {
          const reply = listener(m);
          if (reply) return reply;
        }
        return Promise.resolve(undefined);
      },
    },
    scripting: {
      executeScript: async ({ target, func, args = [], files }: Inject) => {
        const tab = tabOf(target.tabId);
        const doc = tab.doc;
        if (files) {
          copyIn(tab, doc);
          return [{ frameId: 0, result: null }];
        }
        const m = args[1] as Msg | undefined;
        if (m?.__safariHarness === 1) {
          trips.push(`script ${m.op}`);
          if (doc.held) return never();
        }
        const result = await new Function("window", `return (${func})`)(doc.world)(...args);
        // Safari may fail a script whose document went away while it ran.
        if (tab.doc !== doc) throw new Error("the frame's document went away");
        return [{ frameId: 0, result: result ?? null }];
      },
    },
    storage: { local: storage, session: storage },
    windows: { onFocusChanged: hook(), onRemoved: hook(), WINDOW_ID_NONE: -1 },
  };

  let seq = 0;
  const waiting = new Map<string, (answer: Answer) => void>();
  let socket: Socket | undefined;
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = Socket.CONNECTING;
    onopen = () => {};
    onmessage = (_ev: { data: string }) => {};
    constructor() { socket = this; }
    send(data: string) {
      const m = JSON.parse(data) as { id?: string; value?: unknown; error?: string };
      if (m.id !== undefined) waiting.get(m.id)?.({ value: m.value, error: m.error });
    }
    close() {}
  }

  new Function("browser", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "Date", "console", SOURCE)(
    browser, Socket, clock.setTimeout, clock.clearTimeout, () => 0, { now: () => clock.now }, { log: () => {} },
  );
  await settle();
  if (!socket) throw new Error("background.js opened no socket to the daemon");
  const open = socket;
  open.readyState = Socket.OPEN;
  open.onopen();

  let nextTab = 10;
  return {
    clock,
    trips,
    // A tab showing a page whose script reported in to this background page,
    // or, reported false, to an earlier run of it (Safari stops an idle one).
    open(url: string, reported = true): Tab {
      const tab = { id: nextTab++, doc: new Doc(url) };
      tabs.set(tab.id, tab);
      copyIn(tab, tab.doc, reported);
      return tab;
    },
    // A tab whose page was open since before the extension reloaded: its
    // copy of the script holds the claim and answers no one.
    openFromBefore(url: string): Tab {
      const tab = { id: nextTab++, doc: new Doc(url, false) };
      tab.doc.world.__safariHarnessInjected = {};
      tabs.set(tab.id, tab);
      return tab;
    },
    // The tab loads doc; Safari skips putting the script in some pages.
    navigate(tab: Tab, doc: Doc, script = true) {
      onUpdated.fire(tab.id, { status: "loading" });
      tab.doc = doc;
      if (script) copyIn(tab, doc);
      onUpdated.fire(tab.id, { status: "complete" });
    },
    // The page changes and Safari puts its script in, before the tab's new
    // load is seen.
    swap(tab: Tab, doc: Doc) {
      tab.doc = doc;
      copyIn(tab, doc);
    },
    // A page request as the daemon sends it (bridge.tab).
    ask(tab: Tab, op: string, args: unknown[] = []): Promise<Answer> {
      const id = `d${++seq}`;
      const answer = Promise.withResolvers<Answer>();
      waiting.set(id, answer.resolve);
      open.onmessage({ data: JSON.stringify({ id, op: "relay", args: [tab.id, op, args, 30000, 0] }) });
      return answer.promise;
    },
  };
}

test("a page that answered once takes each next request in one trip", async () => {
  const b = await start();
  const tab = b.open("https://example.com/", false);
  await b.ask(tab, "tabInfo");
  b.trips.length = 0;
  expect((await b.ask(tab, "tabInfo")).value).toEqual({ url: "https://example.com/" });
  expect(b.trips).toEqual(["message tabInfo"]);
});

test("a new page that reported in takes its first request in one trip", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  await b.ask(tab, "tabInfo");
  b.navigate(tab, new Doc("https://example.org/"));
  b.trips.length = 0;
  expect((await b.ask(tab, "tabInfo")).value).toEqual({ url: "https://example.org/" });
  expect(b.trips).toEqual(["message tabInfo"]);
});

test("after a new load, a page Safari put no script in is asked first", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  await b.ask(tab, "tabInfo");
  b.navigate(tab, new Doc("https://example.org/"), false);
  b.trips.length = 0;
  expect((await b.ask(tab, "tabInfo")).value).toEqual({ url: "https://example.org/" });
  expect(b.trips[0]).toBe("message ping");
});

test("a request the page no longer takes goes to its new document, once", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  const next = new Doc("https://example.org/");
  // no load seen, and no copy of the script in the new document yet
  tab.doc = next;
  expect((await b.ask(tab, "click", ["5"])).value).toEqual({ url: "https://example.org/" });
  expect(next.ran).toEqual(["click"]);
});

test("an action whose page navigates while it runs is not sent again", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  const first = tab.doc;
  const next = new Doc("https://example.org/");
  // Safari never settles a message whose page unloads mid-request.
  first.does = () => {
    b.navigate(tab, next);
    return never();
  };
  expect((await b.ask(tab, "click", ["5"])).value).toEqual({ ok: true, navigated: { url: "https://example.org/", title: "" } });
  expect(first.ran).toEqual(["click"]);
  expect(next.ran).toEqual([]);
});

test("a page open since before the reload takes reads through executeScript in one trip once reached", async () => {
  const b = await start();
  const tab = b.openFromBefore("https://example.com/");
  expect((await b.ask(tab, "tabInfo")).value).toEqual({ url: "https://example.com/" });
  b.trips.length = 0;
  expect((await b.ask(tab, "tabInfo")).value).toEqual({ url: "https://example.com/" });
  expect(b.trips).toEqual(["script tabInfo"]);
});

test("an action on a page open since before the reload runs once when the page goes away under it", async () => {
  const b = await start();
  const tab = b.openFromBefore("https://example.com/");
  await b.ask(tab, "tabInfo");
  const first = tab.doc;
  const next = new Doc("https://example.org/");
  first.does = () => {
    b.swap(tab, next);
    return { ok: true };
  };
  await b.ask(tab, "click", ["5"]);
  expect([...first.ran, ...next.ran].filter((op) => op === "click")).toEqual(["click"]);
});

test("a known page that stops answering fails at the ping time, not at the request's limit", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  tab.doc.held = true;
  let answer: Answer | undefined;
  b.ask(tab, "tabInfo").then((a) => { answer = a; });
  await b.clock.advance(10000);
  expect(answer?.error).toStartWith("the page at https://example.com/ did not answer within 5 s");
});

test("a stale ref or a heal in an embedded frame names the ref as the agent sent it, with the frame's prefix", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  tab.doc.does = () => ({ ok: true, healed: { ref: "3", now: "9" } });
  expect((await b.ask(tab, "click", ["f5:3"])).value).toEqual({ ok: true, healed: { ref: "f5:3", now: "f5:9" } });
  tab.doc.does = () => ({ error: "stale ref 3; re-run snapshot" });
  expect((await b.ask(tab, "click", ["f5:3"])).error).toBe("stale ref f5:3; re-run snapshot");
});
