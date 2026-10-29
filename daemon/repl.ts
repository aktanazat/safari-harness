// safari repl: a persistent JavaScript session over the helper's tools, in
// the manner of Playwright. Code runs in a V8 context of its own whose
// top-level bindings last from call to call. `page`, `openTab`, `snapshot`,
// locators and the rest call the same tools the CLI and MCP server call, so
// there is no second way into the browser. The site globals (slack, gmail,
// ...) read the owner's signed-in sites through tabs of their own.

import vm from "node:vm";
import { mkdirSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { homedir } from "node:os";
import { inspect } from "node:util";
import { invoke as defaultInvoke, type Invoke } from "./call.ts";
import { lineDiff } from "./tools.ts";
import { addressedNote } from "./injection.ts";
import { saveAnswer } from "./save.ts";
import { nearest } from "./guard.ts";
import { SiteKit } from "./sites/kit.ts";
import { SITE_ALIASES, SITE_GLOBALS } from "./sites/index.ts";
import type { CaptureResult } from "./evidence.ts";
import { stateLine, type PageState } from "./page-state.ts";
import type { ResearchReceipt } from "./browser-memory.ts";

export const REPL_TIMEOUT_MS = 120_000;

// A run's output past this many characters is saved whole, and the result
// keeps its head and the file's path. On 10-14 one agent's 36 runs reading
// Calendly's and Ashby's bundles printed 250 KB, two of them 30 KB of
// minified source each, cut only where a reply cuts (replyText, tools.ts).
const SPILL_CHARS = 10_000;
const SPILL_HEAD_CHARS = 2_000;
// A failed run's output, and its error, past this many lines are cut to
// them, the whole saved: on 10-22 a failed script's answer began with a
// page's whole snapshot, its error at the end.
const ERROR_LINES = 8;

export type ReplResult = { output: string; error?: string };

type TabRow = { id: number; url?: string; title?: string; active?: boolean; front?: boolean };
type Outcome = { ok?: boolean; navigated?: { url?: string; title?: string }; effect?: { url?: string } | "none"; newTab?: TabRow; dialogs?: unknown[]; next?: string };
type Saved = { path: string; name: string; size: number; type: string };
type Waiter<T> = { resolve: (v: T) => void; reject: (e: Error) => void };
type SnapshotOptions = { interactive?: boolean; showHidden?: boolean; ref?: string; selector?: string; maxNodes?: number };
type Snapshot = { tree: string; diff: string; pageState?: PageState; memoryReceipt?: ResearchReceipt; memoryWarning?: string };
type PasteOptions = { html?: string; tsv?: string };

const DOWNLOADS = nodePath.join(homedir(), "Downloads");

// "[12]" and Aside-style "e12" name the ref "12", and "f1e3" the frame ref
// "f1:3"; anything else passes as a selector or visible text, which the
// page resolves the way actions do.
function targetOf(target: unknown): string {
  const t = String(target).trim();
  const frame = /^f(\d+)e(\d+)$/.exec(t);
  if (frame) return `f${frame[1]}:${frame[2]}`;
  const m = /^\[((?:f\d+:)?\d+)\]$/.exec(t) ?? /^e(\d+)$/.exec(t);
  return m ? m[1] : t;
}

// Text that a getBy* names. Digits alone read as a ref in the page, so they
// go as text=: on 10-02 getByRole('option', { name: '15' }) for a birthday's
// day clicked ref 15, the page's language menu.
function textTarget(text: unknown): string {
  const t = String(text);
  return /^\s*\d+\s*$/.test(t) ? `text=${t.trim()}` : t;
}

// type's code sources ({{code}} in the text), as the type tool takes them.
type CodeSource = { secret?: string; from?: number; from_selector?: string };
function codeSource(opts: CodeSource = {}): CodeSource {
  const { secret, from, from_selector } = opts;
  return { ...(secret === undefined ? {} : { secret }), ...(from === undefined ? {} : { from }), ...(from_selector === undefined ? {} : { from_selector }) };
}

// A url glob as Playwright reads one: ** is any text, * any text but "/",
// {a,b} either choice, \ keeps the next character as it is, and ? is itself.
// The glob covers the whole url. waitForURL('**/apply/frm?<id>') ran out its
// 30 s on that very address, the glob read as text to find (09-30).
function globRegExp(glob: string): RegExp {
  const literal = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let re = "";
  let group = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) re += literal(glob[++i]);
    else if (c === "*" && glob[i + 1] === "*") {
      while (glob[i + 1] === "*") i++;
      re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "{") [group, re] = [true, re + "(?:"];
    else if (c === "}" && group) [group, re] = [false, re + ")"];
    else if (c === "," && group) re += "|";
    else re += literal(c);
  }
  return new RegExp(`^${re}$`);
}

// fs functions whose first two arguments are both paths.
const TWO_PATHS = new Set(["copyFile", "cp", "rename", "link"]);

// node:fs/promises and node:path with relative paths starting at the
// session's folder rather than the process's, which only a one-shot call
// shares.
function rootedFs(cwd: string): typeof fsp {
  const at = (p: unknown) => (typeof p === "string" && !nodePath.isAbsolute(p) ? nodePath.resolve(cwd, p) : p);
  return new Proxy(fsp, {
    get(target, key) {
      const f: unknown = Reflect.get(target, key);
      if (typeof f !== "function") return f;
      return (...args: unknown[]) => f.apply(target, [at(args[0]), ...(TWO_PATHS.has(String(key)) ? [at(args[1]), ...args.slice(2)] : args.slice(1))]);
    },
  });
}

function rootedPath(cwd: string): typeof nodePath {
  return { ...nodePath, resolve: (...parts: string[]) => nodePath.resolve(cwd, ...parts) };
}

// The page's security policy refused to run code in its own world, in
// WebKit's words or the daemon's (EVAL_BLOCKED in tools.ts, thrown).
const EVAL_REFUSED = /unsafe-eval|Content Security Policy|Refused to evaluate|EvalError|Trusted ?Type|security policy blocks eval/i;

function waitFor<T>(ms: number, what: string, arm: (w: Waiter<T> | null) => void): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    arm(null);
    reject(new Error(`no ${what} within ${Math.round(ms / 1000)} s`));
  }, ms);
  arm({
    resolve: (v) => { clearTimeout(timer); resolve(v); },
    reject: (e) => { clearTimeout(timer); reject(e); },
  });
  return promise;
}

export class Download {
  readonly #saved: Saved;
  readonly #cwd: string;
  constructor(saved: Saved, cwd: string) {
    this.#saved = saved;
    this.#cwd = cwd;
  }
  async path(): Promise<string> {
    return this.#saved.path;
  }
  suggestedFilename(): string {
    return this.#saved.name;
  }
  async saveAs(to: string): Promise<void> {
    const dest = nodePath.resolve(this.#cwd, to);
    await fsp.mkdir(nodePath.dirname(dest), { recursive: true });
    await fsp.copyFile(this.#saved.path, dest);
  }
  async failure(): Promise<null> {
    return null;
  }
  [inspect.custom]() {
    return `Download { name: ${JSON.stringify(this.#saved.name)}, path: ${JSON.stringify(this.#saved.path)}, size: ${this.#saved.size} }`;
  }
}

export class Locator {
  readonly #page: Page;
  readonly target: string;
  constructor(page: Page, target: string) {
    this.#page = page;
    this.target = target;
  }
  async click(opts: { noWaitAfter?: boolean } = {}): Promise<void> {
    await this.#page.clickTarget(this.target, opts.noWaitAfter === true);
  }
  async dragTo(target: Locator): Promise<void> {
    if (!(target instanceof Locator) || target.#page.id !== this.#page.id || target.#page.session !== this.#page.session) {
      throw new Error("dragTo needs a locator in the same page");
    }
    await this.#page.act("real_input", { do: "drag", ref: this.target, target: target.target });
  }
  async paste(text: string, opts: PasteOptions = {}): Promise<void> {
    await this.#page.act("real_input", { do: "paste", ref: this.target, text: String(text), ...(opts.html === undefined ? {} : { html: opts.html }), ...(opts.tsv === undefined ? {} : { tsv: opts.tsv }) });
  }
  // opts names where a {{code}} in text comes from: { secret: "page", from:
  // <mail tab> } for an emailed one. Without it, a script's emailed code
  // waited 30 s for a text message (10-02).
  async fill(text: string, opts?: CodeSource & { noWaitAfter?: boolean }): Promise<void> {
    await this.#page.act("type", { ref: this.target, text: String(text), ...codeSource(opts), ...(opts?.noWaitAfter === true ? { noWaitAfter: true } : {}) });
  }
  // Playwright's type() adds keystrokes to what is there.
  async type(text: string, opts?: CodeSource & { noWaitAfter?: boolean }): Promise<void> {
    await this.#page.act("type", { ref: this.target, text: String(text), append: true, ...codeSource(opts), ...(opts?.noWaitAfter === true ? { noWaitAfter: true } : {}) });
  }
  async press(key: string, opts: { noWaitAfter?: boolean } = {}): Promise<void> {
    await this.#page.act("press", { ref: this.target, key: String(key), ...(opts.noWaitAfter === true ? { noWaitAfter: true } : {}) });
  }
  async hover(): Promise<void> {
    await this.#page.act("hover", { ref: this.target });
  }
  async selectOption(choice: unknown, opts: { noWaitAfter?: boolean } = {}): Promise<void> {
    const one = Array.isArray(choice) ? choice[0] : choice;
    const option = one && typeof one === "object" ? (one as { label?: unknown; value?: unknown }).label ?? (one as { value?: unknown }).value : one;
    await this.#page.act("select", { ref: this.target, option: String(option), ...(opts.noWaitAfter === true ? { noWaitAfter: true } : {}) });
  }
  async setInputFiles(files: string | string[]): Promise<void> {
    const paths = (Array.isArray(files) ? files : [files]).map((f) => nodePath.resolve(this.#page.cwd, String(f)));
    await this.#page.act("upload", { ref: this.target, paths });
  }
  async check(): Promise<void> {
    if ((await this.#fact("checked")) !== true) await this.click();
  }
  async uncheck(): Promise<void> {
    if ((await this.#fact("checked")) === true) await this.click();
  }
  textContent(): Promise<string | null> {
    return this.#fact("text") as Promise<string | null>;
  }
  innerText(): Promise<string> {
    return this.#fact("innerText") as Promise<string>;
  }
  innerHTML(): Promise<string> {
    return this.#fact("html") as Promise<string>;
  }
  inputValue(): Promise<string> {
    return this.#fact("value") as Promise<string>;
  }
  getAttribute(name: string): Promise<string | null> {
    return this.#fact("attr", name) as Promise<string | null>;
  }
  isVisible(): Promise<boolean> {
    return this.#fact("visible") as Promise<boolean>;
  }
  isChecked(): Promise<boolean> {
    return this.#fact("checked") as Promise<boolean>;
  }
  count(): Promise<number> {
    return this.#fact("count") as Promise<number>;
  }
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.#fact("box") as Promise<{ x: number; y: number; width: number; height: number }>;
  }
  // The page resolves a target to its first shown match already.
  first(): Locator {
    return this;
  }
  // The match at i, counted from 0, or from the end when negative, in the
  // page's order (matchesOf in content.js): in the two weeks of logs before
  // 10-19, three scripts called nth and one last, which locators lacked.
  nth(i: number): Locator {
    return new Locator(this.#page, `${this.target} >> nth=${i}`);
  }
  last(): Locator {
    return this.nth(-1);
  }
  async all(): Promise<Locator[]> {
    return Array.from({ length: await this.count() }, (_, i) => this.nth(i));
  }
  // Every match's text, in one call to the page.
  allTextContents(): Promise<string[]> {
    return this.#fact("texts") as Promise<string[]>;
  }
  allInnerTexts(): Promise<string[]> {
    return this.#fact("innerTexts") as Promise<string[]>;
  }
  async screenshot(opts: { path?: string } = {}): Promise<Buffer> {
    return this.#page.shot({ ref: this.target, path: opts.path });
  }
  async waitFor(opts: { timeout?: number } = {}): Promise<void> {
    const limit = opts.timeout ?? 30_000;
    const start = Date.now();
    while (!(await this.isVisible())) {
      if (Date.now() - start > limit) throw new Error(`${this.target} did not show within ${Math.round(limit / 1000)} s`);
      await Bun.sleep(250);
    }
    // Then reads where the page is, as page.waitForTimeout does.
    await this.#page.info();
  }
  #fact(what: string, name?: string): Promise<unknown> {
    return this.#page.call("element", { ref: this.target, what, name });
  }
  [inspect.custom]() {
    return `Locator(${JSON.stringify(this.target)})`;
  }
}

export class Page {
  readonly session: ReplSession;
  readonly id: number;
  #url: string;
  #title: string;
  downloadWaiter: Waiter<Download> | null = null;
  popupWaiter: Waiter<Page> | null = null;
  readonly keyboard: { press: (key: string) => Promise<void>; type: (text: string) => Promise<void>; paste: (text: string, opts?: PasteOptions) => Promise<void> };
  readonly mouse: { click: (x: number, y: number) => Promise<void> };

  constructor(session: ReplSession, row: TabRow) {
    this.session = session;
    this.id = row.id;
    this.#url = row.url ?? "";
    this.#title = row.title ?? "";
    this.keyboard = {
      press: async (key) => { await this.act("press", { key: String(key) }); },
      type: async (text) => { await this.act("type", { ref: ":focus", text: String(text), append: true }); },
      paste: async (text, opts = {}) => { await this.act("real_input", { do: "paste", text: String(text), ...(opts.html === undefined ? {} : { html: opts.html }), ...(opts.tsv === undefined ? {} : { tsv: opts.tsv }) }); },
    };
    this.mouse = { click: async (x, y) => { await this.act("click", { x, y }); } };
  }

  get targetId(): string {
    return String(this.id);
  }
  get cwd(): string {
    return this.session.cwd;
  }
  url(): string {
    return this.#url;
  }
  note(url?: string, title?: string): void {
    if (url) this.#url = url;
    if (title !== undefined) this.#title = title;
  }

  // The page's calls go through here, and what each answer says of where
  // the page is becomes page.url(), which reads no page itself: an action's
  // navigated (it loaded a page) or its effect's url (it moved the page
  // within its document, as a single-page app does), else the url of an
  // answer that names the page (snapshot, extract, info, goto, a wait that
  // missed). A move after the latest answer shows with the next one.
  async call(tool: string, args: Record<string, unknown> = {}, model = false): Promise<unknown> {
    const r = await this.session.call(tool, { tab: this.id, ...args }, model);
    if (r !== null && typeof r === "object") {
      const { navigated, effect, url, title } = r as Outcome & { url?: unknown; title?: unknown };
      if (navigated?.url) this.note(navigated.url, navigated.title);
      else if (typeof effect === "object" && effect.url) this.note(effect.url);
      else if (typeof url === "string") this.note(url, typeof title === "string" ? title : undefined);
    }
    return r;
  }

  async info(): Promise<{ url: string; title: string; ready: string }> {
    return (await this.call("info")) as { url: string; title: string; ready: string };
  }
  async title(): Promise<string> {
    return (await this.info()).title;
  }
  async goto(url: string): Promise<{ url: string; title: string }> {
    this.session.showNotes(await this.call("goto", { url: String(url) }));
    return { url: this.#url, title: this.#title };
  }
  async goBack(): Promise<void> {
    await this.act("history", { do: "back" });
    await this.info();
  }
  async goForward(): Promise<void> {
    await this.act("history", { do: "forward" });
    await this.info();
  }
  async reload(): Promise<void> {
    await this.act("history", { do: "reload" });
    await this.info();
  }

  // Runs in the page's own world, as in Playwright. A page whose security
  // policy forbids that runs it beside the page instead: the same DOM, but
  // none of the page's own script variables.
  async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
    const expression = typeof fn === "function" ? `(${String(fn)})(${arg === undefined ? "" : JSON.stringify(arg)})` : String(fn);
    // The refusal comes back as the page's error, or thrown by the daemon.
    const r = (await this.call("eval", { expression, page: true }).catch((e: unknown) => {
      if (e instanceof Error && EVAL_REFUSED.test(e.message)) return { error: e.message };
      throw e;
    })) as { result?: unknown; error?: string };
    if (typeof r?.error !== "string") return r?.result ?? undefined;
    if (!EVAL_REFUSED.test(r.error)) throw new Error(r.error);
    const again = (await this.call("eval", { expression })) as { result?: unknown };
    return again.result ?? undefined;
  }
  async content(): Promise<string> {
    const r = (await this.call("eval", { expression: "document.documentElement.outerHTML" })) as { result: string };
    return r.result;
  }
  // extract(selector), as the guide gives it, or extract({selector, query, maxBytes})
  async extract(opts: string | { selector?: string; query?: string; maxBytes?: number } = {}): Promise<unknown> {
    return this.call("extract", typeof opts === "string" ? { selector: opts } : opts);
  }
  // page.snapshot(options), as snapshot(page, options): on 10-22 a script
  // called it so and failed "is not a function".
  snapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
    return this.session.snapshot(this, opts);
  }

  locator(target: string): Locator {
    return new Locator(this, targetOf(target));
  }
  getByText(text: string): Locator {
    return new Locator(this, textTarget(text));
  }
  getByLabel(text: string): Locator {
    return new Locator(this, textTarget(text));
  }
  getByRole(role: string, opts: { name?: string } = {}): Locator {
    if (opts.name === undefined) throw new Error(`getByRole needs { name }; for any ${role}, take a snapshot and use its ref`);
    return new Locator(this, textTarget(opts.name));
  }
  getByPlaceholder(text: string): Locator {
    return new Locator(this, `[placeholder=${JSON.stringify(String(text))}]`);
  }

  // Playwright's page-level shorthands for a locator's actions.
  click(target: string, opts: { noWaitAfter?: boolean } = {}): Promise<void> {
    return this.locator(target).click(opts);
  }
  fill(target: string, text: string, opts?: CodeSource & { noWaitAfter?: boolean }): Promise<void> {
    return this.locator(target).fill(text, opts);
  }
  type(target: string, text: string, opts?: CodeSource & { noWaitAfter?: boolean }): Promise<void> {
    return this.locator(target).type(text, opts);
  }

  async act(tool: string, args: Record<string, unknown>): Promise<Outcome> {
    const res = (await this.call(tool, args)) as Outcome;
    this.session.showHint(res?.next);
    if (res?.newTab) {
      const popup = this.session.adopt(res.newTab);
      const w = this.popupWaiter;
      this.popupWaiter = null;
      w?.resolve(popup);
    }
    return res;
  }

  // A click that a waitForEvent('download') is waiting on goes through the
  // download tool, which saves what the click downloads.
  async clickTarget(target: string, noWaitAfter = false): Promise<void> {
    const w = this.downloadWaiter;
    if (!w) {
      await this.act("click", noWaitAfter ? { ref: target, noWaitAfter } : { ref: target });
      return;
    }
    this.downloadWaiter = null;
    try {
      w.resolve(await this.session.downloadFrom(this, target));
    } catch (e) {
      w.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  waitForEvent(event: string, opts: { timeout?: number } = {}): Promise<Download | Page> {
    const ms = opts.timeout ?? 30_000;
    if (event === "download") return waitFor<Download>(ms, "download", (w) => { this.downloadWaiter = w; });
    if (event === "popup") return this.session.waitForPopup(this, ms);
    throw new Error(`waitForEvent supports "download" and "popup", not ${JSON.stringify(event)}`);
  }
  async waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<Locator> {
    const ms = opts.timeout ?? 10_000;
    const r = (await this.call("wait", { selector: String(selector), ms })) as { found?: boolean; unanswered?: boolean };
    // A wait the page gave no answer by its end says nothing of the page
    // (wait in tools.ts): on 10-16, with Safari slow, one read as a miss.
    if (r.unanswered === true) throw new Error(`the page gave no answer in time (Safari or the page is slow), so whether ${selector} appeared within ${Math.round(ms / 1000)} s is unknown; wait for it again`);
    if (!r.found) throw new Error(`${selector} did not appear within ${Math.round(ms / 1000)} s`);
    // Then reads where the page is, as waitForTimeout does.
    await this.info();
    return this.locator(selector);
  }
  // Ends once the page shows lines it did not have at the last look, as
  // wait's changed does (tools.ts), and returns them. A script after a
  // click or a scroll can rarely name the text to come, so it slept: in the
  // two weeks of logs before 10-19, 1,935 s past the budget in 19 sessions.
  async waitForChange(opts: { timeout?: number } = {}): Promise<string[]> {
    const ms = opts.timeout ?? 10_000;
    const r = (await this.call("wait", { changed: true, ms })) as { found?: boolean; unanswered?: boolean; added?: string[] };
    if (r.unanswered === true) throw new Error(`the page gave no answer in time (Safari or the page is slow), so whether it changed within ${Math.round(ms / 1000)} s is unknown; wait again`);
    if (!r.found) throw new Error(`nothing new appeared within ${Math.round(ms / 1000)} s`);
    // Then reads where the page is, as waitForTimeout does.
    await this.info();
    return r.added ?? [];
  }
  // Ends once the page is quiet, ms at most, as a wait with only ms does
  // (tools.ts): fixed sleeps in scripts held agents over a minute. The wait
  // tool takes 30 s at a time. Each part goes as the model's own wait: a
  // script's pause is the agent's sleep, and on 09-30 scripts slept 161 s
  // in 46 of them past the budget whose hint (guard.ts) never reached them.
  // A wait's answer says nothing of where the tab is, so the wait ends by
  // reading it: on 10-05 three scripts printed page.url() after one and got
  // where the page had been (Cvent's sign-on, AWS's sign-in, the form)
  // while a snapshot right after showed where it had gone.
  async waitForTimeout(ms: number): Promise<void> {
    let hint: unknown;
    for (let left = Number(ms); left > 0; ) {
      const part = Math.min(left, 30_000);
      const r = (await this.call("wait", { ms: part }, true)) as { waitedMs?: number; hint?: unknown };
      if (r?.hint !== undefined) hint = r.hint;
      const waited = r?.waitedMs ?? part;
      if (waited < part) break;
      left -= waited;
    }
    this.session.showHint(hint);
    await this.info();
  }
  async waitForLoadState(_state?: string, opts: { timeout?: number } = {}): Promise<void> {
    const limit = opts.timeout ?? 30_000;
    const start = Date.now();
    while ((await this.info()).ready !== "complete") {
      if (Date.now() - start > limit) throw new Error(`page still loading after ${Math.round(limit / 1000)} s`);
      await Bun.sleep(250);
    }
  }
  async waitForURL(want: unknown, opts: { timeout?: number } = {}): Promise<void> {
    const limit = opts.timeout ?? 30_000;
    const start = Date.now();
    // Text with no * or {} is still found anywhere in the url, as before.
    const text = String(want);
    const glob = typeof want === "string" && /[*{]/.test(want) ? globRegExp(want) : null;
    const matches = (u: string) => (typeof want === "function" ? Boolean(want(new URL(u))) : Object.prototype.toString.call(want) === "[object RegExp]" ? (want as RegExp).test(u) : glob ? glob.test(u) : u === text || u.includes(text));
    while (!matches((await this.info()).url)) {
      if (Date.now() - start > limit) throw new Error(`url did not match within ${Math.round(limit / 1000)} s; it is ${this.#url}`);
      await Bun.sleep(250);
    }
  }
  // Ends once fn, run in the page as evaluate runs it, returns something
  // truthy, and returns that: on 10-05 a script waited so for a button to
  // show, and the page had no waitForFunction.
  async waitForFunction(fn: unknown, arg?: unknown, opts: { timeout?: number } = {}): Promise<unknown> {
    const limit = opts.timeout ?? 30_000;
    const start = Date.now();
    for (;;) {
      const value = await this.evaluate(fn, arg);
      if (value) return value;
      if (Date.now() - start > limit) throw new Error(`the function returned nothing truthy within ${Math.round(limit / 1000)} s`);
      await Bun.sleep(250);
    }
  }

  async capture(opts: { ref?: string; path?: string; fullPage?: boolean; annotate?: boolean; tiles?: boolean; tileHeight?: number } = {}): Promise<CaptureResult> {
    const out = opts.path === undefined ? undefined : nodePath.resolve(this.cwd, opts.path);
    return await this.call("shot", {
      ref: opts.ref,
      fullPage: !!opts.fullPage,
      annotate: !!opts.annotate,
      tiles: !!opts.tiles,
      tileHeight: opts.tileHeight,
      out,
    }) as CaptureResult;
  }

  async shot(opts: { ref?: string; path?: string; fullPage?: boolean; annotate?: boolean }): Promise<Buffer> {
    const capture = await this.capture(opts);
    return Buffer.from(await fsp.readFile(capture.path));
  }

  screenshot(opts: { path?: string; fullPage?: boolean } = {}): Promise<Buffer> {
    return this.shot(opts);
  }
  // Prints the page to PDF (Safari's own layout; format and margins are
  // not taken). With path, also saves it there.
  async pdf(opts: { path?: string } = {}): Promise<Buffer> {
    const out = opts.path === undefined ? undefined : nodePath.resolve(this.cwd, opts.path);
    if (out) await fsp.mkdir(nodePath.dirname(out), { recursive: true });
    const r = (await this.call("pdf", { do: "save", out })) as { path: string };
    return Buffer.from(await fsp.readFile(r.path));
  }
  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    await this.call("window", { width: size.width, height: size.height });
  }
  async bringToFront(): Promise<void> {
    await this.call("activate");
  }
  fetch(url: string, init?: FetchInit): Promise<Response> {
    return this.session.fetchFrom(this, url, init);
  }
  async close(): Promise<void> {
    await this.session.closeTab(this);
  }
  [inspect.custom]() {
    return `Page { id: ${this.id}, url: ${JSON.stringify(this.#url)}, title: ${JSON.stringify(this.#title)} }`;
  }
}

// The names a page and a locator answer to, for an error's nearest.
const PAGE_METHODS = [...Object.getOwnPropertyNames(Page.prototype), ...Object.getOwnPropertyNames(Locator.prototype)].filter((n) => n !== "constructor");

type FetchInit = { method?: string; headers?: unknown; body?: unknown };

// A value from the session's own V8 context, copied into this one so it
// prints as it would in Node: objects made there do not share this
// context's Object.prototype, and print their prototype's methods.
function toHost(v: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof v === "function") return new Label(`[Function: ${v.name || "anonymous"}]`);
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v)) return new Label("[Circular]");
  if (depth > 8) return new Label("[…]");
  seen.add(v);
  if (typeof (v as Record<symbol, unknown>)[inspect.custom] === "function") return v;
  if (Buffer.isBuffer(v)) return v;
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return v.map((x) => toHost(x, seen, depth + 1));
  const tag = Object.prototype.toString.call(v);
  if (tag === "[object Error]" || ("message" in v && "stack" in v)) return new Label(errorText(v));
  if (tag === "[object Map]") return new Map([...(v as Map<unknown, unknown>)].map(([k, x]) => [toHost(k, seen, depth + 1), toHost(x, seen, depth + 1)]));
  if (tag === "[object Set]") return new Set([...(v as Set<unknown>)].map((x) => toHost(x, seen, depth + 1)));
  if (tag === "[object Date]") return new Date((v as Date).getTime());
  if (tag === "[object RegExp]") return new RegExp((v as RegExp).source, (v as RegExp).flags);
  if (tag === "[object Promise]") return new Label("Promise { <pending>; await it }");
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = toHost((v as Record<string, unknown>)[k], seen, depth + 1);
  return out;
}

class Label {
  constructor(readonly text: string) {}
  [inspect.custom]() {
    return this.text;
  }
}

function show(v: unknown): string {
  return typeof v === "string" ? v : inspect(toHost(v), { depth: 8, maxArrayLength: 500, maxStringLength: 100_000, breakLength: 120 });
}

// Errors from the session's context fail `instanceof Error` here; read them
// by shape. A parse error from the transpiler carries its position.
function errorText(e: unknown): string {
  if (!e || typeof e !== "object" || !("message" in e)) return String(e);
  const name = "name" in e && typeof e.name === "string" ? e.name : "Error";
  const errors = "errors" in e && Array.isArray(e.errors) ? (e.errors as unknown[]) : [];
  if (name === "AggregateError" && errors.length) return errors.map(syntaxError).join("\n");
  if (name === "BuildMessage") return syntaxError(e);
  return `${name}: ${String(e.message)}`;
}

// text's first lines, and the file the whole of it was saved to.
async function cutLines(text: string, what: string, lines = ERROR_LINES): Promise<string> {
  const all = text.split("\n");
  if (all.length <= lines) return text;
  const path = await saveAnswer(text);
  return `${all.slice(0, lines).join("\n")}\n…${all.length - lines} more lines of ${what}; the whole is in ${path}`;
}

// A parse error with its line, column, and the line itself. On 10-01 and
// 10-02 three scripts failed with a bare "Unterminated string literal":
// each had a \n in a quoted string, which the call's JSON turned into a
// line break.
function syntaxError(x: unknown): string {
  const m = x as { message?: string; position?: { line?: number; column?: number; lineText?: string } | null };
  const p = m.position;
  const at = p ? ` (line ${p.line}, column ${p.column})${p.lineText ? `: ${p.lineText.trim()}` : ""}` : "";
  const hint = m.message === "Unterminated string literal" ? "\nhint: a string in quotes ends at its line; write \\n for a line break, or quote it with backticks" : "";
  return `SyntaxError: ${m.message ?? String(x)}${at}${hint}`;
}

// A word of code: a name, a number, or a word of a string.
const WORD = /[\w$]+/g;

// Where in the script an error was thrown, from the first frame of its stack
// in the transpiled code: "line 4" or "lines 3-5". The transpiler reflows the
// script and keeps no source map, but keeps its names, numbers and strings in
// order, so the transpiled line is found as the fewest script lines holding
// its words in order. undefined when the stack has no such frame, or the
// words fit more than one place.
function scriptLines(code: string, js: string, stack: unknown): string | undefined {
  const frame = typeof stack === "string" ? /\brepl:(\d+):\d+/.exec(stack) : null;
  if (!frame) return undefined;
  // The transpiler hands the last expression back as `value: ...`.
  const want = (js.split("\n")[Number(frame[1]) - 1] ?? "").replace(/^\s*value:/, "").match(WORD) ?? [];
  if (want.length === 0) return undefined;
  const lines = code.split("\n").map((line) => line.match(WORD) ?? []);
  const spans: [number, number][] = [];
  for (let start = 0; start < lines.length; start++) {
    let k = 0;
    for (let end = start; end < lines.length && k < want.length; end++) {
      for (const w of lines[end]) if (w === want[k]) k++;
      if (k === want.length) spans.push([start, end]);
    }
  }
  const fewest = Math.min(...spans.map(([s, e]) => e - s));
  const best = spans.filter(([s, e]) => e - s === fewest);
  if (best.length !== 1) return undefined;
  const [s, e] = best[0];
  return s === e ? `line ${s + 1}` : `lines ${s + 1}-${e + 1}`;
}

// The transpiler hoists each top-level declaration to a `var` line above
// the script (`let a, b = 2` to `var a, b;`), and a var declared again keeps
// the value an earlier call left: on 10-19 `let cursor;` began a paginated
// fetch from the last call's cursor, mid-list. So each name the script
// declares starts undefined, as in a new script, on the same line, so the
// lines an error names stay put. Names it does not declare keep their values.
function freshDeclarations(js: string): string {
  return js.replace(/^(?:var [^=;\n]+;\n)+/, (head) => head.replace(/[^\s,;]+(?=[,;])/g, "$& = void 0"));
}

export class ReplSession {
  readonly tabs: Page[] = [];
  readonly kit: SiteKit;
  readonly cwd: string;
  closed = false;
  readonly #invoke: Invoke;
  readonly #owned = new Set<number>();
  readonly #ctx: vm.Context;
  readonly #g: Record<string, unknown>;
  readonly #trees = new Map<string, string>();
  readonly #transpiler = new Bun.Transpiler({ loader: "ts", replMode: true });
  // What the script's `page` holds: the last page opened or attached, or
  // whatever the script assigned to it. It is a plain global, as every
  // other one is: the transpiler hoists `const page = ...` to `var page`,
  // and over a global with a getter and setter that var read undefined
  // ever after, though the setter took the value (10-16).
  get #page(): unknown {
    return this.#g.page;
  }
  set #page(value: unknown) {
    this.#g.page = value;
  }
  #out: string[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  // Which call of the session this is, and the address each tab its
  // openTab opened asked for, in which call (openTab).
  #calls = 0;
  readonly #asked = new Map<number, { address: string; call: number }>();

  // quiet: a person reads the output (a script routine's text to his
  // phone), so the site notes, guides, and hints meant for a model stay out.
  readonly #quiet: boolean;

  constructor(readonly id: string, opts: { cwd?: string; invoke?: Invoke; quiet?: boolean } = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    mkdirSync(this.cwd, { recursive: true });
    this.#invoke = opts.invoke ?? defaultInvoke;
    this.#quiet = opts.quiet === true;
    this.kit = new SiteKit(this.#invoke, undefined, this.cwd);
    this.#ctx = vm.createContext({});
    this.#g = vm.runInContext("globalThis", this.#ctx) as Record<string, unknown>;
    Object.assign(this.#g, this.#globals(), this.#sites(), { page: undefined });
  }

  // The site globals, made with the session: making one opens nothing
  // until a method runs (sites/index.ts). Plain values, so a script that
  // declares `const x = ...` over one has its own x, as with page.
  #sites(): Record<string, object> {
    const made: Record<string, object> = {};
    for (const [name, site] of Object.entries(SITE_GLOBALS)) made[name] = site(this.kit);
    for (const [alias, source] of Object.entries(SITE_ALIASES)) made[alias] = made[source];
    return made;
  }

  call(tool: string, args: Record<string, unknown> = {}, model = false): Promise<unknown> {
    return this.#invoke(tool, args, model);
  }

  get page(): Page | undefined {
    return this.#page instanceof Page ? this.#page : undefined;
  }

  // A site's notes and guide come once, with the first result on the site
  // (notes.ts), so they go to the script's output even if it prints nothing.
  showNotes(result: unknown): void {
    if (this.#quiet || !result || typeof result !== "object") return;
    if ("guide" in result && typeof result.guide === "string") this.#out.push(`guide: ${result.guide}`);
    if ("notes" in result && typeof result.notes === "string") this.#out.push(result.notes);
  }

  // A hint beside a result goes to the script's output on a line of its
  // own, as formatResult prints one (tools.ts), once in a run however
  // many of its actions came back with it. A hint that differs from an
  // earlier one only in its numbers takes that one's place: on 10-16 one
  // script printed "you slept 60 s ...", "61 s", "62 s" ... on 80 lines
  // (guard.ts).
  showHint(hint: unknown): void {
    if (this.#quiet || typeof hint !== "string") return;
    const line = `hint: ${hint}`;
    const kind = line.replace(/\d+/g, "#");
    const at = this.#out.findIndex((l) => l.replace(/\d+/g, "#") === kind);
    if (at >= 0) this.#out[at] = line;
    else this.#out.push(line);
  }

  // Runs one call's code after any earlier call has finished.
  run(code: string, timeoutMs = REPL_TIMEOUT_MS): Promise<ReplResult> {
    const next = this.#chain.then(() => this.#exec(code, timeoutMs));
    this.#chain = next.catch(() => {});
    return next;
  }

  async #exec(code: string, timeoutMs: number): Promise<ReplResult> {
    if (this.closed) return { output: "", error: "this session has ended" };
    this.#calls++;
    this.#out = [];
    let js: string;
    try {
      js = this.#transpiler.transformSync(code);
    } catch (e) {
      const error = errorText(e);
      if (!/Top-level return/.test(error)) return { output: "", error };
      // Playwright scripts often end with `return x`, which the transpiler
      // refuses beside a top-level await. Such a script runs as the body of
      // one async function, on the same lines, and its declarations stay in it.
      try {
        js = this.#transpiler.transformSync(`await (async () => {${code}\n})()`);
      } catch (again) {
        return { output: "", error: errorText(again) };
      }
    }
    let timer: Timer | undefined;
    try {
      await this.#refresh();
      const running = Promise.resolve(vm.runInContext(freshDeclarations(js), this.#ctx, { timeout: timeoutMs, filename: "repl" }) as unknown);
      const limit = Promise.withResolvers<never>();
      timer = setTimeout(() => limit.reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s; the code may still be running in this session`)), timeoutMs);
      const done = await Promise.race([running, limit.promise]);
      // The last expression comes back as { value } on an object with no
      // prototype; a `return x` the transpiler let through, as x itself.
      const value = done !== null && typeof done === "object" && Object.getPrototypeOf(done) === null ? ("value" in done ? done.value : undefined) : done;
      if (value !== undefined) this.#out.push(show(value));
      return { output: await this.#flush() };
    } catch (e) {
      const where = scriptLines(code, js, e && typeof e === "object" && "stack" in e ? e.stack : undefined);
      const text = errorText(e);
      const output = await this.#flush(ERROR_LINES);
      const error = this.#quiet ? text : await cutLines(text, "the error");
      return { output, error: `${error}${where ? `\nat ${where} of the script` : ""}${this.#hint(text)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  // What to do about an error: scripts written for the page reach for its
  // globals, which only the page has, and a name a script got wrong gets
  // its nearest: on 10-22 getTab(745000) failed "getTab is not defined",
  // and a page from listBrowserTabs() "snapshot is not a function".
  #hint(text: string): string {
    if (/^ReferenceError: (document|window|localStorage|location) is not defined/.test(text)) return "\nscripts run outside the page; read it with page.evaluate(() => ...)";
    if (this.#page === undefined && /\(evaluating 'page\./.test(text)) return "\nhint: no page yet: openTab(url) or attachBrowserTab(id) first";
    const name = /^ReferenceError: ([\w$]+) is not defined/.exec(text)?.[1];
    const global = name === undefined ? undefined : nearest(name, Object.keys(this.#g));
    if (global !== undefined) return `\nhint: did you mean ${global}?`;
    const [, on, method] = /^TypeError: (.+?)\.([\w$]+) is not a function/.exec(text) ?? [];
    if (method === undefined) return "";
    if (PAGE_METHODS.includes(method)) return `\nhint: ${on} is not a page; openTab(url) or attachBrowserTab(id) gives one, with ${method}()`;
    // a short name is near too many others: map is not tap
    const near = method.length > 4 ? nearest(method, PAGE_METHODS) : undefined;
    return near === undefined ? "" : `\nhint: did you mean ${on}.${near}()?`;
  }

  // The run's output; past SPILL_CHARS, or past lines, saved whole and its
  // head returned with the path. A person reads a quiet session's output,
  // not a file.
  async #flush(lines = Infinity): Promise<string> {
    const text = this.#out.join("\n");
    this.#out = [];
    if (this.#quiet) return text;
    if (text.split("\n").length > lines) return cutLines(text, "output before the error", lines);
    if (text.length <= SPILL_CHARS) return text;
    const path = await saveAnswer(text);
    return `${text.slice(0, SPILL_HEAD_CHARS)}\n…cut at ${SPILL_HEAD_CHARS} of ${text.length} characters; the whole output is in ${path}: grep it or read the part you need`;
  }

  #print(args: unknown[]): void {
    this.#out.push(args.map(show).join(" "));
  }

  // Keeps each page's url current (the page may have moved on its own) and
  // lets go of tabs someone closed. The tab list cuts a tab this session
  // did not open to origin and path, so such a page reads its own info: on
  // 10-05 a page attached from the user's tab began each later script
  // without its query.
  async #refresh(): Promise<void> {
    if (this.tabs.length === 0) return;
    const rows = await this.#rows(true);
    // A copy: forgetting a page takes it out of this.tabs.
    for (const p of this.tabs.slice()) {
      const row = rows.find((r) => r.id === p.id);
      if (!row) this.#forget(p);
      else if (this.#owned.has(p.id)) p.note(row.url, row.title);
      else await p.info();
    }
  }

  // The tabs tool's rows. An agent's own call lists its tabs, the user's
  // front tab, and a note counting his others; all lists his too, their
  // addresses cut at the path (tabs-view.ts). A page may be one of his.
  async #rows(all = false): Promise<TabRow[]> {
    const r = (await this.call("tabs", all ? { all: true } : {})) as { tabs: unknown[] };
    return r.tabs.filter((t): t is TabRow => typeof t === "object" && t !== null);
  }

  #forget(p: Page): void {
    const i = this.tabs.indexOf(p);
    if (i >= 0) this.tabs.splice(i, 1);
    this.#owned.delete(p.id);
    this.#asked.delete(p.id);
    for (const key of this.#trees.keys()) if (key.startsWith(`${p.id}|`)) this.#trees.delete(key);
    if (this.#page === p) this.#page = this.tabs.at(-1);
  }

  #attached(row: TabRow): Page {
    const known = this.tabs.find((p) => p.id === row.id);
    if (known) {
      known.note(row.url, row.title);
      return known;
    }
    const p = new Page(this, row);
    this.tabs.push(p);
    return p;
  }

  // A tab an action of this session opened: attached, and closed with it.
  adopt(row: TabRow): Page {
    this.#owned.add(row.id);
    return this.#attached(row);
  }

  async listBrowserTabs(): Promise<{ targetId: string; id: number; active: boolean; title: string; url: string; attached: boolean }[]> {
    const rows = await this.#rows();
    return rows.map((r) => ({ targetId: String(r.id), id: r.id, active: !!r.active, title: r.title ?? "", url: r.url ?? "", attached: this.tabs.some((p) => p.id === r.id) }));
  }

  async attachBrowserTab(targetId: unknown): Promise<Page> {
    const id = Number(targetId);
    const row = (await this.#rows(true)).find((r) => r.id === id);
    if (!row) throw new Error(`no open tab ${String(targetId)}; see listBrowserTabs()`);
    const p = this.#attached(row);
    // The tab list cuts a tab not this session's to origin and path, and a
    // named session is its own owner: an agent's own tab lost its query
    // (09-30). info answers with the tab's full address.
    await p.info();
    this.#page = p;
    return p;
  }

  async attachActiveBrowserTab(): Promise<Page> {
    const row = (await this.#rows()).find((r) => r.front);
    if (!row) throw new Error("Safari has no front tab");
    return this.attachBrowserTab(row.id);
  }

  // Every open Safari tab as a page of this session; page stays as it was.
  async getTabs(): Promise<Page[]> {
    const rows = await this.#rows();
    return rows.map((r) => this.#attached(r));
  }

  // A tab this session opened on the same address in an earlier call loads
  // it again, unless new: true (open in tools.ts takes it only while it is
  // free). On 10-05 a sign-up retry loop ran its script in one session
  // every 10 minutes, and each run opened partiful.com in another tab.
  // Within one call each openTab gets a tab of its own, as a script may
  // read several copies of a page at once.
  async openTab(url: string, opts: { background?: boolean; new?: boolean } = {}): Promise<Page> {
    const address = String(url);
    const earlier = (p: Page) => {
      const asked = this.#asked.get(p.id);
      return asked !== undefined && asked.address === address && asked.call < this.#calls;
    };
    const again = opts.new === true ? [] : this.tabs.filter(earlier).map((p) => p.id);
    const row = (await this.call("open", { url: address, background: opts.background ?? true, ...(again.length > 0 ? { again } : {}) })) as TabRow & { hint?: unknown };
    this.showNotes(row);
    this.showHint(row.hint);
    const p = this.adopt(row);
    this.#asked.set(p.id, { address, call: this.#calls });
    this.#page = p;
    return p;
  }

  async closeTab(target?: unknown): Promise<void> {
    const p = target === undefined ? this.page : target instanceof Page ? target : this.tabs.find((t) => t.targetId === String(target));
    if (!p) throw new Error("closeTab(page): no such page in this session");
    await this.call("close", { tab: p.id });
    this.#forget(p);
  }

  async snapshot(page: unknown, opts: SnapshotOptions = {}): Promise<Snapshot> {
    if (!(page instanceof Page)) throw new TypeError("snapshot(page, options): pass a page from openTab() or attachBrowserTab()");
    let root = opts.selector;
    if (root === undefined && opts.ref !== undefined) {
      const ref = targetOf(opts.ref);
      if (!/^\d+$/.test(ref)) throw new Error(`snapshot's ref takes a ref from the top page ("12"); for ${ref} use selector`);
      root = `[data-sh-ref="${ref}"]`;
    }
    const snap = (await page.call("snapshot", { root, maxNodes: opts.maxNodes, showHidden: !!opts.showHidden, interactive: !!opts.interactive })) as { url: string; title: string; snapshot: string; truncated: boolean; addressedToAI?: number; pageState?: PageState; memoryReceipt?: ResearchReceipt; memoryWarning?: string };
    this.showNotes(snap);
    const lines = snap.snapshot.split("\n");
    const cut = snap.truncated ? [`(cut at ${lines.length} lines: narrow with selector or ref, or raise maxNodes)`] : [];
    const warn = [stateLine(snap).trimEnd(), ...(snap.addressedToAI ? [addressedNote(snap.addressedToAI)] : []), ...(snap.memoryWarning ? [`memoryWarning: ${snap.memoryWarning}`] : [])].filter(Boolean);
    const tree = [`title: ${snap.title}`, `url: ${snap.url}`, ...warn, ...lines, ...cut].join("\n");
    const key = `${page.id}|${root ?? ""}|${opts.interactive ? 1 : 0}|${opts.showHidden ? 1 : 0}`;
    const before = this.#trees.get(key);
    this.#trees.set(key, tree);
    const diff = before === undefined ? "(first snapshot)" : lineDiff(before.split("\n"), tree.split("\n")) || "(no change)";
    return { tree, diff, ...(snap.pageState ? { pageState: snap.pageState } : {}), ...(snap.memoryReceipt ? { memoryReceipt: snap.memoryReceipt } : {}), ...(snap.memoryWarning ? { memoryWarning: snap.memoryWarning } : {}) };
  }

  async annotatedScreenshot(page: unknown, opts: { path?: string } = {}): Promise<CaptureResult> {
    if (!(page instanceof Page)) throw new TypeError("annotatedScreenshot(page): pass a page from openTab() or attachBrowserTab()");
    if (![...this.#trees.keys()].some((k) => k.startsWith(`${page.id}|`))) await this.snapshot(page);
    const out = opts.path === undefined ? undefined : nodePath.resolve(this.cwd, opts.path);
    return (await this.call("shot", { tab: page.id, annotate: true, out })) as CaptureResult;
  }

  // What a click on target downloads, saved in ~/Downloads. A download the
  // page's script makes is caught in the page; one the server sends back
  // (a form post, a redirect) lands in ~/Downloads through Safari, so that
  // folder is watched for a new finished file.
  async downloadFrom(page: Page, target: string): Promise<Download> {
    const before = new Set(await fsp.readdir(DOWNLOADS).catch(() => []));
    try {
      const saved = (await this.call("download", { tab: page.id, ref: target })) as Saved;
      return new Download(saved, this.cwd);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/started no download the page could see/.test(msg)) throw e;
    }
    const start = Date.now();
    const sizes = new Map<string, number>();
    while (Date.now() - start < 60_000) {
      await Bun.sleep(500);
      for (const name of await fsp.readdir(DOWNLOADS).catch(() => [])) {
        if (before.has(name) || name.endsWith(".download") || name.startsWith(".")) continue;
        const path = nodePath.join(DOWNLOADS, name);
        const size = (await fsp.stat(path)).size;
        if (sizes.get(name) === size) return new Download({ path, name, size, type: "" }, this.cwd);
        sizes.set(name, size);
      }
    }
    throw new Error("the click started no download: nothing new arrived in ~/Downloads within 60 s");
  }

  // The next tab an action on page opens. The action's own report names it
  // at once; a tab its script opens later shows up in the tab list.
  async waitForPopup(page: Page, ms: number): Promise<Page> {
    const known = new Set((await this.#rows(true)).map((r) => r.id));
    const reported = waitFor<Page>(ms, "popup", (w) => { page.popupWaiter = w; });
    const listed = (async () => {
      const start = Date.now();
      while (Date.now() - start < ms && page.popupWaiter) {
        await Bun.sleep(500);
        const fresh = (await this.#rows(true)).find((r) => !known.has(r.id));
        if (fresh && page.popupWaiter) {
          const w = page.popupWaiter;
          page.popupWaiter = null;
          const p = this.adopt(fresh);
          w.resolve(p);
          return;
        }
      }
    })();
    listed.catch(() => {});
    return reported;
  }

  // A request from a page of this session, with that page's cookies: one on
  // the url's own site if the session has one, else the current page. Its
  // answer's url is the address fetched, not the page's, so the call goes
  // past page.call.
  async fetchFrom(page: Page | undefined, input: unknown, init: FetchInit = {}): Promise<Response> {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? input);
    const from = page ?? this.page;
    const base = from?.url() || undefined;
    const url = new URL(raw, base);
    const sameSite = this.tabs.find((p) => { try { return new URL(p.url()).origin === url.origin; } catch { return false; } });
    const via = page ?? sameSite ?? from;
    if (!via) throw new Error("fetch sends the request from a page, with its cookies: open or attach a tab on that site first (openTab(url))");
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers as Record<string, string> | undefined);
    if (init.body !== undefined && typeof init.body !== "string" && !(init.body instanceof URLSearchParams)) throw new Error("fetch body must be a string or URLSearchParams");
    const r = (await this.call("fetch", { tab: via.id, url: url.href, method: init.method, headers, body: init.body === undefined ? undefined : String(init.body), base64: true, maxBytes: 50_000_000 })) as { status: number; url: string; headers?: [string, string][]; data: string; truncated: boolean };
    const empty = r.status === 204 || r.status === 304 || (init.method ?? "GET").toUpperCase() === "HEAD";
    const res = new Response(empty ? null : Buffer.from(r.data, "base64"), { status: r.status, headers: r.headers });
    Object.defineProperty(res, "url", { value: r.url });
    if (r.truncated) Object.defineProperty(res, "truncated", { value: true });
    return res;
  }

  // asked: the session was ended on request (safari repl --close), so the
  // pages its scripts changed close too, as at a turn's end; ended by itself
  // (30 minutes unused, its agent's exit) it leaves those be. A tab kept for
  // the user, or handed to him, stays either way (close in tools.ts).
  async close(asked = false): Promise<{ closed: number }> {
    if (this.closed) return { closed: 0 };
    this.closed = true;
    const answers = [...(await this.kit.close()), ...(await Promise.all([...this.#owned].map((id) => this.call("close", { tab: id, held: true, ...(asked ? { ended: true } : {}) }).catch(() => undefined))))] as ({ ok?: boolean; kept?: true; protected?: unknown } | null | undefined)[];
    this.#owned.clear();
    this.tabs.length = 0;
    this.#page = undefined;
    return { closed: answers.filter((a) => a?.ok === true && !a.kept && a.protected === undefined).length };
  }

  #globals(): Record<string, unknown> {
    const log = (...args: unknown[]) => this.#print(args);
    return {
      tabs: this.tabs,
      listBrowserTabs: () => this.listBrowserTabs(),
      attachBrowserTab: (id: unknown) => this.attachBrowserTab(id),
      attachActiveBrowserTab: () => this.attachActiveBrowserTab(),
      getTabByTargetId: (id: unknown) => this.tabs.find((p) => p.targetId === String(id)) ?? null,
      getTabs: () => this.getTabs(),
      openTab: (url: string, opts?: { background?: boolean; new?: boolean }) => this.openTab(url, opts),
      closeTab: (p?: unknown) => this.closeTab(p),
      snapshot: (p: unknown, o?: SnapshotOptions) => this.snapshot(p, o),
      saveSource: (receipt: string, reason: string) => this.call("save_source", { receipt, reason }),
      annotatedScreenshot: (p: unknown, o?: { path?: string }) => this.annotatedScreenshot(p, o),
      fetch: (input: unknown, init?: FetchInit) => this.fetchFrom(undefined, input, init),
      display: log,
      console: { log, info: log, warn: log, error: log, debug: log, dir: log, table: log },
      sleep: (ms: number) => Bun.sleep(ms),
      pwd: this.cwd,
      fs: rootedFs(this.cwd),
      path: rootedPath(this.cwd),
      // Bun.write, as scripts reach for it to save a page's text: 5 of the 8
      // "Bun is not defined" in the two weeks of logs before 10-19. Bun.file
      // reads back what an earlier run saved (10-22). Their paths start in
      // the session's folder, as fs's do, and write makes folders as Bun's
      // does; the rest of Bun is not here.
      Bun: {
        write: async (file: string, data: string | Blob | ArrayBuffer | Uint8Array | Response) => {
          const to = nodePath.resolve(this.cwd, String(file));
          const bytes = new Uint8Array(await (data instanceof Response ? data : new Response(data)).arrayBuffer());
          await fsp.mkdir(nodePath.dirname(to), { recursive: true });
          await fsp.writeFile(to, bytes);
          return bytes.byteLength;
        },
        file: (file: string) => {
          const at = nodePath.resolve(this.cwd, String(file));
          return {
            name: at,
            text: () => fsp.readFile(at, "utf8"),
            json: async () => JSON.parse(await fsp.readFile(at, "utf8")),
            bytes: async () => new Uint8Array(await fsp.readFile(at)),
            exists: () => fsp.access(at).then(() => true, () => false),
          };
        },
      },
      Buffer,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
      URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
      Blob, Response, Headers, FormData, atob, btoa, crypto, performance,
    };
  }
}
