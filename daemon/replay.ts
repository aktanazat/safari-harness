// Replay: does again what the user taught in teach mode (recordings.ts), in
// a background tab of the caller's. Each step's target is found by its
// fingerprint (fingerprint.ts) among the page's lookalikes, looked for again
// while the page draws; one still missing, or one of several the matcher
// cannot tell apart, stops the replay at its step. It acts through the
// tools, as an agent would, so lanes, tab ownership, action receipts, and
// bot checks work as they do for one. Replay stops at a bot check.

import { createHmac, randomBytes } from "node:crypto";
import type { Challenge } from "./challenge.ts";
import type { Clock } from "./downloads.ts";
import { isFingerprint, lookalikeKey, matchFingerprint, unmatched, type Candidate } from "./fingerprint.ts";
import { assertAgentRecording, gateOfStep, loadRecording, outputOf, playbookUrl, readOnlySearchSubmit } from "./recordings.ts";
import type { AgentRecording, AgentStep, AppliedInput, PlaybookOutput } from "./recordings.ts";

type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
type Fields = Record<string, unknown>;
export type PlaybookRow = Record<string, string>;
type OutputContext = { origin?: string; applied?: AppliedInput; vars?: Record<string, string>; allowEmpty?: boolean };
export type Replayed = { ok: boolean; name: string; steps: number; failedAt?: number; error?: string; tab?: unknown; url?: unknown; title?: unknown; value?: string; rows?: PlaybookRow[]; challenge?: Challenge; gate?: string; verified?: boolean };

// How long a step's target may take to show on a page still loading or
// drawing, and how often it is looked for meanwhile.
const FIND_MS = 10_000;
const POLL_MS = 250;
const REAL: Clock = { now: Date.now, sleep: Bun.sleep };

// A secret step's field, filled from Apple Passwords by its do; the user
// never recorded the secret itself (recordings.ts).
const FILL: Record<string, string> = { password: "fill", "one-time-code": "code" };

const fields = (v: unknown): Fields => (v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : {});

// A bot check that stopped the replay, as the user reads it.
class Wall extends Error {
  constructor(readonly challenge: Challenge, tab: unknown) {
    super(challenge.where === "block"
      ? `the site blocks this browser (${challenge.kind}); the user cannot clear that either`
      : `the page shows a bot check (${challenge.kind}); wait for the page to clear in Safari, then retry with tab: ${String(tab)}; otherwise use another permitted source`);
  }
}

class Gated extends Error {
  constructor(readonly gate: string) {
    super(`this step needs the owner's ${gate} handoff; review the live page and continue manually`);
  }
}

function wallOf(result: unknown, tab: unknown): void {
  const c = fields(fields(result).challenge);
  if (typeof c.kind === "string" && (c.where === "page" || c.where === "box" || c.where === "block")) throw new Wall({ kind: c.kind, where: c.where }, tab);
}

// vars replace the text typed, or the option chosen, in the field they name
// by its name, id, or label; username picks the saved login a password step
// fills. A name no field has is a mistake, told before anything opens.
function varsOf(v: unknown, steps: unknown[]): Record<string, string> {
  if (v === undefined) return {};
  const vars = fields(v);
  if (typeof v !== "object" || !Object.values(vars).every((x) => typeof x === "string")) throw new Error('vars must map field names to text: {"q": "shoes"}');
  const known = new Set(["username"]);
  for (const s of steps) {
    const f = fields(fields(s).field);
    for (const k of [f.name, f.id, f.label]) if (typeof k === "string" && k) known.add(k);
    if (typeof fields(s).param === "string") known.add(String(fields(s).param));
  }
  const stray = Object.keys(vars).filter((k) => !known.has(k));
  if (stray.length) throw new Error(`no field in this recording is named ${stray.join(", ")}; its fields: ${[...known].join(", ")}`);
  return vars as Record<string, string>;
}

export function fingerprintRows(rows: PlaybookRow[], salt: string): string {
  return createHmac("sha256", salt).update(JSON.stringify(rows)).digest("hex");
}

export async function readPlaybookResult(call: Call, tab: unknown, selector: string): Promise<string> {
  const result = fields(fields(await call("eval", { tab, expression: `(() => { const matches = document.querySelectorAll(${JSON.stringify(selector)}); return {count: matches.length, text: matches.length === 1 ? matches[0].innerText : null}; })()` })).result);
  if (result.count !== 1) throw new Error("the result selector must match exactly one element");
  const text = result.text;
  if (typeof text !== "string" || !text.trim() || text.length > 20_000) throw new Error("the result is empty or too large to return");
  return text.replace(/\s+/g, " ").trim();
}

function inputApplied(hash: unknown, applied: AppliedInput, vars: Record<string, string>): boolean {
  const value = vars[applied.param];
  if (typeof value !== "string" || typeof hash !== "string" || (hash !== "" && !hash.startsWith("#"))) throw new Error("the applied-input check could not read the current input state");
  let decoded: string;
  try { decoded = decodeURIComponent(hash.slice(1)); }
  catch { throw new Error("the applied-input state is not a valid encoded fragment"); }
  return decoded === `${applied.prefix ?? ""}${value}`;
}

// Wait only on an observed input marker, never repeat the action that
// should have applied it. A quiet end check follows before reading rows.
export async function waitForAppliedInput(call: Call, tab: unknown, applied: AppliedInput, vars: Record<string, string>, origin: string, clock: Clock = REAL): Promise<void> {
  const deadline = clock.now() + FIND_MS;
  for (;;) {
    const answer = await call("eval", { tab, expression: "({origin: location.origin, hash: location.hash})" });
    wallOf(answer, tab);
    const result = fields(fields(answer).result);
    if (result.origin !== origin) throw new Error("the page left the learned origin before the input was verified");
    if (inputApplied(result.hash, applied, vars)) return;
    if (clock.now() >= deadline) throw new Error("the new input was not applied; no result was returned and no action was retried");
    await clock.sleep(POLL_MS);
  }
}

// Public selectors describe structure only. Values are read together from
// the live DOM and never written back into the recording.
export async function readPlaybookOutput(call: Call, tab: unknown, output: PlaybookOutput, context: OutputContext = {}): Promise<PlaybookRow[]> {
  const contract = outputOf(output);
  const answer = await call("eval", { tab, expression: `(() => {
    const output = ${JSON.stringify(contract)};
    try {
      const elements = Array.from(document.querySelectorAll(output.rows));
      if ((!elements.length && !${context.allowEmpty === true}) || elements.length > 200) return {error: "the output selector must match between 1 and 200 rows"};
      const visible = el => el instanceof HTMLElement && el.getClientRects().length > 0 &&
        !el.closest('[hidden], [aria-hidden="true"], [inert]') && !["hidden", "collapse"].includes(getComputedStyle(el).visibility);
      const selected = new Set(elements);
      const rows = [];
      let size = 0;
      for (const row of elements) {
        if (!visible(row) || row.closest('[aria-busy="true"]')) return {error: "an output row is hidden or still loading"};
        for (let parent = row.parentElement; parent; parent = parent.parentElement) {
          if (selected.has(parent)) return {error: "the output selector matches nested rows"};
        }
        const values = [];
        for (const [name, selector] of Object.entries(output.fields)) {
          const matches = selector === ":scope" ? [row] : Array.from(row.querySelectorAll(selector));
          if (matches.length !== 1) return {error: "each output field must match exactly one element in every row"};
          const el = matches[0];
          if (!visible(el) || el.closest("input, textarea, select, option, script, style, template, iframe, object, embed") ||
            typeof el.innerText !== "string") return {error: "each output field must be visible page text, not a form value or hidden content"};
          const text = el.innerText.replace(/\\s+/g, " ").trim();
          if (text.length > 2000) return {error: "an output field exceeds 2000 characters"};
          size += text.length;
          if (size > 100000) return {error: "the output exceeds 100000 characters"};
          values.push([name, text]);
        }
        if (values.every(([, text]) => !text)) return {error: "an output row has no visible text"};
        rows.push(Object.fromEntries(values));
      }
      return {rows, origin: location.origin, hash: ${context.applied ? "location.hash" : "null"}};
    } catch {
      return {error: "the output contains an invalid or unusable CSS selector"};
    }
  })()` });
  wallOf(answer, tab);
  const result = fields(fields(answer).result);
  if (typeof result.error === "string") throw new Error(result.error);
  if (context.origin !== undefined && result.origin !== context.origin) throw new Error("the output page left the learned origin");
  if (context.applied && !inputApplied(result.hash, context.applied, context.vars ?? {})) throw new Error("the page no longer shows the supplied input; no result was returned");
  if (!Array.isArray(result.rows) || (!result.rows.length && !context.allowEmpty) || result.rows.length > 200) throw new Error("the output did not return between 1 and 200 typed rows");
  const names = Object.keys(contract.fields);
  let size = 0;
  const rows: PlaybookRow[] = [];
  for (const value of result.rows) {
    const row = fields(value);
    if (Object.keys(row).length !== names.length || names.some((name) => !Object.hasOwn(row, name)
      || typeof row[name] !== "string" || row[name].length > 2000) || names.every((name) => !String(row[name]).trim())) throw new Error("the live output does not match its declared fields");
    size += Object.values(row).reduce<number>((total, text) => total + String(text).length, 0);
    if (size > 100_000) throw new Error("the output exceeds 100000 characters");
    rows.push(row as PlaybookRow);
  }
  return rows;
}

export async function replay(a: Record<string, unknown>, call: Call, clock: Clock = REAL): Promise<Replayed> {
  const rec = loadRecording(a.name);
  let learned: AgentRecording | undefined;
  if (fields(rec).source === "agent") {
    assertAgentRecording(rec);
    learned = rec;
  }
  const vars = varsOf(a.vars, rec.steps);
  if (learned) for (const param of learned.params) if (!Object.hasOwn(vars, param)) throw new Error(`missing playbook parameter ${param}; nothing was opened`);
  const done = { name: String(a.name), steps: rec.steps.length };
  const given = a.tab !== undefined;
  let tab = a.tab;
  let at = 0; // the step running; 0 while the first page opens
  let quiet: number | undefined; // the latest step whose action the page ignored
  let value: string | undefined;
  let rows: PlaybookRow[] | undefined;

  // The ref of the one element a step's fingerprint names on the page now.
  const find = async (s: Fields): Promise<unknown> => {
    if (!isFingerprint(s.target)) throw new Error("the step names no element to find");
    const fp = s.target;
    const deadline = clock.now() + FIND_MS;
    for (;;) {
      const seen = await call("lookalikes", { tab, target: fp });
      const found = (Array.isArray(seen) ? seen : []).filter((c): c is Candidate & { ref: unknown } => ["role", "name", "tag", "near", "path"].every((k) => typeof fields(c)[k] === "string"));
      const m = learned
        ? found.length === 1 && lookalikeKey(found[0]) === lookalikeKey(fp) ? { index: 0 } : { count: found.length }
        : matchFingerprint(fp, found);
      if ("index" in m) return found[m.index].ref;
      if (clock.now() >= deadline) throw new Error(unmatched(fp, m.count));
      await clock.sleep(POLL_MS);
    }
  };
  // The recorded text or option, or the var for its field.
  const textOf = (s: Fields, key: "value" | "option"): string => {
    const f = fields(s.field);
    const named = [s.param, f.name, f.id, f.label].find((k): k is string => typeof k === "string" && k !== "" && Object.hasOwn(vars, k));
    const text = named === undefined ? s[key] : vars[named];
    if (typeof text !== "string") throw new Error("the step has no text to enter");
    return text;
  };
  const acted = (result: unknown) => {
    wallOf(result, tab);
    if (learned && (fields(result).ok === false || fields(result).kept === false || fields(result).invalid || fields(result).effect === "none")) throw new Error("the page did not verify the action");
    if (fields(result).effect === "none") quiet = at;
    else quiet = undefined;
  };

  const step = async (s: Fields): Promise<void> => {
    if (learned) {
      const gate = gateOfStep(s as AgentStep);
      if (gate) throw new Gated(gate);
      if (s.kind !== "navigate" && playbookUrl(fields(await call("info", { tab })).url) !== s.url) throw new Error("the page path changed before the action; nothing at this step was replayed");
    }
    const target = async () => {
      const ref = await find(s);
      if (learned) {
        if (!/^\d+$/.test(String(ref))) throw new Error("the live target is not a top-document ref");
        const selector = `[data-sh-ref="${String(ref)}"]`;
        const live = fields(fields(await call("eval", { tab, expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const form = el.type === "submit" ? el.form : null; return {type: el.type || el.localName, autocomplete: el.getAttribute("autocomplete") || "", name: el.getAttribute("name") || "", submit: el.type === "submit", searchForm: form ? {method: el.hasAttribute("formmethod") ? el.formMethod : form.method, action: el.hasAttribute("formaction") ? el.formAction : form.action, inputs: Array.from(form.elements).filter(input => input.localName === "input" && ["text", "search"].includes(input.type)).map(input => ({name: input.name, id: input.id, type: input.type}))} : null, href: el.localName === "a" ? el.href : null}; })()` })).result);
        if (typeof live.type !== "string") throw new Error("the live control disappeared");
        if (live.submit === true && !readOnlySearchSubmit(String(fields(s.target).name ?? ""), live.searchForm, learned.steps.slice(0, at - 1), learned.url)) throw new Gated("send or submit");
        if ((s.href ?? null) !== live.href) throw new Error("the link destination changed; no action was replayed");
        if (s.kind === "type" || s.kind === "select") {
          const original = fields(s.field);
          if (["type", "autocomplete", "name"].some((key) => live[key] !== original[key])) throw new Error("the field changed; no parameter was entered");
        }
      }
      return ref;
    };
    if ((s.kind === "type" || s.kind === "select") && typeof s.secret === "string") {
      if (!Object.hasOwn(FILL, s.secret)) throw new Error(`a ${s.secret} field: replay fills only saved passwords and verification codes`);
      await call("passwords", { do: FILL[s.secret], tab, ...(vars.username === undefined ? {} : { username: vars.username }) });
      return;
    }
    switch (s.kind) {
      case "navigate":
        // one the step before led to comes of itself
        if (s.from === "user") wallOf(await call("goto", { tab, url: s.url }), tab);
        return;
      case "click":
        return acted(await call("click", { tab, ref: await target() }));
      case "press":
        return acted(await call("press", { tab, ref: await target(), key: s.key }));
      case "type":
        return acted(await call("type", { tab, ref: await target(), text: textOf(s, "value") }));
      case "select":
        return acted(await call("select", { tab, ref: await target(), option: textOf(s, "option") }));
      case "read": {
        // without a selector, wait would sleep out its whole limit
        if (typeof s.selector !== "string") throw new Error("the step names nothing to read");
        shown(await call("wait", { tab, selector: s.selector, ms: FIND_MS }), `nothing on the page is where the text was read (${s.selector})`, `whether the text is at ${s.selector} is unknown`);
        value = String(await call("element", { tab, ref: s.selector, what: "innerText" })).replace(/\s+/g, " ").trim();
        return;
      }
      default:
        throw new Error(`replay cannot do a ${String(s.kind)} step`);
    }
  };

  try {
    const first = await call(given ? "goto" : "open", given ? { tab, url: rec.url } : { url: rec.url, background: true });
    if (!given) tab = fields(first).id;
    wallOf(first, tab);
    if (learned) {
      if (playbookUrl(fields(first).url) !== learned.url) throw new Error("the first page changed path; no steps were replayed");
      const before = await call("wait", { tab, ...learned.before, ms: FIND_MS });
      wallOf(before, tab);
      shown(before, "the start condition is missing; no steps were replayed", "whether the start condition holds is unknown; no steps were replayed");
    }
    const salt = learned?.applied && learned.output ? randomBytes(16).toString("hex") : undefined;
    const baseline = salt && learned?.output ? fingerprintRows(await readPlaybookOutput(call, tab, learned.output, { allowEmpty: true }), salt) : undefined;
    for (const [i, s] of rec.steps.entries()) {
      at = i + 1;
      await step(fields(s));
    }
    if (learned) {
      at = rec.steps.length + 1;
      const origin = new URL(learned.url).origin;
      if (learned.applied) await waitForAppliedInput(call, tab, learned.applied, vars, origin, clock);
      const checked = await call("wait", { tab, ...learned.verify, ...(learned.applied ? { quiet: true } : {}), ms: FIND_MS });
      wallOf(checked, tab);
      shown(checked, "the end condition was not verified", "whether the end condition holds is unknown; it was not verified");
      if (learned.resultSelector) value = await readPlaybookResult(call, tab, learned.resultSelector);
      if (learned.output) {
        rows = await readPlaybookOutput(call, tab, learned.output, { origin, applied: learned.applied, vars });
        if (salt && fingerprintRows(rows, salt) === baseline) throw new Error("the result rows did not change after the new search; no result was returned");
      }
    }
  } catch (e) {
    return failed(e, tab, at, rec.steps[at - 1], quiet, done, call);
  }
  // The tab it opened is done with; a close that fails leaves it to close
  // with the caller's other tabs.
  if (!given) await call("close", { tab }).catch(() => {});
  return { ok: true, ...done, ...(value === undefined ? {} : { value }), ...(rows === undefined ? {} : { rows }), ...(learned ? { verified: true } : {}) };
}

// A wait the page gave no answer by its end (unanswered: wait in tools.ts)
// says nothing of what the page shows, and the replay fails saying so, not
// that the page lacks it: on 10-16, with Safari slow after a deploy, a wait
// on example.com, which showed its words all along, read as a miss.
function shown(w: unknown, missing: string, unknown: string): void {
  const f = fields(w);
  if (f.found === true) return;
  throw new Error(f.unanswered === true ? `the page gave no answer in time (Safari or the page is slow), so ${unknown}` : missing);
}

// A failed replay leaves its tab open, for the caller to look at, hand to
// the user, or go on in; where the tab is, and a bot check it shows, come
// with the error.
async function failed(e: unknown, tab: unknown, at: number, raw: unknown, quiet: number | undefined, done: { name: string; steps: number }, call: Call): Promise<Replayed> {
  const where = at === 0 ? "the first page" : at > done.steps ? "the end check" : `step ${at} (${String(fields(raw).kind)})`;
  const page = tab === undefined || e instanceof Wall ? {} : fields(await call("snapshot", { tab, maxNodes: 1 }).catch(() => ({})));
  let why = e instanceof Error ? e.message : String(e);
  let challenge = e instanceof Wall ? e.challenge : undefined;
  try {
    wallOf(page, tab);
  } catch (wall) {
    if (wall instanceof Wall) ({ message: why, challenge } = wall);
  }
  const ignored = quiet !== undefined && challenge === undefined ? ` (the page did not react to step ${quiet})` : "";
  return {
    ok: false,
    ...done,
    failedAt: at,
    error: `${where}: ${why}${ignored}`,
    ...(tab === undefined ? {} : { tab }),
    ...(typeof page.url === "string" ? { url: page.url, title: page.title } : {}),
    ...(challenge ? { challenge } : {}),
    ...(e instanceof Gated ? { gate: e.gate } : {}),
  };
}
