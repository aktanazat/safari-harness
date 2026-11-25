// The Safari extension, run against Ladybird. Ladybird has no extension
// API, so this process gives the extension's own background.js the
// browser.* calls it makes (tabs, windows, scripting, cookies, storage,
// alarms, runtime), each done over WebDriver BiDi (bidi.ts), and puts
// start.js, dialogs.js and the messaging content.js needs in every frame
// as a BiDi preload script. background.js, content.js and the daemon run
// unchanged: background.js connects to the daemon as the extension does.
//
// Ladybird has no isolated worlds yet ("Sandbox realms are not
// supported"), so the extension's scripts run in the page's own world.
//
//   bun ladybird/bridge.ts [--browser attach|launch|headless] [--profile-path DIR | --profile NAME]
//                          [--driver-port 4470] [--daemon-port 37333]

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Ladybird, type BidiEvent } from "./bidi.ts";
import { createImageBitmap, FileReader, OffscreenCanvas } from "./raster.ts";

const EXT = new URL("../extension/", import.meta.url).pathname;
const MANIFEST = await Bun.file(join(EXT, "manifest.json")).json();
const EXTENSION_ID = "ladybird-harness";
const ORIGIN = `safari-web-extension://${EXTENSION_ID}`;
// The window property each frame's shim lives under: fresh each run, so a
// page cannot have it ready.
const KEY = `__lbh_${crypto.randomUUID().slice(0, 8)}`;

type Listener = (...args: never[]) => unknown;
class Ev {
  readonly fns = new Set<Listener>();
  addListener = (fn: Listener) => void this.fns.add(fn);
  removeListener = (fn: Listener) => void this.fns.delete(fn);
  hasListener = (fn: Listener) => this.fns.has(fn);
  emit(...args: unknown[]) {
    for (const fn of [...this.fns]) {
      try {
        (fn as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        console.error("[ladybird] listener threw", e);
      }
    }
  }
}

type Tab = { id: number; context: string; windowId: number; url: string; title: string; status: "loading" | "complete"; openerTabId?: number };
type Frame = { context: string; tabId: number; frameId: number; url: string };
type Win = { id: number; bounds?: [number, number, number, number] };
type Info = { context: string; parent?: string | null; url?: string; originalOpener?: string | null; children?: Info[] | null };
type Remote = { type: string; value?: unknown };
type CallResult = { type: "success"; result: Remote } | { type: "exception"; exceptionDetails: { text: string } };

const fail = (what: string) => Promise.reject(new Error(what));

// Every frame's shim: browser.runtime for start.js and content.js, the
// reports of the top frame's title, visibility, focus and bounds, then
// dialogs.js (page world, document_start) and start.js (document_end).
function preloadSource(dialogs: string, start: string): string {
  return `(send) => {
  const KEY = ${JSON.stringify(KEY)};
  if (Object.hasOwn(window, KEY)) return;
  const post = (m) => send(JSON.stringify(m));
  const event = (set) => ({ addListener: (f) => void set.add(f), removeListener: (f) => void set.delete(f), hasListener: (f) => set.has(f) });
  const listeners = new Set();
  const pending = new Map();
  let seq = 0;
  const port = (name) => ({ name, onMessage: event(new Set()), onDisconnect: event(new Set()), postMessage() {}, disconnect() {} });
  const runtime = {
    id: ${JSON.stringify(EXTENSION_ID)},
    getURL: (p) => "ladybird-harness://extension/" + String(p).replace(/^\\//, ""),
    sendMessage(msg) {
      const id = ++seq;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); post({ k: "msg", id, msg }); });
    },
    onMessage: event(listeners),
    connect: (info) => port(info && info.name || ""),
  };
  const api = Object.freeze({ runtime: Object.freeze(runtime) });
  Object.defineProperty(window, KEY, { value: Object.freeze({
    api,
    reply(id, ok, json) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(JSON.parse(json) ?? undefined); else p.reject(new Error(json));
    },
    deliver(json) {
      const msg = JSON.parse(json);
      for (const f of listeners) {
        const out = f(msg, { id: runtime.id });
        if (out !== undefined) return Promise.resolve(out).then((v) => JSON.stringify(v === undefined ? null : v));
      }
      return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
    },
  }) });
  if (window === window.top) {
    let last = "";
    const report = () => {
      const state = { k: "page", title: document.title, visible: document.visibilityState === "visible", focused: document.hasFocus(), bounds: [screenX, screenY, outerWidth, outerHeight] };
      const now = JSON.stringify(state);
      if (now !== last) { last = now; post(state); }
    };
    addEventListener("DOMContentLoaded", () => {
      report();
      new MutationObserver(report).observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
    }, { once: true });
    for (const type of ["load", "focus", "blur", "resize"]) addEventListener(type, report);
    document.addEventListener("visibilitychange", report);
  }
  try {
${dialogs}
  } catch (e) { console.error("[ladybird-harness] dialogs.js", e); }
  const start = () => { (function (browser, chrome) {
${start}
  }).call(window, api, undefined); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
}`;
}

// The function a scripting.executeScript runs in a frame: the extension's
// own func (or a file's source as a function body), handed browser.* in
// the extension's world, its result back as JSON.
function injected(src: string, world: string): string {
  const bind = world === "MAIN" ? "undefined" : "shim.api";
  return `(json) => {
  const shim = window[${JSON.stringify(KEY)}];
  if (${world === "MAIN" ? "false" : "!shim"}) throw new Error("${KEY}:no-shim");
  const f = (function (browser, chrome) { return (${src}); }).call(window, ${bind}, undefined);
  return Promise.resolve().then(() => f(...JSON.parse(json))).then((r) => JSON.stringify(r === undefined ? null : r));
}`;
}

class Browser {
  readonly tabs = new Map<number, Tab>();
  readonly frames = new Map<string, Frame>();
  readonly windows = new Map<number, Win>();
  readonly active = new Map<number, number>();
  lastFocused = -1;
  #tabOf = new Map<string, number>();
  // Where the next contexts this bridge makes go: Ladybird gives every tab
  // its own BiDi clientWindow, so windows are tracked here, by how each
  // tab came to be.
  #expect: (number | "new")[] = [];
  #nextTab = 1;
  #nextWin = 1;
  #nextFrame = new Map<number, number>();
  readonly events = {
    tabCreated: new Ev(), tabUpdated: new Ev(), tabRemoved: new Ev(), tabActivated: new Ev(),
    winCreated: new Ev(), winRemoved: new Ev(), winFocus: new Ev(),
    message: new Ev(),
  };

  constructor(readonly lb: Ladybird) {}

  async start() {
    this.lb.on((e) => this.#event(e));
    await this.lb.call("session.subscribe", {
      events: ["browsingContext.contextCreated", "browsingContext.contextDestroyed", "browsingContext.navigationStarted", "browsingContext.navigationCommitted", "browsingContext.load", "browsingContext.historyUpdated", "browsingContext.fragmentNavigated", "script.message"],
    });
    const tree = await this.lb.call<{ contexts: Info[] }>("browsingContext.getTree", {});
    for (const top of tree.contexts) this.#adopt(top, false);
  }

  #newWindow(): number {
    const id = this.#nextWin++;
    this.windows.set(id, { id });
    this.events.winCreated.emit(this.windowObject(id));
    return id;
  }

  // A tab a page opened goes in its opener's window; one this bridge made,
  // where it asked; any other, in the window last in front.
  #placeTab(opener: number | undefined): number {
    const asked = opener !== undefined ? this.tabs.get(opener)?.windowId : this.#expect.shift();
    if (typeof asked === "number" && this.windows.has(asked)) return asked;
    if (asked === "new" || this.windows.size === 0) return this.#newWindow();
    return this.windows.has(this.lastFocused) ? this.lastFocused : [...this.windows.keys()][0];
  }

  // A context Ladybird reports, from the tree or as it is made.
  #adopt(info: Info, announce: boolean): void {
    if (info.parent) {
      const tabId = this.frames.get(info.parent)?.tabId;
      if (tabId === undefined || this.frames.has(info.context)) return;
      const frameId = (this.#nextFrame.get(tabId) ?? 1);
      this.#nextFrame.set(tabId, frameId + 1);
      this.frames.set(info.context, { context: info.context, tabId, frameId, url: info.url ?? "about:blank" });
    } else if (!this.#tabOf.has(info.context)) {
      const id = this.#nextTab++;
      const opener = info.originalOpener ? this.#tabOf.get(info.originalOpener) : undefined;
      const windowId = this.#placeTab(opener);
      const tab: Tab = { id, context: info.context, windowId, url: info.url ?? "about:blank", title: "", status: "complete", ...(opener !== undefined ? { openerTabId: opener } : {}) };
      this.tabs.set(id, tab);
      this.#tabOf.set(info.context, id);
      this.frames.set(info.context, { context: info.context, tabId: id, frameId: 0, url: tab.url });
      if (!this.active.has(windowId)) this.active.set(windowId, id);
      if (announce) this.events.tabCreated.emit(this.tabObject(tab));
    }
    for (const child of info.children ?? []) this.#adopt({ ...child, parent: info.context }, announce);
  }

  #event({ method, params }: BidiEvent) {
    const context = params.context as string | undefined;
    switch (method) {
      case "browsingContext.contextCreated":
        return this.#adopt(params as unknown as Info, true);
      case "browsingContext.contextDestroyed":
        return this.#destroyed(params as unknown as Info);
      case "script.message":
        return this.#message(params);
    }
    const frame = context ? this.frames.get(context) : undefined;
    if (!frame) return;
    const url = params.url as string | undefined;
    if (frame.frameId !== 0) {
      if (url && method !== "browsingContext.load") frame.url = url;
      return;
    }
    const tab = this.tabs.get(frame.tabId)!;
    if (method === "browsingContext.navigationStarted") {
      tab.status = "loading";
      if (url) tab.url = frame.url = url;
      this.events.tabUpdated.emit(tab.id, { status: "loading", ...(url ? { url } : {}) }, this.tabObject(tab));
    } else if (method === "browsingContext.load") {
      tab.status = "complete";
      this.events.tabUpdated.emit(tab.id, { status: "complete" }, this.tabObject(tab));
    } else if (url && url !== tab.url) {
      tab.url = frame.url = url;
      this.events.tabUpdated.emit(tab.id, { url }, this.tabObject(tab));
    }
  }

  #destroyed(info: Info) {
    const frame = this.frames.get(info.context);
    if (!frame) return;
    for (const [ctx, f] of this.frames) if (f.tabId === frame.tabId && (frame.frameId === 0 || ctx === info.context)) this.frames.delete(ctx);
    if (frame.frameId !== 0) return;
    const tab = this.tabs.get(frame.tabId)!;
    this.tabs.delete(tab.id);
    this.#tabOf.delete(tab.context);
    const left = [...this.tabs.values()].filter((t) => t.windowId === tab.windowId);
    if (this.active.get(tab.windowId) === tab.id) {
      if (left.length) this.active.set(tab.windowId, left[left.length - 1].id);
      else this.active.delete(tab.windowId);
    }
    this.events.tabRemoved.emit(tab.id, { windowId: tab.windowId, isWindowClosing: left.length === 0 });
    if (left.length === 0) {
      const win = this.windows.get(tab.windowId)!;
      this.windows.delete(win.id);
      this.events.winRemoved.emit(win.id);
    }
  }

  #message(params: Record<string, unknown>) {
    const source = params.source as { context?: string } | undefined;
    const frame = source?.context ? this.frames.get(source.context) : undefined;
    const data = params.data as Remote | undefined;
    if (!frame || data?.type !== "string") return;
    const m = JSON.parse(String(data.value)) as { k: string; id?: number; msg?: unknown; title?: string; visible?: boolean; focused?: boolean; bounds?: [number, number, number, number] };
    const tab = this.tabs.get(frame.tabId);
    if (!tab) return;
    if (m.k === "msg") return this.events.message.emit(frame, m.id, m.msg);
    if (m.k !== "page" || frame.frameId !== 0) return;
    const win = this.windows.get(tab.windowId);
    if (win && m.bounds) win.bounds = m.bounds;
    if (m.title !== undefined && m.title !== tab.title) {
      tab.title = m.title;
      this.events.tabUpdated.emit(tab.id, { title: m.title }, this.tabObject(tab));
    }
    if (m.visible) this.markActive(tab);
    if (m.focused && this.lastFocused !== tab.windowId) {
      this.lastFocused = tab.windowId;
      this.events.winFocus.emit(tab.windowId);
    }
  }

  markActive(tab: Tab) {
    if (this.active.get(tab.windowId) === tab.id) return;
    this.active.set(tab.windowId, tab.id);
    this.events.tabActivated.emit({ tabId: tab.id, windowId: tab.windowId });
  }

  tab(id: number): Tab {
    const t = this.tabs.get(id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    return t;
  }

  win(id: number): Win {
    const w = this.windows.get(id);
    if (!w) throw new Error(`No window with id: ${id}.`);
    return w;
  }

  // A new tab, in a new window or beside the active tab of one.
  async create(where: number | "new", background: boolean): Promise<Tab> {
    const ref = typeof where === "number" ? this.active.get(where) : undefined;
    this.#expect.push(where);
    const { context } = await this.lb.call<{ context: string }>("browsingContext.create", {
      type: where === "new" ? "window" : "tab", background, ...(ref !== undefined ? { referenceContext: this.tab(ref).context } : {}),
    });
    // Its contextCreated may come after the reply.
    if (!this.#tabOf.has(context)) {
      const tree = await this.lb.call<{ contexts: Info[] }>("browsingContext.getTree", { root: context });
      for (const top of tree.contexts) this.#adopt(top, true);
    }
    return this.tab(this.#tabOf.get(context)!);
  }

  tabObject(t: Tab) {
    const beside = [...this.tabs.values()].filter((o) => o.windowId === t.windowId);
    const active = this.active.get(t.windowId) === t.id;
    return {
      id: t.id, windowId: t.windowId, index: beside.indexOf(t), url: t.url, title: t.title, status: t.status,
      active, highlighted: active, selected: active, pinned: false, audible: false, discarded: false, incognito: false,
      ...(t.openerTabId !== undefined ? { openerTabId: t.openerTabId } : {}),
    };
  }

  windowObject(id: number, populate = false) {
    const w = this.win(id);
    const [left, top, width, height] = w.bounds ?? [0, 0, 0, 0];
    return {
      id, focused: this.lastFocused === id, left, top, width, height, state: "normal", type: "normal", incognito: false, alwaysOnTop: false,
      ...(populate ? { tabs: [...this.tabs.values()].filter((t) => t.windowId === id).map((t) => this.tabObject(t)) } : {}),
    };
  }

  // Contexts of a tab's frames for an executeScript target.
  targets(target: { tabId: number; frameIds?: number[]; allFrames?: boolean }): Frame[] {
    this.tab(target.tabId);
    const all = [...this.frames.values()].filter((f) => f.tabId === target.tabId);
    if (target.allFrames) return all;
    const ids = target.frameIds ?? [0];
    const out = all.filter((f) => ids.includes(f.frameId));
    if (out.length < ids.length) throw new Error(`No frame with id ${ids.find((i) => !out.some((f) => f.frameId === i))} in tab ${target.tabId}.`);
    return out;
  }

  // Runs one function in one frame's page world.
  async run(frame: Frame, decl: string, args: unknown[], preload: string): Promise<unknown> {
    const call = () => this.lb.call<CallResult>("script.callFunction", {
      functionDeclaration: decl, arguments: [{ type: "string", value: JSON.stringify(args) }], target: { context: frame.context }, awaitPromise: true,
    });
    let r = await call();
    // A frame from before the preload was added gets the shim now.
    if (r.type === "exception" && r.exceptionDetails.text.includes(`${KEY}:no-shim`)) {
      await this.lb.call("script.callFunction", { functionDeclaration: preload, arguments: [{ type: "channel", value: { channel: "harness" } }], target: { context: frame.context }, awaitPromise: false });
      r = await call();
    }
    if (r.type === "exception") throw new Error(r.exceptionDetails.text);
    return JSON.parse(String(r.result.value));
  }
}

// Classic WebDriver's cookie, as the cookies API gives one. Classic calls
// see the in-memory jar, HttpOnly and session cookies included, but only
// for the current page's site; Ladybird.db lags it by up to 30 s and
// never holds session cookies.
type ClassicCookie = { name: string; value: string; path: string; domain: string; secure: boolean; httpOnly: boolean; expiry?: number; sameSite?: string };
function cookieObject(c: ClassicCookie) {
  const sameSite = (c.sameSite ?? "").toLowerCase();
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
    hostOnly: !c.domain.startsWith("."), session: c.expiry === undefined, storeId: "0",
    sameSite: sameSite === "strict" ? "strict" : sameSite === "lax" ? "lax" : sameSite === "none" ? "no_restriction" : "unspecified",
    ...(c.expiry !== undefined ? { expirationDate: c.expiry } : {}),
  };
}

// browser.* for one run of the extension's background scripts; a
// runtime.reload drops it and makes another.
type Extension = { api: { runtime: { onStartup: Ev }; storage: { local: { set(items: Record<string, unknown>): Promise<void> } } }; dispose: () => void };
function makeApi(b: Browser, ctx: { storageFile: string; preload: string; reload: () => void }): Extension {
  const ev = {
    tabCreated: new Ev(), tabUpdated: new Ev(), tabRemoved: new Ev(), tabActivated: new Ev(),
    winCreated: new Ev(), winRemoved: new Ev(), winFocus: new Ev(),
    message: new Ev(), alarm: new Ev(), never: new Ev(),
  };
  const relays: [Ev, Ev][] = [
    [b.events.tabCreated, ev.tabCreated], [b.events.tabUpdated, ev.tabUpdated], [b.events.tabRemoved, ev.tabRemoved],
    [b.events.tabActivated, ev.tabActivated], [b.events.winCreated, ev.winCreated], [b.events.winRemoved, ev.winRemoved],
    [b.events.winFocus, ev.winFocus],
  ];
  const forwarders = relays.map(([from, to]) => {
    const fn = ((...a: unknown[]) => to.emit(...a)) as Listener;
    from.addListener(fn);
    return () => from.removeListener(fn);
  });
  const alarms = new Map<string, ReturnType<typeof setTimeout>>();

  // Content scripts' runtime.sendMessage, answered by background.js's
  // onMessage listeners, the first that answers.
  const onPageMessage = ((frame: Frame, id: number, msg: unknown) => {
    const tab = b.tabs.get(frame.tabId);
    if (!tab) return;
    const sender = { id: EXTENSION_ID, tab: b.tabObject(tab), frameId: frame.frameId, url: frame.url, origin: frame.url.startsWith("http") ? new URL(frame.url).origin : undefined };
    let answer: Promise<unknown> | undefined;
    for (const fn of [...ev.message.fns]) {
      let out: unknown;
      try {
        out = (fn as (...a: unknown[]) => unknown)(msg, sender, () => {});
      } catch (e) {
        console.error("[ladybird] onMessage listener threw", e);
        continue;
      }
      if (out !== undefined && out !== true && answer === undefined) answer = Promise.resolve(out);
    }
    void (answer ?? Promise.resolve(null)).then(
      (v) => [true, JSON.stringify(v === undefined ? null : v)] as const,
      (e) => [false, String(e?.message ?? e)] as const,
    ).then(([ok, json]) => b.lb.call("script.callFunction", {
      functionDeclaration: `(id, ok, json) => window[${JSON.stringify(KEY)}]?.reply(id, ok, json)`,
      arguments: [{ type: "number", value: id }, { type: "boolean", value: ok }, { type: "string", value: json }],
      target: { context: frame.context }, awaitPromise: false,
    })).catch(() => {});
  }) as Listener;
  b.events.message.addListener(onPageMessage);

  // storage.local, kept in a file; storage.session in memory.
  const area = (persist: boolean) => {
    let data: Record<string, unknown> = {};
    const loaded = persist ? Bun.file(ctx.storageFile).json().then((d) => { data = d as Record<string, unknown>; }, () => {}) : Promise.resolve();
    let saving = Promise.resolve();
    const save = () => { if (persist) saving = saving.then(() => Bun.write(ctx.storageFile, JSON.stringify(data)).then(() => {})); return saving; };
    return {
      async get(keys?: string | string[] | Record<string, unknown> | null) {
        await loaded;
        if (keys == null) return structuredClone(data);
        if (typeof keys === "string") keys = [keys];
        const out: Record<string, unknown> = Array.isArray(keys) ? {} : { ...keys };
        for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      },
      async set(items: Record<string, unknown>) { await loaded; Object.assign(data, structuredClone(items)); await save(); },
      async remove(keys: string | string[]) { await loaded; for (const k of typeof keys === "string" ? [keys] : keys) delete data[k]; await save(); },
      async clear() { await loaded; data = {}; await save(); },
    };
  };
  const local = area(true);

  const registered = new Map<string, { id: string; matches: string[]; js: string[]; world?: string; runAt?: string; allFrames?: boolean; preload: string }>();

  // Runs classic cookie calls on a site from a background window on its
  // robots.txt: a page of the site that runs no script.
  const onSite = async <T>(url: string, fn: (send: <V>(m: string, p: string, body?: object) => Promise<V>) => Promise<T>): Promise<T> => {
    const { context } = await b.create("new", true);
    try {
      await b.lb.call("browsingContext.navigate", { context, url: `${new URL(url).origin}/robots.txt`, wait: "interactive" }).catch(() => {});
      return await b.lb.classic(async (send) => {
        await send("POST", "/window", { handle: context });
        return fn(send);
      });
    } finally {
      await b.lb.call("browsingContext.close", { context }).catch(() => {});
    }
  };

  const api = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (p: string) => `ladybird-harness://extension/${p.replace(/^\//, "")}`,
      getManifest: () => structuredClone(MANIFEST),
      onMessage: ev.message, onConnect: ev.never, onInstalled: ev.never, onStartup: new Ev(),
      reload: () => ctx.reload(),
    },
    action: {
      setBadgeText: async () => {}, setTitle: async () => {}, onClicked: ev.never,
    },
    alarms: {
      create(name: string, info: { delayInMinutes?: number; periodInMinutes?: number; when?: number }) {
        clearTimeout(alarms.get(name));
        const first = info.when !== undefined ? Math.max(0, info.when - Date.now()) : (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000;
        const fire = () => {
          const scheduledTime = Date.now();
          if (info.periodInMinutes) alarms.set(name, setTimeout(fire, info.periodInMinutes * 60000));
          else alarms.delete(name);
          ev.alarm.emit({ name, scheduledTime, ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) });
        };
        alarms.set(name, setTimeout(fire, first));
      },
      async clear(name: string) { const had = alarms.has(name); clearTimeout(alarms.get(name)); alarms.delete(name); return had; },
      onAlarm: ev.alarm,
    },
    storage: { local, session: area(false) },
    tabs: {
      async get(id: number) { return b.tabObject(b.tab(id)); },
      async query(q: { active?: boolean; windowId?: number; currentWindow?: boolean; lastFocusedWindow?: boolean; url?: string } = {}) {
        const windowId = q.windowId ?? (q.currentWindow || q.lastFocusedWindow ? b.lastFocused : undefined);
        return [...b.tabs.values()].map((t) => b.tabObject(t)).filter((t) =>
          (windowId === undefined || t.windowId === windowId) && (q.active === undefined || t.active === q.active) && (q.url === undefined || t.url === q.url));
      },
      async create(props: { url?: string; active?: boolean; windowId?: number }) {
        const windowId = props.windowId ?? (b.windows.has(b.lastFocused) ? b.lastFocused : [...b.windows.keys()][0]);
        const tab = await b.create(windowId ?? "new", props.active === false);
        const context = tab.context;
        if (props.active !== false) b.markActive(tab);
        if (props.url) {
          tab.url = props.url;
          tab.status = "loading";
          void b.lb.call("browsingContext.navigate", { context, url: props.url, wait: "none" }).catch(() => {});
        }
        return b.tabObject(tab);
      },
      async update(id: number, props: { url?: string; active?: boolean }) {
        const tab = b.tab(id);
        if (props.url) await b.lb.call("browsingContext.navigate", { context: tab.context, url: props.url, wait: "none" });
        if (props.active) {
          await b.lb.classic((send) => send("POST", "/window", { handle: tab.context }));
          b.markActive(tab);
        }
        return b.tabObject(tab);
      },
      async remove(ids: number | number[]) {
        for (const id of typeof ids === "number" ? [ids] : ids) await b.lb.call("browsingContext.close", { context: b.tab(id).context });
      },
      async move() { throw new Error("Ladybird cannot move a tab to another window."); },
      async sendMessage(id: number, msg: unknown, opts: { frameId?: number } = {}) {
        const [frame] = b.targets({ tabId: id, frameIds: [opts.frameId ?? 0] });
        const deliver = `(json) => { const shim = window[${JSON.stringify(KEY)}]; if (!shim) throw new Error("Could not establish connection. Receiving end does not exist."); return shim.deliver(json); }`;
        const r = await b.lb.call<CallResult>("script.callFunction", { functionDeclaration: deliver, arguments: [{ type: "string", value: JSON.stringify(msg) }], target: { context: frame.context }, awaitPromise: true });
        if (r.type === "exception") throw new Error(r.exceptionDetails.text);
        return JSON.parse(String(r.result.value)) ?? undefined;
      },
      async captureVisibleTab(windowId?: number, opts: { format?: string } = {}) {
        const win = windowId ?? b.lastFocused;
        const tabId = b.active.get(win);
        if (tabId === undefined) throw new Error(`No window with id: ${win}.`);
        const { data } = await b.lb.call<{ data: string }>("browsingContext.captureScreenshot", { context: b.tab(tabId).context, ...(opts.format === "jpeg" ? { format: { type: "image/jpeg" } } : {}) });
        return `data:image/${opts.format === "jpeg" ? "jpeg" : "png"};base64,${data}`;
      },
      onCreated: ev.tabCreated, onUpdated: ev.tabUpdated, onRemoved: ev.tabRemoved, onActivated: ev.tabActivated,
      onReplaced: ev.never, onAttached: ev.never,
    },
    windows: {
      WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2,
      async get(id: number, opts: { populate?: boolean } = {}) { return b.windowObject(id, opts.populate); },
      async getAll(opts: { populate?: boolean } = {}) { return [...b.windows.keys()].map((id) => b.windowObject(id, opts.populate)); },
      async getLastFocused(opts: { populate?: boolean } = {}) {
        const id = b.windows.has(b.lastFocused) ? b.lastFocused : [...b.windows.keys()][0];
        if (id === undefined) throw new Error("No last-focused window");
        return b.windowObject(id, opts.populate);
      },
      async create(props: { url?: string | string[]; tabId?: number; focused?: boolean; left?: number; top?: number; width?: number; height?: number }) {
        if (props.tabId !== undefined) throw new Error("Ladybird cannot move a tab to a new window.");
        const tab = await b.create("new", props.focused === false);
        const context = tab.context;
        const url = Array.isArray(props.url) ? props.url[0] : props.url;
        if (url) {
          tab.url = url;
          tab.status = "loading";
          void b.lb.call("browsingContext.navigate", { context, url, wait: "none" }).catch(() => {});
        }
        await setBounds(tab.windowId, props);
        return b.windowObject(tab.windowId, true);
      },
      async update(id: number, props: { focused?: boolean; left?: number; top?: number; width?: number; height?: number; state?: string }) {
        b.win(id);
        await setBounds(id, props);
        if (props.state === "maximized" || props.state === "minimized" || props.state === "fullscreen") {
          const tabId = b.active.get(id);
          if (tabId !== undefined) await b.lb.classic(async (send) => { await send("POST", "/window", { handle: b.tab(tabId).context }); await send("POST", `/window/${props.state === "maximized" ? "maximize" : props.state === "minimized" ? "minimize" : "fullscreen"}`, {}); });
        }
        if (props.focused) {
          const tabId = b.active.get(id);
          if (tabId !== undefined) await b.lb.call("browsingContext.activate", { context: b.tab(tabId).context });
          if (b.lastFocused !== id) { b.lastFocused = id; ev.winFocus.emit(id); }
        }
        return b.windowObject(id);
      },
      onCreated: ev.winCreated, onRemoved: ev.winRemoved, onFocusChanged: ev.winFocus,
    },
    scripting: {
      async executeScript(inj: { target: { tabId: number; frameIds?: number[]; allFrames?: boolean }; func?: (...a: never[]) => unknown; args?: unknown[]; files?: string[]; world?: string }) {
        const world = inj.world ?? "ISOLATED";
        let decl: string;
        if (inj.func) decl = injected(inj.func.toString(), world);
        else {
          const sources = await Promise.all((inj.files ?? []).map((f) => Bun.file(join(EXT, f)).text()));
          decl = injected(`function () {\n${sources.join("\n;\n")}\n}`, world);
        }
        const frames = b.targets(inj.target);
        const results = await Promise.allSettled(frames.map((f) => b.run(f, decl, inj.args ?? [], ctx.preload)));
        if (results.every((r) => r.status === "rejected") && results.length) throw (results[0] as PromiseRejectedResult).reason;
        return frames.map((f, i) => ({ frameId: f.frameId, documentId: f.context, result: results[i].status === "fulfilled" ? results[i].value : undefined }));
      },
      async registerContentScripts(scripts: { id: string; matches: string[]; js: string[]; world?: string; runAt?: string; allFrames?: boolean; persistAcrossSessions?: boolean }[]) {
        for (const s of scripts) {
          const src = (await Promise.all(s.js.map((f) => Bun.file(join(EXT, f)).text()))).join("\n;\n");
          const pattern = s.matches.map((m) => m.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
          const fn = `() => { if (${s.allFrames ? "true" : "window === window.top"} && /^(?:${pattern.join("|")})$/.test(location.href)) { (function (browser, chrome) {\n${src}\n}).call(window, ${s.world === "MAIN" ? "undefined" : `window[${JSON.stringify(KEY)}]?.api`}, undefined); } }`;
          const { script } = await b.lb.call<{ script: string }>("script.addPreloadScript", { functionDeclaration: fn });
          registered.set(s.id, { id: s.id, matches: s.matches, js: s.js, world: s.world, runAt: s.runAt, allFrames: s.allFrames, preload: script });
        }
      },
      async getRegisteredContentScripts(filter: { ids?: string[] } = {}) {
        return [...registered.values()].filter((s) => !filter.ids || filter.ids.includes(s.id)).map(({ preload: _, ...s }) => s);
      },
      async unregisterContentScripts(filter: { ids?: string[] } = {}) {
        for (const s of [...registered.values()]) {
          if (filter.ids && !filter.ids.includes(s.id)) continue;
          await b.lb.call("script.removePreloadScript", { script: s.preload }).catch(() => {});
          registered.delete(s.id);
        }
      },
    },
    cookies: {
      async getAll(filter: { url?: string; domain?: string; name?: string } = {}) {
        const site = filter.url ?? (filter.domain ? `https://${filter.domain.replace(/^\./, "")}/` : undefined);
        if (!site) throw new Error("Ladybird reads cookies one site at a time: pass url or domain.");
        const all = await onSite(site, (send) => send<ClassicCookie[]>("GET", "/cookie"));
        return all.filter((c) => filter.name === undefined || c.name === filter.name).map(cookieObject);
      },
      async set(d: { url: string; name: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expirationDate?: number }) {
        await onSite(d.url, (send) => send("POST", "/cookie", { cookie: {
          name: d.name, value: d.value ?? "", ...(d.domain ? { domain: d.domain } : {}), path: d.path ?? "/", secure: !!d.secure, httpOnly: !!d.httpOnly,
          ...(d.expirationDate ? { expiry: Math.round(d.expirationDate) } : {}),
          ...(d.sameSite ? { sameSite: d.sameSite === "strict" ? "Strict" : d.sameSite === "lax" ? "Lax" : "None" } : {}),
        } }));
        return { name: d.name, value: d.value ?? "", domain: d.domain ?? new URL(d.url).hostname, path: d.path ?? "/", secure: !!d.secure, httpOnly: !!d.httpOnly, storeId: "0" };
      },
      async remove(d: { url: string; name: string }) {
        await onSite(d.url, (send) => send("DELETE", `/cookie/${encodeURIComponent(d.name)}`));
        return { url: d.url, name: d.name, storeId: "0" };
      },
    },
  };

  async function setBounds(id: number, p: { left?: number; top?: number; width?: number; height?: number }) {
    if (p.left === undefined && p.top === undefined && p.width === undefined && p.height === undefined) return;
    const tabId = b.active.get(id);
    if (tabId === undefined) return;
    const rect = await b.lb.classic(async (send) => {
      await send("POST", "/window", { handle: b.tab(tabId).context });
      return send<{ x: number; y: number; width: number; height: number }>("POST", "/window/rect", { x: p.left ?? null, y: p.top ?? null, width: p.width ?? null, height: p.height ?? null });
    });
    b.win(id).bounds = [p.left ?? rect.x, p.top ?? rect.y, p.width ?? rect.width, p.height ?? rect.height];
  }

  const dispose = () => {
    for (const off of forwarders) off();
    b.events.message.removeListener(onPageMessage);
    for (const t of alarms.values()) clearTimeout(t);
    alarms.clear();
  };
  return { api, dispose };
}

// background.js as Safari runs it: upgrades.js and background.js in one
// scope, given browser.*, a WebSocket that presents the extension's
// origin to the daemon, Ladybird's user agent, and the image calls a
// screenshot makes (raster.ts).
async function runBackground(api: object, userAgent: string) {
  const sources = await Promise.all((MANIFEST.background.scripts as string[]).map((f) => Bun.file(join(EXT, f)).text()));
  class ExtensionSocket extends WebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { Origin: ORIGIN } });
    }
  }
  const run = new Function("browser", "chrome", "WebSocket", "navigator", "createImageBitmap", "OffscreenCanvas", "FileReader", sources.join("\n;\n"));
  run(api, undefined, ExtensionSocket, { userAgent }, createImageBitmap, OffscreenCanvas, FileReader);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "profile-path": { type: "string" }, profile: { type: "string" }, browser: { type: "string", default: "launch" },
      "driver-port": { type: "string", default: "4470" }, "daemon-port": { type: "string", default: "37333" },
      state: { type: "string", default: join(homedir(), ".local/share/safari-harness/ladybird") },
    },
  });
  mkdirSync(values.state!, { recursive: true });
  const browser = values.browser;
  if (browser !== "attach" && browser !== "launch" && browser !== "headless") throw new Error(`--browser is attach, launch or headless, not ${browser}`);
  const lb = await Ladybird.launch({ port: Number(values["driver-port"]), browser, profilePath: values["profile-path"], profile: values.profile });
  console.log(`[ladybird] session ${lb.session}, ${lb.userAgent}`);
  const b = new Browser(lb);
  await b.start();

  const [dialogs, start] = await Promise.all(["dialogs.js", "start.js"].map((f) => Bun.file(join(EXT, f)).text()));
  const preload = preloadSource(dialogs, start);
  await lb.call("script.addPreloadScript", { functionDeclaration: preload, arguments: [{ type: "channel", value: { channel: "harness" } }] });

  const storageFile = join(values.state!, "storage.json");
  let current: Extension | null = null;
  const load = async (startup: boolean) => {
    current?.dispose();
    current = makeApi(b, { storageFile, preload, reload: () => void load(false) });
    await current.api.storage.local.set({ daemonPort: Number(values["daemon-port"]) });
    await runBackground(current.api, lb.userAgent);
    if (startup) (current.api.runtime.onStartup as Ev).emit();
    console.log(`[ladybird] extension ${startup ? "started" : "reloaded"}, daemon port ${values["daemon-port"]}`);
  };
  await load(true);

  const stop = async (why: string) => {
    console.log(`[ladybird] stopping: ${why}`);
    current?.dispose();
    await lb.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  console.log(`[ladybird] ${await lb.closed}`);
  await stop("browser closed");
}

if (import.meta.main) await main();
