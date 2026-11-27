// Reddit (www.reddit.com) for safari repl: threads and search, read-only.
// Reddit answers its .json addresses with 403 even from a browser tab
// (11-27, Ladybird, signed out), so this reads what its own pages draw. A thread is read from
// the page itself, loaded in the kit's background tab: a fetched copy of the
// page has the post but no comments, and the comment fragment alone holds
// only the first three top-level comments and no pager (11-27). Further
// comments and search results come from the HTML fragments the page posts
// for (/svc/shreddit/...), fetched and parsed in that tab. Requests go out
// at least 1 s apart, across every session.

import { rateLimited } from "../failures.ts";
import type { SiteKit } from "./kit.ts";

const ORIGIN = "https://www.reddit.com";
const SITE = "reddit.com";
// The kit's tab opens on a path Reddit has nothing for: its small
// not-found page, which carries the session like any other.
const PARK_URL = `${ORIGIN}/safari-repl`;
const GAP_MS = 1000;

// Runs in the tab. Plain script: no template literals.
const PAGE = String.raw`
const BLOCKS = "p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,tr";
// Reddit's refusals: its block page, and its rate-limit page.
const BLOCKED = /blocked by network security/i;
const LIMITED = /whoa there, pardner|too many requests/i;
const text = (el) => {
  if (!el) return "";
  const c = el.cloneNode(true);
  for (const b of c.querySelectorAll("br")) b.replaceWith("\n");
  for (const b of c.querySelectorAll(BLOCKS)) b.append("\n\n");
  return c.textContent.split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
};
const num = (v) => (v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : "");
const abs = (path) => (path ? new URL(path, location.origin).href : "");
// The slot of node's own, not one of a reply nested in it.
const own = (node, slot, tag) => [...node.querySelectorAll("[slot=" + slot + "]")].find((s) => s.closest(tag) === node);
// What a refusal page says, asked only of a page that holds nothing a
// read looks for: a post or comment may quote either refusal.
const refusal = (doc) => {
  const t = doc.title + " " + (doc.body ? doc.body.textContent.slice(0, 2000) : "");
  return LIMITED.test(t) ? 429 : BLOCKED.test(t) ? 403 : 0;
};
const post = (doc) => {
  const p = doc.querySelector("shreddit-post");
  if (!p) return null;
  const a = (n) => p.getAttribute(n);
  return {
    id: (a("id") || "").replace(/^t3_/, ""),
    url: abs(a("permalink")),
    subreddit: (a("subreddit-prefixed-name") || "").replace(/^r\//, ""),
    title: a("post-title") || "",
    author: a("author") || "",
    createdAt: iso(a("created-timestamp")),
    score: num(a("score")),
    upvoteRatio: num(a("upvote-ratio")),
    comments: num(a("comment-count")),
    type: a("post-type") || "",
    link: a("post-type") === "link" ? a("content-href") || "" : "",
    text: text(p.querySelector("shreddit-post-text-body") || own(p, "text-body", "shreddit-post")),
  };
};
const comments = (doc) => [...doc.querySelectorAll("shreddit-comment")].map((c) => {
  const a = (n) => c.getAttribute(n);
  const parent = (a("parentid") || "").replace(/^t[13]_/, "");
  return Object.assign({
    id: (a("thingid") || "").replace(/^t1_/, ""),
    depth: num(a("depth")) || 0,
    author: a("author") || "",
    createdAt: iso(a("created")),
    score: num(a("score")),
    url: abs(a("permalink")),
    text: text(own(c, "comment", "shreddit-comment")),
  }, parent ? { parentId: parent } : {});
});
// The "more replies" fragments, and the one that loads the next top-level comments.
const more = (doc) => [...doc.querySelectorAll("faceplate-partial[src*='/more-comments/']")].map((p) => ({ src: p.getAttribute("src"), cursor: (p.querySelector("input[name=cursor]") || {}).value || "", top: /[?&]top-level=1/.test(p.getAttribute("src")) }));
// Reply chains Reddit moves to a page of their own ("97 more replies" links), which no fragment loads.
const held = (doc) => !!doc.querySelector("[slot=more-comments-permalink]");
// One search result per post: the first element whose tracking context names it holds the rest.
const results = (doc) => {
  const roots = new Map();
  for (const n of doc.querySelectorAll("[data-faceplate-tracking-context]")) {
    let ctx;
    try { ctx = JSON.parse(n.getAttribute("data-faceplate-tracking-context")); } catch { continue; }
    const id = ctx && ctx.post && ctx.post.id;
    if (id && !roots.has(id)) roots.set(id, { node: n, ctx });
  }
  return [...roots.values()].map(({ node, ctx }) => {
    const id = ctx.post.id.replace(/^t3_/, "");
    const link = node.querySelector("a[href*='/comments/" + id + "/']");
    let score = null;
    let count = null;
    for (const f of node.querySelectorAll("faceplate-number")) {
      const label = (f.parentElement ? f.parentElement.textContent : "").toLowerCase();
      if (/vote/.test(label)) score = num(f.getAttribute("number"));
      else if (/comment/.test(label)) count = num(f.getAttribute("number"));
    }
    const time = node.querySelector("faceplate-timeago");
    return {
      id,
      url: abs(link ? link.getAttribute("href").split("?")[0] : "/comments/" + id + "/"),
      subreddit: (ctx.subreddit && ctx.subreddit.name) || "",
      title: ctx.post.title || "",
      author: (ctx.profile && ctx.profile.name) || "",
      createdAt: iso(time && time.getAttribute("ts")),
      score,
      comments: count,
    };
  });
};
const run = async (job) => {
  if (job.kind === "page") {
    // goto can answer while a long thread's HTML still streams in (11-27:
    // a 3,474-comment thread had no post element yet).
    if (document.readyState === "loading") await new Promise((done) => document.addEventListener("DOMContentLoaded", done, { once: true }));
    const p = post(document);
    const refused = p ? 0 : refusal(document);
    if (refused) return { status: refused, blocked: refused === 403 };
    return { status: 200, url: location.href, post: p, comments: comments(document), more: more(document), held: held(document) };
  }
  const init = job.cursor === undefined ? { credentials: "include" } : { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "cursor=" + encodeURIComponent(job.cursor) };
  const r = await fetch(job.url, init);
  const html = await r.text();
  const out = { status: r.status, url: r.url, retryAfter: r.headers.get("retry-after") };
  if (r.status !== 200) return Object.assign(out, { blocked: BLOCKED.test(html) });
  if (job.kind === "resolve") return out;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (job.kind === "more") {
    const found = { comments: comments(doc), more: more(doc), held: held(doc) };
    const refused = found.comments.length || found.more.length ? 0 : refusal(doc);
    return refused ? Object.assign(out, { status: refused, blocked: refused === 403 }) : Object.assign(out, found);
  }
  const found = results(doc);
  const refused = found.length ? 0 : refusal(doc);
  if (refused) return Object.assign(out, { status: refused, blocked: refused === 403 });
  const next = doc.querySelector("faceplate-partial[src*='cursor=']");
  return Object.assign(out, { results: found, next: next ? next.getAttribute("src") : null });
};
`;

export type Post = { id: string; url: string; subreddit: string; title: string; author: string; createdAt: string; score: number | null; upvoteRatio: number | null; comments: number | null; type: string; link: string; text: string };
// parentId: the comment it answers; a top-level comment has none.
export type Comment = { id: string; parentId?: string; depth: number; author: string; createdAt: string; score: number | null; url: string; text: string };
// more: Reddit holds comments this read did not reach.
export type Thread = { post: Post; comments: Comment[]; more: boolean };
export type SearchResult = { id: string; url: string; subreddit: string; title: string; author: string; createdAt: string; score: number | null; comments: number | null };

type Pager = { src: string; cursor: string; top: boolean };
type Job = { kind: "page" } | { kind: "resolve" | "search"; url: string } | { kind: "more"; url: string; cursor: string };
type Reply = { status: number; url?: string; retryAfter?: string | null; blocked?: boolean; post?: Post | null; comments?: Comment[]; more?: Pager[]; held?: boolean; results?: SearchResult[]; next?: string | null };
type SearchOptions = { subreddit?: string; sort?: "relevance" | "hot" | "top" | "new" | "comments"; time?: "hour" | "day" | "week" | "month" | "year" | "all"; limit?: number; cursor?: string };

const SORTS = { best: "confidence", top: "top", new: "new", controversial: "controversial", old: "old", qa: "qa" } as const;
export type CommentSort = keyof typeof SORTS;

const POST_URL = /^https?:\/\/(?:[\w-]+\.)?reddit\.com\/(?:(?:r|u|user)\/[^/]+\/)?comments\/([a-z0-9]+)/i;
const SHORT_URL = /^https?:\/\/redd\.it\/([a-z0-9]+)/i;
const SHARE_URL = /^https?:\/\/(?:[\w-]+\.)?reddit\.com\/(?:r|u|user)\/[^/]+\/s\/[A-Za-z0-9]+/i;
const BARE_ID = /^(?:t3_)?([a-z0-9]{4,12})$/i;
const postId = (s: string): string | undefined => (POST_URL.exec(s) ?? SHORT_URL.exec(s) ?? BARE_ID.exec(s))?.[1].toLowerCase();

export function reddit(kit: SiteKit) {
  async function call(job: Job): Promise<Reply> {
    await kit.tab(ORIGIN, PARK_URL);
    // Reading the page the tab already holds asks Reddit nothing.
    if (job.kind !== "page") await kit.turn(SITE, GAP_MS);
    const r = await kit.eval<Reply>(ORIGIN, `(async () => {${PAGE}\nreturn run(${JSON.stringify(job)});})()`, { read: true });
    const limit = await kit.limited(SITE, r.status, (name) => (name === "retry-after" ? r.retryAfter : undefined));
    if (limit) throw rateLimited(limit.host, limit.resetAt, limit.guessed);
    if (r.blocked) throw new Error(`${SITE} blocked the read ("You've been blocked by network security")`);
    if (r.status !== 200) throw new Error(`${SITE} answered HTTP ${r.status}`);
    return r;
  }

  // The post a share link (/r/<sub>/s/<code>) leads to: Reddit redirects it.
  async function resolve(input: string): Promise<string> {
    const s = input.trim();
    const id = postId(s) ?? (SHARE_URL.test(s) ? postId((await call({ kind: "resolve", url: s })).url ?? "") : undefined);
    if (!id) throw new Error(`not a Reddit post url or id: ${input}`);
    return id;
  }

  // One read at a time: getThread moves the tab to its thread, which pulls
  // the page out from under any other read in flight (11-27: three
  // getThread calls at once each read another's page, or none).
  let lane: Promise<unknown> = Promise.resolve();
  function inLane<T>(read: () => Promise<T>): Promise<T> {
    const run = lane.then(read);
    lane = run.catch(() => undefined);
    return run;
  }

  async function thread(postUrlOrId: string, opts: { sort?: CommentSort; limit?: number }): Promise<Thread> {
    const id = await resolve(postUrlOrId);
    const limit = opts.limit ?? 50;
    const tab = await kit.tab(ORIGIN, PARK_URL);
    await kit.turn(SITE, GAP_MS);
    await kit.invoke("goto", { tab, url: `${ORIGIN}/comments/${id}/?sort=${SORTS[opts.sort ?? "top"]}` });
    const first = await call({ kind: "page" });
    if (!first.post) throw new Error(`no Reddit post ${id}: the tab, at ${first.url}, shows none (deleted, private, or the id is wrong)`);
    if (first.post.id !== id) throw new Error(`Reddit showed post ${first.post.id} for ${id}, at ${first.url}`);
    const seen = new Set<string>();
    const comments: Comment[] = [];
    const add = (list: Comment[] = []) => { for (const c of list) if (!seen.has(c.id)) { seen.add(c.id); comments.push(c); } };
    add(first.comments);
    let held = first.held === true;
    // The next top-level page goes before folded replies. A fragment can
    // draw a pager already asked; asked again, it would be asked forever.
    const queue: Pager[] = [];
    const asked = new Set<string>();
    const enqueue = (list: Pager[] = []) => {
      for (const p of list) {
        const key = `${p.src}\n${p.cursor}`;
        if (asked.has(key)) continue;
        asked.add(key);
        if (p.top) queue.unshift(p);
        else queue.push(p);
      }
    };
    enqueue(first.more);
    while (comments.length < limit) {
      const p = queue.shift();
      if (!p) break;
      const page = await call({ kind: "more", url: p.src, cursor: p.cursor });
      add(page.comments);
      enqueue(page.more);
      held ||= page.held === true;
    }
    return { post: first.post, comments: comments.slice(0, limit), more: queue.length > 0 || comments.length > limit || held };
  }

  async function search(query: string, opts: SearchOptions): Promise<{ results: SearchResult[]; nextCursor?: string }> {
    const limit = opts.limit ?? 25;
    const sub = opts.subreddit?.trim().replace(/^\/?r\//i, "").replace(/\/$/, "");
    if (sub !== undefined && !/^\w{2,21}$/.test(sub)) throw new Error(`not a subreddit name: ${opts.subreddit}`);
    // The path as fetch will resolve it, so ../ cannot leave the fragments.
    if (opts.cursor !== undefined && !new URL(opts.cursor, ORIGIN).pathname.startsWith("/svc/shreddit/")) throw new Error(`not a cursor from reddit.search: ${opts.cursor}`);
    const q = new URLSearchParams({ q: query, type: "posts", sort: opts.sort ?? "relevance", t: opts.time ?? "all", ...(sub ? { restrict_sr: "1" } : {}) });
    let url: string | undefined = opts.cursor ?? `/svc/shreddit/${sub ? `r/${sub}/` : ""}search/?${q}`;
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    while (url && results.length < limit) {
      const page = await call({ kind: "search", url });
      const fresh = (page.results ?? []).filter((r) => !seen.has(r.id));
      for (const r of fresh) { seen.add(r.id); results.push(r); }
      // A page that adds nothing new would be asked for again forever.
      url = fresh.length && page.next ? page.next : undefined;
    }
    return { results: results.slice(0, limit), ...(url ? { nextCursor: url } : {}) };
  }

  return {
    // The post and its comments in Reddit's order for sort, up to limit:
    // the page's own first comments, then the next top-level ones, then
    // the replies Reddit folds behind "more replies". A reply loaded later
    // comes after the comment it answers; parentId and depth place it.
    getThread: (postUrlOrId: string, opts: { sort?: CommentSort; limit?: number } = {}): Promise<Thread> => inLane(() => thread(postUrlOrId, opts)),
    // Posts for query in Reddit's order, up to limit; cursor (an answer's
    // nextCursor) reads on from where that answer stopped.
    search: (query: string, opts: SearchOptions = {}): Promise<{ results: SearchResult[]; nextCursor?: string }> => inLane(() => search(query, opts)),
  };
}
