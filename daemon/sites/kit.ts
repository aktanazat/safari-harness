// Plumbing shared by the REPL's site globals (slack, gmail, notion, ...).
// Each site works through a background tab of its own on that site, opened
// on first use (and again, once, if it is gone) and closed with the REPL
// session, so its requests carry the owner's Safari session the way the
// site's own page would, and no tab the owner is using is touched. Anything
// that sends or posts goes through draftOrSend: it returns the exact draft
// until the owner approves it.

import type { Invoke } from "../call.ts";

export class NotSignedIn extends Error {
  constructor(readonly site: string, detail = "") {
    super(`not signed in to ${site} in Safari${detail ? ` (${detail})` : ""}; sign in there, then try again`);
    this.name = "NotSignedIn";
  }
}

export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number };
export type FetchResult = { status: number; url: string; type: string | null; text: string; truncated: boolean };

// The extension's answer for a tab that no longer exists (background.js):
// the owner closed it, or it sat unused for 20 minutes (tools.ts).
const GONE = /that tab is gone/;

export class SiteKit {
  private tabs = new Map<string, Promise<number>>();
  // Where each origin's tab opens: the address its site last asked for.
  private homes = new Map<string, string>();
  // The origin of every tab the kit opened, gone ones included.
  private origins = new Map<number, string>();
  private lastRequest = new Map<string, number>();
  // Tool calls for the sites. A call on a kit tab that is gone never ran,
  // so it runs once more in the tab that takes its place; gone again, the
  // error stands.
  readonly invoke: Invoke;

  // owned is told about each tab opened, so the REPL can close it with the
  // session even if close() is never reached. cwd is the session's folder,
  // where a relative path a site saves a file at begins, as with its fs.
  constructor(private send: Invoke, private owned: (tab: number) => void = () => {}, readonly cwd = process.cwd()) {
    this.invoke = async (tool, args) => {
      try {
        return await send(tool, args);
      } catch (e) {
        const gone = Number(args.tab);
        const origin = this.origins.get(gone);
        if (origin === undefined || !(e instanceof Error && GONE.test(e.message))) throw e;
        return send(tool, { ...args, tab: await this.reopen(origin, gone) });
      }
    };
  }

  // A background tab on origin ("https://app.slack.com"), opened at url on
  // first use and reused after. Requests go out from its page.
  tab(origin: string, url?: string): Promise<number> {
    if (url !== undefined) this.homes.set(origin, url);
    let tab = this.tabs.get(origin);
    if (!tab) {
      tab = this.send("open", { url: this.homes.get(origin) ?? `${origin}/`, background: true, site: true }).then((t) => {
        // open answers with the tab it made: {id, url, title} (tools.ts).
        const opened = t as { id: number };
        this.origins.set(opened.id, origin);
        this.owned(opened.id);
        return opened.id;
      });
      this.tabs.set(origin, tab);
      tab.catch(() => this.tabs.delete(origin));
    }
    return tab;
  }

  // The tab in place of gone, origin's tab that no longer exists: a new one
  // where the site last asked, or the one another call already opened.
  async reopen(origin: string, gone: number): Promise<number> {
    const tab = this.tabs.get(origin);
    if (tab && (await tab) === gone && this.tabs.get(origin) === tab) this.tabs.delete(origin);
    return this.tab(origin);
  }

  // A request from the site's own page, with its cookies.
  async fetch(origin: string, url: string, init: FetchInit = {}): Promise<FetchResult> {
    const tab = await this.tab(origin);
    return (await this.invoke("fetch", { tab, url, method: init.method, headers: init.headers, body: init.body, maxBytes: init.maxBytes ?? 20_000_000 })) as FetchResult;
  }

  // fetch, parsed as JSON. 401 and 403 mean the session is gone.
  async json<T = unknown>(origin: string, url: string, init: FetchInit = {}, site = new URL(origin).hostname): Promise<T> {
    const res = await this.fetch(origin, url, init);
    if (res.status === 401 || res.status === 403) throw new NotSignedIn(site, `HTTP ${res.status}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`${site} answered HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    if (res.truncated) throw new Error(`${site} sent more than ${init.maxBytes ?? 20_000_000} bytes`);
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new Error(`${site} did not answer with JSON: ${res.text.slice(0, 200)}`);
    }
  }

  // An expression evaluated in the site's tab; page: true runs it in the
  // page's own world, where the site's script variables are.
  async eval<T = unknown>(origin: string, expression: string, opts: { page?: boolean } = {}): Promise<T> {
    const tab = await this.tab(origin);
    const r = (await this.invoke("eval", { tab, expression, page: !!opts.page })) as { result?: T };
    return r.result as T;
  }

  // Waits until ms have passed since the last request under key, for sites
  // that flag bursts of requests.
  async pace(key: string, ms: number): Promise<void> {
    const wait = (this.lastRequest.get(key) ?? 0) + ms - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    this.lastRequest.set(key, Date.now());
  }

  async close(): Promise<void> {
    const tabs = await Promise.allSettled(this.tabs.values());
    this.tabs.clear();
    // A tab already gone needs no closing, and no new tab to close.
    await Promise.all(tabs.map((t) => (t.status === "fulfilled" ? this.send("close", { tab: t.value }).catch(() => {}) : undefined)));
  }
}

export type Draft = { status: "draft"; site: string; action: string; to?: string; text: string; note: string };
export type Sent<T> = { status: "sent"; site: string; action: string; to?: string; result: T };

// Anything that sends, posts, or changes the owner's account: without
// approved it sends nothing and returns the exact draft for the owner to
// read; called again with approved: true after they say yes, it sends.
export async function draftOrSend<T>(opts: { site: string; action: string; to?: string; text: string; approved?: boolean; send: () => Promise<T> }): Promise<Draft | Sent<T>> {
  const { site, action, to, text } = opts;
  if (opts.approved !== true) {
    return { status: "draft", site, action, ...(to === undefined ? {} : { to }), text, note: "nothing was sent; show the owner this exact text, and call again with { approved: true } only after they approve it" };
  }
  return { status: "sent", site, action, ...(to === undefined ? {} : { to }), result: await opts.send() };
}
