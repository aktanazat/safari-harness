// Slack, through the owner's Safari session. The web client keeps a token
// per workspace in app.slack.com's localStorage (localConfig_v2), and the
// token only works beside the session cookie, which is HttpOnly: each call
// reads the token and sends the request in one expression in the page's
// own world, so the token never leaves the page. Requests go to
// app.slack.com/api, the page's own origin; workspace hosts refuse a
// credentialed request from it.

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
// there first, or SiteKit would open the origin's heavy root.
async function pageEval<T>(kit: SiteKit, expression: string): Promise<T> {
  await kit.tab(ORIGIN, PARK_URL);
  return kit.eval<T>(ORIGIN, expression, { page: true });
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
      const state = await kit.eval<{ url: string; teams: number }>(ORIGIN, BOOT_STATE_EXPR).catch(() => null);
      if (state && /\/(workspace-)?signin/.test(state.url)) throw new NotSignedIn(SITE);
      if (state && state.teams > 0) break;
      if (Date.now() > deadline) throw new Error(`Slack's client did not load in ${BOOT_MS / 1000} s`);
    }
  } finally {
    await kit.invoke("goto", { tab, url: PARK_URL }).catch(() => {});
  }
  return pageEval<Store>(kit, STORE_EXPR);
}

// The stored workspaces. An empty store means the owner is signed out, or
// signed in but has not opened Slack in Safari since the store was cleared:
// the landing page tells which, and the client is booted once for the latter.
async function readStore(kit: SiteKit): Promise<Store> {
  const store = await pageEval<Store>(kit, STORE_EXPR);
  if (store.teams.length) return store;
  const landing = await pageEval<{ url: string; sessions: number | null }>(kit, LANDING_EXPR);
  if (landing.sessions === 0) throw new NotSignedIn(SITE);
  return bootClient(kit);
}

// ---------- web API ----------

type ApiResponse = { ok: boolean; error?: string; needed?: string; response_metadata?: { next_cursor?: string } };
type Answer = { signedOut?: boolean; status: number; text: string; truncated: boolean };

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
    return { status: res.status, text: text.slice(0, ${MAX_RESPONSE}), truncated: text.length > ${MAX_RESPONSE} };
  })()`;
}

async function call<T>(kit: SiteKit, teamId: string, method: string, params: Record<string, unknown>): Promise<T & ApiResponse> {
  if (!/^[a-zA-Z][\w.]*$/.test(method)) throw new Error(`"${method}" is not a Slack method name`);
  await kit.pace("slack", PACE_MS);
  const answer = await pageEval<Answer>(kit, requestExpr(teamId, method, params));
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

type RawMessage = { ts: string; subtype?: string; user?: string; bot_id?: string; username?: string; text?: string; thread_ts?: string; reply_count?: number; reactions?: { name: string; count: number }[]; files?: { id: string; name?: string; title?: string; mimetype?: string }[]; attachments?: unknown[] };

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
    ...(m.files?.length ? { files: m.files.map((f) => ({ id: f.id, name: f.name ?? f.title ?? "", type: f.mimetype ?? "" })) } : {}),
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

    // Any web-API method that reads, with Slack's answer as is.
    api(method: string, params: Record<string, unknown> = {}) {
      const verb = method.slice(method.lastIndexOf(".") + 1);
      if (!READ_VERB.test(verb)) throw new Error(`${method} is not a read method; api() only reads (.list, .history, .replies, .info, .search, .get...). To post, use postMessage.`);
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
