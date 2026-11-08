// Plumbing shared by the REPL's site globals (slack, gmail, notion, ...).
// Each site works through a background tab of its own on that site, opened
// on first use (and again, once, if it is gone) and closed with the REPL
// session, so its requests carry the owner's Safari session the way the
// site's own page would, and no tab the owner is using is touched. Anything
// that sends or posts goes through draftOrSend: it returns the exact draft
// until the owner approves that draft.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { Invoke } from "../call.ts";
import { HarnessError, rateLimited } from "../failures.ts";
import type { Limit } from "../pace.ts";

export class NotSignedIn extends Error {
  constructor(readonly site: string, detail = "") {
    super(`not signed in to ${site} in Safari${detail ? ` (${detail})` : ""}; sign in there, then try again`);
    this.name = "NotSignedIn";
  }
}

// read: the request only reads, so it may run twice (eval's read below).
export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number; read?: boolean };
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
// The daemon's answer when a kit tab that closed at its agent's turn end is
// opened again for the next call (tools.ts reopen): the call did not run,
// and the new tab holds the kit's own parked page. On 11-04 every first
// Slack call of a turn failed this way.
export const FRESH = /; it is open again on \S+, loaded fresh as tab (\d+), so its refs/;

// The action of the approved send running now (draftOrSend). A request of
// it whose tab vanished may have reached the site before the tab went: the
// extension says "that tab is gone" after dispatch too (background.js), so
// it is not sent again (SiteKit.call): the kit once posted a Slack message
// twice so (audit SH-24).
const sending = new AsyncLocalStorage<string>();

export class SiteKit {
  private tabs = new Map<string, Promise<number>>();
  // Where each origin's tab opens: the address its site last asked for.
  private homes = new Map<string, string>();
  // The origin of every tab the kit opened, gone ones included.
  private origins = new Map<number, string>();
  // Tool calls for the sites. A call on a kit tab that is gone runs once
  // more in the tab that takes its place, unless it is part of an approved
  // send; gone again, the error stands.
  readonly invoke: Invoke;
  // The REPL run the session is in (repl.ts): a draft cannot be approved in
  // the run that made it (draftOrSend).
  run = 0;
  // The drafts this session showed, by draftId (draftOrSend): a hash of what
  // it would send, the run that made it, when, and whether it was approved.
  readonly drafts = new Map<string, { payload: string; run: number; at: number; used?: true }>();

  // owned is told about each tab opened, so the REPL can close it with the
  // session even if close() is never reached. cwd is the session's folder,
  // where a relative path a site saves a file at begins, as with its fs.
  constructor(private send: Invoke, private owned: (tab: number) => void = () => {}, readonly cwd = process.cwd()) {
    this.invoke = (tool, args) => this.call(tool, args);
  }

  private async call(tool: string, args: Record<string, unknown>, onReopen?: (tab: number) => void): Promise<unknown> {
    try {
      return await this.send(tool, args);
    } catch (e) {
      const gone = Number(args.tab);
      const origin = this.origins.get(gone);
      if (origin === undefined || !(e instanceof Error)) throw e;
      const fresh = FRESH.exec(e.message);
      if (fresh) {
        const tab = Number(fresh[1]);
        this.origins.set(tab, origin);
        this.owned(tab);
        if (this.tabs.has(origin)) this.tabs.set(origin, Promise.resolve(tab));
        onReopen?.(tab);
        return this.send(tool, { ...args, tab });
      }
      if (!GONE.test(e.message)) throw e;
      const action = sending.getStore();
      if (action !== undefined) throw new HarnessError("effect_unknown", `${action}: the ${origin} tab closed while its ${tool} was out (${e.message}), so it may have gone through; it was not sent again`, { next: `check ${origin} for it before sending again, which takes a new draft` });
      const tab = await this.reopen(origin, gone);
      onReopen?.(tab);
      return this.send(tool, { ...args, tab });
    }
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
    return (await this.invoke("fetch", { tab, url, method: init.method, headers: init.headers, body: init.body, maxBytes: init.maxBytes ?? 20_000_000, ...(init.read ? { read: true } : {}) })) as FetchResult;
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
  // says it can safely run twice. The daemon then holds no retry when its
  // answer is lost (lanes.ts): on 11-04 a Slack read that lost its answer
  // blocked the same read for four calls (MineSessionD-7). And when the
  // page did not answer, the held tab is closed and the expression asked
  // once more in a new tab where the site asked; not answering again, the
  // error stands.
  async eval<T = unknown>(origin: string, expression: string, opts: { page?: boolean; read?: boolean } = {}): Promise<T> {
    let tab = await this.tab(origin);
    const args = { tab, expression, page: !!opts.page, ...(opts.read ? { read: true } : {}) };
    const r = (await this.call("eval", args, (reopened) => { tab = reopened; }).catch(async (e: unknown) => {
      if (!opts.read || !(e instanceof Error && HELD.test(e.message))) throw e;
      await this.send("close", { tab });
      return this.invoke("eval", { ...args, tab: await this.reopen(origin, tab) });
    })) as { result?: T };
    return r.result as T;
  }

  // Waits for host's turn, gap ms after the request before it from any
  // agent or session (pace.ts); bucket names the one of host's limits the
  // request falls under. A host still rate-limited past a short wait fails
  // at once with rate_limited. With within, a turn further off than that
  // is not taken and the answer is false, at once.
  async turn(host: string, gap: number, bucket?: string, within?: number): Promise<boolean> {
    const t = (await this.invoke("pace", { host, gap, bucket, ...(within === undefined ? {} : { within }) })) as { at: number; taken?: false } | Limit;
    if ("resetAt" in t) throw rateLimited(t.host, t.resetAt, t.guessed);
    if (t.taken === false) return false;
    const wait = t.at - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    return true;
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

export type Draft = { status: "draft"; draftId: string; site: string; action: string; from?: string; to?: string; text: string; note: string };
export type Sent<T> = { status: "sent"; draftId: string; site: string; action: string; from?: string; to?: string; result: T };

// How long a draft can be approved, as long as a REPL session lasts unused.
const DRAFT_MS = 30 * 60_000;

// Anything that sends, posts, or changes the owner's account: without
// approved it sends nothing and returns the exact draft for the owner to
// read, with its draftId. Called again in a later run, with the same
// arguments and approved: that draftId, after they say yes, it sends, once.
// Approval was a flag the model set itself (approved: true): scripts
// drafted and sent in one run, and a draft of one text to one channel let
// another text go to another (audit SH-21, E-10). from names the account
// it goes out as; bind, what else the send depends on (a file's bytes), so
// that a change to either is a new draft.
export async function draftOrSend<T>(kit: SiteKit, opts: { site: string; action: string; from?: string; to?: string; text: string; bind?: string; approved?: string | boolean; send: () => Promise<T> }): Promise<Draft | Sent<T>> {
  const { site, action, from, to, text } = opts;
  const shown = { site, action, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
  const payload = createHash("sha256").update(JSON.stringify([site, action, from, to, text, opts.bind])).digest("hex");
  const now = Date.now();
  for (const [id, d] of kit.drafts) if (now - d.at > DRAFT_MS) kit.drafts.delete(id);
  if (opts.approved === undefined || opts.approved === false) {
    const draftId = randomBytes(6).toString("hex");
    kit.drafts.set(draftId, { payload, run: kit.run, at: now });
    return { status: "draft", draftId, ...shown, text, note: `nothing was sent; show the owner this exact draft, and only after they approve it call again, in a later call, with the same arguments and { approved: "${draftId}" }` };
  }
  const refused = (why: string) => new HarnessError("invalid_argument", `nothing was sent: ${why}`, { retryable: false, next: "show the owner the draft and wait for their yes before approving it" });
  const id = opts.approved;
  if (typeof id !== "string") throw refused("approved takes the draftId of the draft the owner approved; call without approved for the draft");
  const d = kit.drafts.get(id);
  if (!d) throw refused(`no draft ${id} in this REPL session (a draft lasts ${DRAFT_MS / 60_000} min in the session that made it); draft it again`);
  if (d.used) throw refused(`draft ${id} was approved once already, and a draft sends once; draft again for another send`);
  if (d.payload !== payload) throw refused(`this ${action} is not draft ${id}: its text, recipient, sender, or file differs; draft it again`);
  if (d.run === kit.run) throw refused(`draft ${id} was made in this same run, so the owner has not seen it; approve it in a later call`);
  d.used = true;
  return { status: "sent", draftId: id, ...shown, result: await sending.run(action, opts.send) };
}
