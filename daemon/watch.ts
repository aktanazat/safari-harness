// Watch routines: a page read on a schedule, with no model. Each run opens
// the page in a background tab, reads one value from it, closes the tab,
// and alerts the user's phone when the value is not what the last run read;
// the first run only records it. A bot check or a sign-in page is his to
// clear, never the run's: it alerts him about one at most once a day.
// launchd runs it (routineRun in cli/launchd.ts); the alert needs none of
// the terminal's permissions (telegram.ts).

import { join } from "node:path";
import type { Challenge } from "./challenge.ts";
import { alert, dataFile, readJson, writeJson } from "./phone.ts";
import { rpc } from "./rpc.ts";

// How the value is read: a CSS selector's text, a regex over the page's
// text (its first group, else the whole match), a JS expression's value,
// or the last read of a recording played back (safari replay).
export type How = "selector" | "text" | "eval" | "replay";
export type Watch = { url: string; how: How; what: string };
export type Ran = { code: number; note: string };

const HOWS: How[] = ["selector", "text", "eval", "replay"];
const DAY_MS = 24 * 3_600_000;
// How long a value may take to show on a page still filling in.
const SHOW_MS = 15_000;
// A value is cut to this in an alert; the state keeps all of it.
const CLIP = 200;
const CLI = join(import.meta.dir, "..", "cli", "safari.ts");
const NO_REPLAY = "this safari has no replay command, so a watch cannot play a recording back; deploy a release that has it";

type State = { value?: string; checkAlertedAt?: number };
type Read = { value: string } | { wall: string } | { error: string };

function isState(v: unknown): v is State {
  return !!v && typeof v === "object" && (!("value" in v) || typeof v.value === "string") && (!("checkAlertedAt" in v) || typeof v.checkAlertedAt === "number");
}

export const stateFile = (name: string) => dataFile(`state/${name}.json`);

// The value the watch last read, for routine list.
export function lastValue(name: string): string | undefined {
  const s = readJson(stateFile(name));
  return isState(s) ? s.value : undefined;
}

// The watch that `routine add --watch url` with one of --selector, --text,
// --eval, or --replay describes.
export async function parseWatch(url: string, reads: Partial<Record<How, string>>): Promise<Watch> {
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
  if (how === "replay" && (await replayMissing())) throw new Error(NO_REPLAY);
  return { url, how, what };
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

// The value as the open tab shows it, or none; a wait that missed says
// whether a check stands in its way.
async function valueOf(tab: number, how: Exclude<How, "replay">, what: string): Promise<{ value?: string; challenge?: Challenge }> {
  if (how === "selector") {
    const seen = (await rpc("wait", { tab, selector: what, ms: SHOW_MS })) as { found?: boolean; challenge?: Challenge };
    if (!seen.found) return seen.challenge ? { challenge: seen.challenge } : {};
    const got = (await rpc("extract", { tab, selector: what })) as { text?: unknown };
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
    const got = (await rpc("extract", { tab, selector: "body", maxBytes: 500_000 })) as { text?: unknown };
    const m = typeof got.text === "string" ? re.exec(got.text) : null;
    if (m) return { value: m[1] ?? m[0] };
    if (Date.now() >= until) return {};
    await Bun.sleep(1000);
  }
}

// The page's value, or what stands in its way: a check, or a sign-in form
// where the value should be.
async function read(w: Watch): Promise<Read> {
  if (w.how === "replay") return replay(w.what);
  const tab = (await rpc("open", { url: w.url, background: true })) as { id: number; challenge?: Challenge };
  try {
    if (tab.challenge?.where === "block") return { error: `${tab.challenge.kind} turns this browser away from ${w.url}` };
    if (tab.challenge?.where === "page") return { wall: "a check" };
    const got = await valueOf(tab.id, w.how, w.what);
    const value = got.value?.replace(/\s+/g, " ").trim();
    if (value) return { value };
    if (got.challenge ?? tab.challenge) return { wall: "a check" };
    // login_form refuses a page that is not https: that is no sign-in wall
    const form = (await rpc("login_form", { tab: tab.id }).catch(() => ({}))) as { username?: boolean; password?: boolean };
    if (form.password || form.username) return { wall: "a sign-in page" };
    return { error: `${w.url} shows nothing for ${w.how} ${w.what}` };
  } finally {
    await rpc("close", { tab: tab.id });
  }
}

// One run. An alert that fails leaves the old value, so the next run sends
// it again.
export async function runWatch(name: string, w: Watch): Promise<Ran> {
  const file = stateFile(name);
  const kept = readJson(file);
  const state: State = isState(kept) ? kept : {};
  const got = await read(w);
  if ("error" in got) return { code: 1, note: got.error };
  if ("wall" in got) {
    const site = new URL(w.url).hostname.replace(/^www\./, "");
    const now = Date.now();
    if (state.checkAlertedAt !== undefined && now - state.checkAlertedAt < DAY_MS) return { code: 1, note: `${site} shows ${got.wall}; the user was alerted about it within the day` };
    await alert(`${name} needs you: ${site} shows ${got.wall}`);
    writeJson(file, { ...state, checkAlertedAt: now });
    return { code: 1, note: `${site} shows ${got.wall}; alerted the user` };
  }
  if (state.value === undefined) {
    writeJson(file, { ...state, value: got.value });
    return { code: 0, note: `first run: recorded ${got.value}` };
  }
  if (got.value === state.value) return { code: 0, note: `no change: ${got.value}` };
  // each value cut short in the alert; the state keeps all of it
  const [was, now] = [state.value, got.value].map((v) => (v.length > CLIP ? `${v.slice(0, CLIP - 1)}…` : v));
  await alert(`${name}: ${was} -> ${now} (${w.url})`);
  writeJson(file, { ...state, value: got.value });
  return { code: 0, note: `changed: ${state.value} -> ${got.value}; alerted the user` };
}
