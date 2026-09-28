// Teach mode's recordings: what the user did once in a tab, as content.js
// recorded it and background.js sent it (bridge.ts), saved for a replay to
// do again. They are his: the folder is 0700 and each file 0600, and no
// secret he typed reaches the disk.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataFile } from "./phone.ts";

type Field = { type: string; autocomplete: string; name: string; id: string; label: string };
type Raw = { url: string; steps: unknown[]; startedAt?: unknown };

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

function isRecording(v: unknown): v is Raw {
  return !!v && typeof v === "object" && "url" in v && typeof v.url === "string" && "steps" in v && Array.isArray(v.steps);
}

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
