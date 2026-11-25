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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
type Rect = { x: number; y: number; width: number; height: number };
type Layout = { screens: { frame: Rect }[]; reference?: Rect };

const INPUT = new URL("../scripts/input", import.meta.url).pathname;
// How stale the display layout may be when a window sync reads it.
const LAYOUT_MS = 2000;

// The display holding most of r.
function holdingScreen(r: Rect, screens: { frame: Rect }[]): Rect | undefined {
  const shared = (s: Rect) => Math.max(0, Math.min(r.x + r.width, s.x + s.width) - Math.max(r.x, s.x)) * Math.max(0, Math.min(r.y + r.height, s.y + s.height) - Math.max(r.y, s.y));
  const best = screens.reduce<{ frame: Rect } | undefined>((most, s) => (!most || shared(s.frame) > shared(most.frame) ? s : most), undefined);
  return best && shared(best.frame) > 0 ? best.frame : undefined;
}

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
      const state = { k: "page", title: document.title, visible: document.visibilityState === "visible", focused: document.hasFocus() };
      const now = JSON.stringify(state);
      if (now !== last) { last = now; post(state); }
    };
    addEventListener("DOMContentLoaded", () => {
      report();
      new MutationObserver(report).observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
    }, { once: true });
    for (const type of ["load", "focus", "blur"]) addEventListener(type, report);
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
  // Windows by the name Ladybird gives each (clientWindow "window-N",
  // syncWindows), which its UI does once it shows a tab there.
  #winOf = new Map<string, number>();
  #syncing: Promise<void> | undefined;
  // A tab placed by a move's reply keeps that place against a sync whose
  // snapshot was asked for before it.
  #placements = 0;
  #placedAt = new Map<number, number>();
  // Ids go on from where the bridge's last run left them (idsFile): the
  // extension's storage and the daemon keep tabs by id across runs, and a
  // new tab with an old one's id would take that tab's owner and marks.
  #nextTab = 1;
  #nextWin = 1;
  #nextFrame = new Map<number, number>();
  readonly events = {
    tabCreated: new Ev(), tabUpdated: new Ev(), tabRemoved: new Ev(), tabActivated: new Ev(),
    winCreated: new Ev(), winRemoved: new Ev(), winFocus: new Ev(), tabAttached: new Ev(),
    message: new Ev(), actionClicked: new Ev(),
  };

  constructor(readonly lb: Ladybird, readonly idsFile: string) {
    if (!existsSync(idsFile)) return;
    const ids = JSON.parse(readFileSync(idsFile, "utf8")) as { tab: number; win: number };
    this.#nextTab = ids.tab;
    this.#nextWin = ids.win;
  }

  #saveIds() {
    writeFileSync(this.idsFile, JSON.stringify({ tab: this.#nextTab, win: this.#nextWin }));
  }

  async start() {
    this.lb.on((e) => this.#event(e));
    await this.lb.call("session.subscribe", {
      events: ["browsingContext.contextCreated", "browsingContext.contextDestroyed", "browsingContext.navigationStarted", "browsingContext.navigationCommitted", "browsingContext.load", "browsingContext.historyUpdated", "browsingContext.fragmentNavigated", "script.message", "ladybird:action.clicked"],
    });
    const tree = await this.lb.call<{ contexts: Info[] }>("browsingContext.getTree", {});
    for (const top of tree.contexts) this.#adopt(top, false);
    // The pages the user had open before, which no preload reported, give their titles now.
    await Promise.all([...this.tabs.values()].map(async (tab) => {
      const r = await this.lb.call<CallResult>("script.evaluate", { expression: "document.title", target: { context: tab.context }, awaitPromise: false }).catch(() => null);
      if (r?.type === "success" && typeof r.result.value === "string") tab.title = r.result.value;
    }));
    await this.syncWindows();
  }

  #newWindow(): number {
    const id = this.#nextWin++;
    this.#saveIds();
    this.windows.set(id, { id });
    this.events.winCreated.emit(this.windowObject(id));
    return id;
  }

  // A tab a page opened goes in its opener's window, any other in the
  // window last in front; one this bridge made then goes where it asked
  // (create).
  #placeTab(opener: number | undefined): number {
    const beside = opener !== undefined ? this.tabs.get(opener)?.windowId : undefined;
    if (beside !== undefined && this.windows.has(beside)) return beside;
    if (this.windows.size === 0) return this.#newWindow();
    return this.windows.has(this.lastFocused) ? this.lastFocused : [...this.windows.keys()][0];
  }

  // Each tab goes to the window Ladybird says shows it, and each window
  // takes the bounds and focus Ladybird reports.
  syncWindows(): Promise<void> {
    this.#syncing ??= (async () => {
      const asked = this.#placements;
      const [{ contexts }, { clientWindows }] = await Promise.all([
        this.lb.call<{ contexts: (Info & { clientWindow?: string })[] }>("browsingContext.getTree", { maxDepth: 0 }),
        this.lb.call<{ clientWindows: { clientWindow: string; active: boolean; x: number; y: number; width: number; height: number }[] }>("browser.getClientWindows"),
        this.refreshLayout(LAYOUT_MS),
      ]);
      for (const c of contexts) {
        const tab = this.tabs.get(this.#tabOf.get(c.context) ?? -1);
        if (!tab || !c.clientWindow?.startsWith("window-") || (this.#placedAt.get(tab.id) ?? 0) > asked) continue;
        this.#place(tab, c.clientWindow);
      }
      this.#dropEmptyWindows();
      for (const w of clientWindows) {
        const id = this.#winOf.get(w.clientWindow);
        const win = id === undefined ? undefined : this.windows.get(id);
        if (!win) continue;
        if (w.width > 0) win.bounds = [w.x, w.y, w.width, w.height];
        if (w.active && this.lastFocused !== win.id) {
          this.lastFocused = win.id;
          this.events.winFocus.emit(win.id);
        }
      }
    })().finally(() => { this.#syncing = undefined; });
    return this.#syncing;
  }

  // The tab goes to the window Ladybird names: a window this bridge placed
  // tabs in takes the first name Ladybird gives it.
  #place(tab: Tab, clientWindow: string) {
    let windowId = this.#winOf.get(clientWindow);
    if (windowId === undefined) {
      windowId = [...this.#winOf.values()].includes(tab.windowId) ? this.#newWindow() : tab.windowId;
      this.#winOf.set(clientWindow, windowId);
    }
    if (tab.windowId !== windowId) this.#move(tab, windowId);
  }

  // Moves a tab to a window, or to a new one, with Ladybird's
  // ladybird:moveTab, and answers the window its reply names.
  async moveTab(tab: Tab, to: number | "new", background: boolean): Promise<number> {
    await this.syncWindows();
    const name = to === "new" ? undefined : [...this.#winOf].find(([, id]) => id === to)?.[0];
    if (to !== "new" && name === undefined) throw new Error(`No window with id: ${to}.`);
    const { clientWindow } = await this.lb.call<{ clientWindow: string }>("ladybird:moveTab", { context: tab.context, background, ...(name ? { clientWindow: name } : {}) });
    this.#placedAt.set(tab.id, ++this.#placements);
    this.#place(tab, clientWindow);
    this.#dropEmptyWindows();
    return tab.windowId;
  }

  #move(tab: Tab, windowId: number) {
    const from = tab.windowId;
    tab.windowId = windowId;
    if (this.active.get(from) === tab.id) this.active.delete(from);
    if (!this.active.has(windowId)) this.active.set(windowId, tab.id);
    this.events.tabAttached.emit(tab.id, { newWindowId: windowId, newPosition: this.tabObject(tab).index });
  }

  // Once every tab is where it belongs: a window left with no tab is gone,
  // and one that lost its active tab shows another.
  #dropEmptyWindows() {
    for (const id of [...this.windows.keys()]) {
      const left = [...this.tabs.values()].filter((t) => t.windowId === id);
      if (left.length === 0) {
        this.windows.delete(id);
        this.active.delete(id);
        for (const [name, w] of this.#winOf) if (w === id) this.#winOf.delete(name);
        this.events.winRemoved.emit(id);
      } else if (!this.active.has(id)) {
        this.active.set(id, left[0].id);
      }
    }
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
      this.#saveIds();
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
      case "ladybird:action.clicked": {
        const tab = this.tabs.get(this.#tabOf.get(context ?? "") ?? -1);
        if (tab) this.events.actionClicked.emit(this.tabObject(tab));
        return;
      }
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
      for (const [name, id] of this.#winOf) if (id === win.id) this.#winOf.delete(name);
      this.events.winRemoved.emit(win.id);
    }
  }

  #message(params: Record<string, unknown>) {
    const source = params.source as { context?: string } | undefined;
    const frame = source?.context ? this.frames.get(source.context) : undefined;
    const data = params.data as Remote | undefined;
    if (!frame || data?.type !== "string") return;
    const m = JSON.parse(String(data.value)) as { k: string; id?: number; msg?: unknown; title?: string; visible?: boolean; focused?: boolean };
    const tab = this.tabs.get(frame.tabId);
    if (!tab) return;
    if (m.k === "msg") return this.events.message.emit(frame, m.id, m.msg);
    if (m.k !== "page" || frame.frameId !== 0) return;
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
    const { context } = await this.lb.call<{ context: string }>("browsingContext.create", {
      type: where === "new" ? "window" : "tab", background, ...(ref !== undefined ? { referenceContext: this.tab(ref).context } : {}),
    });
    // Its contextCreated may come after the reply.
    if (!this.#tabOf.has(context)) {
      const tree = await this.lb.call<{ contexts: Info[] }>("browsingContext.getTree", { root: context });
      for (const top of tree.contexts) this.#adopt(top, true);
    }
    // The reply names the context, so it goes where it was asked, whichever
    // window #placeTab put it in as it was announced.
    const tab = this.tab(this.#tabOf.get(context)!);
    const alone = ![...this.tabs.values()].some((t) => t !== tab && t.windowId === tab.windowId);
    const windowId = where === "new" ? (alone ? tab.windowId : this.#newWindow()) : where;
    if (tab.windowId !== windowId) {
      this.#move(tab, windowId);
      this.#dropEmptyWindows();
    }
    return tab;
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

  // The displays, and the one a new window opens on, as the harness's native
  // helper reads them (scripts/input windows), at most maxAge ms old.
  layout: Layout = { screens: [] };
  #layoutAt = 0;
  async refreshLayout(maxAge: number): Promise<void> {
    if (Date.now() - this.#layoutAt <= maxAge) return;
    const helper = Bun.spawn([INPUT, "windows"], { stdout: "pipe", stderr: "ignore" });
    this.layout = JSON.parse(await new Response(helper.stdout).text()) as Layout;
    this.#layoutAt = Date.now();
  }

  // Safari counts a window's left and top from the top-left of the display
  // holding most of it; Ladybird's are the screen's.
  windowObject(id: number, populate = false) {
    const w = this.win(id);
    const [x, y, width, height] = w.bounds ?? [0, 0, 0, 0];
    const origin = holdingScreen({ x, y, width, height }, this.layout.screens) ?? { x: 0, y: 0 };
    return {
      id, focused: this.lastFocused === id, left: x - origin.x, top: y - origin.y, width, height, state: "normal", type: "normal", incognito: false, alwaysOnTop: false,
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

  // script.callFunction, again once when Ladybird moved the page to another
  // WebContent process mid-call ("WebContent was replaced while executing
  // the command"), as it does when a navigation changes site.
  async callFunction<T = CallResult>(params: object): Promise<T> {
    try {
      return await this.lb.call<T>("script.callFunction", params);
    } catch (e) {
      if (!String(e).includes("WebContent was replaced")) throw e;
      return this.lb.call<T>("script.callFunction", params);
    }
  }

  // Runs one function in one frame's page world.
  async run(frame: Frame, decl: string, args: unknown[], preload: string): Promise<unknown> {
    const call = () => this.callFunction({
      functionDeclaration: decl, arguments: [{ type: "string", value: JSON.stringify(args) }], target: { context: frame.context }, awaitPromise: true,
    });
    let r = await call();
    // A frame from before the preload was added gets the shim now.
    if (r.type === "exception" && r.exceptionDetails.text.includes(`${KEY}:no-shim`)) {
      await this.callFunction({ functionDeclaration: preload, arguments: [{ type: "channel", value: { channel: "harness" } }], target: { context: frame.context }, awaitPromise: false });
      r = await call();
    }
    if (r.type === "exception") throw new Error(r.exceptionDetails.text);
    return JSON.parse(String(r.result.value));
  }
}

// A cookie as WebDriver BiDi's storage module gives it, from the browser's
// own jar, HttpOnly and session cookies included.
type BidiCookie = { name: string; value: { type: string; value: string }; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: string; expiry?: number };

function cookieObject(c: BidiCookie) {
  return {
    name: c.name, value: c.value.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
    hostOnly: !c.domain.startsWith("."), session: c.expiry === undefined, storeId: "0",
    sameSite: c.sameSite === "strict" ? "strict" : c.sameSite === "lax" ? "lax" : c.sameSite === "none" ? "no_restriction" : "unspecified",
    ...(c.expiry !== undefined ? { expirationDate: c.expiry } : {}),
  };
}

// cookies.getAll's filters: the cookies a request to url would send, or
// those of domain and its subdomains.
function cookieMatches(c: BidiCookie, filter: { url?: string; domain?: string; name?: string }): boolean {
  const bare = c.domain.replace(/^\./, "");
  if (filter.name !== undefined && c.name !== filter.name) return false;
  if (filter.domain !== undefined) {
    const want = filter.domain.replace(/^\./, "");
    if (bare !== want && !bare.endsWith(`.${want}`)) return false;
  }
  if (filter.url !== undefined) {
    const u = new URL(filter.url);
    const hostOk = c.domain.startsWith(".") ? u.hostname === bare || u.hostname.endsWith(`.${bare}`) : u.hostname === bare;
    if (!hostOk || !u.pathname.startsWith(c.path) || (c.secure && u.protocol !== "https:")) return false;
  }
  return true;
}

// browser.* for one run of the extension's background scripts; a
// runtime.reload drops it and makes another.
type Extension = { api: { runtime: { onStartup: Ev }; storage: { local: { set(items: Record<string, unknown>): Promise<void> } } }; dispose: () => void };
function makeApi(b: Browser, ctx: { storageFile: string; preload: string; reload: () => void }): Extension {
  const ev = {
    tabCreated: new Ev(), tabUpdated: new Ev(), tabRemoved: new Ev(), tabActivated: new Ev(),
    winCreated: new Ev(), winRemoved: new Ev(), winFocus: new Ev(), tabAttached: new Ev(),
    message: new Ev(), alarm: new Ev(), never: new Ev(), actionClicked: new Ev(),
  };
  const relays: [Ev, Ev][] = [
    [b.events.tabCreated, ev.tabCreated], [b.events.tabUpdated, ev.tabUpdated], [b.events.tabRemoved, ev.tabRemoved],
    [b.events.tabActivated, ev.tabActivated], [b.events.winCreated, ev.winCreated], [b.events.winRemoved, ev.winRemoved],
    [b.events.winFocus, ev.winFocus], [b.events.tabAttached, ev.tabAttached], [b.events.actionClicked, ev.actionClicked],
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

  const cookiesWhere = async (filter: { url?: string; domain?: string; name?: string }) =>
    (await b.lb.call<{ cookies: BidiCookie[] }>("storage.getCookies", {})).cookies.filter((c) => cookieMatches(c, filter));

  const api = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (p: string) => `ladybird-harness://extension/${p.replace(/^\//, "")}`,
      getManifest: () => structuredClone(MANIFEST),
      onMessage: ev.message, onConnect: ev.never, onInstalled: ev.never, onStartup: new Ev(),
      reload: () => ctx.reload(),
    },
    // The toolbar button Ladybird Harness shows while this bridge is attached
    // (ladybird:setAction), per tab, as Safari shows the extension's.
    action: {
      async setBadgeText({ tabId, text }: { tabId?: number; text: string }) {
        await b.lb.call("ladybird:setAction", { ...(tabId !== undefined ? { context: b.tab(tabId).context } : {}), badge: text });
      },
      async setTitle({ tabId, title }: { tabId?: number; title: string }) {
        await b.lb.call("ladybird:setAction", { ...(tabId !== undefined ? { context: b.tab(tabId).context } : {}), title });
      },
      onClicked: ev.actionClicked,
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
        await b.syncWindows();
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
      async move(ids: number | number[], props: { windowId: number; index?: number }) {
        const moved = [];
        for (const id of typeof ids === "number" ? [ids] : ids) {
          const tab = b.tab(id);
          await b.moveTab(tab, props.windowId, true);
          moved.push(b.tabObject(tab));
        }
        return typeof ids === "number" ? moved[0] : moved;
      },
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
      onReplaced: ev.never, onAttached: ev.tabAttached,
    },
    windows: {
      WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2,
      async get(id: number, opts: { populate?: boolean } = {}) { await b.syncWindows(); return b.windowObject(id, opts.populate); },
      async getAll(opts: { populate?: boolean } = {}) { await b.syncWindows(); return [...b.windows.keys()].map((id) => b.windowObject(id, opts.populate)); },
      async getLastFocused(opts: { populate?: boolean } = {}) {
        await b.syncWindows();
        const id = b.windows.has(b.lastFocused) ? b.lastFocused : [...b.windows.keys()][0];
        if (id === undefined) throw new Error("No last-focused window");
        return b.windowObject(id, opts.populate);
      },
      async create(props: { url?: string | string[]; tabId?: number; focused?: boolean; left?: number; top?: number; width?: number; height?: number }) {
        let tab: Tab;
        if (props.tabId !== undefined) {
          tab = b.tab(props.tabId);
          await b.moveTab(tab, "new", props.focused === false);
        } else {
          tab = await b.create("new", props.focused === false);
        }
        const context = tab.context;
        const url = Array.isArray(props.url) ? props.url[0] : props.url;
        if (url) {
          tab.url = url;
          tab.status = "loading";
          void b.lb.call("browsingContext.navigate", { context, url, wait: "none" }).catch(() => {});
        }
        await setBounds(tab.windowId, props, true);
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
        return (await cookiesWhere(filter)).map(cookieObject);
      },
      async set(d: { url: string; name: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expirationDate?: number }) {
        // No domain makes a host-only cookie, as in Chrome; a domain makes one for its subdomains too.
        const domain = d.domain ? `.${d.domain.replace(/^\./, "")}` : new URL(d.url).hostname;
        const cookie = {
          name: d.name, value: { type: "string", value: d.value ?? "" }, domain, path: d.path ?? "/", secure: !!d.secure, httpOnly: !!d.httpOnly,
          ...(d.sameSite ? { sameSite: d.sameSite === "no_restriction" ? "none" : d.sameSite } : {}),
          ...(d.expirationDate ? { expiry: Math.round(d.expirationDate) } : {}),
        };
        await b.lb.call("storage.setCookie", { cookie });
        return cookieObject({ ...cookie, sameSite: cookie.sameSite ?? "default" });
      },
      async remove(d: { url: string; name: string }) {
        for (const c of await cookiesWhere({ url: d.url, name: d.name })) {
          await b.lb.call("storage.deleteCookies", { filter: { name: c.name, domain: c.domain, path: c.path } });
        }
        return { url: d.url, name: d.name, storeId: "0" };
      },
    },
  };

  // left and top count, as in Safari, from the top-left of the display
  // holding most of the window, or for a new window from the display Safari
  // opens one on (the helper's reference display).
  async function setBounds(id: number, p: { left?: number; top?: number; width?: number; height?: number }, opening = false) {
    if (p.left === undefined && p.top === undefined && p.width === undefined && p.height === undefined) return;
    const tabId = b.active.get(id);
    if (tabId === undefined) return;
    if (!opening) await b.syncWindows();
    await b.refreshLayout(0);
    const [x, y, width, height] = b.win(id).bounds ?? [0, 0, 0, 0];
    const origin = (opening ? b.layout.reference : holdingScreen({ x, y, width, height }, b.layout.screens)) ?? { x: 0, y: 0 };
    const rect = await b.lb.classic(async (send) => {
      await send("POST", "/window", { handle: b.tab(tabId).context });
      return send<Rect>("POST", "/window/rect", {
        x: p.left === undefined ? null : origin.x + p.left, y: p.top === undefined ? null : origin.y + p.top,
        width: p.width ?? null, height: p.height ?? null,
      });
    });
    b.win(id).bounds = [rect.x, rect.y, rect.width, rect.height];
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
  const b = new Browser(lb, join(values.state!, "ids.json"));
  await b.start();
  await lb.call("ladybird:setAction", { title: "Safari Harness" });

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
