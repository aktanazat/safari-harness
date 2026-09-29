// Action receipts: what a click, a key, or an option did to the page.
//
// content.js watches the page for a moment after each such action
// (withReceipt) and answers with what it saw: a raw receipt of the nodes
// added and removed, other changes, where the address and the focus went,
// the states of the control and of what it controls, a dialog, the requests
// the page made, and the errors it threw. effectOf turns that into the
// action's effect, or into "none" with what to try next: an agent whose
// click the page ignored learns it from the click's own answer, instead of
// from a snapshot a turn later.

import { redactUrl } from "./redact.ts";

export type NetEntry = { method: string; url: string; status?: number; error?: string };

// An element whose states (stateOf's words in content.js) the action
// changed, named as a snapshot names it: button "Menu".
export type StateChange = { who: string; before: string[]; after: string[] };

export type RawReceipt = {
  added: number;
  removed: number;
  // elements whose attributes or text changed in place
  changed: number;
  // the new address, when the page moved without loading another
  url: string | null;
  // where the focus went, when it moved: an element, or "page"
  focus: string | null;
  states: StateChange[];
  // a dialog that opened: one the page drew, or alert, confirm, or prompt
  dialog: string | null;
  // the address the requests are judged against
  page: string;
  // null when the page keeps no request log (a tab no agent works in)
  requests: NetEntry[] | null;
  pending: NetEntry[] | null;
  errors: string[];
};

export type Effect = {
  added?: number;
  removed?: number;
  changed?: number;
  url?: string;
  focus?: string;
  states?: string[];
  dialog?: string;
  net?: string[];
};

export const NO_EFFECT = "the page did not react; the control may need a real click (real_input), a different target (a child or parent), or the page may be busy";

// A page that refused what an action started because Safari did not have
// it in front, or because no real click started it: a passkey, Touch ID,
// or security key request (navigator.credentials), the clipboard, playback.
// WebKit refuses such a call with a NotAllowedError, and dialogs.js keeps
// an unhandled rejection's message, which leaves the name out.
const REFUSED = /document is not focused|NotAllowedError|not allowed by the user agent or the platform in the current context/i;
const NEEDS_FRONT = "the page refused because Safari was not in front or the click was not real: activate, then real_input; a passkey or Touch ID prompt that then opens needs the user (handoff)";

// The page's errors as an action's answer carries them, their secret
// parameters cut as addresses' are (redact.ts), and the next step when one
// is such a refusal. click, press, and select answer with them here, and
// so does real_input's press (input.ts).
export function pageErrorsOf(errors: string[]): { pageErrors?: string[]; next?: string } {
  if (!errors.length) return {};
  return { pageErrors: errors.map(redactUrl), ...(errors.some((e) => REFUSED.test(e)) ? { next: NEEDS_FRONT } : {}) };
}

// content.js carries site, keepRequest, and urlMatch with these bodies,
// between its "tested with daemon/receipt.test.ts" markers: the page tells
// with them whether it is still waiting on a request and whether a wait's
// address has come. receipt.test.ts runs both copies on one table.

// The site a host belongs to: its last two labels, or three under a
// two-letter country code whose second label is short (bbc.co.uk,
// shop.com.au). An IP address stands for itself.
export function site(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  const n = labels.length > 2 && labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3 ? 3 : 2;
  return labels.slice(-n).join(".");
}

// Path segments analytics, logging, and ad scripts report to. A page sends
// them on every click, so they say nothing about this one.
const BEACON = /^(collect|analytics|log|beacon|track|pixel)(\.\w+)?$/i;

// Whether a request belongs in a receipt: one to the page's own site, less
// its beacons. One that changes something (PUT, PATCH, DELETE) always
// counts, whatever its path.
export function keepRequest(entry: { method: string; url: string }, page: string): boolean {
  const to = URL.parse(entry.url);
  const from = URL.parse(page);
  if (!to || !from || site(to.hostname) !== site(from.hostname)) return false;
  if (entry.method !== "GET" && entry.method !== "POST") return true;
  return !to.pathname.split("/").some((segment) => BEACON.test(segment));
}

// A wait's url: /regex/ with its flags, or else a part of the address. A
// bad regex throws, so wait refuses it before asking the page.
export function urlMatch(href: string, pattern: string): boolean {
  const re = /^\/(.+)\/([dgimsuvy]*)$/.exec(pattern);
  return re ? new RegExp(re[1], re[2]).test(href) : href.includes(pattern);
}

// How many request lines a receipt lists; the rest are counted.
const NET_LINES_MAX = 10;

// The requests a receipt reports: failed ones first ("failed: POST
// /api/cart 500"), then the rest, then those still out ("pending: GET
// /api/list"). A path stands without its query, which can carry a token; a
// request to another host of the site names that host.
export function netLines(requests: NetEntry[], pending: NetEntry[], page: string): string[] {
  const host = URL.parse(page)?.host;
  const where = (e: NetEntry) => {
    const u = new URL(e.url);
    return u.host === host ? u.pathname : `${u.host}${u.pathname}`;
  };
  const done = requests.filter((e) => keepRequest(e, page));
  const failed = done.filter((e) => e.error !== undefined || (e.status ?? 0) >= 400);
  const lines = [
    ...failed.map((e) => `failed: ${e.method} ${where(e)} ${e.error ?? e.status}`),
    ...done.filter((e) => !failed.includes(e)).map((e) => `${e.method} ${where(e)} ${e.status}`),
    ...pending.filter((e) => keepRequest(e, page)).map((e) => `pending: ${e.method} ${where(e)}`),
  ];
  return lines.length > NET_LINES_MAX ? [...lines.slice(0, NET_LINES_MAX), `and ${lines.length - NET_LINES_MAX} more`] : lines;
}

// A state word's key, so a value's old and new pair up: value="1" and
// value="2" are both value, "3 options" is options, and a flag is itself.
const stateKey = (s: string) => (/^\w+=/.test(s) ? s.slice(0, s.indexOf("=")) : / options$/.test(s) ? "options" : s);

// One line per element whose states changed: what it is now, what it no
// longer is, and a value's old and new. Focus is left out: the receipt
// says where it went.
//   button "Menu": now expanded
//   combobox "Size": value="S" -> value="M"
export function stateLines(changes: StateChange[]): string[] {
  const byKey = (words: string[]) => new Map(words.filter((s) => s !== "focused").map((s) => [stateKey(s), s]));
  return changes.flatMap(({ who, before, after }) => {
    const was = byKey(before);
    const now = byKey(after);
    const parts: string[] = [];
    for (const [key, s] of now) {
      const old = was.get(key);
      if (old === undefined) parts.push(`now ${s}`);
      else if (old !== s) parts.push(`${old} -> ${s}`);
    }
    for (const [key, s] of was) if (!now.has(key)) parts.push(`no longer ${s}`);
    return parts.length ? [`${who}: ${parts.join(", ")}`] : [];
  });
}

// The effect a raw receipt shows, or "none" with the next thing to try.
// The page's uncaught errors come beside it, since a handler that threw is
// often why nothing happened; one that says the page refused for want of
// focus or a real click sets the next step even beside an effect. Page text
// in it (a name, a link's address, an error) has its secret parameters cut,
// as addresses are (redact.ts).
export function effectOf(raw: RawReceipt): { effect: Effect | "none"; next?: string; pageErrors?: string[] } {
  const states = stateLines(raw.states).map(redactUrl);
  const net = raw.requests === null ? [] : netLines(raw.requests, raw.pending ?? [], raw.page);
  const effect: Effect = {
    ...(raw.added > 0 ? { added: raw.added } : {}),
    ...(raw.removed > 0 ? { removed: raw.removed } : {}),
    ...(raw.changed > 0 ? { changed: raw.changed } : {}),
    ...(raw.url !== null ? { url: raw.url } : {}),
    ...(raw.focus !== null ? { focus: redactUrl(raw.focus) } : {}),
    ...(states.length ? { states } : {}),
    ...(raw.dialog !== null ? { dialog: redactUrl(raw.dialog) } : {}),
    ...(net.length ? { net } : {}),
  };
  const errors = pageErrorsOf(raw.errors);
  return Object.keys(effect).length ? { effect, ...errors } : { effect: "none", next: NO_EFFECT, ...errors };
}

// An action's answer with the page's raw receipt turned into its effect.
// One that says where it led (another page, a new tab, a download) reports
// that as before and nothing more: the page it left may well show nothing.
export function withEffect(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("receipt" in result)) return result;
  // content.js's answer: the receipt withReceipt built beside the action's own keys
  const { receipt, ...rest } = result as { receipt: RawReceipt } & Record<string, unknown>;
  const led = ["navigated", "newTab", "downloaded", "downloading"].some((key) => key in rest);
  return led ? rest : { ...rest, ...effectOf(receipt) };
}

// Whether a wait names something on the page to wait for; one with only ms
// waits for the page to settle, ms at most.
export function waitsOnPage(a: { selector?: unknown; text?: unknown; any?: unknown; gone?: unknown; url?: unknown; quiet?: unknown }): boolean {
  return a.quiet === true || [a.selector, a.text, a.any, a.gone, a.url].some((v) => v !== undefined);
}

export const WAIT_NEEDS = "wait needs ms, selector, text, any, gone, url, or quiet";
