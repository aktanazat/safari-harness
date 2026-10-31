// Plumbing shared by the REPL's site globals (slack, gmail, notion, ...).
// Each site works through a background tab of its own on that site, opened
// on first use (and again, once, if it is gone) and closed with the REPL
// session, so its requests carry the owner's Safari session the way the
// site's own page would, and no tab the owner is using is touched. Anything
// that sends or posts goes through draftOrSend: it returns the exact draft
// until the owner approves it.

import type { Invoke } from "../call.ts";
import { rateLimited } from "../failures.ts";
import type { Limit } from "../pace.ts";

export class NotSignedIn extends Error {
  constructor(readonly site: string, detail = "") {
    super(`not signed in to ${site} in Safari${detail ? ` (${detail})` : ""}; sign in there, then try again`);
    this.name = "NotSignedIn";
  }
}

export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number };
// headers: the response's content-length, retry-after, and rate-limit
// headers, those the page could read (another origin exposes few); total:
// the whole text's length, of which text holds the first maxBytes.
export type FetchResult = { status: number; url: string; type: string | null; text: string; truncated: boolean; headers?: [string, string][]; total?: number };

// The reset a response names, in epoch ms: Retry-After, in seconds or as a
// date, or x-rate-limit-reset, in epoch seconds (X sends it with every API
// answer, beside x-rate-limit-remaining: 10-29).
function resetOf(header: (name: string) => string | null | undefined): number | undefined {
  const after = header("retry-after");
  if (after) {
    const seconds = Number(after);
    return Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(after) || undefined;
  }
  const reset = Number(header("x-rate-limit-reset"));
  return reset > 0 ? reset * 1000 : undefined;
}

// The extension's answer for a tab that no longer exists (background.js):
// the owner closed it, or it sat unused for 20 minutes (tools.ts).
const GONE = /that tab is gone/;
// Its answer for a page that answered nothing for 5 s: a dialog or a stuck
// load holds it, or Safari, short of memory, passed nothing on for that long
// (10-31: 91% of those answers came within 10 s of Safari's own calls
// stalling).
const HELD = /did not answer.*; reload it with goto and retry$/;

export class SiteKit {
  private tabs = new Map<string, Promise<number>>();
  // Where each origin's tab opens: the address its site last asked for.
  private homes = new Map<string, string>();
  // The origin of every tab the kit opened, gone ones included.
  private origins = new Map<number, string>();
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

  // fetch, parsed as JSON. A 429 fails with rate_limited; 401 and 403 mean
  // the session is gone.
  async json<T = unknown>(origin: string, url: string, init: FetchInit = {}, site = new URL(origin).hostname): Promise<T> {
    const res = await this.fetch(origin, url, init);
    const limit = await this.limited(origin, res.status, (name) => res.headers?.find(([k]) => k.toLowerCase() === name)?.[1]);
    if (limit) throw rateLimited(limit.host, limit.resetAt, limit.guessed);
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
  // page's own world, where the site's script variables are. read: true
  // says it can safely run twice: when the page did not answer, the held
  // tab is closed and the expression asked once more in a new tab where the
  // site asked; not answering again, the error stands. A new tab, because
  // the daemon refuses to repeat an eval in the tab where it may have run
  // until that tab is read (mission.ts checkAction), and a reload is no read.
  async eval<T = unknown>(origin: string, expression: string, opts: { page?: boolean; read?: boolean } = {}): Promise<T> {
    const tab = await this.tab(origin);
    const args = { tab, expression, page: !!opts.page };
    const r = (await this.invoke("eval", args).catch(async (e: unknown) => {
      if (!opts.read || !(e instanceof Error && HELD.test(e.message))) throw e;
      await this.send("close", { tab });
      return this.invoke("eval", { ...args, tab: await this.reopen(origin, tab) });
    })) as { result?: T };
    return r.result as T;
  }

  // Waits for host's turn, gap ms after the request before it from any
  // agent or session (pace.ts); bucket names the one of host's limits the
  // request falls under. A host still rate-limited past a short wait fails
  // at once with rate_limited.
  async turn(host: string, gap: number, bucket?: string): Promise<void> {
    const t = (await this.invoke("pace", { host, gap, bucket })) as { at: number } | Limit;
    if ("resetAt" in t) throw rateLimited(t.host, t.resetAt, t.guessed);
    const wait = t.at - Date.now();
    if (wait > 0) await Bun.sleep(wait);
  }

  // The rate limit a response tells of, held for every agent and session:
  // a 429's, until the reset it names, else for a back-off from backoff ms;
  // and once a response leaves none of its window, until the window's
  // reset. Answers the 429's hold.
  async limited(host: string, status: number, header: (name: string) => string | null | undefined, bucket?: string, backoff?: number): Promise<Limit | undefined> {
    const reset = resetOf(header);
    if (status === 429) return (await this.invoke("pace", { do: "hold", host, bucket, until: reset, backoff })) as Limit;
    if (reset !== undefined && header("x-rate-limit-remaining") === "0") await this.invoke("pace", { do: "hold", host, bucket, until: reset });
    return undefined;
  }

  // Each tab's answer to its close (close in tools.ts). A site global's tab
  // is its own, of no use once its session ends, even one its calls changed.
  async close(): Promise<unknown[]> {
    const tabs = await Promise.allSettled(this.tabs.values());
    this.tabs.clear();
    // A tab already gone needs no closing, and no new tab to close.
    return Promise.all(tabs.map((t) => (t.status === "fulfilled" ? this.send("close", { tab: t.value, held: true, ended: true }).catch(() => undefined) : undefined)));
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
