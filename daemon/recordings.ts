// Teach mode's recordings: what the user did once in a tab, as content.js
// recorded it and background.js sent it (bridge.ts), saved for a replay to
// do again (replay.ts). They are his: the folder is 0700 and each file
// 0600, and no secret he typed reaches the disk.

import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataFile } from "./phone.ts";
import { isFingerprint } from "./fingerprint.ts";
import type { Fingerprint } from "./fingerprint.ts";

export type Field = { type: string; autocomplete: string; name: string; id: string; label: string };
export type Recording = { url: string; steps: unknown[]; title?: unknown; startedAt?: unknown };

const SECRET_HINTS = { password: /passw|passcode|\bpin\b/i, code: /\botp\b|one.?time|verification.?code|\b2fa\b|\bmfa\b/i, card: /\bcc-|card|cvv|cvc|csc|expir|security.?code/i };

export function secretOfField(f: Field): string | null {
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

// Agent runs use the same recordings, but keep parameters, never their
// values. This is the storage and replay boundary: a local recording cannot
// opt out of validation by skipping the playbooks tool.
export type Check = { text?: string; selector?: string };
export type AgentStep = { kind: string; url: string; target?: Fingerprint; field?: Field; param?: string; key?: string; from?: string; gate?: string; href?: string };
export type AgentRecording = Recording & { source: "agent"; verified: true; goal: string; params: string[]; before: Check; verify: Check; steps: AgentStep[] };

export function checkOf(v: unknown): Check {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("a check needs text or selector");
  const c = v as Record<string, unknown>;
  if (Object.keys(c).some((k) => k !== "text" && k !== "selector")
    || !Object.values(c).every((s) => typeof s === "string" && s.trim() !== "")
    || (!c.text && !c.selector)) throw new Error("a check needs nonempty text or selector");
  return c as Check;
}

// Keep generic task/control labels only, not mail text, credentials, or
// private addresses. Callers still owe generic goals and structural checks.
export function publicLabel(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 300
    || /[\r\n]|[\w.+-]+@[\w.-]+|\b\d{4,}\b|\b(?:bearer|cookie|token|secret|password)\s*[:=]|https?:\/\/|[A-Za-z0-9_-]{32,}/i.test(v)) throw new Error("use a short generic label, without private text or secrets");
  return v.trim();
}

export function playbookUrl(v: unknown): string {
  const u = typeof v === "string" ? URL.parse(v) : null;
  if (!u || !["http:", "https:"].includes(u.protocol) || u.username || u.password
    || /(?:reset|verify|invite|magic)[^/]*\/|[\w-]{32,}|@/i.test(decodeURIComponent(u.pathname))) throw new Error("the playbook needs a public page path, not a secret link");
  return u.origin + u.pathname;
}

export function gateOfStep(s: AgentStep): string | undefined {
  if (s.gate) return s.gate;
  if (s.field && secretOfField(s.field)) return "sign-in or secret";
  if (s.kind === "press" && s.key === "Enter") return "approval";
  const label = `${s.target?.name ?? ""} ${s.field?.label ?? ""} ${new URL(s.url).pathname}`;
  const gates: [string, RegExp][] = [
    ["send", /\b(send|post|publish|reply|share|submit|message|invite)\b/i],
    ["spend", /\b(buy|pay|purchase|order|checkout|subscribe|donate|book|transfer)\b/i],
    ["delete", /\b(delete|remove|discard|trash|clear)\b/i],
    ["stop", /\b(stop|cancel|unsubscribe|deactivate|disable)\b/i],
    ["account settings", /\b(account|settings|password|security|billing)\b/i],
    ["sign-in", /\b(sign[\s_-]?in|log[\s_-]?in|sign[\s_-]?up|verify|captcha|challenge)\b/i],
  ];
  return gates.find(([, pattern]) => pattern.test(label))?.[0];
}

export function assertAgentRecording(raw: Recording): asserts raw is AgentRecording {
  const r = raw as Recording & Record<string, unknown>;
  if (r.source !== "agent" || r.verified !== true) throw new Error("the agent run is not verified");
  if (Object.keys(r).some((k) => !["url", "steps", "startedAt", "source", "verified", "goal", "params", "before", "verify"].includes(k))) throw new Error("the agent recording contains unrecognized data");
  publicLabel(r.goal);
  if (playbookUrl(r.url) !== r.url) throw new Error("agent recordings keep no URL query or fragment");
  for (const c of [checkOf(r.before), checkOf(r.verify)]) for (const text of Object.values(c)) publicLabel(text);
  if (!Array.isArray(r.params) || !r.params.every((p) => typeof p === "string" && /^[a-zA-Z][\w-]{0,63}$/.test(p))
    || new Set(r.params).size !== r.params.length || !r.steps.length) throw new Error("the agent run needs steps and named parameters");
  const used = new Set<string>();
  for (const rawStep of r.steps) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) throw new Error("invalid agent step");
    const s = rawStep as AgentStep;
    if (Object.keys(s).some((k) => !["kind", "url", "target", "field", "param", "key", "from", "gate", "href"].includes(k))
      || !["click", "type", "select", "press", "navigate"].includes(s.kind)
      || playbookUrl(s.url) !== s.url || new URL(s.url).origin !== new URL(r.url).origin) throw new Error("the agent step contains unsafe or unsupported data");
    if (s.kind === "navigate") {
      if (s.from !== "user") throw new Error("invalid agent navigation");
    } else {
      const f = s.target;
      if (!isFingerprint(f)
        || f.near !== "" || f.path !== "" || f.index !== 0 || f.count !== 1
        || !/^[a-z][a-z0-9-]*$/.test(f.tag) || Object.keys(f).length !== 7) throw new Error("agent targets must have one unique control label, without surrounding page text");
      publicLabel(f.name);
      if (s.href !== undefined && (playbookUrl(s.href) !== s.href || new URL(s.href).origin !== new URL(r.url).origin)) throw new Error("the link destination is unsafe");
    }
    if (s.gate !== undefined) publicLabel(s.gate);
    if (s.kind === "press" && !["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(s.key ?? "")) throw new Error("unsupported agent key");
    if (s.kind === "type" || s.kind === "select") {
      if (!s.field || Object.keys(s.field).some((k) => !["type", "autocomplete", "name", "id", "label"].includes(k))
        || Object.keys(s.field).length !== 5 || !Object.values(s.field).every((v) => typeof v === "string")) throw new Error("the field facts are missing");
      for (const label of Object.values(s.field)) if (label) publicLabel(label);
      if (typeof s.param !== "string" || !r.params.includes(s.param)) throw new Error("the field needs a named parameter");
      used.add(s.param);
    }
  }
  if (used.size !== r.params.length) throw new Error("the agent run has unused parameters");
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
  if ("source" in raw && raw.source === "agent") assertAgentRecording(raw);
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
export function listRecordings(): { name: string; url: string; title: string; steps: number; began: string }[] {
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
