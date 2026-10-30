// background.js takes each page request from the daemon to the content
// script in the tab. These tests load it under a fake extension API and a
// fake daemon socket and record every trip a request makes to the page, so
// what a request costs, and the rules for pages that change under it, are
// checked without Safari.

import { expect, test } from "bun:test";

const SOURCE = `${await Bun.file(new URL("./upgrades.js", import.meta.url)).text()}\n${await Bun.file(new URL("./background.js", import.meta.url)).text()}`;

type Msg = { __safariHarness?: number; id: string; op: string; args?: unknown[]; kept?: unknown };
type Reply = { id: string; value?: unknown; error?: string; failure?: unknown };
type Answer = { value?: unknown; error?: string; failure?: unknown };
type Sender = { tab: { id: number; windowId: number }; frameId: number };
type Inject = { target: { tabId: number; frameIds?: number[]; allFrames?: boolean }; func?: (...args: unknown[]) => unknown; args?: unknown[]; files?: string[] };
type Cookie = { name: string; value: string; domain: string; path: string; secure: boolean };

type Raster = { width: number; height: number; pixels: number[] | Uint8Array };
const rasterData = (image: Raster) => Buffer.from(JSON.stringify({ ...image, pixels: Array.from(image.pixels) })).toString("base64");
const readRaster = (data: string): Raster => JSON.parse(Buffer.from(data, "base64").toString());
const rasterImage = (width: number, height: number, pixel: (x: number, y: number) => number): Raster => ({
  width, height, pixels: Array.from({ length: width * height }, (_, i) => pixel(i % width, Math.floor(i / width))),
});

class RasterCanvas {
  readonly pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number) { this.pixels = new Uint8Array(width * height); }
  getContext(_kind: string) {
    return {
      fillStyle: "#000",
      drawImage: (image: Raster, ...args: number[]) => {
        const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 2 ? [0, 0, image.width, image.height, args[0], args[1], image.width, image.height] : args;
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          const targetX = dx + x, targetY = dy + y;
          if (targetX >= 0 && targetY >= 0 && targetX < this.width && targetY < this.height) this.pixels[targetY * this.width + targetX] = image.pixels[Math.floor(sy + y * sh / dh) * image.width + Math.floor(sx + x * sw / dw)];
        }
      },
      fillRect: (left: number, top: number, width: number, height: number) => {
        for (let y = top; y < Math.min(this.height, top + height); y++) this.pixels.fill(0, y * this.width + left, y * this.width + Math.min(this.width, left + width));
      },
    };
  }
  async convertToBlob() { return new Blob([Buffer.from(rasterData(this), "base64")]); }
}

class RasterReader {
  result: string | null = null;
  error: Error | null = null;
  onload = () => {};
  onerror = () => {};
  readAsDataURL(blob: Blob) {
    blob.text().then((text) => { this.result = `data:image/png;base64,${Buffer.from(text).toString("base64")}`; this.onload(); }, (error: Error) => { this.error = error; this.onerror(); });
  }
}

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
  readonly world: Record<string, unknown> = { document: { querySelectorAll: () => [] }, __safariHarnessFrame: crypto.randomUUID().replaceAll("-", ""), innerWidth: 800, innerHeight: 600 };
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

// window: the window it is in, 1 unless a test says otherwise; frames: the
// documents of its embedded frames, by frame id.
type Tab = { id: number; doc: Doc; window?: number; frames?: Map<number, Doc>; incognito?: boolean };

// local: the extension's local storage, which a new background page reads;
// unread: a key of it whose first reads (times, 1 unless said) Safari
// leaves unanswered, or refuses.
async function start(local = new Map<string, unknown>(), unread?: { key: string; refused?: boolean; times?: number }) {
  const clock = new Clock();
  const trips: string[] = [];
  const tabs = new Map<number, Tab>();
  // The tab in front of each window, and the window focused last.
  const actives = new Map<number, number>();
  let focused = 1;
  let focusRead: { entered: () => void; wait: Promise<void> } | undefined;
  // Each window's size, once one is set.
  const sizes = new Map<number, { width: number; height: number }>();
  // What Safari shows at each address the harness opens a tab on or loads
  // in one; any other address shows a page of its own.
  const pages = new Map<string, Doc>();
  // The headers a server answers a fetch of each address with that serves
  // a file (serveFile); any other fetch reads a data: address.
  const served = new Map<string, Headers>();
  const onMessage = new Hook<[unknown, Sender]>();
  const onUpdated = new Hook<[number, { status?: string; url?: string }, { url: string }]>();
  const onActivated = new Hook<[{ tabId: number; windowId: number }]>();
  const onClicked = new Hook<[{ id: number; url: string; title: string }]>();
  const onRemoved = new Hook<[number, { windowId: number; isWindowClosing: boolean }?]>();
  const heldCloses = new Set<number>();
  let picture: () => string | Promise<string> = () => `data:image/png;base64,${rasterData(rasterImage(8, 6, () => 9))}`;
  // Safari stops answering windows.getAll (stallWindows), or the extension's
  // local storage (stallStorage), or its first reads of one key (unread),
  // or refuses every write to it (refuseWrites).
  let windowsStalled = false;
  let storageStalled = false;
  let writesRefused = false;
  let unreadLeft = unread?.times ?? 1;
  // Each read of the extension's local storage, by the keys it asked for.
  const localReads: (string | string[] | null)[] = [];
  const hook = () => new Hook<unknown[]>();
  // Safari's storage areas keep what is put in them: session storage while
  // it runs (a recording lives there between steps), local storage past a
  // reload (the agent windows, and the order he focused windows in).
  const area = (kept: Map<string, unknown>, stalls = false) => ({
    get: async (keys: string | string[] | null) => {
      if (stalls) localReads.push(keys);
      if (stalls && storageStalled) return never();
      if (stalls && unread && unreadLeft > 0 && [keys].flat().includes(unread.key)) {
        unreadLeft -= 1;
        if (unread.refused) throw new Error("Safari could not read the extension's storage");
        return never();
      }
      return Object.fromEntries([...kept].filter(([k]) => keys === null || [keys].flat().includes(k)).map(([k, v]) => [k, structuredClone(v)]));
    },
    set: async (items: Record<string, unknown>) => {
      if (stalls && storageStalled) return never();
      if (stalls && writesRefused) throw new Error("Invalid call to browser.storage.local.set(). Disk I/O error.");
      for (const [k, v] of Object.entries(items)) kept.set(k, structuredClone(v));
    },
    remove: async (keys: string | string[]) => { for (const k of [keys].flat()) kept.delete(k); },
  });
  const kept = new Map<string, unknown>();
  const session = area(kept);
  const storage = area(local, true);
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
  const row = (tab: Tab) => ({ id: tab.id, windowId: tab.window ?? 1, url: tab.doc.url, title: tab.doc.title, status: "complete", active: actives.get(tab.window ?? 1) === tab.id, incognito: tab.incognito ?? false });

  // What content.js does as it starts: take the page's claim unless another
  // copy holds it, answer through __safariHarnessRun, and, where its world's
  // messaging reaches this load, answer messages and report in.
  function copyIn(tab: Tab, doc: Doc, report = true, frameId = 0) {
    const w = doc.world;
    if (w.__safariHarnessInjected) return;
    const claim = {};
    w.__safariHarnessInjected = claim;
    const answer = async (m: Msg): Promise<Reply> => {
      if (m.op === "ping") return { id: m.id, value: true };
      doc.ran.push(m.op);
      // content.js sends a failure it reports as { error } as an error,
      // with the failure a refusal before any event carries
      const value = await doc.does(m.op, m);
      return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? { id: m.id, error: value.error, ...("failure" in value ? { failure: value.failure } : {}) } : { id: m.id, value };
    };
    w.__safariHarnessRun = (m: Msg) => (w.__safariHarnessInjected === claim ? answer(m) : null);
    if (!doc.live) return;
    doc.listeners.push((m) => (m.__safariHarness === 1 && w.__safariHarnessInjected === claim ? answer(m) : undefined));
    if (report) onMessage.fire({ __safariHarnessReady: 1 }, { tab: { id: tab.id, windowId: tab.window ?? 1 }, frameId });
  }

  // The tab loads doc; Safari skips putting the script in some pages.
  function load(tab: Tab, doc: Doc, script = true) {
    onUpdated.fire(tab.id, { status: "loading", url: doc.url }, { url: doc.url });
    tab.doc = doc;
    if (script) copyIn(tab, doc);
    onUpdated.fire(tab.id, { status: "complete" }, row(tab));
  }

  // When background.js asked Safari to reload the extension, by the clock.
  const reloadsAsked: number[] = [];
  const browser = {
    runtime: { onMessage, onInstalled: hook(), onStartup: hook(), onConnect: hook(), reload: () => { reloadsAsked.push(clock.now); } },
    action: { onClicked, setBadgeText: async () => {}, setTitle: async () => {} },
    alarms: { onAlarm: hook(), create: () => {}, clear: async () => true },
    tabs: {
      onUpdated,
      onActivated,
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
        if (!tab.doc.shut) copyIn(tab, tab.doc);
        return row(tab);
      },
      // goto: Safari loads the address in the tab.
      update: async (id: number, { url, active }: { url?: string; active?: boolean }) => {
        const tab = tabOf(id);
        if (url !== undefined) load(tab, pages.get(url) ?? new Doc(url));
        if (active && actives.get(tab.window ?? 1) !== id) {
          actives.set(tab.window ?? 1, id);
          onActivated.fire({ tabId: id, windowId: tab.window ?? 1 });
        }
        return row(tab);
      },
      remove: async (id: number) => {
        if (heldCloses.has(id)) return never();
        tabs.delete(tabOf(id).id);
        onRemoved.fire(id);
      },
      // A message no copy took settles undefined; one to a held page, never.
      sendMessage: (id: number, m: Msg, { frameId = 0 }: { frameId?: number } = {}) => {
        const tab = tabOf(id);
        const doc = frameId === 0 ? tab.doc : tab.frames?.get(frameId);
        trips.push(frameId === 0 ? `message ${m.op}` : `message ${m.op} to frame ${frameId}`);
        if (!doc) return Promise.resolve(undefined);
        if (doc.held) return never();
        for (const listener of doc.listeners) {
          const reply = listener(m);
          if (reply) return reply;
        }
        return Promise.resolve(undefined);
      },
      // The picture of what the tab's window shows.
      captureVisibleTab: async () => {
        trips.push("capture");
        return picture();
      },
    },
    scripting: {
      // In frame 0 unless the target names frames; allFrames, in each frame
      // the extension may enter.
      executeScript: async ({ target, func, args = [], files }: Inject) => {
        const refused = "Invalid call to scripting.executeScript(). This extension does not have access to this tab.";
        const tab = tabOf(target.tabId);
        if (tab.doc.shut) throw new Error(refused);
        const frameOf = (frameId: number) => (frameId === 0 ? tab.doc : tab.frames?.get(frameId));
        const frameIds = target.allFrames ? [0, ...(tab.frames?.keys() ?? [])] : (target.frameIds ?? [0]);
        const results: { frameId: number; result: unknown }[] = [];
        for (const frameId of frameIds) {
          const doc = frameOf(frameId);
          if (!doc || (doc.shut && target.allFrames)) continue;
          if (doc.shut) throw new Error(refused);
          if (files) {
            copyIn(tab, doc, true, frameId);
            results.push({ frameId, result: null });
            continue;
          }
          const m = args[1] as Msg | undefined;
          if (m?.__safariHarness === 1) {
            trips.push(`script ${m.op}`);
            if (doc.held) return never();
          }
          const result = await new Function("window", "location", "innerWidth", "innerHeight", `return (${func})`)(doc.world, new URL(doc.url), doc.world.innerWidth, doc.world.innerHeight)(...args);
          // Safari may fail a script whose document went away while it ran.
          if (frameOf(frameId) !== doc) throw new Error("the frame's document went away");
          results.push({ frameId, result: result ?? null });
        }
        return results;
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
      getAll: async () => (windowsStalled ? never() : [...new Set([...tabs.values()].map((t) => t.window ?? 1))].map((id) => ({ id, ...sizes.get(id) }))),
      getLastFocused: async () => {
        const held = focusRead;
        focusRead = undefined;
        if (held) { held.entered(); await held.wait; }
        return { id: focused, focused: focused >= 0 };
      },
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
    onclose = (_ev: { code: number }) => {};
    constructor() { sockets.push(this); }
    send(data: string) {
      const m = JSON.parse(data) as { id?: string; op: string; value?: unknown; error?: string; failure?: unknown };
      if (m.id !== undefined) waiting.get(m.id)?.({ value: m.value, error: m.error, ...(m.failure === undefined ? {} : { failure: m.failure }) });
      else told.push(m);
    }
    close() {}
  }

  new Function("browser", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "Date", "console", "OffscreenCanvas", "FileReader", "fetch", "createImageBitmap", SOURCE)(
    browser, Socket, clock.setTimeout, clock.clearTimeout, () => 0, class extends Date { constructor() { super(clock.now); } static now() { return clock.now; } }, { log: () => {} },
    RasterCanvas, RasterReader, async (url: string) => (served.has(url) ? { ok: true, url, headers: served.get(url) } : { blob: async () => new Blob([Buffer.from(url.split(",")[1], "base64")]) }),
    async (blob: Blob) => ({ ...JSON.parse(await blob.text()), close() {} }),
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
    localReads,
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
    // url serves a file with these headers: Safari downloads it, or shows
    // it as no page, and the tab opened on it keeps no address or script.
    serveFile(url: string, headers: Record<string, string>) {
      const blank = new Doc("");
      blank.shut = true;
      pages.set(url, blank);
      served.set(url, new Headers(headers));
      return blank;
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
    captureWith(next: () => string | Promise<string>) { picture = next; },
    active(window = 1) { return actives.get(window); },
    tabListenerCounts() { return { updated: onUpdated.listeners.size, activated: onActivated.listeners.size }; },
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
    holdClose(tab: Tab) { heldCloses.add(tab.id); },
    // He closes tab, or its window, which takes the tab with it.
    close(tab: Tab, withWindow = false) {
      tabs.delete(tab.id);
      onRemoved.fire(tab.id, { windowId: tab.window ?? 1, isWindowClosing: withWindow });
      if (withWindow) browser.windows.onRemoved.fire(tab.window ?? 1);
    },
    stallWindows() { windowsStalled = true; },
    holdFocusRead() {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      focusRead = { entered: entered.resolve, wait: release.promise };
      return { entered: entered.promise, release: release.resolve };
    },
    stallStorage() { storageStalled = true; },
    refuseWrites() { writesRefused = true; },
    // An embedded frame in tab's page, as frameId, showing url; its script
    // reports in.
    frame(tab: Tab, frameId: number, url: string): Doc {
      const doc = new Doc(url);
      (tab.frames ??= new Map()).set(frameId, doc);
      copyIn(tab, doc, true, frameId);
      return doc;
    },
    // He sizes window.
    size(window: number, width: number, height: number) {
      sizes.set(window, { width, height });
    },
    sizeOf: (window: number) => sizes.get(window),
    // He brings tab's window to the front, tab showing in it.
    focus(tab: Tab) {
      const window = tab.window ?? 1;
      if (actives.get(window) !== tab.id) {
        actives.set(window, tab.id);
        onActivated.fire({ tabId: tab.id, windowId: window });
      }
      focused = window;
      browser.windows.onFocusChanged.fire(window);
    },
    unfocus() {
      focused = -1;
      browser.windows.onFocusChanged.fire(-1);
    },
    disconnect() {
      open.readyState = 3;
      open.onclose({ code: 1006 });
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
    reloadsAsked,
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

test("after a new load, a page Safari put no script in still answers its first request", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  await b.ask(tab, "tabInfo");
  b.navigate(tab, new Doc("https://example.org/"), false);
  expect((await b.ask(tab, "tabInfo")).value).toEqual({ url: "https://example.org/" });
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

// A gather clicks Load more and scrolls as it reads: asked again of the
// page it went to, it would gather that page too, and harvest's answer
// would come back as an action's.
test.each([
  ["harvest", "expand"],
  ["extract", "expand"],
  ["extract", "scroll"],
] as const)("%s with %s, whose page navigates while it gathers, is not sent again and names where the page went", async (op, how) => {
  const b = await start();
  const tab = b.open("https://example.com/");
  const first = tab.doc;
  const next = new Doc("https://example.org/");
  first.does = () => {
    b.navigate(tab, next);
    return never();
  };
  expect((await b.ask(tab, op, [{ [how]: true }])).error).toContain("https://example.org/");
  expect(first.ran).toEqual([op]);
  expect(next.ran).toEqual([]);
});

// 10-28 to 10-29 the link dropped 533 times, it seems at one answer over
// what the daemon reads, each drop failing every request on it (MESSAGE_MAX
// in bridge.ts).
test("an answer over what the daemon reads fails its own request alone, and the link carries the next", async () => {
  const b = await start();
  const [link] = b.sockets;
  link.onmessage({ data: JSON.stringify({ op: "limit", bytes: 4000 }) });
  const frames: number[] = [];
  const send = link.send.bind(link);
  link.send = (data: string) => {
    frames.push(Buffer.byteLength(data));
    send(data);
  };
  const tab = b.open("https://example.com/");
  // 2 bytes a character in UTF-8: 6 KB in 3,000 characters
  tab.doc.does = (op) => (op === "extract" ? { text: "é".repeat(3000) } : { url: tab.doc.url });
  const big = await b.ask(tab, "extract", [{}]);
  expect(big.value).toBeUndefined();
  expect(big.error).toContain("answer too large");
  expect((await b.ask(tab, "tabInfo")).value).toEqual({ url: "https://example.com/" });
  expect(Math.max(...frames)).toBeLessThanOrEqual(4000);
  expect(b.sockets).toHaveLength(1);
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

// On 10-29 an open of a .pkg made Safari ask whether the site may download;
// that alert, in a hidden agent window, held Safari's main thread for over
// 20 min, and every request to the extension hung.
test.each(loads)("%s of an installer's address answers the file without loading it in any tab", async (_tool, load) => {
  const b = await start();
  const url = "https://example.com/dist/setup-3.13.pkg";
  const installer = b.serveFile(url, { "content-type": "application/octet-stream", "content-length": "70239759" });
  let answer: Answer | undefined;
  load(b, url).then((a) => { answer = a; });
  await b.clock.advance(6000);
  expect(answer?.value).toMatchObject({ url, file: "download", fileBytes: 70239759 });
  expect(() => b.showing(installer)).toThrow();
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
  expect(answer?.error).toStartWith("the page at https://example.com/ did not answer in 10 s");
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
  expect(stuck?.error).toMatch(/did not answer in 10 s/);
});

// On 10-23 a map's eval that awaited fetch() ran past its limit and was
// told a video or animation in a tab behind another never settles (HD-10).
test("an eval past its limit that awaited a fetch is told to bound the fetch, not about video", async () => {
  const b = await start();
  const busy = b.open("https://example.com/");
  busy.doc.does = () => never();
  let ran: Answer | undefined;
  b.ask(busy, "eval", ["const r = await fetch('/api/items'); return r.json()"]).then((a) => { ran = a; });
  await b.clock.advance(31_000);
  expect(ran?.error).toMatch(/ran past 30 s.*A fetch you awaited never answered: bound it with AbortSignal\.timeout/);
  expect(ran?.error).not.toMatch(/video/);
});

// On 10-23 an open with a snapshot answered Safari's own words, "This
// extension does not have access to this tab", and the agent left the
// address unexplained (SONA-13).
test("a request Safari refuses the extension's script names the tab's address and what to check", async () => {
  const b = await start();
  const tab = b.open("https://nas.tail1234.ts.net/");
  tab.doc.shut = true;
  const answer = await b.request("evalPage", [tab.id, "1", 0, 30000]);
  expect(answer.error).toStartWith("Safari would not let the extension into the tab at https://nas.tail1234.ts.net/: it shows a page no extension may read, most often Safari's own page for a site that did not load");
});

// On 10-22 and 10-23 open answered tabs whose address downloaded a file,
// and each read of one then waited 36 s to fail with "Safari lets no
// extension into :" or "this tab is blank" (K3, K13, SR-7).
test.each([
  ["a PDF", { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="leaflet.pdf"' }, "pdf", 'this address is a PDF, which Safari does not show as a page: read its text with pdf {do: "read", url: "https://example.com/leaflet?download=true"}'],
  ["another file", { "content-type": "application/zip" }, "download", 'this address downloads a file (application/zip), which Safari does not show as a page: save it with download {url: "https://example.com/leaflet?download=true"}'],
])("open of an address that downloads %s answers once the tab shows no page, and a read of the tab says what to use at once", async (_name, headers, file, told) => {
  const b = await start();
  const url = "https://example.com/leaflet?download=true";
  b.serveFile(url, headers);
  let opened: Answer | undefined;
  b.request("tabs.open", [url, true]).then((a) => { opened = a; });
  // an owned tab first waits out its dialog setting (5 s), then FILE_WAIT_MS
  await b.clock.advance(7000);
  expect(opened?.value).toMatchObject({ url, file });
  const tab = opened?.value;
  if (!tab || typeof tab !== "object" || !("id" in tab)) throw new Error("open answered no tab");
  let read: Answer | undefined;
  b.request("relay", [tab.id, "extract", [{}], 30000, 0]).then((a) => { read = a; });
  await b.clock.advance(0);
  expect(read?.error).toBe(told);
});

test("open of a page slow to load is not taken for a file", async () => {
  const b = await start();
  const url = "https://example.com/guide";
  b.serveFile(url, { "content-type": "text/html; charset=utf-8" });
  let opened: Answer | undefined;
  b.request("tabs.open", [url, true]).then((a) => { opened = a; });
  await b.clock.advance(15_000);
  expect(opened?.value).not.toHaveProperty("file");
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
  expect(stuck?.error).toMatch(/did not answer in 10 s/);
});

test("a stale ref or a heal in an embedded frame names the ref as the agent sent it, with the frame's prefix", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  const frame = b.frame(tab, 5, "https://example.com/embedded");
  const healed = { ref: "3", now: "9" };
  frame.does = (op) => op === "clickProbe" ? { frame: frame.world.__safariHarnessFrame, x: 10, y: 20, healed } : { ok: true, healed };
  tab.doc.does = (op) => op === "assertFrameClickable" ? { found: true, frame: tab.doc.world.__safariHarnessFrame, x: 10, y: 20 } : { url: tab.doc.url };
  expect((await b.ask(tab, "click", ["f5:3"])).value).toEqual({ ok: true, healed: { ref: "f5:3", now: "f5:9" } });
  frame.does = () => ({ error: "stale ref 3; re-run snapshot" });
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

// On 10-23 a click on a link that opens a window answered ok after 3 s
// with nothing opened; real_input on the same ref opened it.
test("a click whose page asks for a tab that never comes says to click it with real_input", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  tab.doc.does = (op) => (op === "click" ? { ok: true, expect: "tab" } : {});
  const answer = b.ask(tab, "click", ["1"]);
  await b.clock.advance(5000);
  expect(await answer).toEqual({ value: { ok: true, next: expect.stringContaining("real_input") } });
});

test("a click the page refused before any event reaches the daemon with its failure", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  const refusal = { error: "that target is covered by div \"Cookies\"", failure: { code: "stale_view", effect: "none" } };
  tab.doc.does = (op) => (op === "click" ? refusal : {});
  expect(await b.ask(tab, "click", ["1"])).toEqual(refusal);
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

test("a daemon reconnect confirms unchanged owned tabs but never personal, closed, or unproven tabs", async () => {
  const b = await start();
  b.open("https://personal.example/");
  const owned = b.open("https://example.com/?token=fixture");
  await b.own(owned);
  const closed = b.open("https://closed.example/");
  await b.own(closed);
  b.close(closed);
  await b.clock.advance(0);
  b.told.length = 0;
  b.drop();
  b.reconnect();
  await b.clock.advance(0);
  expect(b.told.filter(m => m.kind === "renumbered")).toEqual([{ op: "tab", kind: "renumbered", tabs: { [owned.id]: owned.id } }]);
  b.reloaded();
  await b.clock.advance(0);
  b.told.length = 0;
  b.drop();
  b.reconnect();
  await b.clock.advance(0);
  expect(b.told.filter(m => m.kind === "renumbered")).toEqual([]);
});

// 10-20 and 10-21: on a Mac nearly out of memory, Safari answered every
// write to the extension's local storage "Invalid call to
// browser.storage.local.set(). Disk I/O error." until it was quit. Each
// agent's first tab failed with it, and a Slack message the owner had
// approved was not sent.
test("an agent window opens while Safari refuses writes to the extension's local storage, and stays out of his front tab", async () => {
  const b = await start();
  b.refuseWrites();
  const his = b.open("https://example.org/");
  b.focus(his);
  const made = b.request("windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }]);
  await b.clock.advance(0);
  const { windowId } = (await made).value as { windowId: number };
  const agents = b.open("https://example.com/", true, windowId);
  b.focus(agents);
  await b.clock.advance(0);
  const { value } = await b.request("tabs.list", []);
  expect((value as { active: boolean }[]).filter((t) => t.active)).toEqual([
    { id: his.id, url: "https://example.org/", title: "", active: true, windowId: 1, front: true },
    { id: agents.id, url: "https://example.com/", title: "", active: true, windowId, shown: true },
  ]);
});

test("a reloaded extension tells the daemon each tab's new id while Safari refuses writes to its local storage", async () => {
  const b = await start();
  const tab = b.openFromBefore("https://example.com/", 3);
  b.refuseWrites();
  b.reloaded();
  await b.clock.advance(0);
  expect(b.told.filter((m) => m.kind === "renumbered")).toEqual([{ op: "tab", kind: "renumbered", tabs: { 3: tab.id } }]);
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

// 10-13: the extension answered nothing for over two minutes, its page
// running all along, until it was turned off and on in Safari Settings, and
// turning it on made macOS ask the owner for his password. The daemon asks
// a stuck extension to reload itself instead (bridge.ts).
test("the daemon's reload frame has the extension ask Safari to reload it", async () => {
  const b = await start();
  b.sockets[0]?.onmessage({ data: JSON.stringify({ op: "reload" }) });
  expect(b.reloadsAsked).toHaveLength(1);
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
test.each(["idle", "owned"])("an %s close leaves an agent's tab he has in front, and takes it once he is in another window", async (only) => {
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
  expect(await b.request("tabs.close", [consent.id, only])).toEqual({ value: { ok: false, front: true } });
  b.focus(his);
  await b.clock.advance(0);
  expect(await b.request("tabs.close", [consent.id, only])).toEqual({ value: { ok: true } });
});

test.each([
  ["text", { tagName: "INPUT", value: "draft", defaultValue: "" }],
  ["textarea", { tagName: "TEXTAREA", value: "draft", defaultValue: "" }],
  ["checkbox", { tagName: "INPUT", type: "checkbox", checked: true, defaultChecked: false }],
  ["selection", { tagName: "SELECT", options: [{ selected: false, defaultSelected: true }, { selected: true, defaultSelected: false }] }],
  ["editable", { isContentEditable: true, textContent: "draft" }],
])("automatic cleanup preserves an unsent %s without returning its contents", async (_kind, field) => {
  const b = await start();
  const tab = b.open("https://fixture.example/form"); await b.own(tab);
  tab.doc.world.document = { querySelectorAll: () => [field] };
  const result = await b.request("tabs.close", [tab.id, "owned"]);
  const listing = await b.request("tabs.list", []);
  expect({ result, count: (listing.value as unknown[]).length }).toEqual({ result: { value: { ok: false, protected: "form" } }, count: 1 });
});

test("automatic cleanup closes an untouched select whose browser default is its first option", async () => {
  const b = await start();
  const tab = b.open("https://fixture.example/select"); await b.own(tab);
  tab.doc.world.document = { querySelectorAll: () => [{ tagName: "SELECT", options: [{ selected: true, defaultSelected: false }, { selected: false, defaultSelected: false }] }] };
  expect(await b.request("tabs.close", [tab.id, "idle"])).toEqual({ value: { ok: true } });
  expect(((await b.request("tabs.list", [])).value as unknown[]).length).toBe(0);
});

test("automatic cleanup preserves a page Safari will not let it inspect", async () => {
  const b = await start();
  const tab = b.open("https://fixture.example/blocked"); await b.own(tab);
  tab.doc.shut = true;
  expect(await b.request("tabs.close", [tab.id, "owned"])).toEqual({ value: { ok: false, protected: "unreadable" } });
  expect(((await b.request("tabs.list", [])).value as unknown[]).length).toBe(1);
});

test("automatic cleanup never replaces a page with a blank page when Safari refuses its close", async () => {
  const b = await start();
  const tab = b.open("https://fixture.example/result"); await b.own(tab); b.holdClose(tab);
  const result = b.request("tabs.close", [tab.id, "idle"]);
  await b.clock.advance(15000);
  expect(await result).toMatchObject({ error: expect.stringContaining("Safari did not close the tab") });
  expect(tab.doc.url).toBe("https://fixture.example/result");
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

// Through 10-16 a page silent to a ping held each request to it for the
// ping's 5 s and more, 807 times, one tab 39 times.
test("a page that answered nothing fails the next request to it within a second and answers again once it is free", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  tab.doc.held = true;
  let first: Answer | undefined;
  b.ask(tab, "tabInfo").then((a) => { first = a; });
  await b.clock.advance(10_000);
  let again: Answer | undefined;
  b.ask(tab, "tabInfo").then((a) => { again = a; });
  await b.clock.advance(1000);
  expect([first?.error, again?.error]).toEqual([
    expect.stringContaining("did not answer"),
    expect.stringContaining("did not answer"),
  ]);
  tab.doc.held = false;
  const free = b.ask(tab, "tabInfo");
  await b.clock.advance(0);
  expect((await free).value).toEqual({ url: "https://example.com/" });
});

// 10-13 and 10-16: tab lists came in storms, each waiting out the daemon's
// limit.
test("a tab list whose front window Safari will not tell answers within its limit, its tabs marked partial, and a close leaves the tab", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  await b.own(tab);
  b.focus(tab);
  b.stallWindows();
  const listed = b.request("tabs.list", []);
  const closed = b.request("tabs.close", [tab.id, "idle"]);
  await b.clock.advance(2500);
  expect([await listed, await closed]).toEqual([
    { value: [{ id: tab.id, url: "https://example.com/", title: "", active: true, windowId: 1, partial: "windows.getAll" }] },
    { value: { ok: false, front: true } },
  ]);
});

// 10-20: Safari left the extension's local storage unanswered past 2.5 s,
// again and again for two minutes, and each tab list waited it out naming
// no front tab, so tab: "front" failed (journal: slow-phase
// storage.local.get).
test("a tab list names his front tab, not the agent window Safari shows, while Safari's local storage does not answer", async () => {
  const b = await start();
  const his = b.open("https://example.org/");
  b.focus(his);
  const made = b.request("windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }]);
  await b.clock.advance(0);
  const { windowId } = (await made).value as { windowId: number };
  const agents = b.open("https://example.com/", true, windowId);
  b.focus(agents);
  b.stallStorage();
  const listed = b.request("tabs.list", []);
  await b.clock.advance(2500);
  const { value } = await listed;
  expect((value as { active: boolean }[]).filter((t) => t.active)).toEqual([
    { id: his.id, url: "https://example.org/", title: "", active: true, windowId: 1, front: true },
    { id: agents.id, url: "https://example.com/", title: "", active: true, windowId, shown: true },
  ]);
});

// Safari may stop the extension's background page and start it again.
test("a new background page still leaves the agent windows the last one made out of his front tab", async () => {
  const local = new Map<string, unknown>();
  const before = await start(local);
  const made = before.request("windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }]);
  await before.clock.advance(0);
  const { windowId } = (await made).value as { windowId: number };
  const b = await start(local);
  const his = b.open("https://example.org/");
  const agents = b.open("https://example.com/", true, windowId);
  b.focus(his);
  b.focus(agents);
  await b.clock.advance(0);
  const { value } = await b.request("tabs.list", []);
  expect((value as { active: boolean }[]).filter((t) => t.active)).toEqual([
    { id: his.id, url: "https://example.org/", title: "", active: true, windowId: 1, front: true },
    { id: agents.id, url: "https://example.com/", title: "", active: true, windowId, shown: true },
  ]);
});

test("a background page whose first read of the agent windows Safari leaves unanswered still leaves them out of his front tab", async () => {
  const local = new Map<string, unknown>();
  const before = await start(local);
  const made = before.request("windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }]);
  await before.clock.advance(0);
  const { windowId } = (await made).value as { windowId: number };
  const b = await start(local, { key: "agentWindows" });
  const his = b.open("https://example.org/");
  const agents = b.open("https://example.com/", true, windowId);
  b.focus(his);
  b.focus(agents);
  await b.clock.advance(2500);
  const listed = b.request("tabs.list", []);
  await b.clock.advance(2500);
  const { value } = await listed;
  expect((value as { active: boolean }[]).filter((t) => t.active)).toEqual([
    { id: his.id, url: "https://example.org/", title: "", active: true, windowId: 1, front: true },
    { id: agents.id, url: "https://example.com/", title: "", active: true, windowId, shown: true },
  ]);
});

// A read Safari refuses is no answer either: lists taken as empty in its
// place would be written back by the next change.
test("a background page whose first read of the agent windows Safari refuses keeps them through its next change", async () => {
  const local = new Map<string, unknown>();
  const before = await start(local);
  const made = before.request("windows.open", ["http://127.0.0.1:37334/space?id=1&name=agent", { width: 1001, height: 777 }]);
  await before.clock.advance(0);
  const { windowId } = (await made).value as { windowId: number };
  const b = await start(local, { key: "agentWindows", refused: true });
  b.close(b.open("https://example.net/", true, 2), true);
  await b.clock.advance(2500);
  const c = await start(local);
  const his = c.open("https://example.org/");
  const agents = c.open("https://example.com/", true, windowId);
  c.focus(his);
  c.focus(agents);
  await c.clock.advance(0);
  const { value } = await c.request("tabs.list", []);
  expect((value as { active: boolean }[]).filter((t) => t.active)).toEqual([
    { id: his.id, url: "https://example.org/", title: "", active: true, windowId: 1, front: true },
    { id: agents.id, url: "https://example.com/", title: "", active: true, windowId, shown: true },
  ]);
});

test("a background page Safari never gives the window lists asks for them less and less often", async () => {
  const b = await start(new Map(), { key: "agentWindows", times: Infinity });
  await b.clock.advance(600_000);
  expect(b.localReads.filter((keys) => [keys].flat().includes("agentWindows")).length).toBeLessThanOrEqual(30);
});

// S99: seven window calls answered the viewport from before the resize,
// and the agent reloaded pages and measured innerWidth to be sure.
test("sizing a window answers the viewport the page lays out at once it has", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  // the page lays out at the window's new size 300 ms after Safari sizes it
  let laidOut: number | undefined;
  tab.doc.does = () => {
    const size = b.sizeOf(tab.window ?? 1);
    if (size && laidOut === undefined) laidOut = b.clock.now + 300;
    return { url: "https://example.com/", viewport: { w: size && b.clock.now >= (laidOut ?? Infinity) ? size.width : 1440, h: 900 } };
  };
  const sized = b.request("window", [tab.id, { width: 390, height: 844 }]);
  await b.clock.advance(1000);
  expect((await sized).value).toMatchObject({ viewport: { w: 390, h: 900 } });
});

// S99PartA: a page's animations stalled in a tab behind another, and the
// agent worked around them by hand before its shots.
test("ordinary screenshots finish finite animations and live screenshots leave them running", async () => {
  const b = await start();
  const tab = b.open("https://example.com/");
  const page = shotPage(tab);
  b.focus(tab);
  await b.request("shot", [tab.id, {}]);
  const settled = page.finished;
  await b.request("shot", [tab.id, { live: true }]);
  expect([settled, page.finished]).toEqual([2, 2]);
});

// On 10-19 SheerID's verification form sat in a frame of its own over
// Adorama's page: a wait for its "Add documents" to go answered at once,
// and extract read the empty dialog around it.
async function sheerid() {
  const b = await start();
  const tab = b.open("https://www.adorama.com/");
  const form = b.frame(tab, 5, "https://services.sheerid.com/verify/");
  form.world.__safariHarnessFrame = "sheerid";
  return { b, tab, form };
}

test("a wait for text to go holds while an embedded frame still shows it, and ends once the frame no longer does", async () => {
  const { b, tab, form } = await sheerid();
  tab.doc.does = (op) => (op === "wait" ? { found: true, already: true, hint: '"Add documents" was not on the page as the wait began' } : { url: tab.doc.url });
  const left = Promise.withResolvers<unknown>();
  form.does = (op) => {
    if (op !== "wait") return { url: form.url };
    return left.promise;
  };
  let answer: Answer | undefined;
  void b.ask(tab, "wait", [null, { gone: "Add documents" }]).then((a) => (answer = a));
  await b.clock.advance(1000);
  expect(answer).toBeUndefined();
  left.resolve({ found: true });
  await b.clock.advance(0);
  expect(answer).toEqual({ value: { found: true } });
});

test("extract reads an embedded frame shown in what it read, which the page cannot read itself, after the page's own text", async () => {
  const { b, tab, form } = await sheerid();
  tab.doc.does = (op) => (op === "extract"
    ? { url: tab.doc.url, title: "Adorama", text: "", truncated: false, note: 'no line on the page contains "documents" (the page has 0 characters of text)', frames: [{ token: "sheerid", name: 'iframe "SheerID Verification Form"' }] }
    : { url: tab.doc.url });
  form.does = () => ({ url: form.url, title: "SheerID", text: "Add documents", truncated: false });
  expect(await b.ask(tab, "extract", [{ query: "documents" }])).toEqual({
    value: { url: tab.doc.url, title: "Adorama", text: 'iframe "SheerID Verification Form":\nAdd documents', truncated: false },
  });
});

// A gather clicks and scrolls the page it reads; each frame asked to gather
// too would click and scroll on the same call's time.
test("extract that gathers reads an embedded frame plain", async () => {
  const { b, tab, form } = await sheerid();
  tab.doc.does = (op) => (op === "extract" ? { url: tab.doc.url, title: "Adorama", text: "Thread", truncated: false, frames: [{ token: "sheerid", name: "frame" }] } : { url: tab.doc.url });
  const asked: unknown[] = [];
  form.does = (op, m) => {
    if (op === "extract") asked.push(m.args?.[0]);
    return { url: form.url, title: "SheerID", text: "Add documents", truncated: false };
  };
  await b.ask(tab, "extract", [{ expand: true, scroll: true }]);
  expect(asked).toEqual([expect.objectContaining({ expand: false, scroll: false })]);
});

// On 10-29 a javadoc frameset's read cut each frame at the limit on its
// own, and ended "â€¦truncated": the marker's UTF-8 read as Windows-1252.
test("extract of a page and its frames past the limit answers their text up to what the daemon saves, cut once, and counts the whole", async () => {
  const { b, tab, form } = await sheerid();
  const own = "a".repeat(15_000);
  const framed = "b".repeat(12_000);
  tab.doc.does = (op) => (op === "extract" ? { url: tab.doc.url, title: "Adorama", text: own, truncated: false, frames: [{ token: "sheerid", name: "frame" }] } : { url: tab.doc.url });
  form.does = () => ({ url: form.url, title: "SheerID", text: framed, truncated: false });
  const whole = `${own}\n\nframe:\n${framed}`;
  expect(await b.ask(tab, "extract", [{ whole: 2_000_000 }])).toEqual({ value: { url: tab.doc.url, title: "Adorama", text: whole, truncated: true, total: whole.length } });
  expect(await b.ask(tab, "extract", [{}])).toEqual({ value: { url: tab.doc.url, title: "Adorama", text: whole.slice(0, 20_000), truncated: true, total: whole.length } });
});

type ShotResult = {
  data: string;
  screens?: number;
  cut?: boolean;
  source: { url: string; title: string; capturedAt: string; width: number; height: number; viewport: { width: number; height: number; devicePixelRatio: number }; crop?: { x: number; y: number; width: number; height: number }; privacy: { masked: number } };
  tiles?: { data: string; region: { x: number; y: number; width: number; height: number } }[];
};

function shotPage(tab: Tab, viewport = { width: 8, height: 6, devicePixelRatio: 1 }, height = 10) {
  let y = 0, savedY = 0;
  const page = { protected: false, annotated: false, finished: 0, refusePrepare: false, changeDuringCapture: false, stillsChange: false, still: false, get y() { return y; } };
  tab.doc.title = "Private page";
  const state = () => ({
    ok: true,
    source: { url: tab.doc.url, title: tab.doc.title, viewport },
    page: { x: 0, y, height },
    regions: [{ x: 2, y: 1, width: 2, height: 2 }],
    masked: 1,
  });
  tab.doc.does = (op, msg) => {
    if (op === "capturePrivacy") {
      const phase = msg.args?.[1];
      if (phase === "start") savedY = y;
      if (phase === "prepare") {
        page.protected = true;
        if (page.refusePrepare) return { error: "screenshot privacy: protected inspection unavailable" };
      }
      if (phase === "check" && page.changeDuringCapture) return { error: "screenshot privacy: the page changed during capture" };
      if (phase === "clear" || phase === "restore") page.protected = false;
      if (phase === "restore") y = savedY;
      return state();
    }
    if (op === "eval") {
      const top = /top:(\d+)/.exec(String(msg.args?.[0]));
      if (top) y = Math.min(Number(top[1]), Math.max(0, height - viewport.height));
      return { ok: true, result: y };
    }
    if (op === "locate") return { x: 1, y: 1, width: 4, height: 3, innerWidth: viewport.width, innerHeight: viewport.height };
    if (op === "settle") { page.finished += 2; return { finished: 2 }; }
    if (op === "annotate") page.annotated = msg.args?.[0] === true;
    // the page stops changing once its video and animations are paused
    if (op === "stillPage") {
      page.still = msg.args?.[0] === true;
      if (page.still && page.stillsChange) page.changeDuringCapture = false;
    }
    return { ok: true };
  };
  return page;
}

test.each([
  ["viewport", {}],
  ["live", { live: true }],
  ["crop", { ref: "#secret" }],
  ["annotated", { annotate: true }],
  ["full page", { fullPage: true }],
  ["live full page", { fullPage: true, live: true }],
] as const)("%s screenshots remove protected pixels before returning image bytes", async (_name, options) => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  const page = shotPage(tab);
  b.focus(tab);
  b.captureWith(() => `data:image/png;base64,${rasterData(rasterImage(8, 6, (x, y) => x >= 2 && x < 4 && y >= 1 && y < 3 ? 249 : 9))}`);
  const answer = await b.request("shot", [tab.id, { ...options, secrets: ["sentinel"] }]);
  expect(answer.error).toBeUndefined();
  const result = answer.value as ShotResult;
  const image = readRaster(result.data);
  expect(Array.from(image.pixels)).not.toContain(249);
  expect(Array.from(image.pixels)).toContain(9);
  expect(result.source).toMatchObject({ url: tab.doc.url, title: "Private page", width: image.width, height: image.height, privacy: { masked: "fullPage" in options ? 2 : 1 } });
  expect(page.protected).toBe(false);
  expect(page.y).toBe(0);
});

test("a failed privacy inspection returns no picture and restores the selected tab", async () => {
  const b = await start();
  const front = b.open("https://example.com/owner");
  const tab = b.open("https://example.com/private");
  const page = shotPage(tab);
  page.refusePrepare = true;
  b.focus(front);
  const answer = await b.request("shot", [tab.id, {}]);
  expect(answer).toEqual({ error: "screenshot privacy: protected inspection unavailable" });
  expect(b.trips).not.toContain("capture");
  expect(page.protected).toBe(false);
  expect(b.active()).toBe(front.id);
});

test("a raw capture exception restores protection and selection without disguising the capture error", async () => {
  const b = await start();
  const front = b.open("https://example.com/owner");
  const tab = b.open("https://example.com/private");
  const page = shotPage(tab);
  b.focus(front);
  b.captureWith(() => { throw new Error("capture refused"); });
  expect(await b.request("shot", [tab.id, { fullPage: true, annotate: true }])).toEqual({ error: "capture refused" });
  expect(page.protected).toBe(false);
  expect(page.y).toBe(0);
  expect(b.active()).toBe(front.id);
  b.captureWith(() => `data:image/png;base64,${rasterData(rasterImage(8, 6, () => 9))}`);
  expect((await b.request("shot", [tab.id, {}])).error).toBeUndefined();
  expect(page.protected).toBe(false);
  expect(b.active()).toBe(front.id);
});

test("a page that keeps changing while Safari captures, its video and animations paused, returns no image bytes", async () => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  const page = shotPage(tab);
  b.focus(tab);
  page.changeDuringCapture = true;
  const answer = await b.request("shot", [tab.id, { live: true }]);
  expect(answer.value).toBeUndefined();
  expect(answer.error).toStartWith("screenshot privacy: the page kept changing during capture, even with its video and animations paused");
  expect(page.protected).toBe(false);
  expect(page.still).toBe(false);
});

// SR-6: a shot of a page playing a video failed its check each time.
test("a page that changes while Safari captures is captured again with its video and animations paused, which play again after", async () => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  const page = shotPage(tab);
  b.focus(tab);
  page.changeDuringCapture = true;
  page.stillsChange = true;
  const answer = await b.request("shot", [tab.id, { live: true }]);
  expect(answer.error).toBeUndefined();
  expect(answer.value).toMatchObject({ source: { privacy: { masked: 1 } } });
  expect(page.protected).toBe(false);
  expect(page.still).toBe(false);
});

test("a screenshot refuses another tab's pixels when selection switches away and back during capture", async () => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  const other = b.open("https://example.com/other");
  const page = shotPage(tab);
  b.focus(tab);
  const listeners = b.tabListenerCounts();
  b.captureWith(() => {
    expect(b.active()).toBe(tab.id);
    expect(page.protected).toBe(true);
    expect(page.annotated).toBe(true);
    b.focus(other);
    const pixels = `data:image/png;base64,${rasterData(rasterImage(8, 6, () => 249))}`;
    b.focus(tab);
    return pixels;
  });
  const answer = await b.request("shot", [tab.id, { live: true, annotate: true }]);
  expect(answer.value).toBeUndefined();
  expect(answer.error).toBe("screenshot privacy: the protected tab changed during capture");
  expect(b.active()).toBe(tab.id);
  expect(page.protected).toBe(false);
  expect(page.annotated).toBe(false);
  expect(b.tabListenerCounts()).toEqual(listeners);
});

test("a screenshot still returns protected pixels when another window switches tabs during capture", async () => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  const other = b.open("https://example.com/other", true, 2);
  const next = b.open("https://example.com/next", true, 2);
  const page = shotPage(tab);
  b.focus(other);
  b.focus(tab);
  const listeners = b.tabListenerCounts();
  b.captureWith(() => {
    b.focus(next);
    return `data:image/png;base64,${rasterData(rasterImage(8, 6, () => 9))}`;
  });
  const answer = await b.request("shot", [tab.id, { live: true }]);
  expect(answer.error).toBeUndefined();
  const result = answer.value as ShotResult;
  expect(result.source).toMatchObject({ url: tab.doc.url, privacy: { masked: 1 } });
  expect(Array.from(readRaster(result.data).pixels)).toEqual(Array.from(rasterImage(8, 6, (x, y) => x >= 2 && x < 4 && y >= 1 && y < 3 ? 0 : 9).pixels));
  expect(b.active()).toBe(tab.id);
  expect(b.active(2)).toBe(next.id);
  expect(page.protected).toBe(false);
  expect(b.tabListenerCounts()).toEqual(listeners);
});

test("overlapping tiles preserve the original image and identify every retained raster row", async () => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  shotPage(tab, { width: 4, height: 300, devicePixelRatio: 2 }, 300);
  b.focus(tab);
  b.captureWith(() => `data:image/png;base64,${rasterData(rasterImage(8, 600, (_x, y) => y % 180 + 1))}`);
  const answer = await b.request("shot", [tab.id, { live: true, tiles: true, tileHeight: 256 }]);
  expect(answer.error).toBeUndefined();
  const result = answer.value as ShotResult;
  const original = readRaster(result.data);
  expect(result.source).toMatchObject({ width: 8, height: 600, viewport: { width: 4, height: 300, devicePixelRatio: 2 } });
  expect(result.tiles?.map((tile) => tile.region)).toEqual([
    { x: 0, y: 0, width: 8, height: 256 },
    { x: 0, y: 192, width: 8, height: 256 },
    { x: 0, y: 384, width: 8, height: 216 },
  ]);
  expect(result.tiles?.map((tile) => {
    const image = readRaster(tile.data);
    return { width: image.width, height: image.height, pixels: Array.from(image.pixels) };
  })).toEqual(result.tiles?.map(({ region }) => ({
    width: region.width, height: region.height,
    pixels: Array.from(original.pixels).slice(region.y * original.width, (region.y + region.height) * original.width),
  })));
});

test("full-page captures retain overlapping viewport coverage without claiming extra rows", async () => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  const page = shotPage(tab);
  b.focus(tab);
  b.captureWith(() => `data:image/png;base64,${rasterData(rasterImage(8, 6, (_x, y) => page.y + y + 10))}`);
  const answer = await b.request("shot", [tab.id, { fullPage: true }]);
  expect(answer.error).toBeUndefined();
  const result = answer.value as ShotResult;
  const image = readRaster(result.data);
  expect({ screens: result.screens, cut: result.cut, width: result.source.width, height: result.source.height }).toEqual({ screens: 2, cut: false, width: 8, height: 10 });
  expect(Array.from({ length: image.height }, (_, y) => image.pixels[y * image.width])).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  expect(page.y).toBe(0);
});

test("a crop reports retained CSS coordinates and raster dimensions at the captured pixel scale", async () => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  shotPage(tab, { width: 8, height: 6, devicePixelRatio: 2 }, 6);
  const does = tab.doc.does;
  tab.doc.does = (op, msg) => op === "locate" ? { x: -1, y: 2, width: 5, height: 8, innerWidth: 8, innerHeight: 6 } : does(op, msg);
  b.focus(tab);
  b.captureWith(() => `data:image/png;base64,${rasterData(rasterImage(16, 12, () => 9))}`);
  const answer = await b.request("shot", [tab.id, { ref: "#part", tiles: true }]);
  expect(answer.error).toBeUndefined();
  const result = answer.value as ShotResult;
  expect(result.source).toMatchObject({ width: 8, height: 8, crop: { x: 0, y: 2, width: 4, height: 4 }, viewport: { width: 8, height: 6, devicePixelRatio: 2 } });
  expect(result.tiles?.map((tile) => tile.region)).toEqual([{ x: 0, y: 0, width: 8, height: 8 }]);
  expect(readRaster(result.data)).toMatchObject({ width: 8, height: 8 });
});

test("a bounded full-page screenshot marks missing rows rather than claiming the entire page", async () => {
  const b = await start();
  const tab = b.open("https://example.com/private");
  shotPage(tab, { width: 8, height: 6, devicePixelRatio: 1 }, 100);
  b.focus(tab);
  const answer = await b.request("shot", [tab.id, { fullPage: true, live: true }]);
  expect(answer.error).toBeUndefined();
  const result = answer.value as ShotResult;
  expect({ screens: result.screens, cut: result.cut, height: result.source.height }).toEqual({ screens: 12, cut: true, height: 72 });
  expect(readRaster(result.data).height).toBe(72);
});

test("a failed frame crop restores the child frame's scroll position as well as the selected tab", async () => {
  const b = await start();
  const front = b.open("https://example.com/owner");
  const tab = b.open("https://example.com/private");
  shotPage(tab);
  const frame = b.frame(tab, 5, "https://frame.example/private");
  frame.world.__safariHarnessFrame = "capture-frame";
  const page = shotPage({ id: tab.id, doc: frame });
  const does = frame.does;
  frame.does = (op, msg) => {
    if (op === "locate") {
      does("eval", { id: "scroll", op: "eval", args: ["scrollTo({top:4})"] });
      return { x: 1, y: 1, width: 4, height: 3, innerWidth: 8, innerHeight: 6 };
    }
    return does(op, msg);
  };
  b.focus(front);
  b.captureWith(() => { throw new Error("capture refused"); });
  expect(await b.request("shot", [tab.id, { ref: "f5:1" }])).toEqual({ error: "capture refused" });
  expect(page.y).toBe(0);
  expect(b.active()).toBe(front.id);
});

test("a screenshot without confirmed protected paint returns no image and restores page selection", async () => {
  const b = await start();
  const front = b.open("https://example.com/owner");
  const tab = b.open("https://example.com/private");
  const page = shotPage(tab);
  const does = tab.doc.does;
  tab.doc.does = (op, msg) => op === "painted" ? { ok: false } : does(op, msg);
  b.focus(front);
  const answer = await b.request("shot", [tab.id, { live: true }]);
  expect(answer).toEqual({ error: "screenshot privacy: the protected page did not paint" });
  expect(b.trips).not.toContain("capture");
  expect(page.protected).toBe(false);
  expect(b.active()).toBe(front.id);
});

test("a protected page that never paints fails closed at the paint deadline and removes its overlay", async () => {
  const b = await start();
  const front = b.open("https://example.com/owner");
  const tab = b.open("https://example.com/private");
  const page = shotPage(tab);
  const does = tab.doc.does;
  tab.doc.does = (op, msg) => op === "painted" ? never() : does(op, msg);
  b.focus(front);
  const pending = b.request("shot", [tab.id, { live: true }]);
  await b.clock.advance(7000);
  expect(await pending).toEqual({ error: "screenshot privacy: the protected page did not paint" });
  expect(b.trips).not.toContain("capture");
  expect(page.protected).toBe(false);
  expect(b.active()).toBe(front.id);
});

const memoryConfig = { enabled: true, sites: ["example.com"], excludedSites: [] };

test("memory waits for an opted-in foreground page and does not let hidden-tab updates cancel it", async () => {
  const b = await start();
  const page = b.open("https://example.com/article");
  const hidden = b.open("https://example.com/background");
  b.focus(page);
  await b.clock.advance(2000);
  expect(b.told.filter((event) => event.op === "memory")).toEqual([]);
  await b.request("memory.configure", [memoryConfig, 1]);
  await b.clock.advance(1000);
  b.update(hidden, { status: "complete" });
  await b.clock.advance(500);
  expect(b.told.filter((event) => event.op === "memory")).toEqual([{ op: "memory", tab: page.id, url: page.doc.url, revision: 1 }]);
  page.doc.does = (op) => op === "memoryPage" ? { url: page.doc.url, title: "Article", body: "The aurora research was published on Tuesday.", visible: true } : { url: page.doc.url };
  expect(await b.request("memory.capture", [page.id, page.doc.url, 1])).toEqual({ value: { url: page.doc.url, title: "Article", body: "The aurora research was published on Tuesday.", visible: true }, error: undefined });
});

test("memory never reads private, excluded, inactive, agent-owned, or agent-driven pages", async () => {
  const b = await start();
  const selected = b.open("https://example.com/article");
  const hidden = b.open("https://example.com/background");
  const privateTab = b.open("https://example.com/private");
  privateTab.incognito = true;
  const owned = b.open("https://example.com/agent");
  await b.own(owned);
  const driven = b.open("https://example.com/driven");
  await b.ask(driven, "tabInfo");
  await b.request("memory.configure", [memoryConfig, 1]);
  for (const tab of [privateTab, owned, driven]) {
    b.focus(tab);
    expect(await b.request("memory.capture", [tab.id, tab.doc.url, 1])).toEqual({ value: { skipped: true }, error: undefined });
    expect(tab.doc.ran).not.toContain("memoryPage");
  }
  b.focus(selected);
  expect(await b.request("memory.capture", [hidden.id, hidden.doc.url, 1])).toEqual({ value: { skipped: true }, error: undefined });
  await b.request("memory.configure", [{ ...memoryConfig, excludedSites: ["example.com"] }, 2]);
  expect(await b.request("memory.capture", [selected.id, selected.doc.url, 2])).toEqual({ value: { skipped: true }, error: undefined });
  expect(selected.doc.ran).not.toContain("memoryPage");
  expect(hidden.doc.ran).not.toContain("memoryPage");
});

test("memory refuses background Safari and changed URLs without reading the page", async () => {
  const b = await start();
  const tab = b.open("https://example.com/article");
  b.focus(tab);
  await b.request("memory.configure", [memoryConfig, 1]);
  b.unfocus();
  expect(await b.request("memory.capture", [tab.id, tab.doc.url, 1])).toEqual({ value: { skipped: true }, error: undefined });
  b.focus(tab);
  expect(await b.request("memory.capture", [tab.id, "https://example.com/before", 1])).toEqual({ value: { skipped: true }, error: undefined });
  expect(tab.doc.ran).not.toContain("memoryPage");
});

test("a pause while the page is being read discards its content and cancels collection", async () => {
  const b = await start();
  const tab = b.open("https://example.com/article");
  b.focus(tab);
  await b.request("memory.configure", [memoryConfig, 1]);
  const held = Promise.withResolvers<{ url: string; title: string; body: string; visible: boolean }>();
  tab.doc.does = (op) => op === "memoryPage" ? held.promise : { url: tab.doc.url };
  const reading = b.request("memory.capture", [tab.id, tab.doc.url, 1]);
  await settle();
  await b.request("memory.configure", [{ ...memoryConfig, enabled: false }, 2]);
  held.resolve({ url: tab.doc.url, title: "Article", body: "Discard this captured text.", visible: true });
  expect(await reading).toEqual({ value: { skipped: true }, error: undefined });
  await b.clock.advance(2000);
  expect(b.told.filter((event) => event.op === "memory")).toEqual([]);
});

test("forget resynchronization does not immediately recapture the page and disconnection clears consent", async () => {
  const b = await start();
  const tab = b.open("https://example.com/article");
  b.focus(tab);
  await b.request("memory.configure", [memoryConfig, 1]);
  await b.request("memory.configure", [memoryConfig, 2, false]);
  await b.clock.advance(2000);
  expect(b.told.filter((event) => event.op === "memory")).toEqual([]);
  b.disconnect();
  b.reconnect();
  b.focus(tab);
  b.update(tab, { status: "complete" });
  await b.clock.advance(2000);
  expect(await b.request("memory.capture", [tab.id, tab.doc.url, 2])).toEqual({ value: { skipped: true }, error: undefined });
  expect(tab.doc.ran).not.toContain("memoryPage");
});

test("memory does not collect a document that Safari reports as hidden", async () => {
  const b = await start();
  const tab = b.open("https://example.com/article");
  b.focus(tab);
  await b.request("memory.configure", [memoryConfig, 1]);
  tab.doc.does = (op) => op === "memoryPage" ? { url: tab.doc.url, title: "Article", body: "Hidden page content.", visible: false } : { url: tab.doc.url };
  expect(await b.request("memory.capture", [tab.id, tab.doc.url, 1])).toEqual({ value: { skipped: true }, error: undefined });
});

test("forget during the foreground eligibility check cannot send a stale memory notification", async () => {
  const b = await start();
  const tab = b.open("https://example.com/article");
  b.focus(tab);
  await b.request("memory.configure", [memoryConfig, 1]);
  const held = b.holdFocusRead();
  await b.clock.advance(1500);
  await held.entered;
  await b.request("memory.configure", [memoryConfig, 2, false]);
  held.release();
  await settle();
  expect(b.told.filter((event) => event.op === "memory")).toEqual([]);
  b.update(tab, { status: "complete" });
  await b.clock.advance(1500);
  expect(b.told.filter((event) => event.op === "memory")).toEqual([{ op: "memory", tab: tab.id, url: tab.doc.url, revision: 2 }]);
});

test("native preparation binds both points to the current document and refuses a moved target before delivery", async () => {
  const b = await start();
  const tab = b.open("https://example.com/editor");
  let destination = 80;
  tab.doc.does = (op) => op === "nativeProbe" ? {
    document: tab.doc.world.__safariHarnessFrame, innerWidth: 800, innerHeight: 600,
    from: { x: 20, y: 30 }, to: { x: destination, y: 90 },
  } : { url: tab.doc.url };
  const initial = await b.request("upgrade.native", [tab.id, { do: "drag", ref: "#source", target: "#destination" }]);
  expect(initial.error).toBeUndefined();
  expect(initial.value).toMatchObject({ from: { x: 20, y: 30 }, to: { x: 80, y: 90 }, inputFrame: 0 });
  destination = 100;
  const moved = await b.request("upgrade.native", [tab.id, { do: "drag", ref: "#source", target: "#destination", expected: initial.value }]);
  expect(moved.value).toBeUndefined();
  expect(moved.error).toContain("changed before input");
  expect(tab.doc.ran).toEqual(["nativeProbe", "nativeProbe"]);
});

test("native embedded-frame preparation does not scroll its containing page and rejects a covering parent", async () => {
  const b = await start();
  const tab = b.open("https://example.com/editor");
  const child = b.frame(tab, 5, "https://frame.example/editor");
  let covered = false;
  let scroll = 0;
  child.does = (op) => op === "nativeProbe" ? {
    document: child.world.__safariHarnessFrame, innerWidth: 200, innerHeight: 100,
    from: { x: 20, y: 30 }, to: { x: 80, y: 70 },
  } : { url: child.url };
  tab.doc.does = (op, message) => {
    if (op !== "assertFrameClickable") return { url: tab.doc.url };
    const [token, point, options] = message.args as [string, { x: number; y: number }, { scroll?: boolean }];
    if (token !== child.world.__safariHarnessFrame) return { found: false };
    if (options.scroll !== false) scroll += 100;
    return covered ? { found: true, blocker: "the frame is covered by another element" }
      : { found: true, frame: tab.doc.world.__safariHarnessFrame, x: point.x + 100, y: point.y + 150 };
  };
  const initial = await b.request("upgrade.native", [tab.id, { do: "drag", ref: "f5:#source", target: "f5:#destination" }]);
  expect(initial.error).toBeUndefined();
  expect(initial.value).toMatchObject({ from: { x: 120, y: 180 }, to: { x: 180, y: 220 }, inputFrame: 5 });
  expect(scroll).toBe(0);
  covered = true;
  const blocked = await b.request("upgrade.native", [tab.id, { do: "drag", ref: "f5:#source", target: "f5:#destination", expected: initial.value }]);
  expect(blocked.value).toBeUndefined();
  expect(blocked.error).toContain("covered");
  expect(scroll).toBe(0);
});

test("research reads do not enable personal capture and strip candidates when independent permission is off", async () => {
  const b = await start();
  const tab = b.open("https://example.com/research");
  const memorySource = { url: tab.doc.url, title: "Research", body: "A public research article contains useful scientific findings.", partial: false };
  tab.doc.does = () => ({ url: tab.doc.url, title: "Research", text: memorySource.body, memorySource });
  await b.request("memory.configure", [{ enabled: false, researchEnabled: false, sites: [], excludedSites: [] }, 1]);
  expect((await b.ask(tab, "extract", [{ memoryResearch: true }])).value).not.toHaveProperty("memorySource");
  await b.request("memory.configure", [{ enabled: false, researchEnabled: true, sites: [], excludedSites: [] }, 2]);
  expect((await b.ask(tab, "extract", [{}])).value).toHaveProperty("memorySource", memorySource);
  await b.clock.advance(2000);
  expect(b.told.filter((event) => event.op === "memory")).toEqual([]);
});

test.each(["private", "excluded", "account", "signed"] as const)("research rejects a %s source before it can reach daemon receipts", async (kind) => {
  const b = await start();
  const tab = b.open(kind === "account" ? "https://example.com/account" : kind === "signed" ? "https://example.com/research?X-Amz-Signature=fixture-grant" : "https://example.com/research");
  tab.incognito = kind === "private";
  const memorySource = { url: tab.doc.url, title: "Research", body: "A source that must not become a saved public research observation.", partial: false };
  tab.doc.does = () => ({ url: tab.doc.url, text: memorySource.body, memorySource });
  await b.request("memory.configure", [{ enabled: false, researchEnabled: true, sites: [], excludedSites: kind === "excluded" ? ["example.com"] : [] }, 1]);
  expect((await b.ask(tab, "extract", [{}])).value).not.toHaveProperty("memorySource");
});

test("forgetting while a research read is pending prevents the old source from reaching receipts", async () => {
  const b = await start();
  const tab = b.open("https://example.com/research");
  const held = Promise.withResolvers<unknown>();
  tab.doc.does = () => held.promise;
  await b.request("memory.configure", [{ enabled: false, researchEnabled: true, sites: [], excludedSites: [] }, 1]);
  const reading = b.ask(tab, "extract", [{}]);
  await settle();
  await b.request("memory.configure", [{ enabled: false, researchEnabled: true, sites: [], excludedSites: [] }, 2, false]);
  held.resolve({ url: tab.doc.url, text: "A previously read public source must not survive forgetting.", memorySource: {
    url: tab.doc.url, title: "Research", body: "A previously read public source must not survive forgetting.", partial: false,
  } });
  expect((await reading).value).not.toHaveProperty("memorySource");
});
