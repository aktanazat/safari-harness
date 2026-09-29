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
  const onUpdated = new Hook<[number, { status: string; url?: string }]>();
  const onClicked = new Hook<[{ id: number; url: string; title: string }]>();
  const onRemoved = new Hook<[number]>();
  const hook = () => new Hook<unknown[]>();
  const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  // Session storage keeps what is put in it, as Safari's does while it
  // runs: a recording lives there between steps.
  const kept = new Map<string, unknown>();
  const session = {
    get: async (keys: string | string[] | null) => Object.fromEntries([...kept].filter(([k]) => keys === null || [keys].flat().includes(k)).map(([k, v]) => [k, structuredClone(v)])),
    set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) kept.set(k, structuredClone(v)); },
    remove: async (keys: string | string[]) => { for (const k of [keys].flat()) kept.delete(k); },
  };
  const tabOf = (id: number) => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`Tab '${id}' was not found`);
    return tab;
  };
  // A tab as Safari describes it; none here is the one in front of its window.
  const row = (tab: Tab) => ({ id: tab.id, windowId: 1, url: tab.doc.url, title: "", status: "complete", active: false });

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
    action: { onClicked, setBadgeText: async () => {}, setTitle: async () => {} },
    alarms: { onAlarm: hook(), create: () => {}, clear: async () => true },
    tabs: {
      onUpdated,
      onRemoved,
      onCreated: hook(),
      onAttached: hook(),
      onReplaced: hook(),
      get: async (id: number) => row(tabOf(id)),
      // what Safari finds for a filter on active and windowId
      query: async (q: { active?: boolean; windowId?: number } = {}) => [...tabs.values()].map(row).filter((t) => t.active === (q.active ?? t.active) && t.windowId === (q.windowId ?? t.windowId)),
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
    storage: { local: storage, session },
    windows: { onFocusChanged: hook(), onRemoved: hook(), WINDOW_ID_NONE: -1 },
  };

  let seq = 0;
  const waiting = new Map<string, (answer: Answer) => void>();
  // What background.js tells the daemon unasked.
  const told: { op: string; [key: string]: unknown }[] = [];
  let socket: Socket | undefined;
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = Socket.CONNECTING;
    onopen = () => {};
    onmessage = (_ev: { data: string }) => {};
    constructor() { socket = this; }
    send(data: string) {
      const m = JSON.parse(data) as { id?: string; op: string; value?: unknown; error?: string };
      if (m.id !== undefined) waiting.get(m.id)?.({ value: m.value, error: m.error });
      else told.push(m);
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
    told,
    // A tab showing a page whose script reported in to this background page,
    // or, reported false, to an earlier run of it (Safari stops an idle one).
    open(url: string, reported = true): Tab {
      const tab = { id: nextTab++, doc: new Doc(url) };
      tabs.set(tab.id, tab);
      copyIn(tab, tab.doc, reported);
      return tab;
    },
    // A tab whose page was open since before the extension reloaded: its
    // copy of the script holds the claim and answers no one. was is the id
    // Safari gave the tab before the reload, which its page keeps from when
    // it reported in (content.js).
    openFromBefore(url: string, was?: number): Tab {
      const tab = { id: nextTab++, doc: new Doc(url, false) };
      tab.doc.world.__safariHarnessInjected = {};
      if (was !== undefined) Object.assign(tab.doc.world, { __safariHarnessTab: was, __safariHarnessWindow: 1 });
      tabs.set(tab.id, tab);
      return tab;
    },
    // The tab loads doc; Safari skips putting the script in some pages.
    navigate(tab: Tab, doc: Doc, script = true) {
      onUpdated.fire(tab.id, { status: "loading", url: doc.url });
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
    // He clicks the toolbar button with tab in front.
    toolbar(tab: Tab) {
      onClicked.fire({ id: tab.id, url: tab.doc.url, title: "Example" });
    },
    // The page in tab reports a step it recorded.
    step(tab: Tab, step: unknown) {
      onMessage.fire({ __safariHarnessStep: 1, step }, { tab: { id: tab.id, windowId: 1 }, frameId: 0 });
    },
    // Safari makes a tab: one a page opened, or one of its own making (a
    // tab group's), with its opener when Safari says it; its page reports in.
    create(opener?: Tab): Tab {
      const tab = { id: nextTab++, doc: new Doc("https://example.com/popup") };
      tabs.set(tab.id, tab);
      browser.tabs.onCreated.fire({ id: tab.id, windowId: 1, ...(opener ? { openerTabId: opener.id } : {}) });
      copyIn(tab, tab.doc);
      return tab;
    },
    // The page in tab says a tab it opens is coming (content.js).
    announce(tab: Tab) {
      onMessage.fire({ __safariHarnessPopup: 1 }, { tab: { id: tab.id, windowId: 1 }, frameId: 0 });
    },
    // A tab the harness opened, whose dialogs and popups are its own.
    own(tab: Tab) {
      return session.set({ [`dialogs:${tab.id}`]: { accept: false, text: null } });
    },
    close(tab: Tab) {
      tabs.delete(tab.id);
      onRemoved.fire(tab.id);
    },
    // The daemon goes away, and comes back.
    drop() { open.readyState = 3; },
    reconnect() {
      open.readyState = Socket.OPEN;
      open.onopen();
    },
    // Safari loads the extension again (a deploy), its tabs still open, and
    // empties session storage; the background page's variables stay here.
    reloaded() {
      kept.clear();
      browser.runtime.onInstalled.fire();
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

const clickStep = (n: number) => ({ kind: "click", url: "https://example.com/", target: { role: "button", name: `Step ${n}`, tag: "button", near: "", path: "", index: 0, count: 1 } });
const recordings = (b: { told: { op: string; [key: string]: unknown }[] }) => b.told.filter((m) => m.op === "recording").map((m) => m.recording);

test("teach mode records the steps of the tab he started it in, and the daemon gets them when he stops", async () => {
  const b = await start();
  await b.clock.advance(60_000);
  const tab = b.open("https://example.com/");
  const other = b.open("https://example.org/");
  b.toolbar(tab);
  await b.clock.advance(0);
  expect(tab.doc.ran).toEqual(["record"]);
  b.step(tab, clickStep(1));
  b.step(other, clickStep(99));
  b.step(tab, clickStep(2));
  await b.clock.advance(1000);
  // what he was still typing when he stopped comes back with the stop
  const typing = { kind: "type", url: "https://example.com/", target: clickStep(3).target, value: "Ada" };
  tab.doc.does = (op) => (op === "record" ? { ok: true, recording: false, pending: typing } : {});
  b.toolbar(tab);
  await b.clock.advance(0);
  expect(recordings(b)).toEqual([{ url: "https://example.com/", title: "Example", startedAt: 60_000, steps: [clickStep(1), clickStep(2), typing], stoppedAt: 61_000, why: "stopped" }]);
  // stopped means stopped: a later step is nobody's
  b.step(tab, clickStep(4));
  await b.clock.advance(0);
  expect(recordings(b)).toHaveLength(1);
});

test("a load soon after a step is that step's doing, and one long after is his own", async () => {
  const b = await start();
  await b.clock.advance(60_000);
  const tab = b.open("https://example.com/");
  b.toolbar(tab);
  await b.clock.advance(0);
  b.step(tab, clickStep(1));
  await b.clock.advance(1000);
  b.navigate(tab, new Doc("https://example.com/next"));
  await b.clock.advance(20_000);
  b.navigate(tab, new Doc("https://example.com/later"));
  await b.clock.advance(1000);
  b.toolbar(tab);
  await b.clock.advance(0);
  expect(recordings(b)[0]).toMatchObject({
    steps: [clickStep(1), { kind: "navigate", url: "https://example.com/next", from: "step" }, { kind: "navigate", url: "https://example.com/later", from: "user" }],
  });
});

test("closing the recorded tab ends its recording, and one ended while the daemon is away reaches it when it is back", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  b.toolbar(tab);
  await b.clock.advance(0);
  b.step(tab, clickStep(1));
  await b.clock.advance(0);
  b.drop();
  b.close(tab);
  await b.clock.advance(0);
  expect(recordings(b)).toEqual([]);
  b.reconnect();
  await b.clock.advance(0);
  expect(recordings(b)).toMatchObject([{ url: "https://example.com/", steps: [clickStep(1)], why: "closed" }]);
});

test("a tab that appears while a click runs is not the click's unless its page says one is coming", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  // the tab group keeper's New Tab Group makes a tab mid-click
  tab.doc.does = (op) => (op === "click" ? (b.create(), { ok: true }) : {});
  const answer = b.ask(tab, "click", ["1"]);
  await b.clock.advance(5000);
  expect(await answer).toEqual({ value: { ok: true } });
});

test("a click whose page opens a tab reports it, whether Safari makes the tab before or after the page says so", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  const opened: Tab[] = [];
  const clicks = [
    () => { b.announce(tab); opened.push(b.create()); },
    () => { opened.push(b.create()); b.announce(tab); },
  ];
  for (const click of clicks) {
    tab.doc.does = (op) => (op === "click" ? (click(), { ok: true, expect: "tab" }) : {});
    const answer = b.ask(tab, "click", ["1"]);
    await b.clock.advance(5000);
    expect(await answer).toEqual({ value: { ok: true, newTab: { id: opened.at(-1)!.id, url: "https://example.com/popup", title: "" } } });
  }
});

test("a popup an owned page opens on its own goes to the agent, and one the user's page opens stays his", async () => {
  const b = await start();
  const owned = b.open("https://example.com/");
  const his = b.open("https://example.org/");
  await b.own(owned);
  b.announce(owned);
  const first = b.create();
  await b.clock.advance(2000);
  const second = b.create();
  b.announce(owned);
  await b.clock.advance(2000);
  b.announce(his);
  b.create();
  await b.clock.advance(2000);
  expect(b.told.filter((m) => m.kind === "popup")).toEqual([
    { op: "tab", kind: "popup", tab: first.id, opener: owned.id, url: "https://example.com/popup" },
    { op: "tab", kind: "popup", tab: second.id, opener: owned.id, url: "https://example.com/popup" },
  ]);
});

// A deploy reloads the extension, and Safari gives every tab a new id; the
// daemon, and agents through it, still hold the old ones. An extension that
// kept the new ids to itself would leave the daemon behind, and a daemon
// the same deploy restarted would never hear them.
test("a reloaded extension tells the daemon each tab's new id, and again each time it connects", async () => {
  const b = await start();
  const tab = b.openFromBefore("https://example.com/", 3);
  b.reloaded();
  await b.clock.advance(0);
  b.drop();
  b.reconnect();
  await b.clock.advance(0);
  const renumbered = { op: "tab", kind: "renumbered", tabs: { 3: tab.id } };
  expect(b.told.filter((m) => m.kind === "renumbered")).toEqual([renumbered, renumbered]);
});
