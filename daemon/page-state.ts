import type { Challenge } from "./challenge.ts";

export type PageKind = "content" | "login_wall" | "paywall" | "region_block" | "consent" | "loading" | "error" | "empty" | "unjudged";
export type PageState = { kind: PageKind; next: string };
type Control = { role: "button" | "textbox"; label: string };
export type PageFacts = {
  url: string;
  title: string;
  text?: string;
  status?: number;
  loading?: boolean;
  ready?: "loading" | "interactive" | "complete";
  truncated?: boolean;
  partial?: boolean;
  contentType?: string;
  challenge?: Challenge | null;
  controls?: Control[];
};

const NEXT: Record<PageKind, string> = {
  content: "use the readable page content.",
  login_wall: "use the authorized sign-in flow; ask the user for any step only they can complete.",
  paywall: "use an authorized subscription or another permitted source; do not bypass payment.",
  region_block: "report the region restriction and use a permitted source; do not bypass it.",
  consent: "ask the user to choose unless their consent choice is already authorized.",
  loading: "wait for expected page text, then read the page again.",
  error: "check the address and the page error before choosing another source or action.",
  empty: "no text was read; inspect the page before treating it as empty.",
  unjudged: "read a whole-page snapshot or extract before judging what is available.",
};

const LOGIN = /^(?:(?:please )?(?:sign[ -]?in|log[ -]?in)(?: to (?:continue(?: reading)?|read (?:more|this (?:article|story))|access .+|view .+))?|authentication required|you (?:must|need to) (?:sign[ -]?in|log[ -]?in)(?: to .+)?)\s*[.!]?$/i;
const LOGIN_REQUIRED = /^(?:(?:please )?(?:sign[ -]?in|log[ -]?in) to (?:continue|read|access|view)\b|authentication required|you (?:must|need to) (?:sign[ -]?in|log[ -]?in)\b)/i;
const LOGIN_ACTION = /^(?:(?:sign[ -]?in|log[ -]?in|continue)(?: with .+)?|next)\s*[.!]?$/i;
const PAY = /^(?:(?:subscribe|become a (?:subscriber|member)) to (?:continue(?: reading)?|read (?:more|on|this (?:article|story)|the (?:full|rest of (?:this|the)) (?:article|story)))|(?:this (?:article|story|content) is (?:only |exclusively )?(?:for|available to) (?:our )?(?:subscribers|members))|(?:you(?:'ve| have) reached (?:your|the) (?:free |monthly )?(?:article|reading) limit)|(?:your free (?:article|reading) limit (?:has been|is) reached))\s*[.!]?$/i;
const PAY_ACTION = /^(?:subscribe(?: now| today)?|start (?:your |a )?(?:free )?(?:trial|subscription)|become a (?:subscriber|member)|choose (?:a |your )?plan|unlock (?:this |the )?(?:article|story))\s*[.!]?$/i;
// A journal's offer of the article it holds back, as Oxford Academic's
// abstract page for an article with no abstract read on 11-14 (RSI#869):
// "Purchase content", "The Transplant Effect - 24 Hours access", "Rental",
// "You do not currently have access to this article." Two of them make a
// paywall: "Get access" alone is a product's button too.
const ACCESS = /^(?:get access|purchase (?:access|content|this article|short-term access)|rent this article|rental|.+ - \d+ hours? access|you do not (?:currently )?have access to this (?:article|content|chapter|book))\s*[.!]?$/i;
const REGION = /^(?:sorry[,!.]?\s*)?(?:(?:this|our) (?:site|website|service|content|video|page) (?:is )?(?:not available|unavailable|blocked|not accessible) (?:in|from) (?:your|this) (?:country|region|location)|(?:not available|unavailable) in your (?:country|region|location)|we (?:are unable to|cannot) (?:provide|offer) (?:this (?:service|content)|access) in your (?:country|region))\s*[.!]?$/i;
const CONSENT = /^(?:before you continue(?: to .+)?|we value your privacy|your privacy choices|privacy (?:and|&) cookie preferences|cookie (?:consent|preferences)|consent required)\s*[.!]?$/i;
const CHOICE = /^(?:accept all(?: cookies)?|agree|i agree|manage (?:options|preferences|cookies)|more options|customi[sz]e(?: cookies)?)\s*[.!]?$/i;
// A consent choice that refuses, which next names when the read gave it a
// ref; the harness never clicks it.
const REJECT = /^(?:reject (?:all|optional)(?: cookies)?|i disagree|disagree|only necessary(?: cookies)?)\s*[.!]?$/i;
const ERROR = /^(?:(?:error\s*)?(?:400|401|403|404|408|410|429|451|500|502|503|504)(?:\s*[-:–—]?\s*(?:bad request|unauthorized|forbidden|not found|request timeout|gone|too many requests|unavailable for legal reasons|internal server error|bad gateway|service unavailable|gateway timeout))?|(?:page|file) not found|something went wrong|access denied|forbidden|service unavailable|internal server error|bad gateway|failed to open page|error page)\s*[.!]?$/i;
// A site that has stopped answering this browser for a while. On 11-13
// UKG's docs answered "You’ve been rate limited … by our firewall!" to a
// map's eval of each page after the first (LOCK#1363), and on 11-14
// Harvard's repository "WEB FIREWALL · 429 / The service is under heavy
// load" (RSI#747); both counted as read.
const RATE = /^(?:you(?:'ve| have) been rate[ -]limited|(?:you(?: are|'re) being )?rate[ -]limited|rate limit(?: exceeded| reached)|too many requests|(?:web )?firewall\s*[·:|–—-]\s*429|(?:error\s*)?429(?:\s*[-:–—]?\s*too many requests)?|the service is under heavy load)\s*[.!]?$/i;
const RATE_LIMITED = "the site rate-limited this browser; wait a few minutes before reading it again, then read its pages one at a time.";
// A title part that names the page missing. Safari gives a page read no
// HTTP status (27.0.1's navigation timing has no responseStatus), so the
// title is the page's own word for it: "Page not found · GitHub".
const NOT_FOUND = /^(?:(?:error )?404(?: error)?|(?:404 )?(?:page |file )?not found|this page could not be found)[.!]?$/i;
// A page still on its way. On 11-13 ServiceNow's docs read "Loading
// application..." (LOCK#1312), and on 11-11 a Slack link "Launching
// <workspace> / You will be redirected in a few moments." (LOCK#563); both
// were judged content and counted as read. "Loading" with words of its own
// counts only with its trailing dots, and a redirect only when it says how
// soon: "Loading Docker images faster" and "You will be redirected to a
// third-party website" are a page's words.
const LOADING = /^(?:loading(?: (?:content|page|results))?|loading(?: [\w-]+){1,2}(?=\s*(?:\.{3}|…)\s*$)|please wait|signing in|redirecting(?: to .+)?|you will be redirected in .+)\s*[.!…]*$/i;
// The address of a sign-in page: its host, or the first step of its path,
// as a docs page on signing in sits under its section (/guides/auth,
// /reference/login). On 11-13 SAP's accounts.sap.com/oauth2/authorize
// asked for "Email, User ID or Login Name", a field no rule knew, and was
// read as content (LOCK#1284); on 11-15 and 11-16 billing pages led to
// sign-in pages whose only actions were "Continue with Google" and the
// like (LOCK#1865, #1875-1880).
const SIGN_IN_HOST = /^(?:accounts|auth|login|signin|sso)\./i;
const SIGN_IN_PATH = /^\/(?:signin|sign-in|login|log-in|auth|sso|authorize|oauth2)(?:\/|$)/i;
// A sign-in page's own button: one through another account.
const SIGN_IN_WITH = /^(?:(?:sign[ -]?in|log[ -]?in|continue) with .+|single sign-on\b.*)$/i;
// A title part that names a sign-in page: "Exa Login", "Login · Nimble",
// "SAP Business Accelerator Hub: Sign In", "Sign in to GitHub".
const SIGN_IN_TITLE = /^(?:(?:[\w.&'-]+ ){0,3}(?:sign[ -]?in|log[ -]?in)|(?:sign[ -]?in|log[ -]?in) to [\w.&'-]+(?: [\w.&'-]+)?)$/i;
const OUTLINE = /^(?:\[([\w:.-]+)\]\s*)?(h[1-6]|heading|form|dialog|alertdialog|button|link|textbox|label|checkbox|radio|combobox|main|article|navigation|banner)(?:\s+|$)(?:\[[\w:.-]+\]\s*)?/i;
type Line = { label: string; role: string; indent: number; ref?: string };

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    const outline = OUTLINE.exec(trimmed);
    const role = outline?.[2].toLowerCase() ?? "";
    const label = (outline ? trimmed.slice(outline[0].length).replace(/\s*\{[^{}]*\}\s*$/, "") : trimmed).replace(/^"(.*)"$/, "$1").trim();
    if (label) lines.push({ label, role, indent: raw.length - raw.trimStart().length, ...(outline?.[1] ? { ref: outline[1] } : {}) });
  }
  return lines;
}

function titleParts(title: string): string[] {
  return title.replace(/’/g, "'").split(/\s*[·|:•–—]\s*|\s+-\s+/).map((part) => part.trim());
}

function notFound(title: string): boolean {
  return titleParts(title).some((part) => NOT_FOUND.test(part));
}

// Whether the page runs as prose, as an article does; a wall or a missing
// page says one short thing. A cookie notice or a copyright line is not its
// prose: on 10-24 MDN's not-found page read with "Portions of this content
// are ©1998–2026 by individual mozilla.org contributors. Content …". Nor is
// a line of JSON: on 11-16 Exa's sign-in page showed a sample answer beside
// its buttons (LOCK#1875).
function proseHeavy(lines: Line[]): boolean {
  const prose = lines.filter((line) => line.role === "" && line.label.length >= 100 && !line.label.includes("©") && !/^"[^"]+"\s*:/.test(line.label)
    && !/^(?:we use (?:cookies|data)|by (?:clicking|continuing|signing)|cookies (?:and|are)|to (?:learn more|find out more)|our (?:privacy|cookie) policy)\b/i.test(line.label));
  return prose.some((line) => line.label.length >= 280 || /[.!?]["”']?\s+[A-Z]/.test(line.label)) || prose.length >= 2;
}

function wallKind(lines: Line[], title: string, url: string): PageKind | undefined {
  const labels = lines.map((line) => line.label);
  if (labels.join("\n").length > 3000 || proseHeavy(lines)) return undefined;
  const titleHead = title.replace(/’/g, "'").split(/\s+[|–—-]\s+/)[0].trim();
  const primary = lines.find((line) => /^(?:h1|heading|dialog|alertdialog)$/.test(line.role))
    ?? lines.find((line) => /^(?:h[2-6]|form)$/.test(line.role)) ?? lines.find((line) => line.role === "");
  const heading = (pattern: RegExp) => (primary !== undefined && pattern.test(primary.label))
    || (pattern.test(titleHead) && lines.slice(0, 4).some((line) => line.role !== "button" && line.role !== "link" && pattern.test(line.label)));
  const action = (pattern: RegExp) => lines.some((line) => (line.role === "" || line.role === "button" || line.role === "link") && pattern.test(line.label));
  if (heading(REGION)) return "region_block";
  if (heading(CONSENT) && /\b(?:cookies?|consent|privacy)\b/i.test(labels.join(" "))
    && new Set(labels.filter((label) => CHOICE.test(label) || REJECT.test(label)).map((label) => label.toLowerCase())).size >= 2) return "consent";
  if ((heading(PAY) && action(PAY_ACTION)) || new Set(labels.filter((label) => ACCESS.test(label)).map((label) => label.toLowerCase())).size >= 2) return "paywall";
  const field = lines.some((line) => /^(?:email(?: address)?(?: or (?:phone(?: number)?|username))?|password|username|phone(?: number)?)(?:\s*[:*])?$/i.test(line.label)
    && (line.role === "" || line.role === "textbox" || line.role === "label"));
  const loginRoute = /\/(?:signin|sign-in|login|log-in|auth|sso)(?:\/|$)/i.test(URL.parse(url)?.pathname ?? "");
  if (heading(LOGIN) && ((field && (action(LOGIN_ACTION) || loginRoute || LOGIN.test(titleHead)))
    || (heading(LOGIN_REQUIRED) && action(LOGIN_ACTION)))) return "login_wall";
  // A sign-in page whose field no rule knows, or that has only buttons
  // ("Continue with Google"): its address and its title or buttons say so.
  const address = URL.parse(url);
  if (address !== null && (SIGN_IN_HOST.test(address.hostname) || SIGN_IN_PATH.test(address.pathname))
    && (titleParts(title).some((part) => SIGN_IN_TITLE.test(part))
      || (action(SIGN_IN_WITH) && labels.some((label) => /\b(?:sign[ -]?in|log[ -]?in)\b/i.test(label))))) return "login_wall";
  // A heading that gives a status code and its name is the server's own
  // page whatever its title: on 11-14 a robots.txt answered "503 Service
  // Unavailable" under the title "Site not available" (LOCK#1717).
  if (heading(ERROR) && (ERROR.test(titleHead) || labels.length <= 2 || (primary !== undefined && /^(?:error\s*)?\d{3}\s*[-:–—]?\s*[a-z]/i.test(primary.label)))) return "error";
  return undefined;
}

// Whether a field holds something: words, a number other than 0, true, or
// a list or record with entries. error: 0, {} and [] say nothing went wrong.
function said(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  const fields = record(value);
  return value === true || (fields !== undefined && Object.keys(fields).length > 0);
}

// The error, sign-in, or loading state a JSON answer gives in its own
// fields, which an HTTP 200 carries as often as not: {requiresLogin:
// true}, {loading: true}, {error: "…"}. A GraphQL answer with data holds
// what it could read beside the errors of the rest, so it is an answer;
// {ok: false} that says no more is unjudged, as a "no" can be an answer.
// request_catalog refuses to save or run an endpoint that answers any of
// these (checkedJson).
export function jsonWall(parsed: unknown): "error" | "login_wall" | "loading" | "unjudged" | undefined {
  const envelope = record(parsed);
  if (!envelope) return undefined;
  if (envelope.requiresLogin === true || envelope.authenticated === false || envelope.authorized === false || envelope.unauthorized === true) return "login_wall";
  if (envelope.loading === true) return "loading";
  if (said(envelope.error) || (Array.isArray(envelope.errors) && envelope.errors.length > 0 && (envelope.data === undefined || envelope.data === null))) return "error";
  if (envelope.ok === false || envelope.success === false) return said(envelope.message) ? "error" : "unjudged";
  return undefined;
}

// A pager's count beside a list: {items: [], total: 0, page: 1}.
const PAGER = /^(?:total(?:_?(?:count|results|pages))?|count|page(?:_?(?:size|count|number))?|per_?page|offset|limit|size)$/i;

// A JSON answer whose list holds nothing: [], or an object whose one list
// is empty beside nothing but pager counts, flags and nulls ({items: [],
// total: 0}); the same under the one record that wraps it ({data: {search:
// {edges: []}}}). Words or a record beside the list ({tags: [], name: "x"})
// are the answer.
function emptyJson(parsed: unknown): boolean {
  if (Array.isArray(parsed)) return parsed.length === 0;
  let body = record(parsed);
  for (let depth = 0; body && depth < 4; depth++) {
    const entries = Object.entries(body);
    const lists = entries.filter(([, value]) => Array.isArray(value));
    const others = entries.filter(([key, value]) => !Array.isArray(value) && typeof value !== "boolean" && !(PAGER.test(key) && typeof value === "number") && said(value));
    const list = lists[0]?.[1];
    if (lists.length === 1 && others.length === 0) return Array.isArray(list) && list.length === 0;
    if (lists.length > 0 || others.length !== 1) return false;
    body = record(others[0][1]);
  }
  return false;
}

const JSON_TYPE = /^(?:application\/(?:[a-z0-9!#$&^_.+-]+\+)?json|text\/json)\s*(?:;|$)/i;
const EMPTY_JSON = "the JSON answer holds no items; check the address and its parameters before treating the list as empty.";
const ONLY_MESSAGE = "the JSON answer is only a message, no data; read it before treating it as an answer, a sign-in, or an error.";

// {"message": "Sign in"}: words that may be a wall or an answer, with no
// data beside them.
function onlyMessage(parsed: unknown): boolean {
  const body = record(parsed);
  if (!body) return false;
  const kept = Object.entries(body).filter(([, value]) => said(value));
  return kept.length > 0 && kept.every(([key, value]) => typeof value === "string" && /^(?:message|msg|detail|reason|status(?:_?text)?|description)$/i.test(key));
}

const BARE_NO = "the JSON answer says ok: false without saying why; read its fields before treating it as an answer or an error.";

// The parsed body of a JSON answer, by its type or by a body that parses
// as one; undefined for any other text.
function jsonOf(text: string, contentType: string | undefined): { parsed: unknown } | undefined {
  const typed = contentType !== undefined && JSON_TYPE.test(contentType);
  if (!typed && !((text[0] === "{" && text.at(-1) === "}") || (text[0] === "[" && text.at(-1) === "]"))) return undefined;
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

export function classifyPage(facts: PageFacts): PageState {
  const state = (kind: PageKind): PageState => ({ kind, next: NEXT[kind] });
  const walled = (kind: PageKind, scope: Line[]): PageState => {
    const reject = kind === "consent" ? scope.find((line) => line.ref !== undefined && REJECT.test(line.label)) : undefined;
    return reject ? { kind, next: `${NEXT.consent.slice(0, -1)}; the reject choice is [${reject.ref}] ${reject.role} "${reject.label}".` } : state(kind);
  };
  if (facts.challenge?.where === "block") return { kind: "error", next: "the site blocks this browser; report the block and do not bypass it." };
  if (facts.challenge?.where === "page") return { kind: "unjudged", next: "the page shows a bot check; wait for it to clear in Safari, then use another permitted source if it persists." };
  if (/^safari-resource:.*errorpage/i.test(facts.url) || /^safari-resource:/i.test(facts.title) || facts.title === "Failed to open page") return state("error");
  const status = facts.status;
  if (status !== undefined && Number.isInteger(status)) {
    if (status === 401) return state("login_wall");
    if (status === 402) return state("paywall");
    if (status === 429) return { kind: "error", next: RATE_LIMITED };
    if (status >= 400 && status <= 599) {
      if (facts.partial !== true && facts.truncated !== true && facts.text && wallKind(linesOf(facts.text), facts.title, facts.url) === "region_block") return state("region_block");
      return state("error");
    }
  }
  if (facts.loading === true) return state("loading");
  if (facts.text === undefined) return state(facts.ready === "loading" ? "loading" : "unjudged");
  const text = facts.text.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/’/g, "'").trim();
  if (facts.partial === true || facts.truncated === true || text === "(no change)") return state("unjudged");
  if (!text || text === "(0 nodes)") return state(facts.ready === "loading" ? "loading" : "empty");
  const json = jsonOf(text, facts.contentType);
  if (json) {
    const wall = jsonWall(json.parsed);
    if (wall === "unjudged") return { kind: "unjudged", next: BARE_NO };
    if (wall) return state(wall);
    if (onlyMessage(json.parsed)) return { kind: "unjudged", next: ONLY_MESSAGE };
    return emptyJson(json.parsed) ? { kind: "empty", next: EMPTY_JSON } : state("content");
  }
  if ((facts.contentType && !/^text\/(?:plain|html)(?:;|$)/i.test(facts.contentType)) || /^<(?:!doctype|[a-z][\w:-]*(?:\s|>))/i.test(text)) return state("unjudged");
  const lines = linesOf(text);
  for (const control of facts.controls ?? []) lines.push({ ...control, indent: 0 });
  if (lines.length === 0) return state("unjudged");
  if (lines.every((line) => LOADING.test(line.label))) return state("loading");
  // A rate limit says so first, or in its title, and its next line may be
  // a whole sentence ("Your requests have been rate limited by our
  // firewall! This should almost never happen …"), which reads as prose.
  if (text.length <= 600 && (RATE.test(lines[0].label) || titleParts(facts.title).some((part) => RATE.test(part)))) return { kind: "error", next: RATE_LIMITED };
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].role !== "dialog" && lines[index].role !== "alertdialog") continue;
    let end = index + 1;
    while (end < lines.length && lines[end].indent > lines[index].indent) end++;
    const scope = lines.slice(index, end);
    const wall = wallKind(scope, "", facts.url);
    if (wall) return walled(wall, scope);
  }
  const wall = wallKind(lines, facts.title, facts.url);
  if (wall) return walled(wall, lines);
  if (notFound(facts.title) && !proseHeavy(lines)) return state("error");
  // A short page that says it is on its way, among a few menu lines: on
  // 11-16 Type Network's font page read "Fonts Stories / Show filters /
  // Loading styles... / About Type Network …" (BERK#185).
  if (text.length <= 300 && lines.every((line) => line.label.length < 100)
    && lines.some((line) => line.role !== "button" && line.role !== "link" && LOADING.test(line.label))) return state("loading");
  if (lines.every((line) => LOGIN.test(line.label) || PAY_ACTION.test(line.label) || CONSENT.test(line.label) || ERROR.test(line.label)
    || /^(?:main|article|error|unavailable|access restricted|verify (?:you are|you're) human)\s*[.!?]?$/i.test(line.label))) return state("unjudged");
  return state("content");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function controlsOf(value: unknown): Control[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const controls: Control[] = [];
  for (const item of value) {
    const control = record(item);
    if (control && (control.role === "button" || control.role === "textbox") && typeof control.label === "string") controls.push({ role: control.role, label: control.label });
  }
  return controls;
}

function pageStateOf(value: unknown): PageState | undefined {
  const state = record(value);
  if (!state || typeof state.kind !== "string" || !Object.hasOwn(NEXT, state.kind) || typeof state.next !== "string") return undefined;
  return { kind: state.kind as PageKind, next: state.next };
}

// judgedText: a sample of the page's text that a read of rows or pictures
// brings only to be judged (judgedSample in content.js); it goes no
// further.
function decorate(value: Record<string, unknown>, scope?: { partial?: boolean }): Record<string, unknown> {
  const { judgedText, ...rest } = value;
  if (pageStateOf(value.pageState) || typeof value.file === "string") return judgedText === undefined ? value : rest;
  const challenge = record(value.challenge);
  const pageState = classifyPage({
    url: typeof value.url === "string" ? value.url : "",
    title: typeof value.title === "string" ? value.title : "",
    text: typeof value.snapshot === "string" ? value.snapshot : typeof value.text === "string" ? value.text : typeof judgedText === "string" ? judgedText : undefined,
    status: typeof value.status === "number" ? value.status : undefined,
    loading: value.loading === true,
    ready: value.ready === "loading" || value.ready === "interactive" || value.ready === "complete" ? value.ready : undefined,
    partial: scope?.partial === true || value.partial === true,
    truncated: value.truncated === true,
    contentType: typeof value.type === "string" ? value.type : undefined,
    controls: controlsOf(value.controls),
    challenge: challenge && typeof challenge.kind === "string" && (challenge.where === "page" || challenge.where === "box" || challenge.where === "block")
      ? { kind: challenge.kind, where: challenge.where } : undefined,
  });
  return { ...rest, pageState };
}

function mappedPage(value: unknown): unknown {
  const page = record(value);
  if (!page) return value;
  let result = page;
  if (Array.isArray(page.items)) result = { ...result, items: page.items.map(mappedPage) };
  const child = record(page.value);
  if (page.ok === true && child) {
    const existing = pageStateOf(child.pageState);
    if (existing || (typeof child.url === "string" && (typeof child.text === "string" || typeof child.snapshot === "string" || typeof child.status === "number"))) {
      const decorated = decorate(child);
      result = { ...result, value: decorated, ...(pageStateOf(page.pageState) ? {} : { pageState: decorated.pageState }) };
    }
  }
  return decorate(result);
}

const PAGE_TOOLS: Record<string, true> = { open: true, goto: true, snapshot: true, extract: true, fetch: true, info: true };

// A read some of whose answers are of a page: net's body of one request
// and pdf's read of an address, by their text; harvest's list, by its
// items' words. An eval judges its own page (judgedEval in tools.ts).
function pageReadOf(tool: string, value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Object.hasOwn(PAGE_TOOLS, tool)) return value;
  if (typeof value.url !== "string") return undefined;
  if ((tool === "net" || tool === "pdf") && typeof value.text === "string") return value;
  if (tool === "harvest" && Array.isArray(value.items)) {
    return { ...value, judgedText: value.items.map((item) => record(item)?.text).filter((text) => typeof text === "string").join("\n") };
  }
  return undefined;
}
const PAGE_WRAPPERS: Record<string, true> = { click: true, type: true, press: true, select: true, hover: true, upload: true, history: true, scroll: true, wait: true, real_input: true };

// Whether a read's arguments take part of the page, which says nothing of
// the whole page's state; so does an action's snapshot of words or of
// {query, root, diff} (pageRead in tools.ts). On 11-08 open's snapshot of
// words on a billing page found none yet and said the page was empty.
export function partialRead(args: Record<string, unknown>): boolean {
  const want = args.snapshot;
  const read = record(want);
  return ["query", "root", "ref", "selector", "interactive", "diff"].some((key) => args[key] !== undefined && args[key] !== false) ||
    (typeof want === "string" && want !== "true" && want !== "false") ||
    (read !== undefined && ["query", "root", "diff"].some((key) => read[key] !== undefined && read[key] !== false));
}

export function withPageState(tool: string, value: unknown, scope?: { partial?: boolean }): unknown {
  const object = record(value);
  if (!object) return value;
  const read = pageReadOf(tool, object);
  let result = read ? decorate(read, scope) : object;
  const page = record(object.page);
  if (page && (Object.hasOwn(PAGE_TOOLS, tool) || Object.hasOwn(PAGE_WRAPPERS, tool))) result = { ...result, page: decorate(page, scope) };
  if ((tool === "map" || tool === "follow") && Array.isArray(object.pages)) result = { ...result, pages: object.pages.map(mappedPage) };
  if (tool === "run" && Array.isArray(object.steps)) {
    result = { ...result, steps: object.steps.map((value) => {
      const step = record(value);
      return step && typeof step.tool === "string" && "value" in step ? { ...step, value: withPageState(step.tool, step.value) } : value;
    }) };
  }
  return result;
}

export function stateLine(value: unknown): string {
  const state = pageStateOf(record(value)?.pageState);
  return !state || state.kind === "content" || state.kind === "unjudged" ? "" : `page state: ${state.kind}; ${state.next}\n`;
}

// A state that tells the agent nothing it can act on: readable content, or
// the plain reminder to read before judging.
export function plainState(value: unknown): boolean {
  const state = pageStateOf(record(value)?.pageState);
  return !!state && (state.kind === "content" || state.next === NEXT.unjudged);
}
