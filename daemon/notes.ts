// Site notes: short facts agents learn about a site (a flow's steps, a
// control that loads late, which account owns which workspace), kept past
// the session that learned them, which otherwise loses them at compaction.
// One file per host in ~/.local/share/safari-harness/notes
// (SAFARI_HARNESS_NOTES puts them elsewhere, for a test), one fact a line,
// oldest first: "- <date> [<agent>] <fact>". The daemon writes them (the
// learn tool) and hands them out (firstNotes); `safari guide` reads them.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentOwner, processName, watchOwner } from "./owner.ts";

const MAX_CHARS = 300;
const MAX_NOTES = 50;
// Up to this many notes, each this short, come inline instead of a count.
const INLINE_NOTES = 3;
const INLINE_CHARS = 120;

type Note = { date: string; agent: string; fact: string };

const LINE = /^- (\d{4}-\d{2}-\d{2}) \[([^\]]*)\] (.+)$/;

function notesDir(): string {
  return process.env.SAFARI_HARNESS_NOTES ?? join(homedir(), ".local/share/safari-harness/notes");
}

const fileOf = (host: string) => join(notesDir(), `${host}.md`);

// The host a site names: a host or an address, lowercased, without its
// scheme, port, path, or "www.", so one site keeps one file.
export function siteHost(site: string): string {
  const s = site.trim().toLowerCase();
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`);
  const host = (url?.hostname ?? "").replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) throw new Error(`not a site: ${site}; give a host like cvs.com, or an address`);
  return host;
}

function readNotes(host: string): Note[] {
  let text: string;
  try {
    text = readFileSync(fileOf(host), "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
  return text.split("\n").flatMap((line) => {
    const m = LINE.exec(line);
    return m ? [{ date: m[1], agent: m[2], fact: m[3] }] : [];
  });
}

function writeNotes(host: string, notes: Note[]) {
  if (notes.length === 0) {
    rmSync(fileOf(host), { force: true });
    return;
  }
  mkdirSync(notesDir(), { recursive: true });
  writeFileSync(fileOf(host), `# ${host}\n\n${notes.map((n) => `- ${n.date} [${n.agent}] ${n.fact}`).join("\n")}\n`);
}

// Hosts with notes, for `safari guide`.
export function notedHosts(): string[] {
  try {
    return readdirSync(notesDir()).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
}

// A host's notes as `safari guide` prints them, numbered as forget takes
// them; null when it has none.
export function notesSection(host: string): string | null {
  const notes = readNotes(host);
  if (notes.length === 0) return null;
  return `## Learned notes for ${host}\n\n${notes.map((n, i) => `${i + 1}. ${n.fact} (${n.date}, ${n.agent})`).join("\n")}`;
}

// ---------- secrets ----------

// The notes are plain files every agent reads, so a fact that looks like a
// secret is refused. Each test errs toward refusing: an agent can reword a
// fact, but not take back a password it wrote down.

// Words after "password is" that say where it is kept, not what it is.
const KEPT: Record<string, true> = Object.fromEntries(["a", "an", "the", "in", "on", "at", "from", "under", "saved", "stored", "kept", "managed", "filled", "autofilled", "required", "needed", "asked", "not", "only", "never", "optional", "reset", "changed", "sent", "set", "field", "box", "step", "page", "prompt", "screen"].map((w) => [w, true]));

function password(s: string): boolean {
  for (const m of s.matchAll(/\b(?:pass(?:word|wd|code|phrase)|pwd)\b\s*(?:is\b|[:=])\s*(\S+)/gi)) {
    if (!KEPT[m[1].toLowerCase().replace(/[^a-z]/g, "")]) return true;
  }
  return false;
}

function code(s: string): boolean {
  return /(?<!\b(?:zip|postal|area|country|promo|coupon|discount|error|status|source|product|style) )\b(?:code|otp|pin|passcode)\b\D{0,12}(?<!\d)\d{4,8}(?!\d)/i.test(s)
    || /(?<!\d)\d{4,8}(?!\d)\s+is\s+(?:the|my|your)\s+(?:\w+\s+)?(?:code|otp|pin)\b/i.test(s);
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i]) * (i % 2 === 1 ? 2 : 1);
    sum += d > 9 ? d - 9 : d;
  }
  return sum % 10 === 0;
}

function card(s: string): boolean {
  for (const m of s.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

// A run of letters and digits with two digits or more that switches
// between upper case, lower case, and digits at 35% of its characters or
// more reads as random: a random key switches at about 60%, hex at about
// 47%, and a camelCase name with a year in it at about 25%. A name with no
// digits (getElementsByClassName) never counts.
function random(run: string): boolean {
  if ((run.match(/\d/g) ?? []).length < 2) return false;
  const kind = (c: string) => (/\d/.test(c) ? 0 : c === c.toUpperCase() ? 1 : 2);
  let switches = 0;
  for (let i = 1; i < run.length; i++) if (kind(run[i]) !== kind(run[i - 1])) switches++;
  return switches / run.length >= 0.35;
}

function token(s: string): boolean {
  return /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(s)
    || /\b(?:token|api[ _-]?key|secret|client[ _-]?secret)\b\s*(?:is\b|[:=])\s*[A-Za-z0-9._~+/=-]{12,}/i.test(s)
    || [...s.matchAll(/[A-Za-z0-9]{20,}/g)].some((m) => random(m[0]));
}

const SECRETS: [string, (s: string) => boolean][] = [["password", password], ["card number", card], ["verification code", code], ["token", token]];

// ---------- the learn tool ----------

function save(host: string, given: string, agent: string): string {
  const fact = given.replace(/\s+/g, " ").trim();
  if (!fact) throw new Error("fact is empty");
  if (fact.length > MAX_CHARS) throw new Error(`a fact is at most ${MAX_CHARS} characters, and this one is ${fact.length}: keep the one thing the next agent needs`);
  const secret = SECRETS.find(([, looks]) => looks(fact))?.[0];
  if (secret) throw new Error(`not saved: this looks like a ${secret}. Site notes are plain files every agent reads, so they never hold a password, code, card number, or token; say where it comes from instead ("the code comes by text")`);
  const notes = readNotes(host);
  const same = notes.findIndex((n) => n.fact.toLowerCase() === fact.toLowerCase());
  if (same >= 0) return `already noted for ${host}, as note ${same + 1}`;
  notes.push({ date: new Date().toLocaleDateString("sv"), agent: agent.replace(/[\]\s]/g, "") || "unknown", fact });
  const dropped = notes.splice(0, Math.max(0, notes.length - MAX_NOTES));
  writeNotes(host, notes);
  return `saved for ${host} as note ${notes.length}${dropped.length ? `; a site keeps ${MAX_NOTES}, so the oldest went: "${dropped[0].fact}"` : ""}`;
}

function forget(host: string, n: number): string {
  const notes = readNotes(host);
  if (notes.length === 0) throw new Error(`no notes for ${host}`);
  if (!Number.isInteger(n) || n < 1 || n > notes.length) throw new Error(`forget takes a note number from 1 to ${notes.length}; learn with only site lists them`);
  const [gone] = notes.splice(n - 1, 1);
  writeNotes(host, notes);
  return `forgot note ${n} for ${host}: "${gone.fact}"; ${notes.length} left`;
}

// learn {site, fact} saves a fact, {site, forget: n} removes note n, and
// {site} alone lists the site's notes. A fact names the agent that learned
// it by its process name.
export async function learn(a: Record<string, unknown>): Promise<string> {
  if (typeof a.site !== "string") throw new Error("site must be a string: a host like cvs.com, or an address");
  const host = siteHost(a.site);
  if (a.fact !== undefined && a.forget !== undefined) throw new Error("give fact or forget, not both");
  if (a.forget !== undefined) return forget(host, Number(a.forget));
  if (a.fact === undefined) return notesSection(host) ?? `no notes for ${host}`;
  if (typeof a.fact !== "string") throw new Error("fact must be a string");
  const owner = currentOwner();
  return save(host, a.fact, (owner === undefined ? undefined : await processName(owner)) ?? "unknown");
}

// ---------- notes that come by themselves ----------

// The hosts each agent has been told about, so a site's notes come once per
// agent: with the first open, goto, or snapshot result on that host. Calls
// with no agent known (another Mac's) share one list.
const told = new Map<number | undefined, Set<string>>();

// The line for a result on the page at url: the notes themselves when a
// few short ones, else their count; undefined when there are none, or the
// agent has had them. A notes file that cannot be read costs the line, not
// the result.
export function firstNotes(url: unknown): string | undefined {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined;
  let host: string;
  try {
    host = siteHost(url);
  } catch {
    // an address with no plain host (an IPv6 one) has no notes
    return undefined;
  }
  const owner = currentOwner();
  let hosts = told.get(owner);
  if (!hosts) {
    hosts = new Set();
    told.set(owner, hosts);
    if (owner !== undefined) watchOwner(owner, () => told.delete(owner));
  }
  if (hosts.has(host)) return undefined;
  hosts.add(host);
  let notes: Note[];
  try {
    notes = readNotes(host);
  } catch (e) {
    console.error(`[safari-harness] site notes for ${host} not read:`, e instanceof Error ? e.message : e);
    return undefined;
  }
  if (notes.length === 0) return undefined;
  if (notes.length <= INLINE_NOTES && notes.every((n) => n.fact.length <= INLINE_CHARS)) return `site notes for ${host}: ${notes.map((n, i) => `(${i + 1}) ${n.fact}`).join(" ")}`;
  return `site notes for ${host}: ${notes.length}; read them with guide ${host}`;
}
