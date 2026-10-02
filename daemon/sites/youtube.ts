// YouTube for the REPL: search, video metadata, transcripts, and comments,
// read through the same private API the YouTube page uses (/youtubei/v1),
// called from a background tab of the kit's own. The calls carry the tab's
// cookies but not the account signature header the page adds, so YouTube
// answers them as signed out: nothing lands in the owner's search or watch
// history. The player endpoint, which the watch page uses, is never called.

import type { SiteKit } from "./kit.ts";

const ORIGIN = "https://www.youtube.com";
// The kit's tab opens on the lightest page that still carries the app and
// its config: the watch layout with no video in it.
const TAB_URL = `${ORIGIN}/watch?v=00000000000`;

type Json = { [key: string]: unknown };

const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Walks a.b.c through objects and arrays (a number step indexes an array).
function at(v: unknown, ...path: (string | number)[]): unknown {
  let cur = v;
  for (const p of path) {
    cur = typeof p === "number" ? arr(cur)[p] : obj(cur)?.[p];
    if (cur === undefined) return undefined;
  }
  return cur;
}

// YouTube writes text as {simpleText}, {runs: [{text}]}, or {content}.
function text(v: unknown): string {
  const o = obj(v);
  if (!o) return "";
  return str(o.simpleText) ?? str(o.content) ?? arr(o.runs).map((r) => str(obj(r)?.text) ?? "").join("");
}

// "1,234,567 views" -> 1234567; "1.2K" and other rounded forms stay undefined.
function count(s: string): number | undefined {
  const m = /^[\d,]+/.exec(s.trim());
  return m ? Number(m[0].replace(/,/g, "")) : undefined;
}

// "1:02:03" -> 3723
function seconds(clock: string): number | undefined {
  if (!/^\d+(:\d+)+$/.test(clock.trim())) return undefined;
  return clock.trim().split(":").reduce((total, n) => total * 60 + Number(n), 0);
}

// A video id from an id, a watch/shorts/live/embed URL, or youtu.be.
export function videoId(idOrUrl: string): string {
  const s = idOrUrl.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`not a YouTube video id or URL: ${idOrUrl}`);
  }
  const id = u.searchParams.get("v") ?? (u.hostname === "youtu.be" ? u.pathname.slice(1) : /^\/(?:shorts|live|embed|v)\/([\w-]{11})/.exec(u.pathname)?.[1]) ?? "";
  if (!/^[\w-]{11}$/.test(id)) throw new Error(`no video id in ${idOrUrl}`);
  return id;
}

// ---------- the API ----------

// One /youtubei/v1 call made by the page itself, with the key and client
// context from its ytcfg. drop names branches of the answer to leave in the
// page (related videos and the like run to a megabyte).
async function innertube(kit: SiteKit, endpoint: string, body: Json, drop: string[] = []): Promise<Json> {
  const expression = `(async () => {
    if (typeof ytcfg === "undefined") throw new Error("the YouTube page did not load its config");
    const key = ytcfg.get("INNERTUBE_API_KEY");
    const ctx = ytcfg.get("INNERTUBE_CONTEXT") || {};
    const context = { client: ctx.client, user: ctx.user, request: ctx.request };
    const endpoint = ${JSON.stringify(endpoint)};
    const res = await fetch("/youtubei/v1/" + endpoint + "?prettyPrint=false&key=" + encodeURIComponent(key), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Youtube-Client-Name": String(ytcfg.get("INNERTUBE_CONTEXT_CLIENT_NAME") || 1), "X-Youtube-Client-Version": String(ctx.client && ctx.client.clientVersion) },
      body: JSON.stringify(Object.assign({ context }, ${JSON.stringify(body)})),
    });
    const text = await res.text();
    if (!res.ok) throw new Error("YouTube answered HTTP " + res.status + " for " + endpoint + ": " + text.slice(0, 200));
    const out = JSON.parse(text);
    for (const path of ${JSON.stringify(drop)}) {
      const keys = path.split(".");
      const last = keys.pop();
      const parent = keys.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), out);
      if (parent && typeof parent === "object") delete parent[last];
    }
    return out;
  })()`;
  await kit.tab(ORIGIN, TAB_URL);
  const out = obj(await kit.eval(ORIGIN, expression, { page: true }));
  if (!out) throw new Error(`YouTube ${endpoint} gave no data`);
  return out;
}

const NEXT_DROP = ["contents.twoColumnWatchNextResults.secondaryResults", "contents.twoColumnWatchNextResults.autoplay", "playerOverlays", "topbar", "frameworkUpdates", "responseContext"];
const SEARCH_DROP = ["topbar", "header", "refinements", "frameworkUpdates", "responseContext"];
const COMMENTS_DROP = ["topbar", "responseContext"];

export type VideoHit = { videoId: string; url: string; title: string; channel: string; duration: string; durationSeconds?: number; views?: number; viewsText: string; published: string };

function videoHit(v: Json): VideoHit {
  const id = str(v.videoId) ?? "";
  const duration = text(v.lengthText);
  const viewsText = text(v.viewCountText);
  return { videoId: id, url: `${ORIGIN}/watch?v=${id}`, title: text(v.title), channel: text(v.ownerText) || text(v.longBylineText), duration, durationSeconds: seconds(duration), views: count(viewsText), viewsText, published: text(v.publishedTimeText) };
}

// The search endpoint: first page as sections, later pages as continuation
// items; both hold videoRenderers and a continuation token.
async function searchPage(kit: SiteKit, body: Json): Promise<{ hits: VideoHit[]; next?: string }> {
  const res = await innertube(kit, "search", body, SEARCH_DROP);
  const sections = body.continuation === undefined
    ? arr(at(res, "contents", "twoColumnSearchResultsRenderer", "primaryContents", "sectionListRenderer", "contents"))
    : arr(res.onResponseReceivedCommands).flatMap((c) => arr(at(c, "appendContinuationItemsAction", "continuationItems")));
  const hits: VideoHit[] = [];
  let next: string | undefined;
  for (const section of sections) {
    for (const item of arr(at(section, "itemSectionRenderer", "contents"))) {
      const v = obj(at(item, "videoRenderer"));
      if (v && str(v.videoId)) hits.push(videoHit(v));
    }
    next = str(at(section, "continuationItemRenderer", "continuationEndpoint", "continuationCommand", "token")) ?? next;
  }
  return { hits, next };
}

// ---------- transcripts ----------

// The transcript panel's language menu carries one params string per
// track: a protobuf whose field 2 is a base64 protobuf of {1: "asr" for
// auto-generated, 2: language code}. This reads those two fields.
function protoFields(bytes: Uint8Array): Map<number, Uint8Array | number> {
  const fields = new Map<number, Uint8Array | number>();
  let i = 0;
  const varint = () => {
    let n = 0;
    let shift = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      n += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (b < 0x80) break;
    }
    return n;
  };
  while (i < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) fields.set(field, varint());
    else if (wire === 2) {
      const len = varint();
      fields.set(field, bytes.subarray(i, i + len));
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break;
  }
  return fields;
}

function trackOf(params: string): { lang: string; auto: boolean } | undefined {
  try {
    const outer = protoFields(Uint8Array.from(atob(decodeURIComponent(params)), (c) => c.charCodeAt(0)));
    const inner = outer.get(2);
    if (!(inner instanceof Uint8Array)) return undefined;
    const track = protoFields(Uint8Array.from(atob(decodeURIComponent(new TextDecoder().decode(inner))), (c) => c.charCodeAt(0)));
    const kind = track.get(1);
    const lang = track.get(2);
    if (!(lang instanceof Uint8Array)) return undefined;
    return { lang: new TextDecoder().decode(lang), auto: kind instanceof Uint8Array && new TextDecoder().decode(kind) === "asr" };
  } catch {
    return undefined;
  }
}

export type TranscriptLanguage = { lang: string; name: string; auto: boolean; selected: boolean };
export type TranscriptSegment = { start: number; end: number; text: string };
export type Transcript = { videoId: string; lang: string; name: string; auto: boolean; segments: TranscriptSegment[]; text: string };

// Since late 2025 the transcript endpoint only answers requests the page
// itself attests, so transcripts come from the watch page's own transcript
// panel, opened in the kit's tab the way a reader opens it. Before the tab
// ever reaches a real watch page, media playback is switched off in it,
// so the player never starts and nothing lands in watch history; the page
// then navigates itself to the video, as a click on a link would, which
// keeps that switch (a reload would drop it).
const NO_PLAY = `if (!window.__safariHarnessNoPlay) {
  window.__safariHarnessNoPlay = true;
  HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException("playback is off in this helper tab", "NotAllowedError")); };
}`;

const TRANSCRIPT_PANEL = "engagement-panel-searchable-transcript";
const PANEL = `ytd-engagement-panel-section-list-renderer[target-id="${TRANSCRIPT_PANEL}"]`;
const SHOW_BUTTON = (flexy: string) => `${flexy} ytd-video-description-transcript-section-renderer button`;

// Waits in the page until cond (an expression) gives a value, watching the
// DOM rather than a timer: Safari slows a hidden tab's timers down.
const until = (cond: string, ms: number) => `(() => {
  const { promise, resolve } = Promise.withResolvers();
  const value = () => { try { return ${cond}; } catch { return null; } };
  const finish = (v) => { watcher.disconnect(); clearTimeout(timer); resolve(v); };
  const watcher = new MutationObserver(() => { const v = value(); if (v) finish(v); });
  const timer = setTimeout(() => finish(null), ${ms});
  const first = value();
  if (first) finish(first);
  else watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  return promise;
})()`;

// The panel's data, trimmed: each segment's times and text, the language
// menu, and the first segment's target (video id, track, times), which
// tells whose transcript the panel holds.
const PANEL_DATA = `(() => {
  const list = document.querySelector("ytd-transcript-segment-list-renderer");
  const footer = document.querySelector("ytd-transcript-footer-renderer");
  const rows = (list && list.data && list.data.initialSegments) || [];
  const segments = rows.map((r) => r.transcriptSegmentRenderer).filter(Boolean);
  if (!segments.length) return null;
  const menu = (footer && footer.data && footer.data.languageMenu && footer.data.languageMenu.sortFilterSubMenuRenderer && footer.data.languageMenu.sortFilterSubMenuRenderer.subMenuItems) || [];
  return {
    first: String(segments[0].targetId || ""),
    segments: segments.map((s) => ({ start: s.startMs, end: s.endMs, text: ((s.snippet && s.snippet.runs) || []).map((x) => x.text).join("") })),
    menu: menu.map((m) => ({ title: m.title, selected: m.selected === true, params: m.continuation && m.continuation.reloadContinuationData && m.continuation.reloadContinuationData.continuation })),
  };
})()`;

type Panel = { segments: TranscriptSegment[]; languages: TranscriptLanguage[] };

function panelOf(raw: unknown): Panel {
  const segments: TranscriptSegment[] = [];
  for (const s of arr(at(raw, "segments"))) {
    const seg = obj(s);
    if (seg) segments.push({ start: Number(seg.start) / 1000, end: Number(seg.end) / 1000, text: (str(seg.text) ?? "").replace(/\s+/g, " ").trim() });
  }
  const languages: TranscriptLanguage[] = [];
  for (const m of arr(at(raw, "menu"))) {
    const item = obj(m);
    if (!item) continue;
    const name = str(item.title) ?? "";
    const track = trackOf(str(item.params) ?? "");
    languages.push({ lang: track?.lang ?? "", name, auto: track?.auto ?? /auto/i.test(name), selected: item.selected === true });
  }
  return { segments, languages };
}

// Reads the panel once it holds this video's transcript (it keeps the last
// video's until the new one arrives), or the track chosen after `was`.
async function readPanel(kit: SiteKit, id: string, was = ""): Promise<Panel> {
  const ours = `d && d.first.startsWith(${JSON.stringify(`${id}.`)}) && d.first !== ${JSON.stringify(was)}`;
  const raw = await kit.eval(ORIGIN, until(`(() => { const d = ${PANEL_DATA}; return ${ours} ? d : null; })()`, 20000), { page: true });
  if (!raw) throw new Error(`the transcript panel for YouTube video ${id} did not fill in time`);
  return panelOf(raw);
}

// Opens the video's transcript panel in the kit's tab and reads it.
async function openTranscript(kit: SiteKit, id: string): Promise<Panel> {
  await kit.tab(ORIGIN, TAB_URL);
  const flexy = `ytd-watch-flexy[video-id=${JSON.stringify(id)}]`;
  const go = `(() => {
    ${NO_PLAY}
    if (location.pathname === "/watch" && new URLSearchParams(location.search).get("v") === ${JSON.stringify(id)}) return "there";
    const app = document.querySelector("ytd-app");
    if (!app || typeof app.resolveCommand !== "function") throw new Error("the YouTube page did not load its app");
    setTimeout(() => app.resolveCommand({ watchEndpoint: { videoId: ${JSON.stringify(id)} }, commandMetadata: { webCommandMetadata: { url: ${JSON.stringify(`/watch?v=${id}`)}, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } } }), 0);
    return "going";
  })()`;
  // A new tab's app is still rendering its own first page for a moment
  // after it opens, and drops a navigation asked for before then: the page
  // lands back on the empty watch layout. The app's own watch data in the
  // page marks the end of that.
  const settled = await kit.eval(ORIGIN, until(`(() => { const page = document.querySelector("ytd-watch-flexy"); return page && page.data && "settled"; })()`, 15000), { page: true });
  if (!settled) throw new Error("the YouTube page did not finish loading in time");
  // The helper's own wait tool talks to the tab's content script, which
  // Safari may hold up across the app's navigation, so the waiting happens
  // in the page. The app sometimes drops a navigation asked for while it
  // is still settling: asking again is what a second click would do.
  let loaded: unknown = null;
  for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
    await kit.eval(ORIGIN, go, { page: true });
    loaded = await kit.eval(ORIGIN, until(`document.querySelector(${JSON.stringify(`${flexy} ytd-watch-metadata`)}) && "loaded"`, 15000), { page: true });
  }
  if (!loaded) throw new Error(`the YouTube watch page for ${id} did not load in time`);
  // Whether the video has a transcript comes from the watch data the page
  // renders, not from the DOM: the last video's description, its
  // transcript button included, stays in the page for a moment after the
  // new video's title shows.
  const state = await kit.eval<{ transcript: boolean; blocked: boolean }>(ORIGIN, until(`(() => {
    const page = document.querySelector(${JSON.stringify(flexy)});
    const data = page && page.data;
    const watch = data && data.currentVideoEndpoint && data.currentVideoEndpoint.watchEndpoint;
    if (!watch || watch.videoId !== ${JSON.stringify(id)}) return null;
    const transcript = (data.engagementPanels || []).some((p) => p.engagementPanelSectionListRenderer && p.engagementPanelSectionListRenderer.targetId === ${JSON.stringify(TRANSCRIPT_PANEL)});
    if (transcript && !document.querySelector(${JSON.stringify(SHOW_BUTTON(flexy))})) return null;
    return { transcript, blocked: !!window.__safariHarnessNoPlay };
  })()`, 10000), { page: true });
  if (!state) throw new Error(`the YouTube watch page for ${id} did not finish loading in time`);
  if (!state.transcript) throw new Error(`YouTube video ${id} has no transcript`);
  // a page the app reloaded rather than navigated has lost the playback
  // switch, and the player may have started: stop it, then say so
  if (!state.blocked) {
    await kit.eval(ORIGIN, `(() => { ${NO_PLAY} const player = document.getElementById("movie_player"); if (player && typeof player.pauseVideo === "function") player.pauseVideo(); })()`, { page: true });
    throw new Error(`the YouTube tab reloaded on its way to ${id}, which may have started the video; try again`);
  }
  await kit.eval(ORIGIN, `(() => {
    const panel = document.querySelector(${JSON.stringify(PANEL)});
    const d = ${PANEL_DATA};
    const open = panel && panel.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
    // a panel left open from the last video does not refill by itself
    if (open && !(d && d.first.startsWith(${JSON.stringify(`${id}.`)}))) { const close = panel.querySelector("#visibility-button button"); if (close) close.click(); }
    else if (open) return;
    document.querySelector(${JSON.stringify(SHOW_BUTTON(flexy))}).click();
  })()`, { page: true });
  return readPanel(kit, id);
}

// Picks another track in the panel's language menu and waits for it.
async function switchTrack(kit: SiteKit, id: string, name: string): Promise<Panel> {
  const was = await kit.eval<string>(ORIGIN, `(() => {
    const footer = document.querySelector("ytd-transcript-footer-renderer");
    const item = footer && [...footer.querySelectorAll("tp-yt-paper-item")].find((e) => e.textContent.trim() === ${JSON.stringify(name)});
    if (!item) throw new Error("the transcript language menu has no " + ${JSON.stringify(name)});
    const d = ${PANEL_DATA};
    item.click();
    return d ? d.first : "";
  })()`, { page: true });
  const panel = await readPanel(kit, id, was);
  if (!panel.languages.some((l) => l.selected && l.name === name)) throw new Error(`YouTube did not switch the transcript to ${name}`);
  return panel;
}

// ---------- comments ----------

export type Comment = { id: string; author: string; channelId?: string; text: string; likes: string; published: string; replies?: string; url: string };
export type Comments = { videoId: string; comments: Comment[]; continuation?: string };

// Comments arrive as commentThreadRenderers that point, by key, at
// commentEntityPayloads in frameworkUpdates, where the author, text, and
// counts are.
function commentsPage(id: string, res: Json): Comments {
  const entities = new Map<string, Json>();
  for (const m of arr(at(res, "frameworkUpdates", "entityBatchUpdate", "mutations"))) {
    const key = str(at(m, "entityKey"));
    const payload = obj(at(m, "payload", "commentEntityPayload"));
    if (key && payload) entities.set(key, payload);
  }
  const items = arr(res.onResponseReceivedEndpoints).flatMap((e) => [...arr(at(e, "reloadContinuationItemsCommand", "continuationItems")), ...arr(at(e, "appendContinuationItemsAction", "continuationItems"))]);
  const comments: Comment[] = [];
  let continuation: string | undefined;
  for (const item of items) {
    const key = str(at(item, "commentThreadRenderer", "commentViewModel", "commentViewModel", "commentKey"));
    const c = key === undefined ? undefined : entities.get(key);
    if (c) {
      const commentId = str(at(c, "properties", "commentId")) ?? "";
      comments.push({
        id: commentId,
        author: str(at(c, "author", "displayName")) ?? "",
        channelId: str(at(c, "author", "channelId")),
        text: text(at(c, "properties", "content")),
        likes: str(at(c, "toolbar", "likeCountNotliked")) ?? "",
        published: str(at(c, "properties", "publishedTime")) ?? "",
        replies: str(at(c, "toolbar", "replyCount")) || undefined,
        url: `${ORIGIN}/watch?v=${id}&lc=${commentId}`,
      });
    }
    // the page's own "load more" token, at the end of the list
    continuation = str(at(item, "continuationItemRenderer", "continuationEndpoint", "continuationCommand", "token")) ?? str(at(item, "continuationItemRenderer", "button", "buttonRenderer", "command", "continuationCommand", "token")) ?? continuation;
  }
  return { videoId: id, comments, ...(continuation === undefined ? {} : { continuation }) };
}

// ---------- metadata ----------

export type Chapter = { title: string; start: number; startText: string };
export type VideoMetadata = {
  videoId: string; url: string; title: string; channel: string; channelUrl?: string; description: string;
  duration?: string; durationSeconds?: number; views?: number; viewsText: string; likes?: string; published: string; publishedRelative?: string; live: boolean; chapters: Chapter[];
};

export function youtube(kit: SiteKit) {
  // The watch page's "next" call: everything about a video except its
  // player: title, owner, description, counts, chapters, the comments
  // token, and the transcript token.
  const next = (id: string) => innertube(kit, "next", { videoId: id }, NEXT_DROP);

  return {
    // Videos matching query, in YouTube's order; limit defaults to 10.
    async search(query: string, opts: { limit?: number } = {}): Promise<VideoHit[]> {
      const limit = opts.limit ?? 10;
      const hits: VideoHit[] = [];
      // EgIQAQ== is the "videos only" filter, as the page sends it.
      let body: Json = { query, params: "EgIQAQ==" };
      while (hits.length < limit) {
        const page = await searchPage(kit, body);
        hits.push(...page.hits);
        if (!page.next || page.hits.length === 0) break;
        body = { continuation: page.next };
      }
      return hits.slice(0, limit);
    },

    // Title, channel, description, counts, date, and chapters. The length
    // comes from a search for the id, since the watch data does not carry
    // it and the player endpoint is left alone.
    async getMetadata(idOrUrl: string): Promise<VideoMetadata> {
      const id = videoId(idOrUrl);
      // one page call at a time: the tab runs them in turn anyway
      const res = await next(id);
      const rows = arr(at(res, "contents", "twoColumnWatchNextResults", "results", "results", "contents"));
      const primary = obj(rows.map((r) => at(r, "videoPrimaryInfoRenderer")).find(Boolean));
      const secondary = obj(rows.map((r) => at(r, "videoSecondaryInfoRenderer")).find(Boolean));
      if (!primary) {
        const note = text(at(rows, 0, "messageRenderer", "text"));
        throw new Error(`YouTube has no watch data for video ${id}${note ? `: ${note}` : ""}`);
      }
      const found = await searchPage(kit, { query: id, params: "EgIQAQ==" });
      const owner = obj(at(secondary, "owner", "videoOwnerRenderer"));
      const handle = str(at(owner, "navigationEndpoint", "browseEndpoint", "canonicalBaseUrl"));
      const viewsText = text(at(primary, "viewCount", "videoViewCountRenderer", "viewCount"));
      const chapters: Chapter[] = [];
      for (const p of arr(res.engagementPanels)) {
        const panel = obj(at(p, "engagementPanelSectionListRenderer"));
        if (panel?.panelIdentifier !== "engagement-panel-macro-markers-description-chapters") continue;
        for (const c of arr(at(panel, "content", "macroMarkersListRenderer", "contents"))) {
          const item = obj(at(c, "macroMarkersListItemRenderer"));
          if (item) chapters.push({ title: text(item.title), start: Number(at(item, "onTap", "watchEndpoint", "startTimeSeconds") ?? 0), startText: text(item.timeDescription) });
        }
      }
      const hit = found.hits.find((h) => h.videoId === id);
      const likes = arr(at(primary, "videoActions", "menuRenderer", "topLevelButtons"))
        .map((b) => str(at(b, "segmentedLikeDislikeButtonViewModel", "likeButtonViewModel", "likeButtonViewModel", "toggleButtonViewModel", "toggleButtonViewModel", "defaultButtonViewModel", "buttonViewModel", "title")))
        .find(Boolean);
      return {
        videoId: id,
        url: `${ORIGIN}/watch?v=${id}`,
        title: text(primary.title),
        channel: text(owner?.title),
        ...(handle ? { channelUrl: `${ORIGIN}${handle}` } : {}),
        description: text(secondary?.attributedDescription),
        ...(hit ? { duration: hit.duration, durationSeconds: hit.durationSeconds } : {}),
        views: count(viewsText),
        viewsText,
        ...(likes ? { likes } : {}),
        published: text(primary.dateText),
        ...(text(primary.relativeDateText) ? { publishedRelative: text(primary.relativeDateText) } : {}),
        live: !!at(primary, "viewCount", "videoViewCountRenderer", "isLive"),
        chapters,
      };
    },

    // The caption tracks a video has: language code, YouTube's name for the
    // track, and whether it is auto-generated.
    async listTranscriptLanguages(idOrUrl: string): Promise<TranscriptLanguage[]> {
      const id = videoId(idOrUrl);
      return (await openTranscript(kit, id)).languages;
    },

    // The transcript as timed segments plus the joined text. lang picks a
    // track by language code ("en", "ko") or by YouTube's name for it;
    // without it, the video's default track.
    async getTranscript(idOrUrl: string, opts: { lang?: string } = {}): Promise<Transcript> {
      const id = videoId(idOrUrl);
      let panel = await openTranscript(kit, id);
      let track = panel.languages.find((l) => l.selected) ?? panel.languages[0];
      if (opts.lang !== undefined) {
        const want = opts.lang.trim().toLowerCase();
        const match = panel.languages.find((l) => l.lang.toLowerCase() === want) ?? panel.languages.find((l) => l.name.toLowerCase() === want) ?? panel.languages.find((l) => l.lang.toLowerCase().startsWith(`${want}-`) || l.name.toLowerCase().startsWith(want));
        if (!match) throw new Error(`YouTube video ${id} has no "${opts.lang}" transcript; it has: ${panel.languages.map((l) => `${l.lang} (${l.name})`).join(", ") || "none"}`);
        if (!match.selected) panel = await switchTrack(kit, id, match.name);
        track = match;
      }
      if (panel.segments.length === 0) throw new Error(`YouTube video ${id} has no transcript`);
      return { videoId: id, lang: track?.lang ?? "", name: track?.name ?? "", auto: track?.auto ?? false, segments: panel.segments, text: panel.segments.map((s) => s.text).join(" ") };
    },

    // Top-level comments in YouTube's "top comments" order; limit defaults
    // to 20, and continuation from one answer pages to the next.
    async getComments(idOrUrl: string, opts: { limit?: number; continuation?: string } = {}): Promise<Comments> {
      const id = videoId(idOrUrl);
      const limit = opts.limit ?? 20;
      let token = opts.continuation;
      if (token === undefined) {
        const res = await next(id);
        const rows = arr(at(res, "contents", "twoColumnWatchNextResults", "results", "results", "contents"));
        const section = obj(rows.map((r) => obj(at(r, "itemSectionRenderer"))).find((s) => s?.sectionIdentifier === "comment-item-section"));
        token = str(at(section, "contents", 0, "continuationItemRenderer", "continuationEndpoint", "continuationCommand", "token"));
        if (!token) {
          const note = text(at(section, "contents", 0, "messageRenderer", "text"));
          throw new Error(`YouTube video ${id} has no comments to read${note ? `: ${note}` : ""}`);
        }
      }
      const out: Comments = { videoId: id, comments: [] };
      while (out.comments.length < limit && token) {
        const page = commentsPage(id, await innertube(kit, "next", { continuation: token }, COMMENTS_DROP));
        out.comments.push(...page.comments);
        token = page.continuation;
        if (page.comments.length === 0) break;
      }
      out.comments = out.comments.slice(0, limit);
      if (token) out.continuation = token;
      return out;
    },
  };
}
