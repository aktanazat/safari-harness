// Form drafts: what a form held when a click or an Enter sent it on
// (Submit, Next, Continue), kept so that refill can put it back when the
// page answers with an error, its check emptied the form, or it asks to
// sign in first (formDraft, draftFrame, and refill in content.js). They
// are the user's: the folder is 0700 and each site's file 0600, named by a
// hash so a listing names no site, and no secret reaches the disk: no
// password, card, code, or private number's field, no field the harness
// typed a secret into, no value that looks like one. A draft is of one
// form on one page and goes back only to that page: on a job board every
// company's application shares the site and the fields' names (11-11). It
// keeps a day from its last save, and goes once its form's last step went
// through.

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { HarnessError } from "./failures.ts";
import { beside } from "./guard.ts";
import { secretLook } from "./notes.ts";
import { classifyPage } from "./page-state.ts";
import { dataFile } from "./phone.ts";
import { secretOfField } from "./recordings.ts";
import { redactSecretText, tabSecrets, unsecret } from "./redact.ts";

export const DRAFT_MS = 24 * 60 * 60 * 1000;
const FORMS_MAX = 8;
const FIELDS_MAX = 200;
const VALUE_MAX = 5_000;
// A page can fill fields the agent never sees, and the secret check of a
// value can cost as its length squared: 200 values of 20,000 characters
// held the daemon 55 s on 11-11 (redact.ts LABELED on "a.a.a..."); within
// these caps the worst such page holds it 105 ms. A draft checks and keeps
// this many characters of values at most.
const DRAFT_CHARS_MAX = 30_000;
const TEXT_MAX = 2000;
const LABEL_MAX = 80;
// A draft is a page read (relay p50 3 ms in the call log of 11-11, against
// a click's 422 ms); a page that does not answer in this long gets its
// click without one.
const TAKE_MS = 3000;
// The look after a click waits for the page it led to be ready (probe in
// background.js), this long at most.
const LOOK_MS = 5000;

export type DraftField = { key: string; type: string; autocomplete: string; name: string; id: string; label: string } & ({ value: string | string[] } | { checked: boolean });
// form and page are hashes of formDraft's form key and page: an address
// can hold a token, and a draft is only ever matched to them.
export type Draft = { origin: string; form: string; page: string; at: number; fields: DraftField[] };
// A click or an Enter that sent a form on with its draft kept: the site,
// the form and page as its draft has them, whether it was the form's last
// step, and the keys of the draft's fields, for the look after it; or why
// its draft was not kept.
export type Sent = { origin: string; form: string; page: string; final: boolean; keys: string[] } | { unsaved: string };
// A frame as draftFrame in content.js saw it after the click.
export type Look = { frame: number; origin: string; page?: string; present: number; empty: number; signIn: boolean; url?: string; title?: string; alerts?: string; text?: string };
export type Outcome = "unseen" | "kept" | "emptied" | "signIn" | "error" | "sent";

const short = (v: unknown, max = TEXT_MAX): v is string => typeof v === "string" && v.length <= max;

// A field of formDraft's answer, checked: it comes from the page.
function fieldOf(v: unknown): DraftField | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  if (!short(f.key) || !short(f.type) || !short(f.autocomplete) || !short(f.name) || !short(f.id) || !short(f.label)) return null;
  const facts = { key: f.key, type: f.type, autocomplete: f.autocomplete, name: f.name, id: f.id, label: f.label.slice(0, LABEL_MAX) };
  if (f.value === undefined) return typeof f.checked === "boolean" ? { ...facts, checked: f.checked } : null;
  if (f.checked !== undefined) return null;
  if (short(f.value, VALUE_MAX)) return f.value === "" ? null : { ...facts, value: f.value };
  if (!Array.isArray(f.value)) return null;
  const values = f.value.filter((x): x is string => short(x));
  return values.length > 0 && values.length === f.value.length && values.length <= FIELDS_MAX ? { ...facts, value: values } : null;
}

// A name or an id as words: applicantSSN, applicant_ssn, and applicant-ssn
// all read "applicant SSN".
const words = (s: string) => s.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[\W_]+/g, " ");

// A private number's field, by its words: a social security, insurance, or
// tax number, a passport or a license, a bank account. Certn's applicant
// form asks for an SSN (docs/sites/certn.md).
const PRIVATE_NUMBER = /\b(?:ssn|social (?:security|insurance)|(?:tax|taxpayer) (?:id|identification|number)|itin|tin|ein|sin|nino?|national (?:id|identity|insurance)|passport|driver ?s? licen[cs]e|licen[cs]e (?:number|no)|routing|bank account|account (?:number|no)|iban)\b/i;
const SSN = /(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)/;

// Whether a field must not be kept: a password's, a code's, a card's, or a
// private number's field by its type, autocomplete, name, id, or label; or
// a value holding a secret: one the harness typed into a tab, which this
// tab's answers have cut to "..." (bridge.ts) and so is no longer what the
// user typed, or one that looks like a card number, a social security
// number, a code, a token, or a labeled password or key.
function secret(tab: number, f: DraftField): boolean {
  const named = { ...f, name: words(f.name), id: words(f.id) };
  if (secretOfField(f) || secretOfField(named) || PRIVATE_NUMBER.test(`${named.name} ${named.id} ${f.label} ${f.autocomplete}`)) return true;
  if (redactSecretText(f.label) !== f.label) return true;
  const values = "value" in f ? [f.value].flat() : [];
  if (tabSecrets.get(tab)?.size && values.some((v) => v.includes("..."))) return true;
  return values.some((v) => secretLook(v) !== undefined || SSN.test(v) || redactSecretText(v) !== v || [...tabSecrets.keys()].some((t) => unsecret(t, v) !== v));
}

// The folder, asked each time: a test points dataFile elsewhere.
const folder = () => dataFile("form-drafts");
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const fileOf = (origin: string) => join(folder(), `${hashOf(origin)}.json`);

function draftOf(v: unknown, origin: string): Draft | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (!short(d.form) || !short(d.page) || typeof d.at !== "number" || !Number.isFinite(d.at) || !Array.isArray(d.fields)) return null;
  return { origin, form: d.form, page: d.page, at: d.at, fields: d.fields.slice(0, FIELDS_MAX).map(fieldOf).filter((f): f is DraftField => f !== null) };
}

// A site's file as written, or null for none: a file cut short or written
// for another site holds none.
function siteFile(path: string): { origin: string; drafts: Draft[] } | null {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
  let site: unknown;
  try {
    site = JSON.parse(body);
  } catch {
    return null;
  }
  if (!site || typeof site !== "object") return null;
  const { origin, drafts } = site as Record<string, unknown>;
  if (typeof origin !== "string" || !Array.isArray(drafts)) return null;
  return { origin, drafts: drafts.map((d) => draftOf(d, origin)).filter((d): d is Draft => d !== null) };
}

const live = (d: Draft, now: number) => d.at <= now && now - d.at < DRAFT_MS;

// A site's drafts kept less than DRAFT_MS ago, newest first.
function readSite(origin: string, now: number): Draft[] {
  const site = siteFile(fileOf(origin));
  return site?.origin === origin ? site.drafts.filter((d) => live(d, now)) : [];
}

// Writes a site's drafts whole, or deletes its file when none are left: the
// folder 0700 and the file 0600 before a value is in it, renamed over the
// old one so a reader never finds half of it.
function writeSite(origin: string, drafts: Draft[]): void {
  const file = fileOf(origin);
  if (drafts.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const dir = folder();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const partial = `${file}.${process.pid}`;
  rmSync(partial, { force: true });
  writeFileSync(partial, JSON.stringify({ origin, drafts }), { mode: 0o600, flag: "wx" });
  renameSync(partial, file);
}

// Each site's drafts past DRAFT_MS are deleted, and a site's file with none
// left, or that is no site's drafts, goes; then a timer comes back when the
// oldest draft left is due. A draft so never outlives its day on disk.
let due: Timer | undefined;
export function sweepDrafts(now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(folder());
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return;
    throw e;
  }
  let oldest = Infinity;
  for (const name of names) {
    const path = join(folder(), name);
    const site = /^[0-9a-f]{16}\.json$/.test(name) ? siteFile(path) : null;
    const kept = site && fileOf(site.origin) === path ? site.drafts.filter((d) => live(d, now)) : [];
    if (kept.length === 0) rmSync(path, { force: true });
    else if (site && kept.length < site.drafts.length) writeSite(site.origin, kept);
    for (const d of kept) oldest = Math.min(oldest, d.at);
  }
  clearTimeout(due);
  due = oldest === Infinity ? undefined : setTimeout(() => {
    try {
      sweepDrafts();
    } catch {
      // the next save or refill sweeps again
    }
  }, Math.max(1000, oldest + DRAFT_MS - now));
  due?.unref();
}

// formDraft's answer, checked: a form step on an http or https page.
function takenOf(v: unknown): { final: boolean; form: string; page: string; origin: string; fields: DraftField[] } | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  const site = typeof t.origin === "string" ? URL.parse(t.origin) : null;
  if (typeof t.final !== "boolean" || !short(t.form) || !short(t.page, VALUE_MAX) || !site || site.origin !== t.origin || !/^https?:$/.test(site.protocol) || !Array.isArray(t.fields)) return null;
  return { final: t.final, form: t.form, page: t.page, origin: site.origin, fields: t.fields.slice(0, FIELDS_MAX).map(fieldOf).filter((f): f is DraftField => f !== null) };
}

// Keeps what a click or an Enter is about to send on (formDraft's answer),
// merged into the draft its form had on this page (an earlier step's),
// each field's newer value winning and a radio group's newer choice
// replacing the older. A draft is kept with two fields at least that are
// not checkboxes: one is no work to type again. Answers the step with its
// draft, or null when it sends no form on or its form has none.
export function saveDraft(tab: number, answer: unknown, now = Date.now()): Sent | null {
  const taken = takenOf(answer);
  if (!taken) return null;
  const form = hashOf(taken.form);
  const page = hashOf(taken.page);
  const site = readSite(taken.origin, now);
  const prior = site.find((d) => d.form === form && d.page === page);
  let chars = 0;
  const fields = taken.fields.filter((f) => {
    chars += "value" in f ? [f.value].flat().join("").length : 0;
    return chars <= DRAFT_CHARS_MAX;
  }).filter((f) => !secret(tab, f));
  const chosen = new Set(fields.filter((f) => f.type === "radio").map((f) => f.name));
  const merged = new Map((prior?.fields ?? []).filter((f) => f.type !== "radio" || !chosen.has(f.name)).map((f) => [f.key, f]));
  for (const f of fields) merged.set(f.key, f);
  const kept = [...merged.values()].slice(0, FIELDS_MAX);
  if (kept.filter((f) => f.type !== "checkbox").length < 2) return null;
  writeSite(taken.origin, [{ origin: taken.origin, form, page, at: now, fields: kept }, ...site.filter((d) => d !== prior)].slice(0, FORMS_MAX));
  sweepDrafts(now);
  return { origin: taken.origin, form, page, final: taken.final, keys: kept.map((f) => f.key) };
}

// Before a click on args[0], or an Enter (args [ref or null, "Enter"]),
// what the form it sends on holds, kept. A page that does not answer, or
// an extension without formDraft, leaves the click to go on without one;
// a draft that cannot be written says so beside the click's answer.
export async function checkpoint(tab: number, args: unknown[]): Promise<Sent | null> {
  const answer = await bridge.tab(tab, "formDraft", args, TAKE_MS).catch(() => null);
  try {
    return saveDraft(tab, answer);
  } catch (e) {
    return { unsaved: e instanceof Error ? e.message : String(e) };
  }
}

function lookOf(v: unknown): Look | null {
  if (!v || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  if (typeof l.frame !== "number" || typeof l.origin !== "string" || typeof l.present !== "number" || typeof l.empty !== "number" || typeof l.signIn !== "boolean") return null;
  const optional = (s: unknown) => (typeof s === "string" ? s : undefined);
  return { frame: l.frame, origin: l.origin, page: optional(l.page), present: l.present, empty: l.empty, signIn: l.signIn, url: optional(l.url), title: optional(l.title), alerts: optional(l.alerts), text: optional(l.text) };
}

const labels = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// What a page's alert or title says when a form did not go through, and
// when it did.
const FAILED = /\b(?:error|went wrong|try again|failed|unable to|could not|couldn't|cannot|can't|invalid|expired|timed out|required|please (?:enter|fill|complete|correct|check|select|provide))\b/i;
const WENT_THROUGH = /\b(?:thank(?:s| you)|success(?:ful(?:ly)?)?|submitted|received|sent|saved|confirmed)\b/i;

// What became of a form a click sent on, from each frame's look after it:
// unseen with no look at the top page; kept while the form's fields still
// hold their text; emptied when they are back on show empty, unless the
// page says the form went through; signIn or error when the form left for
// a sign-in or an error; sent when it left for anything else.
export function outcome(looks: Look[], origin: string): Outcome {
  const top = looks.find((l) => l.frame === 0);
  if (!top) return "unseen";
  const mine = looks.filter((l) => l.origin === origin);
  const present = mine.reduce((n, l) => n + l.present, 0);
  const empty = mine.reduce((n, l) => n + l.empty, 0);
  const said = `${top.title ?? ""}\n${top.alerts ?? ""}`;
  const page = classifyPage({ url: top.url ?? "", title: top.title ?? "", text: top.text }).kind;
  const failed = page === "error" || FAILED.test(said);
  if (present > 0) return empty === 0 ? "kept" : !failed && WENT_THROUGH.test(said) ? "sent" : "emptied";
  if (page === "login_wall" || looks.some((l) => l.signIn)) return "signIn";
  return failed ? "error" : "sent";
}

const BACK_ON_FORM = "once back on the form, refill puts back what its fields held before this click (kept a day)";

// The click's answer after a look at the page it led to: a note when the
// form came back emptied, or left for a sign-in or an error; its draft
// deleted when its last step went through. It never throws: the click
// happened, and an error would read as one to do again.
export async function afterStep(tab: number, sent: Sent, result: unknown, look = true): Promise<unknown> {
  if ("unsaved" in sent) return beside(result, "note", `the form's fields were not saved before this click: ${sent.unsaved}`);
  if (!look) return result;
  const answer = await bridge.request("probe", [tab, "draft", sent.keys], LOOK_MS).catch(() => []);
  const looks = Array.isArray(answer) ? answer.map(lookOf).filter((l): l is Look => l !== null) : [];
  switch (outcome(looks, sent.origin)) {
    case "emptied": {
      const mine = looks.filter((l) => l.origin === sent.origin);
      const empty = mine.reduce((n, l) => n + l.empty, 0);
      const present = mine.reduce((n, l) => n + l.present, 0);
      return beside(result, "note", `the form came back with ${empty} of its ${present} saved fields empty; if the page did not take it, refill puts back what they held before this click`);
    }
    case "signIn":
      return beside(result, "note", `the page asks to sign in; ${BACK_ON_FORM}`);
    case "error":
      return beside(result, "note", `the page may have answered with an error; ${BACK_ON_FORM}`);
    case "sent":
      if (!sent.final) return result;
      try {
        writeSite(sent.origin, readSite(sent.origin, Date.now()).filter((d) => d.form !== sent.form || d.page !== sent.page));
        return result;
      } catch (e) {
        return beside(result, "note", `the form went through, but its saved fields were not deleted: ${e instanceof Error ? e.message : String(e)}`);
      }
    default:
      return result;
  }
}

// Puts back what the tab's forms held before a click or an Enter sent them
// on, in each frame on a page with a draft kept (refill in content.js): it
// fills empty fields only and sends nothing. The answer counts the fields
// that hold their saved value and names by label those that do not, never
// a value.
export async function refill(tab: number, now = Date.now()): Promise<unknown> {
  sweepDrafts(now);
  const answer = await bridge.request("probe", [tab, "draft", null], LOOK_MS);
  const frames = Array.isArray(answer) ? answer.map(lookOf).filter((l): l is Look => l !== null) : [];
  const pages = frames.flatMap(({ frame, origin, page }) => {
    const at = page === undefined ? null : hashOf(page);
    const drafts = readSite(origin, now).filter((d) => d.page === at);
    return drafts.length > 0 ? [{ frame, page, drafts }] : [];
  });
  const top = frames.find((f) => f.frame === 0)?.origin;
  if (pages.length === 0) throw new HarnessError("invalid_argument", `nothing to refill: no form on this page${top ? ` of ${top}` : ""} was saved in the last day`, { retryable: false, next: "type the fields; a form's fields are saved only just before a click or an Enter sends it on (Submit, Next, Continue), and refill puts them back only on the page the form was on" });
  let filled = 0;
  const left: string[] = [];
  const missing: string[] = [];
  const lost: string[] = [];
  for (const { frame, page, drafts } of pages) {
    const put = await bridge.tab(tab, "refill", [drafts, page], 30000, frame);
    if (!put || typeof put !== "object") continue;
    const p = put as Record<string, unknown>;
    if (typeof p.filled === "number") filled += p.filled;
    left.push(...labels(p.left));
    missing.push(...labels(p.missing));
    lost.push(...labels(p.lost));
  }
  const named = { ...(left.length ? { left } : {}), ...(missing.length ? { missing } : {}), ...(lost.length ? { lost } : {}) };
  if (filled > 0) return { ok: true, filled, ...named };
  if (lost.length) throw new HarnessError("command_failed", `the page did not keep what refill put into ${lost.join(", ")}`, { next: "read the form, then type those fields" });
  throw new HarnessError("invalid_argument", `nothing was refilled: ${missing.length ? `none of the saved fields (${missing.slice(0, 5).join(", ")}) is on the page` : "every saved field holds other text or is locked"}`, { retryable: false, next: "go back to the form the click sent on, then refill" });
}
