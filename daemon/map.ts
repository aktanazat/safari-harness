// map: one read of each of up to 20 pages, a few at a time. Each page opens
// in a background tab of the caller's agent window, is read, and closes. The
// tab is the caller's meanwhile (open with background), so it still closes
// if the caller exits first. A page that fails is reported in its place and
// the others go on. So is a bot check: it is never waited on, since nobody
// watches these tabs.

import type { Challenge } from "./challenge.ts";
import { saveOutput, targetOf, withLimit, type SaveKind, type Target } from "./save.ts";

export const MAP_MAX_URLS = 20;
const AT_ONCE = 4;
const MAX_AT_ONCE = 6;
export const READS: SaveKind[] = ["extract", "snapshot", "eval", "fetch"];

// A check that stands in for the page leaves nothing to read; one in a box
// on a page that otherwise reads normally is noted beside what was read.
const CHECKED: Record<"page" | "block", string> = {
  page: "a bot check stands in for the page; open it and hand it to the user with handoff, or leave it",
  block: "the site turns the browser away; the user cannot clear that either",
};

type Outcome = ({ ok: true; value: unknown } | { ok: false; error: string }) & { challenge?: Challenge };
export type Page = Outcome & { url: string; ms: number; closeError?: string };
type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
// What map does with each page: the read, its arguments, where to save it.
type Job = { read: SaveKind; args: Record<string, unknown>; target?: Target; call: Call };
type Opened = { id: number; url?: string; challenge?: Challenge };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readOf(what: unknown): SaveKind {
  const read = READS.find((r) => r === what);
  if (!read) throw new Error("what must be extract, snapshot, eval, or fetch");
  return read;
}

// call runs one tool as the caller would (callTool): open, the read, close.
export async function mapPages(a: Record<string, unknown>, call: Call): Promise<{ pages: Page[] }> {
  const { urls, what = "extract", concurrency = AT_ONCE, save, ...args } = a;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u): u is string => typeof u === "string")) throw new Error('map needs urls: ["https://…", …]');
  if (urls.length > MAP_MAX_URLS) throw new Error(`map reads at most ${MAP_MAX_URLS} pages a call; pass the rest to another`);
  const read = readOf(what);
  if (read === "eval" && typeof args.expression !== "string") throw new Error("what: eval needs expression");
  const atOnce = Number(concurrency);
  if (!Number.isFinite(atOnce)) throw new Error("concurrency must be a number");
  const job: Job = { read, args, target: save === undefined || save === false ? undefined : targetOf(save, "folder"), call };
  const pages: Page[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < urls.length; i = next++) pages[i] = await visit(urls[i], job);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(atOnce)), MAX_AT_ONCE, urls.length) }, worker));
  return { pages };
}

// One page, start to end; it answers for every failure, its tab's close
// included, so one page never takes the others down with it.
async function visit(url: string, job: Job): Promise<Page> {
  const started = performance.now();
  let tab: number | undefined;
  let outcome: Outcome;
  try {
    // open answers {id, url, challenge?} or throws; callTool types every answer unknown
    const opened = (await job.call("open", { url, background: true })) as Opened;
    tab = opened.id;
    outcome = await readTab(opened, url, job);
  } catch (e) {
    outcome = { ok: false, error: messageOf(e) };
  }
  const ms = Math.round(performance.now() - started);
  const closeError = tab === undefined ? undefined : await job.call("close", { tab }).then(() => undefined, messageOf);
  return { ...outcome, url, ms, ...(closeError === undefined ? {} : { closeError }) };
}

async function readTab(opened: Opened, url: string, { read, args, target, call }: Job): Promise<Outcome> {
  const check = opened.challenge;
  if (check && check.where !== "box") return { ok: false, error: CHECKED[check.where], challenge: check };
  // fetch asks again for the address the tab opened, with its cookies: the
  // body as the server sends it, where the others read the page it drew.
  const value = await call(read, { ...(target ? withLimit(read, args) : args), tab: opened.id, ...(read === "fetch" ? { url } : {}) });
  // A page can answer with an error instead of output (extract's selector
  // matches nothing): it read nothing, so it failed like a page that threw.
  const outcome: Outcome = pageError(value) ?? { ok: true, value: target ? await saveOutput(read, value, target, async () => opened.url ?? url) : value };
  return check ? { ...outcome, challenge: check } : outcome;
}

function pageError(value: unknown): { ok: false; error: string } | undefined {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? { ok: false, error: value.error } : undefined;
}
