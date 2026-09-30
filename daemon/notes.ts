// Site notes: short facts agents learn about a site (a flow's steps, a
// control that loads late, which account owns which workspace), kept past
// the session that learned them, which otherwise loses them at compaction.
// One file per host in ~/.local/share/safari-harness/notes
// (SAFARI_HARNESS_NOTES puts them elsewhere, for a test), one fact a line,
// oldest first: "- <date> [<agent>] <fact>". Beside it, the site's readers:
// scripts an agent worked out to read the site's data (a page variable, an
// API the page calls), which the next agent runs by name with eval {reader}
// instead of working them out again. The daemon writes both (the learn
// tool) and hands them out (firstNotes, readerFor); `safari guide` reads
// them.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentOwner, processName, watchOwner } from "./owner.ts";

const MAX_CHARS = 300;
const MAX_NOTES = 50;
// A site's notes come inline while they run to this many characters in
// all, three notes at their longest; past it, their count. Every site noted
// by 09-29 had one note of 124 to 289 characters, and a limit of 120 each
// sent every agent to guide for one sentence.
const INLINE_CHARS = 900;

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

// Hosts with notes or readers, for `safari guide`.
export function notedHosts(): string[] {
  try {
    const hosts = readdirSync(notesDir()).flatMap((f) => (f.endsWith(READERS) ? [f.slice(0, -READERS.length)] : f.endsWith(".md") ? [f.slice(0, -3)] : []));
    return [...new Set(hosts)].sort();
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
}

// A host's notes as `safari guide` prints them, numbered as forget takes
// them, then its readers; null when it has neither.
export function notesSection(host: string): string | null {
  const notes = readNotes(host);
  const readers = Object.entries(readReaders(host));
  const sections = [
    ...(notes.length ? [`## Learned notes for ${host}\n\n${notes.map((n, i) => `${i + 1}. ${n.fact} (${n.date}, ${n.agent})`).join("\n")}`] : []),
    ...(readers.length ? [`## Readers saved for ${host}\n\nRun one with eval {tab, reader: "<name>"}; learn {site, reader: "<name>"} shows its code.\n\n${readers.map(([name, r]) => `- ${name}: ${r.expression.length} characters${r.page ? ", in the page's own world" : ""} (${r.date}, ${r.agent})`).join("\n")}`] : []),
  ];
  return sections.length ? sections.join("\n\n") : null;
}

// ---------- readers ----------

const READERS = ".readers.json";
// It starts with a letter, so forget: "2" (the CLI's --forget 2) is a note.
const READER_NAME = /^[a-z][a-z0-9_-]{0,39}$/i;
const MAX_READER_CHARS = 10_000;

type Reader = { expression: string; page: boolean; date: string; agent: string };

const readersOf = (host: string) => join(notesDir(), `${host}${READERS}`);

// A host's readers by name, in objects with no prototype: a reader named
// constructor is the agent's, not Object's.
function readReaders(host: string): Record<string, Reader> {
  let text: string;
  try {
    text = readFileSync(readersOf(host), "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return Object.create(null) as Record<string, Reader>;
    throw e;
  }
  // the daemon's own file, written only by writeReaders
  return Object.assign(Object.create(null) as Record<string, Reader>, JSON.parse(text) as Record<string, Reader>);
}

function writeReaders(host: string, readers: Record<string, Reader>) {
  if (Object.keys(readers).length === 0) {
    rmSync(readersOf(host), { force: true });
    return;
  }
  mkdirSync(notesDir(), { recursive: true });
  writeFileSync(readersOf(host), `${JSON.stringify(readers, null, 2)}\n`);
}

// A host and the sites above it, nearest first: ecams.geico.com, then
// geico.com. What was learned on geico.com holds on its subdomains' pages.
function sitesOf(host: string): string[] {
  const labels = host.split(".");
  return Array.from({ length: Math.max(1, labels.length - 1) }, (_, i) => labels.slice(i).join("."));
}

// The reader called name saved for the page at url's site, or for a site
// above it.
export function readerFor(url: string, name: string): Reader {
  const host = siteHost(url);
  const sites = sitesOf(host);
  for (const site of sites) {
    const reader = readReaders(site)[name];
    if (reader) return reader;
  }
  const saved = sites.flatMap((site) => Object.keys(readReaders(site)));
  throw new Error(`no reader ${name} saved for ${host}; ${saved.length ? `saved: ${saved.join(", ")}` : "save one with learn {site, reader, expression}"}`);
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
  if (fact.length > MAX_CHARS) throw new Error(`a fact is at most ${MAX_CHARS} characters, and this one is ${fact.length}: keep the one thing the next agent needs, and save a script as a reader (learn {site, reader, expression})`);
  refuseSecret(fact, "Site notes are plain files every agent reads, so they never hold a password, code, card number, or token; say where it comes from instead (\"the code comes by text\")");
  const notes = readNotes(host);
  const same = notes.findIndex((n) => n.fact.toLowerCase() === fact.toLowerCase());
  if (same >= 0) return `already noted for ${host}, as note ${same + 1}`;
  notes.push({ date: new Date().toLocaleDateString("sv"), agent: agent.replace(/[\]\s]/g, "") || "unknown", fact });
  const dropped = notes.splice(0, Math.max(0, notes.length - MAX_NOTES));
  writeNotes(host, notes);
  return `saved for ${host} as note ${notes.length}${dropped.length ? `; a site keeps ${MAX_NOTES}, so the oldest went: "${dropped[0].fact}"` : ""}`;
}

function refuseSecret(text: string, why: string) {
  const secret = SECRETS.find(([, looks]) => looks(text))?.[0];
  if (secret) throw new Error(`not saved: this looks like a ${secret}. ${why}`);
}

function forget(host: string, n: number): string {
  const notes = readNotes(host);
  if (notes.length === 0) throw new Error(`no notes for ${host}`);
  if (!Number.isInteger(n) || n < 1 || n > notes.length) throw new Error(`forget takes a note number from 1 to ${notes.length}, or a reader's name; learn with only site lists them`);
  const [gone] = notes.splice(n - 1, 1);
  writeNotes(host, notes);
  return `forgot note ${n} for ${host}: "${gone.fact}"; ${notes.length} left`;
}

function saveReader(host: string, name: string, expression: string, page: boolean, agent: string): string {
  if (!READER_NAME.test(name)) throw new Error("a reader's name is a letter, then up to 39 letters, digits, - or _, like listings or price-history");
  if (!expression.trim()) throw new Error("expression is empty");
  if (expression.length > MAX_READER_CHARS) throw new Error(`a reader is at most ${MAX_READER_CHARS} characters, and this one is ${expression.length}`);
  refuseSecret(expression, "Readers are plain files every agent runs, so they never hold a password, code, card number, or token; read it from the page instead");
  const readers = readReaders(host);
  const replaced = Object.hasOwn(readers, name);
  readers[name] = { expression, page, date: new Date().toLocaleDateString("sv"), agent: agent.replace(/\s/g, "") || "unknown" };
  writeReaders(host, readers);
  return `saved reader ${name} for ${host}${replaced ? ", in place of the one saved before" : ""}; run it with eval {tab, reader: "${name}"}, or map with what: "eval"`;
}

function showReader(host: string, name: string): string {
  const reader = readReaders(host)[name];
  if (!reader) throw new Error(`no reader ${name} for ${host}`);
  return `reader ${name} for ${host} (${reader.page ? "runs in the page's own world; " : ""}${reader.date}, ${reader.agent}):\n${reader.expression}`;
}

function forgetReader(host: string, name: string): string {
  const readers = readReaders(host);
  if (!Object.hasOwn(readers, name)) throw new Error(`no reader ${name} for ${host}`);
  delete readers[name];
  writeReaders(host, readers);
  return `forgot reader ${name} for ${host}`;
}

// learn {site, fact} saves a fact, {site, forget: n} removes note n, and
// {site} alone lists the site's notes and readers. {site, reader,
// expression} saves a reader (page: true runs it in the page's own world),
// {site, reader} shows its code, and {site, forget: "<name>"} removes it.
// What is saved names the agent that learned it by its process name.
export async function learn(a: Record<string, unknown>): Promise<string> {
  if (typeof a.site !== "string") throw new Error("site must be a string: a host like cvs.com, or an address");
  const host = siteHost(a.site);
  const given = ["fact", "reader", "forget"].filter((k) => a[k] !== undefined);
  if (given.length > 1) throw new Error(`give one of fact, reader, or forget, not ${given.join(" and ")}`);
  if (typeof a.forget === "string" && !/^\s*\d+\s*$/.test(a.forget)) return forgetReader(host, a.forget);
  if (a.forget !== undefined) return forget(host, Number(a.forget));
  if (a.reader !== undefined) {
    if (typeof a.reader !== "string") throw new Error("reader must be a string: the reader's name");
    if (a.expression === undefined) return showReader(host, a.reader);
    if (typeof a.expression !== "string") throw new Error("expression must be a string");
    return saveReader(host, a.reader, a.expression, a.page === true, await agentName());
  }
  if (a.fact === undefined) return notesSection(host) ?? `no notes or readers for ${host}`;
  if (typeof a.fact !== "string") throw new Error("fact must be a string");
  return save(host, a.fact, await agentName());
}

async function agentName(): Promise<string> {
  const owner = currentOwner();
  return (owner === undefined ? undefined : await processName(owner)) ?? "unknown";
}

// ---------- notes that come by themselves ----------

// The sites each agent has been told about, so a site's notes and readers
// come once per agent: with the first open, goto, or snapshot result on it
// or on one of its subdomains. A page not found there brings them again
// (again), since a note may say why the page is missing. Calls with no
// agent known (another Mac's) share one list.
const told = new Map<number | undefined, Set<string>>();

// The lines for a result on the page at url, for its host and each site
// above it with notes or readers the agent has not had, or, with again,
// has: the notes themselves up to INLINE_CHARS, else their count, and the
// readers' names. undefined when there are none. A file that cannot be read
// costs its lines, not the result.
export function firstNotes(url: unknown, again = false): string | undefined {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined;
  let host: string;
  try {
    host = siteHost(url);
  } catch {
    // an address with no plain host (an IPv6 one) has no notes
    return undefined;
  }
  const owner = currentOwner();
  let sites = told.get(owner);
  if (!sites) {
    sites = new Set();
    told.set(owner, sites);
    if (owner !== undefined) watchOwner(owner, () => told.delete(owner));
  }
  const lines: string[] = [];
  for (const site of sitesOf(host)) {
    if (sites.has(site) && !again) continue;
    sites.add(site);
    try {
      lines.push(...linesFor(site));
    } catch (e) {
      console.error(`[safari-harness] site notes for ${site} not read:`, e instanceof Error ? e.message : e);
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}

// Notes past INLINE_CHARS come as a count and the call that reads them,
// learn with only site, which every agent has: on 09-29 an agent over MCP
// called guide, a CLI command, and was told there is no such tool.
function linesFor(site: string): string[] {
  const notes = readNotes(site);
  const readers = Object.keys(readReaders(site));
  const chars = notes.reduce((sum, n) => sum + n.fact.length, 0);
  return [
    ...(notes.length === 0 ? [] : chars <= INLINE_CHARS ? [`site notes for ${site}: ${notes.map((n, i) => `(${i + 1}) ${n.fact}`).join(" ")}`] : [`site notes for ${site}: ${notes.length}; read them with learn {site: "${site}"}`]),
    ...(readers.length ? [`readers saved for ${site}: ${readers.join(", ")}; run one with eval {tab, reader: "<name>"}`] : []),
  ];
}
