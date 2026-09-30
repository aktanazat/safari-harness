// map: one read of each of up to 20 pages, a few at a time. Each page opens
// in a background tab of the caller's agent window, is read, and closes. The
// tab is the caller's meanwhile (open with background), so it still closes
// if the caller exits first. A page that fails is reported in its place and
// the others go on. So is a bot check still up once open has waited on it
// (settledChallenge): nobody watches these tabs to clear one. With wait,
// each page is read once it shows what the wait asks for: a page its script
// draws after it loads reads empty before.

import type { Challenge } from "./challenge.ts";
import { WAIT_NEEDS, waitsOnPage } from "./receipt.ts";
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
// What map does with each page: what it waits for, the read, its
// arguments, where to save it.
type Job = { wait?: Record<string, unknown>; read: SaveKind; args: Record<string, unknown>; target?: Target; call: Call };
type Opened = { id: number; url?: string; title?: string; challenge?: Challenge };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const { urls, what = "extract", concurrency = AT_ONCE, save, wait, ...args } = a;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u): u is string => typeof u === "string")) throw new Error('map needs urls: ["https://…", …]');
  if (urls.length > MAP_MAX_URLS) throw new Error(`map reads at most ${MAP_MAX_URLS} pages a call; pass the rest to another`);
  const read = readOf(what);
  if (read === "eval" && typeof args.expression !== "string" && typeof args.reader !== "string") throw new Error("what: eval needs expression, or reader");
  const atOnce = Number(concurrency);
  if (!Number.isFinite(atOnce)) throw new Error("concurrency must be a number");
  const job: Job = { wait: wait === undefined ? undefined : waitOf(wait), read, args, target: save === undefined || save === false ? undefined : targetOf(save, "folder"), call };
  const pages: Page[] = [];
  const began: number[] = [];
  // The pages' files being written, which the answer waits on.
  const writing: Promise<void>[] = [];
  let next = 0;
  // Past BUDGET_MS no page begins; one still being read goes on and closes
  // its tab as it ends, and with save writes no file: the answer names it
  // unfinished, so its file would be one no answer names.
  let over = false;
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
  }, BUDGET_MS);
  await Promise.race([Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(atOnce)), MAX_AT_ONCE, urls.length) }, worker)), late]);
  clearTimeout(timer);
  await Promise.all(writing);
  return { pages: urls.map((url, i) => pages[i] ?? unfinished(url, began[i])) };
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
    // open answers {id, url, title, challenge?} or throws; callTool types every answer unknown
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

async function readTab(opened: Opened, url: string, { wait, read, args, target, call }: Job): Promise<Outcome> {
  const check = opened.challenge;
  if (check && check.where !== "box") return { ok: false, error: CHECKED[check.where], challenge: check };
  if (wait) {
    const missed = missOf(await call("wait", { ...wait, tab: opened.id }));
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
// page (a redirect, a page not found): the address and title say which.
function missOf(seen: unknown): { ok: false; error: string } | undefined {
  if (!seen || typeof seen !== "object" || !("found" in seen) || seen.found !== false) return undefined;
  const at = "url" in seen && typeof seen.url === "string" ? seen.url : "an address Safari did not give";
  const title = "title" in seen && typeof seen.title === "string" && seen.title !== "" ? ` ("${seen.title}")` : "";
  return { ok: false, error: `it did not show what wait asked for; the tab is at ${at}${title}` };
}
