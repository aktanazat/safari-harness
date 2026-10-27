import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { removeCapture } from "./evidence.ts";

const MISSIONS = 100;
const CALLS = 200;
const BYTES = 2 * 1024 * 1024;
const PICTURES = 100;
const PICTURE_BYTES = 128 * 1024 * 1024;
const AGE_MS = 30 * 24 * 60 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOOLS: Record<string, true> = Object.fromEntries("run tabs open close keep goto activate snapshot click type press select hover upload history scroll eval fetch authenticated_read request_catalog request_catalog_context download dialog extract map follow info wait data handoff_wait net console cookies shot shots pdf window locate resolve_tab real_site select_tab press_mark press_done type_mark type_field type_send element autofill login_form login_fill card_form card_fill card_phone passwords learn replay recordings playbooks lookalikes keep_secret report real_input action_admit action_finish input_state audit react site_actions video native_preflight unknown".split(" ").map((name) => [name, true as const]));
const PROCESSES: Record<string, true> = { omp: true, claude: true, codex: true, bun: true, node: true, python: true, python3: true, sleep: true };
const CODES: Record<string, true> = Object.fromEntries("stale_view effect_unknown privacy blocked not_content timeout unavailable aborted invalid_argument command_failed stopped waiting_for_human".split(" ").map((name) => [name, true as const]));
const STATUSES: Record<string, true> = { working: true, "waiting on the user": true, paused: true, "user is driving": true, stopped: true, ended: true };
const GAPS: Record<string, true> = { "capture unavailable": true, "privacy guard refused capture": true, "task is paused or ended": true, "picture exceeded size limit": true, "picture expired": true, "action result is unknown": true, "picture saving stopped": true };
const FAILURE_BYTES = 4096;
const METHODS = new Set("GET HEAD POST PUT PATCH DELETE OPTIONS CONNECT TRACE".split(" "));
const ERROR_CLASSES = new Set("Error EvalError RangeError ReferenceError SyntaxError TypeError URIError AggregateError AbortError NetworkError SecurityError TimeoutError".split(" "));

export type CaptureSummary = { sha256: string; capturedAt: string; width: number; height: number; masked: number; url?: string; tiles?: number };
export type HistoryPicture = { id: string; missing: string } | { id: string; capture: CaptureSummary; receipt: string; bytes: number };
export type FailurePage = { origin: string; path: string };
export type FailureContext = { at: number; tab?: number; page?: FailurePage; network: (FailurePage & { t: number; method: string; status?: number; error?: string })[]; console: { t: number; error: string }[]; unavailable: ("page" | "network" | "console")[] };
export type HistoryCall = { t: number; tool: string; args: string; tab?: number; ms?: number; outcome: "running" | "done" | "failed" | "interrupted"; code?: string; evidence?: CaptureSummary[]; picture?: HistoryPicture; failureContext?: FailureContext };
export type MissionRecord = { id: string; owner: number | null; process: string | null; since: number; active: number; raised: number; status: string; ended?: number; interrupted?: true; controls: false; spaces: string[]; pictures: boolean; inspectionOnly?: true; calls: HistoryCall[] };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is number => count(value) && value > 0 && value <= 8_640_000_000_000_000;

export function historyToolName(tool: string): string {
  return tool === "request_catalog_context" ? "request_catalog" : tool;
}

function failurePage(value: unknown): FailurePage | undefined {
  const o = object(value);
  const raw = typeof value === "string" ? value : typeof o?.origin === "string" && typeof o.path === "string" ? o.origin + o.path : undefined;
  if (raw === undefined || raw.length > 8192) return undefined;
  const url = URL.parse(raw);
  if (!url || url.protocol !== "http:" && url.protocol !== "https:" || url.origin.length > 200) return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  const path = segments.length ? "/" + segments.slice(0, 8).map(() => "…").join("/") + (segments.length > 8 ? "/…" : "") : "/";
  return { origin: url.origin, path };
}

function errorClass(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const name = /^(?:(?:Uncaught(?: \(in promise\))?|Unhandled Promise Rejection)\s*:?\s*)?([A-Za-z]+Error|Error)\b/i.exec(value.slice(0, 120))?.[1];
  return name && ERROR_CLASSES.has(name) ? name : fallback;
}

export function failureContextSummary(value: unknown, started: number, duration: number): FailureContext | undefined {
  const o = object(value);
  if (!o || !time(o.at) || o.at < started || o.at > started + duration + 1000) return undefined;
  const at = o.at;
  const tab = count(o.tab) && o.tab > 0 ? o.tab : undefined;
  const from = Math.max(started - 5000, at - 30_000);
  const recent = (t: unknown): t is number => time(t) && t >= from && t <= at;
  const page = tab === undefined ? undefined : failurePage(o.page);
  const network: FailureContext["network"] = [];
  if (tab !== undefined && Array.isArray(o.network)) for (const raw of o.network.slice(-100)) {
    const entry = object(raw);
    if (!entry || !recent(entry.t) || typeof entry.method !== "string" || !METHODS.has(entry.method)) continue;
    const location = failurePage(entry.url ?? entry);
    if (!location) continue;
    const status = count(entry.status) && (entry.status === 0 || entry.status >= 100) && entry.status <= 599 ? entry.status : undefined;
    const failed = typeof entry.error === "string" && entry.error.length > 0;
    if (!failed && status !== 0 && (status === undefined || status < 400)) continue;
    network.push({ ...location, t: entry.t, method: entry.method, ...(status === undefined ? {} : { status }), ...(failed || status === 0 ? { error: errorClass(entry.error, "NetworkError") } : {}) });
  }
  const errors: FailureContext["console"] = [];
  if (tab !== undefined && Array.isArray(o.console)) for (const raw of o.console.slice(-100)) {
    const entry = object(raw);
    if (!entry || !recent(entry.t) || entry.uncaught !== true && !(typeof entry.error === "string" && ERROR_CLASSES.has(entry.error))) continue;
    errors.push({ t: entry.t, error: errorClass(entry.error ?? entry.text, "Error") });
  }
  const unavailable: FailureContext["unavailable"] = [];
  if (Array.isArray(o.unavailable)) for (const name of ["page", "network", "console"] as const) if (o.unavailable.includes(name)) unavailable.push(name);
  if (!page && !unavailable.includes("page")) unavailable.push("page");
  if (tab === undefined) for (const name of ["network", "console"] as const) if (!unavailable.includes(name)) unavailable.push(name);
  const summary: FailureContext = { at, ...(tab === undefined ? {} : { tab }), ...(page ? { page } : {}), network: network.sort((a, b) => a.t - b.t).slice(-5), console: errors.sort((a, b) => a.t - b.t).slice(-3), unavailable };
  return Buffer.byteLength(JSON.stringify(summary)) <= FAILURE_BYTES ? summary : undefined;
}

function capture(value: unknown): CaptureSummary | undefined {
  const o = object(value);
  if (!o || typeof o.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(o.sha256)) return undefined;
  if (typeof o.capturedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.capturedAt) || !Number.isFinite(Date.parse(o.capturedAt))) return undefined;
  if (!count(o.width) || o.width === 0 || o.width > 100_000 || !count(o.height) || o.height === 0 || o.height > 100_000) return undefined;
  const masked = object(o.privacy)?.masked ?? o.masked;
  if (!count(masked)) return undefined;
  const url = typeof o.url === "string" ? URL.parse(o.url) : null;
  const source = url && (url.protocol === "https:" || url.protocol === "http:") ? url.origin.slice(0, 200) : undefined;
  const tiles = Array.isArray(o.tiles) ? o.tiles.length : count(o.tiles) ? o.tiles : undefined;
  return { sha256: o.sha256.toLowerCase(), capturedAt: o.capturedAt, width: o.width, height: o.height, masked, ...(source ? { url: source } : {}), ...(tiles === undefined ? {} : { tiles: Math.min(tiles, 1000) }) };
}

export function captureSummaries(value: unknown): CaptureSummary[] {
  const summaries: CaptureSummary[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || summaries.length >= 16) return;
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 100)) visit(item, depth + 1);
      return;
    }
    const o = object(v);
    if (!o) return;
    const saved = capture(o.evidence);
    if (saved && !summaries.some((s) => s.sha256 === saved.sha256)) summaries.push(saved);
    for (const key of ["value", "page", "pages", "results", "files", "shots", "captures", "capture", "frames", "steps"]) if (o[key] !== undefined) visit(o[key], depth + 1);
  };
  visit(value, 0);
  return summaries;
}

function picture(value: unknown, mission: string, root: string): HistoryPicture | undefined {
  const o = object(value);
  if (!o || typeof o.id !== "string" || !UUID.test(o.id)) return undefined;
  if (typeof o.missing === "string" && Object.hasOwn(GAPS, o.missing)) return { id: o.id, missing: o.missing };
  const summary = capture(o.capture);
  if (!summary || !count(o.bytes) || o.bytes > 16 * 1024 * 1024 || typeof o.receipt !== "string") return undefined;
  const directory = join(root, mission, `${o.id}.png.evidence`);
  if (!/^capture-[a-f0-9-]{36}\/capture-[a-f0-9]{64}\.json$/i.test(relative(directory, o.receipt))) return undefined;
  return { id: o.id, capture: summary, receipt: o.receipt, bytes: o.bytes };
}

function call(value: unknown, mission: string, root: string): HistoryCall | undefined {
  const o = object(value);
  if (!o || !time(o.t)) return undefined;
  const tool = typeof o.tool === "string" && Object.hasOwn(TOOLS, o.tool) ? historyToolName(o.tool) : "unknown";
  const tab = count(o.tab) && o.tab > 0 ? o.tab : undefined;
  const outcome = o.outcome === "done" || o.outcome === "failed" || o.outcome === "interrupted" ? o.outcome : "running";
  const code = typeof o.code === "string" && Object.hasOwn(CODES, o.code) ? o.code : undefined;
  const evidence = Array.isArray(o.evidence) ? o.evidence.slice(0, 16).map(capture).filter((e): e is CaptureSummary => e !== undefined) : [];
  const saved = picture(o.picture, mission, root);
  const failureContext = outcome === "failed" && count(o.ms) ? failureContextSummary(o.failureContext, o.t, o.ms) : undefined;
  return { t: o.t, tool, args: tab === undefined ? "" : `tab=${tab}`, ...(tab === undefined ? {} : { tab }), ...(count(o.ms) ? { ms: Math.min(o.ms, 86_400_000) } : {}), outcome, ...(code ? { code } : {}), ...(evidence.length ? { evidence } : {}), ...(saved ? { picture: saved } : {}), ...(failureContext && failureContext.tab === tab ? { failureContext } : {}) };
}

function record(value: unknown, root: string, restarted = false): MissionRecord | undefined {
  const o = object(value);
  if (!o || typeof o.id !== "string" || !UUID.test(o.id) || !time(o.since) || !time(o.active) || !Array.isArray(o.calls)) return undefined;
  const id = o.id;
  const ended = time(o.ended) ? o.ended : restarted ? o.active : undefined;
  const interrupted = o.interrupted === true || (restarted && o.status !== "ended" && o.status !== "stopped");
  const calls = o.calls.slice(-CALLS).map((v) => call(v, id, root)).filter((c): c is HistoryCall => c !== undefined).map((c) => restarted && c.outcome === "running" ? { ...c, outcome: "interrupted" as const } : c);
  const spaces = Array.isArray(o.spaces) ? o.spaces.filter((v): v is string => typeof v === "string" && UUID.test(v)).slice(-100) : [];
  return { id, owner: count(o.owner) && o.owner > 1 ? o.owner : null, process: typeof o.process === "string" && Object.hasOwn(PROCESSES, o.process) ? o.process : null,
    since: o.since, active: o.active, raised: count(o.raised) ? o.raised : 0,
    status: restarted ? o.status === "stopped" ? "stopped" : "ended" : typeof o.status === "string" && Object.hasOwn(STATUSES, o.status) ? o.status : "ended",
    ...(ended === undefined ? {} : { ended }), ...(interrupted ? { interrupted: true } : {}), controls: false, spaces, pictures: o.pictures === true, ...(o.inspectionOnly === true ? { inspectionOnly: true } : {}), calls };
}

export class MissionHistory {
  private records: MissionRecord[] = [];
  private expired = new Set<string>();
  private scanned = false;
  private cleaning: Promise<void> | undefined;
  private readonly root: string;

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.root = path ? join(realpathSync(dirname(path)), `${basename(path)}.pictures`) : join(realpathSync(tmpdir()), `safari-mission-${randomUUID()}`);
    if (!path) return;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BYTES) throw new Error("Mission history is not a bounded regular file.");
      const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
      const rows = object(saved);
      if (rows?.version !== 1 || !Array.isArray(rows.missions)) throw new Error("Mission history format is invalid.");
      this.records = rows.missions.slice(-MISSIONS).map((v) => record(v, this.root, true)).filter((v): v is MissionRecord => v !== undefined);
      this.trim();
      this.persist();
    } catch (e) {
      if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ENOENT") throw e;
    }
  }

  pictureOutput(mission: string, id: string): string {
    if (!UUID.test(mission) || !UUID.test(id)) throw new Error("Picture identity is invalid.");
    return join(this.root, mission, `${id}.png`);
  }

  save(value: unknown): void {
    const entry = record(value, this.root);
    if (!entry) throw new Error("Mission history record is invalid.");
    const before = this.receipts();
    this.records = this.records.filter((r) => r.id !== entry.id);
    this.records.push(entry);
    this.trim();
    const kept = this.receipts();
    for (const receipt of before) if (!kept.has(receipt)) this.expired.add(receipt);
    this.persist();
  }

  list(id?: string): MissionRecord[] {
    if (this.records.length && this.records[0].active < this.now() - AGE_MS) {
      this.trim();
      this.persist();
    }
    return structuredClone(this.records.filter((r) => id === undefined || r.id === id).toReversed());
  }

  cleanup(): Promise<void> {
    this.cleaning ??= this.clean().finally(() => { this.cleaning = undefined; });
    return this.cleaning;
  }

  private receipts(): Set<string> {
    return new Set(this.records.flatMap((r) => r.calls.flatMap((c) => c.picture && "receipt" in c.picture ? [c.picture.receipt] : [])));
  }

  private async clean(): Promise<void> {
    if (!this.scanned) {
      const kept = this.receipts();
      let directories;
      try { directories = await readdir(this.root, { withFileTypes: true }); }
      catch (e) { if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") directories = []; else throw e; }
      for (const directory of directories) {
        if (!directory.isDirectory() || !UUID.test(directory.name)) continue;
        const folder = join(this.root, directory.name);
        for (const file of await readdir(folder, { withFileTypes: true })) {
          if (!file.isDirectory() || !/^[a-f0-9-]{36}\.png\.evidence$/i.test(file.name)) continue;
          const sidecar = join(folder, file.name);
          for (const bundle of await readdir(sidecar, { withFileTypes: true })) {
            if (!bundle.isDirectory() || !/^capture-[a-f0-9-]{36}$/i.test(bundle.name)) continue;
            const folder = join(sidecar, bundle.name);
            for (const receipt of await readdir(folder, { withFileTypes: true })) {
              if (!receipt.isFile() || !/^capture-[a-f0-9]{64}\.json$/.test(receipt.name)) continue;
              const path = join(folder, receipt.name);
              if (!kept.has(path) && !this.receipts().has(path)) this.expired.add(path);
            }
          }
        }
      }
      this.scanned = true;
    }
    for (const receipt of this.expired) {
      if (this.receipts().has(receipt)) { this.expired.delete(receipt); continue; }
      await removeCapture(receipt);
      this.expired.delete(receipt);
      await rmdir(dirname(dirname(dirname(receipt)))).catch((e: unknown) => {
        if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ENOTEMPTY" && e.code !== "ENOENT") throw e;
      });
    }
  }

  private trim(): void {
    const before = this.receipts();
    const earliest = this.now() - AGE_MS;
    this.records = this.records.filter((r) => r.active >= earliest).sort((a, b) => a.active - b.active).slice(-MISSIONS);
    let pictures = 0, bytes = 0;
    for (let r = this.records.length - 1; r >= 0; r--) for (let c = this.records[r].calls.length - 1; c >= 0; c--) {
      const call = this.records[r].calls[c];
      if (!call.picture || !("receipt" in call.picture)) continue;
      const storedBytes = call.picture.bytes * 2;
      if (pictures >= PICTURES || bytes + storedBytes > PICTURE_BYTES) call.picture = { id: call.picture.id, missing: "picture expired" };
      else { pictures++; bytes += storedBytes; }
    }
    while (this.records.length && Buffer.byteLength(JSON.stringify({ version: 1, missions: this.records })) > BYTES) this.records.shift();
    const kept = this.receipts();
    for (const receipt of before) if (!kept.has(receipt)) this.expired.add(receipt);
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    const pending = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(pending, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, missions: this.records })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(pending, this.path);
    } finally {
      try { unlinkSync(pending); } catch (e) {
        if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ENOENT") throw e;
      }
    }
  }
}
