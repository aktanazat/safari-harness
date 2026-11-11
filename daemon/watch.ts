// Watch routines: a page read on a schedule, with no model. Each run opens
// the page in a background tab, reads one value from it, closes the tab,
// and keeps the reading in a short series. A plain watch alerts the user's
// phone when the value is not what the last run read; a price watch only
// when the price falls below every price in the series; an availability
// watch only when something opens after a reading of none. The first run
// only records. A bot check or a sign-in page is his to clear, never the
// run's: it alerts him about one at most once a day.
// launchd runs it (routineRun in cli/launchd.ts); the alert needs none of
// the terminal's permissions (telegram.ts).

import { statSync } from "node:fs";
import { join } from "node:path";
import type { Challenge } from "./challenge.ts";
import { alert, dataFile, readJson, writeJson } from "./phone.ts";
import { rpc } from "./rpc.ts";

// How the value is read: a CSS selector's text, a regex over the page's
// text (its first group, else the whole match), a JS expression's value,
// or the last read of a recording played back (safari replay).
export type How = "selector" | "text" | "eval" | "replay";
// What a change means: any change (the default), a price that fell below
// the series' lowest, or an opening after none.
export type Kind = "price" | "availability";
export type Watch = { url: string; how: How; what: string; kind?: Kind };
export type Ran = { code: number; note: string };

const HOWS: How[] = ["selector", "text", "eval", "replay"];
const KINDS: Kind[] = ["price", "availability"];
const DAY_MS = 24 * 3_600_000;
// How long a value may take to show on a page still filling in.
const SHOW_MS = 15_000;
// A value is cut to this in an alert; the series keeps up to VALUE_MAX.
const CLIP = 200;
// The series' bound: 100 readings of at most 2,000 characters each, about
// two days of a watch that runs every 30 minutes.
const SERIES_MAX = 100;
const VALUE_MAX = 2_000;
// Only the user's account may read the series: it records what he watches.
const OWNER_ONLY = 0o600;
const CLI = join(import.meta.dir, "..", "cli", "safari.ts");
const NO_REPLAY = "this safari has no replay command, so a watch cannot play a recording back; deploy a release that has it";

type Reading = { at: number; value: string };
type State = { readings: Reading[]; checkAlertedAt?: number };
type Read = { value: string } | { wall: string } | { error: string };

const isReading = (v: unknown): v is Reading => !!v && typeof v === "object" && "at" in v && typeof v.at === "number" && "value" in v && typeof v.value === "string";

export const stateFile = (name: string) => dataFile(`state/${name}.json`);

// The state kept for the watch. A state from before the series held only
// the last value, which reads as one reading taken when it was written.
function loadState(file: string): State {
  const s = readJson(file);
  if (!s || typeof s !== "object") return { readings: [] };
  const checkAlertedAt = "checkAlertedAt" in s && typeof s.checkAlertedAt === "number" ? { checkAlertedAt: s.checkAlertedAt } : {};
  if ("readings" in s && Array.isArray(s.readings)) return { readings: s.readings.filter(isReading), ...checkAlertedAt };
  if ("value" in s && typeof s.value === "string") return { readings: [{ at: statSync(file).mtimeMs, value: s.value.slice(0, VALUE_MAX) }], ...checkAlertedAt };
  return { readings: [], ...checkAlertedAt };
}

// The value the watch last read, for routine list.
export function lastValue(name: string): string | undefined {
  return loadState(stateFile(name)).readings.at(-1)?.value;
}

// One reading as routine history prints it: with the price a price watch
// takes from it, or whether an availability watch counts it as open.
export type HistoryRow = { at: string; value: string; price?: string; open?: boolean };

// The series, oldest first, for routine history.
export function history(name: string, kind?: Kind): HistoryRow[] {
  return loadState(stateFile(name)).readings.map((r) => ({
    at: new Date(r.at).toISOString(),
    value: r.value,
    ...(kind === "price" ? { price: priceOf(r.value)?.text } : {}),
    ...(kind === "availability" ? { open: isOpen(r.value) } : {}),
  }));
}

// An amount: a currency mark or code before it, then a whole number: one
// with thousands commas (or lakh commas, 1,29,999), or one with a decimal
// point (up to three places, as a fuel price has) or comma; never one that
// starts or ends inside more digits, or a percentage.
const AMOUNT = /(?:([$€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD|JPY|INR)\b)\s?)?(?<![\d.,])(\d{1,3}(?:,\d{2,3})*,\d{3}(?:\.\d{1,3})?|\d+(?:\.\d{1,3}|,\d{1,2})?)(?![\d.,]*\d|\s*%)/g;
// Words that make the amount after them a price the item is not sold at:
// a crossed-out "was" price, a list price, or a saving.
const NOT_PRICE_BEFORE = /\b(?:was|list(?: price)?|reg(?:ular)?(?: price)?|orig(?:inal(?:ly)?)?(?: price)?|compare(?: at)?|msrp|rrp|before|typical(?: price)?|save|you save)\W*$/i;
const NOT_PRICE_AFTER = /^\s*(?:off\b|savings?\b)/i;

// The price a reading shows: its first amount that is no "was" price or
// saving, and, when any amount has a currency mark, the first such one.
function priceOf(value: string): { amount: number; text: string } | undefined {
  const found = [];
  let since = 0;
  for (const m of value.matchAll(AMOUNT)) {
    const before = value.slice(Math.max(since, m.index - 30), m.index);
    const after = value.slice(m.index + m[0].length, m.index + m[0].length + 12);
    since = m.index + m[0].length;
    if (NOT_PRICE_BEFORE.test(before) || NOT_PRICE_AFTER.test(after)) continue;
    const digits = /^\d{1,3}(?:,\d{2,3})*,\d{3}(?:\.\d+)?$/.test(m[2]) ? m[2].replaceAll(",", "") : m[2].replace(",", ".");
    found.push({ amount: Number(digits), text: m[0].trim(), marked: m[1] !== undefined });
  }
  const pick = found.find((f) => f.marked) ?? found[0];
  return pick && { amount: pick.amount, text: pick.text };
}

// A reading of nothing, a zero, an empty list, or one that says nothing is
// left counts as none open.
const NONE = /^(?:|0|\[\]|\{\}|false|null|none)[.!]?$/i;
const CLOSED = /\b(?:sold out|out of stock|unavailable|(?:not|no longer) (?:\w+ )?available|fully booked|booked up|notify me|coming soon|(?:none|nothing|0) (?:\w+ )?(?:available|left|open)|no (?:\w+ ){0,2}(?:appointments?|slots?|times?|dates?|openings?|availability|tickets?|seats?))\b/i;
const isOpen = (value: string) => !NONE.test(value.trim()) && !CLOSED.test(value);

// The watch that `routine add --watch url` with one of --selector, --text,
// --eval, or --replay, and --kind if given, describes.
export async function parseWatch(url: string, reads: Partial<Record<How, string>>, kind?: string): Promise<Watch> {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new Error("--watch needs an http or https address");
  const given = HOWS.filter((h) => reads[h] !== undefined);
  if (given.length !== 1) throw new Error("a watch reads its value one way: give one of --selector, --text, --eval, or --replay");
  const how = given[0];
  const what = reads[how] ?? "";
  if (!what.trim()) throw new Error(`--${how} needs a value`);
  if (how === "text") {
    try {
      new RegExp(what);
    } catch (e) {
      throw new Error(`--text is not a regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const k = KINDS.find((x) => x === kind);
  if (kind !== undefined && !k) throw new Error(`--kind is ${KINDS.join(" or ")}`);
  if (how === "replay" && (await replayMissing())) throw new Error(NO_REPLAY);
  return { url, how, what, ...(k ? { kind: k } : {}) };
}

// Whether the safari command lacks replay: it answers an unknown command
// with exit 2.
async function replayMissing(): Promise<boolean> {
  const p = Bun.spawn([process.execPath, CLI, "replay", "--help"], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return code === 2 && err.includes("unknown command: replay");
}

// The recording's last read, played back by the replay command, which
// opens and closes a tab of its own. It prints one JSON object whether or
// not the replay went through: ok, and value when the recording ends on a
// read.
async function replay(recording: string): Promise<Read> {
  const p = Bun.spawn([process.execPath, CLI, "replay", recording, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code === 2 && err.includes("unknown command: replay")) return { error: NO_REPLAY };
  let r: unknown;
  try {
    r = JSON.parse(out);
  } catch {
    return { error: `replay ${recording} gave no result: ${(err || out).trim().slice(0, 300)}` };
  }
  if (!r || typeof r !== "object" || !("ok" in r)) return { error: `replay ${recording} gave no result: ${out.trim().slice(0, 300)}` };
  if (r.ok !== true) return { error: `replay ${recording} failed: ${"error" in r && typeof r.error === "string" ? r.error : `exit ${code}`}` };
  if (!("value" in r) || typeof r.value !== "string") return { error: `recording ${recording} ends on no read, so it gives nothing to watch; record it again ending on the value` };
  return { value: r.value };
}

// A price element's text without its crossed-out parts (s, del, strike, or
// a line through it), where a sale shows the "was" price; hidden parts are
// left out as the page leaves them out. Inline parts join as drawn ($, 79,
// .49 in separate spans read $79.49); a block part stands apart.
const unstruck = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const text = (n) => {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1 || n.matches("s, del, strike, script, style")) return "";
    const style = getComputedStyle(n);
    if (style.display === "none" || style.textDecorationLine.includes("line-through")) return "";
    const inner = [...n.childNodes].map(text).join("");
    return style.display.startsWith("inline") ? inner : " " + inner + " ";
  };
  return text(el);
})()`;

// The value as the open tab shows it, or none; a wait that missed says
// whether a check stands in its way.
async function valueOf(tab: number, how: Exclude<How, "replay">, what: string, kind?: Kind): Promise<{ value?: string; challenge?: Challenge }> {
  if (how === "selector") {
    const seen = (await rpc("wait", { tab, selector: what, ms: SHOW_MS })) as { found?: boolean; challenge?: Challenge };
    if (!seen.found) return seen.challenge ? { challenge: seen.challenge } : {};
    if (kind === "price") {
      const evaluated = (await rpc("eval", { tab, expression: unstruck(what) })) as { result?: unknown };
      return typeof evaluated.result === "string" ? { value: evaluated.result } : {};
    }
    const got = (await rpc("extract", { tab, selector: what, save: false })) as { text?: unknown };
    return typeof got.text === "string" ? { value: got.text } : {};
  }
  if (how === "eval") {
    const evaluated = await rpc("eval", { tab, expression: what });
    const result = evaluated && typeof evaluated === "object" && "result" in evaluated ? evaluated.result : undefined;
    return result === undefined || result === null ? {} : { value: typeof result === "string" ? result : JSON.stringify(result) };
  }
  // The page may fill in after it loads, so its text is read again until
  // the regex matches.
  const re = new RegExp(what);
  const until = Date.now() + SHOW_MS;
  for (;;) {
    const got = (await rpc("extract", { tab, selector: "body", maxBytes: 500_000, save: false })) as { text?: unknown };
    const m = typeof got.text === "string" ? re.exec(got.text) : null;
    if (m) return { value: m[1] ?? m[0] };
    if (Date.now() >= until) return {};
    await Bun.sleep(1000);
  }
}

// The page's value, or what stands in its way: a check, or a sign-in form
// where the value should be. On an availability watch, a page that shows
// nothing for the read, with neither in the way, reads as none open.
async function read(w: Watch): Promise<Read> {
  if (w.how === "replay") return replay(w.what);
  const tab = (await rpc("open", { url: w.url, background: true })) as { id: number; challenge?: Challenge };
  try {
    if (tab.challenge?.where === "block") return { error: `${tab.challenge.kind} turns this browser away from ${w.url}` };
    if (tab.challenge?.where === "page") return { wall: "a check" };
    const got = await valueOf(tab.id, w.how, w.what, w.kind);
    const value = got.value?.replace(/\s+/g, " ").trim();
    if (value) return { value };
    if (got.challenge ?? tab.challenge) return { wall: "a check" };
    // login_form refuses a page that is not https: that is no sign-in wall
    const form = (await rpc("login_form", { tab: tab.id }).catch(() => ({}))) as { username?: boolean; password?: boolean };
    if (form.password || form.username) return { wall: "a sign-in page" };
    if (w.kind === "availability") return { value: "" };
    return { error: `${w.url} shows nothing for ${w.how} ${w.what}` };
  } finally {
    await rpc("close", { tab: tab.id });
  }
}

const clip = (v: string) => (v.length > CLIP ? `${v.slice(0, CLIP - 1)}…` : v);

// What a reading means against the series before it: a note for the run,
// and the alert to send, if any.
function judge(name: string, w: Watch, before: Reading[], value: string): { note: string; alert?: string; code?: number } {
  if (w.kind === "price") {
    const price = priceOf(value);
    if (!price) return { code: 1, note: `no price in ${value}` };
    const prior = before.flatMap((r) => priceOf(r.value) ?? []);
    if (prior.length === 0) return { note: `first price: ${price.text}` };
    const low = prior.reduce((a, b) => (b.amount < a.amount ? b : a));
    const span = `the lowest of the last ${prior.length} reading${prior.length === 1 ? "" : "s"}`;
    if (price.amount >= low.amount) return { note: `price ${price.text}; ${span} was ${low.text}` };
    return { note: `price dropped to ${price.text}, below ${low.text}, ${span}`, alert: `${name}: price dropped to ${price.text}, below ${low.text}, ${span} (${w.url})` };
  }
  const last = before.at(-1);
  if (last === undefined) return { note: `first run: recorded ${value || "nothing"}` };
  if (w.kind === "availability") {
    if (!isOpen(value)) return { note: `none open: ${value || "nothing shown"}` };
    if (isOpen(last.value)) return { note: `still open: ${value}` };
    return { note: `opened: ${value}`, alert: `${name}: open now: ${clip(value)} (${w.url})` };
  }
  if (value === last.value) return { note: `no change: ${value}` };
  return { note: `changed: ${last.value} -> ${value}`, alert: `${name}: ${clip(last.value)} -> ${clip(value)} (${w.url})` };
}

// One run. An alert that fails leaves the series as it was, so the next
// run sends it again, and the note says why he was not told.
export async function runWatch(name: string, w: Watch): Promise<Ran> {
  const file = stateFile(name);
  const state = loadState(file);
  const got = await read(w);
  if ("error" in got) return { code: 1, note: got.error };
  if ("wall" in got) {
    const site = new URL(w.url).hostname.replace(/^www\./, "");
    const now = Date.now();
    if (state.checkAlertedAt !== undefined && now - state.checkAlertedAt < DAY_MS) return { code: 1, note: `${site} shows ${got.wall}; the user was alerted about it within the day` };
    const failed = await alert(`${name} needs you: ${site} shows ${got.wall}`).then(() => undefined, (e: Error) => e.message);
    if (failed !== undefined) return { code: 1, note: `${site} shows ${got.wall}; the user was not told: ${failed}` };
    writeJson(file, { ...state, checkAlertedAt: now }, OWNER_ONLY);
    return { code: 1, note: `${site} shows ${got.wall}; alerted the user` };
  }
  const value = got.value.slice(0, VALUE_MAX);
  const verdict = judge(name, w, state.readings, value);
  let note = verdict.note;
  if (verdict.alert !== undefined) {
    const failed = await alert(verdict.alert).then(() => undefined, (e: Error) => e.message);
    if (failed !== undefined) return { code: 1, note: `${note}; the user was not told: ${failed}` };
    note += "; alerted the user";
  }
  writeJson(file, { ...state, readings: [...state.readings, { at: Date.now(), value }].slice(-SERIES_MAX) }, OWNER_ONLY);
  return { code: verdict.code ?? 0, note };
}
