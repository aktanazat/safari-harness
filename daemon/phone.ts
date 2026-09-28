// The harness's texts to the user's own phone, and his replies to them.
// Every text goes out through here: handoff's alerts, ask's questions, and
// the notes of watch routines. A log of them (texts.jsonl), shared by every
// process that texts, holds them to LIMIT an hour across all agents and
// routines, and tells his replies from the harness's own lines, which come
// back to the Mac as received too. It keeps when each line went and a hash
// of it, never the line.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ownThread, textOwner, textOwnNumber } from "./imessage.ts";

const execFileAsync = promisify(execFile);

// His phone is his: at most this many texts an hour, however many agents
// and routines want one.
export const LIMIT = 6;
const HOUR_MS = 3_600_000;
// The log keeps a day, longer than any wait on a reply.
const KEEP_MS = 24 * HOUR_MS;
// How often a wait reads his thread. Handoff looks at the page as soon as
// he says done, sooner than its own look once a second.
export const POLL_MS = 500;
// A line he texts his own number can show as sent and as received; two
// copies written this close together are one reply.
const TWIN_MS = 120_000;

// Away: the screen is locked or asleep, the Mac is on another user, or
// nothing was typed or clicked for IDLE_S. None of it needs a permission.
const IDLE_S = 180;
const AWAY = `ObjC.import("CoreGraphics");
const s = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary());
const locked = s.objectForKey("CGSSessionScreenIsLocked");
JSON.stringify({ idle: $.CGEventSourceSecondsSinceLastEventType(0, 0xffffffff), locked: !locked.isNil() && locked.boolValue, console: ObjC.unwrap(s.objectForKey("kCGSSessionOnConsoleKey")) === true, asleep: $.CGDisplayIsAsleep($.CGMainDisplayID()) !== 0 })`;

// SAFARI_HARNESS_AWAY=1 says away (a test: a text says it is one), 0 says
// at the Mac.
export async function isAway(): Promise<boolean> {
  const forced = process.env.SAFARI_HARNESS_AWAY;
  if (forced === "1" || forced === "0") return forced === "1";
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", AWAY], { timeout: 5000 });
  const s: unknown = JSON.parse(stdout);
  if (!s || typeof s !== "object" || !("idle" in s) || !("locked" in s) || !("console" in s) || !("asleep" in s)) throw new Error(`away probe said ${stdout}`);
  return s.locked === true || s.asleep === true || s.console !== true || (typeof s.idle === "number" && s.idle >= IDLE_S);
}

// What a text waits for. ask: any reply answers it. handoff: done, skip,
// or stop; done leaves it waiting, since the check may still be there.
// note: nothing (a watch's news).
export type Kind = "ask" | "handoff" | "note";
// The replies a handoff takes, by their first word.
export type Word = "done" | "skip" | "stop";
// Where the replies to a text are: his thread (to, his number) after the
// rowid the text went out after, and which line it was, by hash.
export type Thread = { to: string; after: number; hash: string; kind: Kind };
export type Texted = { status: "received" | "sent" | "unconfirmed"; picture?: string; thread: Thread };
// failed marks a text that never went: it gives back its place in the hour.
type Sent = { at: number; hash: string; kind: Kind; failed?: true };

const isKind = (v: unknown): v is Kind => v === "ask" || v === "handoff" || v === "note";
export const isWord = (w: string): w is Word => w === "done" || w === "skip" || w === "stop";

function isSent(v: unknown): v is Sent {
  return !!v && typeof v === "object" && "at" in v && typeof v.at === "number" && "hash" in v && typeof v.hash === "string" && "kind" in v && isKind(v.kind);
}

export function isThread(v: unknown): v is Thread {
  return !!v && typeof v === "object" && "to" in v && typeof v.to === "string" && "after" in v && typeof v.after === "number"
    && "hash" in v && typeof v.hash === "string" && "kind" in v && isKind(v.kind);
}

// A file of the harness's own state.
export function dataFile(name: string): string {
  return join(homedir(), ".local", "share", "safari-harness", name);
}

// A file's text, or undefined when there is no such file yet.
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  }
}

// A JSON file's value, or undefined when there is no such file yet.
export function readJson(path: string): unknown {
  const body = readText(path);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${path} is not JSON; delete it to start it over`);
  }
}

// Written whole and renamed over the old one, so another process never
// reads half of it.
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.${process.pid}`;
  writeFileSync(part, `${JSON.stringify(value)}\n`);
  renameSync(part, path);
}

// Runs of whitespace count as one space: a line goes out, and is compared,
// as one line.
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const hashOf = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 16);

// A reply's first word, lowercased, without its punctuation: "Done!" says done.
export function firstWord(reply: string): string {
  return reply.toLowerCase().match(/[\p{L}\p{N}]+/u)?.[0] ?? "";
}

// The log's lines, oldest first. Each is appended whole, so processes
// texting at once never write over each other's; a line cut short (a
// process that died mid-write) is passed over.
function logLines(): Sent[] {
  return (readText(dataFile("texts.jsonl")) ?? "").split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      const v: unknown = JSON.parse(line);
      return isSent(v) ? [v] : [];
    } catch {
      return [];
    }
  });
}

// The texts that went, oldest first.
function logged(lines: Sent[]): Sent[] {
  const failed = new Set(lines.filter((s) => s.failed).map((s) => `${s.at} ${s.hash}`));
  return lines.filter((s) => !s.failed && !failed.has(`${s.at} ${s.hash}`));
}

// Texts line to his phone, unless LIMIT went in the last hour: then the
// error says so, and when the next may go. picture goes first. With to,
// his number known already, the text goes with no look at Messages'
// database, which a scheduled run may not read, so nothing confirms it
// arrived.
export async function text(line: string, kind: Kind, via: { picture?: string; to?: string } = {}): Promise<Texted> {
  const now = Date.now();
  const lines = logLines();
  const hour = logged(lines).filter((s) => now - s.at < HOUR_MS);
  if (hour.length >= LIMIT) {
    const next = Math.ceil((Math.min(...hour.map((s) => s.at)) + HOUR_MS - now) / 60_000);
    throw new Error(`the harness has texted the user's phone ${LIMIT} times in the last hour, the most it may; the next text can go in ${next} min`);
  }
  const log = dataFile("texts.jsonl");
  const day = lines.filter((s) => now - s.at < KEEP_MS);
  // Written over only once it holds many old texts: a text another process
  // logs meanwhile would be lost.
  if (lines.length - day.length >= 100) {
    writeFileSync(`${log}.${process.pid}`, day.map((s) => `${JSON.stringify(s)}\n`).join(""));
    renameSync(`${log}.${process.pid}`, log);
  }
  const flat = oneLine(line);
  const sent: Sent = { at: now, hash: hashOf(flat), kind };
  mkdirSync(dirname(log), { recursive: true });
  // logged before it goes, so a process texting meanwhile counts it
  appendFileSync(log, `${JSON.stringify(sent)}\n`);
  try {
    if (via.to !== undefined) {
      await textOwnNumber(via.to, flat);
      return { status: "unconfirmed", thread: { to: via.to, after: 0, hash: sent.hash, kind } };
    }
    const r = await textOwner(flat, via.picture);
    return { status: r.status, ...(r.picture === undefined ? {} : { picture: r.picture }), thread: { to: r.to, after: r.after, hash: sent.hash, kind } };
  } catch (e) {
    appendFileSync(log, `${JSON.stringify({ ...sent, failed: true })}\n`);
    throw e;
  }
}

// His replies to thread's text, oldest first. A reply goes to the newest
// text before it that takes one: with a question and a handoff out at
// once, skip goes to whichever came last, and a word no handoff takes goes
// to the question. The harness's own lines are no replies, and neither is
// the second copy of a line he texts his own number.
export function replies(thread: Thread): string[] {
  const ours = new Map(logged(logLines()).map((s) => [s.hash, s.kind]));
  ours.set(thread.hash, thread.kind);
  const seen = new Set<string>();
  // texts that take a reply, oldest first; mine is thread's own
  const open: { mine: boolean; kind: Kind }[] = [];
  // his lines whose second copy has not come
  const lone: { line: string; me: boolean; at: number }[] = [];
  const out: string[] = [];
  for (const row of ownThread(thread.to, thread.after)) {
    const line = oneLine(row.text);
    // a picture
    if (!line) continue;
    const hash = hashOf(line);
    const kind = ours.get(hash);
    if (kind !== undefined) {
      // A text takes replies from its first copy on, sent or come back:
      // which one Messages writes first is its own affair.
      if (!seen.has(hash) && kind !== "note") open.push({ mine: hash === thread.hash, kind });
      seen.add(hash);
      continue;
    }
    const twin = lone.findIndex((l) => l.line === line && l.me !== row.me && Math.abs(l.at - row.at) <= TWIN_MS);
    if (twin >= 0) {
      lone.splice(twin, 1);
      continue;
    }
    lone.push({ line, me: row.me, at: row.at });
    const word = firstWord(line);
    const to = open.findLastIndex((o) => o.kind === "ask" || isWord(word));
    if (to < 0) continue;
    if (open[to].mine) out.push(line);
    // done leaves a handoff open: the check may still be there
    if (open[to].kind === "ask" || word !== "done") open.splice(to, 1);
  }
  return out;
}
