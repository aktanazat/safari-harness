import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { createHash, randomUUID } from "node:crypto";

export type SiteActionBinding = Readonly<{ tab: number; origin: string; document: string; frame: 0 }>;
export type SiteActionSelection = Readonly<{ revision: string; name: string }>;
export type SiteActionRequest = SiteActionSelection & Readonly<{ input: Record<string, unknown>; timeoutMs?: number }>;
export type SiteActionTransport = {
  catalog(binding: SiteActionBinding, signal: AbortSignal): Promise<unknown>;
  schema(binding: SiteActionBinding, selection: SiteActionSelection, signal: AbortSignal): Promise<unknown>;
  invoke(binding: SiteActionBinding, request: SiteActionSelection & { input: Record<string, unknown>; callId: string; timeoutMs: number }, signal: AbortSignal): Promise<unknown>;
  cancel(binding: SiteActionBinding, callId: string): Promise<unknown>;
};
export type SiteActionAdmission = Readonly<{ binding: SiteActionBinding; revision: string; name: string; input: Readonly<Record<string, unknown>>; signal: AbortSignal }>;
export type SiteActionOutcome =
  | { status: "completed"; result: unknown; trust: "untrusted-site"; retry: false }
  | { status: "refused" | "unknown"; reason: string; retry: false };
type Summary = { name: string; title: string; description: string; annotations: Record<string, boolean> };
type Catalog = { binding: SiteActionBinding; pageRevision: string; revision: string; tools: Summary[]; schemas: Map<string, { inputSchema: Record<string, unknown>; validate: ValidateFunction }> };
type Pending = { binding: SiteActionBinding; callId: string; controller: AbortController; dispatched: boolean };
type Options = {
  transport: SiteActionTransport;
  // These callbacks are trusted harness code, never page-provided callbacks.
  current(binding: SiteActionBinding): Promise<SiteActionBinding>;
  // Must check current task ownership, pause/stop, explicit action authorization,
  // and approval policy for an opaque site action. Return only after admission.
  // Site descriptions/annotations intentionally are not inputs to this decision.
  admit(request: SiteActionAdmission): Promise<() => void>;
  schedule?: (ms: number, expire: () => void) => () => void;
};
const MAX_JSON = 32768;
const MAX_TOOLS = 128;
const MAX_DOCUMENTS = 128;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keyOf = (binding: SiteActionBinding): string => `${binding.tab}:${binding.document}`;
const same = (a: SiteActionBinding, b: SiteActionBinding): boolean => a.tab === b.tab && a.document === b.document && a.origin === b.origin && a.frame === b.frame;
const refused = (reason: string): SiteActionOutcome => ({ status: "refused", reason, retry: false });
const unknown = (reason: string): SiteActionOutcome => ({ status: "unknown", reason, retry: false });
const schemaOptions = { strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: false, ownProperties: true, addUsedSchema: false, inlineRefs: false, loopRequired: 32, loopEnum: 32 };

// Bounds parsing and compilation work and disallows remote schema references.
function boundedJSON(value: unknown, limit = MAX_JSON): unknown {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || text.length > limit) throw new Error("site action JSON exceeds the supported limit");
  const result: unknown = JSON.parse(text);
  let nodes = 0;
  const walk = (node: unknown, depth: number) => {
    if (++nodes > 2048 || depth > 24) throw new Error("site action JSON is too complex");
    if (Array.isArray(node)) for (const child of node) walk(child, depth + 1);
    else if (record(node)) for (const [name, child] of Object.entries(node)) {
      if (name === "__proto__" || name === "constructor" || name === "prototype") throw new Error("site action JSON contains an unsafe property");
      walk(child, depth + 1);
    }
  };
  walk(result, 0);
  return result;
}
function bindingOK(binding: SiteActionBinding): void {
  const url = new URL(binding.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== binding.origin || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || binding.frame !== 0 || !Number.isInteger(binding.tab) || !binding.document) throw new Error("site actions require an exact secure origin and top-document identity");
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function compile(inputSchema: Record<string, unknown>): ValidateFunction {
  const check = (node: unknown) => {
    if (!record(node)) return;
    for (const [name, value] of Object.entries(node)) {
      if (["$ref", "$dynamicRef", "$recursiveRef"].includes(name) && (typeof value !== "string" || !value.startsWith("#"))) throw new Error("remote schema references are unsupported");
      if (name === "format") throw new Error("schema formats are unsupported; use structural constraints");
      if (["pattern", "patternProperties"].includes(name)) throw new Error("schema regular expressions are unsupported");
      if (["properties", "$defs", "definitions", "dependentSchemas", "dependencies"].includes(name) && record(value)) {
        for (const child of Object.values(value)) check(child);
      } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(name) && Array.isArray(value)) {
        for (const child of value) check(child);
      } else if (["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "contains", "not", "if", "then", "else", "additionalItems", "unevaluatedItems", "contentSchema"].includes(name)) {
        if (Array.isArray(value)) for (const child of value) check(child);
        else check(value);
      }
    }
  };
  check(inputSchema);
  const dialect = inputSchema.$schema;
  if (dialect !== undefined && dialect !== "https://json-schema.org/draft/2020-12/schema" && dialect !== "http://json-schema.org/draft-07/schema#" && dialect !== "https://json-schema.org/draft-07/schema") throw new Error("unsupported JSON Schema dialect");
  try {
    const validator = dialect === "https://json-schema.org/draft/2020-12/schema" ? new Ajv2020(schemaOptions) : new Ajv(schemaOptions);
    return validator.compile(inputSchema);
  } catch {
    throw new Error("site action schema is invalid or unsupported");
  }
}

// One instance per extension connection. Navigation and disconnect must call
// invalidate/dispose. No retry/healing wrapper may surround call().
export class SiteActions {
  readonly #options: Options;
  readonly #enabled = new Set<string>();
  readonly #catalogs = new Map<string, Catalog>();
  readonly #pending = new Map<number, Pending>();
  readonly #uncertain = new Map<number, string>();
  readonly #schedule: (ms: number, expire: () => void) => () => void;
  #disposed = false;
  constructor(options: Options) {
    this.#options = options;
    this.#schedule = options.schedule ?? ((ms, expire) => { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); });
  }
  configure(origin: string, enabled: boolean): { origin: string; enabled: boolean; reloadRequired: true } {
    if (this.#disposed) throw new Error("site action connection ended");
    bindingOK({ tab: 0, origin, document: "configure", frame: 0 });
    if (enabled) {
      if (this.#enabled.size >= MAX_DOCUMENTS && !this.#enabled.has(origin)) throw new Error("site action origin limit reached");
      this.#enabled.add(origin);
    } else {
      this.#enabled.delete(origin);
      for (const catalog of this.#catalogs.values()) if (catalog.binding.origin === origin) this.invalidate(catalog.binding.tab);
      for (const pending of this.#pending.values()) if (pending.binding.origin === origin) pending.controller.abort();
    }
    return { origin, enabled, reloadRequired: true };
  }
  async #current(binding: SiteActionBinding, signal: AbortSignal): Promise<void> {
    if (this.#disposed) throw new Error("site action connection ended");
    signal.throwIfAborted();
    bindingOK(binding);
    if (!this.#enabled.has(binding.origin)) throw new Error("site actions are not enabled for this origin");
    const current = await this.#options.current(binding);
    signal.throwIfAborted();
    if (!same(binding, current)) throw new Error("site action document or origin changed");
  }
  async #read(binding: SiteActionBinding, signal: AbortSignal): Promise<Catalog> {
    await this.#current(binding, signal);
    const raw = await this.#options.transport.catalog(binding, signal);
    await this.#current(binding, signal);
    if (!record(raw) || raw.status !== "available" || raw.origin !== binding.origin || raw.frame !== "top" || typeof raw.revision !== "string" || !/^\d{1,16}$/.test(raw.revision) || !Array.isArray(raw.tools) || raw.tools.length > MAX_TOOLS) throw new Error("unavailable or malformed site action catalog");
    const names = new Set<string>();
    const tools: Summary[] = raw.tools.map((tool: unknown) => {
      if (!record(tool) || typeof tool.name !== "string" || !NAME.test(tool.name) || names.has(tool.name) || typeof tool.description !== "string" || tool.description.length > 160 || typeof tool.title !== "string" || tool.title.length > 256) throw new Error("malformed site action summary");
      names.add(tool.name);
      const annotations: Record<string, boolean> = {};
      if (record(tool.annotations)) for (const hint of ["readOnlyHint", "untrustedContentHint", "consequentialHint", "debugging"]) if (typeof tool.annotations[hint] === "boolean") annotations[hint] = tool.annotations[hint];
      return { name: tool.name, title: tool.title.slice(0, 80), description: tool.description, annotations };
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const revision = digest([binding.origin, binding.document, raw.revision, tools]);
    const key = keyOf(binding);
    const previous = this.#catalogs.get(key);
    if (previous?.revision === revision && same(previous.binding, binding)) return previous;
    for (const [old, catalog] of this.#catalogs) if (catalog.binding.tab === binding.tab) this.#catalogs.delete(old);
    if (this.#catalogs.size >= MAX_DOCUMENTS) {
      const oldest = this.#catalogs.keys().next().value;
      if (oldest !== undefined) this.#catalogs.delete(oldest);
    }
    const catalog: Catalog = { binding: { ...binding }, pageRevision: raw.revision, revision, tools, schemas: new Map() };
    this.#catalogs.set(key, catalog);
    return catalog;
  }
  async #observe<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const stopTimer = this.#schedule(15000, abort);
    const cancelled = Promise.withResolvers<never>();
    const reject = () => cancelled.reject(new Error("site action read cancelled or timed out"));
    controller.signal.addEventListener("abort", reject, { once: true });
    if (controller.signal.aborted) reject();
    try {
      return await Promise.race([run(controller.signal), cancelled.promise]);
    } finally {
      stopTimer();
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", reject);
    }
  }
  async list(binding: SiteActionBinding, options: { since?: string } = {}, signal = new AbortController().signal): Promise<unknown> {
    const catalog = await this.#observe(signal, (bounded) => this.#read(binding, bounded));
    const base = { origin: binding.origin, document: binding.document, revision: catalog.revision, frame: "top", trust: "untrusted-site" };
    if (options.since === catalog.revision) return { ...base, changed: false };
    return { ...base, changed: true, tools: catalog.tools.slice(0, 32), omitted: Math.max(0, catalog.tools.length - 32) };
  }
  async #schema(binding: SiteActionBinding, selection: SiteActionSelection, signal: AbortSignal): Promise<{ catalog: Catalog; inputSchema: Record<string, unknown>; validate: ValidateFunction }> {
    const catalog = await this.#read(binding, signal);
    if (catalog.revision !== selection.revision) throw new Error("site action catalog changed; list again before calling");
    if (!catalog.tools.some((tool) => tool.name === selection.name)) throw new Error("site action is not registered");
    const cached = catalog.schemas.get(selection.name);
    if (cached) return { catalog, ...cached };
    const raw = await this.#options.transport.schema(binding, { revision: catalog.pageRevision, name: selection.name }, signal);
    await this.#current(binding, signal);
    if (!record(raw) || raw.status !== "available" || raw.revision !== catalog.pageRevision || raw.name !== selection.name) throw new Error("site action schema changed or is unavailable");
    const inputSchema = boundedJSON(raw.inputSchema);
    if (!record(inputSchema)) throw new Error("site action schema must be an object");
    const item = { inputSchema, validate: compile(inputSchema) };
    catalog.schemas.set(selection.name, item);
    return { catalog, ...item };
  }
  async schema(binding: SiteActionBinding, selection: SiteActionSelection, signal = new AbortController().signal): Promise<unknown> {
    const { inputSchema } = await this.#observe(signal, (bounded) => this.#schema(binding, selection, bounded));
    return { ...selection, origin: binding.origin, document: binding.document, inputSchema: boundedJSON(inputSchema), schemaDigest: digest(stable(inputSchema)), trust: "untrusted-site" };
  }
  async call(binding: SiteActionBinding, request: SiteActionRequest, signal?: AbortSignal): Promise<SiteActionOutcome> {
    if (this.#pending.size >= MAX_DOCUMENTS || (this.#uncertain.size >= MAX_DOCUMENTS && !this.#uncertain.has(binding.tab))) return refused("site_action_connection_limit_reached");
    if (this.#pending.has(binding.tab)) return refused("another_site_action_is_pending");
    if (this.#uncertain.get(binding.tab) === binding.document) return refused("previous_action_outcome_unknown_reload_before_another_action");
    if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1)) return refused("invalid_timeout");
    binding = Object.freeze({ ...binding });
    const selection = Object.freeze({ revision: request.revision, name: request.name });
    const pending: Pending = { binding: { ...binding }, callId: randomUUID(), controller: new AbortController(), dispatched: false };
    this.#pending.set(binding.tab, pending);
    const abort = () => pending.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const ms = Math.max(1, Math.min(60000, request.timeoutMs ?? 15000));
    const stopTimer = this.#schedule(ms, abort);
    const cancelled = Promise.withResolvers<never>();
    const cancelListener = () => cancelled.reject(new Error("site action cancelled or timed out"));
    pending.controller.signal.addEventListener("abort", cancelListener, { once: true });
    if (pending.controller.signal.aborted) cancelListener();
    const work = async (): Promise<SiteActionOutcome> => {
      const input = boundedJSON(request.input);
      if (!record(input)) throw new Error("site action input must be a JSON object");
      const { catalog, validate } = await this.#schema(binding, selection, pending.controller.signal);
      if (!validate(input)) throw new Error("site action input does not match its schema");
      const admissionInput = boundedJSON(input);
      if (!record(admissionInput)) throw new Error("site action input must be an object");
      const freeze = (value: unknown) => {
        if (value !== null && typeof value === "object") {
          for (const child of Object.values(value)) freeze(child);
          Object.freeze(value);
        }
      };
      freeze(admissionInput);
      const checkAdmission = await this.#options.admit({ binding, ...selection, input: admissionInput, signal: pending.controller.signal });
      await this.#current(binding, pending.controller.signal);
      const fresh = await this.#read(binding, pending.controller.signal);
      if (fresh.revision !== catalog.revision) throw new Error("site action catalog changed during admission");
      checkAdmission();
      pending.controller.signal.throwIfAborted();
      pending.dispatched = true;
      const raw = await this.#options.transport.invoke(binding, { revision: catalog.pageRevision, name: selection.name, input, callId: pending.callId, timeoutMs: ms }, pending.controller.signal);
      await this.#current(binding, pending.controller.signal);
      if (!record(raw) || raw.status !== "completed") return unknown("untrusted_site_did_not_confirm_completion_after_dispatch");
      return { status: "completed", result: boundedJSON(raw.result, 65536), trust: "untrusted-site", retry: false };
    };
    try {
      const result = await Promise.race([work(), cancelled.promise]);
      if (result.status === "unknown") this.#uncertain.set(binding.tab, binding.document);
      return result;
    } catch (error) {
      if (!pending.dispatched) return refused(error instanceof Error ? error.message : "site_action_not_admitted");
      this.#uncertain.set(binding.tab, binding.document);
      pending.controller.abort();
      // This is best-effort cancellation, never evidence that side effects stopped.
      void this.#options.transport.cancel(binding, pending.callId).catch(() => {});
      return unknown("cancelled_navigation_timeout_or_transport_loss_after_dispatch");
    } finally {
      stopTimer();
      signal?.removeEventListener("abort", abort);
      pending.controller.signal.removeEventListener("abort", cancelListener);
      if (this.#pending.get(binding.tab) === pending) this.#pending.delete(binding.tab);
    }
  }
  invalidate(tab: number): void {
    this.#pending.get(tab)?.controller.abort();
    for (const [key, catalog] of this.#catalogs) if (catalog.binding.tab === tab) this.#catalogs.delete(key);
    // Keep uncertainty for this exact document until a real navigation replaces it.
  }
  dispose(): void {
    this.#disposed = true;
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#catalogs.clear();
    this.#enabled.clear();
    this.#uncertain.clear();
  }
}
