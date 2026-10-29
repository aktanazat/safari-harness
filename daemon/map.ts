// map: one read of each of up to 20 pages, a few at a time. Each of its
// readers opens a background tab of the caller's agent window, loads the
// pages it reads into it one after another, and closes it as map ends. The
// tabs are the caller's meanwhile (open with background), so they still
// close if the caller exits first. A page that fails is reported in its
// place and the others go on. So is a bot check still up once open has
// waited on it (settledChallenge): nobody watches these tabs to clear one.
// With wait, each page is read once it shows what the wait asks for: a
// page its script draws after it loads reads empty before. A page the task
// read in the last 10 minutes, or one on a site that showed it a check, is
// answered from that (reads.ts) unless fresh.

import type { Challenge } from "./challenge.ts";
import { site, WAIT_NEEDS, waitsOnPage } from "./receipt.ts";
import { saveOutput, SAVED_DIR, targetOf, withLimit, writeIndex, type SaveKind, type Target } from "./save.ts";
import { failureOf, HarnessError, readFailure, type Failure } from "./failures.ts";
import { affectsPage } from "./lanes.ts";
import { partialRead, type PageState } from "./page-state.ts";
import { checked, keep, recall } from "./reads.ts";

export const MAP_MAX_URLS = 20;
const AT_ONCE = 6;
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
// "or leave it" here was read as leave it: 28 of 48 runs that met a check
// in October never opened the page (harness-audit), and on 10-23 the
// Lancet's check that stood through map's 9 s let a tab opened later in.
const CHECKED: Record<"page" | "block", string> = {
  page: "a bot check stands in for the page; open it in a tab and wait a few seconds, since many checks clear on their own in Safari; if it remains, use another permitted source or report that the page is unavailable",
  block: "the site turns the browser away; the user cannot clear that either",
};

// A site's error page in place of the page (open's warning) is often only
// a burst's answer: in the October hunts eBay answered searches with "Error
// Page | eBay", the same address loaded when opened again, and two agents
// wrote loops of their own to ask again (AkylHunts AH4). map loads it again
// after each of these.
const RETRY_MS = [2000, 5000];

// Google and Bing answer a burst of searches with a check: on 10-22 a map of
// four Google searches met four reCAPTCHA pages (K12). Their results pages
// load one at a time, SEARCH_GAP_MS apart, across every map the daemon
// runs, as the Google kit's searches do (sites/google-search.ts).
const SEARCH_GAP_MS = 3000;
const SEARCH = /^(?:www\.)?(?:google\.[a-z]{2,3}(?:\.[a-z]{2})?|bing\.com)$/;
let searchAt = 0;

// The start of the error a page gets that never showed what its wait asked.
const MISSED = "it did not show";

// With follow, wait holds each page followed, as it holds map's pages; a
// listing waits for follow's match. In a shopping task on 10-22 three maps
// waited for a listing's heading on every page they followed, and each ran
// out its 50 s (SR-1).
const FOLLOWED_WAIT = "wait holds each page followed, not the listing, and none of them showed it; a listing waits for follow's match, when it is a CSS selector";

type Outcome = ({ ok: true; value: unknown } | { ok: false; error: string; failure?: Failure; value?: unknown }) & { challenge?: Challenge };
// title: the page's as it opened, which an eval or fetch read does not
// carry, where the address may have led to a sign-in or a page not found;
// finalUrl: where it opened, when not at url; retried: how many times it
// was loaded again after its site's error page; from: whose read of this
// task's it is (reads.ts). A failed page's value is what an error page read.
export type Page = Outcome & { url: string; finalUrl?: string; title?: string; ms: number; closeError?: string; retried?: number; from?: string };
type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
// What map does with each page: what it waits for (and how a miss names
// it), the read, its arguments, where to save it, whether to load it
// whatever this task has read or met, and the key its reads are kept by.
type Job = { wait?: Record<string, unknown>; waited?: string; read: SaveKind; args: Record<string, unknown>; target?: Target; fresh?: boolean; key?: string; readOnly?: true; call: Call };
type Opened = { id?: number; url?: string; title?: string; challenge?: Challenge; ok?: boolean; warning?: string; file?: string; note?: string };
// What map answers: its pages; the addresses it did not read (past follow's
// max, or past its 50 s), for the next map; the folder's index.json.
export type MapAnswer = { pages: (Page | Listing)[]; urls?: string[]; index?: string; note?: string };
// A reader's tab (readAll): the address of the page it shows, as map last
// read it, and that page, which a close that fails is told on.
type Warm = { tab?: number; at?: string; last?: Page };
// A page as visit read it: dropped by a link that came back, or stalled.
type Visit = { page: Page; disconnected?: boolean; stalled?: boolean };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A page that failed because the extension answered nothing (bridge.ts),
// and the kind of request it left unanswered.
const UNANSWERED = /extension request (\S+) timed out|extension stuck: .*? none of the last \d+ (\S+) requests/;

const DISCONNECTED = /^(?:the Safari extension (?:disconnected|restarted) before it answered\b|Safari was not running: it is starting in the background, and its extension did not connect within \d+ s; try again$)/;

// A page that answered nothing in time: a dialog or a load held it, or
// Safari was loaded. Read again after the others it often answers: on
// 10-29 os.html, the longest of 20 python docs pages map read four at a
// time, did not answer in 10 s (baseline).
const STALLED = /^(?:the page (?:at \S+ )?did not answer\b|Safari did not answer \S+ in time\b|it gave the wait no answer in time\b)/;

// A close the link dropped is asked again, each ask waiting for the
// extension to connect again (bridge.ts): of the 61 map pages answered
// "not closed" in the 10-29 audit, 48 had met a dropped link.
const CLOSE_TRIES = 3;

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

// call runs one tool as the caller would (callTool): open, goto, the read,
// close.
export async function mapPages(a: Record<string, unknown>, call: Call): Promise<MapAnswer> {
  const { urls, job, atOnce } = jobOf(a, call);
  const end = Date.now() + BUDGET_MS;
  const tabs: Warm[] = [];
  const { pages, left } = await readAll(urls, job, atOnce, end, tabs);
  await closeAll(tabs, call, end);
  return { pages, ...(left.length ? { urls: left } : {}), ...(await indexed(job.target, pages)) };
}

// map's addresses, what it does with each page, and how many at once.
function jobOf(a: Record<string, unknown>, call: Call): { urls: string[]; job: Job; atOnce: number } {
  const { urls, what = "extract", concurrency = AT_ONCE, save, wait, fresh, ...args } = a;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u): u is string => typeof u === "string")) throw new Error('map needs urls: ["https://…", …]');
  if (urls.length > MAP_MAX_URLS) throw new Error(`map reads at most ${MAP_MAX_URLS} pages a call; pass the rest to another`);
  const read = readOf(what);
  if (read === "eval" && typeof args.expression !== "string" && typeof args.reader !== "string" && typeof args.file !== "string") throw new Error("what: eval needs expression, reader, or file");
  const atOnce = Number(concurrency);
  if (!Number.isFinite(atOnce)) throw new Error("concurrency must be a number");
  const target = save === undefined || save === false ? undefined : targetOf(save, "folder");
  const waits = wait === undefined ? undefined : waitOf(wait);
  // This task's reads are kept (reads.ts) by the read, its arguments as the
  // page is asked them, and the wait. eval, whose page may change as it
  // runs, and a fetch that changes something are not kept.
  const key = affectsPage(read, args) ? undefined : JSON.stringify([read, Object.entries(target ? withLimit(read, args) : args).sort(), waits ? Object.entries(waits).sort() : null]);
  return { urls, job: { wait: waits, read, args, target, fresh: fresh === true, key, call }, atOnce };
}

// Each of urls read as job says, a few at a time, in their order, by
// readers that each take a tab of tabs and give it back as they end. Past
// end no page begins; one still being read goes on and closes its tab as
// it ends, and with save writes no file: the answer names it unfinished,
// so its file would be one no answer names. A page that stalled is read
// once more after the others. left: the pages it did not read that map
// may load again.
async function readAll(urls: string[], job: Job, atOnce: number, end: number, tabs: Warm[]): Promise<{ pages: Page[]; left: string[] }> {
  const pages: Page[] = [];
  const began: number[] = [];
  const disconnected: boolean[] = [];
  const stalled: boolean[] = [];
  const effectful = job.readOnly !== true && affectsPage(job.read, job.args);
  // The pages' files being written, which the answer waits on.
  const writing: Promise<void>[] = [];
  const queue = urls.map((_, i) => i);
  let over = Date.now() >= end;
  const read = async (warm: Warm) => {
    for (let i = queue.shift(); i !== undefined && !over; i = queue.shift()) {
      let known = recalled(urls[i], job);
      const gap = known ? 0 : searchGap(urls[i]);
      if (gap) {
        await Bun.sleep(gap);
        // the search before it may have met a check meanwhile
        known = recalled(urls[i], job);
      }
      if (over) return;
      began[i] = performance.now();
      let result: Visit = known ? { page: known } : await visit(urls[i], job, warm);
      for (let retry = 0; result.disconnected && !effectful && !over; retry++) {
        const pause = Math.max(RETRY_MS[Math.min(retry, RETRY_MS.length - 1)], searchGap(urls[i]));
        if (Date.now() + pause >= end) break;
        await Bun.sleep(pause);
        if (over || Date.now() >= end) return;
        known = recalled(urls[i], job);
        result = known ? { page: known } : await visit(urls[i], job, warm, true);
      }
      if (over) return;
      const { page } = result;
      page.ms = Math.round(performance.now() - began[i]);
      disconnected[i] = result.disconnected === true;
      const again = result.stalled === true && !stalled[i];
      stalled[i] = result.stalled === true;
      if (again) {
        pages[i] = page;
        queue.push(i);
        continue;
      }
      const { target } = job;
      if (target && page.value !== undefined) {
        const written = savePage(page, job, target).then((saved) => {
          pages[i] = saved;
          if (warm.last === page) warm.last = saved;
        });
        writing.push(written);
        await written;
      } else pages[i] = page;
    }
  };
  const worker = async () => {
    const warm = tabs.pop() ?? {};
    await read(warm);
    // past end map has answered, so the tab closes now
    if (over) void shut(warm, job.call);
    else tabs.push(warm);
  };
  const { promise: late, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    over = true;
    resolve();
  }, Math.max(0, end - Date.now()));
  await Promise.race([Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(atOnce)), MAX_AT_ONCE, urls.length) }, worker)), late]);
  clearTimeout(timer);
  await Promise.all(writing);
  const answered = urls.map((url, i) => pages[i] ?? unfinished(url, began[i], began[i] !== undefined && effectful));
  // An extension that answers nothing fails each page alike, and a list of
  // failed pages read as a map that worked: on 10-13 two maps took 30 s
  // each and answered every page "extension request tabs.list timed out".
  const unanswered = answered.map((p) => (p.ok ? null : UNANSWERED.exec(p.error)));
  const [first] = unanswered;
  if (first && unanswered.every(Boolean)) throw new Error(`extension stuck: the Safari extension answered none of map's ${urls.length} pages (its ${first[1] ?? first[2]} requests went unanswered); map again in a minute, and if it fails the same way, tell the user Safari is not answering`);
  return { pages: answered, left: urls.filter((_, i) => (pages[i] === undefined && began[i] === undefined) || (!effectful && (pages[i] === undefined || disconnected[i] || stalled[i]))) };
}

// How long url waits for its turn to load: a search engine's results page
// takes the next turn of every map's, the others none.
function searchGap(url: string): number {
  const u = URL.parse(url);
  if (!u || !SEARCH.test(u.hostname) || u.pathname !== "/search") return 0;
  const now = Date.now();
  const at = Math.max(now, searchAt);
  searchAt = at + SEARCH_GAP_MS;
  return at - now;
}

// follow reads each of urls as a listing (search results, a category):
// the links on it to its own site that match, each once and max in all,
// then those pages as map reads its urls, each listing's under it. In the
// two weeks of logs before 10-19 an agent copied a map's addresses out of
// the answer before into its next call 165 times, 153 of them a listing's.
// While max wants more links, a listing's next page (linksIn) is read as
// one too; next: the one max or map's 50 s left unread. The links past
// max, and those the 50 s left unread, come back as urls.
export type Listing = { url: string; title?: string; ms: number; closeError?: string } & ({ ok: true; items: Page[]; unread?: number; next?: string } | { ok: false; error: string; challenge?: Challenge });

export async function followPages(a: Record<string, unknown>, call: Call): Promise<MapAnswer> {
  const { follow, ...rest } = a;
  const { match, max } = followOf(follow);
  const { urls, job, atOnce } = jobOf(rest, call);
  const end = Date.now() + BUDGET_MS;
  const tabs: Warm[] = [];
  // A selector is waited for, as a page's script may draw the list after
  // it loads; a regex reads the links there are once the page has loaded.
  const listing: Job = { ...(typeof match === "string" ? { wait: { selector: match } } : {}), waited: `a link matching ${String(match)}`, read: "eval", args: { expression: linksIn(match) }, readOnly: true, fresh: job.fresh, call };
  const seen = new Set(urls);
  const past: string[] = [];
  let left = max;
  const found = urls.map(() => ({ pages: [] as Page[], links: [] as string[], matched: 0, unread: 0, next: undefined as string | undefined }));
  let listedLeft: string[] | undefined;
  let wave = urls.map((url, i) => ({ url, i }));
  while (wave.length > 0) {
    const listed = await readAll(wave.map((w) => w.url), listing, atOnce, end, tabs);
    listedLeft ??= listed.left;
    const onward: { url: string; i: number }[] = [];
    wave.forEach(({ i }, k) => {
      const page = listed.pages[k];
      const f = found[i];
      f.pages.push(page);
      // a later page unread stays its listing's next
      f.next = !page.ok && f.pages.length > 1 ? page.url : undefined;
      if (!page.ok) return;
      const home = site(URL.parse(page.url)?.hostname ?? "");
      const { links, next } = listedOf(page.value);
      const before = f.matched;
      for (const href of links) {
        const link = URL.parse(href);
        if (!link || !/^https?:$/.test(link.protocol) || site(link.hostname) !== home) continue;
        link.hash = "";
        if (typeof match !== "string" && !match.test(link.href)) continue;
        f.matched++;
        if (seen.has(link.href)) continue;
        seen.add(link.href);
        if (left > 0) {
          f.links.push(link.href);
          left--;
        } else {
          f.unread++;
          past.push(link.href);
        }
      }
      const onto = next === undefined || f.matched === before ? null : URL.parse(next);
      if (!onto || !/^https?:$/.test(onto.protocol) || site(onto.hostname) !== home) return;
      onto.hash = "";
      if (seen.has(onto.href)) return;
      seen.add(onto.href);
      f.next = onto.href;
      onward.push({ url: onto.href, i });
    });
    wave = left > 0 ? onward : [];
  }
  const items = await readAll(found.flatMap((f) => f.links), job, atOnce, end, tabs);
  await closeAll(tabs, call, end);
  let at = 0;
  const pages = found.map(({ pages: [page, ...later], links, matched, unread, next }): Listing => {
    if (!page.ok) return page;
    const closeError = [page, ...later].find((p) => p.closeError !== undefined)?.closeError;
    const about = { url: page.url, ...(page.title ? { title: page.title } : {}), ms: [page, ...later].reduce((ms, p) => ms + p.ms, 0), ...(closeError === undefined ? {} : { closeError }) };
    if (matched === 0) return { ...about, ok: false, error: `no link on it to its own site matched ${String(match)}` };
    return { ...about, ok: true, items: items.pages.slice(at, (at += links.length)), ...(unread ? { unread } : {}), ...(next ? { next } : {}) };
  });
  const unreadUrls = [...(listedLeft ?? []), ...items.left, ...past];
  const nexts = found.flatMap((f) => (f.next === undefined ? [] : [f.next]));
  const { index, note } = await indexed(job.target, items.pages);
  const missed = job.wait !== undefined && items.pages.length > 0 && items.pages.every((p) => !p.ok && p.error.startsWith(MISSED));
  const notes = [...(missed ? [FOLLOWED_WAIT] : []), ...(nexts.length ? [`${nexts.length === 1 ? "a listing's next page" : "listings' next pages"} not read: map ${JSON.stringify({ urls: nexts })} with the same follow to go on`] : []), ...(note ? [note] : [])];
  return { pages, ...(unreadUrls.length ? { urls: unreadUrls } : {}), ...(index ? { index } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) };
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

// What a listing shows, in its order. links: each element the selector
// matches, its own link or the first inside it (a card); every link for a
// regex, which followPages tests. next: its next page, the link marked
// rel=next, else the first that says next (its text, label, or class) in
// the nearest box around the first match that holds one, as a category
// lists its subcategories' next page and its pages' apart (Wikipedia). On
// 10-29 a category of 1,019 members over 6 pages read 20, and nothing told
// of its other 5 (completeness).
function linksIn(match: string | RegExp): string {
  const links = typeof match === "string"
    ? `sh.qa(${JSON.stringify(match)}).map((e) => (e.closest("a[href]") ?? e.querySelector("a[href]"))?.href).filter(Boolean)`
    : `sh.qa("a[href]").map((a) => a.href)`;
  return `({ links: ${links}, next: (${NEXT_PAGE})(${typeof match === "string" ? `sh.q(${JSON.stringify(match)})` : "null"}) })`;
}

const NEXT_PAGE = String.raw`(first) => {
  const usable = (a) => /^https?:/.test(a.href) && a.href.split("#")[0] !== location.href.split("#")[0] && a.getAttribute("aria-disabled") !== "true";
  const says = (a) => /^(?:next(?: page)?|[›»→])(?:\s*[›»→>])?$/i.test(a.textContent.trim()) || /\bnext\b/i.test(a.getAttribute("aria-label") ?? "") || /(?:^|[\s_-])next(?:$|[\s_-])/i.test(a.getAttribute("class") ?? "");
  const marked = [...document.querySelectorAll("link[rel~=next][href], a[rel~=next][href]")].find(usable);
  if (marked) return marked.href;
  for (let box = first?.parentElement; box; box = box.parentElement) {
    const near = [...box.querySelectorAll("a[href]")].find((a) => usable(a) && says(a));
    if (near) return near.href;
  }
  return [...document.querySelectorAll("a[href]")].find((a) => usable(a) && says(a))?.href ?? null;
}`;

// eval answers {result}; a page's script may make it anything.
function listedOf(value: unknown): { links: string[]; next?: string } {
  const result = value && typeof value === "object" && "result" in value ? value.result : undefined;
  if (!result || typeof result !== "object") return { links: [] };
  const links = "links" in result && Array.isArray(result.links) ? result.links.filter((h): h is string => typeof h === "string") : [];
  return "next" in result && typeof result.next === "string" ? { links, next: result.next } : { links };
}

// A page map answered without: still being read, or not begun.
function unfinished(url: string, began: number | undefined, effectful: boolean): Page {
  const ms = began === undefined ? 0 : Math.round(performance.now() - began);
  const error = `unfinished when map's ${BUDGET_MS / 1000} s ran out; ${effectful ? "the action result is unknown; read the page before deciding whether to repeat it" : "map it again, in a call with fewer pages"}`;
  return { ok: false, error, failure: failureOf(new HarnessError("timeout", error, { effect: effectful ? "possibly_effected" : "none" })), url, ms };
}

// A read of a page that read as content, with no check on it, which the
// task may be answered with again.
function keeps(page: Page): boolean {
  if (!page.ok || page.challenge) return false;
  const state = page.value && typeof page.value === "object" && "pageState" in page.value ? (page.value.pageState as PageState | undefined) : undefined;
  return state === undefined || state.kind === "content" || state.kind === "unjudged";
}

// The page as this task met it in the last 10 minutes (reads.ts): read as
// job reads it, or on a site that showed it a check. fresh loads it all
// the same.
function recalled(url: string, job: Job): Page | undefined {
  if (job.fresh) return undefined;
  const kept = job.key === undefined ? undefined : recall(job.key, url);
  if (kept) return { ...(kept.value as { ok: true; value: unknown; title?: string; finalUrl?: string }), url, ms: 0, from: kept.from };
  const check = checked(url);
  if (!check) return undefined;
  return { ok: false, error: check.error, failure: failureOf(new HarnessError("blocked", check.error, { next: check.error })), challenge: check.challenge, url, ms: 0 };
}

// One page, start to end, in warm's tab (load); it answers for every
// failure, so one page never takes the others down with it. A page that
// opens as its site's error page is loaded again after each of RETRY_MS.
// One that threw leaves its tab in a state not known, so the tab closes;
// a read of the page the tab showed before is that page's, not url's, so
// url loads again in a new tab.
async function visit(url: string, job: Job, warm: Warm, recovering = false): Promise<Visit> {
  const started = performance.now();
  const effectful = job.readOnly !== true && affectsPage(job.read, job.args);
  let opened: Opened | undefined;
  let outcome: Outcome;
  let retried = 0;
  let disconnected = false;
  let closeError: string | undefined;
  try {
    // open and goto answer {id, url, title, challenge?, ok?, warning?, file?} or throw; callTool types every answer unknown
    opened = await load(url, job, warm);
    while (opened.ok === false && opened.warning && !opened.file && retried < RETRY_MS.length) {
      await Bun.sleep(RETRY_MS[retried++]);
      opened = (await job.call("goto", { tab: opened.id, url })) as Opened;
    }
    outcome = await readTab(opened, url, job);
  } catch (e) {
    const error = messageOf(e);
    disconnected = DISCONNECTED.test(error) || recovering && error === "Safari extension not connected — enable the Safari Harness extension (Safari ▸ Settings ▸ Extensions; turning it on asks for the Mac's password or Touch ID)";
    outcome = { ok: false, error, failure: failureOf(e, { effectful: affectsPage(job.read, job.args) }) };
    closeError = await drop(warm, job.call);
  }
  // extract and snapshot say the address of the document they read
  const v = outcome.value;
  const shown = v && typeof v === "object" && "url" in v && typeof v.url === "string" ? address(v.url) : undefined;
  if (warm.tab !== undefined && warm.at !== undefined && shown === warm.at && address(url) !== warm.at) {
    await shut(warm, job.call);
    return visit(url, job, warm, recovering);
  }
  // map has closed the tab by the time its answer is read, so a stalled
  // page's advice to reload it there becomes mapping it again
  let stalled = false;
  if (!outcome.ok && !effectful && STALLED.test(outcome.error)) {
    stalled = true;
    const told = outcome.error.replace(/; reload it with goto and retry$/, "");
    const error = told.endsWith("map it again") ? told : `${told}; map it again`;
    outcome = { ...outcome, error, ...(outcome.failure ? { failure: { ...outcome.failure, message: error } } : {}) };
  }
  if (warm.tab !== undefined && !opened?.file) warm.at = shown ?? address(opened?.url);
  const ms = Math.round(performance.now() - started);
  const finalUrl = opened?.url && opened.url !== URL.parse(url)?.href ? opened.url : undefined;
  const about = { url, ...(finalUrl ? { finalUrl } : {}), ...(opened?.title ? { title: opened.title } : {}) };
  const page: Page = { ...outcome, ...about, ms, ...(retried ? { retried } : {}), ...(closeError === undefined ? {} : { closeError }) };
  if (warm.tab !== undefined) warm.last = page;
  if (outcome.ok && job.key !== undefined && keeps(page)) keep(job.key, url, { ok: true, value: outcome.value, ...about });
  return { page, disconnected, stalled };
}

// url in warm's tab: a goto where the reader's last page shows, a new tab
// for its first. A goto that answers that last page's address did not
// load url (a load that never began): its tab closes and url opens in a
// new one, as a page must never be read as another.
async function load(url: string, { call, fresh }: Job, warm: Warm): Promise<Opened> {
  const freshly = fresh ? { fresh: true } : {};
  if (warm.tab !== undefined) {
    const went = (await call("goto", { tab: warm.tab, url, ...freshly })) as Opened;
    warm.tab = went.id ?? warm.tab;
    if (warm.at === undefined || address(url) === warm.at || address(went.url) !== warm.at) return went;
    await shut(warm, call);
  }
  const opened = (await call("open", { url, background: true, ...freshly })) as Opened;
  warm.tab = opened.id;
  return opened;
}

// warm's tab closed, and warm left to open a new one: what the close
// answered, when it failed.
async function drop(warm: Warm, call: Call): Promise<string | undefined> {
  const { tab } = warm;
  warm.tab = warm.at = warm.last = undefined;
  return tab === undefined ? undefined : closeOf(tab, call);
}

// warm's tab closed; a close that fails is told on the last page it showed.
async function shut(warm: Warm, call: Call): Promise<void> {
  const { last } = warm;
  const error = await drop(warm, call);
  if (error !== undefined && last) last.closeError = error;
}

async function closeOf(tab: number, call: Call): Promise<string | undefined> {
  for (let tries = 1; ; tries++) {
    try {
      await call("close", { tab });
      return undefined;
    } catch (e) {
      if (tries === CLOSE_TRIES || !DISCONNECTED.test(messageOf(e))) return messageOf(e);
    }
  }
}

// The readers' tabs closed as map answers; past map's 50 s the answer goes
// without waiting on them.
async function closeAll(tabs: Warm[], call: Call, end: number): Promise<void> {
  const { promise: late, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, Math.max(0, end - Date.now()));
  await Promise.race([Promise.all(tabs.splice(0).map((warm) => shut(warm, call))), late]);
  clearTimeout(timer);
}

// An address as loads compare it: without its #fragment.
function address(url: string | undefined): string | undefined {
  const u = url === undefined ? null : URL.parse(url);
  if (!u) return url;
  u.hash = "";
  return u.href;
}

async function readTab(opened: Opened, url: string, { wait, waited, read, args, target, call }: Job): Promise<Outcome> {
  const check = opened.challenge;
  if (check && check.where !== "box") return { ok: false, error: CHECKED[check.where], failure: failureOf(new HarnessError("blocked", CHECKED[check.where], { next: CHECKED[check.where] })), challenge: check };
  // open answers a site's error page (its guide's error-titles) as not ok,
  // with a warning: the page holds nothing to read. On 10-16 a hunt's eBay
  // searches answered "Error Page | eBay", read as no listings (HuntsUsage).
  if (opened.ok === false && opened.warning) return { ok: false, error: opened.warning, failure: failureOf(new HarnessError("not_content", opened.warning)) };
  // An address Safari saves as a file opens no page: open and goto answer
  // with the file read (tools.ts fileOpened), which is the page's read; its
  // note tells of a tab map closes. A PDF Safari shows inline answers
  // extract that it is one, and reads through pdf. On 10-23 a map of two
  // leaflet PDFs waited 36 s on each to read nothing (SR-7).
  if (opened.file) {
    const { id: _, note: __, ...file } = opened;
    return { ok: true, value: file };
  }
  const pdfRead = async (): Promise<Outcome> => ({ ok: true, value: await call("pdf", { do: "read", url: opened.url ?? url, ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}) }) });
  if (wait) {
    const missed = missOf(await call("wait", { ...wait, tab: opened.id }), waited);
    if (missed) return check ? { ...missed, challenge: check } : missed;
  }
  // fetch asks again for the address the tab opened, with its cookies: the
  // body as the server sends it, where the others read the page it drew.
  let value: unknown;
  try {
    value = await call(read, { ...(target ? withLimit(read, args) : args), tab: opened.id, ...(read === "fetch" ? { url } : {}) });
  } catch (e) {
    if (read === "extract" && messageOf(e).includes("this is a PDF in Safari's viewer")) return pdfRead();
    throw e;
  }
  // A page can answer with an error instead of output (extract's selector
  // matches nothing): it read nothing, so it failed like a page that threw.
  const outcome: Outcome = pageError(value, affectsPage(read, args)) ?? errorRead(value, opened.title) ?? { ok: true, value };
  return check ? { ...outcome, challenge: check } : outcome;
}

function pageError(value: unknown, effectful: boolean): { ok: false; error: string; failure: Failure } | undefined {
  if (!value || typeof value !== "object" || !("error" in value) || typeof value.error !== "string") return undefined;
  const known = "failure" in value ? readFailure(value.failure) : undefined;
  return { ok: false, error: value.error, failure: known ?? failureOf(new Error(value.error), { effectful }) };
}

// A read of a page that is not the one asked for: an HTTP error, or a page
// its state calls an error (page-state.ts: a page not found, a rate limit).
// It failed, and what it read stays beside the error: on 10-23 three saved
// pages not found, three raw 404s, and an API's rate limit counted as read
// (K4).
function errorRead(value: unknown, title: string | undefined): Outcome | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { status?: unknown; title?: unknown; pageState?: PageState };
  const status = typeof v.status === "number" && v.status >= 400 ? v.status : undefined;
  if (status === undefined && v.pageState?.kind !== "error") return undefined;
  const named = typeof v.title === "string" && v.title ? v.title : title;
  const error = `an error page${status === undefined ? "" : ` (HTTP ${status})`}${named ? `, "${named}"` : ""}, not the page asked for${v.pageState ? `: ${v.pageState.next}` : ""}`;
  const failure = status === undefined ? failureOf(new HarnessError("not_content", error)) : failureOf(Object.assign(new Error(error), { status }), { effectful: false });
  return { ok: false, error, failure, value };
}

// A page's read written to the folder, which the page then answers with
// (save.ts); an error page's too, though it failed. An eval's value is
// saved with the page it came from.
async function savePage(page: Page, job: Job, target: Target): Promise<Page> {
  const { value: _, ...rest } = page;
  try {
    return { ...page, value: await saveOutput(job.read, job.read === "eval" ? sourced(page) : page.value, target, async () => page.finalUrl ?? page.url, partialRead(job.args)) };
  } catch (e) {
    return { ...rest, ok: false, error: messageOf(e), failure: failureOf(e, { effectful: false }) };
  }
}

// An eval's value as its file holds it: in the hunts of October an agent
// keyed its retries on an eBay search's address parameters, as its files
// held only the expression's value (AkylHunts AH5). A string (HTML, text)
// is saved as it is.
function sourced(page: Page): unknown {
  const v = page.value;
  if (!v || typeof v !== "object" || !("result" in v) || typeof v.result === "string") return v;
  return { ...v, result: { url: page.url, ...(page.finalUrl ? { finalUrl: page.finalUrl } : {}), ...(page.title ? { title: page.title } : {}), ok: page.ok, ms: page.ms, value: v.result } };
}

// The folder's index.json (save.ts), each page's line, failed or not: for a
// folder the caller named, as the shared one holds every task's maps.
async function indexed(target: Target | undefined, pages: Page[]): Promise<{ index?: string; note?: string }> {
  if (!target || !("dir" in target) || target.dir === SAVED_DIR || pages.length === 0) return {};
  const entries = pages.map((p) => {
    const v = p.value && typeof p.value === "object" ? (p.value as { saved?: unknown; status?: unknown }) : {};
    return {
      url: p.url,
      ...(p.finalUrl ? { finalUrl: p.finalUrl } : {}),
      ...(p.title ? { title: p.title } : {}),
      ok: p.ok,
      ...(typeof v.status === "number" ? { status: v.status } : {}),
      ms: p.ms,
      ...(typeof v.saved === "string" ? { saved: v.saved } : {}),
      ...(p.ok ? {} : { error: p.error }),
    };
  });
  return writeIndex(target.dir, entries).then((index) => ({ index }), (e: unknown) => ({ note: `no index.json: ${messageOf(e)}` }));
}

// A page that never showed what the wait asked for is most often another
// page (a redirect, a page not found): the address and title say which. A
// page that gave the wait no answer in time (unanswered, a loaded Safari)
// may show it all the same.
function missOf(seen: unknown, waited = "what wait asked for"): { ok: false; error: string; failure: Failure } | undefined {
  if (!seen || typeof seen !== "object" || !("found" in seen) || seen.found !== false) return undefined;
  const at = "url" in seen && typeof seen.url === "string" ? seen.url : "an address Safari did not give";
  const title = "title" in seen && typeof seen.title === "string" && seen.title !== "" ? ` ("${seen.title}")` : "";
  const error = "unanswered" in seen && seen.unanswered === true
    ? `it gave the wait no answer in time (Safari or the page was slow), so whether it shows ${waited} is not known: map it again`
    : `${MISSED} ${waited}; the tab is at ${at}${title}`;
  return { ok: false, error, failure: failureOf(new HarnessError("not_content", error)) };
}

type Row = { page: Page | Listing; depth: number; head: string; body: string; sep: string };

// map's answer as text: a line counting its pages, then each page under
// its title and address, as its read prints alone; a read that prints its
// own title (extract, snapshot) is not given it twice. A listing map
// followed has the pages it links to under it. Past max, an index of every
// page comes first, and each page keeps an even share of the rest: on
// 10-23 seven map answers were cut at a reply's 30,000 characters, and
// three of their pages did not show at all (K6).
export function mapText(answer: MapAnswer, format: (value: unknown) => string, max = Infinity): string {
  const rows: Row[] = [];
  const add = (list: (Page | Listing)[], level: string, depth: number) => list.forEach((p, i) => {
    const notes = [
      `${p.ms} ms`,
      ...("from" in p && p.from ? [p.from] : []),
      ...("retried" in p && p.retried ? [`loaded again ${p.retried === 1 ? "once" : `${p.retried} times`} after its error page`] : []),
      ...("challenge" in p && p.challenge ? [`challenge: ${JSON.stringify(p.challenge)}`] : []),
      ...(p.closeError ? [`not closed: ${p.closeError}`] : []),
      ...("unread" in p && p.unread ? [`${p.unread} more matching links past max`] : []),
    ];
    const value = "value" in p ? p.value : undefined;
    const titled = !!value && typeof value === "object" && "title" in value;
    const head = `${level} ${p.title && !titled ? `${p.title} — ` : ""}${p.url} (${notes.join("; ")})`;
    const sep = i > 0 ? "\n\n" : depth > 0 ? "\n" : "";
    if (!p.ok) return rows.push({ page: p, depth, head, body: `error: ${p.error}${value === undefined ? "" : `\n${format(value)}`}`, sep });
    if (!("items" in p)) return rows.push({ page: p, depth, head, body: format(p.value), sep });
    rows.push({ page: p, depth, head, body: p.items.length ? "" : "no page of its own: its links were read above, or are past max", sep });
    add(p.items, `${level}#`, depth + 1);
  });
  add(answer.pages, "##", 0);
  const read = rows.filter((r) => r.page.ok).length;
  const kept = rows.filter((r) => "from" in r.page && r.page.from).length;
  const top = [
    ...(rows.length > 1 || answer.urls?.length || answer.index
      ? [`${rows.length} page${rows.length === 1 ? "" : "s"}: ${read} read, ${rows.length - read} failed${kept ? `; ${kept} from this task's reads of the last 10 minutes (fresh: true reads them again)` : ""}`]
      : []),
    ...(answer.index ? [`index: ${answer.index}`] : []),
    ...(answer.urls?.length
      ? [`not read: ${answer.urls.length} (past max, or when map's ${BUDGET_MS / 1000} s ran out); map ${answer.urls.length > MAP_MAX_URLS ? `the first ${MAP_MAX_URLS}` : "them"} next: ${JSON.stringify({ urls: answer.urls.slice(0, MAP_MAX_URLS) })}`]
      : []),
  ];
  const text = (bodies: string[], lines: string[]) => [...(lines.length ? [`${lines.join("\n")}\n\n`] : []), ...rows.map((r, i) => `${r.sep}${r.head}${bodies[i] ? `\n${bodies[i]}` : ""}`)].join("");
  const whole = text(rows.map((r) => r.body), top);
  if (whole.length <= max) return whole;
  // A page's size as its read found it: an extract cut at its limit keeps
  // the whole text's length and its file (tools.ts fit), a saved read its
  // file's bytes; on 10-29 a 237,685-byte page read as about 20,000.
  const sizes = rows.map((r) => {
    const v = "value" in r.page && r.page.value && typeof r.page.value === "object" ? r.page.value : {};
    const saved = "saved" in v && typeof v.saved === "string" ? `, saved in ${v.saved}` : "";
    return { of: "total" in v && typeof v.total === "number" ? `${v.total} characters` : "bytes" in v && typeof v.bytes === "number" ? `${v.bytes} bytes` : `${r.body.length} characters`, saved };
  });
  const index = rows.map((r, i) => {
    const p = r.page;
    const state = !p.ok ? `failed: ${p.error.length > 120 ? `${p.error.slice(0, 120)}…` : p.error}` : "items" in p ? `listing, ${p.items.length} links read` : `read, ${sizes[i].of}${sizes[i].saved}`;
    return `${"  ".repeat(r.depth)}- ${p.url}: ${state}`;
  });
  const lines = [...top, `each page below is cut to its share of ${max} characters:`, ...index];
  // Each body is given the room left, shortest first: one that needs less
  // than an even share keeps all of it, and the rest share what it leaves.
  // 40 characters each are kept for the line that says where it was cut.
  let room = max - text(rows.map(() => ""), lines).length - 40 * rows.length;
  const shares: number[] = [];
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].body.length - rows[b].body.length);
  order.forEach((i, k) => {
    shares[i] = Math.min(rows[i].body.length, Math.max(0, Math.floor(room / (order.length - k))));
    room -= shares[i];
  });
  return text(rows.map((r, i) => (shares[i] < r.body.length ? `${r.body.slice(0, shares[i])}\n…cut at ${shares[i]} of ${sizes[i].of}` : r.body)), lines);
}
