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
export type PlaybookOutput = { rows: string; fields: Record<string, string> };
export type AppliedInput = { param: string; in: "hash"; prefix?: string };
type PlaybookVersion = { tool: string; revision: number; previous?: string };
export type AgentRecording = Recording & { source: "agent"; verified: true; goal: string; params: string[]; before: Check; verify: Check; resultSelector?: string; output?: PlaybookOutput; applied?: AppliedInput; version?: PlaybookVersion; steps: AgentStep[] };
export type SavedPlaybook = { name: string; tool: string; revision: number; recording: AgentRecording };
type RevisionSummary = { name: string; revision: number; current: boolean };

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

export function outputOf(v: unknown): PlaybookOutput {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("output needs rows and fields selectors");
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 2 || !Object.hasOwn(o, "rows") || !Object.hasOwn(o, "fields")
    || !o.fields || typeof o.fields !== "object" || Array.isArray(o.fields)) throw new Error("output needs only rows and fields selectors");
  const selector = (value: unknown): string => {
    const s = publicLabel(value);
    if (/data-sh-ref|\[\s*value(?:\s|[~|^$*]?=|\])/i.test(s)) throw new Error("output selectors must use public structure, not input values or temporary refs");
    return s;
  };
  const entries = Object.entries(o.fields);
  if (!entries.length || entries.length > 20 || entries.some(([key]) => !/^[a-zA-Z][\w-]{0,63}$/.test(key))) throw new Error("output needs between 1 and 20 public field names");
  return { rows: selector(o.rows), fields: Object.fromEntries(entries.map(([key, value]) => [key, selector(value)])) };
}

export function appliedOf(v: unknown, params: string[]): AppliedInput {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("applied needs a parameter and a hash check");
  const a = v as Record<string, unknown>;
  if (Object.keys(a).some((key) => !["param", "in", "prefix"].includes(key)) || typeof a.param !== "string"
    || !params.includes(a.param) || a.in !== "hash"
    || (a.prefix !== undefined && (typeof a.prefix !== "string" || !/^[a-zA-Z][a-zA-Z0-9/_-]{0,79}$/.test(a.prefix)))) throw new Error("applied needs a declared parameter, in: hash, and an optional public hash prefix");
  if (a.prefix !== undefined) publicLabel(a.prefix);
  return { param: a.param, in: "hash", ...(a.prefix === undefined ? {} : { prefix: String(a.prefix) }) };
}

export function playbookUrl(v: unknown): string {
  const u = typeof v === "string" ? URL.parse(v) : null;
  if (!u || !["http:", "https:"].includes(u.protocol) || u.username || u.password
    || /(?:reset|verify|invite|magic)[^/]*\/|[\w-]{32,}|@/i.test(decodeURIComponent(u.pathname))) throw new Error("the playbook needs a public page path, not a secret link");
  return u.origin + u.pathname;
}

export function readOnlySearchSubmit(name: string, form: unknown, steps: AgentStep[], url: string): boolean {
  if (!/^(?:search|find)\b/i.test(name) || !form || typeof form !== "object" || Array.isArray(form)) return false;
  const candidate = form as Record<string, unknown>;
  if (candidate.method !== "get" || typeof candidate.action !== "string" || !Array.isArray(candidate.inputs)) return false;
  try { if (playbookUrl(candidate.action) !== url) return false; } catch { return false; }
  return steps.some((step) => step.kind === "type" && step.param && step.field && candidate.inputs.some((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    return (input.type === "text" || input.type === "search") && input.type === step.field?.type
      && ((step.field.name !== "" && input.name === step.field.name) || (step.field.id !== "" && input.id === step.field.id));
  }));
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
  if (Object.keys(r).some((k) => !["url", "steps", "startedAt", "source", "verified", "goal", "params", "before", "verify", "resultSelector", "output", "applied", "version"].includes(k))) throw new Error("the agent recording contains unrecognized data");
  publicLabel(r.goal);
  if (playbookUrl(r.url) !== r.url) throw new Error("agent recordings keep no URL query or fragment");
  for (const c of [checkOf(r.before), checkOf(r.verify)]) for (const text of Object.values(c)) publicLabel(text);
  if (r.resultSelector !== undefined) publicLabel(r.resultSelector);
  if (!Array.isArray(r.params) || !r.params.every((p) => typeof p === "string" && /^[a-zA-Z][\w-]{0,63}$/.test(p))
    || new Set(r.params).size !== r.params.length || !r.steps.length) throw new Error("the agent run needs steps and named parameters");
  if (r.output !== undefined) outputOf(r.output);
  if (r.applied !== undefined) appliedOf(r.applied, r.params);
  if (r.output !== undefined && r.params.length && (r.params.length !== 1 || r.applied === undefined)) throw new Error("structured output with an input needs one parameter and a supported applied-input check; otherwise publication is refused");
  if (r.version !== undefined) {
    if (!r.version || typeof r.version !== "object" || Array.isArray(r.version)) throw new Error("invalid playbook revision");
    const v = r.version as Record<string, unknown>;
    if (Object.keys(v).some((key) => !["tool", "revision", "previous"].includes(key))
      || typeof v.revision !== "number" || !Number.isSafeInteger(v.revision) || v.revision < 1) throw new Error("invalid playbook revision");
    recordingName(v.tool);
    if (v.revision === 1 ? v.previous !== undefined : v.previous === undefined) throw new Error("a changed revision needs its prior recording name");
    if (v.previous !== undefined) recordingName(v.previous);
  }
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

function assertRevisionContract(next: AgentRecording, previous: AgentRecording): void {
  if (next.params.length !== previous.params.length || previous.params.some((param) => !next.params.includes(param))) throw new Error("a changed tool must retain its public parameter names");
  if ((previous.before.text !== undefined && next.before.text !== previous.before.text)
    || (previous.before.selector !== undefined && next.before.selector !== previous.before.selector)) throw new Error("a changed tool must retain its verified start condition");
  if ((previous.verify.text !== undefined && next.verify.text !== previous.verify.text)
    || (previous.verify.selector !== undefined && next.verify.selector !== previous.verify.selector)) throw new Error("a changed tool must retain its verified end condition");
  if (previous.resultSelector !== undefined && next.resultSelector !== previous.resultSelector) throw new Error("a changed tool must retain its verified result selector");
  if (previous.output && (!next.output || next.output.rows !== previous.output.rows
    || Object.entries(previous.output.fields).some(([name, selector]) => next.output?.fields[name] !== selector))) throw new Error("a changed tool must retain its verified output rows and fields");
  if (previous.applied && (!next.applied || next.applied.param !== previous.applied.param
    || next.applied.in !== previous.applied.in || (next.applied.prefix ?? "") !== (previous.applied.prefix ?? ""))) throw new Error("a changed tool must retain its applied-input check");
}

// Revisions are immutable recordings too. The catalog is derived from these
// files, never from a mutable current-version index.
export function saveRecording(raw: unknown, from?: string, example?: Record<string, string>): string {
  if (!isRecording(raw)) throw new Error("not a recording: it needs a url and steps");
  const agent = "source" in raw && raw.source === "agent";
  if (from !== undefined && !agent) throw new Error("only verified agent recordings can have revisions");
  const prior = from === undefined ? undefined : loadPlaybook(from);
  const latest = prior && listPlaybooks().find((p) => p.tool === prior.tool);
  if (agent) {
    assertAgentRecording(raw);
    if (raw.version !== undefined) throw new Error("revision metadata belongs to the recording store; use learn from a prior name");
    if (prior) {
      assertRevisionContract(raw, prior.recording);
      if (latest && latest.name !== prior.name) assertRevisionContract(raw, latest.recording);
    }
  }
  if (prior && new URL(raw.url).origin !== new URL(prior.recording.url).origin) throw new Error("a changed tool must stay on its learned origin");
  const nextRevision = prior ? Math.max(prior.revision, latest ? latest.revision : 0) + 1 : 1;
  const dir = dataFile("recordings");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const steps = raw.steps.map(redactStep);
  const base = stem(raw.url, typeof raw.startedAt === "number" ? raw.startedAt : Date.now());
  const samples = Object.values(example ?? {}).filter((value) => value.length > 0);
  for (let n = 0; ; n++) {
    const revision = nextRevision + n;
    if (!Number.isSafeInteger(revision)) throw new Error("the playbook revision number is too large");
    const name = prior ? `${prior.tool}-r${revision}` : n === 0 ? base : `${base}-${n + 1}`;
    const version = agent ? { tool: prior ? prior.tool : name, revision: prior ? revision : 1, ...(prior ? { previous: prior.name } : {}) } : undefined;
    const recording = { ...raw, steps, ...(version ? { version } : {}) };
    if (samples.length && containsSample({ name, recording }, samples)) throw new Error("an example value appeared in the recording metadata or name; no playbook was stored");
    const body = JSON.stringify(recording, null, 1);
    try {
      writeFileSync(join(dir, `${name}.json`), body, { flag: "wx", mode: 0o600 });
      return name;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
}

function containsSample(value: unknown, samples: string[]): boolean {
  if (typeof value === "string") return samples.some((sample) => value.includes(sample));
  if (Array.isArray(value)) return value.some((item) => containsSample(item, samples));
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => containsSample(key, samples) || containsSample(item, samples));
  return false;
}

// The file a caller's name stands for: only ever one in the folder, never
// a path out of it.
function recordingName(name: unknown): string {
  if (typeof name !== "string" || !/^[\w-][\w.-]*$/.test(name)) throw new Error("name must be a recording's name, as recordings lists them");
  return name;
}

function fileOf(name: unknown): string {
  return join(dataFile("recordings"), `${recordingName(name)}.json`);
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

function storedRecordings(): { name: string; rec: Recording }[] {
  let files: string[];
  try {
    files = readdirSync(dataFile("recordings"));
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
  return files.filter((f) => f.endsWith(".json")).map((f) => ({ name: f.slice(0, -".json".length), rec: loadRecording(f.slice(0, -".json".length)) }));
}

// Newest first, each with what a caller tells them apart by.
export function listRecordings(): { name: string; url: string; title: string; steps: number; began: string }[] {
  const at = (r: Recording) => (typeof r.startedAt === "number" ? r.startedAt : 0);
  return storedRecordings().sort((a, b) => at(b.rec) - at(a.rec)).map(({ name, rec }) => ({
    name,
    url: rec.url,
    title: typeof rec.title === "string" ? rec.title : "",
    steps: rec.steps.length,
    began: new Date(at(rec)).toLocaleString("sv").slice(0, 16),
  }));
}

function playbookOf(name: string, rec: Recording): SavedPlaybook {
  assertAgentRecording(rec);
  const { tool, revision } = rec.version ?? { tool: name, revision: 1 };
  if (name !== (revision === 1 ? tool : `${tool}-r${revision}`)) throw new Error("the playbook revision does not match its recording name");
  return { name, tool, revision, recording: rec };
}

export function loadPlaybook(name: unknown): SavedPlaybook {
  return playbookOf(recordingName(name), loadRecording(name));
}

export function listPlaybooks(): (SavedPlaybook & { revisions: RevisionSummary[] })[] {
  const groups = new Map<string, SavedPlaybook[]>();
  for (const { name, rec } of storedRecordings()) {
    if (!("source" in rec) || rec.source !== "agent") continue;
    let saved: SavedPlaybook;
    try { saved = playbookOf(name, rec); } catch { continue; }
    const group = groups.get(saved.tool);
    if (group) group.push(saved);
    else groups.set(saved.tool, [saved]);
  }
  return [...groups.values()].map((group) => {
    group.sort((a, b) => b.revision - a.revision);
    const current = group[0];
    return { ...current, revisions: group.map(({ name, revision }) => ({ name, revision, current: name === current.name })) };
  }).sort((a, b) => Number(b.recording.startedAt ?? 0) - Number(a.recording.startedAt ?? 0) || a.tool.localeCompare(b.tool));
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
