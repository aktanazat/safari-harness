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
const REGION = /^(?:sorry[,!.]?\s*)?(?:(?:this|our) (?:site|website|service|content|video|page) (?:is )?(?:not available|unavailable|blocked|not accessible) (?:in|from) (?:your|this) (?:country|region|location)|(?:not available|unavailable) in your (?:country|region|location)|we (?:are unable to|cannot) (?:provide|offer) (?:this (?:service|content)|access) in your (?:country|region))\s*[.!]?$/i;
const CONSENT = /^(?:before you continue(?: to .+)?|we value your privacy|your privacy choices|privacy (?:and|&) cookie preferences|cookie (?:consent|preferences)|consent required)\s*[.!]?$/i;
const CHOICE = /^(?:accept all(?: cookies)?|reject (?:all|optional)(?: cookies)?|agree|i agree|i disagree|disagree|manage (?:options|preferences|cookies)|more options|customi[sz]e(?: cookies)?|only necessary(?: cookies)?)\s*[.!]?$/i;
const ERROR = /^(?:(?:error\s*)?(?:400|401|403|404|408|410|429|451|500|502|503|504)(?:\s*[-:–—]?\s*(?:bad request|unauthorized|forbidden|not found|request timeout|gone|too many requests|unavailable for legal reasons|internal server error|bad gateway|service unavailable|gateway timeout))?|(?:page|file) not found|something went wrong|access denied|forbidden|service unavailable|internal server error|bad gateway|failed to open page|error page)\s*[.!]?$/i;
// A title part that names the page missing. Safari gives a page read no
// HTTP status (27.0.1's navigation timing has no responseStatus), so the
// title is the page's own word for it: "Page not found · GitHub".
const NOT_FOUND = /^(?:(?:error )?404(?: error)?|(?:404 )?(?:page |file )?not found|this page could not be found)[.!]?$/i;
const LOADING = /^(?:loading(?: (?:content|page|results))?|please wait|signing in|redirecting)\s*[.!…]*$/i;
const OUTLINE = /^(?:\[[\w:.-]+\]\s*)?(h[1-6]|heading|form|dialog|alertdialog|button|link|textbox|label|checkbox|radio|combobox|main|article|navigation|banner)(?:\s+|$)(?:\[[\w:.-]+\]\s*)?/i;
type Line = { label: string; role: string; indent: number };

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    const outline = OUTLINE.exec(trimmed);
    const role = outline?.[1].toLowerCase() ?? "";
    const label = (outline ? trimmed.slice(outline[0].length).replace(/\s*\{[^{}]*\}\s*$/, "") : trimmed).replace(/^"(.*)"$/, "$1").trim();
    if (label) lines.push({ label, role, indent: raw.length - raw.trimStart().length });
  }
  return lines;
}

function notFound(title: string): boolean {
  return title.split(/\s*[·|:•–—]\s*|\s+-\s+/).some((part) => NOT_FOUND.test(part.trim()));
}

// Whether the page runs as prose, as an article does; a wall or a missing
// page says one short thing. A cookie notice or a copyright line is not its
// prose: on 10-24 MDN's not-found page read with "Portions of this content
// are ©1998–2026 by individual mozilla.org contributors. Content …".
function proseHeavy(lines: Line[]): boolean {
  const prose = lines.filter((line) => line.role === "" && line.label.length >= 100 && !line.label.includes("©")
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
    && new Set(labels.filter((label) => CHOICE.test(label)).map((label) => label.toLowerCase())).size >= 2) return "consent";
  if (heading(PAY) && action(PAY_ACTION)) return "paywall";
  const field = lines.some((line) => /^(?:email(?: address)?(?: or (?:phone(?: number)?|username))?|password|username|phone(?: number)?)(?:\s*[:*])?$/i.test(line.label)
    && (line.role === "" || line.role === "textbox" || line.role === "label"));
  const loginRoute = /\/(?:signin|sign-in|login|log-in|auth|sso)(?:\/|$)/i.test(URL.parse(url)?.pathname ?? "");
  if (heading(LOGIN) && ((field && (action(LOGIN_ACTION) || loginRoute || LOGIN.test(titleHead)))
    || (heading(LOGIN_REQUIRED) && action(LOGIN_ACTION)))) return "login_wall";
  if (heading(ERROR) && (ERROR.test(titleHead) || labels.length <= 2)) return "error";
  return undefined;
}

export function classifyPage(facts: PageFacts): PageState {
  const state = (kind: PageKind): PageState => ({ kind, next: NEXT[kind] });
  if (facts.challenge?.where === "block") return { kind: "error", next: "the site blocks this browser; report the block and do not bypass it." };
  if (facts.challenge?.where === "page") return { kind: "unjudged", next: "the page shows a bot check; hand it to the user with handoff rather than solving it." };
  if (/^safari-resource:.*errorpage/i.test(facts.url) || /^safari-resource:/i.test(facts.title) || facts.title === "Failed to open page") return state("error");
  const status = facts.status;
  if (status !== undefined && Number.isInteger(status)) {
    if (status === 401) return state("login_wall");
    if (status === 402) return state("paywall");
    if (status === 429) return { kind: "error", next: "respect the site's wait limit before reading this address again." };
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
  if ((facts.contentType && !/^text\/(?:plain|html)(?:;|$)/i.test(facts.contentType)) || /^<(?:!doctype|[a-z][\w:-]*(?:\s|>))/i.test(text)) return state("unjudged");
  const lines = linesOf(text);
  for (const control of facts.controls ?? []) lines.push({ ...control, indent: 0 });
  if (lines.length === 0) return state("unjudged");
  if (lines.every((line) => LOADING.test(line.label))) return state("loading");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].role !== "dialog" && lines[index].role !== "alertdialog") continue;
    let end = index + 1;
    while (end < lines.length && lines[end].indent > lines[index].indent) end++;
    const wall = wallKind(lines.slice(index, end), "", facts.url);
    if (wall) return state(wall);
  }
  const wall = wallKind(lines, facts.title, facts.url);
  if (wall) return state(wall);
  if (notFound(facts.title) && !proseHeavy(lines)) return state("error");
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

function decorate(value: Record<string, unknown>, scope?: { partial?: boolean }): Record<string, unknown> {
  if (pageStateOf(value.pageState)) return value;
  const challenge = record(value.challenge);
  const pageState = classifyPage({
    url: typeof value.url === "string" ? value.url : "",
    title: typeof value.title === "string" ? value.title : "",
    text: typeof value.snapshot === "string" ? value.snapshot : typeof value.text === "string" ? value.text : undefined,
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
  return { ...value, pageState };
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
const PAGE_WRAPPERS: Record<string, true> = { click: true, type: true, press: true, select: true, hover: true, upload: true, history: true, scroll: true, wait: true, real_input: true };

// Whether a read's arguments take part of the page, which says nothing of
// the whole page's state.
export function partialRead(args: Record<string, unknown>): boolean {
  return ["query", "root", "ref", "selector", "interactive", "diff"].some((key) => args[key] !== undefined && args[key] !== false);
}

export function withPageState(tool: string, value: unknown, scope?: { partial?: boolean }): unknown {
  const object = record(value);
  if (!object) return value;
  let result = Object.hasOwn(PAGE_TOOLS, tool) ? decorate(object, scope) : object;
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
