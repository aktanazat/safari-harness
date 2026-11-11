// A task's reads of each kind of page, for the offer of a faster way to the
// same data (tools.ts). Of the 10,204 page loads logged from 11-06 to 11-11,
// 320 were the Hacker News front page, 286 eBay listings, and 50 one GitHub
// repo's home, each read whole again, while such a page gets its data from
// one JSON request of its own or a saved reader reads it in one call.
import { watchOwner } from "./owner.ts";

const OFFER_AT = 3;
// A page may make its own JSON request after a read: on 11-11 three
// snapshots of a GitHub pull request, each taken as its load ended, came
// before it asked for its checks (page_data/status_checks), which a read
// 4 seconds later found. A page read again is looked at on 2 more reads.
const LOOKS = 3;
// A tab read again this soon, at the same address and in the same document,
// is still one look at the page; a later read sees what changed since.
const SAME_LOOK_MS = 120_000;
const KEPT = 200;

type Kind = { reads: number; pages: Map<bigint, number>; offered: boolean };
type Look = { page: bigint; document?: string; at: number };
const owners = new Map<number, Map<string, { kinds: Map<string, Kind>; looks: Map<number, Look> }>>();

// A page's kind: its origin and path, with each part of the path that names
// one item (a part with a digit or a sign other than - . _ ~, or longer
// than 40 characters) as *, and without its query: /o/r/pull/31 and
// /o/r/pull/32 are one kind. A hint shows the kind, so no part of a page's
// address but plain words reaches its wording.
export function pageKind(url: string): string | undefined {
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return undefined;
  return parsed.origin + parsed.pathname.split("/").map((part) => (/[^A-Za-z_.~-]/.test(part) || part.length > 40 ? "*" : part)).join("/");
}

function kept<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.delete(key);
  map.set(key, value);
  if (map.size > KEPT) map.delete(map.keys().next().value as K);
  return value;
}

// Counts a model's read of the page at url in task, in tab (none for a map
// page). From the third read of one kind of page, answers it once: whether
// this address was read before (a page read again may come from the JSON
// request it made, while a kind read across pages needs a reader), and
// whether this read is the last one to offer on. The answer holds the
// kind's offer, so two reads at once make one; a read that offers nothing
// yet gives it back (deferred).
export function scraped(owner: number, task: string, tab: number | undefined, url: string, document?: string): { kind: string; again: boolean; last: boolean } | undefined {
  const kind = pageKind(url);
  if (kind === undefined) return undefined;
  let tasks = owners.get(owner);
  if (!tasks) {
    owners.set(owner, (tasks = new Map()));
    watchOwner(owner, () => owners.delete(owner));
  }
  const reads = tasks.get(task) ?? kept(tasks, task, { kinds: new Map(), looks: new Map() });
  const page = BigInt(Bun.hash(url.replace(/#.*$/s, "")));
  const now = Date.now();
  if (tab !== undefined) {
    const last = reads.looks.get(tab);
    if (last && last.page === page && now - last.at < SAME_LOOK_MS
      && (last.document === undefined || document === undefined || last.document === document)) return undefined;
    kept(reads.looks, tab, { page, document, at: now });
  }
  const seen = reads.kinds.get(kind) ?? kept(reads.kinds, kind, { reads: 0, pages: new Map(), offered: false });
  const before = seen.pages.get(page) ?? 0;
  kept(seen.pages, page, before + 1);
  if (++seen.reads < OFFER_AT || seen.offered) return undefined;
  seen.offered = true;
  return { kind, again: before > 0, last: seen.reads >= OFFER_AT + LOOKS - 1 };
}

export function deferred(owner: number, task: string, kind: string): void {
  const seen = owners.get(owner)?.get(task)?.kinds.get(kind);
  if (seen) seen.offered = false;
}
