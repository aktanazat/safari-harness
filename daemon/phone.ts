// The harness's alerts to the user's phone, on Telegram (telegram.ts):
// handoff's, ask's, and the news of watch routines. Every alert goes out
// through here. A log of them (alerts.jsonl), shared by every process that
// sends one, holds them to LIMIT an hour across all agents and routines. It
// keeps when each went and from which process, never the line.

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { sendTelegram } from "./telegram.ts";

const execFileAsync = promisify(execFile);

// His phone is his: at most this many alerts an hour, however many agents
// and routines want one.
export const LIMIT = 6;
const HOUR_MS = 3_600_000;

// Away: the screen is locked or asleep, the Mac is on another user, or
// nothing was typed or clicked for IDLE_S. None of it needs a permission.
const IDLE_S = 180;
const AWAY = `ObjC.import("CoreGraphics");
const s = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary());
const locked = s.objectForKey("CGSSessionScreenIsLocked");
JSON.stringify({ idle: $.CGEventSourceSecondsSinceLastEventType(0, 0xffffffff), locked: !locked.isNil() && locked.boolValue, console: ObjC.unwrap(s.objectForKey("kCGSSessionOnConsoleKey")) === true, asleep: $.CGDisplayIsAsleep($.CGMainDisplayID()) !== 0 })`;

// SAFARI_HARNESS_AWAY=1 says away (a test: an alert says it is one), 0 says
// at the Mac.
export async function isAway(): Promise<boolean> {
  const forced = process.env.SAFARI_HARNESS_AWAY;
  if (forced === "1" || forced === "0") return forced === "1";
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", AWAY], { timeout: 5000 });
  const s: unknown = JSON.parse(stdout);
  if (!s || typeof s !== "object" || !("idle" in s) || !("locked" in s) || !("console" in s) || !("asleep" in s)) throw new Error(`away probe said ${stdout}`);
  return s.locked === true || s.asleep === true || s.console !== true || (typeof s.idle === "number" && s.idle >= IDLE_S);
}

// failed marks an alert that never went: it gives back its place in the hour.
type Sent = { at: number; pid: number; failed?: true };

function isSent(v: unknown): v is Sent {
  return !!v && typeof v === "object" && "at" in v && typeof v.at === "number" && "pid" in v && typeof v.pid === "number";
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

// The log's lines, oldest first. Each is appended whole, so processes
// sending at once never write over each other's; a line cut short (a
// process that died mid-write) is passed over.
function logLines(): Sent[] {
  return (readText(dataFile("alerts.jsonl")) ?? "").split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      const v: unknown = JSON.parse(line);
      return isSent(v) ? [v] : [];
    } catch {
      return [];
    }
  });
}

// The alerts that went, oldest first.
function went(lines: Sent[]): Sent[] {
  const key = (s: Sent) => `${s.at} ${s.pid}`;
  const failed = new Set(lines.filter((s) => s.failed).map(key));
  return lines.filter((s) => !s.failed && !failed.has(key(s)));
}

// Sends line to his phone, with a picture's path when there is one, unless
// LIMIT went in the last hour: then the error says so, and when the next
// may go.
export async function alert(line: string, picture?: string): Promise<void> {
  const now = Date.now();
  const lines = logLines();
  const hour = went(lines).filter((s) => now - s.at < HOUR_MS);
  if (hour.length >= LIMIT) {
    const next = Math.ceil((Math.min(...hour.map((s) => s.at)) + HOUR_MS - now) / 60_000);
    throw new Error(`the harness has alerted the user's phone ${LIMIT} times in the last hour, the most it may; the next alert can go in ${next} min`);
  }
  const log = dataFile("alerts.jsonl");
  const recent = lines.filter((s) => now - s.at < HOUR_MS);
  // Written over only once it holds many old alerts: one another process
  // logs meanwhile would be lost.
  if (lines.length - recent.length >= 100) {
    writeFileSync(`${log}.${process.pid}`, recent.map((s) => `${JSON.stringify(s)}\n`).join(""));
    renameSync(`${log}.${process.pid}`, log);
  }
  const sent: Sent = { at: now, pid: process.pid };
  mkdirSync(dirname(log), { recursive: true });
  // logged before it goes, so a process sending meanwhile counts it
  appendFileSync(log, `${JSON.stringify(sent)}\n`);
  try {
    await sendTelegram(line, picture);
  } catch (e) {
    appendFileSync(log, `${JSON.stringify({ ...sent, failed: true })}\n`);
    throw e;
  }
}
