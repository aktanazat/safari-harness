// Teach mode's recordings: what the user did once in a tab, as content.js
// recorded it and background.js sent it (bridge.ts), saved for a replay to
// do again (replay.ts). They are his: the folder is 0700 and each file
// 0600, and no secret he typed reaches the disk.

import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataFile } from "./phone.ts";

type Field = { type: string; autocomplete: string; name: string; id: string; label: string };
export type Recording = { url: string; steps: unknown[]; title?: unknown; startedAt?: unknown };

// content.js judges each field as he types; this copy judges each step
// again before it is saved, so a page script that sent a secret's text
// still leaves only its kind on disk. Keep it as content.js's copy between
// its "shared with daemon/recordings.ts" markers: recordings.test.ts runs
// both on one table.
const SECRET_HINTS = { password: /passw|passcode|\bpin\b/i, code: /\botp\b|one.?time|verification.?code|\b2fa\b|\bmfa\b/i, card: /\bcc-|card|cvv|cvc|csc|expir|security.?code/i };

function secretOfField(f: Field): string | null {
  const hints = `${f.name} ${f.id} ${f.label}`;
  if (f.type === "hidden") return "hidden";
  if (f.type === "password" || /\b(current|new)-password\b/i.test(f.autocomplete) || SECRET_HINTS.password.test(hints)) return "password";
  if (/\bone-time-code\b/i.test(f.autocomplete) || SECRET_HINTS.code.test(hints)) return "one-time-code";
  if (/\bcc-/i.test(f.autocomplete) || SECRET_HINTS.card.test(hints)) return "card";
  return null;
}

function fieldOf(v: unknown): Field | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  const text = (key: string) => {
    const s = f[key];
    return typeof s === "string" ? s : "";
  };
  return { type: text("type"), autocomplete: text("autocomplete"), name: text("name"), id: text("id"), label: text("label") };
}

// A step keeps its text or option only when its field is judged no secret;
// one without field facts cannot be judged, so it keeps neither.
function redactStep(step: unknown): unknown {
  if (!step || typeof step !== "object" || Array.isArray(step)) return step;
  const s = step as Record<string, unknown>;
  if (!("value" in s) && !("option" in s)) return s;
  const field = fieldOf(s.field);
  const kind = (field ? secretOfField(field) : "unknown") ?? (typeof s.secret === "string" ? s.secret : null);
  if (!kind) return s;
  return { ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "value" && k !== "option")), secret: kind };
}

function isRecording(v: unknown): v is Recording {
  return !!v && typeof v === "object" && "url" in v && typeof v.url === "string" && "steps" in v && Array.isArray(v.steps);
}

const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";

// A recording's name: its site and the minute it began, in local time
// (example.com-20260928-1412).
function stem(url: string, startedAt: number): string {
  const host = (URL.canParse(url) && new URL(url).hostname) || "page";
  const d = new Date(startedAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${host}-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

// Saves a recording the extension sent, redacted first, and returns its
// name. A name already taken (two in one minute) gets -2, -3, ...; wx never
// writes over a file.
export function saveRecording(raw: unknown): string {
  if (!isRecording(raw)) throw new Error("not a recording: it needs a url and steps");
  const dir = dataFile("recordings");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // a folder made earlier, or by hand, may let others read it
  chmodSync(dir, 0o700);
  const body = JSON.stringify({ ...raw, steps: raw.steps.map(redactStep) }, null, 1);
  const base = stem(raw.url, typeof raw.startedAt === "number" ? raw.startedAt : Date.now());
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      writeFileSync(join(dir, `${name}.json`), body, { flag: "wx", mode: 0o600 });
      return name;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
}

// The file a caller's name stands for: only ever one in the folder, never
// a path out of it.
function fileOf(name: unknown): string {
  if (typeof name !== "string" || !/^[\w-][\w.-]*$/.test(name)) throw new Error("name must be a recording's name, as recordings lists them");
  return join(dataFile("recordings"), `${name}.json`);
}

export function loadRecording(name: unknown): Recording {
  let rec: unknown;
  try {
    rec = JSON.parse(readFileSync(fileOf(name), "utf8"));
  } catch (e) {
    throw missing(e) ? new Error(`no recording named ${String(name)}; recordings lists them`) : e;
  }
  if (!isRecording(rec)) throw new Error(`${String(name)} is not a recording`);
  return rec;
}

// Newest first, each with what a caller tells them apart by.
function listRecordings(): { name: string; url: string; title: string; steps: number; began: string }[] {
  let files: string[];
  try {
    files = readdirSync(dataFile("recordings"));
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
  const recs = files.filter((f) => f.endsWith(".json")).map((f) => ({ name: f.slice(0, -".json".length), rec: loadRecording(f.slice(0, -".json".length)) }));
  const at = (r: Recording) => (typeof r.startedAt === "number" ? r.startedAt : 0);
  return recs.sort((a, b) => at(b.rec) - at(a.rec)).map(({ name, rec }) => ({
    name,
    url: rec.url,
    title: typeof rec.title === "string" ? rec.title : "",
    steps: rec.steps.length,
    began: new Date(at(rec)).toLocaleString("sv").slice(0, 16),
  }));
}

function removeRecording(name: unknown): { removed: string } {
  try {
    unlinkSync(fileOf(name));
  } catch (e) {
    throw missing(e) ? new Error(`no recording named ${String(name)}; recordings lists them`) : e;
  }
  return { removed: String(name) };
}

// The recordings tool. show wraps the recording: its steps at the top
// would print as a run's (formatResult).
export async function recordingsTool(a: Record<string, unknown>): Promise<unknown> {
  switch (a.do ?? "list") {
    case "list":
      return listRecordings();
    case "show":
      return { name: a.name, recording: loadRecording(a.name) };
    case "rm":
      return removeRecording(a.name);
    default:
      throw new Error("do must be list, show, or rm");
  }
}
