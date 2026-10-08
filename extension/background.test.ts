// background.js takes each page request from the daemon to the content
// script in the tab. These tests load it under a fake extension API and a
// fake daemon socket and record every trip a request makes to the page, so
// what a request costs, and the rules for pages that change under it, are
// checked without Safari.

import { expect, test } from "bun:test";

const SOURCE = await Bun.file(new URL("./background.js", import.meta.url)).text();

type Msg = { __safariHarness?: number; id: string; op: string; args?: unknown[]; kept?: unknown };
type Reply = { id: string; value?: unknown; error?: string };
type Answer = { value?: unknown; error?: string };
type Sender = { tab: { id: number; windowId: number }; frameId: number };
type Inject = { target: { tabId: number }; func?: (...args: unknown[]) => unknown; args?: unknown[]; files?: string[] };
type Cookie = { name: string; value: string; domain: string; path: string; secure: boolean };

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
  // Safari lets the extension put no script in a blank tab, and says so.
  shut = false;
  // What Safari gives as the tab's title while it shows this document.
  title = "";
  does: (op: string, msg: Msg) => unknown = () => ({ url: this.url });
  constructor(readonly url: string, readonly live = true) {}
}

// window: the window it is in, 1 unless a test says otherwise.
type Tab = { id: number; doc: Doc; window?: number };

async function start() {
  const clock = new Clock();
  const trips: string[] = [];
  const tabs = new Map<number, Tab>();
  // The tab in front of each window, and the window focused last.
  const actives = new Map<number, number>();
  let focused = 1;
  // Each window's size, once one is set.
  const sizes = new Map<number, { width: number; height: number }>();
  // What Safari shows at each address the harness opens a tab on or loads
  // in one; any other address shows a page of its own.
  const pages = new Map<string, Doc>();
  const onMessage = new Hook<[unknown, Sender]>();
  const onUpdated = new Hook<[number, { status?: string; url?: string }, { url: string }]>();
  const onClicked = new Hook<[{ id: number; url: string; title: string }]>();
  const onRemoved = new Hook<[number]>();
  const hook = () => new Hook<unknown[]>();
  // Safari's storage areas keep what is put in them: session storage while
  // it runs (a recording lives there between steps), local storage past a
  // reload (the agent windows, and the order he focused windows in).
  const area = (kept: Map<string, unknown>) => ({
    get: async (keys: string | string[] | null) => Object.fromEntries([...kept].filter(([k]) => keys === null || [keys].flat().includes(k)).map(([k, v]) => [k, structuredClone(v)])),
    set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) kept.set(k, structuredClone(v)); },
    remove: async (keys: string | string[]) => { for (const k of [keys].flat()) kept.delete(k); },
  });
  const kept = new Map<string, unknown>();
  const session = area(kept);
  const storage = area(new Map());
  // Safari's cookie store as its extension API reaches it (WebKit's
  // WebExtensionContextAPICookiesCocoa.mm): getAll's domain takes that
  // domain's cookies and its subdomains', and remove deletes the first
  // cookie of that name the url would carry.
  const jar: Cookie[] = [];
  const tabOf = (id: number) => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`Tab '${id}' was not found`);
    return tab;
  };
  // A tab as Safari describes it; one is in front of its window only once a
  // test puts it there (focus).
  const row = (tab: Tab) => ({ id: tab.id, windowId: tab.window ?? 1, url: tab.doc.url, title: tab.doc.title, status: "complete", active: actives.get(tab.window ?? 1) === tab.id });

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
      const value = await doc.does(m.op, m);
      return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? { id: m.id, error: value.error } : { id: m.id, value };
    };
    w.__safariHarnessRun = (m: Msg) => (w.__safariHarnessInjected === claim ? answer(m) : null);
    if (!doc.live) return;
    doc.listeners.push((m) => (m.__safariHarness === 1 && w.__safariHarnessInjected === claim ? answer(m) : undefined));
    if (report) onMessage.fire({ __safariHarnessReady: 1 }, { tab: { id: tab.id, windowId: tab.window ?? 1 }, frameId: 0 });
  }

  // The tab loads doc; Safari skips putting the script in some pages.
  function load(tab: Tab, doc: Doc, script = true) {
    onUpdated.fire(tab.id, { status: "loading", url: doc.url }, { url: doc.url });
    tab.doc = doc;
    if (script) copyIn(tab, doc);
    onUpdated.fire(tab.id, { status: "complete" }, row(tab));
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
      // A tab the harness opens. Safari may tell of a tab before the call
      // that made it answers; here it always does, makeMs on.
      create: async ({ url, windowId = 1 }: { url: string; windowId?: number }) => {
        await made();
        const tab = { id: nextTab++, doc: pages.get(url) ?? new Doc(url), window: windowId };
        tabs.set(tab.id, tab);
        browser.tabs.onCreated.fire({ id: tab.id, windowId });
        copyIn(tab, tab.doc);
        return row(tab);
      },
      // goto: Safari loads the address in the tab.
      update: async (id: number, { url }: { url?: string }) => {
        const tab = tabOf(id);
        if (url !== undefined) load(tab, pages.get(url) ?? new Doc(url));
        return row(tab);
      },
      remove: async (id: number) => {
        tabs.delete(tabOf(id).id);
        onRemoved.fire(id);
      },
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
        if (tab.doc.shut) throw new Error("Invalid call to scripting.executeScript(). This extension does not have access to this tab.");
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
    cookies: {
      getAll: async ({ domain }: { domain: string }) => jar.filter((c) => c.domain === domain || c.domain.endsWith(`.${domain}`)).map((c) => ({ ...c })),
      remove: async ({ url, name }: { url: string; name: string }) => {
        const u = new URL(url);
        const i = jar.findIndex((c) => c.name === name && (c.domain.startsWith(".") ? `.${u.hostname}`.endsWith(c.domain) : c.domain === u.hostname) && u.pathname.startsWith(c.path) && (!c.secure || u.protocol === "https:"));
        return i < 0 ? null : jar.splice(i, 1)[0];
      },
    },
    windows: {
      onFocusChanged: hook(),
      onRemoved: hook(),
      WINDOW_ID_NONE: -1,
      // A window the harness opens on a page, told of as tabs.create's is,
      // or one a tab moves out to.
      create: async ({ url, tabId }: { url?: string; tabId?: number }) => {
        await made();
        if (tabId !== undefined) {
          const moved = tabOf(tabId);
          moved.window = nextWindow++;
          return { id: moved.window, tabs: [row(moved)] };
        }
        const tab = { id: nextTab++, doc: new Doc(url ?? ""), window: nextWindow++ };
        tabs.set(tab.id, tab);
        browser.tabs.onCreated.fire({ id: tab.id, windowId: tab.window });
        copyIn(tab, tab.doc);
        return { id: tab.window, tabs: [row(tab)] };
      },
      update: async (id: number, { width, height }: { width?: number; height?: number } = {}) => {
        if (width !== undefined && height !== undefined) sizes.set(id, { width, height });
        return { id, ...sizes.get(id) };
      },
      get: async (id: number) => ({ id }),
      getAll: async () => [...new Set([...tabs.values()].map((t) => t.window ?? 1))].map((id) => ({ id, ...sizes.get(id) })),
      getLastFocused: async () => ({ id: focused }),
    },
  };

  let seq = 0;
  const waiting = new Map<string, (answer: Answer) => void>();
  // What background.js tells the daemon unasked.
  const told: { op: string; [key: string]: unknown }[] = [];
  const sockets: Socket[] = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = Socket.CONNECTING;
    onopen = () => {};
    onmessage = (_ev: { data: string }) => {};
    onclose = () => {};
    constructor() { sockets.push(this); }
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
  const [open] = sockets;
  if (!open) throw new Error("background.js opened no socket to the daemon");
  open.readyState = Socket.OPEN;
  open.onopen();

  let nextTab = 10;
  let nextWindow = 100;
  // How long Safari takes to make a tab or window the harness asks for.
  let makeMs = 0;
  const made = () => new Promise<void>((resolve) => (makeMs ? clock.setTimeout(resolve, makeMs) : resolve()));
  // A request as the daemon sends it (bridge.request).
  const request = (op: string, args: unknown[]): Promise<Answer> => {
    const id = `d${++seq}`;
    const answer = Promise.withResolvers<Answer>();
    waiting.set(id, answer.resolve);
    open.onmessage({ data: JSON.stringify({ id, op, args }) });
    return answer.promise;
  };
  return {
    clock,
    trips,
    told,
    jar,
    sockets,
    // Safari takes ms to make each tab or window the harness asks for.
    slowMakes(ms: number) {
      makeMs = ms;
    },
    // A tab showing a page whose script reported in to this background page,
    // or, reported false, to an earlier run of it (Safari stops an idle one).
    open(url: string, reported = true, window = 1): Tab {
      const tab = { id: nextTab++, doc: new Doc(url), window };
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
    navigate: load,
    // Safari shows doc at its address when the harness opens or loads it.
    serve(doc: Doc) {
      pages.set(doc.url, doc);
    },
    // The tab that shows doc.
    showing(doc: Doc): Tab {
      const tab = [...tabs.values()].find((t) => t.doc === doc);
      if (!tab) throw new Error(`no tab shows ${doc.url}`);
      return tab;
    },
    // Safari also reports URL changes within one document, and may repeat
    // a URL or load-complete update without a new visit.
    update(tab: Tab, info: { status?: string; url?: string }) {
      onUpdated.fire(tab.id, info, row(tab));
    },
    // The page changes and Safari puts its script in, before the tab's new
    // load is seen.
    swap(tab: Tab, doc: Doc) {
      tab.doc = doc;
      copyIn(tab, doc);
    },
    // A page request as the daemon sends it (bridge.tab).
    ask(tab: Tab, op: string, args: unknown[] = []): Promise<Answer> {
      return request("relay", [tab.id, op, args, 30000, 0]);
    },
    request,
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
    // A blank one loads nothing and takes no script.
    create(opener?: Tab, blank = false, window = 1): Tab {
      const tab = { id: nextTab++, doc: new Doc(blank ? "" : "https://example.com/popup"), window };
      tab.doc.shut = blank;
      tabs.set(tab.id, tab);
      browser.tabs.onCreated.fire({ id: tab.id, windowId: window, ...(opener ? { openerTabId: opener.id } : {}) });
      if (!blank) copyIn(tab, tab.doc);
      return tab;
    },
    // The page in tab says a tab it opens is coming (content.js).
    announce(tab: Tab) {
      onMessage.fire({ __safariHarnessPopup: 1 }, { tab: { id: tab.id, windowId: tab.window ?? 1 }, frameId: 0 });
    },
    // A tab the harness opened, whose dialogs and popups are its own.
    own(tab: Tab) {
      return session.set({ [`dialogs:${tab.id}`]: { accept: false, text: null } });
    },
    close(tab: Tab) {
      tabs.delete(tab.id);
      onRemoved.fire(tab.id);
    },
    // He sizes window.
    size(window: number, width: number, height: number) {
      sizes.set(window, { width, height });
    },
    sizeOf: (window: number) => sizes.get(window),
    // He brings tab's window to the front, tab showing in it.
    focus(tab: Tab) {
      const window = tab.window ?? 1;
      actives.set(window, tab.id);
      focused = window;
      browser.windows.onFocusChanged.fire(window);
    },
    // The daemon goes away, and comes back.
    drop() { open.readyState = 3; },
    reconnect() {
      open.readyState = Socket.OPEN;
      open.onopen();
    },
    // The keepalive alarm wakes the extension, which connects unless it is.
    wake() { browser.alarms.onAlarm.fire({ name: "sh-keepalive" }); },
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

// open loads an address in a tab it makes, and goto in the tab it is given.
type Loader = { request(op: string, args: unknown[]): Promise<Answer>; open(url: string): Tab };
const loads: [string, (b: Loader, url: string) => Promise<Answer>, number][] = [
  ["open", (b, url) => b.request("tabs.open", [url]), 15000],
  ["goto", (b, url) => b.request("tabs.navigate", [b.open("https://example.com/").id, url]), 20000],
];

// On 10-05 open and goto of an AWS event's address answered Cvent's
// sign-on page ("Login"), a spinner whose script then sent the tab on to
// AWS's sign-in.
test.each(loads)("%s of a page that sends the tab on while it is checked answers with the page the tab lands on, and its title", async (_tool, load) => {
  const b = await start();
  const signOn = new Doc("https://login.example.com/sign-on");
  signOn.title = "Login";
  // still turning its spinner when it goes, so asked whether it is still
  // loading, it never answers
  signOn.does = never;
  b.serve(signOn);
  const signIn = new Doc("https://signin.example.com/login");
  signIn.title = "Sign in";
  let answer: Answer | undefined;
  load(b, signOn.url).then((a) => { answer = a; });
  await b.clock.advance(0);
  const tab = b.showing(signOn);
  // the load begins while the tab still shows the sign-on page
  b.update(tab, { status: "loading" });
  await b.clock.advance(300);
  b.swap(tab, signIn);
  await b.clock.advance(0);
  expect(answer?.value).toMatchObject({ url: signIn.url, title: "Sign in" });
});

test.each(loads)("%s follows a load that begins after the loaded reply while it still waits for a title", async (_tool, load) => {
  const b = await start();
  const first = new Doc("https://example.com/redirect");
  b.serve(first);
  let answer: Answer | undefined;
  load(b, first.url).then((a) => { answer = a; });
  await b.clock.advance(0);
  const tab = b.showing(first);
  b.update(tab, { status: "loading" });
  await b.clock.advance(1600);
  const last = new Doc("https://example.com/sign-in");
  last.title = "Sign in";
  b.swap(tab, last);
  await b.clock.advance(0);
  expect(answer?.value).toMatchObject({ url: last.url, title: "Sign in" });
});

test.each(loads)("%s of a ready page that stays put answers without moving the clock", async (_tool, load) => {
  const b = await start();
  const page = new Doc("https://example.com/account");
  page.title = "Account";
  b.serve(page);
  let answer: Answer | undefined;
  load(b, page.url).then((a) => { answer = a; });
  await b.clock.advance(0);
  expect(answer?.value).toMatchObject({ url: page.url, title: "Account" });
});

test.each(loads)("%s ends by its original deadline when the next page never becomes ready or gets a title", async (_tool, load, limit) => {
  const b = await start();
  const first = new Doc("https://example.com/sign-on");
  first.title = "Login";
  first.does = never;
  b.serve(first);
  let answer: Answer | undefined;
  load(b, first.url).then((a) => { answer = a; });
  await b.clock.advance(1000);
  const tab = b.showing(first);
  b.update(tab, { status: "loading" });
  // The address committed, but its document has not reported in.
  tab.doc = new Doc("https://example.com/pending");
  await b.clock.advance(limit - 1000);
  expect(answer?.value).toMatchObject({ url: tab.doc.url });
});

test.each(loads)("%s ends by its original deadline when the last page's loading check never answers", async (_tool, load, limit) => {
  const b = await start();
  const first = new Doc("https://example.com/sign-on");
  first.title = "Login";
  first.does = never;
  b.serve(first);
  let answer: Answer | undefined;
  load(b, first.url).then((a) => { answer = a; });
  await b.clock.advance(1000);
  const tab = b.showing(first);
  b.update(tab, { status: "loading" });
  await b.clock.advance(limit - 2000);
  const last = new Doc("https://example.com/last");
  last.does = never;
  b.swap(tab, last);
  await b.clock.advance(1000);
  expect(answer?.value).toMatchObject({ url: last.url });
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

// On 09-30 an eval that scrolled and slept in a loop ran past its 30 s on a
// page that answered all along, and was told the page did not answer
// (01a0f039). A page a dialog holds still fails at the ping.
test("an eval past its limit blames the code on a page that answers, and the page on one that is held", async () => {
  const b = await start();
  const busy = b.open("https://example.com/");
  busy.doc.does = () => never();
  const held = b.open("https://example.org/");
  held.doc.held = true;
  let ran: Answer | undefined;
  let stuck: Answer | undefined;
  b.ask(busy, "eval", ["1"]).then((a) => { ran = a; });
  b.ask(held, "eval", ["1"]).then((a) => { stuck = a; });
  await b.clock.advance(31_000);
  expect(ran?.error).toMatch(/ran past 30 s/);
  expect(ran?.error).not.toMatch(/did not answer/);
  expect(stuck?.error).toMatch(/did not answer within 5 s/);
});

// eval with page: true runs by executeScript, which has no limit of its
// own: on 09-30 page-world code past 30 s got only the daemon's time-out.
test("a page-world eval answers its value, and past its limit blames the code on a page that answers and the page on one that is held", async () => {
  const b = await start();
  const busy = b.open("https://example.com/");
  const held = b.open("https://example.org/");
  held.doc.held = true;
  const endless = "new Promise(() => {})";
  let ran: Answer | undefined;
  let stuck: Answer | undefined;
  b.request("evalPage", [busy.id, endless, 0, 30000]).then((a) => { ran = a; });
  b.request("evalPage", [held.id, endless, 0, 30000]).then((a) => { stuck = a; });
  expect((await b.request("evalPage", [busy.id, "1 + 1", 0, 30000])).value).toEqual({ ok: true, result: 2 });
  await b.clock.advance(31_000);
  expect(ran?.error).toMatch(/ran past 30 s/);
  expect(ran?.error).not.toMatch(/did not answer/);
  expect(stuck?.error).toMatch(/did not answer within 5 s/);
});

test("a stale ref or a heal in an embedded frame names the ref as the agent sent it, with the frame's prefix", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  tab.doc.does = () => ({ ok: true, healed: { ref: "3", now: "9" } });
  expect((await b.ask(tab, "click", ["f5:3"])).value).toEqual({ ok: true, healed: { ref: "f5:3", now: "f5:9" } });
  tab.doc.does = () => ({ error: "stale ref 3; re-run snapshot" });
  expect((await b.ask(tab, "click", ["f5:3"])).error).toBe("stale ref f5:3; re-run snapshot");
});

// On 10-07 Akyl's audit agents reloaded a page with goto and clicked a ref
// from their snapshot of it, and each click failed as a stale ref
// (partners, calendar, inbox).
test("an action whose ref went stale with a load goes again with that ref's fingerprint from the tab's latest snapshot, which the daemon never sees", async () => {
  const b = await start();
  const url = "https://example.com/inbox";
  const tab = b.open(url);
  const button = (name: string) => ({ role: "button", name, tag: "button", near: "", path: "button:nth-of-type(1)", index: 0, count: 1 });
  // the page drew another button at ref 2 between two snapshots
  for (const [name, last] of [["Archive", 4], ["Save", 6]] as const) {
    tab.doc.does = () => ({ url, snapshot: `[2] button "${name}"`, fingerprints: { 2: button(name) }, last });
    expect((await b.ask(tab, "snapshot", [{}])).value).toEqual({ url, snapshot: `[2] button "${name}"` });
  }
  const fresh = new Doc(url);
  const kept: unknown[] = [];
  fresh.does = (_op, m) => {
    kept.push(m.kept);
    return m.kept ? { ok: true, healed: { ref: "2", now: "7" } } : { error: "stale ref 2; re-run snapshot" };
  };
  b.navigate(tab, fresh);
  expect((await b.ask(tab, "click", ["2"])).value).toEqual({ ok: true, healed: { ref: "2", now: "7" } });
  expect(kept).toEqual([undefined, { url, last: 6, fingerprints: { 2: button("Save") } }]);
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

// 09-30: a blank tab taken as an owned page's popup never reported in, and
// each request to it waited 15 s for a page before failing (01a0f14c).
test("a blank tab a click opens answers a request at once once the click has taken it", async () => {
  const b = await start();
  const opener = b.open("https://example.com/");
  await b.own(opener);
  const made: Tab[] = [];
  opener.doc.does = (op) => (op === "click" ? (b.announce(opener), made.push(b.create(undefined, true)), { ok: true, expect: "tab" }) : {});
  const click = b.ask(opener, "click", ["1"]);
  await b.clock.advance(30_000);
  const [blank] = made;
  if (!blank) throw new Error("the click opened no tab");
  expect((await click).value).toMatchObject({ newTab: { id: blank.id } });
  let answer: Answer | undefined;
  b.ask(blank, "tabInfo").then((a) => { answer = a; });
  await b.clock.advance(0);
  // said to be blank, not held: a reload of a blank tab brings nothing back
  expect(answer?.error).toMatch(/\bblank\b/);
  expect(answer?.error).not.toMatch(/reload it with goto/);
});

test("a blank tab an owned page opens on its own answers a request at once once taken", async () => {
  const b = await start();
  const opener = b.open("https://example.com/");
  await b.own(opener);
  b.announce(opener);
  const blank = b.create(undefined, true);
  await b.clock.advance(10_000);
  let answer: Answer | undefined;
  b.ask(blank, "tabInfo").then((a) => { answer = a; });
  await b.clock.advance(0);
  expect(answer?.error).toMatch(/\bblank\b/);
  expect(answer?.error).not.toMatch(/reload it with goto/);
});

// 09-30: a tab the harness made itself was taken for an owned page's popup
// when the page said one was coming in the same second, and the page's own
// tab then went to no one. A page's tab Safari tells of while the harness
// still waits on its own goes to the page, as of when Safari made it.
const harnessMakes: [string, string, unknown[], number][] = [
  ["open", "tabs.open", ["https://example.com/other", true, 1], 0],
  ["an agent's window", "windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }], 0],
  ["an agent's window Safari takes a while to open", "windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }], 1500],
];

test.each(harnessMakes)("a tab the harness makes for %s is no page's popup, and the page's own tab still is", async (_what, op, args, ms) => {
  const b = await start();
  const opener = b.open("https://example.com/");
  await b.own(opener);
  b.slowMakes(ms);
  b.announce(opener);
  const made = b.request(op, args);
  await b.clock.advance(0);
  const popup = b.create();
  await b.clock.advance(10_000);
  expect((await made).error).toBeUndefined();
  expect(b.told.filter((m) => m.kind === "popup")).toEqual([{ op: "tab", kind: "popup", tab: popup.id, opener: opener.id, url: "https://example.com/popup" }]);
});

// 09-30: a blank tab Safari made while the keeper made a window's tab group
// went to an agent as an owned page's popup (01a0f14c).
test("a tab Safari makes in a window while the keeper makes its tab group is no page's popup, and once that step ends one is again", async () => {
  const b = await start();
  const opener = b.open("https://example.com/");
  await b.own(opener);
  await b.request("windows.regrouping", [1, true]);
  b.announce(opener);
  b.create(undefined, true);
  await b.clock.advance(10_000);
  await b.request("windows.regrouping", [1, false]);
  b.announce(opener);
  const popup = b.create();
  await b.clock.advance(10_000);
  expect(b.told.filter((m) => m.kind === "popup")).toEqual([{ op: "tab", kind: "popup", tab: popup.id, opener: opener.id, url: "https://example.com/popup" }]);
});

// A keeper stopped midway never says its step ended; the window's pages
// must not lose their popups to the user for good.
test("a window whose tab group step never ends takes a page's tab again a minute on", async () => {
  const b = await start();
  const opener = b.open("https://example.com/");
  await b.own(opener);
  await b.request("windows.regrouping", [1, true]);
  await b.clock.advance(60_000);
  b.announce(opener);
  const popup = b.create();
  await b.clock.advance(10_000);
  expect(b.told.filter((m) => m.kind === "popup")).toEqual([{ op: "tab", kind: "popup", tab: popup.id, opener: opener.id, url: "https://example.com/popup" }]);
});

// 09-30: a second page's word that a tab is coming, in the same second,
// replaced the first's, and the first page's tab went to the second page,
// which may be another agent's.
test("a page's tab goes to that page when another page, in its own window, says a tab is coming in the same second", async () => {
  const b = await start();
  const mine = b.open("https://example.com/");
  const theirs = b.open("https://example.org/", true, 2);
  await b.own(mine);
  await b.own(theirs);
  const made: Tab[] = [];
  mine.doc.does = (op) => (op === "click" ? (b.announce(mine), b.announce(theirs), made.push(b.create(), b.create(undefined, false, 2)), { ok: true, expect: "tab" }) : {});
  const click = b.ask(mine, "click", ["1"]);
  await b.clock.advance(10_000);
  const [own, other] = made;
  if (!own || !other) throw new Error("the click opened no tabs");
  expect((await click).value).toMatchObject({ newTab: { id: own.id } });
  expect(b.told.filter((m) => m.kind === "popup")).toEqual([{ op: "tab", kind: "popup", tab: other.id, opener: theirs.id, url: "https://example.com/popup" }]);
});

// 09-30: tool-result logging missed loads an agent made through eval or
// real input, and a page's later redirects and refreshes.
test("an owned tab reports each load and same-document address change once, even outside a tool call", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  await b.own(tab);
  await b.clock.advance(60_000);
  b.navigate(tab, new Doc("https://example.com/redirected"));
  b.update(tab, { url: tab.doc.url, status: "complete" });
  await b.clock.advance(20_000);
  // A reload may report no URL until complete, even on a page with no
  // content script. Keep the load's start time when completion is late.
  b.update(tab, { status: "loading" });
  await b.clock.advance(30_000);
  b.update(tab, { status: "complete" });
  await b.clock.advance(20_000);
  b.update(tab, { url: "https://example.com/route#result" });
  await b.clock.advance(0);
  expect(b.told.filter((m) => m.op === "load")).toEqual([
    { op: "load", url: "https://example.com/redirected", from: 60_000, to: 60_000 },
    { op: "load", url: "https://example.com/redirected", from: 80_000, to: 110_000 },
    { op: "load", url: "https://example.com/route#result", from: 130_000, to: 130_000 },
  ]);
});

test("reading the user's tab does not make its later visits the agent's", async () => {
  const b = await start();
  const his = b.open("https://example.com/");
  await b.ask(his, "snapshot");
  b.navigate(his, new Doc("https://example.com/private"));
  await b.clock.advance(20_000);
  b.update(his, { url: "https://example.com/private#later" });
  await b.clock.advance(0);
  expect(b.told.filter((m) => m.op === "load")).toEqual([]);
});

test("a popup that finished loading before the harness claimed it is recorded once, and later loads are recorded too", async () => {
  const b = await start();
  const opener = b.open("https://example.com/");
  await b.own(opener);
  await b.clock.advance(60_000);
  b.announce(opener);
  const popup = b.create();
  b.navigate(popup, new Doc("https://example.com/signed-in"));
  await b.clock.advance(0);
  b.update(popup, { url: popup.doc.url, status: "complete" });
  await b.clock.advance(20_000);
  b.navigate(popup, new Doc("https://example.com/account"));
  await b.clock.advance(0);
  expect(b.told.filter((m) => m.op === "load")).toEqual([
    { op: "load", url: "https://example.com/signed-in", from: 60_000, to: 60_000 },
    { op: "load", url: "https://example.com/account", from: 80_000, to: 80_000 },
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

// 09-29: a closing socket's close event came after the extension had
// opened its replacement; it dropped the replacement and opened a third,
// and the daemon swapped sockets every 1.5 s, failing every request.
test("an old socket closing after its replacement opened leaves the replacement connected", async () => {
  const b = await start();
  b.drop();
  b.wake();
  await b.clock.advance(0);
  const [old, now] = b.sockets;
  if (!old || !now) throw new Error("the alarm opened no second socket");
  now.readyState = 1;
  now.onopen();
  old.onclose();
  await b.clock.advance(60_000);
  expect(b.sockets.length).toBe(2);
});

test("stopping a wait keeps the top page's change summary", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  const waiting = Promise.withResolvers<unknown>();
  tab.doc.does = (op) => {
    if (op === "wait") return waiting.promise;
    if (op === "waitStop") waiting.resolve({ found: false, meanwhile: ["new: No case found"] });
    return { ok: true };
  };
  const answer = b.ask(tab, "wait", [null, { text: "Case details" }]);
  await b.clock.advance(0);
  await b.ask(tab, "waitStop");
  await b.clock.advance(0);
  expect(await answer).toEqual({ value: { found: false, meanwhile: ["new: No case found"] } });
});

// On 10-06 a page whose own script sent the tab on (location.href) reached
// the tab as one update, already "complete", with no "loading" before it;
// a wait sent to the page it left never answered.
test("a wait whose page's own script sends the tab on is answered by the page it lands on", async () => {
  const b = await start();
  const tab = b.open("https://example.com/slow");
  tab.doc.does = (op) => (op === "wait" ? never() : { ok: true });
  const landed = new Doc("https://example.com/landed");
  landed.does = (op) => (op === "wait" ? { found: true, already: true } : { ok: true });
  let answer: Answer | undefined;
  b.ask(tab, "wait", [null, { url: "landed" }]).then((a) => { answer = a; });
  await b.clock.advance(700);
  b.swap(tab, landed);
  b.update(tab, { status: "complete", url: landed.url });
  await b.clock.advance(0);
  expect(answer).toEqual({ value: { found: true, already: true } });
});

// Safari reports a change of the address's hash in the update a page's
// own redirect gets (10-06): the page is still there, and still answers.
test("an action whose page changes only its address's hash answers with that page's own receipt", async () => {
  const b = await start();
  const tab = b.open("https://example.com/app");
  const receipt = Promise.withResolvers<unknown>();
  tab.doc.does = () => receipt.promise;
  let answer: Answer | undefined;
  b.ask(tab, "click", ["5"]).then((a) => { answer = a; });
  await b.clock.advance(0);
  b.update(tab, { status: "complete", url: "https://example.com/app#step-2" });
  await b.clock.advance(0);
  receipt.resolve({ ok: true, effect: { added: 3 } });
  await b.clock.advance(0);
  expect(answer?.value).toMatchObject({ ok: true, effect: { added: 3 } });
  expect(tab.doc.ran).toEqual(["click"]);
});

// What a page's origin keeps, as the page's own script sees it.
function stored(world: Record<string, unknown>, url: string) {
  const local = new Map([["user", "1"]]);
  const session = new Map([["step", "phone"]]);
  const databases = new Set(["accounts"]);
  const caches = new Set(["static-v1"]);
  const workers = new Set(["/sw.js"]);
  Object.assign(world, {
    location: new URL(url),
    document: { cookie: "" },
    localStorage: { clear: () => local.clear() },
    sessionStorage: { clear: () => session.clear() },
    indexedDB: { databases: async () => [...databases].map((name) => ({ name, version: 1 })), deleteDatabase: (name: string) => databases.delete(name) },
    caches: { keys: async () => [...caches], delete: async (key: string) => caches.delete(key) },
    navigator: { serviceWorker: { getRegistrations: async () => [...workers].map((w) => ({ unregister: async () => workers.delete(w) })) } },
  });
  return () => [local, session, databases, caches, workers].map((s) => s.size);
}

// On 10-02 an agent made TikTok forget a failed sign-up by removing its
// rows from Safari's website data one at a time.
test("clearing a site's cookies removes every one of the site and its subdomains, none of another site's, and answers only counts", async () => {
  const b = await start();
  const cookie = (domain: string, name: string, path = "/", secure = true) => ({ name, value: `secret-${name}`, domain, path, secure });
  b.jar.push(
    cookie(".tiktok.com", "ttwid"),
    cookie("www.tiktok.com", "msToken"),
    cookie("tiktok.com", "tt_csrf_token", "/", false),
    cookie(".m.tiktok.com", "sessionid", "/passport"),
    cookie("nottiktok.com", "ttwid"),
    cookie(".example.org", "sid"),
  );
  expect(await b.request("cookies.clear", ["tiktok.com"])).toEqual({ value: { left: 0 } });
  expect(b.jar.map((c) => c.domain)).toEqual(["nottiktok.com", ".example.org"]);
});

test("clearing a page's storage empties its origin's local and session storage, databases, caches, and service workers", async () => {
  const b = await start();
  const tab = b.open("https://www.tiktok.com/signup");
  const sizes = stored(tab.doc.world, "https://www.tiktok.com");
  expect(await b.request("storage.clear", [tab.id])).toEqual({ value: { origin: "https://www.tiktok.com" } });
  expect(sizes()).toEqual([0, 0, 0, 0, 0]);
});

type ScriptCookie = { name: string; domain?: string; path: string };

// The cookies a page's script reads and writes through document.cookie. A
// write deletes one only if its name, domain (none for a host-only one),
// and path all match, as in a browser.
function scriptCookies(world: Record<string, unknown>, url: string, set: ScriptCookie[]) {
  const jar = [...set];
  const document = {
    get cookie() {
      return jar.map((c) => `${c.name}=1`).join("; ");
    },
    set cookie(line: string) {
      const [pair = "", ...attrs] = line.split(";").map((s) => s.trim());
      const attr = (key: string) => attrs.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
      if (attr("max-age") !== "0") return;
      const i = jar.findIndex((c) => c.name === pair.split("=")[0] && c.domain === attr("domain") && c.path === attr("path"));
      if (i >= 0) jar.splice(i, 1);
    },
  };
  Object.assign(world, { location: new URL(url), document });
  return () => jar.map((c) => c.name);
}

// 10-02 live: once Safari's cookie API removed httpbin.org's cookie, its
// server got none, but a new tab's script still read it from the page
// process's own copy, which only a delete written by script clears.
test("clearing a page's storage deletes every cookie its script reads, whatever domain and path it was set for", async () => {
  const b = await start();
  const tab = b.open("https://www.tiktok.com/signup");
  stored(tab.doc.world, "https://www.tiktok.com/signup");
  const left = scriptCookies(tab.doc.world, "https://www.tiktok.com/signup", [
    { name: "ttwid", domain: "tiktok.com", path: "/" },
    { name: "region", domain: "www.tiktok.com", path: "/" },
    { name: "msToken", path: "/" },
    { name: "csrf", path: "/signup" },
  ]);
  await b.request("storage.clear", [tab.id]);
  expect(left()).toEqual([]);
});

// 10-05: an OAuth consent tab an agent raised in its own window closed as
// its turn ended, while he was authorizing in it (01a10ea8).
test("an idle close leaves an agent's tab he has in front, and takes it once he is in another window", async () => {
  const b = await start();
  const his = b.open("https://example.org/");
  b.focus(his);
  const made = b.request("windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }]);
  await b.clock.advance(0);
  const { windowId } = (await made).value as { windowId: number };
  const consent = b.open("https://claude.ai/oauth/authorize", true, windowId);
  await b.own(consent);
  b.focus(consent);
  await b.clock.advance(0);
  expect(await b.request("tabs.close", [consent.id, "idle"])).toEqual({ value: { ok: false, front: true } });
  b.focus(his);
  await b.clock.advance(0);
  expect(await b.request("tabs.close", [consent.id, "idle"])).toEqual({ value: { ok: true } });
});

// 10-07: each size an agent asked for split its tab out of its window into
// one that named no agent, and the user saw one agent's work in two
// windows. Its keeper finds the window by a size no other window has.
test("sizing a tab in its agent's window sizes that window, at a size no other window has, and the tab stays in it", async () => {
  const b = await start();
  const his = b.open("https://example.org/");
  b.size(1, 390, 844);
  const made = b.request("windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }]);
  await b.clock.advance(0);
  const { windowId } = (await made).value as { windowId: number };
  const tab = b.open("https://example.com/", true, windowId);
  const sized = await b.request("window", [tab.id, { width: 390, height: 844 }, true]);
  expect(tab.window).toBe(windowId);
  expect(sized.value).toMatchObject({ windowId, size: { width: 390, height: 845 } });
  expect([b.sizeOf(windowId), b.sizeOf(his.window ?? 1)]).toEqual([{ width: 390, height: 845 }, { width: 390, height: 844 }]);
});
