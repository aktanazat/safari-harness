// X (x.com) for safari repl: the web app's own GraphQL and REST endpoints,
// called from the kit's background x.com tab so the owner's session goes
// with each request. x.com's security policy refuses page-world eval, so
// the calls run in the extension's content-script world: it reads the csrf
// cookie, the app's bearer token from its main bundle, and each operation's
// query id from the bundle that defines it (they change with every deploy),
// and none of those leave the tab. Every request also carries the
// x-client-transaction-id header the web app derives from the page; search
// answers 404 without it. Nothing here marks notifications or messages
// seen: the web app posts those cursors separately, and we never do.

import { draftOrSend, NotSignedIn, type SiteKit } from "./kit.ts";

const ORIGIN = "https://x.com";
const SITE = "x.com";

// A GraphQL operation as the bundle defines it, with the feature flags the
// web app would send (its own config decides each one). Cached per session.
type Op = { queryId: string; features: Record<string, boolean>; toggles: Record<string, boolean> };
// What the transaction-id header is derived from: the page's verification
// key and the animation key computed from its loading animation.
type Tx = { keyBytes: number[]; animationKey: string };

type GraphqlJob = { kind: "graphql"; name: string; hint: string; variables: Record<string, unknown>; mutation: boolean; op: Op | null; tx: Tx | null };
type RestJob = { kind: "rest"; method: string; path: string; query: Record<string, string>; body: string | null; tx: Tx | null };
type Reply = { signedOut?: boolean; status: number; body: unknown; op?: Op; tx?: Tx };

// Runs in the tab. Plain script: no template literals, nothing leaves but
// the response (and the op / tx records, which hold no secrets).
const PAGE = String.raw`
const cookie = (name) => (document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]+)")) || [])[1] || "";
const scripts = [...document.scripts];
const inline = scripts.filter((s) => !s.src).map((s) => s.textContent || "");
const text = async (url) => (await fetch(url)).text();
const mainUrl = scripts.map((s) => s.src).find((s) => /\/main\.[0-9a-f]+a?\.js$/.test(s)) || "";
// The webpack runtime maps chunk ids to names and to hashes; together they name a chunk's file.
const names = {}; const hashes = {};
for (const m of (inline.find((t) => t.includes('"a.js"')) || "").matchAll(/(\d+):"([^"]*)"/g)) { if (/^[0-9a-f]{16}$/.test(m[2])) hashes[m[1]] = m[2]; else names[m[1]] = m[2]; }
const chunkUrl = (id) => "https://abs.twimg.com/responsive-web/client-web/" + (names[id] || id) + "." + hashes[id] + "a.js";
const OP = /queryId:"([^"]+)",operationName:"([^"]+)",operationType:"[^"]+",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]\}/g;
const list = (s) => (s ? s.split(",").map((x) => x.slice(1, -1)) : []);
const opIn = (t, name) => { for (const m of t.matchAll(OP)) if (m[2] === name) return { queryId: m[1], switches: list(m[3]), toggles: list(m[4]) }; return null; };
const featureConfig = () => {
  const marker = "window.__INITIAL_STATE__=";
  const t = inline.find((s) => s.includes(marker)) || "";
  const s = t.slice(t.indexOf(marker) + marker.length);
  const end = s.indexOf(";window.");
  try { const state = JSON.parse(end > 0 ? s.slice(0, end) : s.replace(/;\s*$/, "")); return (state.featureSwitch && state.featureSwitch.user && state.featureSwitch.user.config) || {}; } catch { return {}; }
};
const findOp = async (name, hint) => {
  let op = opIn(await text(mainUrl), name);
  if (!op) {
    const ids = Object.keys(names).filter((id) => names[id].includes(hint)).sort((a, b) => names[a].length - names[b].length);
    for (const t of await Promise.all(ids.map((id) => text(chunkUrl(id))))) { op = opIn(t, name); if (op) break; }
  }
  if (!op) return null;
  const cfg = featureConfig();
  return { queryId: op.queryId, features: Object.fromEntries(op.switches.map((f) => [f, f in cfg && cfg[f].value === true])), toggles: Object.fromEntries(op.toggles.map((f) => [f, false])) };
};
const bearer = async () => { const m = (await text(mainUrl)).match(/"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{60,})"/); return m ? m[1] : ""; };
// The transaction id: the web app animates one row of its loading svg to a
// time picked by the verification key, hashes the result with the request
// line, and xors the key, time, and hash with a random byte.
const cubic = (c, time) => {
  if (time <= 0) { let g = 0; if (c[0] > 0) g = c[1] / c[0]; else if (c[1] === 0 && c[2] > 0) g = c[3] / c[2]; return g * time; }
  if (time >= 1) { let g = 0; if (c[2] < 1) g = (c[3] - 1) / (c[2] - 1); else if (c[2] === 1 && c[0] < 1) g = (c[1] - 1) / (c[0] - 1); return 1 + g * (time - 1); }
  const at = (a, b, m) => 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
  let start = 0; let end = 1; let mid = 0;
  while (start < end) { mid = (start + end) / 2; const x = at(c[0], c[2], mid); if (Math.abs(time - x) < 0.00001) return at(c[1], c[3], mid); if (x < time) start = mid; else end = mid; }
  return at(c[1], c[3], mid);
};
const scale = (value, min, max, whole) => { const r = (value * (max - min)) / 255 + min; return whole ? Math.floor(r) : Math.round(r * 100) / 100; };
const animationKey = (row, targetTime) => {
  const val = cubic(row.slice(7).map((v, i) => scale(v, i % 2 ? -1 : 0, 1, false)), targetTime);
  const color = [0, 1, 2].map((i) => Math.max(0, row[i] * (1 - val) + row[i + 3] * val));
  const rad = ((scale(row[6], 60, 360, true) * val) * Math.PI) / 180;
  const parts = color.map((v) => Math.round(v).toString(16));
  for (const m of [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)]) parts.push(Math.abs(Math.round(m * 100) / 100).toString(16));
  return parts.concat("0", "0").join("").replace(/[.-]/g, "");
};
const txSetup = async () => {
  const doc = new DOMParser().parseFromString(await (await fetch("https://x.com/home", { credentials: "include" })).text(), "text/html");
  const meta = doc.querySelector("meta[name=twitter-site-verification]");
  const keyBytes = [...atob(meta ? meta.getAttribute("content") : "")].map((ch) => ch.charCodeAt(0));
  const frames = [...doc.querySelectorAll("[id^=loading-x-anim]")];
  const odId = Object.keys(names).find((id) => names[id] === "ondemand.s");
  if (!keyBytes.length || frames.length < 4 || !odId) throw new Error("x.com changed its page: the transaction key inputs were not found");
  const idx = [...(await text(chunkUrl(odId))).matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)].map((m) => Number(m[1]));
  const rows = frames[keyBytes[5] % 4].children[0].children[1].getAttribute("d").slice(9).split("C").map((s) => s.replace(/[^\d]+/g, " ").trim().split(" ").map(Number));
  const frameTime = idx.slice(1).reduce((acc, i) => acc * (keyBytes[i] % 16), 1);
  return { keyBytes, animationKey: animationKey(rows[keyBytes[idx[0]] % 16], frameTime / 4096) };
};
const txId = async (tx, method, path) => {
  const now = Math.floor((Date.now() - 1682924400000) / 1000);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(method + "!" + path + "!" + now + "obfiowerehiring" + tx.animationKey)));
  const rnd = Math.floor(Math.random() * 256);
  const bytes = [...tx.keyBytes, ...[0, 1, 2, 3].map((i) => (now >> (i * 8)) & 0xff), ...hash.slice(0, 16), 3];
  return btoa(String.fromCharCode(rnd, ...bytes.map((b) => b ^ rnd))).replace(/=+$/, "");
};
const send = async (tx, method, path, query, body) => {
  const qs = Object.entries(query).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  const headers = { authorization: "Bearer " + (await bearer()), "x-csrf-token": cookie("ct0"), "x-twitter-auth-type": "OAuth2Session", "x-twitter-active-user": "yes", "x-client-transaction-id": await txId(tx, method, path) };
  if (body !== null) headers["content-type"] = body.startsWith("{") ? "application/json" : "application/x-www-form-urlencoded";
  const r = await fetch("https://x.com" + path + (qs ? "?" + qs : ""), { method, credentials: "include", headers, body: body === null ? undefined : body });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 500) }; }
};
const run = async (job) => {
  if (!cookie("twid")) return { signedOut: true, status: 0, body: null };
  const out = {};
  const tx = job.tx || (out.tx = await txSetup());
  if (job.kind === "rest") return Object.assign(await send(tx, job.method, job.path, job.query, job.body), out);
  const op = job.op || (out.op = await findOp(job.name, job.hint));
  if (!op) throw new Error("x.com's web app no longer defines the " + job.name + " operation");
  const path = "/i/api/graphql/" + op.queryId + "/" + job.name;
  const reply = job.mutation
    ? await send(tx, "POST", path, {}, JSON.stringify({ variables: job.variables, features: op.features, queryId: op.queryId }))
    : await send(tx, "GET", path, { variables: JSON.stringify(job.variables), features: JSON.stringify(op.features), fieldToggles: JSON.stringify(op.toggles) }, null);
  return Object.assign(reply, out);
};
`;

// ---------- shapes the endpoints answer with (only what we read) ----------

type RawUser = {
  rest_id?: string;
  is_blue_verified?: boolean;
  core?: { screen_name?: string; name?: string; created_at?: string };
  legacy?: { screen_name?: string; name?: string; description?: string; location?: string; url?: string; followers_count?: number; friends_count?: number; statuses_count?: number; created_at?: string; verified?: boolean; protected?: boolean; profile_image_url_https?: string };
  profile_bio?: { description?: string };
  location?: { location?: string };
  website?: { url?: string };
  relationship_counts?: { followers?: number; following?: number };
  tweet_counts?: { tweets?: number };
  verification?: { verified?: boolean };
  privacy?: { protected?: boolean };
  avatar?: { image_url?: string };
};

type RawTweet = {
  __typename?: string;
  rest_id?: string;
  tweet?: RawTweet;
  core?: { user_results?: { result?: RawUser } };
  legacy?: {
    full_text?: string;
    created_at?: string;
    favorite_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    bookmark_count?: number;
    in_reply_to_status_id_str?: string;
    entities?: { media?: { type?: string; media_url_https?: string; expanded_url?: string }[]; urls?: { url?: string; expanded_url?: string }[] };
    retweeted_status_result?: { result?: RawTweet };
  };
  note_tweet?: { note_tweet_results?: { result?: { text?: string } } };
  quoted_status_result?: { result?: RawTweet };
  views?: { count?: string };
};

type ItemContent = { itemType?: string; tweet_results?: { result?: RawTweet }; user_results?: { result?: RawUser } };
type Entry = { entryId?: string; content?: { entryType?: string; cursorType?: string; value?: string; itemContent?: ItemContent; items?: { item?: { itemContent?: ItemContent } }[] } };
type Instruction = { type?: string; entries?: Entry[]; entry?: Entry; moduleItems?: { item?: { itemContent?: ItemContent } }[] };

export type User = { id: string; handle: string; name: string; bio: string; location: string; website: string; followers: number; following: number; posts: number; createdAt: string; verified: boolean; protected: boolean; avatar: string };
export type Tweet = { id: string; url: string; author: { id: string; handle: string; name: string }; text: string; createdAt: string; replies: number; reposts: number; quotes: number; likes: number; bookmarks: number; views: number | null; inReplyTo?: string; repostOf?: Tweet; quoted?: Tweet; media?: { type: string; url: string }[] };
export type Timeline = { tweets: Tweet[]; users: User[]; nextCursor?: string };

const iso = (twitterDate: string | undefined): string => (twitterDate && !Number.isNaN(Date.parse(twitterDate)) ? new Date(twitterDate).toISOString() : "");

function user(u: RawUser): User {
  const l = u.legacy ?? {};
  return {
    id: u.rest_id ?? "",
    handle: u.core?.screen_name ?? l.screen_name ?? "",
    name: u.core?.name ?? l.name ?? "",
    bio: u.profile_bio?.description ?? l.description ?? "",
    location: u.location?.location ?? l.location ?? "",
    website: u.website?.url ?? l.url ?? "",
    followers: u.relationship_counts?.followers ?? l.followers_count ?? 0,
    following: u.relationship_counts?.following ?? l.friends_count ?? 0,
    posts: u.tweet_counts?.tweets ?? l.statuses_count ?? 0,
    createdAt: iso(u.core?.created_at ?? l.created_at),
    verified: u.is_blue_verified === true || u.verification?.verified === true || l.verified === true,
    protected: u.privacy?.protected === true || l.protected === true,
    avatar: u.avatar?.image_url ?? l.profile_image_url_https ?? "",
  };
}

// TweetWithVisibilityResults wraps the tweet; a tombstone has no legacy.
function tweet(raw: RawTweet): Tweet | null {
  const t = raw.tweet ?? raw;
  const l = t.legacy;
  if (!t.rest_id || !l) return null;
  const a = user(t.core?.user_results?.result ?? {});
  const media = (l.entities?.media ?? []).map((m) => ({ type: m.type ?? "", url: m.media_url_https ?? "" }));
  const repost = l.retweeted_status_result?.result ? tweet(l.retweeted_status_result.result) : null;
  const quoted = t.quoted_status_result?.result ? tweet(t.quoted_status_result.result) : null;
  // t.co links in the text read better expanded.
  let text = t.note_tweet?.note_tweet_results?.result?.text ?? l.full_text ?? "";
  for (const u of l.entities?.urls ?? []) if (u.url && u.expanded_url) text = text.replaceAll(u.url, u.expanded_url);
  return {
    id: t.rest_id,
    url: `https://x.com/${a.handle || "i"}/status/${t.rest_id}`,
    author: { id: a.id, handle: a.handle, name: a.name },
    text,
    createdAt: iso(l.created_at),
    replies: l.reply_count ?? 0,
    reposts: l.retweet_count ?? 0,
    quotes: l.quote_count ?? 0,
    likes: l.favorite_count ?? 0,
    bookmarks: l.bookmark_count ?? 0,
    views: t.views?.count ? Number(t.views.count) : null,
    ...(l.in_reply_to_status_id_str ? { inReplyTo: l.in_reply_to_status_id_str } : {}),
    ...(repost ? { repostOf: repost } : {}),
    ...(quoted ? { quoted } : {}),
    ...(media.length ? { media } : {}),
  };
}

// The instructions array, wherever the operation nests it.
function instructions(v: unknown, depth = 0): Instruction[] {
  if (!v || typeof v !== "object" || depth > 8) return [];
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.instructions)) return o.instructions as Instruction[];
  for (const x of Object.values(o)) { const r = instructions(x, depth + 1); if (r.length) return r; }
  return [];
}

function timeline(body: unknown): Timeline {
  const out: Timeline = { tweets: [], users: [] };
  const item = (c: ItemContent | undefined) => {
    const t = c?.tweet_results?.result ? tweet(c.tweet_results.result) : null;
    if (t) out.tweets.push(t);
    if (c?.user_results?.result) out.users.push(user(c.user_results.result));
  };
  for (const ins of instructions(body)) {
    for (const m of ins.moduleItems ?? []) item(m.item?.itemContent);
    for (const e of [...(ins.entries ?? []), ...(ins.entry ? [ins.entry] : [])]) {
      const c = e.content ?? {};
      if (c.entryType === "TimelineTimelineCursor" && c.cursorType === "Bottom" && c.value) out.nextCursor = c.value;
      item(c.itemContent);
      for (const i of c.items ?? []) item(i.item?.itemContent);
    }
  }
  return out;
}

const tweetId = (idOrUrl: string): string => {
  const m = /(?:^|\/status\/)(\d{5,})(?:[/?#]|$)/.exec(idOrUrl.trim());
  if (!m) throw new Error(`not a post id or url: ${idOrUrl}`);
  return m[1];
};
const handleOf = (h: string): string => h.trim().replace(/^@/, "").replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//, "").split(/[/?#]/)[0];

// ---------- DM inbox and notifications (REST) ----------

type RawInbox = { inbox_initial_state?: { cursor?: string; users?: Record<string, { name?: string; screen_name?: string }>; conversations?: Record<string, { conversation_id?: string; type?: string; name?: string; participants?: { user_id?: string }[]; last_read_event_id?: string; max_entry_id?: string; sort_timestamp?: string; muted?: boolean; read_only?: boolean; trusted?: boolean }>; entries?: { message?: { id?: string; time?: string; conversation_id?: string; message_data?: { sender_id?: string; text?: string } } }[] } };
type RawNotifications = {
  globalObjects?: { users?: Record<string, { screen_name?: string; name?: string }>; tweets?: Record<string, { full_text?: string; created_at?: string; user_id_str?: string; in_reply_to_status_id_str?: string }>; notifications?: Record<string, { id?: string; timestampMs?: string; icon?: { id?: string }; message?: { text?: string }; template?: { aggregateUserActionsV1?: { targetObjects?: { tweet?: { id?: string } }[]; fromUsers?: { user?: { id?: string } }[] } } }> };
  timeline?: { instructions?: { addEntries?: { entries?: { entryId?: string; content?: { item?: { content?: { notification?: { id?: string }; tweet?: { id?: string } } }; operation?: { cursor?: { value?: string; cursorType?: string } } } }[] } }[] };
};

export type Conversation = { id: string; type: string; name: string; participants: { id: string; handle: string; name: string }[]; unread: boolean; muted: boolean; lastMessage: { id: string; time: string; from: string; text: string } | null };
export type Notification = { id: string; time: string; kind: string; text: string; from: string[]; postId?: string };

const DM_QUERY = { nsfw_filtering_enabled: "false", filter_low_quality: "false", include_quality: "all", dm_secret_conversations_enabled: "false", krs_registration_enabled: "true", cards_platform: "Web-12", include_cards: "1", include_ext_alt_text: "true", include_ext_limited_action_results: "true", include_quote_count: "true", include_reply_count: "1", tweet_mode: "extended", include_ext_views: "true", dm_users: "false", include_groups: "true", include_inbox_timelines: "true", include_ext_media_color: "true", supports_reactions: "true", supports_edit: "true", include_ext_edit_control: "true", ext: "mediaColor,altText,mediaStats,highlightedLabel,voiceInfo,editControl,article" };

export function x(kit: SiteKit) {
  const ops = new Map<string, Op>();
  let tx: Tx | null = null;

  async function call(job: GraphqlJob | RestJob): Promise<unknown> {
    await kit.pace("x", 1000);
    const r = await kit.eval<Reply>(ORIGIN, `(async () => {${PAGE}\nreturn run(${JSON.stringify(job)});})()`);
    if (r.signedOut || r.status === 401) throw new NotSignedIn(SITE, r.signedOut ? "no session cookie" : "HTTP 401");
    if (r.tx) tx = r.tx;
    if (r.op && job.kind === "graphql") ops.set(job.name, r.op);
    const body = r.body as { errors?: { message?: string; code?: number }[]; data?: unknown } | string;
    const errors = typeof body === "object" && body.errors?.length ? body.errors.map((e) => e.message ?? String(e.code)).join("; ") : "";
    if (r.status === 429) throw new Error(`x.com rate-limited this request (HTTP 429); wait a few minutes`);
    if (r.status < 200 || r.status >= 300) throw new Error(`x.com answered HTTP ${r.status}${errors ? `: ${errors}` : typeof body === "string" ? `: ${body.slice(0, 200)}` : ""}`);
    if (typeof body === "object" && errors && body.data === undefined) throw new Error(`x.com refused the request: ${errors}`);
    return body;
  }

  const graphql = (name: string, hint: string, variables: Record<string, unknown>, mutation = false) => call({ kind: "graphql", name, hint, variables, mutation, op: ops.get(name) ?? null, tx });
  const rest = (method: string, path: string, query: Record<string, string> = {}, body: string | null = null) => call({ kind: "rest", method, path, query, body, tx });

  async function userByHandle(handle: string): Promise<User> {
    const h = handleOf(handle);
    const body = (await graphql("UserByScreenName", "Profile", { screen_name: h, withSafetyModeUserFields: true })) as { data?: { user?: { result?: RawUser } } };
    const raw = body.data?.user?.result;
    if (!raw?.rest_id) throw new Error(`no x.com user @${h}`);
    return user(raw);
  }

  // The owner's own user id is in the twid cookie, read inside the tab.
  const myId = async (): Promise<string> => {
    const id = await kit.eval<string>(ORIGIN, `decodeURIComponent((document.cookie.match(/(?:^|; )twid=([^;]+)/) || [])[1] || "").replace(/^u=/, "")`);
    if (!/^\d+$/.test(id)) throw new NotSignedIn(SITE, "no session cookie");
    return id;
  };

  async function page(name: string, hint: string, variables: Record<string, unknown>, count: number): Promise<Timeline> {
    const t = timeline(await graphql(name, hint, variables));
    // The home feed ignores count; trim to what was asked and keep the server's cursor.
    if (t.tweets.length > count) t.tweets = t.tweets.slice(0, count);
    return t;
  }

  return {
    // ----- reads -----
    async getMe(): Promise<User> {
      const body = (await graphql("UserByRestId", "Profile", { userId: await myId(), withSafetyModeUserFields: true })) as { data?: { user?: { result?: RawUser } } };
      const raw = body.data?.user?.result;
      if (!raw?.rest_id) throw new NotSignedIn(SITE, "the session's user was not found");
      return user(raw);
    },

    getUser: (handle: string): Promise<User> => userByHandle(handle),

    async getTweet(idOrUrl: string): Promise<Tweet> {
      const id = tweetId(idOrUrl);
      const body = (await graphql("TweetResultByRestId", "Conversation", { tweetId: id, withCommunity: false, includePromotedContent: false, withVoice: false })) as { data?: { tweetResult?: { result?: RawTweet } } };
      const t = body.data?.tweetResult?.result ? tweet(body.data.tweetResult.result) : null;
      if (!t) throw new Error(`post ${id} is not available (deleted, protected, or the id is wrong)`);
      return t;
    },

    // The Following feed, newest first.
    getTimeline(opts: { count?: number; cursor?: string } = {}): Promise<Timeline> {
      const count = opts.count ?? 20;
      return page("HomeLatestTimeline", "HomeTimeline", { count, ...(opts.cursor ? { cursor: opts.cursor } : {}), includePromotedContent: false, latestControlAvailable: true, requestContext: "launch" }, count);
    },

    // product: Top, Latest, People, Photos, or Videos. People answers in users.
    search(query: string, opts: { count?: number; cursor?: string; product?: "Top" | "Latest" | "People" | "Photos" | "Videos" } = {}): Promise<Timeline> {
      const count = opts.count ?? 20;
      return page("SearchTimeline", "Search", { rawQuery: query, count, ...(opts.cursor ? { cursor: opts.cursor } : {}), querySource: "typed_query", product: opts.product ?? "Latest" }, count);
    },

    async getUserTweets(handle: string, opts: { count?: number; cursor?: string } = {}): Promise<Timeline> {
      const h = handleOf(handle);
      const userId = /^\d+$/.test(h) ? h : (await userByHandle(h)).id;
      const count = opts.count ?? 20;
      return page("UserTweets", "Profile", { userId, count, ...(opts.cursor ? { cursor: opts.cursor } : {}), includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: true }, count);
    },

    getBookmarks(opts: { count?: number; cursor?: string } = {}): Promise<Timeline> {
      const count = opts.count ?? 20;
      return page("Bookmarks", "Bookmarks", { count, ...(opts.cursor ? { cursor: opts.cursor } : {}), includePromotedContent: false }, count);
    },

    // The inbox as the messages page first loads it; reading it does not
    // mark anything seen (the app posts that separately).
    async getDmInbox(): Promise<{ conversations: Conversation[] }> {
      const state = ((await rest("GET", "/i/api/1.1/dm/inbox_initial_state.json", DM_QUERY)) as RawInbox).inbox_initial_state ?? {};
      const users = state.users ?? {};
      const who = (id: string) => ({ id, handle: users[id]?.screen_name ?? "", name: users[id]?.name ?? "" });
      const last = new Map<string, { id: string; time: string; from: string; text: string }>();
      for (const e of state.entries ?? []) {
        const m = e.message;
        if (!m?.conversation_id || !m.id) continue;
        const seen = last.get(m.conversation_id);
        if (!seen || BigInt(m.id) > BigInt(seen.id)) last.set(m.conversation_id, { id: m.id, time: m.time ? new Date(Number(m.time)).toISOString() : "", from: who(m.message_data?.sender_id ?? "").handle, text: m.message_data?.text ?? "" });
      }
      const conversations = Object.values(state.conversations ?? {})
        .filter((c) => c.conversation_id)
        .sort((a, b) => Number(b.sort_timestamp ?? 0) - Number(a.sort_timestamp ?? 0))
        .map((c) => ({
          id: c.conversation_id ?? "",
          type: c.type ?? "",
          name: c.name ?? "",
          participants: (c.participants ?? []).map((p) => who(p.user_id ?? "")),
          unread: !!c.max_entry_id && !!c.last_read_event_id && BigInt(c.max_entry_id) > BigInt(c.last_read_event_id),
          muted: c.muted === true,
          lastMessage: last.get(c.conversation_id ?? "") ?? null,
        }));
      return { conversations };
    },

    // Recent notifications; the unseen marker is left alone.
    async getNotifications(opts: { count?: number; cursor?: string } = {}): Promise<{ notifications: Notification[]; nextCursor?: string }> {
      const body = (await rest("GET", "/i/api/2/notifications/all.json", { count: String(opts.count ?? 20), ...(opts.cursor ? { cursor: opts.cursor } : {}), include_ext_alt_text: "true", tweet_mode: "extended" })) as RawNotifications;
      const g = body.globalObjects ?? {};
      const handle = (id: string | undefined) => (id && g.users?.[id]?.screen_name) || "";
      const out: { notifications: Notification[]; nextCursor?: string } = { notifications: [] };
      for (const ins of body.timeline?.instructions ?? []) {
        for (const e of ins.addEntries?.entries ?? []) {
          const cur = e.content?.operation?.cursor;
          if (cur?.cursorType === "Bottom" && cur.value) out.nextCursor = cur.value;
          const n = e.content?.item?.content?.notification?.id ? g.notifications?.[e.content.item.content.notification.id] : undefined;
          if (n) {
            const agg = n.template?.aggregateUserActionsV1;
            const postId = agg?.targetObjects?.find((t) => t.tweet?.id)?.tweet?.id;
            out.notifications.push({ id: n.id ?? "", time: n.timestampMs ? new Date(Number(n.timestampMs)).toISOString() : "", kind: (n.icon?.id ?? "").replace(/_icon$/, ""), text: n.message?.text ?? "", from: (agg?.fromUsers ?? []).map((u) => handle(u.user?.id)).filter(Boolean), ...(postId ? { postId } : {}) });
          }
          const tid = e.content?.item?.content?.tweet?.id;
          const t = tid ? g.tweets?.[tid] : undefined;
          if (tid && t) out.notifications.push({ id: e.entryId ?? tid, time: iso(t.created_at), kind: t.in_reply_to_status_id_str ? "reply" : "mention", text: t.full_text ?? "", from: [handle(t.user_id_str)].filter(Boolean), postId: tid });
        }
      }
      return out;
    },

    // ----- writes: drafts until approved -----
    post(text: string, opts: { replyTo?: string; approved?: boolean } = {}) {
      const replyTo = opts.replyTo ? tweetId(opts.replyTo) : undefined;
      return draftOrSend({
        site: SITE,
        action: replyTo ? "reply" : "post",
        ...(replyTo ? { to: `https://x.com/i/status/${replyTo}` } : {}),
        text,
        approved: opts.approved,
        send: async () => {
          const body = (await graphql("CreateTweet", "Compose", { tweet_text: text, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo, exclude_reply_user_ids: [] } } : {}), dark_request: false, media: { media_entities: [], possibly_sensitive: false }, semantic_annotation_ids: [] }, true)) as { data?: { create_tweet?: { tweet_results?: { result?: RawTweet } } } };
          const t = body.data?.create_tweet?.tweet_results?.result ? tweet(body.data.create_tweet.tweet_results.result) : null;
          if (!t) throw new Error("x.com accepted the post but did not return it");
          return t;
        },
      });
    },

    like(idOrUrl: string, opts: { approved?: boolean } = {}) {
      const id = tweetId(idOrUrl);
      return draftOrSend({
        site: SITE,
        action: "like",
        to: `https://x.com/i/status/${id}`,
        text: `like post ${id}`,
        approved: opts.approved,
        send: async () => { await graphql("FavoriteTweet", "Compose", { tweet_id: id }, true); return { liked: id }; },
      });
    },

    follow(handle: string, opts: { approved?: boolean } = {}) {
      const h = handleOf(handle);
      return draftOrSend({
        site: SITE,
        action: "follow",
        to: `@${h}`,
        text: `follow @${h}`,
        approved: opts.approved,
        send: async () => {
          const u = await userByHandle(h);
          await rest("POST", "/i/api/1.1/friendships/create.json", {}, `include_profile_interstitial_type=1&skip_status=1&user_id=${u.id}`);
          return { followed: `@${u.handle}`, id: u.id };
        },
      });
    },

    // conversationOrHandle: a conversation id from getDmInbox, or a handle for a one-to-one chat.
    sendDm(conversationOrHandle: string, text: string, opts: { approved?: boolean } = {}) {
      const target = conversationOrHandle.trim();
      const isConversation = /^\d+(-\d+)?$/.test(target);
      return draftOrSend({
        site: SITE,
        action: "dm",
        to: isConversation ? `conversation ${target}` : `@${handleOf(target)}`,
        text,
        approved: opts.approved,
        send: async () => {
          let conversation = target;
          if (!isConversation) {
            const [mine, theirs] = [BigInt(await myId()), BigInt((await userByHandle(target)).id)];
            conversation = mine < theirs ? `${mine}-${theirs}` : `${theirs}-${mine}`;
          }
          const body = (await rest("POST", "/i/api/1.1/dm/new2.json", { ext: "mediaColor,altText,mediaStats,highlightedLabel,voiceInfo,editControl", include_ext_alt_text: "true", include_reply_count: "1", tweet_mode: "extended", include_groups: "true", include_inbox_timelines: "true", supports_reactions: "true" }, JSON.stringify({ conversation_id: conversation, recipient_ids: false, text, cards_platform: "Web-12", include_cards: 1, include_quote_count: true, dm_users: false }))) as { entries?: { message?: { id?: string } }[] };
          return { conversation, messageId: body.entries?.[0]?.message?.id ?? "" };
        },
      });
    },
  };
}
