// map: one read of each of up to 20 pages, a few at a time. Each page opens
// in a background tab of the caller's agent window, is read, and closes. The
// tab is the caller's meanwhile (open with background), so it still closes
// if the caller exits first. A page that fails is reported in its place and
// the others go on. So is a bot check still up once open has waited on it
// (settledChallenge): nobody watches these tabs to clear one. With wait,
// each page is read once it shows what the wait asks for: a page its script
// draws after it loads reads empty before.

import type { Challenge } from "./challenge.ts";
import { site, WAIT_NEEDS, waitsOnPage } from "./receipt.ts";
import { saveOutput, targetOf, withLimit, type SaveKind, type Target } from "./save.ts";

export const MAP_MAX_URLS = 20;
const AT_ONCE = 4;
const MAX_AT_ONCE = 6;
// omp's MCP client ends a call at 60 s, and on 09-30 a map of six pages
// whose eval ran 31.5 s each, three at once, lost all six there
// (01a0f031). One read alone may take 32 s (eval's 30, and the 2 more the
// daemon waits on the extension), so map answers at 50 s with the pages it
// read and names the rest: the other 10 s carry the answer back.
const BUDGET_MS = 50_000;
export const READS: SaveKind[] = ["extract", "snapshot", "eval", "fetch"];

// A check that stands in for the page leaves nothing to read; one in a box
// on a page that otherwise reads normally is noted beside what was read.
const CHECKED: Record<"page" | "block", string> = {
  page: "a bot check stands in for the page; open it and hand it to the user with handoff, or leave it",
  block: "the site turns the browser away; the user cannot clear that either",
};

type Outcome = ({ ok: true; value: unknown } | { ok: false; error: string }) & { challenge?: Challenge };
// title: the page's as it opened, which an eval or fetch read does not
// carry, where the address may have led to a sign-in or a page not found
export type Page = Outcome & { url: string; title?: string; ms: number; closeError?: string };
type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
// What map does with each page: what it waits for (and how a miss names
// it), the read, its arguments, where to save it.
type Job = { wait?: Record<string, unknown>; waited?: string; read: SaveKind; args: Record<string, unknown>; target?: Target; call: Call };
type Opened = { id: number; url?: string; title?: string; challenge?: Challenge; ok?: boolean; warning?: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A page that failed because the extension answered nothing (bridge.ts),
// and the kind of request it left unanswered.
const UNANSWERED = /extension request (\S+) timed out|extension stuck: .*? none of the last \d+ (\S+) requests/;

function readOf(what: unknown): SaveKind {
  const read = READS.find((r) => r === what);
  if (!read) throw new Error("what must be extract, snapshot, eval, or fetch");
  return read;
}

// What each page must show before it is read, as the wait tool takes it.
function waitOf(wait: unknown): Record<string, unknown> {
  if (!wait || typeof wait !== "object" || Array.isArray(wait)) throw new Error('wait must be an object, as the wait tool takes it: {"text": "…"}');
  if (!waitsOnPage(wait) && !("ms" in wait)) throw new Error(WAIT_NEEDS);
  return { ...wait };
}

// call runs one tool as the caller would (callTool): open, the read, close.
export async function mapPages(a: Record<string, unknown>, call: Call): Promise<{ pages: Page[] }> {
  const { urls, job, atOnce } = jobOf(a, call);
  return { pages: await readAll(urls, job, atOnce, Date.now() + BUDGET_MS) };
}

// map's addresses, what it does with each page, and how many at once.
function jobOf(a: Record<string, unknown>, call: Call): { urls: string[]; job: Job; atOnce: number } {
  const { urls, what = "extract", concurrency = AT_ONCE, save, wait, ...args } = a;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u): u is string => typeof u === "string")) throw new Error('map needs urls: ["https://…", …]');
  if (urls.length > MAP_MAX_URLS) throw new Error(`map reads at most ${MAP_MAX_URLS} pages a call; pass the rest to another`);
  const read = readOf(what);
  if (read === "eval" && typeof args.expression !== "string" && typeof args.reader !== "string") throw new Error("what: eval needs expression, or reader");
  const atOnce = Number(concurrency);
  if (!Number.isFinite(atOnce)) throw new Error("concurrency must be a number");
  return { urls, job: { wait: wait === undefined ? undefined : waitOf(wait), read, args, target: save === undefined || save === false ? undefined : targetOf(save, "folder"), call }, atOnce };
}

// Each of urls read as job says, a few at a time, in their order. Past
// end no page begins; one still being read goes on and closes its tab as
// it ends, and with save writes no file: the answer names it unfinished,
// so its file would be one no answer names.
async function readAll(urls: string[], job: Job, atOnce: number, end: number): Promise<Page[]> {
  const pages: Page[] = [];
  const began: number[] = [];
  // The pages' files being written, which the answer waits on.
  const writing: Promise<void>[] = [];
  let next = 0;
  let over = Date.now() >= end;
  const worker = async () => {
    for (let i = next++; i < urls.length && !over; i = next++) {
      began[i] = performance.now();
      const visited = await visit(urls[i], job);
      if (over) return;
      if (typeof visited === "function") {
        const written = visited().then((page) => {
          pages[i] = page;
        });
        writing.push(written);
        await written;
      } else pages[i] = visited;
    }
  };
  const { promise: late, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    over = true;
    resolve();
  }, Math.max(0, end - Date.now()));
  await Promise.race([Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(atOnce)), MAX_AT_ONCE, urls.length) }, worker)), late]);
  clearTimeout(timer);
  await Promise.all(writing);
  const answered = urls.map((url, i) => pages[i] ?? unfinished(url, began[i]));
  // An extension that answers nothing fails each page alike, and a list of
  // failed pages read as a map that worked: on 10-13 two maps took 30 s
  // each and answered every page "extension request tabs.list timed out".
  const unanswered = answered.map((p) => (p.ok ? null : UNANSWERED.exec(p.error)));
  const [first] = unanswered;
  if (first && unanswered.every(Boolean)) throw new Error(`extension stuck: the Safari extension answered none of map's ${urls.length} pages (its ${first[1] ?? first[2]} requests went unanswered); map again in a minute, and if it fails the same way, tell the user Safari is not answering`);
  return answered;
}

// follow reads each of urls as a listing (search results, a category):
// the links on it to its own site that match, each once and max in all,
// then those pages as map reads its urls, each listing's under it. In the
// two weeks of logs before 10-19 an agent copied a map's addresses out of
// the answer before into its next call 165 times, 153 of them a listing's.
export type Listing = { url: string; title?: string; ms: number; closeError?: string } & ({ ok: true; items: Page[]; unread?: number } | { ok: false; error: string; challenge?: Challenge });

export async function followPages(a: Record<string, unknown>, call: Call): Promise<{ pages: Listing[] }> {
  const { follow, ...rest } = a;
  const { match, max } = followOf(follow);
  const { urls, job, atOnce } = jobOf(rest, call);
  const end = Date.now() + BUDGET_MS;
  // A selector is waited for, as a page's script may draw the list after
  // it loads; a regex reads the links there are once the page has loaded.
  const listed = await readAll(urls, { ...(typeof match === "string" ? { wait: { selector: match } } : {}), waited: `a link matching ${String(match)}`, read: "eval", args: { expression: linksIn(match) }, call }, atOnce, end);
  const seen = new Set(urls);
  let left = max;
  const found = listed.map((page) => {
    const links: string[] = [];
    let matched = 0;
    let unread = 0;
    const home = site(URL.parse(page.url)?.hostname ?? "");
    for (const href of page.ok ? hrefsOf(page.value) : []) {
      const link = URL.parse(href);
      if (!link || !/^https?:$/.test(link.protocol) || site(link.hostname) !== home) continue;
      link.hash = "";
      if (typeof match !== "string" && !match.test(link.href)) continue;
      matched++;
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      if (left > 0) {
        links.push(link.href);
        left--;
      } else unread++;
    }
    return { page, links, matched, unread };
  });
  const items = await readAll(found.flatMap((f) => f.links), job, atOnce, end);
  let at = 0;
  return {
    pages: found.map(({ page, links, matched, unread }): Listing => {
      if (!page.ok) return page;
      const about = { url: page.url, ...(page.title ? { title: page.title } : {}), ms: page.ms, ...(page.closeError === undefined ? {} : { closeError: page.closeError }) };
      if (matched === 0) return { ...about, ok: false, error: `no link on it to its own site matched ${String(match)}` };
      return { ...about, ok: true, items: items.slice(at, (at += links.length)), ...(unread ? { unread } : {}) };
    }),
  };
}

function followOf(follow: unknown): { match: string | RegExp; max: number } {
  const usage = `follow must be {"match": "a CSS selector, or /regex/ on the link's address", "max": 1 to ${MAP_MAX_URLS}}`;
  if (!follow || typeof follow !== "object" || Array.isArray(follow)) throw new Error(usage);
  const { match, max = MAP_MAX_URLS } = follow as Record<string, unknown>;
  if (typeof match !== "string" || match.trim() === "" || typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAP_MAX_URLS) throw new Error(usage);
  const regex = /^\/(.+)\/([a-z]*)$/.exec(match);
  if (!regex) return { match, max };
  try {
    // g and y would make test() start where the last match ended
    return { match: new RegExp(regex[1], regex[2].replace(/[gy]/g, "")), max };
  } catch (e) {
    throw new Error(`follow's match ${match} is not a regex: ${messageOf(e)}`);
  }
}

// The links a listing shows, in its order: each element the selector
// matches, its own link or the first inside it (a card); every link for
// a regex, which followPages tests.
function linksIn(match: string | RegExp): string {
  return typeof match === "string"
    ? `sh.qa(${JSON.stringify(match)}).map((e) => (e.closest("a[href]") ?? e.querySelector("a[href]"))?.href).filter(Boolean)`
    : `sh.qa("a[href]").map((a) => a.href)`;
}

// eval answers {result}; a page's script may make it anything.
function hrefsOf(value: unknown): string[] {
  const result = value && typeof value === "object" && "result" in value ? value.result : undefined;
  return Array.isArray(result) ? result.filter((h): h is string => typeof h === "string") : [];
}

// A page map answered without: still being read, or not begun.
function unfinished(url: string, began: number | undefined): Page {
  const ms = began === undefined ? 0 : Math.round(performance.now() - began);
  return { ok: false, error: `unfinished when map's ${BUDGET_MS / 1000} s ran out; map it again, in a call with fewer pages`, url, ms };
}

// One page, start to end; it answers for every failure, its tab's close
// included, so one page never takes the others down with it. With save it
// answers with the write that makes the page instead, which mapPages runs
// only while its answer may still hold the page.
async function visit(url: string, job: Job): Promise<Page | (() => Promise<Page>)> {
  const started = performance.now();
  let opened: Opened | undefined;
  let outcome: Outcome;
  try {
    // open answers {id, url, title, challenge?, ok?, warning?} or throws; callTool types every answer unknown
    opened = (await job.call("open", { url, background: true })) as Opened;
    outcome = await readTab(opened, url, job);
  } catch (e) {
    outcome = { ok: false, error: messageOf(e) };
  }
  const ms = Math.round(performance.now() - started);
  const tab = opened?.id;
  const closeError = tab === undefined ? undefined : await job.call("close", { tab }).then(() => undefined, messageOf);
  const about = { url, ...(opened?.title ? { title: opened.title } : {}), ms, ...(closeError === undefined ? {} : { closeError }) };
  const { read, target } = job;
  if (!target || !outcome.ok) return { ...outcome, ...about };
  const done = outcome;
  const at = opened?.url ?? url;
  return () => saveOutput(read, done.value, target, async () => at).then(
    (saved): Page => ({ ...done, value: saved, ...about }),
    (e: unknown): Page => ({ ok: false, error: messageOf(e), ...about }),
  );
}

async function readTab(opened: Opened, url: string, { wait, waited, read, args, target, call }: Job): Promise<Outcome> {
  const check = opened.challenge;
  if (check && check.where !== "box") return { ok: false, error: CHECKED[check.where], challenge: check };
  // open answers a site's error page (its guide's error-titles) as not ok,
  // with a warning: the page holds nothing to read. On 10-16 a hunt's eBay
  // searches answered "Error Page | eBay", read as no listings (HuntsUsage).
  if (opened.ok === false && opened.warning) return { ok: false, error: opened.warning };
  if (wait) {
    const missed = missOf(await call("wait", { ...wait, tab: opened.id }), waited);
    if (missed) return check ? { ...missed, challenge: check } : missed;
  }
  // fetch asks again for the address the tab opened, with its cookies: the
  // body as the server sends it, where the others read the page it drew.
  const value = await call(read, { ...(target ? withLimit(read, args) : args), tab: opened.id, ...(read === "fetch" ? { url } : {}) });
  // A page can answer with an error instead of output (extract's selector
  // matches nothing): it read nothing, so it failed like a page that threw.
  const outcome: Outcome = pageError(value) ?? { ok: true, value };
  return check ? { ...outcome, challenge: check } : outcome;
}

function pageError(value: unknown): { ok: false; error: string } | undefined {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? { ok: false, error: value.error } : undefined;
}

// A page that never showed what the wait asked for is most often another
// page (a redirect, a page not found): the address and title say which. A
// page that gave the wait no answer in time (unanswered, a loaded Safari)
// may show it all the same.
function missOf(seen: unknown, waited = "what wait asked for"): { ok: false; error: string } | undefined {
  if (!seen || typeof seen !== "object" || !("found" in seen) || seen.found !== false) return undefined;
  if ("unanswered" in seen && seen.unanswered === true) return { ok: false, error: `it gave the wait no answer in time (Safari or the page was slow), so whether it shows ${waited} is not known: map it again` };
  const at = "url" in seen && typeof seen.url === "string" ? seen.url : "an address Safari did not give";
  const title = "title" in seen && typeof seen.title === "string" && seen.title !== "" ? ` ("${seen.title}")` : "";
  return { ok: false, error: `it did not show ${waited}; the tab is at ${at}${title}` };
}
