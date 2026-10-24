// Web reads that did not load, and what the Safari helper makes of them.
// Over Oct 1-24, helpers gave up on a page with no Safari call in 32 of 73
// give-up replies, and 28 of 48 runs that met a bot check in map never opened
// the page (harness-audit/web-giveup-report.md). A read the web tool could
// not load gets Safari's copy of the page beside it; a shell fetch that met a
// wall gets the map command; and a run that ends with such a page unanswered
// by Safari is sent back to it once.

import { daemonHttp } from "../daemon/rpc.ts";
import type { MapAnswer } from "../daemon/map.ts";

export type Block = { type: string; text?: string };
// What the run's end says of a wall: why it holds, and the next step.
type Hold = { reason: string; next: string };
type Wall = Hold & { host: string; answered: boolean };
export type ToolResult = { toolName: string; toolCallId: string; input: Record<string, unknown>; content: Block[] };

// The copy's whole call, inside the 30 s omp gives a tool_result handler: a
// Cloudflare wall that map waits out (challenge.ts) ran 9.1 s on 10-23.
const COPY_MS = 20_000;
// How long Safari's copy waits for an app's loading line to go, inside
// COPY_MS: confex's program drew in 3.2 s once Safari waited (10-24).
const LOADING_MS = 10_000;
// A reply keeps 30 000 characters, as the MCP server's do (mcp-tools.ts).
const REPLY_CHARS = 30_000;
// Below these, a page that names a wall is the wall, not an article about one.
const SHELL_CHARS = 1500;
const JS_SHELL_CHARS = 500;
// A copy with less text than this did not show the page either: the
// Chromium tracker's read only "Sign in" before the app drew.
const COPY_CHARS = 200;
const SHELL_OUTPUT_CHARS = 5000;

const REFUSED: Record<string, true> = { "401": true, "403": true, "406": true, "429": true, "451": true, "999": true };
const JS_NOTE = "Page appears to require JavaScript or is mostly navigation";
// Wall titles that challenge.ts's classify (readWall) does not know as
// titles; it knows Cloudflare's "Just a moment..." and "Attention Required!".
const CHECK_TITLE = /^(?:checking your browser|access denied|request rejected|verify(?:ing)? (?:that )?you are (?:a )?human|are you a (?:human|robot)|human verification|security check|pardon our interruption)\b/i;
const LOGIN_TITLE = /^(?:sign[ -]?in|log[ -]?in)\b|\b(?:sign[ -]?in|log[ -]?in) to\b|: sign[ -]?in$/i;
const LOGIN_URL = /^https?:\/\/(?:idmsa\.apple\.com|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com)\/|\/(?:sign[-_]?in|log[-_]?in|logon|sign[-_]?on|ServiceLogin)(?:[/?#.]|$)/i;
const BLOCK_URL = /\/blocked\?|apology|abuse-detection|captcha|challenge|verify-human|\/\.stile\//i;
const LOOPBACK = /^(?:localhost|127\.|0\.0\.0\.0$|\[::1\]$)/;
const X_POST = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/?#]+\/status\/\d+/i;
const SELECTOR = /:(?:raw|conflicts|img|-?\d+(?:[-+]\d*)?(?:,\d+(?:-\d+)?)*)$/;
const FETCHES = /\bcurl\b|\bwget\b|\bfetch\s*\(|\brequests\.|\bhttpx\.|\burllib\b|\baiohttp\b/;
// A wall a fetch prints: its vendor's own words first; the generic ones
// count only in output short enough to be the wall itself.
const SHELL_WALLS: [RegExp, string, boolean][] = [
  [/Attention Required! \| Cloudflare|Sorry, you have been blocked|__cf_chl|cf-chl-|challenges\.cloudflare\.com|cf-mitigated|Enable JavaScript and cookies to continue/i, "a Cloudflare wall", false],
  [/captcha-delivery\.com|datadome/i, "a DataDome wall", false],
  [/px-captcha|perimeterx|Press & Hold/i, "a PerimeterX wall", false],
  [/errors\.edgesuite\.net|You don't have permission to access/i, "an Akamai wall", false],
  [/^(?:< )?HTTP\/[\d.]+ (401|403|429)\b/m, "HTTP $1", false],
  [/^(401|403|429)(?:\s+https?:\/\/\S*)?(?:\s+\d+)?\s*$/m, "HTTP $1", false],
  [/\bHTTP Error (401|403|429)\b|\b(401|403|429) Client Error\b/, "HTTP $1$2", false],
  [/Access Denied/i, "Access Denied", true],
  [/captcha|verify you are (?:a )?human|Just a moment\.\.\./i, "a bot check", true],
];
// Safari calls that act on the page in a tab, alone or as a step of a run:
// a check they still show is theirs to judge, where map would only answer
// it again from the task's memory of the check (daemon/reads.ts).
const ATTEMPTS: Record<string, true> = { open: true, goto: true, wait: true, handoff: true, repl: true, real_input: true };

const NEXT_CHECK = "open it in a tab (safari open URL) and wait a few seconds, since many checks clear on their own in a real Safari tab; hand it to the user with handoff only if it still stands and the page matters";
const NEXT_THIN = "open it in a tab (safari open URL), wait for its text (safari wait), then read it (safari extract)";
const NEXT_MAP = "read it in the Safari helper (safari map URL)";
// The run's end names a wall's site alone, with these reasons of the
// harness's own: it reaches the model as the harness's word, and a page's
// title, the address it sent a read on to, or a URL in its text can carry
// instructions (review of 10-24).
const READ_CHECKED: Hold = { reason: "a read did not load a page there, and Safari's quick read met a bot check", next: NEXT_CHECK };
const READ_THIN: Hold = { reason: "a read did not load a page there, and Safari's quick read did not load it either", next: NEXT_THIN };
const SAFARI_CHECKED: Hold = { reason: "Safari showed a bot check", next: NEXT_CHECK };

function appended(content: Block[], addition: string): Block[] {
  const last = content.findLastIndex((b) => b.type === "text");
  if (last < 0) return [...content, { type: "text", text: addition }];
  return content.map((b, i) => (i === last ? { ...b, text: `${b.text ?? ""}\n${addition}` } : b));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s'"<>`\\)\]]+/g) ?? []).map((u) => u.replace(/[.,;:]+$/, "")).filter((u) => hostOf(u) !== "" && !LOOPBACK.test(hostOf(u)));
}

// The address a read asked for, without the line selectors read takes
// after it (":raw", ":1-60"); a number after a bare host is its port.
function asked(path: unknown): string | undefined {
  if (typeof path !== "string" || !/^https?:\/\//i.test(path)) return undefined;
  let url = path;
  while (SELECTOR.test(url)) {
    const cut = url.replace(SELECTOR, "");
    if (/^:\d/.test(url.slice(cut.length)) && !/^https?:\/\/[^/]+\//i.test(cut)) break;
    url = cut;
  }
  return LOOPBACK.test(hostOf(url)) ? undefined : url;
}

function sameAddress(a: string, b: string): boolean {
  const key = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.hostname.toLowerCase().replace(/^www\./, "")}${decodeURIComponent(x.pathname).replace(/\/+$/, "")}${decodeURIComponent(x.search)}`;
    } catch {
      return u;
    }
  };
  return key(a) === key(b);
}

type Read = { final: string; method: string; notes: string; title: string; base: string; body: string };

// read's answer for a web page: "URL:", "Method:" and "Notes:" lines, then
// "---" and the page, which starts with its own front matter (title, base).
function readOf(text: string): Read | undefined {
  if (!text.startsWith("URL: ")) return undefined;
  const cut = text.indexOf("\n---\n");
  const head = cut < 0 ? text : text.slice(0, cut);
  let body = cut < 0 ? "" : text.slice(cut + 5).replace(/^\n+/, "");
  let front = "";
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end >= 0) {
      front = body.slice(4, end);
      body = body.slice(end + 5);
    }
  }
  const field = (from: string, name: string) => from.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? "";
  const notes = cut < 0 ? field(head, "Notes") : head.slice(head.indexOf("Notes: ") < 0 ? head.length : head.indexOf("Notes: ") + 7).trim();
  return { final: field(head, "URL"), method: field(head, "Method"), notes, title: field(front, "title"), base: field(front, "base"), body: body.trim() };
}

// A page's words, past its links' and images' addresses.
function wordsOf(body: string): string {
  return body.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
}

// A page whose words are little but a sign-in.
function signInOnly(words: string): boolean {
  return words.length < 300 && /^(?:#+\s*)?(?:log ?in|sign ?in)\b/im.test(words);
}

// The loading line of an app that never drew past it, as the read showed
// it: confex's meeting program read only "please wait while the program
// loads" on 10-21. Safari's copy waits for it to go.
function loadingLine(words: string): string | undefined {
  if (words.length >= JS_SHELL_CHARS) return undefined;
  const line = words.match(/\bplease wait\b[^\n]{0,80}?\bload\w*|^(?:#+\s*)?(loading)\b/im);
  return line ? (line[1] ?? line[0]) : undefined;
}

// The bot check that challenge.ts's classify, as open and map use it, sees
// in a read short enough to be one, given the page's words as content.js
// gives them: Walmart's PerimeterX "Robot or human?", whose title no list
// here knows. Loaded here, not at the top, as tools.ts is below.
async function checkOf(url: string, read: Read, words: string): Promise<string | undefined> {
  const { classify, TEXT_MAX } = await import("../daemon/challenge.ts");
  if (words.length > TEXT_MAX) return undefined;
  const check = classify([{ url: read.final || url, title: read.title, text: words, markers: [], answered: [], frames: [] }]);
  if (!check || check.where === "box") return undefined;
  return check.kind === "other" ? "a bot check" : `a bot check from ${check.kind}`;
}

// Why read's answer for url is not the page, and what Safari's copy waits
// for, or undefined when it is the page. A redirect to the site's own error
// page is its answer, which Safari would only repeat: calrecycle's search
// went to /NotFound with a 404 (10-06).
async function readWall(url: string, text: string): Promise<{ why: string; wait?: Record<string, unknown> } | undefined> {
  const read = readOf(text);
  if (!read) return undefined;
  const moved = read.final !== "" && !sameAddress(url, read.final);
  const landed = moved ? read.final : "";
  if (read.method === "x-unavailable") return { why: "X answers automated reads with nothing" };
  const status = read.notes.match(/HTTP (\d{3})\b/)?.[1];
  const failed = read.method === "failed" || /fetch failed/i.test(read.notes);
  if (failed && status !== undefined && Object.hasOwn(REFUSED, status)) return { why: `HTTP ${status}` };
  if (failed && status === undefined && /Cause: /.test(read.notes) && !/ENOTFOUND|ECONNREFUSED/.test(read.notes)) return { why: read.notes.replace(/^[\s\S]*?Cause: /, "").replace(/\. For more information[\s\S]*$/, "").trim() };
  const words = wordsOf(read.body);
  // a long page at such an address is the page, an article about a challenge
  if (words.length < SHELL_CHARS && (BLOCK_URL.test(landed) || BLOCK_URL.test(read.base))) return { why: `a bot check at ${landed || read.base}` };
  if ((LOGIN_URL.test(read.final) && (moved || read.body.length < SHELL_CHARS)) || (LOGIN_TITLE.test(read.title) && read.body.length < SHELL_CHARS) || signInOnly(words)) return { why: `a sign-in page${landed ? ` at ${landed}` : ""}` };
  const check = await checkOf(url, read, words);
  if (check !== undefined) return { why: check };
  if (CHECK_TITLE.test(read.title) && read.body.length < SHELL_CHARS) return { why: `a bot check ("${read.title}")` };
  const loading = loadingLine(words);
  if (loading !== undefined) return { why: "the page draws itself with JavaScript", wait: { gone: loading, ms: LOADING_MS } };
  if (read.notes.includes(JS_NOTE) && read.body.length < JS_SHELL_CHARS) return { why: "the page draws itself with JavaScript" };
  return undefined;
}

// The page a shell fetch of command met a wall on, and the wall. The page
// is the one the command fetched nearest the wall in the output: a URL the
// output printed is the site's to choose.
function shellWall(command: string, output: string): { url: string; why: string } | undefined {
  if (!FETCHES.test(command)) return undefined;
  const fetched = urlsIn(command);
  if (fetched.length === 0) return undefined;
  for (const [pattern, why, short] of SHELL_WALLS) {
    const match = pattern.exec(output);
    if (!match || (short && output.length > SHELL_OUTPUT_CHARS)) continue;
    const hosts = new Set(fetched.map(hostOf));
    const near = urlsIn(output.slice(0, match.index)).filter((u) => hosts.has(hostOf(u))).at(-1);
    const url = near === undefined ? fetched[0] : (fetched.find((u) => sameAddress(u, near)) ?? fetched.find((u) => hostOf(u) === hostOf(near)) ?? fetched[0]);
    return { url, why: why.replace("$1", match[1] ?? "").replace("$2", match[2] ?? "") };
  }
  return undefined;
}

type Copy = { loaded: boolean; check: boolean; text: string };
type MapPage = MapAnswer["pages"][number];

// The text and page state of map's read of a page.
function readOfPage(page: MapPage | undefined): { text: string; kind?: string } {
  const value = page && "value" in page ? page.value : undefined;
  if (!value || typeof value !== "object") return { text: "" };
  const state = "pageState" in value ? value.pageState : undefined;
  return {
    text: "text" in value && typeof value.text === "string" ? value.text : "",
    kind: state && typeof state === "object" && "kind" in state && typeof state.kind === "string" ? state.kind : undefined,
  };
}

// Safari's copy of url, as `safari map url` prints it, loaded for task by
// this omp process. It waits as wait says (an app's loading line to go); an
// X post waits for the post itself (docs/sites/x.md).
async function safariCopy(url: string, task: string | undefined, wait: Record<string, unknown> | undefined): Promise<Copy> {
  const waits = wait ?? (X_POST.test(url) ? { selector: "article" } : undefined);
  const args = { urls: [url], ...(waits ? { wait: waits } : {}) };
  try {
    const res = await fetch(`${daemonHttp()}/rpc`, {
      method: "POST",
      body: JSON.stringify({ tool: "map", args, caller: process.pid, own: true, news: false, ...(task === undefined ? {} : { task }) }),
      signal: AbortSignal.timeout(COPY_MS),
    });
    const answer = (await res.json()) as { ok?: boolean; value?: MapAnswer; error?: string };
    if (!answer.ok || !answer.value) return { loaded: false, check: false, text: `error: ${answer.error ?? `HTTP ${res.status}`}` };
    const page = answer.value.pages[0];
    const check = !!page && "challenge" in page && page.challenge?.where === "page";
    const { text, kind } = readOfPage(page);
    const loaded = !!page?.ok && !check && (kind === undefined || kind === "content" || kind === "unjudged") && text.trim().length >= COPY_CHARS;
    // Loaded here, not at the top: tools.ts brings the daemon's whole tool
    // graph, 36-57 ms and 33 MB more in every omp process at its start
    // (measured 10-23), for a path few runs take.
    const { formatResult } = await import("../daemon/tools.ts");
    const whole = formatResult(answer.value);
    if (whole.length <= REPLY_CHARS) return { loaded, check, text: whole };
    const { saveAnswer } = await import("../daemon/save.ts");
    const path = await saveAnswer(whole);
    const kept = formatResult(answer.value, REPLY_CHARS).slice(0, REPLY_CHARS);
    return { loaded, check, text: `${kept}\n…cut at ${kept.length} of ${whole.length} characters; the whole copy is in ${path}` };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "TimeoutError") return { loaded: false, check: false, text: `error: Safari gave no answer in ${COPY_MS / 1000} s; it may still be loading the page, and safari map ${url} answers from that read once it is done` };
    return { loaded: false, check: false, text: `error: the Safari helper did not answer (${e instanceof Error ? e.message : String(e)})` };
  }
}

// The lines a read that did not load gets: why, then Safari's copy, then
// the next step when Safari did not load the page either.
function copyLines(url: string, why: string, copy: Copy): string {
  if (copy.loaded) return `safari: read could not load this page (${why}); the Safari helper loaded it:\n${copy.text}`;
  const next = (copy.check ? NEXT_CHECK : NEXT_THIN).replace("URL", url);
  return `safari: read could not load this page (${why}), and the Safari helper did not load it either. Safari answered:\n${copy.text}\nsafari: next, ${next}. If it still fails, quote what Safari answered when you report it.`;
}

// ---------- walls a run met ----------

const walls = new Map<string, Wall[]>();
const nudged = new Set<string>();
// Each tab's site, for calls that name only the tab (wait, handoff).
const tabs = new Map<number, string>();

// A wall the run met at url's site, with what the run's end says of it;
// with no hold, Safari's copy of a page there, which answers the site's
// open wall. An open wall takes a later hold, but not a shell fetch's,
// which knows less of what Safari met there.
function metWall(session: string, url: string, hold: Hold | undefined) {
  const list = walls.get(session) ?? [];
  const host = hostOf(url);
  const open = list.find((w) => !w.answered && w.host === host);
  if (hold === undefined) {
    if (open) open.answered = true;
  } else if (!open) walls.set(session, [...list, { host, ...hold, answered: false }]);
  else if (hold.next !== NEXT_MAP || open.next === NEXT_MAP) Object.assign(open, hold);
}

export function newRun(session: string) {
  walls.delete(session);
  nudged.delete(session);
}

type SafariCall = { tool: string; input: Record<string, unknown>; text: string };

// A Safari call, as an MCP tool, its xd:// device, or the safari CLI.
function safariCall(toolName: string, input: Record<string, unknown>, text: string): SafariCall | undefined {
  if (toolName.startsWith("mcp__safari_")) return { tool: toolName.slice("mcp__safari_".length), input, text };
  if (toolName === "write" && typeof input.path === "string" && input.path.startsWith("xd://mcp__safari_")) {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(typeof input.content === "string" ? input.content : "{}");
      if (parsed && typeof parsed === "object") args = { ...parsed };
    } catch {
      args = {};
    }
    return { tool: input.path.slice("xd://mcp__safari_".length), input: args, text };
  }
  const command = typeof input.command === "string" ? input.command : undefined;
  const tool = command?.match(/(?:^|[\s;&|('"])safari\s+([a-z][a-z_-]*)/)?.[1];
  return tool === undefined ? undefined : { tool: tool.replaceAll("-", "_"), input, text };
}

// One of ATTEMPTS, or a run with one among the steps its answer lists
// ("[2 wait] …", from the MCP tool and the CLI alike): NCBI's check on
// 10-24 cleared during a run's open, wait and info.
function attempts(call: SafariCall): boolean {
  if (call.tool !== "run") return Object.hasOwn(ATTEMPTS, call.tool);
  return [...call.text.matchAll(/^\[\d+ ([a-z_]+)\]/gm)].some((m) => Object.hasOwn(ATTEMPTS, m[1] ?? ""));
}

// What a Safari call tells of the run's walls. Its sites are the ones it
// asked for and those of the tabs it names, never ones its page links to:
// a search result's link is not a call there. A call at a wall's site
// answers that wall; a check it met at one of its sites, other than on a
// page it acts on in a tab, is a wall of its own.
function sawSafari(session: string, call: SafariCall) {
  if (call.tool === "open" || call.tool === "goto") {
    const shown = call.text.match(/"id":\s*(\d+),\s*"url":\s*"([^"]+)"/);
    if (shown) tabs.set(Number(shown[1]), hostOf(shown[2] ?? ""));
  }
  const asked = JSON.stringify(call.input);
  const hosts = new Set(urlsIn(asked).map(hostOf));
  for (const m of asked.matchAll(/"tab":\s*"?(\d+)|--tab[ =]"?(\d+)/g)) {
    const site = tabs.get(Number(m[1] ?? m[2]));
    if (site !== undefined) hosts.add(site);
  }
  for (const wall of walls.get(session) ?? []) if (hosts.has(wall.host)) wall.answered = true;
  if (attempts(call)) return;
  for (const m of call.text.matchAll(/"where":\s*"page"/g)) {
    const checked = urlsIn(call.text.slice(0, m.index)).at(-1);
    if (checked !== undefined && hosts.has(hostOf(checked))) metWall(session, checked, SAFARI_CHECKED);
  }
}

// The run's walls no Safari call of its own answered, by site, once a run:
// undefined when there are none or the run was told already.
export function unanswered(session: string): string | undefined {
  const open = (walls.get(session) ?? []).filter((w) => !w.answered);
  if (open.length === 0 || nudged.has(session)) return undefined;
  nudged.add(session);
  return [
    "safari: pages on these sites did not load, and no Safari call of yours has tried them since:",
    ...open.slice(0, 8).map((w) => `- ${w.host}: ${w.reason}; next, ${w.next}.`),
    "Call a page blocked only after Safari also failed on it, quoting what Safari answered. If your instructions told you to leave a page, skip it and say so in your reply.",
  ].join("\n");
}

const copied = new Set<string>();

// What a tool's result tells of the web: a read that did not load gets
// Safari's copy, once; a shell fetch that met a wall gets the map command;
// a Safari call answers the run's walls or adds its bot check to them.
export async function webResult(event: ToolResult, session: string | undefined, task: () => string | undefined): Promise<{ content: Block[] } | undefined> {
  const text = event.content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
  const url = event.toolName === "read" ? asked(event.input.path) : undefined;
  if (url !== undefined) {
    if (copied.has(event.toolCallId) || text.includes("\nsafari: read could not load this page (")) return undefined;
    const missed = await readWall(url, text);
    // the same result seen again while this one was judged
    if (missed === undefined || copied.has(event.toolCallId)) return undefined;
    if (copied.size > 1000) copied.clear();
    copied.add(event.toolCallId);
    const copy = await safariCopy(url, task(), missed.wait);
    if (session !== undefined) metWall(session, url, copy.loaded ? undefined : copy.check ? READ_CHECKED : READ_THIN);
    return { content: appended(event.content, copyLines(url, missed.why, copy)) };
  }
  const call = safariCall(event.toolName, event.input, text);
  if (call !== undefined && session !== undefined) sawSafari(session, call);
  const command = event.toolName === "bash" ? event.input.command : event.toolName === "eval" ? event.input.code : undefined;
  const wall = typeof command === "string" && call === undefined ? shellWall(command, text) : undefined;
  if (wall === undefined) return undefined;
  if (session !== undefined) metWall(session, wall.url, { reason: `a shell fetch met ${wall.why}`, next: NEXT_MAP });
  return { content: appended(event.content, `safari: ${hostOf(wall.url)} answered this fetch with ${wall.why}; read the page in the Safari helper instead: safari map ${wall.url}`) };
}
