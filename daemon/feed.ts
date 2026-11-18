import { createHash, randomBytes } from "node:crypto";
import { markLines } from "./injection.ts";
import { currentOwner, currentTask } from "./owner.ts";
import { endpointOf, textShownOn } from "./request-catalog.ts";
import { jsonWall } from "./page-state.ts";

// net {tab, pages}: the JSON list behind a page, read a page at a time the
// way the page itself asks for its next one. The request is one the tab made
// (net's log), the rows are the array whose texts the page shows, and the
// pager is learned from two requests the page made to the same endpoint,
// after a scroll when it made only one; a pager named by habit is a guess and
// says so. Next pages go out from the page (its cookies and sign-in header),
// one at a time, and stop at the first answer unlike the page's own.

export type NetEntry = { url: string; method?: string; kind?: string; status?: number; t: number; frame?: number; body?: string; error?: string };
export type Fetched = { status?: number; url?: string; type?: string | null; text?: string; truncated?: boolean; headers?: [string, string][]; note?: string };
export type FeedDeps = {
  entries: (tab: number) => Promise<NetEntry[]>;
  body: (tab: number, entry: NetEntry) => Promise<{ text: string; truncated: boolean; arriving: boolean }>;
  pageUrl: (tab: number) => Promise<string>;
  pageText: (tab: number) => Promise<string>;
  scroll: (tab: number) => Promise<unknown>;
  fetch: (tab: number, url: string) => Promise<Fetched>;
  save: (text: string, url: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
};

type Row = Record<string, unknown>;
type Reply = { url: string; body: unknown };
export type RowsPath = { path: string[]; node?: true };
export type Pager =
  | { kind: "page"; key: string; base: 0 | 1 }
  | { kind: "offset"; key: string }
  | { kind: "cursor"; key: string; from: string[]; link?: true }
  | { kind: "cursor"; key: string; lastRow: string[] };
type Source = "watched" | "scrolled" | "guessed";
type State = {
  owner: string;
  tab: number;
  pageUrl: string;
  expires: number;
  endpoint: string;
  rows: RowsPath;
  pager: Pager;
  source: Source;
  status: number;
  last: Reply;
  idKey?: string;
  seen: Set<string>;
  prints: Set<string>;
  total?: number;
};

export const FEED_MAX_PAGES = 20;
const BUDGET_MS = 50_000;
const GAP_MS = 1_000;
const HANDLE_MS = 10 * 60_000;
const MAX_BODIES = 12;
const MAX_ROWS_SCORED = 200;
const held = new Map<string, State>();

const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- the safety gate ----------

// Words of a path or a query key that ask the site to change something when
// it answers: a GET that marks a feed seen is not a read.
const CHANGING = new Set("mark seen read ack track vote like follow subscribe unsubscribe confirm delete consume redeem logout".split(" "));
// A signed or one-time address: it answers once, or only as it was signed.
const SIGNED = /^(?:sig|signature|token|nonce|expires|x-amz-[\w-]+)$/i;
// Query keys whose value names what the request does.
const ACTION_KEY = /^(?:action|op|operation|do|cmd|method)$/i;

function wordsOf(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// The registrable part of a host, near enough: the last two labels, or
// three under a short country suffix (co.uk, com.au).
export function siteOf(host: string): string {
  const parts = host.toLowerCase().split(".");
  const keep = parts.length >= 3 && parts.at(-1)!.length === 2 && parts.at(-2)!.length <= 3 ? 3 : 2;
  return parts.slice(-keep).join(".");
}

// Why the feed may not ask url again from page, or undefined when it may.
export function feedRefusal(url: string, page: string): string | undefined {
  const u = URL.parse(url);
  const p = URL.parse(page);
  if (!u || !p || !["http:", "https:"].includes(u.protocol)) return "it is not an ordinary web address";
  if (siteOf(u.hostname) !== siteOf(p.hostname)) return "it goes to another site than the page's";
  try {
    endpointOf(u.origin + u.pathname);
  } catch {
    return "its path may sign in, change the account, or hold a secret link";
  }
  const changing = wordsOf(u.pathname).find((word) => CHANGING.has(word));
  if (changing) return `its path has "${changing}", so asking it may change something`;
  for (const [key, value] of flatQuery(url)) {
    const last = key.split(".").at(-1)!;
    if (SIGNED.test(last)) return `its query carries a signed or one-time value (${key})`;
    const word = wordsOf(key).find((w) => CHANGING.has(w));
    if (word) return `its query key ${key} has "${word}", so asking it may change something`;
    if (ACTION_KEY.test(last) && typeof value === "string") {
      const named = wordsOf(value).find((w) => CHANGING.has(w));
      if (named) return `its ${key} is "${named}", so asking it may change something`;
    }
    if (last === "query" && typeof value === "string" && /^\s*mutation\b/.test(value)) return "it is a GraphQL mutation";
  }
  return undefined;
}

// ---------- queries ----------

type Param = { key: string; raw: string; value: string };
const decoded = (text: string) => {
  try { return decodeURIComponent(text.replace(/\+/g, " ")); } catch { return text; }
};

function paramsOf(url: URL): Param[] {
  return url.search.slice(1).split("&").filter(Boolean).map((raw) => {
    const at = raw.indexOf("=");
    return { key: decoded(at < 0 ? raw : raw.slice(0, at)), raw, value: decoded(at < 0 ? "" : raw.slice(at + 1)) };
  });
}

function jsonParam(value: string): unknown {
  if (!/^\s*[[{]/.test(value)) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function leaves(value: unknown, prefix: string, into: Map<string, unknown>): void {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) leaves(child, `${prefix}.${key}`, into);
  } else into.set(prefix, value);
}

// A query as key to value, a JSON-valued parameter (GraphQL's variables)
// opened into a key per value: variables.after.
export function flatQuery(url: string): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  const u = URL.parse(url);
  if (!u) return flat;
  for (const { key, value } of paramsOf(u)) {
    const json = jsonParam(value);
    if (json !== undefined) leaves(json, key, flat);
    else flat.set(key, value);
  }
  return flat;
}

// A key that changes with every request whatever page it asks for: a
// cache-buster's time in seconds or milliseconds.
const clock = (value: unknown) => /^\d{10}(?:\d{3})?$/.test(String(value)) && Math.abs(Number(String(value).padEnd(13, "0")) - Date.now()) < 365 * 86_400_000;

export function changedKeys(a: string, b: string): string[] {
  const x = flatQuery(a);
  const y = flatQuery(b);
  return [...new Set([...x.keys(), ...y.keys()])].filter((key) => JSON.stringify(x.get(key)) !== JSON.stringify(y.get(key)) && !(clock(x.get(key)) && clock(y.get(key))));
}

// url with key set to value and every other byte of its query as it was.
export function withKey(url: string, key: string, value: string | number): string {
  const u = new URL(url);
  const params = paramsOf(u);
  const plain = params.findIndex((p) => p.key === key);
  const nested = plain >= 0 ? -1 : params.findIndex((p) => key.startsWith(`${p.key}.`) && jsonParam(p.value) !== undefined);
  const segment = (p: Param, text: string) => `${p.raw.includes("=") ? p.raw.slice(0, p.raw.indexOf("=")) : p.raw}=${encodeURIComponent(text)}`;
  let segments = params.map((p) => p.raw);
  if (plain >= 0) segments[plain] = segment(params[plain]!, String(value));
  else if (nested >= 0) {
    const p = params[nested]!;
    const json = jsonParam(p.value) as Record<string, unknown>;
    const path = key.slice(p.key.length + 1).split(".");
    let at: Record<string, unknown> = json;
    for (const part of path.slice(0, -1)) {
      if (!isRow(at[part]) && !Array.isArray(at[part])) at[part] = {};
      at = at[part] as Record<string, unknown>;
    }
    const leaf = path.at(-1)!;
    at[leaf] = typeof at[leaf] === "number" && typeof value === "number" ? value : typeof at[leaf] === "number" ? Number(value) : value;
    segments[nested] = segment(p, JSON.stringify(json));
  } else segments = [...segments, `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`];
  return `${u.origin}${u.pathname}?${segments.join("&")}${u.hash}`;
}

// ---------- rows ----------

function at(value: unknown, path: string[]): unknown {
  let here = value;
  for (const part of path) {
    if (here === null || typeof here !== "object" || !Object.hasOwn(here, part)) return undefined;
    here = (here as Record<string, unknown>)[part];
  }
  return here;
}

export function rowsAt(body: unknown, rows: RowsPath): Row[] | undefined {
  const list = at(body, rows.path);
  if (!Array.isArray(list) || !list.every(isRow)) return undefined;
  return rows.node ? list.map((item) => (isRow(item.node) ? item.node : item)) : list;
}

export function rowsName(rows: RowsPath): string {
  return `${rows.path.join(".") || "(root)"}[]${rows.node ? ".node" : ""}`;
}

function stringsOf(value: unknown, into: Set<string>, depth = 0): void {
  if (typeof value === "string") into.add(value);
  else if (value !== null && typeof value === "object" && depth < 6) for (const child of Object.values(value)) stringsOf(child, into, depth + 1);
}

// The array of objects in body whose texts the page shows most, and of two
// that show as many the longer: an edges[] of {node} reads as its nodes.
export function rowsIn(body: unknown, shown: (text: string) => boolean): { rows: RowsPath; count: number; shown: number } | undefined {
  let best: { rows: RowsPath; count: number; shown: number } | undefined;
  const walk = (value: unknown, path: string[], depth: number) => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every(isRow)) {
        const node = value.every((item) => isRow(item.node)) ? true : undefined;
        const rows = rowsAt(body, { path, node })!;
        const texts = new Set<string>();
        for (const row of rows.slice(0, MAX_ROWS_SCORED)) stringsOf(row, texts);
        const count = [...texts].filter(shown).length;
        if (!best || count > best.shown || (count === best.shown && rows.length > best.count)) best = { rows: { path, ...(node ? { node } : {}) }, count: rows.length, shown: count };
      }
      value.slice(0, 3).forEach((item, index) => walk(item, [...path, String(index)], depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, [...path, key], depth + 1);
  };
  walk(body, [], 0);
  return best;
}

const ID_KEYS = ["id", "_id", "uuid", "guid", "key", "slug", "url", "permalink"];

export function idKeyOf(rows: Row[]): string | undefined {
  return ID_KEYS.find((key) => {
    const values = rows.map((row) => row[key]);
    return values.every((v) => (typeof v === "string" && v !== "") || typeof v === "number") && new Set(values).size === values.length;
  });
}

const TOTAL = /^(?:total|totalcount|total_count|totalresults|total_results|totalitems|total_items|totalhits|nbhits|count)$/i;

// The list's length as the reply gives it. A count no larger than this
// reply's rows is the page's size, not the list's: Django's count is the
// list's, other APIs' count the page's.
function totalOf(body: unknown, rows: RowsPath): number | undefined {
  const here = rowsAt(body, rows)?.length ?? 0;
  for (const holder of [at(body, rows.path.slice(0, -1)), body, at(body, [...rows.path.slice(0, -1), "pageInfo"])]) {
    if (!isRow(holder)) continue;
    for (const [key, value] of Object.entries(holder)) if (TOTAL.test(key) && typeof value === "number" && Number.isInteger(value) && value > here) return value;
  }
  return undefined;
}

// The reply's word that it is the last page: GraphQL's hasNextPage, or
// has_more / hasMore, false beside the rows or in their pageInfo.
function saysLast(body: unknown, rows: RowsPath): boolean {
  const parent = rows.path.slice(0, -1);
  for (const holder of [at(body, parent), at(body, [...parent, "pageInfo"]), body]) {
    if (isRow(holder) && [holder.hasNextPage, holder.has_next_page, holder.has_more, holder.hasMore].includes(false)) return true;
  }
  return false;
}

// ---------- the pager ----------

const int = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) ? value : typeof value === "string" && /^-?\d{1,9}$/.test(value) ? Number(value) : undefined);

function paths(value: unknown, want: (leaf: unknown, key: string) => boolean, path: string[] = [], into: string[][] = [], depth = 0): string[][] {
  if (depth > 10) return into;
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if ((child === null || typeof child !== "object") && want(child, key)) into.push([...path, key]);
      paths(child, want, [...path, key], into, depth + 1);
    }
  }
  return into;
}

const startsWith = (path: string[], prefix: string[]) => prefix.every((part, i) => path[i] === part);

// Where a reply holds value: a field outside the rows (a cursor), the last
// row's own field (max_id), or a link to the next page whose key is value.
function cursorSource(body: unknown, rows: RowsPath, key: string, value: string, url: string): Pager | undefined {
  const found = paths(body, (leaf) => (typeof leaf === "string" || typeof leaf === "number") && String(leaf) === value);
  const outside = found.find((path) => !startsWith(path, rows.path));
  if (outside) return { kind: "cursor", key, from: outside };
  const list = rowsAt(body, rows);
  const lastIndex = String((list?.length ?? 0) - 1);
  const last = found.find((path) => startsWith(path, rows.path) && path[rows.path.length] === lastIndex);
  if (last) return { kind: "cursor", key, lastRow: last.slice(rows.path.length + (rows.node ? 2 : 1)) };
  const link = paths(body, (leaf) => typeof leaf === "string" && /^(?:https?:\/\/|\/|\?)/.test(leaf) && flatQuery(new URL(leaf, url).href).get(key) !== undefined && String(flatQuery(new URL(leaf, url).href).get(key)) === value)
    .find((path) => !startsWith(path, rows.path));
  return link ? { kind: "cursor", key, from: link, link: true } : undefined;
}

// The pager two requests to one endpoint show: the one query key that
// changed between them, a page number when it went up by one, an offset
// when by the earlier reply's row count, and a cursor when the earlier
// reply held its new value.
export function learnPager(earlier: Reply, later: Reply, rows: RowsPath): Pager | undefined {
  const keys = changedKeys(earlier.url, later.url);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  const a = flatQuery(earlier.url).get(key);
  const b = flatQuery(later.url).get(key);
  const na = int(a);
  const nb = int(b);
  const count = rowsAt(earlier.body, rows)?.length ?? 0;
  if (nb !== undefined) {
    if (na !== undefined && nb - na === 1) return { kind: "page", key, base: na === 0 ? 0 : 1 };
    if (na !== undefined && count > 1 && nb - na === count) return { kind: "offset", key };
    if (a === undefined && count > 1 && nb === count) return { kind: "offset", key };
    if (a === undefined && (nb === 1 || nb === 2)) return { kind: "page", key, base: nb === 1 ? 0 : 1 };
  }
  if (b === undefined || b === null || String(b) === "") return undefined;
  return cursorSource(earlier.body, rows, key, String(b), earlier.url);
}

const PAGE_KEYS = /^(?:page|p|pg|pagenumber|page_number|pagenum|page_num)$/i;
const OFFSET_KEYS = /^(?:offset|start|skip)$/i;
const CURSOR_KEYS = /^(?:cursor|after|pagetoken|page_token|continuation|max_id)$/i;
const REPLY_CURSOR = /^(?:next|nextcursor|next_cursor|endcursor|end_cursor|next_page_token|nextpagetoken|continuation|cursor)$/i;
const REPLY_LINK = [["paging", "next"], ["links", "next"], ["next"], ["next_page_url"], ["nextPage"]];

// A pager named by habit, for a page that showed no second request: a link
// to the next page in the reply, a cursor key with a cursor in the reply,
// or a page or offset key in the address.
export function guessPager(last: Reply, rows: RowsPath): Pager | undefined {
  for (const path of REPLY_LINK) {
    const link = at(last.body, path);
    if (typeof link !== "string" || !URL.canParse(link, last.url)) continue;
    const href = new URL(link, last.url).href;
    const keys = changedKeys(last.url, href);
    if (keys.length === 1) return { kind: "cursor", key: keys[0]!, from: path, link: true };
  }
  const keys = [...flatQuery(last.url).keys()];
  const name = (key: string) => key.split(".").at(-1)!;
  const cursorKey = keys.find((key) => CURSOR_KEYS.test(name(key)));
  const cursorAt = paths(last.body, (leaf, key) => typeof leaf === "string" && leaf !== "" && REPLY_CURSOR.test(key)).find((path) => !startsWith(path, rows.path));
  if (cursorKey && cursorAt) return { kind: "cursor", key: cursorKey, from: cursorAt };
  const pageKey = keys.find((key) => PAGE_KEYS.test(name(key)));
  if (pageKey) return { kind: "page", key: pageKey, base: int(flatQuery(last.url).get(pageKey)) === 0 ? 0 : 1 };
  const offsetKey = keys.find((key) => OFFSET_KEYS.test(name(key)));
  if (offsetKey) return { kind: "offset", key: offsetKey };
  return undefined;
}

// The value the pager's key takes for the page after last.
export function nextValue(pager: Pager, last: Reply, rows: RowsPath): { value: string | number } | { end: string } {
  const now = flatQuery(last.url).get(pager.key);
  const list = rowsAt(last.body, rows) ?? [];
  if (saysLast(last.body, rows)) return { end: "the reply says it is the last page" };
  if (pager.kind === "page") {
    const page = int(now);
    return { value: page === undefined ? pager.base + 1 : page + 1 };
  }
  if (pager.kind === "offset") return { value: (int(now) ?? 0) + list.length };
  const raw = "lastRow" in pager ? at(list.at(-1), pager.lastRow) : at(last.body, pager.from);
  const value = "link" in pager && typeof raw === "string" && URL.canParse(raw, last.url) ? flatQuery(new URL(raw, last.url).href).get(pager.key) : raw;
  if ((typeof value !== "string" && typeof value !== "number") || value === "") return { end: "the reply gives no next cursor" };
  if (String(value) === String(now)) return { end: "the reply's next cursor is this page's" };
  return { value };
}

// ---------- answers ----------

function shielded(value: unknown, places: { n: number }): unknown {
  if (typeof value === "string") {
    const marked = markLines(value, false);
    places.n += marked.places;
    return marked.text;
  }
  if (Array.isArray(value)) return value.map((child) => shielded(child, places));
  if (isRow(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shielded(child, places)]));
  return value;
}

const print = (rows: Row[], idKey: string | undefined) => createHash("sha1").update(JSON.stringify(idKey ? rows.map((row) => row[idKey]) : rows)).digest("hex");

// The rows of list not seen before, by the id key, or whole when the rows
// have none.
function fresh(list: Row[], state: Pick<State, "idKey" | "seen">): Row[] {
  return list.filter((row) => {
    const id = state.idKey ? String(row[state.idKey]) : createHash("sha1").update(JSON.stringify(row)).digest("hex");
    if (state.seen.has(id)) return false;
    state.seen.add(id);
    return true;
  });
}

const SCROLL = "scroll instead: extract {tab, scroll: true} lets the page ask for its next pages itself";

type Paged = { pages: number; rows: Row[]; stopped?: string; ended?: string };

async function readOn(state: State, want: number, deps: FeedDeps, started: number): Promise<Paged> {
  const sleep = deps.sleep ?? Bun.sleep;
  const out: Paged = { pages: 0, rows: [] };
  let lastAt = 0;
  while (out.pages < want) {
    if (Date.now() - started > BUDGET_MS) return { ...out, stopped: `the call's ${BUDGET_MS / 1000} s ran out` };
    if (state.total !== undefined && state.seen.size >= state.total) return { ...out, ended: `all ${state.total} rows the reply counts are read` };
    const next = nextValue(state.pager, state.last, state.rows);
    if ("end" in next) return { ...out, ended: next.end };
    const url = withKey(state.last.url, state.pager.key, next.value);
    const refused = feedRefusal(url, state.pageUrl);
    if (refused) return { ...out, stopped: `the next page's address was refused: ${refused}` };
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    let got: Fetched;
    try {
      got = await deps.fetch(state.tab, url);
    } catch (e) {
      return { ...out, stopped: `the page's request for the next page failed (${message(e)}); ${SCROLL}` };
    }
    lastAt = Date.now();
    if (got.status !== state.status) {
      const after = got.headers?.find(([name]) => /^retry-after$/i.test(name))?.[1];
      const why = got.status === 429 ? `the site rate-limited the next page (HTTP 429${after ? `, retry after ${after}` : ""}); wait before reading it again`
        : got.status === 401 || got.status === 403 ? `the site refused the next page (HTTP ${got.status}): the page's own request likely carries a header this one lacks; ${SCROLL}`
        : `the next page answered HTTP ${got.status ?? "nothing"} where the page's request got ${state.status}; ${SCROLL}`;
      return { ...out, stopped: why };
    }
    const answered = URL.parse(got.url ?? url);
    if (!answered || answered.origin + answered.pathname !== new URL(url).origin + new URL(url).pathname) return { ...out, stopped: `the next page was sent elsewhere (a sign-in?); ${SCROLL}` };
    if (got.truncated) return { ...out, stopped: "the next page's reply ran past 1 MB" };
    let body: unknown;
    try { body = JSON.parse(got.text ?? ""); } catch { return { ...out, stopped: `the next page did not answer JSON (a sign-in or bot check?); ${SCROLL}` }; }
    if (jsonWall(body) !== undefined) return { ...out, stopped: "the next page's reply reports an error, a sign-in, or loading" };
    const list = rowsAt(body, state.rows);
    if (!list) return { ...out, stopped: `the next page's reply has no rows at ${rowsName(state.rows)}` };
    if (!list.length) return { ...out, ended: "the next page had no rows: the list ended" };
    const fingerprint = print(list, state.idKey);
    if (state.prints.has(fingerprint)) return { ...out, ended: "the site sent the same rows again: the list ended or ignores the pager" };
    state.prints.add(fingerprint);
    state.last = { url, body };
    state.total ??= totalOf(body, state.rows);
    out.pages++;
    const added = fresh(list, state);
    if (!added.length) return { ...out, ended: "the next page had only rows already read: the list ended or ignores the pager" };
    out.rows.push(...added);
  }
  return out;
}

async function answer(state: State, observed: Row[], paged: Paged, maxBytes: number, handle: string | undefined, deps: FeedDeps, notes: string[]) {
  const places = { n: 0 };
  const rows = [...observed, ...paged.rows].map((row) => shielded(row, places));
  const lines = rows.map((row) => JSON.stringify(row));
  let kept = lines.length;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i]!.length + 1;
    if (size > maxBytes) { kept = i; break; }
  }
  const saved = kept < lines.length ? await deps.save(lines.join("\n"), state.pageUrl) : undefined;
  const more = paged.ended === undefined && paged.stopped === undefined;
  const next = more && handle
    ? `net {tab, pages: N, continue: "${handle}"} reads the pages after these`
    : paged.stopped ?? "the list ended; nothing more to read here";
  return {
    feed: {
      request: state.endpoint,
      rows: rowsName(state.rows),
      pager: { kind: state.pager.kind, key: state.pager.key, from: state.source },
      ...(state.idKey ? { idKey: state.idKey } : {}),
    },
    pages: paged.pages,
    ...(observed.length ? { observedRows: observed.length } : {}),
    count: rows.length,
    ...(state.total !== undefined ? { of: state.total } : {}),
    rows: rows.slice(0, kept),
    ...(saved ? { truncated: true, saved, shown: kept } : {}),
    ...(paged.ended ? { ended: paged.ended } : {}),
    ...(paged.stopped ? { stopped: paged.stopped } : {}),
    ...(more && handle ? { continue: handle } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}),
    ...(places.n ? { addressedToAI: places.n } : {}),
    next,
  };
}

function ownerKey(): string {
  return `${currentOwner() ?? "-"}:${currentTask() ?? "-"}`;
}

function sweep(): void {
  const now = Date.now();
  for (const [handle, state] of held) if (state.expires < now) held.delete(handle);
}

function pagesOf(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Error(`pages is how many next pages to read, 1 to ${FEED_MAX_PAGES}`);
  return Math.min(n, FEED_MAX_PAGES);
}

type Candidate = { index: number; entry: NetEntry; body: unknown; rows: RowsPath; count: number; shown: number };

// The net log cuts an address past 500 characters with "…" (dialogs.js);
// asked again, the cut one drops the filters after the cut.
const basic = (e: NetEntry) => (e.method ?? "GET") === "GET" && (e.kind === "fetch" || e.kind === "xhr") && (e.frame ?? 0) === 0 && !e.url.endsWith("…")
  && e.error === undefined && e.status !== undefined && e.status >= 200 && e.status <= 299 && /^\s*[[{]/.test(e.body ?? "");
const endpoint = (url: string) => { const u = new URL(url); return u.origin + u.pathname; };

async function wholeBody(tab: number, entry: NetEntry, deps: FeedDeps): Promise<unknown> {
  const kept = await deps.body(tab, entry).catch(() => undefined);
  if (!kept || kept.truncated || kept.arriving) return undefined;
  try { return JSON.parse(kept.text); } catch { return undefined; }
}

// net {tab, pages, body?, continue?, maxBytes?}.
export async function feedPages(tab: number, args: Record<string, unknown>, deps: FeedDeps): Promise<unknown> {
  sweep();
  const started = Date.now();
  const want = pagesOf(args.pages ?? 1);
  const maxBytes = typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 20_000;
  const pageUrl = await deps.pageUrl(tab);
  if (args.continue !== undefined) {
    const state = typeof args.continue === "string" ? held.get(args.continue) : undefined;
    if (!state || state.owner !== ownerKey() || state.tab !== tab) throw new Error(`that continue handle is not this agent's for tab ${tab}, or it ran out after ${HANDLE_MS / 60_000} minutes; start again with net {tab, pages}`);
    if (state.pageUrl !== pageUrl) throw new Error("the tab left the page this feed was read from; start again with net {tab, pages}");
    state.expires = Date.now() + HANDLE_MS;
    const paged = await readOn(state, want, deps, started);
    if (paged.ended !== undefined || paged.stopped !== undefined) held.delete(String(args.continue));
    return answer(state, [], paged, maxBytes, String(args.continue), deps, []);
  }

  let entries = await deps.entries(tab);
  let refused: string[] = [];
  const allowed = (index: number, e: NetEntry) => {
    if (!basic(e)) return false;
    const why = feedRefusal(e.url, pageUrl);
    if (why) refused.push(`${index} ${URL.parse(e.url)?.pathname ?? "?"}: ${why}`);
    return why === undefined;
  };
  let picked: { index: number; entry: NetEntry }[];
  if (args.body !== undefined) {
    const which = args.body;
    const byIndex = typeof which === "number" || (typeof which === "string" && /^-?\d+$/.test(which));
    const index = byIndex ? (Number(which) < 0 ? entries.length + Number(which) : Number(which)) : entries.findLastIndex((e) => e.url.includes(String(which)));
    const entry = entries[index];
    if (!entry) throw new Error(byIndex ? `no request at ${which}: the list has ${entries.length}` : `no request in the list has ${which} in its url`);
    if (!basic(entry)) throw new Error("that request is not a successful JSON GET the top page made with fetch or XHR");
    const why = feedRefusal(entry.url, pageUrl);
    if (why) throw new Error(`that request is not read again: ${why}`);
    picked = [{ index, entry }];
  } else picked = entries.flatMap((entry, index) => (allowed(index, entry) ? [{ index, entry }] : [])).slice(-MAX_BODIES);

  const scoredOf = async (shown: (text: string) => boolean) => {
    const scored: Candidate[] = [];
    for (const { index, entry } of picked) {
      const body = await wholeBody(tab, entry, deps);
      const found = body === undefined ? undefined : rowsIn(body, shown);
      if (found) scored.push({ index, entry, body, ...found });
    }
    return scored.sort((a, b) => b.shown - a.shown || b.count - a.count || b.index - a.index);
  };
  let scored = await scoredOf(textShownOn(await deps.pageText(tab)));
  const fits = (c: Candidate | undefined): c is Candidate => c !== undefined && (args.body !== undefined || c.shown > 0);
  // A page drawn on the server shows its first page without a request; a
  // scroll makes it ask for the next one, which then holds rows it shows.
  if (!fits(scored[0]) && args.body === undefined) {
    await deps.scroll(tab).catch(() => undefined);
    entries = await deps.entries(tab);
    refused = [];
    picked = entries.flatMap((entry, index) => (allowed(index, entry) ? [{ index, entry }] : [])).slice(-MAX_BODIES);
    scored = await scoredOf(textShownOn(await deps.pageText(tab)));
  }
  const best = scored[0];
  if (!fits(best)) {
    const refusals = refused.length ? ` Refused: ${refused.slice(0, 5).join("; ")}.` : "";
    const early = scored.length === 0 && picked.length > 0 ? " Its replies may still be arriving: wait for words of the list (wait {tab, text}) and ask again." : "";
    throw new Error(`none of the JSON the page fetched holds rows the page shows, after a scroll to make it ask for more (${scored.length} JSON replies read).${refusals}${early} Read the requests with net {tab, urls: true} and name one with body, or ${SCROLL}`);
  }

  const point = endpoint(best.entry.url);
  const replies = async (list: NetEntry[]): Promise<Reply[]> => {
    const out: Reply[] = [];
    for (const entry of list) {
      const body = entry === best.entry ? best.body : await wholeBody(tab, entry, deps);
      if (body !== undefined && rowsAt(body, best.rows)) out.push({ url: entry.url, body });
    }
    return out;
  };
  const sameEndpoint = (list: NetEntry[]) => list.filter((e) => basic(e) && e.status === best.entry.status && endpoint(e.url) === point && feedRefusal(e.url, pageUrl) === undefined).slice(-6);
  let group = await replies(sameEndpoint(entries));
  let pager: Pager | undefined;
  let source: Source = "watched";
  if (group.length >= 2) pager = learnPager(group.at(-2)!, group.at(-1)!, best.rows);
  const notes: string[] = [];
  if (!pager && group.length < 2) {
    await deps.scroll(tab).catch((e: unknown) => notes.push(`the scroll to watch the page ask for its next page failed: ${message(e)}`));
    const after = await deps.entries(tab);
    const more = await replies(sameEndpoint(after).filter((e) => e.t > best.entry.t));
    if (more.length) {
      group = [...group, ...more];
      pager = learnPager(group.at(-2)!, group.at(-1)!, best.rows);
      source = "scrolled";
    }
  }
  const last = group.at(-1) ?? { url: best.entry.url, body: best.body };
  if (!pager) {
    pager = guessPager(last, best.rows);
    source = "guessed";
    if (pager) notes.push("the page showed no second request to this endpoint, so the pager is guessed from its key's name; check the rows follow on");
  }
  const lastRows = rowsAt(last.body, best.rows) ?? [];
  const state: State = {
    owner: ownerKey(),
    tab,
    pageUrl,
    expires: Date.now() + HANDLE_MS,
    endpoint: point,
    rows: best.rows,
    pager: pager ?? { kind: "page", key: "", base: 1 },
    source,
    status: best.entry.status!,
    last,
    idKey: idKeyOf(lastRows),
    seen: new Set(),
    prints: new Set(group.map((reply) => print(rowsAt(reply.body, best.rows) ?? [], idKeyOf(lastRows)))),
    total: totalOf(last.body, best.rows),
  };
  const observed = group.flatMap((reply) => fresh(rowsAt(reply.body, best.rows) ?? [], state));
  notes.unshift(`read from ${group.length} request${group.length === 1 ? "" : "s"} the page made and the next pages it asked for; the page shows ${best.shown} of the rows' texts`);
  if (!pager) {
    return { ...(await answer(state, observed, { pages: 0, rows: [], stopped: `no pager found in the page's requests; ${SCROLL}` }, maxBytes, undefined, deps, notes)), feed: { request: point, rows: rowsName(best.rows) } };
  }
  const paged = await readOn(state, want, deps, started);
  let handle: string | undefined;
  if (paged.ended === undefined && paged.stopped === undefined) {
    handle = randomBytes(12).toString("base64url");
    held.set(handle, state);
  }
  return answer(state, observed, paged, maxBytes, handle, deps, notes);
}

// For a table or list read: a hint naming the JSON request whose reply
// holds what it read, when the page fetched one; texts are the read's own.
// Its cost is one net read and one body: the request whose logged start
// holds a text, else the latest.
export async function feedHint(tab: number, texts: string[], pageUrl: string, deps: Pick<FeedDeps, "entries" | "body">): Promise<string | undefined> {
  const sample = texts.filter((t) => t.length >= 4 && t.length <= 200).slice(0, 8);
  if (sample.length < 2) return undefined;
  const holds = (text: string) => sample.filter((t) => text.includes(t) || text.includes(JSON.stringify(t).slice(1, -1))).length;
  const entries = (await deps.entries(tab)).filter((e) => basic(e) && feedRefusal(e.url, pageUrl) === undefined);
  const entry = entries.findLast((e) => holds(e.body ?? "") > 0) ?? entries.at(-1);
  if (!entry) return undefined;
  const kept = await deps.body(tab, entry).catch(() => undefined);
  if (!kept || holds(kept.text) < Math.min(3, sample.length)) return undefined;
  return `these rows came from the page's JSON request to ${new URL(entry.url).pathname}; net {tab, pages: 5} reads its next pages as rows`;
}
