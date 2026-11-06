// Slack, through the owner's Safari session. The web client keeps a token
// per workspace in app.slack.com's localStorage (localConfig_v2), and the
// token only works beside the session cookie, which is HttpOnly: each call
// reads the token and sends the request in one expression in the page's
// own world, so the token never leaves the page. Requests go to
// app.slack.com/api, the page's own origin; workspace hosts refuse a
// credentialed request from it. A file's bytes come from files.slack.com,
// fetched from the same tab with the cookie alone.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { rateLimited } from "../failures.ts";
import { NotSignedIn, draftOrSend, type SiteKit } from "./kit.ts";

const SITE = "Slack";
const ORIGIN = "https://app.slack.com";
// The tab parks on a page that costs almost nothing: this path does not
// exist, so Slack serves its small "glitch" page, on the origin whose
// localStorage the client fills. The client itself forbids eval in its page
// and weighs hundreds of megabytes, so it is booted only to fill an empty
// store, then left again.
const PARK_URL = `${ORIGIN}/safari-repl`;
const CLIENT_URL = `${ORIGIN}/client`;
const BOOT_MS = 60_000;
const MAX_RESPONSE = 2_000_000;
const PACE_MS = 200;
// Slack answers a burst with HTTP 429 and, in Retry-After, the seconds to
// wait: every agent waits them (pace.ts), and the request goes again,
// TRIES times in all. A page reads only four of files.slack.com's headers
// (content-type among them, 10-07), so a file's 429 may come without one:
// the wait starts at RETRY_MS then.
const TRIES = 3;
const RETRY_MS = 5_000;
// The most a download takes, as the REPL's own fetch: the bytes cross the
// bridge as base64.
const FILE_MAX = 50_000_000;

export type Workspace = { teamId: string; name: string; domain: string; url: string; userId: string | null; signedIn: boolean; lastActive: boolean };
type Store = { lastActiveTeamId: string | null; teams: Workspace[] };

// The stored workspaces, without their tokens.
const STORE_EXPR = `(() => {
  let store = null;
  try { store = JSON.parse(localStorage.getItem("localConfig_v2") || "null"); } catch {}
  const teams = store && store.teams && typeof store.teams === "object" ? Object.values(store.teams) : [];
  const last = store && typeof store.lastActiveTeamId === "string" ? store.lastActiveTeamId : null;
  return {
    lastActiveTeamId: last,
    teams: teams.filter((t) => t && typeof t.id === "string").map((t) => ({
      teamId: t.id,
      name: String(t.name || ""),
      domain: String(t.domain || ""),
      url: String(t.url || (t.domain ? "https://" + t.domain + ".slack.com/" : "")),
      userId: typeof t.user_id === "string" ? t.user_id : null,
      signedIn: typeof t.token === "string" && t.token.length > 0,
      lastActive: t.id === last,
    })),
  };
})()`;

// app.slack.com's landing page counts the signed-in sessions of the cookie.
const LANDING_EXPR = `(async () => {
  const res = await fetch(${JSON.stringify(`${ORIGIN}/`)}, { credentials: "include" });
  const m = /num_signed_in_users\\s*=\\s*(\\d+)/.exec(await res.text());
  return { url: res.url, sessions: m ? Number(m[1]) : null };
})()`;

// Where the tab is and whether the store is filled, for the extension's
// world: the client's page forbids eval.
const BOOT_STATE_EXPR = `(() => {
  let teams = 0;
  try { const store = JSON.parse(localStorage.getItem("localConfig_v2") || "null"); teams = store && store.teams ? Object.keys(store.teams).length : 0; } catch {}
  return { url: location.href, teams };
})()`;

// Every page-world evaluation happens on the parked page; the tab is opened
// there first, or SiteKit would open the origin's heavy root. read: it only
// reads, so it may run twice (kit.ts eval).
async function pageEval<T>(kit: SiteKit, expression: string, read = false): Promise<T> {
  await kit.tab(ORIGIN, PARK_URL);
  return kit.eval<T>(ORIGIN, expression, { page: true, read });
}

// Boots the client in the background tab until it has stored the
// workspaces, then parks the tab again. Landing on workspace-signin means
// Slack wants a sign-in.
async function bootClient(kit: SiteKit): Promise<Store> {
  const tab = await kit.tab(ORIGIN, PARK_URL);
  await pageEval(kit, `location.assign(${JSON.stringify(CLIENT_URL)})`);
  try {
    const deadline = Date.now() + BOOT_MS;
    for (;;) {
      await Bun.sleep(1000);
      const state = await kit.eval<{ url: string; teams: number }>(ORIGIN, BOOT_STATE_EXPR, { read: true }).catch(() => null);
      if (state && /\/(workspace-)?signin/.test(state.url)) throw new NotSignedIn(SITE);
      if (state && state.teams > 0) break;
      if (Date.now() > deadline) throw new Error(`Slack's client did not load in ${BOOT_MS / 1000} s`);
    }
  } finally {
    await kit.invoke("goto", { tab, url: PARK_URL }).catch(() => {});
  }
  return pageEval<Store>(kit, STORE_EXPR, true);
}

// The stored workspaces. An empty store means the owner is signed out, or
// signed in but has not opened Slack in Safari since the store was cleared:
// the landing page tells which, and the client is booted once for the latter.
async function readStore(kit: SiteKit): Promise<Store> {
  const store = await pageEval<Store>(kit, STORE_EXPR, true);
  if (store.teams.length) return store;
  const landing = await pageEval<{ url: string; sessions: number | null }>(kit, LANDING_EXPR, true);
  if (landing.sessions === 0) throw new NotSignedIn(SITE);
  return bootClient(kit);
}

// ---------- web API ----------

type ApiResponse = { ok: boolean; error?: string; needed?: string; response_metadata?: { next_cursor?: string } };
type Answer = { signedOut?: boolean; status: number; retryAfter?: string | null; text: string; truncated: boolean };

// Slack's answers when the token or cookie no longer works.
const SESSION_ERRORS: Record<string, true> = { invalid_auth: true, not_authed: true, account_inactive: true, token_revoked: true, token_expired: true };

// A web-API method reads when its last segment is one of these verbs; api()
// refuses the rest, so nothing that posts, marks, or sets goes through it.
const READ_VERB = /^(list|history|replies|info|\w+Info|search|get|get[A-Z]\w*|lookupByEmail|identity|test|members|messages|files|all|conversations)$/;

function requestExpr(teamId: string, method: string, params: Record<string, unknown>): string {
  return `(async () => {
    let store = null;
    try { store = JSON.parse(localStorage.getItem("localConfig_v2") || "null"); } catch {}
    const team = store && store.teams ? store.teams[${JSON.stringify(teamId)}] : null;
    if (!team || typeof team.token !== "string" || !team.token) return { signedOut: true, status: 0, text: "", truncated: false };
    const body = new FormData();
    for (const [k, v] of Object.entries(${JSON.stringify(params)})) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
    body.set("token", team.token);
    const res = await fetch(${JSON.stringify(`${ORIGIN}/api/${method}`)}, { method: "POST", body, credentials: "include" });
    const text = await res.text();
    return { status: res.status, retryAfter: res.headers.get("retry-after"), text: text.slice(0, ${MAX_RESPONSE}), truncated: text.length > ${MAX_RESPONSE} };
  })()`;
}

// One request to host in its turn (PACE_MS apart), sent again after a 429
// once the wait Slack names has passed: on 10-07 a burst of Akyl's image
// downloads drew one.
async function paced<T extends { status: number; retryAfter?: string | null }>(kit: SiteKit, host: string, send: () => Promise<T>): Promise<T> {
  for (let tried = 1; ; tried++) {
    await kit.turn(host, PACE_MS);
    const answer = await send();
    const limit = await kit.limited(host, answer.status, (name) => (name === "retry-after" ? answer.retryAfter : null), undefined, RETRY_MS);
    if (!limit) return answer;
    if (tried === TRIES) throw rateLimited(limit.host, limit.resetAt, limit.guessed);
  }
}

async function call<T>(kit: SiteKit, teamId: string, method: string, params: Record<string, unknown>): Promise<T & ApiResponse> {
  if (!/^[a-zA-Z][\w.]*$/.test(method)) throw new Error(`"${method}" is not a Slack method name`);
  const read = READ_VERB.test(method.slice(method.lastIndexOf(".") + 1));
  const answer = await paced(kit, ORIGIN, () => pageEval<Answer>(kit, requestExpr(teamId, method, params), read));
  if (answer.signedOut) throw new NotSignedIn(SITE, `workspace ${teamId} has no session`);
  if (answer.status === 401 || answer.status === 403) throw new NotSignedIn(SITE, `HTTP ${answer.status}`);
  if (answer.truncated) throw new Error(`Slack's ${method} answer is longer than ${MAX_RESPONSE} characters; ask for fewer items`);
  let data: T & ApiResponse;
  try {
    data = JSON.parse(answer.text) as T & ApiResponse;
  } catch {
    throw new Error(`Slack ${method} did not answer with JSON (HTTP ${answer.status}): ${answer.text.slice(0, 200)}`);
  }
  if (!data.ok) {
    const error = data.error ?? "unknown_error";
    if (SESSION_ERRORS[error]) throw new NotSignedIn(SITE, error);
    throw new Error(`Slack ${method} failed: ${error}${data.needed ? ` (needs ${data.needed})` : ""}`);
  }
  return data;
}

function limit(v: unknown, dflt: number, max: number): number {
  return Math.min(Math.max(Number(v ?? dflt), 1), max);
}

// ---------- compact shapes ----------

type RawChannel = { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_archived?: boolean; is_member?: boolean; user?: string; num_members?: number; topic?: { value?: string }; purpose?: { value?: string } };

function channel(c: RawChannel) {
  return {
    id: c.id,
    ...(c.name ? { name: c.name } : {}),
    kind: c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private ? "private" : "public",
    ...(c.user ? { user: c.user } : {}),
    ...(c.is_member !== undefined ? { member: c.is_member } : {}),
    ...(c.is_archived ? { archived: true } : {}),
    ...(c.num_members !== undefined ? { members: c.num_members } : {}),
    ...(c.topic?.value ? { topic: c.topic.value } : {}),
    ...(c.purpose?.value ? { purpose: c.purpose.value } : {}),
  };
}

type RawFile = { id: string; name?: string; title?: string; mimetype?: string; size?: number; user?: string; url_private?: string; url_private_download?: string };

// A file as history and replies list it, with what download needs: its
// address and size. Until 10-07 only id, name and type came, and each
// download cost a files.info call first.
type SlackFile = { id: string; name: string; type: string; size?: number; url?: string };

function fileOf(f: RawFile): SlackFile {
  const url = f.url_private_download ?? f.url_private;
  return { id: f.id, name: f.name ?? f.title ?? "", type: f.mimetype ?? "", ...(f.size === undefined ? {} : { size: f.size }), ...(url ? { url } : {}) };
}

// The fetch tool's answer with base64: true (content.js pageFetch).
type FileAnswer = { status: number; type: string | null; headers?: [string, string][]; data: string; truncated: boolean };

type RawMessage = { ts: string; subtype?: string; user?: string; bot_id?: string; username?: string; text?: string; thread_ts?: string; reply_count?: number; reactions?: { name: string; count: number }[]; files?: RawFile[]; attachments?: unknown[] };

function message(m: RawMessage) {
  return {
    ts: m.ts,
    ...(m.user ? { user: m.user } : {}),
    ...(m.bot_id ? { botId: m.bot_id } : {}),
    ...(m.username ? { username: m.username } : {}),
    ...(m.subtype ? { subtype: m.subtype } : {}),
    text: m.text ?? "",
    ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
    ...(m.reply_count ? { replyCount: m.reply_count } : {}),
    ...(m.reactions?.length ? { reactions: m.reactions.map((r) => ({ name: r.name, count: r.count })) } : {}),
    ...(m.files?.length ? { files: m.files.map(fileOf) } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments.length } : {}),
  };
}

type RawMatch = { ts: string; text?: string; user?: string; username?: string; permalink?: string; channel?: { id: string; name?: string } };

type RawUser = { id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; is_admin?: boolean; tz?: string; profile?: { display_name?: string; real_name?: string; title?: string; email?: string; status_text?: string } };

function user(u: RawUser) {
  return {
    id: u.id,
    name: u.name ?? "",
    realName: u.real_name ?? u.profile?.real_name ?? "",
    ...(u.profile?.display_name ? { displayName: u.profile.display_name } : {}),
    ...(u.profile?.title ? { title: u.profile.title } : {}),
    ...(u.profile?.email ? { email: u.profile.email } : {}),
    ...(u.profile?.status_text ? { status: u.profile.status_text } : {}),
    ...(u.tz ? { tz: u.tz } : {}),
    ...(u.is_bot ? { bot: true } : {}),
    ...(u.is_admin ? { admin: true } : {}),
    ...(u.deleted ? { deleted: true } : {}),
  };
}

// ---------- client ----------

function client(kit: SiteKit, workspace: Workspace) {
  const api = <T>(method: string, params: Record<string, unknown>) => call<T>(kit, workspace.teamId, method, params);
  // The message at ts, as history lists it. A thread reply is not in its
  // channel's history: name its thread's ts as thread_ts.
  const messageAt = async (channel: string, ts: string, opts: { thread_ts?: string } = {}) => {
    const top = await api<{ messages: RawMessage[] }>("conversations.history", { channel, latest: ts, oldest: ts, inclusive: true, limit: 1 });
    let found = top.messages.find((m) => m.ts === ts);
    if (!found && opts.thread_ts) found = (await api<{ messages: RawMessage[] }>("conversations.replies", { channel, ts: opts.thread_ts, limit: 1000 })).messages.find((m) => m.ts === ts);
    if (!found) throw new Error(`no message ${ts} in ${channel}${opts.thread_ts ? ` or its thread ${opts.thread_ts}` : "; a thread reply needs its thread's ts as thread_ts"}`);
    return message(found);
  };
  return {
    workspace,

    async conversations(opts: { types?: string; limit?: number; cursor?: string } = {}) {
      const r = await api<{ channels: RawChannel[] }>("conversations.list", { types: opts.types ?? "public_channel,private_channel,mpim,im", exclude_archived: true, limit: limit(opts.limit, 100, 1000), cursor: opts.cursor });
      return { channels: r.channels.map(channel), nextCursor: r.response_metadata?.next_cursor || null };
    },

    async history(channel: string, opts: { limit?: number; oldest?: string; latest?: string; cursor?: string } = {}) {
      const r = await api<{ messages: RawMessage[]; has_more?: boolean }>("conversations.history", { channel, limit: limit(opts.limit, 50, 1000), oldest: opts.oldest, latest: opts.latest, cursor: opts.cursor });
      return { messages: r.messages.map(message), hasMore: !!r.has_more, nextCursor: r.response_metadata?.next_cursor || null };
    },

    async replies(channel: string, ts: string, opts: { limit?: number; cursor?: string } = {}) {
      const r = await api<{ messages: RawMessage[]; has_more?: boolean }>("conversations.replies", { channel, ts, limit: limit(opts.limit, 50, 1000), cursor: opts.cursor });
      return { messages: r.messages.map(message), hasMore: !!r.has_more, nextCursor: r.response_metadata?.next_cursor || null };
    },

    async search(query: string, opts: { count?: number; page?: number } = {}) {
      const r = await api<{ messages: { matches: RawMatch[]; paging?: { total?: number; page?: number; pages?: number } } }>("search.messages", { query, count: limit(opts.count, 20, 100), page: opts.page ?? 1 });
      const { matches, paging } = r.messages;
      return {
        total: paging?.total ?? matches.length,
        page: paging?.page ?? 1,
        pages: paging?.pages ?? 1,
        matches: matches.map((m) => ({
          ts: m.ts,
          ...(m.channel ? { channel: m.channel.id, ...(m.channel.name ? { channelName: m.channel.name } : {}) } : {}),
          ...(m.user ? { user: m.user } : {}),
          ...(m.username ? { username: m.username } : {}),
          text: m.text ?? "",
          ...(m.permalink ? { permalink: m.permalink } : {}),
        })),
      };
    },

    async users(opts: { limit?: number; cursor?: string } = {}) {
      const r = await api<{ members: RawUser[] }>("users.list", { limit: limit(opts.limit, 200, 1000), cursor: opts.cursor });
      return { members: r.members.map(user), nextCursor: r.response_metadata?.next_cursor || null };
    },

    async userInfo(userId: string) {
      return user((await api<{ user: RawUser }>("users.info", { user: userId })).user);
    },

    // Saves a file of a message at out (a relative path begins in the
    // session's folder) and answers {path, size, type}. file is one that
    // history or replies listed, which carries its address, or a file id,
    // which costs a files.info call first. A web page in place of its
    // bytes (Slack's sign-in page) fails, and nothing is saved.
    async download(file: string | SlackFile, out: string) {
      if (typeof out !== "string" || !out) throw new Error("download needs out, the path to save the file at");
      const f = typeof file !== "string" && file.url ? file : fileOf((await api<{ file: RawFile }>("files.info", { file: typeof file === "string" ? file : file.id })).file);
      const url = f.url;
      if (!url) throw new Error(`Slack has no copy of file ${f.id} to download`);
      if ((f.size ?? 0) > FILE_MAX) throw new Error(`file ${f.id} has ${f.size} bytes; download takes at most ${FILE_MAX}`);
      const tab = await kit.tab(ORIGIN, PARK_URL);
      const got = await paced(kit, url, async () => {
        const r = (await kit.invoke("fetch", { tab, url, base64: true, maxBytes: FILE_MAX })) as FileAnswer;
        return { ...r, retryAfter: r.headers?.find(([name]) => name.toLowerCase() === "retry-after")?.[1] ?? null };
      });
      if (got.status !== 200) throw new Error(`Slack answered HTTP ${got.status} for file ${f.id}`);
      const type = (got.type ?? f.type).split(";")[0].trim();
      if (/^text\/html$/i.test(type) && !/^text\/html\b/i.test(f.type)) throw new Error(`Slack answered a web page for file ${f.id}, not its ${f.type || "bytes"}: its sign-in page, most likely; nothing was saved`);
      if (got.truncated) throw new Error(`file ${f.id} has more than ${FILE_MAX} bytes; download takes at most that`);
      const bytes = Buffer.from(got.data, "base64");
      const path = resolve(kit.cwd, out);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return { path, size: bytes.length, type };
    },

    // Any web-API method that reads, with Slack's answer as is.
    api(method: string, params: Record<string, unknown> = {}) {
      const verb = method.slice(method.lastIndexOf(".") + 1);
      if (!READ_VERB.test(verb)) throw new Error(`${method} is not a read method; api() only reads (.list, .history, .replies, .info, .search, .get...). To write, use postMessage, postThread, update, delete, react or upload.`);
      return api<unknown>(method, params);
    },

    postMessage(channel: string, text: string, opts: { thread_ts?: string; approved?: boolean } = {}) {
      return draftOrSend({
        site: "slack",
        action: opts.thread_ts ? `reply in thread ${opts.thread_ts} of ${channel}` : `post in ${channel}`,
        to: channel,
        text,
        approved: opts.approved,
        send: async () => {
          const r = await api<{ ts: string; channel: string }>("chat.postMessage", { channel, text, thread_ts: opts.thread_ts });
          return { ts: r.ts, channel: r.channel };
        },
      });
    },

    messageAt,

    // Edits a message the owner wrote. The draft shows the text it replaces
    // as was, so the owner approves the change, not just the new text.
    async update(channel: string, ts: string, text: string, opts: { thread_ts?: string; approved?: boolean } = {}) {
      const was = (await messageAt(channel, ts, opts)).text;
      const out = await draftOrSend({
        site: "slack",
        action: `edit message ${ts} in ${channel}`,
        to: channel,
        text,
        approved: opts.approved,
        send: async () => {
          const r = await api<{ ts: string; channel: string }>("chat.update", { channel, ts, text });
          return { ts: r.ts, channel: r.channel };
        },
      });
      return { ...out, was };
    },

    // Deletes a message the owner wrote; the draft's text is the message
    // that would go. An admin may delete others' messages, for good: only
    // the owner's own are taken.
    async delete(channel: string, ts: string, opts: { thread_ts?: string; approved?: boolean } = {}) {
      const gone = await messageAt(channel, ts, opts);
      if (!workspace.userId || gone.user !== workspace.userId) throw new Error(`message ${ts} in ${channel} is not the owner's (its author is ${gone.user ?? "unknown"}); delete takes only his own messages`);
      return draftOrSend({
        site: "slack",
        action: `delete message ${ts} in ${channel}${gone.replyCount ? ` (its ${gone.replyCount} thread replies stay)` : ""}`,
        to: channel,
        text: gone.text,
        approved: opts.approved,
        send: async () => {
          await api("chat.delete", { channel, ts });
          return { ts, channel, deleted: true };
        },
      });
    },

    // A top message and its thread replies, approved and posted as one: the
    // replies go under the top message's ts.
    postThread(channel: string, text: string, replies: string[], opts: { approved?: boolean } = {}) {
      if (!Array.isArray(replies) || replies.some((r) => typeof r !== "string" || !r)) throw new Error("postThread needs replies, a list of non-empty texts");
      return draftOrSend({
        site: "slack",
        action: `post in ${channel} with ${replies.length} thread repl${replies.length === 1 ? "y" : "ies"}`,
        to: channel,
        text: [text, ...replies.map((r, i) => `--- thread reply ${i + 1} ---\n${r}`)].join("\n"),
        approved: opts.approved,
        send: async () => {
          const top = await api<{ ts: string; channel: string }>("chat.postMessage", { channel, text });
          const done: string[] = [];
          for (const reply of replies) {
            try {
              done.push((await api<{ ts: string }>("chat.postMessage", { channel: top.channel, text: reply, thread_ts: top.ts })).ts);
            } catch (e) {
              throw new Error(`postThread posted the top message ${top.ts} in ${top.channel} and ${done.length} of ${replies.length} replies, then failed: ${e instanceof Error ? e.message : String(e)}. Do not call postThread again: post the remaining approved replies with postMessage("${top.channel}", text, { thread_ts: "${top.ts}" })`);
            }
          }
          return { ts: top.ts, channel: top.channel, replies: done };
        },
      });
    },

    // Deletes a file the owner shared (F…); deleting the message that
    // carried it leaves the file in his files. The draft names the file.
    async deleteFile(file: string, opts: { approved?: boolean } = {}) {
      const raw = (await api<{ file: RawFile }>("files.info", { file })).file;
      if (!workspace.userId || raw.user !== workspace.userId) throw new Error(`file ${raw.id} is not the owner's (its uploader is ${raw.user ?? "unknown"}); deleteFile takes only his own files`);
      const f = fileOf(raw);
      return draftOrSend({
        site: "slack",
        action: `delete file ${f.id}`,
        text: `${f.name} (${f.type}${f.size === undefined ? "" : `, ${f.size} bytes`})`,
        approved: opts.approved,
        send: async () => {
          await api("files.delete", { file: f.id });
          return { file: f.id, deleted: true };
        },
      });
    },

    // Adds an emoji reaction (name without colons) as the owner. The draft
    // shows the message it goes on.
    async react(channel: string, ts: string, name: string, opts: { thread_ts?: string; approved?: boolean } = {}) {
      const emoji = name.replace(/^:|:$/g, "");
      const on = await messageAt(channel, ts, opts);
      return draftOrSend({
        site: "slack",
        action: `react to ${ts} in ${channel}`,
        to: channel,
        text: `:${emoji}:\n--- on the message ---\n${on.text}`,
        approved: opts.approved,
        send: async () => {
          await api("reactions.add", { channel, timestamp: ts, name: emoji });
          return { ts, channel, reaction: emoji };
        },
      });
    },

    // Uploads a local file (a relative path begins in the session's
    // folder) to a channel or thread through Slack's external upload: one
    // address to send the bytes to, then one call that shares the file.
    async upload(channel: string, path: string, opts: { thread_ts?: string; title?: string; comment?: string; approved?: boolean } = {}) {
      const file = resolve(kit.cwd, path);
      const bytes = await readFile(file);
      if (bytes.length > FILE_MAX) throw new Error(`${file} has ${bytes.length} bytes; upload takes at most ${FILE_MAX}`);
      const name = basename(file);
      return draftOrSend({
        site: "slack",
        action: `upload ${file} (${bytes.length} bytes) ${opts.thread_ts ? `in thread ${opts.thread_ts} of` : "to"} ${channel}`,
        to: channel,
        text: opts.comment ?? "",
        approved: opts.approved,
        send: async () => {
          const slot = await api<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", { filename: name, length: bytes.length });
          const sent = await paced(kit, new URL(slot.upload_url).origin, async () => {
            const res = await fetch(slot.upload_url, { method: "POST", body: bytes });
            return { status: res.status, retryAfter: res.headers.get("retry-after") };
          });
          if (sent.status !== 200) throw new Error(`Slack's upload address answered HTTP ${sent.status}; the file was not shared`);
          const shared = await api<{ files: { id: string; permalink?: string }[] }>("files.completeUploadExternal", {
            files: [{ id: slot.file_id, title: opts.title ?? name }],
            channel_id: channel,
            ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
            ...(opts.comment ? { initial_comment: opts.comment } : {}),
          });
          return { file: slot.file_id, channel, ...(shared.files[0]?.permalink ? { permalink: shared.files[0].permalink } : {}) };
        },
      });
    },

    // A channel's latest messages with each thread's replies after its
    // parent, kept when match (a RegExp, or text matched case-insensitively)
    // is in the text: one call for a history loop plus a replies call per
    // thread.
    async scan(channel: string, opts: { limit?: number; match?: RegExp | string; threads?: boolean } = {}) {
      const re = opts.match === undefined ? null : opts.match instanceof RegExp ? new RegExp(opts.match.source, opts.match.flags.replace(/[gy]/g, "")) : new RegExp(opts.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const top = await api<{ messages: RawMessage[] }>("conversations.history", { channel, limit: limit(opts.limit, 50, 1000) });
      const raw: RawMessage[] = [];
      for (const m of top.messages) {
        raw.push(m);
        if (opts.threads !== false && m.reply_count) raw.push(...(await api<{ messages: RawMessage[] }>("conversations.replies", { channel, ts: m.ts, limit: 1000 })).messages.slice(1));
      }
      return { messages: raw.filter((m) => !re || re.test(m.text ?? "")).map(message) };
    },
  };
}

export function slack(kit: SiteKit) {
  return {
    async listWorkspaces(): Promise<Workspace[]> {
      return (await readStore(kit)).teams;
    },

    // teamId may also be the workspace's domain; without it, the workspace
    // the owner used last, or the first stored one.
    async getClient(teamId?: string) {
      const { teams } = await readStore(kit);
      const team = teamId ? teams.find((t) => t.teamId === teamId || t.domain === teamId) : (teams.find((t) => t.lastActive) ?? teams[0]);
      if (!team) throw new Error(`no workspace "${teamId}" in Safari; listWorkspaces() has ${teams.map((t) => `${t.name} (${t.teamId})`).join(", ")}`);
      if (!team.signedIn) throw new NotSignedIn(SITE, `workspace ${team.name} needs a fresh sign-in`);
      return client(kit, team);
    },
  };
}
